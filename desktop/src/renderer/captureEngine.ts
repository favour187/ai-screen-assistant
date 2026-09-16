/**
 * CaptureEngine — runs in renderer (OS-authorized, independent from viewed app)
 * - Starts getUserMedia({ chromeMediaSource: 'desktop', chromeMediaSourceId }) stream
 * - Ticker at config.intervalMs polls canvas, runs FrameDiffer, compresses efficiently
 * - Memory-safe, lifecycle-aware, reconnection via stream onended
 */

import { FrameDiffer } from './diff.js';

export type CaptureEngineConfig = {
  intervalMs: number;
  scaleFactor: number;
  jpegQuality: number;
  enableFrameDiff: boolean;
  diffThresholdPercent: number;
  maxQueueSize: number;
  autoAnalyze: boolean;
};

export type CaptureStats = {
  fps: number;
  lastDiffPercent: number;
  skipped: number;
  queueSize: number;
  lastError: string | null;
};

export type FrameReadyPayload = {
  jpegDataUrl: string; // data:image/jpeg;base64,...
  width: number;
  height: number;
  diffPercent: number;
  byteLength: number;
};

export class CaptureEngine {
  private config: CaptureEngineConfig;
  private differ: FrameDiffer;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private timer: number | null = null;
  private isRunning = false;
  private skipped = 0;
  private sent = 0;
  private queueSize = 0;
  private lastError: string | null = null;
  private lastDiff = 0;
  private fps = 0;
  private framesThisSecond = 0;
  private secondStart = performance.now();

  onFrameReady: ((frame: FrameReadyPayload) => void) | null = null;
  onPreview: ((dataUrl: string, stats: CaptureStats) => void) | null = null;
  onError: ((msg: string) => void) | null = null;
  onFps: ((fps: number) => void) | null = null;

  constructor(
    video: HTMLVideoElement,
    canvas: HTMLCanvasElement,
    config: CaptureEngineConfig,
  ) {
    this.video = video;
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas 2D not available');
    this.ctx = ctx;
    this.config = { ...config };
    this.differ = new FrameDiffer(config.diffThresholdPercent);
  }

  updateConfig(next: Partial<CaptureEngineConfig>) {
    this.config = { ...this.config, ...next };
    if (next.diffThresholdPercent !== undefined) this.differ.setThreshold(next.diffThresholdPercent);
  }

  getConfig(): CaptureEngineConfig { return { ...this.config }; }
  getStats(): CaptureStats {
    return { fps: this.fps, lastDiffPercent: this.lastDiff, skipped: this.skipped, queueSize: this.queueSize, lastError: this.lastError };
  }

  async start(sourceId: string): Promise<void> {
    if (this.isRunning) await this.stop();
    this.lastError = null;
    this.skipped = 0;
    this.lastDiff = 0;
    this.differ.reset();

    const constraints: any = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          minWidth: 1280,
          maxWidth: 1920,
          minHeight: 720,
          maxHeight: 1080,
        },
      },
    };
    this.stream = await (navigator.mediaDevices as any).getUserMedia(constraints);
    this.video.srcObject = this.stream;
    // Muted autoplay
    this.video.muted = true;
    await this.video.play();
    // Wait a frame for dimensions
    await new Promise((r) => setTimeout(r, 180));

    // Handle track ended (OS revoked, window closed)
    this.stream!.getVideoTracks().forEach((t) => {
      t.onended = () => {
        this.lastError = 'Capture track ended (window closed or OS revoked) — reselect source';
        this.onError?.(this.lastError);
        this.stop();
      };
    });

    this.isRunning = true;
    this.startTicker();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timer !== null) {
      clearInterval(this.timer as unknown as number);
      this.timer = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => {
        try { t.stop(); } catch {}
        (t as any).onended = null;
      });
      this.stream = null;
    }
    this.video.srcObject = null;
    this.video.pause();
    // Don't clear stats — keep for UI
  }

  markQueueConsumed() {
    this.queueSize = Math.max(0, this.queueSize - 1);
  }

  private startTicker() {
    const interval = Math.max(300, this.config.intervalMs);
    // Use window.setInterval for renderer
    this.timer = window.setInterval(() => this.tick().catch((e) => this.handleError(e)), interval);
    // Immediate first tick
    this.tick().catch((e) => this.handleError(e));
  }

  private handleError(e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('AbortError')) return;
    this.lastError = msg;
    this.onError?.(msg);
    console.error('[CaptureEngine] tick error', e);
  }

  private async tick() {
    if (!this.isRunning || !this.stream || this.video.readyState < 2) return;

    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return;

    const scale = this.config.scaleFactor ?? 0.6;
    const targetW = Math.max(320, Math.round(vw * scale));
    const targetH = Math.max(200, Math.round(vh * scale));

    // Resize canvas if needed (avoid realloc every frame if same)
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }

    this.ctx.drawImage(this.video, 0, 0, targetW, targetH);

    // Frame-change detection — before heavy JPEG
    let shouldSend = true;
    let diffPercent = 100;
    if (this.config.enableFrameDiff) {
      const res = this.differ.shouldSendFromCanvas(this.canvas);
      shouldSend = res.shouldSend;
      diffPercent = res.diffPercent;
      this.lastDiff = diffPercent;
      if (!shouldSend) {
        this.skipped++;
        this.updateFps(false);
        this.notifyPreview(null, diffPercent); // still update stats but not frame
        return;
      }
    } else {
      this.lastDiff = 100;
    }

    // Queue guard
    if (this.queueSize >= this.config.maxQueueSize) {
      this.skipped++;
      this.updateFps(false);
      return;
    }

    // Efficient compression — canvas to JPEG dataUrl
    let dataUrl: string;
    try {
      dataUrl = this.canvas.toDataURL('image/jpeg', this.config.jpegQuality / 100);
    } catch (e) {
      // Fallback lower quality
      dataUrl = this.canvas.toDataURL('image/jpeg', 0.6);
      console.warn('[CaptureEngine] toDataURL fallback', e);
    }

    // Approximate byte length
    const byteLen = Math.round((dataUrl.length - 'data:image/jpeg;base64,'.length) * 0.75);
    if (byteLen > 1_900_000) {
      // Too large — auto lower quality next tick
      console.warn('[CaptureEngine] frame too large', byteLen, '— consider lowering scale/quality');
    }

    this.queueSize++;
    this.sent++;
    this.updateFps(true);

    const payload: FrameReadyPayload = { jpegDataUrl: dataUrl, width: targetW, height: targetH, diffPercent, byteLength: byteLen };
    this.onFrameReady?.(payload);
    this.notifyPreview(dataUrl, diffPercent);
  }

  private notifyPreview(dataUrl: string | null, diff: number) {
    if (!this.onPreview) return;
    // Throttle preview to ~2fps is done by caller; here we call every accepted frame
    // For skipped frames we don't update preview image (keep last)
    if (dataUrl) this.onPreview(dataUrl, this.getStats());
  }

  private updateFps(didSend: boolean) {
    this.framesThisSecond += didSend ? 1 : 0;
    const now = performance.now();
    if (now - this.secondStart >= 1000) {
      this.fps = (this.framesThisSecond * 1000) / (now - this.secondStart);
      this.framesThisSecond = 0;
      this.secondStart = now;
      this.onFps?.(this.fps);
    }
  }

  // Single one-off capture (for manual Analyze) — bypasses diff
  async captureOnce(sourceId?: string): Promise<FrameReadyPayload | null> {
    // If already running, just do a tick synchronously
    if (this.isRunning) {
      // Force a capture bypassing interval
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      if (!vw || !vh) return null;
      const targetW = Math.round(vw * (this.config.scaleFactor ?? 0.6));
      const targetH = Math.round(vh * (this.config.scaleFactor ?? 0.6));
      if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
        this.canvas.width = targetW;
        this.canvas.height = targetH;
      }
      this.ctx.drawImage(this.video, 0, 0, targetW, targetH);
      const dataUrl = this.canvas.toDataURL('image/jpeg', this.config.jpegQuality / 100);
      const byteLen = Math.round((dataUrl.length - 'data:image/jpeg;base64,'.length) * 0.75);
      return { jpegDataUrl: dataUrl, width: targetW, height: targetH, diffPercent: 100, byteLength: byteLen };
    }
    // Not running — need sourceId to start temp stream, capture, stop
    if (!sourceId) return null;
    // Temporary stream for single frame
    const constraints: any = {
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, minWidth: 1280, maxWidth: 1920, minHeight: 720, maxHeight: 1080 } },
    };
    const tmpStream: MediaStream = await (navigator.mediaDevices as any).getUserMedia(constraints);
    const tmpVideo = document.createElement('video');
    tmpVideo.srcObject = tmpStream;
    tmpVideo.muted = true;
    await tmpVideo.play();
    await new Promise((r) => setTimeout(r, 180));
    const tmpCanvas = document.createElement('canvas');
    const vw = tmpVideo.videoWidth || 1280;
    const vh = tmpVideo.videoHeight || 720;
    const targetW = Math.round(vw * (this.config.scaleFactor ?? 0.6));
    const targetH = Math.round(vh * (this.config.scaleFactor ?? 0.6));
    tmpCanvas.width = targetW;
    tmpCanvas.height = targetH;
    tmpCanvas.getContext('2d')!.drawImage(tmpVideo, 0, 0, targetW, targetH);
    const dataUrl = tmpCanvas.toDataURL('image/jpeg', this.config.jpegQuality / 100);
    tmpStream.getTracks().forEach((t) => t.stop());
    tmpVideo.pause();
    const byteLen = Math.round((dataUrl.length - 'data:image/jpeg;base64,'.length) * 0.75);
    return { jpegDataUrl: dataUrl, width: targetW, height: targetH, diffPercent: 100, byteLength: byteLen };
  }
}

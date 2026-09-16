/**
 * Efficient frame-change detection for Electron capture
 * Downscales to 32x32 luma, computes % of pixels with Δ > 15
 * Saves backend calls + bandwidth — same idea as Android FrameDiffer
 */

export class FrameDiffer {
  private prevLuma: Uint8Array | null = null;
  private threshold: number;
  private readonly sampleSize = 32;

  constructor(thresholdPercent = 3.0) {
    this.threshold = thresholdPercent;
  }

  setThreshold(p: number) {
    this.threshold = Math.max(0.5, Math.min(25, p));
  }

  reset() {
    this.prevLuma = null;
  }

  /**
   * Returns { shouldSend, diffPercent } — true if frame changed enough
   * Expects an ImageData or a downscaled canvas context; we accept a Canvas
   */
  shouldSendFromCanvas(sourceCanvas: HTMLCanvasElement): { shouldSend: boolean; diffPercent: number } {
    // Create 32x32 sample
    const tmp = document.createElement('canvas');
    tmp.width = this.sampleSize;
    tmp.height = this.sampleSize;
    const ctx = tmp.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(sourceCanvas, 0, 0, this.sampleSize, this.sampleSize);
    const data = ctx.getImageData(0, 0, this.sampleSize, this.sampleSize).data;

    const luma = new Uint8Array(this.sampleSize * this.sampleSize);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      // Rec. 709 luma
      luma[j] = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) | 0;
    }

    if (!this.prevLuma) {
      this.prevLuma = luma;
      return { shouldSend: true, diffPercent: 100 };
    }

    let diffCount = 0;
    for (let i = 0; i < luma.length; i++) {
      if (Math.abs(luma[i] - this.prevLuma[i]) > 15) diffCount++;
    }
    const diffPercent = (diffCount * 100) / luma.length;
    const changed = diffPercent >= this.threshold;
    if (changed) this.prevLuma = luma;
    return { shouldSend: changed, diffPercent };
  }

  // Alternative: hash-based quick check using canvas.toDataURL length? Not needed
}

// Exposes preload bridge types to renderer
export type CaptureSource = {
  id: string;
  name: string;
  thumbnailDataUrl: string;
  displayId: string;
  appIconDataUrl?: string | null;
};
export type CaptureConfig = {
  intervalMs: number;
  scaleFactor: number;
  jpegQuality: number;
  enableFrameDiff: boolean;
  diffThresholdPercent: number;
  autoAnalyze: boolean;
  maxQueueSize: number;
};
export type OverlayUpdate = {
  text: string;
  isStreaming: boolean;
  backendStatus?: string;
  prompt?: string;
  model?: string;
};

declare global {
  interface Window {
    assistantAPI: {
      getSources: () => Promise<CaptureSource[]>;
      requestPermission: () => Promise<{ granted: boolean; method: string }>;
      getVersion: () => Promise<string>;
      showError: (t: string, m: string) => Promise<void>;
      showMessage: (opts: any) => Promise<any>;
      store: {
        get: (key: string) => Promise<any>;
        set: (key: string, value: unknown) => Promise<boolean>;
        getAll: () => Promise<{ backendUrl: string; captureConfig: CaptureConfig; overlay: any }>;
      };
      overlay: {
        create: () => Promise<{ created: boolean; bounds?: Electron.Rectangle }>;
        close: () => Promise<{ closed: boolean }>;
        toggle: () => Promise<{ visible: boolean }>;
        isVisible: () => Promise<{ visible: boolean; alwaysOnTop: boolean }>;
        toggleAlwaysOnTop: () => Promise<{ alwaysOnTop: boolean }>;
        setBounds: (bounds: Electron.Rectangle) => Promise<boolean>;
        update: (payload: OverlayUpdate) => Promise<boolean>;
        onUpdate: (cb: (data: OverlayUpdate) => void) => () => void;
        onClosed: (cb: () => void) => () => void;
      };
      window: {
        closeOverlay: () => Promise<void>;
        minimize: (target: 'main' | 'overlay') => Promise<void>;
        toggleMaximize: (target: 'main' | 'overlay') => Promise<void>;
      };
      backend: {
        health: (backendUrl: string) => Promise<{ ok: boolean; status?: number; data?: any; error?: string }>;
      };
      onOverlayUpdate: (cb: (data: OverlayUpdate) => void) => () => void;
    };
  }
}
export {};

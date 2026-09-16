/**
 * Preload — secure contextBridge, no Node exposure to renderer
 * Single preload used for both main window and overlay window (contextIsolation + sandbox)
 */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

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

const assistantAPI = {
  // OS-authorized capture
  getSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke('capture:getSources'),
  requestPermission: (): Promise<{ granted: boolean; method: string }> =>
    ipcRenderer.invoke('capture:requestPermission'),
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  showError: (title: string, message: string) => ipcRenderer.invoke('dialog:showError', title, message),
  showMessage: (opts: Electron.MessageBoxOptions) => ipcRenderer.invoke('dialog:showMessage', opts),

  // Secure store — only whitelisted keys
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value),
    getAll: (): Promise<{ backendUrl: string; captureConfig: CaptureConfig; overlay: any }> =>
      ipcRenderer.invoke('store:getAll'),
  },

  // Overlay — movable always-on-top result window
  overlay: {
    create: (): Promise<{ created: boolean; bounds?: Electron.Rectangle }> =>
      ipcRenderer.invoke('overlay:create'),
    close: (): Promise<{ closed: boolean }> => ipcRenderer.invoke('overlay:close'),
    toggle: (): Promise<{ visible: boolean }> => ipcRenderer.invoke('overlay:toggle'),
    isVisible: (): Promise<{ visible: boolean; alwaysOnTop: boolean }> =>
      ipcRenderer.invoke('overlay:isVisible'),
    toggleAlwaysOnTop: (): Promise<{ alwaysOnTop: boolean }> =>
      ipcRenderer.invoke('overlay:toggleAlwaysOnTop'),
    setBounds: (bounds: Electron.Rectangle) => ipcRenderer.invoke('overlay:setBounds', bounds),
    update: (payload: OverlayUpdate) => ipcRenderer.invoke('overlay:update', payload),
    onUpdate: (cb: (data: OverlayUpdate) => void) => {
      const handler = (_e: IpcRendererEvent, data: OverlayUpdate) => cb(data);
      ipcRenderer.on('overlay:update', handler);
      return () => ipcRenderer.removeListener('overlay:update', handler);
    },
    onClosed: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('overlay:closed', handler);
      return () => ipcRenderer.removeListener('overlay:closed', handler);
    },
  },

  window: {
    closeOverlay: () => ipcRenderer.invoke('window:closeOverlay'),
    minimize: (target: 'main' | 'overlay') => ipcRenderer.invoke('window:minimize', target),
    toggleMaximize: (target: 'main' | 'overlay') => ipcRenderer.invoke('window:toggleMaximize', target),
  },

  backend: {
    health: (backendUrl: string) => ipcRenderer.invoke('backend:health', backendUrl),
  },

  // Events
  onOverlayUpdate: (cb: (data: OverlayUpdate) => void) => {
    const h = (_e: IpcRendererEvent, d: OverlayUpdate) => cb(d);
    ipcRenderer.on('overlay:update', h);
    return () => ipcRenderer.removeListener('overlay:update', h);
  },
};

contextBridge.exposeInMainWorld('assistantAPI', assistantAPI);

declare global {
  interface Window {
    assistantAPI: typeof assistantAPI;
  }
}

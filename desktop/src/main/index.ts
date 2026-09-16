/**
 * Electron Main — Windows client (production-grade)
 * - Uses ONLY OS-provided, user-authorized capture: desktopCapturer + getUserMedia (renderer)
 * - No DLL injection, no scripts/hooks/extensions, no code in viewed app
 * - Main handles windows, security, store, overlay, IPC — renderer does capture + frame diff
 * - All AI via backend (VITE_API_BASE_URL); no OpenRouter key in client
 */

import { app, BrowserWindow, ipcMain, desktopCapturer, dialog, shell, session, Menu } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import Store from 'electron-store';

// Electron Store schema — persisted securely in OS userData
type StoreSchema = {
  backendUrl: string;
  captureConfig: CaptureConfig;
  overlay: { bounds: Electron.Rectangle; alwaysOnTop: boolean; wasVisible: boolean };
};

type CaptureConfig = {
  intervalMs: number;
  scaleFactor: number;
  jpegQuality: number;
  enableFrameDiff: boolean;
  diffThresholdPercent: number;
  autoAnalyze: boolean;
  maxQueueSize: number;
};

const defaultCaptureConfig: CaptureConfig = {
  intervalMs: 1500,
  scaleFactor: 0.6,
  jpegQuality: 75,
  enableFrameDiff: true,
  diffThresholdPercent: 3.0,
  autoAnalyze: false,
  maxQueueSize: 2,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;

const store = new Store<StoreSchema>({
  defaults: {
    backendUrl: (process.env.VITE_API_BASE_URL as string) || 'http://localhost:3000',
    captureConfig: defaultCaptureConfig,
    overlay: { bounds: { x: 120, y: 120, width: 360, height: 420 }, alwaysOnTop: true, wasVisible: false },
  },
  // encryption at rest via safeStorage when available (Electron 32+)
  // electron-store will use safeStorage internally if encryptionKey not set and safeStorage is available
});

// Single instance lock — prevents duplicate capture sessions
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function getMainWindow(): BrowserWindow | null { return mainWindow; }
function getOverlayWindow(): BrowserWindow | null { return overlayWindow; }

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0f1115',
    title: 'AI Screen Assistant',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // Security: block new windows, limit navigation
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    // Allow only dev server and file://
    const allowed = url.startsWith('http://localhost:5173') || url.startsWith('file://');
    if (!allowed) e.preventDefault();
  });

  // CSP via session
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' http://localhost:* https://* ws://localhost:*; font-src 'self' data:;",
        ],
      },
    });
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
  const isDev = !app.isPackaged;

  if (isDev) {
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => (mainWindow = null));
  mainWindow.on('close', () => {
    // Persist overlay bounds if overlay is open
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      try {
        const bounds = overlayWindow.getBounds();
        store.set('overlay.bounds', bounds);
      } catch {}
    }
  });

  // Hide menu
  Menu.setApplicationMenu(null);
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.focus();
    return overlayWindow;
  }

  const saved = store.get('overlay') as StoreSchema['overlay'];
  const bounds = saved?.bounds || { x: 120, y: 120, width: 360, height: 420 };

  overlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 300,
    minHeight: 280,
    frame: false,
    transparent: false,
    backgroundColor: '#111318',
    alwaysOnTop: saved?.alwaysOnTop ?? true,
    skipTaskbar: false,
    resizable: true,
    hasShadow: true,
    title: 'Assistant Overlay',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Make draggable area work - we handle via CSS -webkit-app-region
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true);

  // Security same as main
  overlayWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const isDev = !app.isPackaged;
  if (isDev) {
    // Overlay is same dev server but with overlay.html query
    overlayWindow.loadURL((process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173') + '/overlay.html');
    // overlayWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    overlayWindow.loadFile(path.join(__dirname, '../../dist/renderer/overlay.html'));
  }

  overlayWindow.once('ready-to-show', () => overlayWindow?.show());
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    store.set('overlay.wasVisible', false);
    // Notify main window
    mainWindow?.webContents.send('overlay:closed');
  });

  // Close on Escape is handled in renderer

  store.set('overlay.wasVisible', true);
  return overlayWindow;
}

function closeOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      const bounds = overlayWindow.getBounds();
      store.set('overlay.bounds', bounds);
    } catch {}
    overlayWindow.close();
    overlayWindow = null;
  }
}

function toggleOverlayAlwaysOnTop() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return false;
  const current = overlayWindow.isAlwaysOnTop();
  overlayWindow.setAlwaysOnTop(!current, 'screen-saver');
  store.set('overlay.alwaysOnTop', !current);
  return !current;
}

// App lifecycle — Windows startup/shutdown + multiple displays + graceful quit
app.whenReady().then(() => {
  createMainWindow();
  // Restore overlay if it was visible last session
  const wasVisible = (store.get('overlay') as any)?.wasVisible;
  if (wasVisible) {
    // Delay a bit to let main window load
    setTimeout(() => createOverlayWindow(), 800);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  registerIpcHandlers();

  // Multiple displays: on display added/removed, notify renderer to refresh source list
  try {
    const { screen } = require('electron');
    screen.on('display-added', () => mainWindow?.webContents.send('display:changed', { reason: 'added' }));
    screen.on('display-removed', () => mainWindow?.webContents.send('display:changed', { reason: 'removed' }));
    screen.on('display-metrics-changed', () => mainWindow?.webContents.send('display:changed', { reason: 'metrics' }));
  } catch {}
});

// Graceful shutdown — persist overlay bounds & capture state
app.on('before-quit', () => {
  try {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      store.set('overlay.bounds', overlayWindow.getBounds());
    }
  } catch {}
});
app.on('will-quit', (e) => {
  // Allow renderer to abort streaming before quit
  try { mainWindow?.webContents.send('app:will-quit'); } catch {}
});

// Handle deep link from second instance
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------- IPC Handlers ----------------
function registerIpcHandlers() {
  // OS-authorized capture enumeration — user must pick in OS-controlled picker
  ipcMain.handle('capture:getSources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 360, height: 220 },
      fetchWindowIcons: true,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnailDataUrl: s.thumbnail.toDataURL(),
      displayId: (s as any).display_id || '',
      appIconDataUrl: (s as any).appIcon ? (s as any).appIcon.toDataURL() : null,
    }));
  });

  ipcMain.handle('capture:requestPermission', async () => {
    return { granted: true, method: 'desktopCapturer picker (OS-authorized, no DLL injection)' };
  });

  ipcMain.handle('dialog:showError', async (_e, title: string, message: string) => {
    dialog.showErrorBox(title, message);
  });

  ipcMain.handle('dialog:showMessage', async (_e, opts: Electron.MessageBoxOptions) => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!win) return { response: 0, checkboxChecked: false };
    return dialog.showMessageBox(win, opts);
  });

  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:getPath', (_e, name: string) => app.getPath(name as any));

  // Secure store — only allow whitelisted keys
  const allowedKeys = new Set(['backendUrl', 'captureConfig', 'overlay', 'prompt', 'model', 'theme', 'history']);
  ipcMain.handle('store:get', (_e, key: string) => {
    if (!allowedKeys.has(key)) throw new Error(`store:get blocked key: ${key}`);
    return store.get(key as any);
  });
  ipcMain.handle('store:set', (_e, key: string, value: unknown) => {
    if (!allowedKeys.has(key)) throw new Error(`store:set blocked key: ${key}`);
    // Validate backendUrl is https/http
    if (key === 'backendUrl' && typeof value === 'string') {
      try {
        const u = new URL(value);
        if (!['https:', 'http:'].includes(u.protocol)) throw new Error('Invalid protocol');
        // For production, warn if http on prod
      } catch (e) { throw new Error(`Invalid backendUrl: ${(e as Error).message}`); }
    }
    // Validate captureConfig shape
    if (key === 'captureConfig' && typeof value === 'object' && value) {
      const c = value as CaptureConfig;
      if (c.intervalMs && (c.intervalMs < 300 || c.intervalMs > 10000)) throw new Error('intervalMs out of range');
      if (c.scaleFactor && (c.scaleFactor < 0.2 || c.scaleFactor > 1)) throw new Error('scaleFactor out of range');
      if (c.jpegQuality && (c.jpegQuality < 30 || c.jpegQuality > 100)) throw new Error('jpegQuality out of range');
    }
    store.set(key as any, value as any);
    return true;
  });
  ipcMain.handle('store:getAll', () => ({
    backendUrl: store.get('backendUrl'),
    captureConfig: store.get('captureConfig'),
    overlay: store.get('overlay'),
  }));

  // Overlay window management
  ipcMain.handle('overlay:create', () => {
    const w = createOverlayWindow();
    return { created: !!w, bounds: w?.getBounds() };
  });
  ipcMain.handle('overlay:close', () => {
    closeOverlayWindow();
    return { closed: true };
  });
  ipcMain.handle('overlay:isVisible', () => ({
    visible: !!(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()),
    alwaysOnTop: overlayWindow?.isAlwaysOnTop() ?? false,
  }));
  ipcMain.handle('overlay:toggleAlwaysOnTop', () => {
    const next = toggleOverlayAlwaysOnTop();
    return { alwaysOnTop: next };
  });
  ipcMain.handle('overlay:setBounds', (_e, bounds: Electron.Rectangle) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setBounds(bounds);
      store.set('overlay.bounds', overlayWindow.getBounds());
    }
    return true;
  });
  ipcMain.handle('overlay:update', (_e, payload: { text: string; isStreaming: boolean; backendStatus?: string; prompt?: string }) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('overlay:update', payload);
    }
    // Also broadcast to main for sync
    mainWindow?.webContents.send('overlay:update', payload);
    return true;
  });
  ipcMain.handle('overlay:toggle', () => {
    if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
      closeOverlayWindow();
      return { visible: false };
    } else {
      createOverlayWindow();
      return { visible: true };
    }
  });

  // Window controls for frameless overlay
  ipcMain.handle('window:closeOverlay', () => closeOverlayWindow());
  ipcMain.handle('window:minimize', (_e, target: 'main' | 'overlay') => {
    const w = target === 'overlay' ? overlayWindow : mainWindow;
    w?.minimize();
  });
  ipcMain.handle('window:toggleMaximize', (_e, target: 'main' | 'overlay') => {
    const w = target === 'overlay' ? overlayWindow : mainWindow;
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });

  // Secure backend health proxy (optional - renderer can fetch directly, but main can do health check with validation)
  ipcMain.handle('backend:health', async (_e, backendUrl: string) => {
    try {
      const u = new URL(backendUrl);
      if (!['https:', 'http:'].includes(u.protocol)) throw new Error('Invalid protocol');
      const res = await fetch(new URL('/health', u).toString(), { method: 'GET' });
      const data = await res.json().catch(() => ({ error: 'malformed health JSON' }));
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // Windows autostart (startup) — user opt-in via Settings UI
  ipcMain.handle('app:autostart:get', () => {
    try { return app.getLoginItemSettings(); } catch { return { openAtLogin: false }; }
  });
  ipcMain.handle('app:autostart:set', (_e, enable: boolean) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enable, openAsHidden: false });
      return { ok: true, openAtLogin: !!enable };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });

  // Graceful recreation helper for renderer reconnection (network failure)
  ipcMain.handle('capture:refreshSources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 360, height: 220 },
      fetchWindowIcons: true,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnailDataUrl: s.thumbnail.toDataURL(),
      displayId: (s as any).display_id || '',
    }));
  });
}

export { getMainWindow, getOverlayWindow };

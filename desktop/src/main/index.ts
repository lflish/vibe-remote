import { app, BrowserWindow, clipboard, ipcMain, safeStorage, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { MachineStore } from './machine-store';

let mainWindow: BrowserWindow | null = null;

// Persisted window geometry, so the app reopens at the size the user left it
// (and maximized if it was maximized) instead of always at the 1200x800 default.
type WindowState = {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
};

// First run fills the screen's work area (minus the menu bar / Dock) rather than
// opening a small window the user has to resize. Only the default: once a size
// has been saved, that wins — so manually shrinking the window sticks.
function defaultWindowState(): WindowState {
  const { workAreaSize } = screen.getPrimaryDisplay();
  return {
    width: Math.max(800, workAreaSize.width),
    height: Math.max(500, workAreaSize.height),
    maximized: true,
  };
}

function getWindowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState(): WindowState {
  try {
    const parsed = JSON.parse(fs.readFileSync(getWindowStatePath(), 'utf-8')) as Partial<WindowState>;
    // Guard against a corrupted or hand-edited file: only accept sane numbers,
    // otherwise a bad value could open the window offscreen or zero-sized.
    const width = Number(parsed.width);
    const height = Number(parsed.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 800 || height < 500) {
      return defaultWindowState();
    }
    const state: WindowState = { width: Math.round(width), height: Math.round(height) };
    if (Number.isFinite(Number(parsed.x)) && Number.isFinite(Number(parsed.y))) {
      state.x = Math.round(Number(parsed.x));
      state.y = Math.round(Number(parsed.y));
    }
    if (parsed.maximized) state.maximized = true;
    return state;
  } catch {
    return defaultWindowState();
  }
}

function saveWindowState(win: BrowserWindow): void {
  try {
    // getNormalBounds is the pre-maximize box, so restoring an un-maximized
    // window doesn't snap it to full-screen dimensions.
    const bounds = win.getNormalBounds();
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: win.isMaximized(),
    };
    fs.mkdirSync(path.dirname(getWindowStatePath()), { recursive: true });
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state, null, 2));
  } catch {
    // Geometry is a convenience; never let a write failure break shutdown.
  }
}

// Dev-only: open a CDP endpoint when VIBE_REMOTE_DEBUG_PORT is set, so the renderer
// can be driven/inspected by tooling. Must be set before app is ready. Never in a
// packaged build: an open CDP port with allow-origins=* hands the renderer (and
// the plaintext tokens it holds) to anything that can reach the port.
if (!app.isPackaged && process.env.VIBE_REMOTE_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.VIBE_REMOTE_DEBUG_PORT);
  app.commandLine.appendSwitch('remote-allow-origins', '*');
}

function createWindow() {
  const windowState = loadWindowState();
  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset', // native frameless with traffic lights on Mac
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#F5F4EF', // match the renderer to avoid a dark launch flash
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (windowState.maximized) mainWindow.maximize();

  // Persist geometry on the events that can change it. Debounced because resize
  // and move fire continuously while dragging.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) saveWindowState(mainWindow);
    }, 400);
  };
  mainWindow.on('resize', scheduleSave);
  mainWindow.on('move', scheduleSave);
  mainWindow.on('maximize', scheduleSave);
  mainWindow.on('unmaximize', scheduleSave);
  // Write synchronously on close: the debounced save may not have fired yet.
  mainWindow.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    if (mainWindow && !mainWindow.isDestroyed()) saveWindowState(mainWindow);
  });

  // The window only ever shows our own UI. Block any navigation away from it
  // (a dropped link, a stray location change) and every window.open, so remote
  // content can never end up running next to the preload bridge.
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (devServerUrl && url.startsWith(devServerUrl)) return; // Vite HMR full reload
    event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // In dev, load from Vite dev server; in prod, load built HTML
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // In dev, forward renderer console to the main process stdout and open
  // DevTools for easier debugging. Set VIBE_REMOTE_NO_DEVTOOLS=1 to suppress.
  if (process.env.VITE_DEV_SERVER_URL && !process.env.VIBE_REMOTE_NO_DEVTOOLS) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      console.log(`[renderer:${level}] ${message} (${source}:${line})`);
    });
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// machines.json lives in userData. Tokens are encrypted with safeStorage (see
// machine-store.ts); created lazily because both userData and safeStorage
// need the app to be ready.
let machineStore: MachineStore | null = null;
function getMachineStore(): MachineStore {
  if (!machineStore) {
    machineStore = new MachineStore({
      path: path.join(app.getPath('userData'), 'machines.json'),
      crypto: {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: (plain) => safeStorage.encryptString(plain),
        decrypt: (encrypted) => safeStorage.decryptString(encrypted),
      },
      warn: (message) => console.warn(`[machines] ${message}`),
    });
  }
  return machineStore;
}

// IPC handlers for renderer process. Errors thrown here reject the renderer's
// promise, which it surfaces (init error / "Save failed").
ipcMain.handle('get-machines', () => {
  return getMachineStore().load();
});

ipcMain.handle('save-machines', (_event, machines: unknown) => {
  // Validated in the store: the renderer is not trusted to send well-formed data.
  getMachineStore().save(machines);
  return true;
});

ipcMain.handle('clipboard-read-text', () => clipboard.readText());

ipcMain.handle('clipboard-write-text', (_event, text: string) => {
  clipboard.writeText(text);
  return true;
});

// App lifecycle
app.whenReady().then(() => {
  // Files written by older versions are 0644; tighten before anything reads them.
  getMachineStore().tightenPermissions();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

import { app, BrowserWindow, ipcMain, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import type { MachineConfig } from '../shared/protocol';

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
// can be driven/inspected by tooling. Must be set before app is ready.
if (process.env.VIBE_REMOTE_DEBUG_PORT) {
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

// Load machine config from userData
function getMachinesConfigPath(): string {
  return path.join(app.getPath('userData'), 'machines.json');
}

function loadMachines(): MachineConfig[] {
  const configPath = getMachinesConfigPath();
  try {
    const data = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(data);
  } catch {
    // Return empty if no config exists yet
    return [];
  }
}

function saveMachines(machines: MachineConfig[]): void {
  const configPath = getMachinesConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(machines, null, 2));
}

// IPC handlers for renderer process
ipcMain.handle('get-machines', () => {
  return loadMachines();
});

ipcMain.handle('save-machines', (_event, machines: MachineConfig[]) => {
  saveMachines(machines);
  return true;
});

// App lifecycle
app.whenReady().then(createWindow);

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

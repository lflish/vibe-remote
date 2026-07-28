import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import type { MachineConfig } from '../shared/protocol';

let mainWindow: BrowserWindow | null = null;

// Dev-only: open a CDP endpoint when VIBE_REMOTE_DEBUG_PORT is set, so the renderer
// can be driven/inspected by tooling. Must be set before app is ready.
if (process.env.VIBE_REMOTE_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.VIBE_REMOTE_DEBUG_PORT);
  app.commandLine.appendSwitch('remote-allow-origins', '*');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset', // native frameless with traffic lights on Mac
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#1e1e2e', // dark background to avoid flash
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
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

// Workdir list persistence (userData/workdirs.json). Keyed by machineKey
// (`addr:port`) → dirs[]. This is the desktop equivalent of the web's
// localStorage workdir store: 会话 = workdir, so each machine remembers the
// workdirs the user has opened chats in.
function getWorkdirsConfigPath(): string {
  return path.join(app.getPath('userData'), 'workdirs.json');
}

function readAllWorkdirs(): Record<string, string[]> {
  try {
    return JSON.parse(fs.readFileSync(getWorkdirsConfigPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function writeAllWorkdirs(all: Record<string, string[]>): void {
  const configPath = getWorkdirsConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(all, null, 2));
}

// IPC handlers for renderer process
ipcMain.handle('get-machines', () => {
  return loadMachines();
});

ipcMain.handle('save-machines', (_event, machines: MachineConfig[]) => {
  saveMachines(machines);
  return true;
});

ipcMain.handle('workdirs:get', (_event, machineKey: string): string[] => {
  return readAllWorkdirs()[machineKey] ?? [];
});

ipcMain.handle('workdirs:add', (_event, args: { machineKey: string; dir: string }) => {
  const all = readAllWorkdirs();
  const cur = all[args.machineKey] ?? [];
  if (!cur.includes(args.dir)) all[args.machineKey] = [...cur, args.dir];
  writeAllWorkdirs(all);
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

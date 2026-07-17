import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  FrameType,
  type AuthFrame,
  type AttachFrame,
  type DataFrameC2S,
  type ResizeFrame,
  type ServerFrame,
  type MachineConfig,
  type SessionInfo,
} from '../shared/protocol';
import { CcdeskClient, ConnectionState } from './client';

// Declared by preload
declare global {
  interface Window {
    ccdesk: {
      getMachines(): Promise<MachineConfig[]>;
      saveMachines(machines: MachineConfig[]): Promise<boolean>;
    };
  }
}

// App state
let machines: MachineConfig[] = [];
let clients: Map<string, CcdeskClient> = new Map(); // machineAddr → client
let activeClient: CcdeskClient | null = null;
let activeSessionId: string | null = null;
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;

// --- Initialization ---

async function init() {
  machines = await window.ccdesk.getMachines();

  // If no machines configured, show placeholder
  if (machines.length === 0) {
    renderEmptyState();
    return;
  }

  initTerminal();
  renderMachineList();
  connectAllMachines();
}

function initTerminal() {
  const container = document.getElementById('terminal-container')!;

  terminal = new Terminal({
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    theme: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#45475a',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#cba6f7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#cba6f7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8',
    },
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
  });

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  fitAddon.fit();

  // Handle terminal input → send to server
  terminal.onData((data: string) => {
    if (activeClient && activeSessionId) {
      const encoded = btoa(data);
      activeClient.sendData(encoded);
    }
  });

  // Handle resize
  const resizeObserver = new ResizeObserver(() => {
    if (fitAddon) {
      fitAddon.fit();
    }
  });
  resizeObserver.observe(container);

  terminal.onResize(({ cols, rows }) => {
    if (activeClient && activeSessionId) {
      activeClient.sendResize(cols, rows);
    }
  });
}

// --- Machine connections ---

function connectAllMachines() {
  for (const machine of machines) {
    const client = new CcdeskClient(machine);

    client.onStateChange = (state) => {
      updateMachineStatus(machine.addr, state);
      updateStatusBar();
    };

    client.onData = (payload: string) => {
      if (terminal && client === activeClient) {
        const decoded = atob(payload);
        terminal.write(decoded);
      }
    };

    client.onSessionList = (sessions: SessionInfo[]) => {
      renderSessionsForMachine(machine.addr, sessions);
    };

    client.onExit = (code: number) => {
      updateStatusBar(`Session exited (code ${code})`);
    };

    client.onError = (msg: string) => {
      console.error(`[${machine.name}] error: ${msg}`);
    };

    clients.set(machine.addr, client);
    client.connect();
  }
}

// --- UI rendering ---

function renderMachineList() {
  const container = document.getElementById('machine-list')!;
  container.innerHTML = '';

  for (const machine of machines) {
    const group = document.createElement('div');
    group.className = 'machine-group';
    group.innerHTML = `
      <div class="machine-name" data-addr="${machine.addr}">
        <span class="machine-status" id="status-${machine.addr}"></span>
        <span>${machine.name}</span>
      </div>
      <div class="session-list" id="sessions-${machine.addr}"></div>
    `;
    container.appendChild(group);
  }
}

function renderSessionsForMachine(addr: string, sessions: SessionInfo[]) {
  const container = document.getElementById(`sessions-${addr}`);
  if (!container) return;

  container.innerHTML = '';
  for (const session of sessions) {
    const item = document.createElement('div');
    item.className = `session-item${session.id === activeSessionId ? ' active' : ''}`;
    item.dataset.sessionId = session.id;
    item.dataset.machineAddr = addr;

    // Show a short label: workdir basename or session id
    const label = session.workdir
      ? session.workdir.split('/').pop() || session.id
      : session.id;
    item.textContent = label;

    item.addEventListener('click', () => switchToSession(addr, session.id));
    container.appendChild(item);
  }
}

function updateMachineStatus(addr: string, state: ConnectionState) {
  const dot = document.getElementById(`status-${addr}`);
  if (!dot) return;
  dot.className = 'machine-status';
  if (state === ConnectionState.Connected) dot.classList.add('connected');
  else if (state === ConnectionState.Reconnecting) dot.classList.add('reconnecting');
  else if (state === ConnectionState.Error) dot.classList.add('error');
}

function updateStatusBar(extra?: string) {
  const connEl = document.getElementById('status-connection')!;
  const sessionEl = document.getElementById('status-session')!;

  if (activeClient) {
    const state = activeClient.state;
    connEl.className = '';
    if (state === ConnectionState.Connected) {
      connEl.className = 'connected';
      connEl.textContent = `Connected to ${activeClient.machine.name}`;
    } else if (state === ConnectionState.Reconnecting) {
      connEl.className = 'reconnecting';
      connEl.textContent = 'Reconnecting...';
    } else {
      connEl.textContent = 'Disconnected';
    }
  } else {
    connEl.textContent = 'No connection';
  }

  sessionEl.textContent = extra || (activeSessionId ? `Session: ${activeSessionId}` : '');
}

function renderEmptyState() {
  const container = document.getElementById('terminal-container')!;
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);flex-direction:column;gap:12px;">
      <p>No machines configured.</p>
      <p style="font-size:11px;">Add machines to <code>machines.json</code> in the app data folder.</p>
    </div>
  `;
}

// --- Session switching ---

function switchToSession(machineAddr: string, sessionId: string) {
  const client = clients.get(machineAddr);
  if (!client) return;

  activeClient = client;
  activeSessionId = sessionId;

  // Clear terminal and re-attach
  if (terminal) {
    terminal.clear();
  }

  // Attach to the session
  if (fitAddon && terminal) {
    const dims = fitAddon.proposeDimensions();
    client.attach(sessionId, dims?.cols || 80, dims?.rows || 24);
  }

  updateStatusBar();
  renderMachineList(); // refresh active state
}

// --- New session button ---

document.getElementById('btn-new-session')?.addEventListener('click', () => {
  if (machines.length === 0) return;

  // For now, create on first machine with default workdir
  const machine = machines[0];
  const client = clients.get(machine.addr);
  if (!client) return;

  activeClient = client;

  if (terminal && fitAddon) {
    terminal.clear();
    const dims = fitAddon.proposeDimensions();
    client.attach('', dims?.cols || 80, dims?.rows || 24);
  }
});

// --- Boot ---
document.addEventListener('DOMContentLoaded', init);

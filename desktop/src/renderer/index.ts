import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { MachineConfig, SessionInfo } from '../shared/protocol';
import { CcdeskClient, ConnectionState } from './client';
import { CcdeskRest } from './rest';
import { openDirPicker } from './dirpicker';
import { openMachineManager } from './machines';

// Declared by preload
declare global {
  interface Window {
    ccdesk: {
      getMachines(): Promise<MachineConfig[]>;
      saveMachines(machines: MachineConfig[]): Promise<boolean>;
    };
  }
}

// A SessionView is one open session: its own WebSocket (CcdeskClient) and its
// own xterm instance. Multiple sessions stay open simultaneously; switching
// just shows/hides their terminal containers. tmux keeps unfocused sessions
// alive server-side regardless.
interface SessionView {
  key: string; // `${machineAddr}::${sessionId}`
  machine: MachineConfig;
  sessionId: string; // '' until the server assigns one for a new session
  client: CcdeskClient;
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLElement;
  banner: HTMLElement; // reconnect banner overlay, hidden by default
}

// --- App state ---
// Machine-keyed maps use `addr:port` (machineKey) rather than addr alone, so
// two ccdeskd instances on the same host but different ports don't collide.
let machines: MachineConfig[] = [];
const rests = new Map<string, CcdeskRest>(); // machineKey -> REST client
const views = new Map<string, SessionView>(); // view key -> open session view
const machineSessions = new Map<string, SessionInfo[]>(); // machineKey -> sessions (REST)
const machineOnline = new Map<string, boolean>(); // machineKey -> reachable
let activeKey: string | null = null;

const machineKey = (m: MachineConfig) => `${m.addr}:${m.port}`;
const viewKey = (m: MachineConfig, sid: string) => `${machineKey(m)}::${sid}`;

// --- base64 <-> bytes helpers (UTF-8 safe) ---
// PTY bytes travel as base64; convert to/from raw bytes (not JS strings) so
// multi-byte UTF-8 sequences (box-drawing, emoji, CJK) survive intact.
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// --- Init ---

async function init() {
  machines = await window.ccdesk.getMachines();
  wireManageMachinesButton();
  wireNewSessionButton();
  wireWindowResize();
  if (machines.length === 0) {
    renderEmptyState();
    return;
  }
  rebuildRests();
  await refreshAllMachines();
  startPolling();
}

// startPolling starts the 5s sidebar refresh loop. Idempotent (guarded by a
// module-level flag) so the empty→non-empty path can start it without ever
// stacking multiple intervals. Poll each machine's session list periodically so
// the sidebar reflects sessions created elsewhere and reachability changes.
let pollingStarted = false;
function startPolling() {
  if (pollingStarted) return;
  pollingStarted = true;
  setInterval(refreshAllMachines, 5000);
}

// rebuildRests rebuilds the machineKey→REST map after the machine list changes
// (add/edit/delete via the manager). Existing session WebSockets are untouched.
function rebuildRests() {
  rests.clear();
  for (const m of machines) rests.set(machineKey(m), new CcdeskRest(m));
}

// wireManageMachinesButton opens the machine manager and hot-reloads on save:
// rebuild REST clients, close views for machines that no longer exist, refresh.
function wireManageMachinesButton() {
  document.getElementById('btn-manage-machines')?.addEventListener('click', () => {
    openMachineManager({
      machines,
      onSaved: (updated) => {
        const removedKeys = machines
          .filter((old) => !updated.some((u) => machineKey(u) === machineKey(old)))
          .map(machineKey);
        machines = updated;
        rebuildRests();
        // Close views belonging to removed machines (does NOT kill remote sessions).
        let activeRemoved = false;
        for (const rk of removedKeys) {
          for (const [k, v] of [...views]) {
            if (machineKey(v.machine) === rk) {
              v.client.disconnect();
              v.terminal.dispose();
              v.container.remove();
              views.delete(k);
              if (activeKey === k) { activeKey = null; activeRemoved = true; }
            }
          }
        }
        // If the active view was removed, fall back to another open view so the
        // main area doesn't go blank (mirrors closeSession's next-view logic).
        if (activeRemoved) {
          const next = views.keys().next();
          if (!next.done) setActive(next.value);
        }
        if (machines.length === 0) {
          renderEmptyState();
        } else {
          // Empty→non-empty transition: drop the leftover empty-state box (if any),
          // then refresh and make sure the poll loop is running.
          document.querySelector('#terminal-container .empty-state')?.remove();
          refreshAllMachines();
          startPolling();
        }
      },
    });
  });
}

// wireWindowResize refits the active terminal when the window resizes, so the
// visible session's PTY dimensions track the window instead of staying at the
// size it was first opened at (which would misdraw wrapped lines). Debounced
// to avoid a resize storm while dragging.
function wireWindowResize() {
  let t: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      if (!activeKey) return;
      const view = views.get(activeKey);
      if (view) view.fitAddon.fit(); // fit() triggers term.onResize → sendResize
    }, 80);
  });
}

// refreshAllMachines pulls each machine's session list over REST and updates
// the sidebar + online status.
async function refreshAllMachines() {
  await Promise.all(
    machines.map(async (m) => {
      const mk = machineKey(m);
      try {
        const list = await rests.get(mk)!.listSessions();
        machineSessions.set(mk, list);
        machineOnline.set(mk, true);
      } catch {
        machineOnline.set(mk, false);
      }
    }),
  );
  renderSidebar();
  updateStatusBar();
}

// --- Session views ---

function makeTerminal(): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    theme: {
      background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc',
      selectionBackground: '#45475a',
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
      blue: '#89b4fa', magenta: '#cba6f7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#cba6f7',
      brightCyan: '#94e2d5', brightWhite: '#a6adc8',
    },
    cursorBlink: true, scrollback: 10000, allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { term, fit };
}

// openSession creates a new SessionView (its own WS + xterm) and attaches.
// sessionId '' means create a brand-new session with the given workdir.
function openSession(machine: MachineConfig, sessionId: string, workdir?: string): SessionView {
  const key = viewKey(machine, sessionId);
  const existing = views.get(key);
  if (existing) {
    setActive(key);
    return existing;
  }

  const wrap = document.getElementById('terminal-container')!;
  const container = document.createElement('div');
  container.className = 'term-instance';
  container.style.display = 'none';
  wrap.appendChild(container);

  const { term, fit } = makeTerminal();
  term.open(container);

  const client = new CcdeskClient(machine);
  const banner = document.createElement('div');
  banner.className = 'reconnect-banner';
  banner.style.display = 'none';
  const view: SessionView = { key, machine, sessionId, client, terminal: term, fitAddon: fit, container, banner };
  views.set(key, view);

  const bannerText = document.createElement('span');
  bannerText.textContent = 'Connection lost, reconnecting…';
  const retryBtn = document.createElement('button');
  retryBtn.textContent = 'Retry now';
  retryBtn.addEventListener('click', () => view.client.reconnectNow());
  banner.append(bannerText, retryBtn);
  container.appendChild(banner);

  // Terminal input → server
  term.onData((data: string) => {
    client.sendData(bytesToBase64(new TextEncoder().encode(data)));
  });
  term.onResize(({ cols, rows }) => client.sendResize(cols, rows));

  // Server PTY bytes → terminal (Uint8Array so xterm decodes UTF-8 itself)
  client.onData = (payload: string) => term.write(base64ToBytes(payload));

  client.onReady = (sid: string) => {
    view.banner.style.display = 'none';
    // A new session gets its real id here; re-key the view and refresh sidebar.
    if (view.sessionId !== sid) {
      views.delete(view.key);
      view.sessionId = sid;
      view.key = viewKey(machine, sid);
      views.set(view.key, view);
      if (activeKey === key) activeKey = view.key;
    }
    term.clear(); // clean base for the tmux full repaint on (re)attach
    refreshAllMachines();
    updateStatusBar();
  };

  client.onStateChange = (state, attempt) => {
    // Banner shows only on the active session; non-active disconnects don't nag.
    if (state === ConnectionState.Reconnecting) {
      view.banner.style.display = 'flex';
    } else if (state === ConnectionState.Connected) {
      view.banner.style.display = 'none';
    }
    if (view.key === activeKey) updateStatusBar(undefined, attempt);
  };
  client.onExit = (code) => {
    // Write a visible marker into the terminal and surface it in the status bar
    // so a dead session isn't just a frozen screen.
    if (view.terminal) view.terminal.write(`\r\n\x1b[33m[session exited, code ${code}]\x1b[0m\r\n`);
    updateStatusBar(`Session exited (code ${code})`);
    refreshAllMachines();
  };
  client.onError = (msg) => {
    console.error(`[${machine.name}]`, msg);
    // Show the error to the user instead of leaving a blank terminal.
    if (view.terminal) view.terminal.write(`\r\n\x1b[31m[error: ${msg}]\x1b[0m\r\n`);
    if (view.key === activeKey) updateStatusBar(`Error: ${msg}`);
  };

  client.connect();
  const dims = fit.proposeDimensions();
  client.attach(sessionId, dims?.cols || 80, dims?.rows || 24, workdir);

  setActive(view.key);
  return view;
}

// setActive shows one session view and hides the rest, then fits + focuses it.
function setActive(key: string) {
  activeKey = key;
  for (const [k, v] of views) {
    v.container.style.display = k === key ? 'block' : 'none';
  }
  const view = views.get(key);
  if (view) {
    requestAnimationFrame(() => {
      view.fitAddon.fit();
      view.terminal.focus();
    });
  }
  renderSidebar();
  updateStatusBar();
}

// --- Sidebar ---

function renderSidebar() {
  const container = document.getElementById('machine-list')!;
  container.textContent = '';

  for (const machine of machines) {
    const group = document.createElement('div');
    group.className = 'machine-group';

    const nameRow = document.createElement('div');
    nameRow.className = 'machine-name';
    const dot = document.createElement('span');
    dot.className = 'machine-status' + (machineOnline.get(machineKey(machine)) ? ' connected' : ' error');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = machine.name;
    nameRow.append(dot, nameSpan);

    const list = document.createElement('div');
    list.className = 'session-list';

    const sessions = machineSessions.get(machineKey(machine)) || [];
    for (const s of sessions) {
      const key = viewKey(machine, s.id);
      const item = document.createElement('div');
      item.className = 'session-item' + (key === activeKey ? ' active' : '');

      const label = document.createElement('span');
      label.className = 'session-label';
      label.textContent = (s.workdir ? s.workdir.split('/').pop() : '') || s.id;
      label.title = s.workdir || s.id;
      label.addEventListener('click', () => openSession(machine, s.id));

      const close = document.createElement('span');
      close.className = 'session-close';
      close.textContent = '×';
      close.title = 'Close session (kills remote claude)';
      close.addEventListener('click', (e) => { e.stopPropagation(); closeSession(machine, s.id); });

      item.append(label, close);
      list.appendChild(item);
    }

    group.append(nameRow, list);
    container.appendChild(group);
  }
}

function updateStatusBar(extra?: string, attempt?: number) {
  const connEl = document.getElementById('status-connection')!;
  const sessionEl = document.getElementById('status-session')!;
  const view = activeKey ? views.get(activeKey) : null;

  connEl.className = '';
  if (view) {
    const st = view.client.state;
    if (st === ConnectionState.Connected) {
      connEl.className = 'connected';
      connEl.textContent = `Connected · ${view.machine.name}`;
    } else if (st === ConnectionState.Reconnecting) {
      connEl.className = 'reconnecting';
      const n = attempt ?? 0;
      connEl.textContent = n > 0 ? `Reconnecting… (attempt ${n})` : 'Reconnecting…';
    } else {
      connEl.textContent = 'Disconnected';
    }
  } else {
    const anyOnline = [...machineOnline.values()].some(Boolean);
    connEl.className = anyOnline ? 'connected' : '';
    connEl.textContent = anyOnline ? 'Ready' : 'No connection';
  }
  sessionEl.textContent = extra || (view?.sessionId ? `Session: ${view.sessionId}` : '');
}

// closeSession kills the remote session (tmux + claude) and removes its view.
async function closeSession(machine: MachineConfig, sessionId: string) {
  try {
    await rests.get(machineKey(machine))!.deleteSession(sessionId);
  } catch (e) {
    console.error('delete session failed', e);
  }
  const key = viewKey(machine, sessionId);
  const view = views.get(key);
  if (view) {
    view.client.disconnect();
    view.terminal.dispose();
    view.container.remove();
    views.delete(key);
    if (activeKey === key) {
      activeKey = null;
      const next = views.keys().next();
      if (!next.done) setActive(next.value);
    }
  }
  refreshAllMachines();
}

function renderEmptyState() {
  const container = document.getElementById('terminal-container')!;
  container.textContent = '';
  const box = document.createElement('div');
  box.className = 'empty-state';
  const h = document.createElement('p');
  h.textContent = 'Add your first machine';
  h.style.fontSize = '16px';
  h.style.color = 'var(--text-secondary)';
  const p = document.createElement('p');
  p.style.fontSize = '12px';
  p.textContent = 'The machine must be on the same tailnet and running ccdeskd.';
  const btn = document.createElement('button');
  btn.className = 'btn-primary';
  btn.style.width = 'auto';
  btn.style.marginTop = '8px';
  btn.textContent = 'Add machine';
  btn.addEventListener('click', () => document.getElementById('btn-manage-machines')?.dispatchEvent(new MouseEvent('click')));
  const hint = document.createElement('p');
  hint.style.fontSize = '11px';
  hint.textContent = 'Address: tailscale IP (100.x) or MagicDNS name · Token: matches ccdeskd config';
  box.append(h, p, btn, hint);
  container.appendChild(box);
}

// --- New session button ---

function wireNewSessionButton() {
  document.getElementById('btn-new-session')?.addEventListener('click', async () => {
    if (machines.length === 0) return;
    // Choose the machine of the active session, else the first machine.
    const active = activeKey ? views.get(activeKey) : null;
    const machine = active?.machine || machines[0];
    const workdir = await openDirPicker(machine);
    if (workdir === null) return; // cancelled
    openSession(machine, '', workdir);
  });
}

// --- Boot ---
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}




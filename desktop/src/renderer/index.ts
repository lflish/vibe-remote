import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { MachineConfig, SessionInfo, SessionMode } from '../shared/protocol';
import { VibeRemoteClient, ConnectionState } from './client';
import { VibeRemoteRest, type MachineInfo } from './rest';
import { openDirPicker } from './dirpicker';
import { openMachineManager } from './machines';

// Declared by preload
declare global {
  interface Window {
    vibeRemote: {
      getMachines(): Promise<MachineConfig[]>;
      saveMachines(machines: MachineConfig[]): Promise<boolean>;
    };
  }
}

// A SessionView is one open session: its own WebSocket (VibeRemoteClient) and its
// own xterm instance. Multiple sessions stay open simultaneously; switching
// just shows/hides their terminal containers. tmux keeps unfocused sessions
// alive server-side regardless.
interface SessionView {
  key: string; // `${machineAddr}::${sessionId}`
  machine: MachineConfig;
  sessionId: string; // '' until the server assigns one for a new session
  client: VibeRemoteClient;
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLElement;
  banner: HTMLElement; // reconnect banner overlay, hidden by default
  activity: 'none' | 'output' | 'idle' | 'waiting'; // sidebar dot state
  suppressUntil: number; // ms timestamp: ignore onData activity until then (attach repaint)
}

// --- App state ---
// Machine-keyed maps use `addr:port` (machineKey) rather than addr alone, so
// two vibe-remoted instances on the same host but different ports don't collide.
let machines: MachineConfig[] = [];
const rests = new Map<string, VibeRemoteRest>(); // machineKey -> REST client
const views = new Map<string, SessionView>(); // view key -> open session view
const machineSessions = new Map<string, SessionInfo[]>(); // machineKey -> sessions (REST)
const machineInfo = new Map<string, MachineInfo>(); // machineKey -> info (REST)
const machineOnline = new Map<string, boolean>(); // machineKey -> reachable
let activeKey: string | null = null;
let overviewMachineKey: string | null = null;
// The machine a new session targets when there is no active session to inherit
// from. Set by clicking a machine header in the sidebar. Must be module-level
// state (not a DOM marker) because renderSidebar rebuilds the whole sidebar DOM
// on every 5s poll — a DOM flag would be wiped each rebuild.
let selectedMachineKey: string | null = null;
// While an inline rename input is open we suppress full sidebar rebuilds:
// the 5s poll (and onReady/onExit) call renderSidebar(), which wipes and
// recreates the whole sidebar DOM — that would delete the focused input and
// its blur would silently commit half-typed text. Paused during editing.
let renamingActive = false;
// Every refresh captures a generation. A newer refresh or machine-list edit
// invalidates older in-flight requests without serializing the 5s poll.
let machineRefreshGeneration = 0;

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
  machines = await window.vibeRemote.getMachines();
  wireManageMachinesButton();
  wireNewSessionButton();
  wireWindowResize();
  if (machines.length === 0) {
    renderEmptyState();
    return;
  }
  // Default the new-session target to the first machine so the selection is
  // always visible and "new session" is predictable before any click.
  selectedMachineKey = machineKey(machines[0]);
  rebuildRests();
  await refreshAllMachines();
  showMachineOverview(machines[0]);
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
  for (const m of machines) rests.set(machineKey(m), new VibeRemoteRest(m));
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
        machineRefreshGeneration++;
        for (const rk of removedKeys) {
          machineSessions.delete(rk);
          machineInfo.delete(rk);
          machineOnline.delete(rk);
        }
        // Drop a selection that points at a now-removed machine so the
        // highlight (and new-session target) never dangles.
        if (selectedMachineKey && !machines.some((m) => machineKey(m) === selectedMachineKey)) {
          selectedMachineKey = machines.length > 0 ? machineKey(machines[0]) : null;
        }
        if (overviewMachineKey && !machines.some((m) => machineKey(m) === overviewMachineKey)) {
          overviewMachineKey = null;
        }
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
          overviewMachineKey = null;
          document.getElementById('machine-overview')?.setAttribute('hidden', '');
          renderEmptyState();
        } else {
          // Empty→non-empty transition: drop the leftover empty-state box (if any),
          // then refresh and make sure the poll loop is running.
          document.querySelector('#terminal-container .empty-state')?.remove();
          refreshAllMachines();
          startPolling();
          if (!overviewMachineKey) showMachineOverview(machines[0]);
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

// refreshAllMachines pulls each machine's sessions and machine metadata over
// REST. Session-list reachability drives online status; a transient info failure
// retains the last successful metadata so the workspace does not flicker.
async function refreshAllMachines() {
  const generation = ++machineRefreshGeneration;
  const refreshMachines = machines.slice();
  await Promise.all(
    refreshMachines.map(async (m) => {
      const mk = machineKey(m);
      const rest = rests.get(mk);
      if (!rest) return;
      const [sessionsResult, infoResult] = await Promise.allSettled([
        rest.listSessions(),
        rest.info(),
      ]);
      // Machine edits invalidate this request, including responses that arrive
      // after a removed machine was deleted and then re-added.
      if (generation !== machineRefreshGeneration) return;
      if (sessionsResult.status === 'fulfilled') {
        machineSessions.set(mk, sessionsResult.value);
        machineOnline.set(mk, true);
      } else {
        machineOnline.set(mk, false);
      }
      if (infoResult.status === 'fulfilled') {
        machineInfo.set(mk, infoResult.value);
      }
    }),
  );
  if (generation !== machineRefreshGeneration) return;
  // The machine list may only change through onSaved, which advances the
  // generation. Check membership as a defensive guard before rendering.
  if (refreshMachines.some((m) => !machines.some((current) => machineKey(current) === machineKey(m)))) return;
  renderSidebar();
  if (overviewMachineKey) {
    const overviewMachine = machines.find((m) => machineKey(m) === overviewMachineKey);
    if (overviewMachine) renderMachineOverview(overviewMachine);
  }
  updateStatusBar();
}

// --- Session views ---

function renderMachineOverview(machine: MachineConfig) {
  const mount = document.getElementById('machine-overview');
  if (!mount) return;

  const mk = machineKey(machine);
  const online = machineOnline.get(mk) === true;
  const info = machineInfo.get(mk);
  const sessions = machineSessions.get(mk) ?? [];
  const localViewCount = [...views.values()].filter((view) => machineKey(view.machine) === mk).length;
  mount.textContent = '';

  const workspace = document.createElement('div');
  workspace.className = 'workspace-page';

  const header = document.createElement('header');
  header.className = 'workspace-header';
  const identity = document.createElement('div');
  identity.className = 'workspace-identity';
  const eyebrow = document.createElement('p');
  eyebrow.className = 'workspace-eyebrow';
  eyebrow.textContent = 'Machine workspace';
  const title = document.createElement('h1');
  title.textContent = machine.name;
  const metadata = document.createElement('div');
  metadata.className = 'workspace-metadata';
  const metadataValues = [
    `${machine.addr}:${machine.port}`,
    info?.default_workdir || 'Default directory unavailable',
    info ? (info.tmux_enabled ? 'tmux enabled' : 'tmux disabled') : 'tmux status unavailable',
  ];
  for (const value of metadataValues) {
    const item = document.createElement('span');
    item.textContent = value;
    metadata.appendChild(item);
  }
  identity.append(eyebrow, title, metadata);

  const headerActions = document.createElement('div');
  headerActions.className = 'workspace-header-actions';
  const manage = document.createElement('button');
  manage.type = 'button';
  manage.className = 'btn-secondary';
  manage.textContent = 'Manage';
  manage.addEventListener('click', () => {
    document.getElementById('btn-manage-machines')?.dispatchEvent(new MouseEvent('click'));
  });
  const create = document.createElement('button');
  create.type = 'button';
  create.className = 'btn-primary workspace-new-session';
  create.textContent = '+ New session';
  create.addEventListener('click', () => startNewSession(machine));
  headerActions.append(manage, create);
  header.append(identity, headerActions);

  const stats = document.createElement('section');
  stats.className = 'workspace-stats';
  stats.setAttribute('aria-label', 'Machine summary');
  const statValues = [
    { label: 'Sessions', value: String(sessions.length) },
    { label: 'Open here', value: String(localViewCount) },
    { label: 'Connection', value: isLoopbackAddress(machine.addr) ? 'Local' : 'Remote' },
  ];
  for (const stat of statValues) {
    const item = document.createElement('div');
    item.className = 'workspace-stat';
    const value = document.createElement('strong');
    value.textContent = stat.value;
    const label = document.createElement('span');
    label.textContent = stat.label;
    item.append(value, label);
    stats.appendChild(item);
  }

  const recentSection = document.createElement('section');
  recentSection.className = 'workspace-section';
  const recentHeading = document.createElement('div');
  recentHeading.className = 'workspace-section-heading';
  const recentTitle = document.createElement('h2');
  recentTitle.textContent = 'Recent sessions';
  const connection = document.createElement('span');
  connection.className = `workspace-connection${online ? ' connected' : ''}`;
  connection.textContent = online ? 'Connected' : 'Offline';
  recentHeading.append(recentTitle, connection);
  recentSection.appendChild(recentHeading);

  const recentList = document.createElement('div');
  recentList.className = 'workspace-recent-list';
  const recent = [...sessions].sort((a, b) => b.created.localeCompare(a.created));
  if (recent.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'workspace-empty';
    empty.textContent = 'No sessions on this machine yet.';
    recentList.appendChild(empty);
  } else {
    for (const session of recent.slice(0, 5)) {
      const key = viewKey(machine, session.id);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'workspace-session-row';
      const sessionIdentity = document.createElement('span');
      sessionIdentity.className = 'workspace-session-identity';
      const sessionTitle = document.createElement('strong');
      sessionTitle.textContent = session.title || (session.workdir ? session.workdir.split('/').pop() : '') || session.id;
      const workdir = document.createElement('span');
      workdir.textContent = session.workdir || 'Working directory unavailable';
      sessionIdentity.append(sessionTitle, workdir);
      const badges = document.createElement('span');
      badges.className = 'workspace-session-badges';
      const mode = document.createElement('span');
      mode.className = 'workspace-badge';
      mode.textContent = session.mode === 'worktree' ? 'Worktree' : 'Normal';
      const status = document.createElement('span');
      status.className = 'workspace-badge workspace-badge-status';
      status.textContent = views.has(key) ? 'Running' : 'Remote';
      badges.append(mode, status);
      row.append(sessionIdentity, badges);
      row.addEventListener('click', () => openSession(machine, session.id));
      recentList.appendChild(row);
    }
  }
  recentSection.appendChild(recentList);

  const modesSection = document.createElement('section');
  modesSection.className = 'workspace-section';
  const modesTitle = document.createElement('h2');
  modesTitle.textContent = 'Start a session';
  const modeGrid = document.createElement('div');
  modeGrid.className = 'workspace-mode-grid';
  const modes: Array<{ mode: SessionMode; title: string; description: string; action: string }> = [
    {
      mode: 'normal',
      title: 'Open existing directory',
      description: 'Run in a folder on this machine without changing its Git setup.',
      action: 'Choose directory',
    },
    {
      mode: 'worktree',
      title: 'Create isolated worktree',
      description: 'Create an isolated branch and worktree before launching the session.',
      action: 'Choose repository',
    },
  ];
  for (const item of modes) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'workspace-mode-card';
    const cardTitle = document.createElement('strong');
    cardTitle.textContent = item.title;
    const description = document.createElement('span');
    description.textContent = item.description;
    const action = document.createElement('span');
    action.className = 'workspace-mode-action';
    action.textContent = `${item.action} →`;
    card.append(cardTitle, description, action);
    card.addEventListener('click', () => startNewSession(machine, item.mode));
    modeGrid.appendChild(card);
  }
  modesSection.append(modesTitle, modeGrid);

  workspace.append(header, stats, recentSection, modesSection);
  mount.appendChild(workspace);
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
}

async function startNewSession(machine: MachineConfig, initialMode?: SessionMode) {
  const picked = await openDirPicker(machine, initialMode);
  if (!picked) return;
  openSession(machine, '', picked.workdir, picked.flags, picked.mode);
}

function showMachineOverview(machine: MachineConfig) {
  overviewMachineKey = machineKey(machine);
  for (const view of views.values()) view.container.style.display = 'none';
  const mount = document.getElementById('machine-overview');
  if (mount) {
    mount.hidden = false;
    renderMachineOverview(machine);
  }
  updateStatusBar();
}

function makeTerminal(): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    theme: {
      background: '#F5F4EF', foreground: '#2B2A28', cursor: '#C9645A',
      selectionBackground: '#DCD6C9',
      black: '#3B3A37', red: '#C0564B', green: '#5E8C58', yellow: '#B07D2E',
      blue: '#4A72B0', magenta: '#9A5BA0', cyan: '#3E8C8C', white: '#6B6862',
      brightBlack: '#9B978E', brightRed: '#C0564B', brightGreen: '#5E8C58',
      brightYellow: '#B07D2E', brightBlue: '#4A72B0', brightMagenta: '#9A5BA0',
      brightCyan: '#3E8C8C', brightWhite: '#2B2A28',
    },
    cursorBlink: true, scrollback: 10000, allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { term, fit };
}

// openSession creates a new SessionView (its own WS + xterm) and attaches.
// sessionId '' means create a brand-new session with the given workdir.
function openSession(machine: MachineConfig, sessionId: string, workdir?: string, flags?: string[], mode: SessionMode = 'normal'): SessionView {
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

  const client = new VibeRemoteClient(machine);
  const banner = document.createElement('div');
  banner.className = 'reconnect-banner';
  banner.style.display = 'none';
  const view: SessionView = { key, machine, sessionId, client, terminal: term, fitAddon: fit, container, banner, activity: 'none', suppressUntil: 0 };
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
  client.onData = (payload: string) => {
    term.write(base64ToBytes(payload));
    // Mark background activity as a dot — but not during the post-attach
    // suppression window (tmux full repaint would false-trigger it), and not
    // for the session the user is actively viewing.
    if (view.key !== activeKey && Date.now() >= view.suppressUntil) {
      if (view.activity === 'none') {
        view.activity = 'output';
        renderSidebar();
      }
    }
  };

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
    // Suppress activity marking briefly so the tmux full repaint on (re)attach
    // doesn't false-light the dot. 500ms is an empirical, tunable value.
    view.suppressUntil = Date.now() + 500;
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
  client.onNotify = (kind, message) => {
    // hook 事件把圆点从「有输出」升级为语义状态。活动会话不标记（用户在看）。
    if (kind === 'idle' || kind === 'waiting') {
      if (view.key !== activeKey) {
        view.activity = kind;
        renderSidebar();
      }
      // waiting = 需要用户介入，可选弹桌面通知（移动端伏笔）。
      if (kind === 'waiting' && notificationsEnabled()) {
        const title = view.terminal ? (views.get(view.key)?.sessionId || 'vibe-remote') : 'vibe-remote';
        notifyDesktop(`${machine.name} · ${title}`, message || 'Claude 需要你的确认');
      }
    }
  };

  client.connect();
  const dims = fit.proposeDimensions();
  client.attach(sessionId, dims?.cols || 80, dims?.rows || 24, workdir, flags, sessionId ? undefined : mode);

  setActive(view.key);
  return view;
}

// setActive shows one session view and hides the rest, then fits + focuses it.
function setActive(key: string) {
  activeKey = key;
  overviewMachineKey = null;
  document.getElementById('machine-overview')?.setAttribute('hidden', '');
  const activeView = views.get(key);
  if (activeView && activeView.activity !== 'none') {
    activeView.activity = 'none';
  }
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
  // Skip rebuilds while an inline rename is in progress (see renamingActive).
  if (renamingActive) return;
  const container = document.getElementById('machine-list')!;
  container.textContent = '';

  for (const machine of machines) {
    const group = document.createElement('div');
    group.className = 'machine-group';

    const nameRow = document.createElement('div');
    const mKey = machineKey(machine);
    nameRow.className = 'machine-name' + (mKey === selectedMachineKey ? ' selected' : '');
    const dot = document.createElement('span');
    dot.className = 'machine-status' + (machineOnline.get(mKey) ? ' connected' : ' error');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = machine.name;
    nameRow.append(dot, nameSpan);
    // Click selects this machine as the new-session target (does NOT open a
    // session — that's what clicking a session item does). Re-render to move
    // the selected highlight.
    nameRow.addEventListener('click', () => {
      selectedMachineKey = mKey;
      showMachineOverview(machine);
      renderSidebar();
    });

    const list = document.createElement('div');
    list.className = 'session-list';

    const sessions = machineSessions.get(machineKey(machine)) || [];
    for (const s of sessions) {
      const key = viewKey(machine, s.id);
      const item = document.createElement('div');
      item.className = 'session-item' + (key === activeKey ? ' active' : '');

      const label = document.createElement('span');
      label.className = 'session-label';
      label.textContent = s.title || (s.workdir ? s.workdir.split('/').pop() : '') || s.id;
      label.title = s.workdir || s.id;
      // Click vs dblclick: dblclick=rename. A dblclick fires as click→click→
      // dblclick, so a naive click handler would open (and WS-connect) an
      // unopened session before the rename even starts. Only unopened sessions
      // pay a short delay so an incoming dblclick can cancel the open; already-
      // open sessions switch instantly (openSession is an idempotent setActive,
      // no side effects), keeping the primary interaction zero-latency.
      let openTimer: number | undefined;
      label.addEventListener('click', () => {
        if (views.has(key)) {
          openSession(machine, s.id); // already open: instant, no delay
        } else {
          window.clearTimeout(openTimer);
          openTimer = window.setTimeout(() => openSession(machine, s.id), 220);
        }
      });
      label.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        window.clearTimeout(openTimer); // cancel any pending open for this label
        startInlineRename(machine, s, label);
      });

      const dot = document.createElement('span');
      dot.className = 'session-unread';
      const openView = views.get(key);
      const act = openView?.activity ?? 'none';
      if (act === 'none' || key === activeKey) {
        dot.classList.add('hidden');
      } else {
        dot.classList.add(act); // 'output' | 'idle' | 'waiting'
      }

      const close = document.createElement('span');
      close.className = 'session-close';
      close.textContent = '×';
      close.title = 'Delete session (kills remote claude — cannot be undone)';
      // Deleting truly kills the remote tmux + claude; the current screen is
      // lost and unrecoverable. Confirm first (mirrors machine-delete in
      // machines.ts), showing the session's display name so a mis-hover on the
      // wrong row is caught before the DELETE fires.
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = s.title || (s.workdir ? s.workdir.split('/').pop() : '') || s.id;
        if (!window.confirm(`Delete session "${name}"? The remote claude process will be killed and its current screen lost. This cannot be undone.`)) {
          return;
        }
        closeSession(machine, s.id);
      });

      item.append(label, dot, close);
      list.appendChild(item);
    }

    group.append(nameRow, list);
    container.appendChild(group);
  }
}

// startInlineRename replaces a session label with an input for in-place rename.
// Enter/blur commits, Esc cancels. Empty input clears the custom name (server
// falls back to the default title). After commit we refresh from the server so
// the authoritative title is shown (keeps multi-client views consistent).
function startInlineRename(machine: MachineConfig, s: SessionInfo, label: HTMLElement) {
  const input = document.createElement('input');
  input.className = 'session-rename-input';
  input.value = s.title || '';
  label.replaceWith(input);
  renamingActive = true; // pause sidebar rebuilds while editing (see flag docs)
  input.focus();
  input.select();

  let done = false;
  const commit = async () => {
    if (done) return;
    // If the input is no longer in the document, this blur came from the DOM
    // being torn down (not a deliberate user focus change) — treat as cancel,
    // never commit half-typed text. (Belt-and-suspenders with renamingActive.)
    if (!document.body.contains(input)) { done = true; renamingActive = false; return; }
    done = true;
    const name = input.value.trim();
    // Clear before refresh so the subsequent renderSidebar() actually rebuilds.
    renamingActive = false;
    try {
      await rests.get(machineKey(machine))!.renameSession(s.id, name);
    } catch (e) {
      console.error('rename failed', e);
    }
    refreshAllMachines();
  };
  const cancel = () => {
    if (done) return;
    done = true;
    renamingActive = false; // clear before renderSidebar so it rebuilds
    renderSidebar();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', commit);
}

function updateStatusBar(extra?: string, attempt?: number) {
  const connEl = document.getElementById('status-connection')!;
  const sessionEl = document.getElementById('status-session')!;
  const tbTitle = document.getElementById('toolbar-title')!;
  const tbStatus = document.getElementById('toolbar-status')!;
  const tbStatusText = document.getElementById('toolbar-status-text')!;
  const view = activeKey ? views.get(activeKey) : null;
  const overviewMachine = overviewMachineKey
    ? machines.find((m) => machineKey(m) === overviewMachineKey)
    : null;

  connEl.className = '';
  tbStatus.className = '';

  if (overviewMachine) {
    const online = machineOnline.get(overviewMachineKey!) === true;
    tbTitle.textContent = overviewMachine.name;
    connEl.className = online ? 'connected' : 'error';
    connEl.textContent = online ? `Connected · ${overviewMachine.name}` : `Offline · ${overviewMachine.name}`;
    tbStatus.className = online ? 'connected' : 'error';
    tbStatusText.textContent = online ? 'Connected' : 'Offline';
    sessionEl.textContent = extra || '';
    return;
  }

  if (view) {
    // Toolbar title: machine name · short session code (SessionView holds no
    // display name; short code is enough to locate the active session).
    const shortId = view.sessionId ? view.sessionId.slice(-6) : 'new';
    tbTitle.textContent = `${view.machine.name} · ${shortId}`;

    const st = view.client.state;
    if (st === ConnectionState.Connected) {
      connEl.className = 'connected';
      connEl.textContent = `Connected · ${view.machine.name}`;
      tbStatus.className = 'connected';
      tbStatusText.textContent = 'Connected';
    } else if (st === ConnectionState.Reconnecting) {
      connEl.className = 'reconnecting';
      const n = attempt ?? 0;
      connEl.textContent = n > 0 ? `Reconnecting… (attempt ${n})` : 'Reconnecting…';
      tbStatus.className = 'reconnecting';
      tbStatusText.textContent = n > 0 ? `Reconnecting… (${n})` : 'Reconnecting…';
    } else {
      connEl.textContent = 'Disconnected';
      tbStatus.className = 'error';
      tbStatusText.textContent = 'Disconnected';
    }
  } else {
    tbTitle.textContent = 'vibe-remote';
    const anyOnline = [...machineOnline.values()].some(Boolean);
    connEl.className = anyOnline ? 'connected' : '';
    connEl.textContent = anyOnline ? 'Ready' : 'No connection';
    tbStatus.className = anyOnline ? 'connected' : '';
    tbStatusText.textContent = anyOnline ? 'Ready' : 'No connection';
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
  const overview = document.getElementById('machine-overview');
  for (const child of [...container.children]) {
    if (child !== overview) child.remove();
  }
  if (overview) {
    overview.hidden = true;
    overview.textContent = '';
  }
  const box = document.createElement('div');
  box.className = 'empty-state';
  const h = document.createElement('p');
  h.textContent = 'Add your first machine';
  h.style.fontSize = '16px';
  h.style.color = 'var(--text-secondary)';
  const p = document.createElement('p');
  p.style.fontSize = '12px';
  p.textContent = 'The machine must be on the same tailnet and running vibe-remoted.';
  const btn = document.createElement('button');
  btn.className = 'btn-primary';
  btn.style.width = 'auto';
  btn.style.marginTop = '8px';
  btn.textContent = 'Add machine';
  btn.addEventListener('click', () => document.getElementById('btn-manage-machines')?.dispatchEvent(new MouseEvent('click')));
  const hint = document.createElement('p');
  hint.style.fontSize = '11px';
  hint.textContent = 'Address: tailscale IP (100.x) or MagicDNS name · Token: matches vibe-remoted config';
  box.append(h, p, btn, hint);
  container.appendChild(box);
}

// --- New session button ---

function wireNewSessionButton() {
  document.getElementById('btn-new-session')?.addEventListener('click', async () => {
    if (machines.length === 0) return;
    // Target machine priority: active session's machine → sidebar-selected
    // machine → first machine. Active wins so "new session" inside a session
    // stays on the same machine; selection covers the no-active-session case.
    const active = activeKey ? views.get(activeKey) : null;
    const selected = selectedMachineKey
      ? machines.find((m) => machineKey(m) === selectedMachineKey)
      : null;
    const machine = active?.machine || selected || machines[0];
    startNewSession(machine);
  });
}

// --- Desktop notifications (optional, for `waiting` events) ---
// A simple localStorage flag gates whether we attempt OS notifications. The OS
// permission itself is separate: a denied permission silently degrades to just
// the sidebar dot. The machine-manager settings can flip this flag.
function notificationsEnabled(): boolean {
  return localStorage.getItem('vibe-remote.notifications') !== 'off';
}

function notifyDesktop(title: string, body: string) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    new Notification(title, { body });
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((perm) => {
      if (perm === 'granted') new Notification(title, { body });
    });
  }
}

// --- Boot ---
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}




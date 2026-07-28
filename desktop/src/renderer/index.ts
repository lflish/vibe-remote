import type { MachineConfig } from '../shared/protocol';
import { VibeRemoteClient, ConnectionState } from './client';
import { VibeRemoteRest } from './rest';
import { openDirPicker } from './dirpicker';
import { openMachineManager } from './machines';
import { mountChat, type ChatMount } from '@vibe-remote/ui';
import '@vibe-remote/ui/styles.css';

// Declared by preload. `getWorkdirs`/`addWorkdir` persist the workdir list
// per machine to Electron userData (`workdirs.json`) — desktop's equivalent
// of the web's localStorage store. Workdir *is* the session identity here
// (headless 唯一线：会话=workdir); we no longer list tmux sessions from the
// server.
declare global {
  interface Window {
    vibeRemote: {
      getMachines(): Promise<MachineConfig[]>;
      saveMachines(machines: MachineConfig[]): Promise<boolean>;
      getWorkdirs(machineKey: string): Promise<string[]>;
      addWorkdir(machineKey: string, dir: string): Promise<void>;
    };
  }
}

// A SessionView is one open workdir on one machine: its own WebSocket
// (VibeRemoteClient) and its own chat view (core ChatSession + ui ChatView,
// mounted via ChatMount). Multiple views can coexist; switching = showing
// one container and hiding the rest.
interface SessionView {
  key: string; // `${machineKey}::${workdir}`
  machine: MachineConfig;
  workdir: string;
  client: VibeRemoteClient;
  chat: ChatMount;
  container: HTMLElement;
  banner: HTMLElement; // reconnect banner overlay, hidden by default
  activity: 'none' | 'output'; // sidebar dot: has-unread-output
}

// --- App state ---
// Machine-keyed maps use `addr:port` (machineKey) rather than addr alone, so
// two vibe-remoted instances on the same host but different ports don't collide.
let machines: MachineConfig[] = [];
const rests = new Map<string, VibeRemoteRest>(); // machineKey -> REST client
const views = new Map<string, SessionView>(); // view key -> open session view
const machineOnline = new Map<string, boolean>(); // machineKey -> reachable
const machineWorkdirs = new Map<string, string[]>(); // machineKey -> workdirs
let activeKey: string | null = null;
// The machine a new session targets when there is no active session to inherit
// from. Set by clicking a machine header in the sidebar.
let selectedMachineKey: string | null = null;

const machineKey = (m: MachineConfig) => `${m.addr}:${m.port}`;
const viewKey = (m: MachineConfig, workdir: string) => `${machineKey(m)}::${workdir}`;

// --- Init ---

async function init() {
  machines = await window.vibeRemote.getMachines();
  wireManageMachinesButton();
  wireNewSessionButton();
  if (machines.length === 0) {
    renderEmptyState();
    return;
  }
  selectedMachineKey = machineKey(machines[0]);
  rebuildRests();
  await refreshAllMachines();
  startPolling();
}

// startPolling starts the 5s sidebar refresh loop (probes each machine's
// reachability + reloads its workdir list from userData). Idempotent.
let pollingStarted = false;
function startPolling() {
  if (pollingStarted) return;
  pollingStarted = true;
  setInterval(refreshAllMachines, 5000);
}

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
        if (selectedMachineKey && !machines.some((m) => machineKey(m) === selectedMachineKey)) {
          selectedMachineKey = machines.length > 0 ? machineKey(machines[0]) : null;
        }
        rebuildRests();
        let activeRemoved = false;
        for (const rk of removedKeys) {
          for (const [k, v] of [...views]) {
            if (machineKey(v.machine) === rk) {
              v.client.disconnect();
              v.chat.dispose();
              v.container.remove();
              views.delete(k);
              if (activeKey === k) { activeKey = null; activeRemoved = true; }
            }
          }
        }
        if (activeRemoved) {
          const next = views.keys().next();
          if (!next.done) setActive(next.value);
        }
        if (machines.length === 0) {
          renderEmptyState();
        } else {
          document.querySelector('#terminal-container .empty-state')?.remove();
          refreshAllMachines();
          startPolling();
        }
      },
    });
  });
}

// refreshAllMachines probes each machine (via /info) for reachability and
// reloads its workdir list from Electron userData. Sidebar content = workdir
// list, so no server-side session listing is needed anymore.
async function refreshAllMachines() {
  await Promise.all(
    machines.map(async (m) => {
      const mk = machineKey(m);
      try {
        await rests.get(mk)!.info();
        machineOnline.set(mk, true);
      } catch {
        machineOnline.set(mk, false);
      }
      const dirs = await window.vibeRemote.getWorkdirs(mk);
      machineWorkdirs.set(mk, dirs);
    }),
  );
  renderSidebar();
  updateStatusBar();
}

// --- Session views ---

// openSession opens (or focuses) a SessionView keyed by (machine, workdir).
// One WebSocket + one chat mount per workdir; further clicks on the same
// workdir just switch to the existing view.
function openSession(machine: MachineConfig, workdir: string, flags?: string[]): SessionView {
  const key = viewKey(machine, workdir);
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

  const client = new VibeRemoteClient(machine);

  const chatHost = document.createElement('div');
  chatHost.className = 'chat-host';
  container.appendChild(chatHost);
  const chat = mountChat(chatHost, {
    onSend: (payload: string) => client.sendData(payload),
  });

  const banner = document.createElement('div');
  banner.className = 'reconnect-banner';
  banner.style.display = 'none';
  const view: SessionView = { key, machine, workdir, client, chat, container, banner, activity: 'none' };
  views.set(key, view);

  const bannerText = document.createElement('span');
  bannerText.textContent = 'Connection lost, reconnecting…';
  const retryBtn = document.createElement('button');
  retryBtn.textContent = 'Retry now';
  retryBtn.addEventListener('click', () => view.client.reconnectNow());
  banner.append(bannerText, retryBtn);
  container.appendChild(banner);

  // Best-effort history backfill from the jsonl-backed REST endpoint. Runs in
  // parallel with the WS connect; if it fails we just show a live-only chat.
  rests.get(machineKey(machine))!
    .history(workdir, 50)
    .then((turns) => {
      const msgs = turns.map((t) =>
        t.role === 'assistant'
          ? { role: 'assistant' as const, parts: [{ type: 'text' as const, text: t.text }], streaming: false }
          : { role: 'user' as const, parts: [{ type: 'text' as const, text: t.text }] },
      );
      if (msgs.length) chat.setHistory(msgs);
    })
    .catch(() => { /* history best-effort */ });

  // Server NDJSON (headless stream-json) → structured chat. `feed` handles
  // base64 → text → line splitting → session state.
  client.onData = (payload: string) => {
    chat.feed(payload);
    if (view.key !== activeKey && view.activity === 'none') {
      view.activity = 'output';
      renderSidebar();
    }
  };

  client.onReady = (_readyWorkdir: string) => {
    // Session identity is the requested workdir; the server's ready frame just
    // confirms attach succeeded. No re-key.
    view.banner.style.display = 'none';
    updateStatusBar();
  };

  client.onStateChange = (state, attempt) => {
    if (state === ConnectionState.Reconnecting) {
      view.banner.style.display = 'flex';
    } else if (state === ConnectionState.Connected) {
      view.banner.style.display = 'none';
    }
    if (view.key === activeKey) updateStatusBar(undefined, attempt);
  };
  client.onExit = (code) => {
    updateStatusBar(`Session exited (code ${code})`);
  };
  client.onError = (msg) => {
    console.error(`[${machine.name}]`, msg);
    if (view.key === activeKey) updateStatusBar(`Error: ${msg}`);
  };

  client.connect();
  client.attach(workdir, flags);

  setActive(view.key);
  return view;
}

function setActive(key: string) {
  activeKey = key;
  const activeView = views.get(key);
  if (activeView && activeView.activity !== 'none') {
    activeView.activity = 'none';
  }
  for (const [k, v] of views) {
    v.container.style.display = k === key ? 'block' : 'none';
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
    const mKey = machineKey(machine);
    nameRow.className = 'machine-name' + (mKey === selectedMachineKey ? ' selected' : '');
    const statusDot = document.createElement('span');
    statusDot.className = 'machine-status' + (machineOnline.get(mKey) ? ' connected' : ' error');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = machine.name;
    nameRow.append(statusDot, nameSpan);
    nameRow.addEventListener('click', () => {
      selectedMachineKey = mKey;
      renderSidebar();
    });

    const list = document.createElement('div');
    list.className = 'session-list';

    const dirs = machineWorkdirs.get(mKey) || [];
    for (const dir of dirs) {
      const key = viewKey(machine, dir);
      const item = document.createElement('div');
      item.className = 'session-item' + (key === activeKey ? ' active' : '');

      const label = document.createElement('span');
      label.className = 'session-label';
      // Show trailing path segment (matches how tmux session titles used to
      // read); full path in title tooltip.
      const short = dir.split('/').filter(Boolean).pop() || dir;
      label.textContent = short;
      label.title = dir;
      label.addEventListener('click', () => openSession(machine, dir));

      const dot = document.createElement('span');
      dot.className = 'session-unread';
      const openView = views.get(key);
      const act = openView?.activity ?? 'none';
      if (act === 'none' || key === activeKey) {
        dot.classList.add('hidden');
      } else {
        dot.classList.add(act);
      }

      item.append(label, dot);
      list.appendChild(item);
    }

    group.append(nameRow, list);
    container.appendChild(group);
  }
}

function updateStatusBar(extra?: string, attempt?: number) {
  const connEl = document.getElementById('status-connection')!;
  const sessionEl = document.getElementById('status-session')!;
  const tbTitle = document.getElementById('toolbar-title')!;
  const tbStatus = document.getElementById('toolbar-status')!;
  const tbStatusText = document.getElementById('toolbar-status-text')!;
  const view = activeKey ? views.get(activeKey) : null;

  connEl.className = '';
  tbStatus.className = '';

  if (view) {
    const short = view.workdir.split('/').filter(Boolean).pop() || view.workdir;
    tbTitle.textContent = `${view.machine.name} · ${short}`;

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
  sessionEl.textContent = extra || (view ? `Workdir: ${view.workdir}` : '');
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

// The "+ New Session" footer button picks a directory on the target machine
// (openDirPicker returns the chosen path + selected launch flags), records
// the workdir into userData so it shows up in the sidebar, then opens it.
function wireNewSessionButton() {
  document.getElementById('btn-new-session')?.addEventListener('click', async () => {
    if (machines.length === 0) return;
    const active = activeKey ? views.get(activeKey) : null;
    const selected = selectedMachineKey
      ? machines.find((m) => machineKey(m) === selectedMachineKey)
      : null;
    const machine = active?.machine || selected || machines[0];
    const picked = await openDirPicker(machine);
    if (picked === null) return;
    await window.vibeRemote.addWorkdir(machineKey(machine), picked.workdir);
    machineWorkdirs.set(machineKey(machine), await window.vibeRemote.getWorkdirs(machineKey(machine)));
    openSession(machine, picked.workdir, picked.flags);
  });
}

// --- Boot ---
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

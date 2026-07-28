import type { MachineConfig, SessionInfo } from '../shared/protocol';
import { VibeRemoteClient, ConnectionState } from './client';
import { VibeRemoteRest } from './rest';
import { openDirPicker } from './dirpicker';
import { openMachineManager } from './machines';
import { mountChat, type ChatMount } from '@vibe-remote/ui';
import '@vibe-remote/ui/styles.css';

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
// own chat view (core ChatSession + ui ChatView, mounted via ChatMount).
// 阶段 1b：内容区从 xterm 换成结构化聊天 UI，走 headless 线。多会话同时打开，
// 切换只显隐各自容器；tmux/headless 会话在服务端各自保活。
interface SessionView {
  key: string; // `${machineAddr}::${sessionId}`
  machine: MachineConfig;
  sessionId: string; // '' until the server assigns one for a new session
  client: VibeRemoteClient;
  chat: ChatMount; // core ChatSession + ui ChatView 挂载
  container: HTMLElement;
  banner: HTMLElement; // reconnect banner overlay, hidden by default
  activity: 'none' | 'output' | 'idle' | 'waiting'; // sidebar dot state
}

// --- App state ---
// Machine-keyed maps use `addr:port` (machineKey) rather than addr alone, so
// two vibe-remoted instances on the same host but different ports don't collide.
let machines: MachineConfig[] = [];
const rests = new Map<string, VibeRemoteRest>(); // machineKey -> REST client
const views = new Map<string, SessionView>(); // view key -> open session view
const machineSessions = new Map<string, SessionInfo[]>(); // machineKey -> sessions (REST)
const machineOnline = new Map<string, boolean>(); // machineKey -> reachable
let activeKey: string | null = null;
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

const machineKey = (m: MachineConfig) => `${m.addr}:${m.port}`;
const viewKey = (m: MachineConfig, sid: string) => `${machineKey(m)}::${sid}`;

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
        // Drop a selection that points at a now-removed machine so the
        // highlight (and new-session target) never dangles.
        if (selectedMachineKey && !machines.some((m) => machineKey(m) === selectedMachineKey)) {
          selectedMachineKey = machines.length > 0 ? machineKey(machines[0]) : null;
        }
        rebuildRests();
        // Close views belonging to removed machines (does NOT kill remote sessions).
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

// 阶段 1b：headless 聊天 UI 用 CSS 布局自适应窗口，无需 xterm 的 fit/resize。
// 保留空函数占位以免调用处报错；后续可彻底删除调用点。
function wireWindowResize() {
  /* no-op：结构化聊天视图靠 CSS flex 自适应，不再需要按窗口 resize 重算 PTY 尺寸 */
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

// openSession creates a new SessionView (its own WS + chat view) and attaches (headless).
// sessionId '' means create a brand-new session with the given workdir.
function openSession(machine: MachineConfig, sessionId: string, workdir?: string, flags?: string[]): SessionView {
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

  const client = new VibeRemoteClient(machine);

  // 聊天内容区：用户发消息 → 编码为 data 帧发出（headless 线里 data 帧承载 prompt 文本）。
  const chatHost = document.createElement('div');
  chatHost.className = 'chat-host';
  container.appendChild(chatHost);
  const chat = mountChat(chatHost, {
    onSend: (payload: string) => client.sendData(payload),
    // onStop：interrupt 帧待阶段 0b（headless 双向化）落地后接入。
  });

  const banner = document.createElement('div');
  banner.className = 'reconnect-banner';
  banner.style.display = 'none';
  const view: SessionView = { key, machine, sessionId, client, chat, container, banner, activity: 'none' };
  views.set(key, view);

  const bannerText = document.createElement('span');
  bannerText.textContent = 'Connection lost, reconnecting…';
  const retryBtn = document.createElement('button');
  retryBtn.textContent = 'Retry now';
  retryBtn.addEventListener('click', () => view.client.reconnectNow());
  banner.append(bannerText, retryBtn);
  container.appendChild(banner);

  // Server NDJSON (headless stream-json) → 结构化 chat。data 帧 payload 是 base64 的
  // NDJSON 文本；ChatMount.feed 内部做行缓冲 + 解析 + 状态累积。
  client.onData = (payload: string) => {
    chat.feed(payload);
    // 后台会话有输出即点亮圆点（活动会话不标记，用户在看）。
    if (view.key !== activeKey && view.activity === 'none') {
      view.activity = 'output';
      renderSidebar();
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
    updateStatusBar(`Session exited (code ${code})`);
    refreshAllMachines();
  };
  client.onError = (msg) => {
    console.error(`[${machine.name}]`, msg);
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
        const title = views.get(view.key)?.sessionId || 'vibe-remote';
        notifyDesktop(`${machine.name} · ${title}`, message || 'Claude 需要你的确认');
      }
    }
  };

  client.connect();
  // 走 headless 结构化线（cols/rows 对 headless 无意义，传占位值）。
  client.attach(sessionId, 80, 24, workdir, flags, 'headless');

  setActive(view.key);
  return view;
}

// setActive shows one session view and hides the rest, then fits + focuses it.
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
      close.title = 'Close session (kills remote claude)';
      close.addEventListener('click', (e) => { e.stopPropagation(); closeSession(machine, s.id); });

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

  connEl.className = '';
  tbStatus.className = '';

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
    view.chat.dispose();
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
    const picked = await openDirPicker(machine);
    if (picked === null) return; // cancelled
    openSession(machine, '', picked.workdir, picked.flags);
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




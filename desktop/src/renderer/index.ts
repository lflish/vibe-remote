import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { MachineConfig, SessionInfo, SessionMode } from '../shared/protocol';
import { PROTOCOL_VERSION } from '../shared/protocol';
import { VibeRemoteClient, ConnectionState, type AttachOptions } from './client';
import { VibeRemoteRest, DeleteSessionError, ReloadSessionError } from './rest';
import { openDirPicker } from './dirpicker';
import { openMachineManager } from './machines';
import { t, toggleLocale, getLocale, onLocaleChange } from './i18n';
import { fitWhenVisible, dimensionsWhenVisible } from './terminal-layout';
import { attachMacClipboardShortcuts } from './terminal-clipboard';
import { ChatView } from './chat/view';
import { nextDot, type ActivityEvent, type Dot, type RestSnapshot } from './chat/activity';
import type { Prompt } from './chat/types';

// Declared by preload

// A SessionView is one open session: its own WebSocket (VibeRemoteClient) and its
// own xterm instance. Multiple sessions stay open simultaneously; switching
// just shows/hides their terminal containers. tmux keeps unfocused sessions
// alive server-side regardless.
interface SessionView {
  ui: 'terminal';
  key: string; // `${machineAddr}::${sessionId}`
  machine: MachineConfig;
  sessionId: string; // '' until the server assigns one for a new session
  client: VibeRemoteClient;
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLElement;
  banner: HTMLElement; // reconnect banner overlay, hidden by default
  activity: Dot; // sidebar dot state
  suppressUntil: number; // ms timestamp: ignore onData activity until then (attach repaint)
  warnedProto: boolean; // already told the user this daemon is older than the client
}

// An open view is a terminal session (xterm) or a chat session (ChatView,
// design 1.6). Both have key/machine/sessionId/client/container/activity.
type AnyView = SessionView | ChatView;

// disposeView closes a view locally (the remote session keeps running).
function disposeView(v: AnyView) {
  if (v.ui === 'chat') {
    v.dispose();
    return;
  }
  v.client.disconnect();
  v.terminal.dispose();
  v.container.remove();
}

// --- App state ---
// Machine-keyed maps use `addr:port` (machineKey) rather than addr alone, so
// two vibe-remoted instances on the same host but different ports don't collide.
let machines: MachineConfig[] = [];
const rests = new Map<string, VibeRemoteRest>(); // machineKey -> REST client
const views = new Map<string, AnyView>(); // view key -> open session view
const machineSessions = new Map<string, SessionInfo[]>(); // machineKey -> sessions (REST)
const machineOnline = new Map<string, boolean>(); // machineKey -> reachable
type MachineIssue = 'auth' | 'version' | 'unreachable';
const machineIssues = new Map<string, MachineIssue>();
const machineFailures = new Map<string, number>();
const machineRetryAt = new Map<string, number>();
const COLLAPSED_MACHINES_KEY = 'vibe-remote.collapsed-machines';
const collapsedMachines = loadCollapsedMachines();
let activeKey: string | null = null;
let overviewMachineKey: string | null = null;
// While an inline rename input is open we suppress full sidebar rebuilds:
// the 5s poll (and onReady/onExit) call renderSidebar(), which wipes and
// recreates the whole sidebar DOM — that would delete the focused input and
// its blur would silently commit half-typed text. Paused during editing.
let renamingActive = false;
// Sessions with a Reload in flight, keyed by viewKey(machine, sessionId).
// Session-level rather than per-button because the sidebar is rebuilt from
// several paths (5s poll, onReady/onExit, locale switch, and Reload's own
// refresh) — a fresh button would come back enabled and let the user fire a
// second respawn-pane at the same pane while the first is still running.
const reloadingSessions = new Set<string>();
// Chat sessions not open here get their sidebar dot from the 5s REST poll
// (activitySeq / epoch / state, R16.4). Keyed by viewKey; open views keep
// their own `activity` from live frames instead.
const sessionDots = new Map<string, Dot>();
const restSnapshots = new Map<string, RestSnapshot>();
// Every refresh captures a generation. A newer refresh or machine-list edit
// invalidates older in-flight requests without serializing the 5s poll.
let machineRefreshGeneration = 0;
let statusMessageTimer: ReturnType<typeof setTimeout> | null = null;

const machineKey = (m: MachineConfig) => `${m.addr}:${m.port}`;
const viewKey = (m: MachineConfig, sid: string) => `${machineKey(m)}::${sid}`;

function rendererIcon(name: 'machine' | 'terminal' | 'chat' | 'branch' | 'chevron' | 'reload' | 'close'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const paths = {
    machine: 'M4 3.5h12a1.5 1.5 0 0 1 1.5 1.5v10A1.5 1.5 0 0 1 16 16.5H4A1.5 1.5 0 0 1 2.5 15V5A1.5 1.5 0 0 1 4 3.5Zm-1.5 6h15M5.5 6.5h.01m2.49 0h.01m-2.51 6h.01m2.49 0h.01',
    terminal: 'M4.5 5.5 8 9l-3.5 3.5M10 13h5.5',
    chat: 'M4 4.5h12A1.5 1.5 0 0 1 17.5 6v6.5A1.5 1.5 0 0 1 16 14h-6l-3.5 2.5V14H4a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 4 4.5Z',
    branch: 'M6 3.5v9.25A3.75 3.75 0 0 0 9.75 16.5H14M6 6.5h5A3 3 0 0 0 14 3.5v0M4 3.5h4m4 0h4m-4 13h4',
    chevron: 'm7 5 5 5-5 5',
    reload: 'M15.5 6.4A6.5 6.5 0 1 0 16.2 12M15.5 6.4V2.8m0 3.6h-3.6',
    close: 'M5.5 5.5l9 9m0-9-9 9',
  };
  path.setAttribute('d', paths[name]);
  svg.appendChild(path);
  return svg;
}

function loadCollapsedMachines(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(COLLAPSED_MACHINES_KEY) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function persistCollapsedMachines() {
  localStorage.setItem(COLLAPSED_MACHINES_KEY, JSON.stringify([...collapsedMachines]));
}

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
  // Set lang first so the init-error screen is announced in the right language too.
  document.documentElement.lang = getLocale() === 'zh' ? 'zh-CN' : 'en';
  machines = await window.vibeRemote.getMachines();
  wireLanguageToggle();
  wireManageMachinesButton();
  wireWindowResize();
  wireTerminalResizeObserver();
  if (machines.length === 0) {
    renderEmptyState();
    return;
  }
  rebuildRests();
  await refreshAllMachines();
  showMachineOverview(machines[0]);
  startPolling();
}

// A click on a chat notification opens that session (R16.3). The tag is the
// session's view key. Wired once at load; unsigned builds never deliver
// clicks (Dock fallback, d12), and nothing ever switches sessions on its own.
window.vibeRemote?.onNotificationClick?.((tag) => {
  const open = views.get(tag);
  const r = nextDot(open?.activity ?? sessionDots.get(tag) ?? 'none', { kind: 'notificationClick' }, { isActive: tag === activeKey, windowFocused: true });
  if (!r.open) return;
  if (open) {
    setActive(tag);
    return;
  }
  for (const machine of machines) {
    const session = machineSessions.get(machineKey(machine))?.find((s) => viewKey(machine, s.id) === tag);
    if (session) {
      openExisting(machine, session);
      return;
    }
  }
});

// wireLanguageToggle wires the sidebar language button and re-renders all
// dynamically-built UI when the locale switches. Static HTML labels are read
// through t() at render time, so re-running the render functions is enough —
// no page reload, and open terminals (their own xterm instances) are untouched.
function wireLanguageToggle() {
  const btn = document.getElementById('btn-lang');
  const sync = () => {
    if (btn) {
      btn.textContent = t('lang.toggle');
      btn.title = t('lang.toggleTitle');
      btn.setAttribute('aria-label', t('lang.toggleTitle'));
    }
    const manage = document.getElementById('btn-manage-machines');
    if (manage) {
      manage.title = t('machines.title');
      manage.setAttribute('aria-label', t('machines.title'));
    }
  };
  sync();
  btn?.addEventListener('click', () => toggleLocale());
  onLocaleChange(() => {
    sync();
    renderSidebar();
    if (overviewMachineKey) {
      const machine = machines.find((m) => machineKey(m) === overviewMachineKey);
      if (machine) renderMachineOverview(machine);
    }
    // The empty state is built once when there are no machines/sessions, so it
    // needs an explicit rebuild (renderEmptyState is idempotent).
    if (document.querySelector('.empty-state')) renderEmptyState();
    // Reconnect banners live inside each open session's container and are
    // usually hidden, so they'd otherwise keep their creation-time language
    // until the next disconnect.
    for (const view of views.values()) {
      if (view.ui === 'chat') {
        view.relabel();
        continue;
      }
      const text = view.banner.querySelector('.reconnect-banner-text');
      if (text) text.textContent = t('banner.reconnecting');
      const retry = view.banner.querySelector('.reconnect-banner-retry');
      if (retry) retry.textContent = t('banner.retry');
    }
    updateStatusBar();
  });
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
          machineOnline.delete(rk);
          machineIssues.delete(rk);
          machineFailures.delete(rk);
          machineRetryAt.delete(rk);
          collapsedMachines.delete(rk);
          // Reload markers are keyed "<machineKey>::<sessionId>"; drop the
          // machine's entries so they can't outlive it.
          for (const marker of [...reloadingSessions]) {
            if (marker.startsWith(`${rk}::`)) reloadingSessions.delete(marker);
          }
        }
        if (removedKeys.length > 0) persistCollapsedMachines();
        if (overviewMachineKey && !machines.some((m) => machineKey(m) === overviewMachineKey)) {
          overviewMachineKey = null;
        }
        rebuildRests();
        // Close views belonging to removed machines (does NOT kill remote sessions).
        let activeRemoved = false;
        for (const rk of removedKeys) {
          for (const [k, v] of [...views]) {
            if (machineKey(v.machine) === rk) {
              disposeView(v);
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
      if (view?.ui === 'terminal') view.fitAddon.fit(); // fit() triggers term.onResize → sendResize
    }, 80);
  });
}

// wireTerminalResizeObserver re-fits the active terminal whenever the terminal
// container's box actually changes size. A single requestAnimationFrame in
// setActive can fire before layout has settled, leaving xterm measured against
// a stale size so it doesn't fill the pane. Observing the container covers that
// timing without guessing a delay; fit() is a no-op when dimensions are
// unchanged, so redundant callbacks are cheap.
function wireTerminalResizeObserver() {
  const container = document.getElementById('terminal-container');
  if (!container || typeof ResizeObserver === 'undefined') return;
  const ro = new ResizeObserver(() => {
    if (!activeKey) return;
    const view = views.get(activeKey);
    // Only fit the visible terminal; hidden views (display:none) measure as 0.
    if (view?.ui === 'terminal' && view.container.style.display !== 'none') {
      fitWhenVisible(view.container, () => view.fitAddon.fit());
    }
  });
  ro.observe(container);
}

// refreshAllMachines pulls each machine's session list over REST. It is the
// single reachability signal used by the desktop sidebar.
async function refreshAllMachines(force = false, targetMachineKey?: string) {
  const generation = ++machineRefreshGeneration;
  const now = Date.now();
  const refreshMachines = machines.filter((machine) => {
    const mk = machineKey(machine);
    if (targetMachineKey && mk !== targetMachineKey) return false;
    return force || (machineRetryAt.get(mk) ?? 0) <= now;
  });

  // Publish each response independently. In particular, a slow / unavailable
  // info endpoint must not delay the session list (or make a healthy machine
  // appear offline after its sessions request succeeds).
  const isCurrent = (m: MachineConfig) => {
    const mk = machineKey(m);
    return generation === machineRefreshGeneration && machines.some((current) => machineKey(current) === mk);
  };
  const publish = (m: MachineConfig) => {
    const mk = machineKey(m);
    if (!isCurrent(m)) return;
    renderSidebar();
    if (overviewMachineKey === mk) {
      const overviewMachine = machines.find((candidate) => machineKey(candidate) === mk);
      if (overviewMachine) renderMachineOverview(overviewMachine);
    }
    updateStatusBar();
  };

  await Promise.all(
    refreshMachines.flatMap((m) => {
      const mk = machineKey(m);
      const rest = rests.get(mk);
      if (!rest) return [];
      const sessionsRequest = rest.listSessions()
        .then((sessions) => {
          if (!isCurrent(m)) return;
          trackChatActivity(m, sessions);
          machineSessions.set(mk, sessions);
          machineOnline.set(mk, true);
          machineIssues.delete(mk);
          machineFailures.delete(mk);
          machineRetryAt.delete(mk);
        })
        .catch((error: unknown) => {
          if (!isCurrent(m)) return;
          machineOnline.set(mk, false);
          machineIssues.set(mk, classifyMachineIssue(error));
          const failures = (machineFailures.get(mk) ?? 0) + 1;
          machineFailures.set(mk, failures);
          machineRetryAt.set(mk, Date.now() + Math.min(5000 * (2 ** (failures - 1)), 60000));
        })
        .finally(() => publish(m));
      return [sessionsRequest];
    }),
  );
}

// trackChatActivity updates the dots of chat sessions that are not open here
// from what the poll says about them, and notifies when one starts waiting.
function trackChatActivity(machine: MachineConfig, sessions: SessionInfo[]) {
  const mk = machineKey(machine);
  const live = new Set<string>();
  for (const s of sessions) {
    if (s.ui !== 'chat') continue;
    const key = viewKey(machine, s.id);
    live.add(key);
    const next: RestSnapshot = { state: s.state, activitySeq: s.activitySeq, epoch: s.epoch };
    const prev = restSnapshots.get(key);
    restSnapshots.set(key, next);
    if (views.has(key)) continue; // an open view follows its live frames
    const r = nextDot(sessionDots.get(key) ?? 'none', { kind: 'rest', prev, next }, { isActive: false, windowFocused: document.hasFocus() });
    sessionDots.set(key, r.dot);
    if (r.notify && notificationsEnabled()) {
      const title = `${machine.name} · ${s.title || s.id}`;
      notifyDesktop(title, t('session.waitingFallback'), key, (result) => {
        const after = nextDot(sessionDots.get(key) ?? 'none', { kind: 'notifyResult', result }, { isActive: key === activeKey, windowFocused: document.hasFocus() });
        sessionDots.set(key, after.dot);
      });
    }
  }
  for (const key of [...restSnapshots.keys()]) {
    if (key.startsWith(`${mk}::`) && !live.has(key)) {
      restSnapshots.delete(key);
      sessionDots.delete(key);
    }
  }
}

// applyViewActivity moves an open chat view's dot on a live event and raises
// the "needs you" notification (R16.1–R16.3).
function applyViewActivity(view: ChatView, ev: ActivityEvent, prompt?: Prompt) {
  const r = nextDot(view.activity, ev, { isActive: view.key === activeKey, windowFocused: document.hasFocus() });
  if (r.dot !== view.activity) {
    view.activity = r.dot;
    renderSidebar();
  }
  if (r.notify && notificationsEnabled()) {
    const body = prompt?.kind === 'plan'
      ? t('chat.notify.plan')
      : prompt?.kind === 'question'
        ? t('chat.notify.question')
        : prompt?.toolName ? t('chat.notify.tool', { tool: prompt.toolName }) : t('session.waitingFallback');
    notifyDesktop(`${view.machine.name} · ${sessionDisplayTitle(view.machine, view.sessionId)}`, body, view.key, (result) => {
      applyViewActivity(view, { kind: 'notifyResult', result });
    });
  }
}

function classifyMachineIssue(error: unknown): MachineIssue {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/\b(401|403)\b/.test(message)) return 'auth';
  if (/\b404\b/.test(message)) return 'version';
  return 'unreachable';
}

// Machine overview keeps machine-level actions close to the selected machine.
// It intentionally contains no remote filesystem/runtime metadata: paths and
// environment details belong in the directory picker and terminal context.
function renderMachineOverview(machine: MachineConfig) {
  const mount = document.getElementById('machine-overview');
  if (!mount) return;

  const mk = machineKey(machine);
  const reachability = machineOnline.get(mk);
  const online = reachability === true;
  const sessions = machineSessions.get(mk) ?? [];
  mount.textContent = '';

  const workspace = document.createElement('div');
  workspace.className = 'workspace-page';

  const header = document.createElement('header');
  header.className = 'workspace-header';
  const identity = document.createElement('div');
  identity.className = 'workspace-identity';
  const eyebrow = document.createElement('p');
  eyebrow.className = 'workspace-eyebrow';
  eyebrow.textContent = t('workspace.eyebrow');
  const title = document.createElement('h1');
  title.textContent = machine.name;
  const titleRow = document.createElement('div');
  titleRow.className = 'workspace-title-row';
  const machineMark = document.createElement('span');
  machineMark.className = `workspace-machine-mark ${reachability === undefined ? 'checking' : online ? 'connected' : 'error'}`;
  machineMark.appendChild(rendererIcon('machine'));
  titleRow.append(machineMark, title);
  identity.append(eyebrow, titleRow);

  const headerActions = document.createElement('div');
  headerActions.className = 'workspace-header-actions';
  const manage = document.createElement('button');
  manage.type = 'button';
  manage.className = 'btn-secondary';
  manage.textContent = t('workspace.manage');
  manage.addEventListener('click', () => {
    document.getElementById('btn-manage-machines')?.dispatchEvent(new MouseEvent('click'));
  });
  headerActions.append(manage);
  header.append(identity, headerActions);

  const summary = document.createElement('p');
  summary.className = 'workspace-summary';
  summary.textContent = `${t('workspace.summary.sessions', { count: sessions.length })} · ${isLoopbackAddress(machine.addr) ? t('workspace.summary.local') : t('workspace.summary.remote')}`;

  let connectionNotice: HTMLElement | null = null;
  if (reachability === false) {
    connectionNotice = document.createElement('section');
    connectionNotice.className = 'workspace-notice workspace-notice-error';
    connectionNotice.setAttribute('aria-labelledby', 'connection-notice-title');
    const noticeCopy = document.createElement('div');
    const noticeTitle = document.createElement('strong');
    noticeTitle.id = 'connection-notice-title';
    noticeTitle.textContent = t('workspace.connectionIssue.title');
    const noticeDetail = document.createElement('p');
    noticeDetail.textContent = t(`workspace.connectionIssue.${machineIssues.get(mk) ?? 'unreachable'}`);
    noticeCopy.append(noticeTitle, noticeDetail);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn-secondary workspace-retry';
    retry.textContent = t('workspace.connectionIssue.retry');
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      retry.setAttribute('aria-busy', 'true');
      machineRetryAt.delete(mk);
      await refreshAllMachines(true, mk);
    });
    connectionNotice.append(noticeCopy, retry);
  }

  const recentSection = document.createElement('section');
  recentSection.className = 'workspace-section';
  const recentHeading = document.createElement('div');
  recentHeading.className = 'workspace-section-heading';
  const recentTitleGroup = document.createElement('div');
  recentTitleGroup.className = 'workspace-section-titles';
  const recentTitle = document.createElement('h2');
  recentTitle.textContent = t('workspace.recent.title');
  const recentSubtitle = document.createElement('p');
  recentSubtitle.className = 'workspace-section-subtitle';
  recentSubtitle.textContent = t('workspace.recent.subtitle');
  recentTitleGroup.append(recentTitle, recentSubtitle);
  recentHeading.append(recentTitleGroup);
  recentSection.appendChild(recentHeading);

  const recentList = document.createElement('div');
  recentList.className = 'workspace-recent-list';
  const recent = [...sessions].sort((a, b) => b.created.localeCompare(a.created));
  if (recent.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'workspace-empty';
    empty.textContent = t('workspace.recent.empty');
    recentList.appendChild(empty);
  } else {
    for (const session of recent.slice(0, 5)) {
      const key = viewKey(machine, session.id);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'workspace-session-row';
      const sessionTitle = document.createElement('strong');
      sessionTitle.textContent = session.title || session.id;
      const identity = document.createElement('span');
      identity.className = 'workspace-session-identity';
      const sessionIcon = document.createElement('span');
      sessionIcon.className = 'workspace-session-icon';
      sessionIcon.appendChild(rendererIcon(session.ui === 'chat' ? 'chat' : 'terminal'));
      const sessionCopy = document.createElement('span');
      sessionCopy.className = 'workspace-session-copy';
      sessionCopy.appendChild(sessionTitle);
      identity.append(sessionIcon, sessionCopy);
      const badges = document.createElement('span');
      badges.className = 'workspace-session-badges';
      const mode = document.createElement('span');
      mode.className = 'workspace-badge';
      mode.textContent = session.mode === 'worktree' ? t('workspace.badge.worktree') : t('workspace.badge.normal');
      const status = document.createElement('span');
      status.className = 'workspace-badge workspace-badge-status';
      status.textContent = views.has(key) ? t('workspace.badge.running') : t('workspace.badge.remote');
      badges.append(mode, status);
      row.append(identity, badges);
      row.dataset.ui = session.ui ?? 'terminal';
      row.addEventListener('click', () => openExisting(machine, session));
      recentList.appendChild(row);
    }
  }
  recentSection.appendChild(recentList);

  const modesSection = document.createElement('section');
  modesSection.className = 'workspace-section';
  const modesTitleGroup = document.createElement('div');
  modesTitleGroup.className = 'workspace-section-titles';
  const modesTitle = document.createElement('h2');
  modesTitle.textContent = t('workspace.start.title');
  const modesSubtitle = document.createElement('p');
  modesSubtitle.className = 'workspace-section-subtitle';
  modesSubtitle.textContent = t('workspace.start.subtitle');
  modesTitleGroup.append(modesTitle, modesSubtitle);
  const modeGrid = document.createElement('div');
  modeGrid.className = 'workspace-mode-grid';
  const modes: Array<{ mode: SessionMode; title: string; description: string; hint: string; action: string; tag?: string; featured?: boolean }> = [
    { mode: 'normal', title: t('mode.normal.title'), description: t('mode.normal.desc'), hint: t('mode.normal.hint'), action: t('mode.normal.action') },
    { mode: 'worktree', title: t('mode.worktree.title'), description: t('mode.worktree.desc'), hint: t('mode.worktree.hint'), action: t('mode.worktree.action'), tag: t('mode.worktree.tag'), featured: true },
  ];
  for (const item of modes) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `workspace-mode-card${item.featured ? ' workspace-mode-card-featured' : ''}`;
    card.disabled = !online;
    if (!online) card.title = t('workspace.connectionIssue.required');
    const cardHead = document.createElement('span');
    cardHead.className = 'workspace-mode-head';
    const cardIcon = document.createElement('span');
    cardIcon.className = 'workspace-mode-icon';
    cardIcon.appendChild(rendererIcon(item.mode === 'worktree' ? 'branch' : 'terminal'));
    const cardTitle = document.createElement('strong');
    cardTitle.textContent = item.title;
    cardHead.append(cardIcon, cardTitle);
    if (item.tag) {
      const tag = document.createElement('span');
      tag.className = 'workspace-mode-tag';
      tag.textContent = item.tag;
      cardHead.appendChild(tag);
    }
    const description = document.createElement('span');
    description.className = 'workspace-mode-desc';
    description.textContent = item.description;
    const hint = document.createElement('span');
    hint.className = 'workspace-mode-hint';
    hint.textContent = item.hint;
    const action = document.createElement('span');
    action.className = 'workspace-mode-action';
    action.textContent = `${item.action} →`;
    card.append(cardHead, description, hint, action);
    card.addEventListener('click', () => startNewSession(machine, item.mode));
    modeGrid.appendChild(card);
  }
  modesSection.append(modesTitleGroup, modeGrid);

  const content = document.createElement('div');
  content.className = 'workspace-content';
  if (online && recent.length === 0) {
    content.classList.add('workspace-content-empty');
    content.appendChild(modesSection);
  } else if (online) {
    content.append(recentSection, modesSection);
  } else if (recent.length > 0) {
    content.classList.add('workspace-content-single');
    content.appendChild(recentSection);
  }

  workspace.append(header, summary);
  if (connectionNotice) workspace.appendChild(connectionNotice);
  if (content.childElementCount > 0) workspace.appendChild(content);
  mount.appendChild(workspace);
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
}

async function startNewSession(machine: MachineConfig, initialMode?: SessionMode) {
  const picked = await openDirPicker(machine, initialMode);
  if (!picked) return;
  if (picked.ui === 'chat') openChatSession(machine, '', picked.workdir, picked.flags, picked.mode);
  else openSession(machine, '', picked.workdir, picked.flags, picked.mode);
}

function showMachineOverview(machine: MachineConfig) {
  overviewMachineKey = machineKey(machine);
  // Every view is hidden now, so none is the current session: their sidebar
  // dots and "needs you" notifications work as for any background session.
  activeKey = null;
  for (const view of views.values()) view.container.style.display = 'none';
  const mount = document.getElementById('machine-overview');
  if (mount) {
    mount.hidden = false;
    renderMachineOverview(machine);
  }
  renderSidebar();
  updateStatusBar();
}

function makeTerminal(): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    theme: {
      background: '#FBFAF7', foreground: '#2B2A28', cursor: '#AD5048',
      selectionBackground: '#DED7CB',
      black: '#3B3A37', red: '#C0564B', green: '#5E8C58', yellow: '#B07D2E',
      blue: '#4A72B0', magenta: '#9A5BA0', cyan: '#3E8C8C', white: '#6B6862',
      brightBlack: '#9B978E', brightRed: '#C0564B', brightGreen: '#5E8C58',
      brightYellow: '#B07D2E', brightBlue: '#4A72B0', brightMagenta: '#9A5BA0',
      brightCyan: '#3E8C8C', brightWhite: '#2B2A28',
    },
    cursorBlink: true, scrollback: 10000, allowProposedApi: true,
    // claude turns on mouse reporting, which otherwise makes xterm forward every
    // drag to the app and disable its own selection — getSelection() would always
    // return '' and ⌘C would copy nothing. This inverts the default: a plain drag
    // selects text, and mouse events reach claude only while ⌥ is held. Wheel
    // events are exempt, so scrolling inside claude keeps working unmodified.
    mouseEventsRequireAlt: true,
    // Fallback escape hatch (⌥-drag forces selection). mouseEventsRequireAlt takes
    // precedence when both are set; this only matters if that option goes away.
    macOptionClickForcesSelection: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { term, fit };
}

// openExisting opens a listed session in the view its kind needs.
function openExisting(machine: MachineConfig, session: SessionInfo): AnyView {
  return session.ui === 'chat' ? openChatSession(machine, session.id, session.workdir) : openSession(machine, session.id);
}

// openChatSession creates a ChatView (its own WS + transcript) and attaches
// with ui:'chat'. sessionId '' means create a brand-new chat session.
function openChatSession(machine: MachineConfig, sessionId: string, workdir?: string, flags?: string[], mode: SessionMode = 'normal'): AnyView {
  const key = viewKey(machine, sessionId);
  const existing = views.get(key);
  if (existing) {
    setActive(key);
    return existing;
  }
  const wrap = document.getElementById('terminal-container')!;
  const client = new VibeRemoteClient(machine);
  const view = new ChatView(machine, client, key, sessionId, workdir ?? '');
  wrap.appendChild(view.container);
  views.set(key, view);

  view.onMessage = (text) => {
    if (view.key === activeKey) updateStatusBar(text);
  };
  view.onActivity = () => renderSidebar();
  view.onActivityEvent = (ev, prompt) => applyViewActivity(view, ev, prompt);
  view.onHandoff = () => handoffChat(view);
  view.onRestart = () => void reloadChat(machine, view.sessionId, sessionDisplayTitle(machine, view.sessionId));
  view.onRecheck = () => void recheckChat(view);
  view.onOpenTerminal = (id) => openTerminalById(machine, id);
  // Chat state comes from the structured stream (R16.4); hook notify frames
  // (idle / waiting) are for terminal sessions and are ignored here.
  client.onNotify = () => {};

  client.onReady = (sid, readyWorkdir, proto, ready) => {
    view.banner.style.display = 'none';
    // R2.6: the -c conversation is already running in session `sid`.
    if (ready.existing) updateStatusBar(t('chat.existing', { name: sessionDisplayTitle(machine, sid) }));
    if (view.sessionId !== sid && adoptExisting(view, sid)) return;
    if (view.sessionId !== sid) {
      views.delete(view.key);
      view.sessionId = sid;
      view.key = viewKey(machine, sid);
      views.set(view.key, view);
      if (activeKey === key) activeKey = view.key;
    }
    view.setWorkdir(readyWorkdir);
    refreshAllMachines();
    updateStatusBar();
    if (proto < PROTOCOL_VERSION && !view.warnedProto && view.key === activeKey) {
      view.warnedProto = true;
      updateStatusBar(t('terminal.oldDaemon', { proto, want: PROTOCOL_VERSION }));
    }
  };
  client.onStateChange = (state, attempt) => {
    if (state === ConnectionState.Reconnecting) view.banner.style.display = 'flex';
    else if (state === ConnectionState.Connected) view.banner.style.display = 'none';
    view.setConnected(state === ConnectionState.Connected);
    if (view.key === activeKey) updateStatusBar(undefined, attempt);
  };
  client.onExit = (code) => {
    // The chat session's own state (chat_state.ended) drives the transcript;
    // the connection stays and reload can bring the process back.
    updateStatusBar(t('status.sessionExited', { code }));
    refreshAllMachines();
  };
  client.onError = (msg, fatal) => {
    console.error(`[${machine.name}]`, msg);
    if (fatal) {
      view.banner.style.display = 'none';
      view.setConnected(false);
      refreshAllMachines();
    }
    if (view.key === activeKey) updateStatusBar(t('status.error', { msg }));
  };

  client.connect();
  client.attach(sessionId, 80, 24, workdir, flags, sessionId ? undefined : mode, { ui: 'chat' });
  setActive(view.key);
  return view;
}

// openSession creates a new SessionView (its own WS + xterm) and attaches.
// sessionId '' means create a brand-new session with the given workdir.
// `opts.handoffFrom` creates the terminal session that takes over a chat session (R14).
function openSession(machine: MachineConfig, sessionId: string, workdir?: string, flags?: string[], mode: SessionMode = 'normal', opts?: AttachOptions): AnyView {
  const key = viewKey(machine, sessionId);
  const existing = views.get(key);
  if (existing) {
    setActive(key);
    return existing;
  }

  const wrap = document.getElementById('terminal-container')!;
  const container = document.createElement('div');
  container.className = 'term-instance';
  // Keep the view in layout from the beginning. xterm measures its host during
  // term.open(); display:none would produce 0×0 and send a fallback 80×24
  // attach before the first real fit.
  container.style.display = 'block';
  wrap.appendChild(container);

  const { term, fit } = makeTerminal();
  term.open(container);
  attachMacClipboardShortcuts(term, window.vibeRemote, (error) => {
    console.error('Clipboard operation failed', error);
  }, (_operation, details) => {
    if (location.protocol === 'http:') {
      console.debug('Clipboard text length', details);
    }
  });

  const client = new VibeRemoteClient(machine);
  const banner = document.createElement('div');
  banner.className = 'reconnect-banner';
  banner.style.display = 'none';
  const view: SessionView = { ui: 'terminal', key, machine, sessionId, client, terminal: term, fitAddon: fit, container, banner, activity: 'none', suppressUntil: 0, warnedProto: false };
  views.set(key, view);

  // Classed so a locale switch can retranslate banners that already exist:
  // these are created once per session but only become visible later, on a
  // disconnect, so without this they'd show the language from creation time.
  const bannerText = document.createElement('span');
  bannerText.className = 'reconnect-banner-text';
  bannerText.textContent = t('banner.reconnecting');
  const retryBtn = document.createElement('button');
  retryBtn.className = 'reconnect-banner-retry';
  retryBtn.textContent = t('banner.retry');
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

  client.onReady = (sid: string, _workdir: string, proto: number) => {
    view.banner.style.display = 'none';
    // A handoff can resolve to the terminal session that already took over
    // (6.5 step 2); if that one is open here, keep it and drop this view.
    if (view.sessionId !== sid && adoptExisting(view, sid)) return;
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
    // An older daemon accepts the attach but silently ignores what it doesn't
    // know (newSessionId, worktree mode on very old builds). Say so once per
    // view instead of letting the user assume features that aren't there. The
    // status bar, not the terminal: tmux repaints the whole screen right after
    // ready, which would wipe a line written into xterm before anyone reads it.
    if (proto < PROTOCOL_VERSION && !view.warnedProto && view.key === activeKey) {
      view.warnedProto = true;
      updateStatusBar(t('terminal.oldDaemon', { proto, want: PROTOCOL_VERSION }));
    }
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
    if (view.terminal) view.terminal.write(`\r\n\x1b[33m[${t('terminal.exited', { code })}]\x1b[0m\r\n`);
    updateStatusBar(t('status.sessionExited', { code }));
    refreshAllMachines();
  };
  client.onError = (msg, fatal) => {
    console.error(`[${machine.name}]`, msg);
    // Show the error to the user instead of leaving a blank terminal.
    if (view.terminal) view.terminal.write(`\r\n\x1b[31m[${t('terminal.error', { msg })}]\x1b[0m\r\n`);
    if (fatal) {
      // The client has stopped reconnecting; a "reconnecting…" banner would
      // promise something that will never happen.
      view.banner.style.display = 'none';
      if (view.terminal) view.terminal.write(`\x1b[33m[${t('terminal.fatal')}]\x1b[0m\r\n`);
      refreshAllMachines();
    }
    if (view.key === activeKey) updateStatusBar(t('status.error', { msg }));
  };
  client.onNotify = (kind, message) => {
    // hook 事件把圆点从「有输出」升级为语义状态。活动会话不标记（用户在看）。
    if (kind === 'idle' || kind === 'waiting') {
      if (view.key !== activeKey) {
        view.activity = kind;
        renderSidebar();
      }
      // waiting = 需要用户介入，可选弹桌面通知。
      if (kind === 'waiting' && notificationsEnabled()) {
        notifyDesktop(`${machine.name} · ${sessionDisplayTitle(machine, view.sessionId)}`, message || t('session.waitingFallback'));
      }
    }
  };

  client.connect();
  const dims = dimensionsWhenVisible(container, () => fit.proposeDimensions());
  client.attach(sessionId, dims?.cols || 80, dims?.rows || 24, workdir, flags, sessionId ? undefined : mode, opts);

  setActive(view.key);
  return view;
}

// adoptExisting handles a create whose `ready` names a session that is
// already open here (R2.6 existing, a handoff that joined its terminal
// session): the open view wins, the new one is closed. Returns true if so.
function adoptExisting(view: AnyView, sid: string): boolean {
  const target = viewKey(view.machine, sid);
  const other = views.get(target);
  if (!other || other === view) return false;
  const wasActive = activeKey === view.key;
  disposeView(view);
  views.delete(view.key);
  if (wasActive) setActive(target);
  return true;
}

// openTerminalById opens (or switches to) a terminal session by id.
function openTerminalById(machine: MachineConfig, sessionId: string) {
  const key = viewKey(machine, sessionId);
  if (views.has(key)) setActive(key);
  else openSession(machine, sessionId);
}

// handoffChat continues a chat session in a new terminal session running
// `claude --resume` on the same conversation (R14). A turn in progress is
// interrupted by the daemon, so ask first (R14.2).
function handoffChat(view: ChatView) {
  if (!view.sessionId) return;
  const st = view.state();
  if (st.ended?.reason === 'handed_off' && st.ended.handedOffTo) {
    openTerminalById(view.machine, st.ended.handedOffTo);
    return;
  }
  const busy = !st.ended && (st.status === 'running' || st.status === 'waiting');
  if (busy && !window.confirm(t('chat.handoff.confirm'))) return;
  openSession(view.machine, '', undefined, undefined, 'normal', { handoffFrom: view.sessionId });
}

// reloadChat restarts a chat session's claude process on the same
// conversation (R15.3). The REST call returns 202 at once; the open view
// learns the outcome from chat_state (d10), so rest.ts keeps its timeout.
async function reloadChat(machine: MachineConfig, sessionId: string, name: string) {
  const key = viewKey(machine, sessionId);
  if (!sessionId || reloadingSessions.has(key)) return;
  const open = views.get(key);
  const chatView = open?.ui === 'chat' ? open : null;
  reloadingSessions.add(key);
  chatView?.beginRestart();
  renderSidebar();
  try {
    await rests.get(machineKey(machine))!.reloadSession(sessionId);
    updateStatusBar(t('chat.reload.started', { name }));
  } catch (error) {
    chatView?.cancelRestart();
    updateStatusBar(reloadErrorText(machine, error));
  } finally {
    reloadingSessions.delete(key);
    renderSidebar();
    void refreshAllMachines();
  }
}

function reloadErrorText(machine: MachineConfig, error: unknown): string {
  if (error instanceof ReloadSessionError && error.message === 'claude_session_busy') {
    const owner = error.owner ?? '';
    const holder = machineSessions.get(machineKey(machine))?.find((s) => s.id === owner);
    return t('chat.reload.busy', { owner: holder?.title || owner || '?' });
  }
  return t('chat.reload.failed', { msg: error instanceof Error ? error.message : String(error) });
}

// recheckChat: "upgraded, check again" after version_unsupported (R13.4). The
// daemon probes claude again; if it is new enough now, restart the session.
async function recheckChat(view: ChatView) {
  const rest = rests.get(machineKey(view.machine));
  if (!rest) return;
  try {
    const info = await rest.info({ recheck: true });
    if (info.chat?.supported) {
      await reloadChat(view.machine, view.sessionId, sessionDisplayTitle(view.machine, view.sessionId));
    } else {
      updateStatusBar(t('chat.recheck.stillOld', { version: info.chat?.claudeVersion || '?', min: info.chat?.minClaudeVersion || '?' }));
    }
  } catch (error) {
    updateStatusBar(t('chat.recheck.failed', { msg: error instanceof Error ? error.message : String(error) }));
  }
}

// sessionDisplayTitle is the name the sidebar shows for a session (custom
// name, else the workdir-derived default from the server), falling back to the
// raw id when the session list hasn't caught up yet (e.g. a brand-new session).
function sessionDisplayTitle(machine: MachineConfig, sessionId: string): string {
  const session = machineSessions.get(machineKey(machine))?.find((s) => s.id === sessionId);
  return session?.title || sessionId || 'vibe-remote';
}

// setActive shows one session view and hides the rest, then fits + focuses it.
function setActive(key: string) {
  activeKey = key;
  overviewMachineKey = null;
  const overview = document.getElementById('machine-overview');
  if (overview) overview.hidden = true;
  const activeView = views.get(key);
  if (activeView && activeView.activity !== 'none') {
    activeView.activity = 'none';
  }
  sessionDots.delete(key);
  if (activeView) {
    const activeMachineKey = machineKey(activeView.machine);
    if (collapsedMachines.delete(activeMachineKey)) persistCollapsedMachines();
  }
  for (const [k, v] of views) {
    v.container.style.display = k === key ? 'block' : 'none';
  }
  const view = views.get(key);
  if (view?.ui === 'chat') {
    view.show();
  } else if (view) {
    // Fit only after the host has a real box. The first startup can still be in
    // Electron's maximize/layout transition; fitWhenVisible retries once on
    // the next frame instead of locking xterm to the initial small dimensions.
    fitWhenVisible(view.container, () => {
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

    const sessions = machineSessions.get(machineKey(machine)) || [];
    const collapsed = collapsedMachines.has(machineKey(machine));
    const groupHeader = document.createElement('div');
    groupHeader.className = 'machine-group-header';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'machine-toggle';
    toggle.appendChild(rendererIcon('chevron'));
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', t('a11y.actionTarget', { action: collapsed ? t('sidebar.expand') : t('sidebar.collapse'), target: machine.name }));
    toggle.disabled = sessions.length === 0;
    toggle.addEventListener('click', () => {
      if (collapsedMachines.has(machineKey(machine))) collapsedMachines.delete(machineKey(machine));
      else collapsedMachines.add(machineKey(machine));
      persistCollapsedMachines();
      renderSidebar();
    });
    const nameRow = document.createElement('button');
    nameRow.type = 'button';
    const mKey = machineKey(machine);
    const machineState = machineOnline.get(mKey);
    const isOverview = mKey === overviewMachineKey;
    nameRow.className = 'machine-name' + (isOverview ? ' selected' : '');
    if (isOverview) nameRow.setAttribute('aria-current', 'page');
    nameRow.setAttribute('aria-label', `${machine.name} · ${machineState === true ? t('workspace.connected') : machineState === false ? t('workspace.offline') : t('status.connecting')}`);
    const nameSpan = document.createElement('span');
    nameSpan.className = 'machine-name-label';
    nameSpan.textContent = machine.name;
    const machineIcon = document.createElement('span');
    machineIcon.className = `machine-kind-icon ${machineState === true ? 'connected' : machineState === false ? 'error' : 'checking'}`;
    machineIcon.appendChild(rendererIcon('machine'));
    const sessionCount = document.createElement('span');
    sessionCount.className = 'machine-session-count';
    sessionCount.textContent = String(sessions.length);
    sessionCount.setAttribute('aria-hidden', 'true');
    nameRow.append(machineIcon, nameSpan, sessionCount);
    nameRow.addEventListener('click', () => {
      showMachineOverview(machine);
    });

    const list = document.createElement('div');
    list.className = 'session-list';
    list.hidden = collapsed;

    for (const s of sessions) {
      const key = viewKey(machine, s.id);
      const item = document.createElement('div');
      item.className = 'session-item' + (key === activeKey ? ' active' : '');
      item.dataset.ui = s.ui ?? 'terminal';

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'session-label';
      const sessionIcon = document.createElement('span');
      sessionIcon.className = 'session-kind-icon';
      sessionIcon.appendChild(rendererIcon(s.ui === 'chat' ? 'chat' : 'terminal'));
      const sessionText = document.createElement('span');
      sessionText.className = 'session-label-text';
      sessionText.textContent = s.title || (s.workdir ? s.workdir.split('/').pop() : '') || s.id;
      label.append(sessionIcon, sessionText);
      if (s.ui === 'chat') {
        const badge = document.createElement('span');
        badge.className = 'session-ui-badge';
        badge.textContent = t('chat.badge');
        label.appendChild(badge);
      }
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
          openExisting(machine, s); // already open: instant, no delay
        } else {
          window.clearTimeout(openTimer);
          openTimer = window.setTimeout(() => openExisting(machine, s), 220);
        }
      });
      label.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        window.clearTimeout(openTimer); // cancel any pending open for this label
        startInlineRename(machine, s, label);
      });

      const dot = document.createElement('span');
      dot.className = 'session-unread';
      dot.setAttribute('aria-hidden', 'true');
      const openView = views.get(key);
      const act = openView?.activity ?? sessionDots.get(key) ?? 'none';
      if (act === 'none' || key === activeKey) {
        dot.classList.add('hidden');
        item.dataset.dot = 'none';
      } else {
        dot.classList.add(act); // 'output' | 'idle' | 'waiting'
        item.dataset.dot = act;
      }

      const reload = document.createElement('button');
      reload.type = 'button';
      reload.className = 'session-action session-reload';
      reload.appendChild(rendererIcon('reload'));
      reload.title = t('session.reloadTitle');
      reload.setAttribute('aria-label', t('a11y.actionTarget', { action: t('session.reloadTitle'), target: s.title || s.id }));
      // Reflect any in-flight Reload for this session, so a sidebar rebuild
      // mid-request doesn't hand back an enabled button.
      const reloadKey = viewKey(machine, s.id);
      if (reloadingSessions.has(reloadKey)) {
        reload.disabled = true;
        reload.setAttribute('aria-busy', 'true');
      }
      reload.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (reloadingSessions.has(reloadKey)) return;
        const name = s.title || (s.workdir ? s.workdir.split('/').pop() : '') || s.id;
        if (s.ui === 'chat') {
          // Chat: 202 now, the outcome later through chat_state (d10).
          if (!window.confirm(t('chat.reload.confirm', { name }))) return;
          void reloadChat(machine, s.id, name);
          return;
        }
        if (!window.confirm(t('session.reloadConfirm', { name }))) return;
        reloadingSessions.add(reloadKey);
        reload.disabled = true;
        reload.setAttribute('aria-busy', 'true');
        try {
          await rests.get(machineKey(machine))!.reloadSession(s.id);
          updateStatusBar(t('session.reloadSuccess', { name }));
          reloadingSessions.delete(reloadKey);
          await refreshAllMachines();
        } catch (error) {
          updateStatusBar(t('session.reloadFailed', {
            msg: error instanceof Error ? error.message : String(error),
          }));
          reloadingSessions.delete(reloadKey);
        } finally {
          // This button may already be detached by a rebuild; harmless either way.
          reload.disabled = false;
          reload.removeAttribute('aria-busy');
        }
      });

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'session-action session-close';
      close.appendChild(rendererIcon('close'));
      close.title = t('session.deleteTitle');
      close.setAttribute('aria-label', t('a11y.actionTarget', { action: t('session.deleteTitle'), target: s.title || s.id }));
      // Deleting truly kills the remote tmux + claude; the current screen is
      // lost and unrecoverable. Confirm first (mirrors machine-delete in
      // machines.ts), showing the session's display name so a mis-hover on the
      // wrong row is caught before the DELETE fires.
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = s.title || (s.workdir ? s.workdir.split('/').pop() : '') || s.id;
        if (!window.confirm(t('session.deleteConfirm', { name }))) {
          return;
        }
        closeSession(machine, s.id);
      });

      item.append(label, dot, reload, close);
      list.appendChild(item);
    }

    groupHeader.append(toggle, nameRow);
    group.append(groupHeader, list);
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
    const mk = machineKey(machine);
    // Invalidate in-flight session polls before the rename request starts. Their
    // old title must not be allowed to render over the rename transaction.
    machineRefreshGeneration++;
    try {
      await rests.get(mk)!.renameSession(s.id, name);
    } catch (e) {
      console.error('rename failed', e);
    } finally {
      // Refresh even after failure so the sidebar returns to the server's
      // authoritative title. Keep the input protected until that refresh is done.
      await refreshAllMachines(false, mk);
      renamingActive = false;
      renderSidebar();
    }
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
  const statusBar = document.getElementById('status-bar')!;
  const statusMessage = document.getElementById('status-message')!;
  const tbTitle = document.getElementById('toolbar-title')!;
  const tbStatus = document.getElementById('toolbar-status')!;
  const tbStatusText = document.getElementById('toolbar-status-text')!;
  const view = activeKey ? views.get(activeKey) : null;
  const overviewMachine = overviewMachineKey
    ? machines.find((m) => machineKey(m) === overviewMachineKey)
    : null;
  tbStatus.className = '';

  if (extra) {
    statusMessage.textContent = extra;
    statusBar.hidden = false;
    if (statusMessageTimer) clearTimeout(statusMessageTimer);
    statusMessageTimer = setTimeout(() => {
      statusBar.hidden = true;
      statusMessage.textContent = '';
      statusMessageTimer = null;
    }, 6000);
  }

  if (overviewMachine) {
    const state = machineOnline.get(overviewMachineKey!);
    tbTitle.textContent = overviewMachine.name;
    tbStatus.className = state === true ? 'connected' : state === false ? 'error' : 'checking';
    tbStatusText.textContent = state === true
      ? t('status.connected')
      : state === false ? t('workspace.offline') : t('status.connecting');
    return;
  }

  if (view) {
    // Toolbar title: machine name · short session code (SessionView holds no
    // display name; short code is enough to locate the active session).
    const shortId = view.sessionId ? view.sessionId.slice(-6) : 'new';
    tbTitle.textContent = `${view.machine.name} · ${shortId}`;

    const st = view.client.state;
    if (st === ConnectionState.Connected) {
      tbStatus.className = 'connected';
      tbStatusText.textContent = t('status.connected');
    } else if (st === ConnectionState.Reconnecting) {
      const n = attempt ?? 0;
      tbStatus.className = 'reconnecting';
      tbStatusText.textContent = n > 0 ? t('status.reconnectingAttempt', { n }) : t('status.reconnecting');
    } else {
      tbStatus.className = 'error';
      tbStatusText.textContent = t('status.disconnected');
    }
  } else {
    tbTitle.textContent = 'vibe-remote';
    const anyOnline = [...machineOnline.values()].some(Boolean);
    tbStatus.className = anyOnline ? 'connected' : '';
    tbStatusText.textContent = anyOnline ? t('status.ready') : t('status.noConnection');
  }
}

// closeSession kills the remote session (tmux + claude) and removes its view.
async function closeSession(machine: MachineConfig, sessionId: string) {
  let deletionSucceeded = false;
  try {
    await rests.get(machineKey(machine))!.deleteSession(sessionId);
    deletionSucceeded = true;
  } catch (e) {
    console.error('delete session failed', e);
    if (e instanceof DeleteSessionError && e.status === 409 && e.code === 'worktree_preserved') {
      await refreshAllMachines();
      updateStatusBar(t('session.worktreePreserved', { path: e.worktreeRoot || '—', branch: e.branch || '—' }));
      return;
    } else {
      updateStatusBar(t('status.error', { msg: e instanceof Error ? e.message : String(e) }));
    }
  }
  if (!deletionSucceeded) {
    refreshAllMachines();
    return;
  }
  const key = viewKey(machine, sessionId);
  // The session is gone; drop any Reload marker so the key can't linger and
  // disable a future session that happens to reuse the id.
  reloadingSessions.delete(key);
  const view = views.get(key);
  if (view) {
    disposeView(view);
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
  const h = document.createElement('h1');
  h.className = 'empty-state-title';
  h.textContent = t('empty.title');
  const p = document.createElement('p');
  p.className = 'empty-state-description';
  p.textContent = t('empty.desc');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-primary';
  btn.textContent = t('empty.addMachine');
  btn.addEventListener('click', () => document.getElementById('btn-manage-machines')?.dispatchEvent(new MouseEvent('click')));
  const hint = document.createElement('p');
  hint.className = 'empty-state-hint';
  hint.textContent = t('empty.hint');
  box.append(h, p, btn, hint);
  container.appendChild(box);
}

// --- Desktop notifications (optional, for `waiting` events) ---
// A simple localStorage flag gates whether we attempt OS notifications. The OS
// permission itself is separate: a denied permission silently degrades to just
// the sidebar dot. The machine-manager settings can flip this flag.
function notificationsEnabled(): boolean {
  return localStorage.getItem('vibe-remote.notifications') !== 'off';
}

// notifyDesktop goes through the main process rather than the web Notification
// API, which fails silently in unsigned builds (see notify() in main/index.ts).
// The outcome is logged so GUI tests can observe it without stubbing anything.
// `tag` (chat sessions only) comes back on a click so the session can be
// opened; `onResult` sees whether it was shown or fell back to the Dock (d12).
function notifyDesktop(title: string, body: string, tag?: string, onResult?: (result: 'shown' | 'fallback') => void) {
  void window.vibeRemote.notify(title, body, tag)
    .then((result) => {
      console.debug(`[notify] ${result}: ${title}`);
      onResult?.(result);
    })
    .catch((e) => console.warn('[notify] failed', e));
}

// showInitError replaces a blank window with the reason startup failed (most
// often machines.json: the keychain refused to decrypt a token). Built with
// textContent only — the message can contain file paths or machine names.
function showInitError(error: unknown) {
  console.error('init failed', error);
  const container = document.getElementById('terminal-container');
  if (!container) return;
  container.querySelector('.init-error')?.remove();
  const box = document.createElement('div');
  box.className = 'empty-state init-error';
  box.setAttribute('role', 'alert');
  const h = document.createElement('h1');
  h.className = 'empty-state-title';
  h.textContent = t('init.failedTitle');
  const p = document.createElement('p');
  p.className = 'empty-state-description';
  p.textContent = t('init.failedDesc', { msg: error instanceof Error ? error.message : String(error) });
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-primary';
  btn.textContent = t('init.reload');
  btn.addEventListener('click', () => location.reload());
  box.append(h, p, btn);
  container.appendChild(box);
}

const boot = () => init().catch(showInitError);

// --- Boot ---
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

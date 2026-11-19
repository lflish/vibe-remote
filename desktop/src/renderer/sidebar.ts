// sidebar.ts — the machine/session sidebar renderer, moved verbatim out of
// index.ts (T6a). It reads nothing from index.ts: state arrives through
// SidebarModel and every side effect goes back through SidebarActions, so the
// generated DOM, classes, attributes and event behavior are unchanged. The
// three-level project tree is layered on in T6b.
import type { MachineConfig, SessionInfo } from '../shared/protocol';
import type { Dot } from './chat/activity';
import { t } from './i18n';

export interface SidebarModel {
  machines: { machine: MachineConfig; key: string; online: boolean | undefined; collapsed: boolean; sessions: SessionInfo[] }[];
  activeKey: string | null;
  overviewMachineKey: string | null;
  dotOf(machineKey: string, sessionId: string): Dot;
  isOpen(viewKey: string): boolean;
  isReloading(viewKey: string): boolean;
}

export interface SidebarActions {
  open(machine: MachineConfig, session: SessionInfo): void;
  openOverview(machine: MachineConfig): void;
  // rename resolves after the server round-trip and refresh; callers clear the
  // renaming flag afterwards. The window.confirm dialogs for reload/delete stay
  // in index.ts's callbacks (reload / deleteSession).
  rename(machine: MachineConfig, session: SessionInfo, name: string): Promise<void>;
  setRenaming(active: boolean): void;
  reload(machine: MachineConfig, session: SessionInfo): void;
  deleteSession(machine: MachineConfig, session: SessionInfo): void;
  toggleMachine(machineKey: string): void;
}

const viewKey = (machineKey: string, sid: string) => `${machineKey}::${sid}`;

export function rendererIcon(name: 'machine' | 'terminal' | 'chat' | 'branch' | 'chevron' | 'reload' | 'close'): SVGSVGElement {
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

export function renderSidebar(container: HTMLElement, model: SidebarModel, actions: SidebarActions): void {
  container.textContent = '';

  for (const m of model.machines) {
    const machine = m.machine;
    const group = document.createElement('div');
    group.className = 'machine-group';

    const sessions = m.sessions;
    const collapsed = m.collapsed;
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
      actions.toggleMachine(m.key);
    });
    const nameRow = document.createElement('button');
    nameRow.type = 'button';
    const mKey = m.key;
    const machineState = m.online;
    const isOverview = mKey === model.overviewMachineKey;
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
      actions.openOverview(machine);
    });

    const list = document.createElement('div');
    list.className = 'session-list';
    list.hidden = collapsed;

    for (const s of sessions) {
      const key = viewKey(m.key, s.id);
      const item = document.createElement('div');
      item.className = 'session-item' + (key === model.activeKey ? ' active' : '');
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
      // open sessions switch instantly (open is an idempotent setActive, no
      // side effects), keeping the primary interaction zero-latency.
      let openTimer: number | undefined;
      label.addEventListener('click', () => {
        if (model.isOpen(key)) {
          actions.open(machine, s); // already open: instant, no delay
        } else {
          window.clearTimeout(openTimer);
          openTimer = window.setTimeout(() => actions.open(machine, s), 220);
        }
      });
      label.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        window.clearTimeout(openTimer); // cancel any pending open for this label
        startInlineRename(machine, s, label, actions);
      });

      const dot = document.createElement('span');
      dot.className = 'session-unread';
      dot.setAttribute('aria-hidden', 'true');
      const act = model.dotOf(m.key, s.id);
      if (act === 'none' || key === model.activeKey) {
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
      if (model.isReloading(key)) {
        reload.disabled = true;
        reload.setAttribute('aria-busy', 'true');
      }
      reload.addEventListener('click', (e) => {
        e.stopPropagation();
        actions.reload(machine, s);
      });

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'session-action session-close';
      close.appendChild(rendererIcon('close'));
      close.title = t('session.deleteTitle');
      close.setAttribute('aria-label', t('a11y.actionTarget', { action: t('session.deleteTitle'), target: s.title || s.id }));
      // Deleting truly kills the remote tmux + claude; the current screen is
      // lost and unrecoverable. Confirm first (in index.ts's deleteSession
      // callback), showing the session's display name so a mis-hover on the
      // wrong row is caught before the DELETE fires.
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        actions.deleteSession(machine, s);
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
// falls back to the default title). After commit the caller refreshes from the
// server so the authoritative title is shown (keeps multi-client views in sync).
export function startInlineRename(machine: MachineConfig, s: SessionInfo, label: HTMLElement, actions: SidebarActions): void {
  const input = document.createElement('input');
  input.className = 'session-rename-input';
  input.value = s.title || '';
  label.replaceWith(input);
  actions.setRenaming(true); // pause sidebar rebuilds while editing
  input.focus();
  input.select();

  let done = false;
  const commit = async () => {
    if (done) return;
    // If the input is no longer in the document, this blur came from the DOM
    // being torn down (not a deliberate user focus change) — treat as cancel,
    // never commit half-typed text.
    if (!document.body.contains(input)) { done = true; actions.setRenaming(false); return; }
    done = true;
    const name = input.value.trim();
    await actions.rename(machine, s, name);
    actions.setRenaming(false);
  };
  const cancel = () => {
    if (done) return;
    done = true;
    actions.setRenaming(false);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', commit);
}

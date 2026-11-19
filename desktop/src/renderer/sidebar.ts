// sidebar.ts — the three-level machine → project → worktree → session sidebar
// (design 7.4). It reads nothing from index.ts: state arrives through
// SidebarModel and every side effect goes back through SidebarActions. No colors
// live here — the project tag's hue is set as the custom property --tag-hue and
// styled in CSS (design 7.5).
import type { MachineConfig, SessionInfo } from '../shared/protocol';
import type { Dot } from './chat/activity';
import { t } from './i18n';
import { projectHue, projectRollup, type Capability, type TreeProject, type TreeSession, type TreeWorktree } from './tree';
import { openMenu } from './menu';

export interface SidebarMachine {
  machine: MachineConfig;
  key: string;
  online: boolean | undefined;
  collapsed: boolean;
  cap: Capability;
  tree: TreeProject[];
}

export interface SidebarModel {
  machines: SidebarMachine[];
  activeKey: string | null;
  overviewMachineKey: string | null;
  collapsedProjects: Set<string>;
  dotOf(machineKey: string, sessionId: string): Dot;
  isOpen(viewKey: string): boolean;
  isReloading(viewKey: string): boolean;
}

export interface SidebarActions {
  open(machine: MachineConfig, session: SessionInfo): void;
  openOverview(machine: MachineConfig): void;
  rename(machine: MachineConfig, session: SessionInfo, name: string): Promise<void>;
  setRenaming(active: boolean): void;
  reload(machine: MachineConfig, session: SessionInfo): void;
  deleteSession(machine: MachineConfig, session: SessionInfo): void;
  toggleMachine(machineKey: string): void;
  toggleProject(machineKey: string, projectId: string): void;
  removeProject(machine: MachineConfig, project: TreeProject): void;
  // Optional callbacks wired in later tasks (T11/T9/T14); when absent the
  // corresponding button or menu item is not rendered.
  newSession?(machine: MachineConfig, project: TreeProject, worktree: TreeWorktree): void;
  newWorktree?(machine: MachineConfig, project: TreeProject): void;
  deleteWorktree?(machine: MachineConfig, project: TreeProject, worktree: TreeWorktree): void;
}

const viewKey = (machineKey: string, sid: string) => `${machineKey}::${sid}`;

export function rendererIcon(name: 'machine' | 'terminal' | 'chat' | 'branch' | 'chevron' | 'reload' | 'close' | 'plus' | 'more'): SVGSVGElement {
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
    plus: 'M10 4.5v11M4.5 10h11',
    more: 'M5 10h.01M10 10h.01M15 10h.01',
  };
  path.setAttribute('d', paths[name]);
  svg.appendChild(path);
  return svg;
}

function countSessions(project: TreeProject): number {
  let n = project.sessions.length;
  for (const w of project.worktrees) n += w.sessions.length;
  return n;
}

function stateLabel(dot: Dot): string {
  if (dot === 'output') return t('sidebar.session.state.output');
  if (dot === 'idle') return t('sidebar.session.state.idle');
  if (dot === 'waiting') return t('sidebar.session.state.waiting');
  return '';
}

export function renderSidebar(container: HTMLElement, model: SidebarModel, actions: SidebarActions): void {
  container.textContent = '';

  for (const m of model.machines) {
    const machine = m.machine;
    const group = document.createElement('div');
    group.className = 'machine-group';

    const total = m.tree.reduce((sum, p) => sum + countSessions(p), 0);
    const collapsed = m.collapsed;
    const groupHeader = document.createElement('div');
    groupHeader.className = 'machine-group-header';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'machine-toggle';
    toggle.appendChild(rendererIcon('chevron'));
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', t('a11y.actionTarget', { action: collapsed ? t('sidebar.expand') : t('sidebar.collapse'), target: machine.name }));
    toggle.disabled = total === 0;
    toggle.addEventListener('click', () => {
      actions.toggleMachine(m.key);
    });
    const nameRow = document.createElement('button');
    nameRow.type = 'button';
    const machineState = m.online;
    const isOverview = m.key === model.overviewMachineKey;
    nameRow.className = 'machine-name' + (isOverview ? ' selected' : '');
    if (isOverview) nameRow.setAttribute('aria-current', 'page');
    nameRow.setAttribute('aria-label', `${machine.name} · ${machineState === true ? t('workspace.connected') : machineState === false ? t('workspace.offline') : t('status.connecting')}`);
    const nameSpan = document.createElement('span');
    nameSpan.className = 'machine-name-label';
    nameSpan.textContent = machine.name;
    const machineIcon = document.createElement('span');
    machineIcon.className = `machine-kind-icon ${machineState === true ? 'connected' : machineState === false ? 'error' : 'checking'}`;
    machineIcon.appendChild(rendererIcon('machine'));
    // "Connected" / "Offline" in words next to the name; nothing while checking.
    const stateText = document.createElement('span');
    stateText.className = 'machine-state';
    stateText.dataset.testid = 'machine-state';
    stateText.dataset.state = machineState === true ? 'connected' : machineState === false ? 'offline' : 'checking';
    stateText.textContent = machineState === true ? t('workspace.connected') : machineState === false ? t('workspace.offline') : '';
    stateText.setAttribute('aria-hidden', 'true'); // the row's aria-label already says it
    const sessionCount = document.createElement('span');
    sessionCount.className = 'machine-session-count';
    sessionCount.textContent = String(total);
    sessionCount.setAttribute('aria-hidden', 'true');
    nameRow.append(machineIcon, nameSpan, stateText, sessionCount);
    nameRow.addEventListener('click', () => {
      actions.openOverview(machine);
    });
    groupHeader.append(toggle, nameRow);
    group.appendChild(groupHeader);

    // Old daemons cannot create / delete worktrees or list sessionless ones.
    if (m.cap === 'legacy') {
      const note = document.createElement('div');
      note.className = 'machine-note';
      note.dataset.testid = 'machine-legacy-note';
      note.textContent = t('sidebar.legacy.note');
      group.appendChild(note);
    }

    const list = document.createElement('div');
    list.className = 'session-list';
    list.hidden = collapsed;
    for (const project of m.tree) renderProject(list, m, project, model, actions);
    group.appendChild(list);
    container.appendChild(group);
  }
}

function renderProject(list: HTMLElement, m: SidebarMachine, project: TreeProject, model: SidebarModel, actions: SidebarActions): void {
  const pg = document.createElement('div');
  pg.className = 'project-group';
  pg.dataset.projectId = project.id;
  const projectCollapsed = model.collapsedProjects.has(`${m.key}|${project.id}`);

  const row = document.createElement('div');
  row.className = 'project-row';
  row.dataset.testid = 'project-row';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'project-toggle';
  toggle.appendChild(rendererIcon('chevron'));
  toggle.setAttribute('aria-expanded', String(!projectCollapsed));
  toggle.addEventListener('click', () => actions.toggleProject(m.key, project.id));

  const tag = document.createElement('span');
  tag.className = 'project-tag';
  tag.textContent = project.name.slice(0, 2).toUpperCase();
  tag.style.setProperty('--tag-hue', String(projectHue(project.id)));

  const name = document.createElement('span');
  name.className = 'project-name';
  name.textContent = project.name;

  row.append(toggle, tag, name);

  if (project.flat && project.git && project.branchLabel) {
    const branch = document.createElement('span');
    branch.className = 'project-branch';
    branch.dataset.testid = 'project-branch';
    branch.textContent = project.branchLabel;
    row.appendChild(branch);
  }

  if (project.error) {
    const status = document.createElement('span');
    status.className = 'project-status';
    status.dataset.testid = 'project-error';
    status.textContent = project.error.code === 'repo_missing'
      ? t('sidebar.project.repoMissing')
      : t('sidebar.project.readFailed', { msg: project.error.message });
    row.appendChild(status);
  }

  if (projectCollapsed && projectRollup(project, (id) => model.dotOf(m.key, id)) === 'waiting') {
    const dot = document.createElement('span');
    dot.className = 'session-unread waiting';
    dot.dataset.testid = 'project-dot';
    dot.setAttribute('aria-hidden', 'true');
    row.appendChild(dot);
  }

  const rowActions = document.createElement('div');
  rowActions.className = 'row-actions';
  const hasMain = project.worktrees.some((w) => w.main);
  const upgradeTitle = m.cap !== 'v4' ? t('sidebar.legacy.needUpgrade') : '';

  if (project.flat && !project.error && actions.newSession) {
    const btn = iconButton('project-new-session', 'plus', t('sidebar.project.newSession'));
    // A git flat project's one worktree, or a synthetic node for a non-git one.
    const wt: TreeWorktree = project.git && project.worktrees[0]
      ? project.worktrees[0]
      : { path: project.id, label: project.name, detached: false, main: true, managed: false, sessions: [] };
    btn.addEventListener('click', (e) => { e.stopPropagation(); actions.newSession!(m.machine, project, wt); });
    rowActions.appendChild(btn);
  }

  if (project.git && actions.newWorktree) {
    const btn = iconButton('project-new-worktree', 'branch', t('sidebar.project.newWorktree'));
    if (m.cap !== 'v4' || !hasMain) {
      btn.disabled = true;
      if (upgradeTitle) btn.title = upgradeTitle;
    }
    btn.addEventListener('click', (e) => { e.stopPropagation(); actions.newWorktree!(m.machine, project); });
    rowActions.appendChild(btn);
  }

  if (project.git) {
    const btn = iconButton('project-menu', 'more', t('sidebar.project.more'));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const hasSessions = countSessions(project) > 0;
      openMenu(btn, [{
        label: t('sidebar.project.remove'),
        testid: 'project-remove',
        disabled: hasSessions,
        note: hasSessions ? t('sidebar.project.removeBlocked') : undefined,
        onClick: () => actions.removeProject(m.machine, project),
      }]);
    });
    rowActions.appendChild(btn);
  }
  row.appendChild(rowActions);
  pg.appendChild(row);

  if (!projectCollapsed) {
    if (project.flat) {
      const flatSessions = project.worktrees.flatMap((w) => w.sessions);
      for (const s of flatSessions) renderSession(pg, m, s, model, actions);
      for (const s of project.sessions) renderSession(pg, m, s, model, actions);
    } else {
      for (const wt of project.worktrees) renderWorktree(pg, m, project, wt, model, actions);
      for (const s of project.sessions) renderSession(pg, m, s, model, actions);
    }
  }
  list.appendChild(pg);
}

function renderWorktree(pg: HTMLElement, m: SidebarMachine, project: TreeProject, wt: TreeWorktree, model: SidebarModel, actions: SidebarActions): void {
  const wg = document.createElement('div');
  wg.className = 'worktree-group';
  wg.dataset.path = wt.path;

  const row = document.createElement('div');
  row.className = 'worktree-row';
  row.dataset.testid = 'worktree-row';

  const label = document.createElement('span');
  label.className = 'worktree-label';
  label.textContent = wt.label;
  row.appendChild(label);

  if (wt.main) {
    row.appendChild(worktreeTag('worktree-tag-main', t('sidebar.worktree.main')));
  } else if (!wt.managed) {
    const tag = worktreeTag('worktree-tag-external', t('sidebar.worktree.external'));
    tag.title = t('sidebar.worktree.externalTitle');
    row.appendChild(tag);
  }

  const rowActions = document.createElement('div');
  rowActions.className = 'row-actions';
  if (actions.newSession) {
    const btn = iconButton('worktree-new-session', 'plus', t('sidebar.project.newSession'));
    btn.addEventListener('click', (e) => { e.stopPropagation(); actions.newSession!(m.machine, project, wt); });
    rowActions.appendChild(btn);
  }
  if (!wt.main && actions.deleteWorktree) {
    const btn = iconButton('worktree-menu', 'more', t('sidebar.project.more'));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenu(btn, [{
        label: t('sidebar.worktree.delete'),
        testid: 'worktree-delete',
        disabled: m.cap !== 'v4',
        note: m.cap !== 'v4' ? t('sidebar.legacy.needUpgrade') : undefined,
        onClick: () => actions.deleteWorktree!(m.machine, project, wt),
      }]);
    });
    rowActions.appendChild(btn);
  }
  row.appendChild(rowActions);
  wg.appendChild(row);

  if (wt.sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'worktree-empty';
    empty.dataset.testid = 'worktree-empty';
    const none = document.createElement('span');
    none.className = 'worktree-empty-text';
    none.textContent = t('sidebar.worktree.empty');
    empty.appendChild(none);
    if (actions.newSession) {
      const start = document.createElement('button');
      start.type = 'button';
      start.className = 'worktree-empty-action';
      start.dataset.testid = 'worktree-empty-new-session';
      start.textContent = t('sidebar.project.newSession');
      start.addEventListener('click', (e) => { e.stopPropagation(); actions.newSession!(m.machine, project, wt); });
      empty.appendChild(start);
    }
    wg.appendChild(empty);
  }
  for (const s of wt.sessions) renderSession(wg, m, s, model, actions);
  pg.appendChild(wg);
}

function renderSession(parent: HTMLElement, m: SidebarMachine, s: TreeSession, model: SidebarModel, actions: SidebarActions): void {
  const machine = m.machine;
  const info = s.info;
  const key = viewKey(m.key, s.id);
  const item = document.createElement('div');
  item.className = 'session-item' + (key === model.activeKey ? ' active' : '');
  item.dataset.testid = 'session-row';
  item.dataset.sessionId = s.id;
  item.dataset.ui = info.ui ?? 'terminal';

  const label = document.createElement('button');
  label.type = 'button';
  label.className = 'session-label';
  const sessionIcon = document.createElement('span');
  sessionIcon.className = 'session-kind-icon';
  sessionIcon.appendChild(rendererIcon(info.ui === 'chat' ? 'chat' : 'terminal'));
  const sessionText = document.createElement('span');
  sessionText.className = 'session-label-text';
  sessionText.textContent = s.name;
  label.append(sessionIcon, sessionText);
  if (info.ui === 'chat') {
    const badge = document.createElement('span');
    badge.className = 'session-ui-badge';
    badge.textContent = t('chat.badge');
    label.appendChild(badge);
  }
  label.title = info.workdir || s.id;
  let openTimer: number | undefined;
  label.addEventListener('click', () => {
    if (model.isOpen(key)) {
      actions.open(machine, info);
    } else {
      window.clearTimeout(openTimer);
      openTimer = window.setTimeout(() => actions.open(machine, info), 220);
    }
  });
  label.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    window.clearTimeout(openTimer);
    startInlineRename(machine, info, label, actions);
  });

  const act = model.dotOf(m.key, s.id);

  const meta = document.createElement('div');
  meta.className = 'session-meta';
  if (s.gone) {
    const gone = document.createElement('span');
    gone.dataset.testid = 'session-gone';
    gone.textContent = t('sidebar.session.gone');
    meta.appendChild(gone);
  } else {
    const kind = document.createElement('span');
    kind.textContent = info.ui === 'chat' ? t('sidebar.session.kind.chat') : t('sidebar.session.kind.terminal');
    meta.appendChild(kind);
    if (act !== 'none' && key !== model.activeKey) {
      const state = document.createElement('span');
      state.textContent = ` · ${stateLabel(act)}`;
      meta.appendChild(state);
    }
  }

  const dot = document.createElement('span');
  dot.className = 'session-unread';
  dot.setAttribute('aria-hidden', 'true');
  if (act === 'none' || key === model.activeKey) {
    dot.classList.add('hidden');
    item.dataset.dot = 'none';
  } else {
    dot.classList.add(act);
    item.dataset.dot = act;
  }

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'session-action session-reload';
  reload.appendChild(rendererIcon('reload'));
  reload.title = t('session.reloadTitle');
  reload.setAttribute('aria-label', t('a11y.actionTarget', { action: t('session.reloadTitle'), target: s.name }));
  if (model.isReloading(key)) {
    reload.disabled = true;
    reload.setAttribute('aria-busy', 'true');
  }
  reload.addEventListener('click', (e) => {
    e.stopPropagation();
    actions.reload(machine, info);
  });

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'session-action session-close';
  close.appendChild(rendererIcon('close'));
  close.title = t('session.deleteTitle');
  close.setAttribute('aria-label', t('a11y.actionTarget', { action: t('session.deleteTitle'), target: s.name }));
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    actions.deleteSession(machine, info);
  });

  item.append(label, meta, dot, reload, close);
  parent.appendChild(item);
}

function iconButton(testid: string, icon: Parameters<typeof rendererIcon>[0], title: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'row-action';
  btn.dataset.testid = testid;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.appendChild(rendererIcon(icon));
  return btn;
}

function worktreeTag(testid: string, text: string): HTMLSpanElement {
  const tag = document.createElement('span');
  tag.className = 'worktree-tag';
  tag.dataset.testid = testid;
  tag.textContent = text;
  return tag;
}

// renderToolbarTitle fills #toolbar-title with project / branch · session parts
// (design 7.4). With no open session it shows the fallback (the machine name).
// `hue` (the project's tag hue) and `ui` (the session kind) are decoration: the
// same two-letter tag as the sidebar before the project, the kind glyph before
// the session name.
export function renderToolbarTitle(
  container: HTMLElement,
  ctx: { project: string; branch?: string; name: string; hue?: number; ui?: 'terminal' | 'chat' } | null,
  fallback: string,
): void {
  container.textContent = '';
  if (!ctx) {
    container.appendChild(document.createTextNode(fallback));
    return;
  }
  if (ctx.hue !== undefined) {
    const tag = document.createElement('span');
    tag.className = 'project-tag';
    tag.textContent = ctx.project.slice(0, 2).toUpperCase();
    tag.style.setProperty('--tag-hue', String(ctx.hue));
    tag.setAttribute('aria-hidden', 'true');
    container.appendChild(tag);
  }
  const project = document.createElement('span');
  project.dataset.testid = 'title-project';
  project.textContent = ctx.project;
  container.appendChild(project);
  if (ctx.branch) {
    container.appendChild(document.createTextNode(' / '));
    const branch = document.createElement('span');
    branch.dataset.testid = 'title-branch';
    branch.textContent = ctx.branch;
    container.appendChild(branch);
  }
  container.appendChild(document.createTextNode(' · '));
  const name = document.createElement('span');
  name.dataset.testid = 'title-session';
  name.textContent = ctx.name;
  if (ctx.ui) {
    name.dataset.ui = ctx.ui;
    const icon = document.createElement('span');
    icon.className = 'session-kind-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.appendChild(rendererIcon(ctx.ui === 'chat' ? 'chat' : 'terminal'));
    name.prepend(icon);
  }
  container.appendChild(name);
}

// startInlineRename replaces a session label with an input for in-place rename.
// Enter/blur commits, Esc cancels. Empty input clears the custom name. The
// caller refreshes from the server afterwards so the authoritative title shows.
export function startInlineRename(machine: MachineConfig, s: SessionInfo, label: HTMLElement, actions: SidebarActions): void {
  const input = document.createElement('input');
  input.className = 'session-rename-input';
  input.value = s.title || '';
  label.replaceWith(input);
  actions.setRenaming(true);
  input.focus();
  input.select();

  let done = false;
  const commit = async () => {
    if (done) return;
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

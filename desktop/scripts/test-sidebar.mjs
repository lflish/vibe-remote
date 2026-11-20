// sidebar.ts: the three-level machine → project → worktree → session renderer
// (T6b). Most cases call renderSidebar directly with a hand-built model and spy
// actions; the last ones drive index.ts through loadIndex() to exercise the real
// wiring (capability persistence, collapsed-project persistence) and keep the
// T6a behavior cases.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { indexDom, load, loadIndex, runner } from './chat-test-util.mjs';

const page = await indexDom();
localStorage.setItem('vibe-remote.locale', 'zh');
const { renderSidebar, renderToolbarTitle, rendererIcon } = await load('src/renderer/sidebar.ts', { platform: 'browser' });
const { buildTree, projectHue } = await load('src/renderer/tree.ts');
const { t } = await load('src/renderer/i18n.ts', { platform: 'browser' });

const { test, run } = runner('test-sidebar');

const M = { name: 'this-mac', addr: '10.0.0.9', port: 8765, token: 't' };
const MK = '10.0.0.9:8765';
let seq = 0;
const sess = (id, over = {}) => ({ id, title: '', workdir: '', created: `2026-01-01T00:00:${String(seq++).padStart(2, '0')}Z`, mode: 'normal', ...over });

function machineEntry(tree, over = {}) {
  return { machine: M, key: MK, online: true, collapsed: false, cap: 'v4', tree, ...over };
}
function model(machines, over = {}) {
  return { machines, activeKey: null, overviewMachineKey: null, collapsedProjects: new Set(), dotOf: () => 'none', isOpen: () => false, isReloading: () => false, ...over };
}
function acts(over = {}) {
  return { open() {}, openOverview() {}, rename: async () => {}, setRenaming() {}, reload() {}, deleteSession() {}, toggleMachine() {}, toggleProject() {}, removeProject() {}, ...over };
}
function render(machines, actions = acts(), modelOver = {}) {
  const c = document.createElement('div');
  document.body.appendChild(c);
  renderSidebar(c, model(machines, modelOver), actions);
  return c;
}
const tid = (root, id) => root.querySelector(`[data-testid="${id}"]`);
const tall = (root, id) => [...root.querySelectorAll(`[data-testid="${id}"]`)];
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const menuItem = (id) => document.querySelector(`[data-testid="${id}"]`);

test('renders_three_levels', () => {
  const projects = [{
    id: '/r/devflow', name: 'devflow', git: true, worktrees: [
      { path: '/r/devflow', branch: 'main', head: 'a1b2c3d', main: true, sessions: ['s1'] },
      { path: '/r/devflow-worktrees/fix-login', branch: 'fix-login', head: '9f8e7d6', managed: true, sessions: ['s2'] },
    ], sessions: [],
  }];
  // R1.1: a chat session in the main directory, a terminal session in the other worktree.
  const tree = buildTree([sess('s1', { workdir: '/r/devflow', ui: 'chat', state: 'idle' }), sess('s2', { workdir: '/r/devflow-worktrees/fix-login' })], projects);
  const c = render([machineEntry(tree)]);
  assert.equal(tall(c, 'worktree-row').length, 2);
  const groups = [...c.querySelectorAll('.worktree-group')];
  assert.equal(groups.length, 2);
  for (const g of groups) {
    const rows = [...g.querySelectorAll('[data-testid="session-row"]')];
    assert.equal(rows.length, 1);
    assert.ok(rows[0].dataset.ui);
    assert.ok('dot' in rows[0].dataset);
  }
  // Each row sits under its own worktree and carries the icon of its kind.
  const rowOf = (id) => c.querySelector(`[data-testid="session-row"][data-session-id="${id}"]`);
  const icon = (id) => rowOf(id).querySelector('.session-label > .session-kind-icon svg path');
  assert.equal(rowOf('s1').closest('.worktree-group').dataset.path, '/r/devflow');
  assert.equal(rowOf('s2').closest('.worktree-group').dataset.path, '/r/devflow-worktrees/fix-login');
  assert.equal(rowOf('s1').dataset.ui, 'chat');
  assert.equal(rowOf('s2').dataset.ui, 'terminal');
  assert.ok(icon('s1') && icon('s2'), 'both rows have a kind icon');
  assert.equal(rowOf('s1').querySelectorAll('.session-kind-icon').length, 1, 'one icon per row');
  assert.equal(rowOf('s2').querySelectorAll('.session-kind-icon').length, 1);
  const shape = (name) => rendererIcon(name).querySelector('path').getAttribute('d');
  assert.notEqual(shape('chat'), shape('terminal'), 'the two kinds are drawn differently');
  assert.equal(icon('s1').getAttribute('d'), shape('chat'), 'the chat session shows the chat glyph');
  assert.equal(icon('s2').getAttribute('d'), shape('terminal'), 'the terminal session shows the terminal glyph');
  // In words as well: the badge and the kind line under the name.
  assert.equal(rowOf('s1').querySelector('.session-ui-badge').textContent, t('chat.badge'));
  assert.equal(rowOf('s2').querySelector('.session-ui-badge'), null);
  assert.equal(rowOf('s1').querySelector('.session-meta').textContent, t('sidebar.session.kind.chat'));
  assert.equal(rowOf('s2').querySelector('.session-meta').textContent, t('sidebar.session.kind.terminal'));
  // A session with no `ui` (an older daemon) is a terminal session.
  assert.equal(icon('s2').getAttribute('d'), rendererIcon('terminal').querySelector('path').getAttribute('d'));
});

// R1.5 on the screen: three projects, eight sessions. The rows are read back
// from the DOM, top to bottom, and compared with the order written out here.
test('rows_are_drawn_in_the_daemons_order', () => {
  const at = (n) => `2026-03-01T10:00:${String(n).padStart(2, '0')}Z`;
  const projects = [
    { id: '/r/alpha', name: 'alpha', git: true, sessions: [], worktrees: [
      { path: '/r/alpha', branch: 'main', head: 'a000001', main: true, sessions: ['z9', 'y8'] },
      { path: '/r/alpha-worktrees/fix', branch: 'fix', head: 'a000002', managed: true, sessions: ['x7', 'w6'] },
      { path: '/r/alpha-worktrees/zeta', branch: 'zeta', head: 'a000003', managed: true, sessions: ['v5'] },
    ] },
    { id: '/r/Beta', name: 'Beta', git: true, sessions: [], worktrees: [{ path: '/r/Beta', branch: 'dev', head: 'b000001', main: true, sessions: ['u4'] }] },
    { id: '/r/gamma', name: 'gamma', git: true, sessions: [], worktrees: [
      { path: '/r/gamma', branch: 'main', head: 'c000001', main: true, sessions: ['t3'] },
      { path: '/r/gamma-worktrees/b', branch: 'b', head: 'c000002', managed: true, sessions: ['s2'] },
    ] },
  ];
  const list = [
    ['z9', '/r/alpha', 1], ['y8', '/r/alpha', 2], ['x7', '/r/alpha-worktrees/fix', 3], ['w6', '/r/alpha-worktrees/fix', 4],
    ['v5', '/r/alpha-worktrees/zeta', 5], ['u4', '/r/Beta', 6], ['t3', '/r/gamma', 7], ['s2', '/r/gamma-worktrees/b', 8],
  ].map(([id, workdir, n]) => ({ id, title: '', workdir, created: at(n), mode: 'normal' }));
  const expected = [
    'project alpha', 'worktree main', 'session z9 alpha', 'session y8 alpha 2', 'worktree fix', 'session x7 fix', 'session w6 fix 2',
    'worktree zeta', 'session v5 zeta',
    'project Beta', 'session u4 Beta',
    'project gamma', 'worktree main', 'session t3 gamma', 'worktree b', 'session s2 b',
  ];
  const drawn = (c) => [...c.querySelectorAll('[data-testid="project-row"], [data-testid="worktree-row"], [data-testid="session-row"]')].map((row) => {
    if (row.dataset.testid === 'project-row') return `project ${row.querySelector('.project-name').textContent}`;
    if (row.dataset.testid === 'worktree-row') return `worktree ${row.querySelector('.worktree-label').textContent}`;
    return `session ${row.dataset.sessionId} ${row.querySelector('.session-label-text').textContent}`;
  });
  assert.deepEqual(drawn(render([machineEntry(buildTree(list, projects))])), expected);
  // The same whatever order the session list arrives in, forty times over.
  let seed = 3;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 40; i++) {
    const shuffled = list.map((x) => [rand(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    assert.deepEqual(drawn(render([machineEntry(buildTree(shuffled, projects))])), expected, `sessions listed as ${shuffled.map((x) => x.id).join(',')}`);
  }
});

test('flat_project_has_no_worktree_row', () => {
  const projects = [{ id: '/r/new-api', name: 'new-api', git: true, worktrees: [{ path: '/r/new-api', branch: 'dev', head: 'abc1234', main: true, sessions: ['a', 'b'] }], sessions: [] }];
  const tree = buildTree([sess('a', { workdir: '/r/new-api' }), sess('b', { workdir: '/r/new-api' })], projects);
  const c = render([machineEntry(tree)]);
  assert.equal(tall(c, 'worktree-row').length, 0);
  assert.equal(tid(c, 'project-branch').textContent, 'dev');
});

test('single_worktree_that_is_not_main_has_a_row_and_a_menu', () => {
  // The main directory is outside the allowed roots: only the other worktree is listed (R2.6).
  const projects = [{ id: '/outside/repo', name: 'repo', git: true, worktrees: [{ path: '/r/repo-wt/a', branch: 'a', head: 'abc1234', managed: true, sessions: ['s'] }], sessions: [] }];
  const tree = buildTree([sess('s', { workdir: '/r/repo-wt/a' })], projects);
  const deleted = [];
  const c = render([machineEntry(tree)], acts({ newWorktree() {}, newSession() {}, deleteWorktree: (m, p, wt) => deleted.push(wt.path) }));
  const rows = tall(c, 'worktree-row');
  assert.equal(rows.length, 1, 'the worktree has its own row');
  assert.equal(rows[0].querySelector('.worktree-label').textContent, 'a');
  assert.equal(tid(c, 'project-branch'), null);
  assert.equal(tid(c, 'project-new-session'), null, 'the project row offers no session of its own: its directory is not listed');
  click(rows[0].querySelector('[data-testid="worktree-menu"]'));
  const del = menuItem('worktree-delete');
  assert.ok(del && !del.disabled, 'the worktree can be deleted from its menu');
  click(del);
  assert.deepEqual(deleted, ['/r/repo-wt/a']);
  // "New worktree" starts from the main directory, which this daemon may not use: say so.
  const nw = tid(c, 'project-new-worktree');
  assert.equal(nw.disabled, true);
  assert.equal(nw.title, t('sidebar.project.noMain'));
  assert.notEqual(t('sidebar.project.noMain'), 'sidebar.project.noMain', 'the text exists');
  assert.equal(nw.getAttribute('aria-label'), t('sidebar.project.noMain'));
});

test('non_git_has_no_worktree_entries', () => {
  const tree = buildTree([sess('n1', { workdir: '/tmp/notes' })], [{ id: '/tmp/notes', name: 'notes', git: false, worktrees: [], sessions: ['n1'] }]);
  const c = render([machineEntry(tree)], acts({ newWorktree() {}, newSession() {} }));
  assert.equal(tid(c, 'project-branch'), null);
  assert.equal(tid(c, 'project-new-worktree'), null);
  assert.equal(tid(c, 'project-menu'), null);
});

test('empty_worktree_row', () => {
  const projects = [{
    id: '/r/devflow', name: 'devflow', git: true, worktrees: [
      { path: '/r/devflow', branch: 'main', head: 'a1b2c3d', main: true, sessions: ['s1'] },
      { path: '/r/devflow/.devflow-tmp/worktrees/general-skills', branch: 'change/general-skills', head: '0c1d2e3', sessions: [] },
    ], sessions: [],
  }];
  const tree = buildTree([sess('s1', { workdir: '/r/devflow' })], projects);
  const asked = [];
  const c = render([machineEntry(tree)], acts({ newSession(_m, _p, wt) { asked.push(wt.path); } }));
  const empty = tid(c, 'worktree-empty');
  assert.ok(empty);
  // The row reads "no sessions" and offers to start one right there (M1).
  assert.equal(empty.querySelector('.worktree-empty-text').textContent, t('sidebar.worktree.empty'));
  const start = tid(empty, 'worktree-empty-new-session');
  assert.ok(start, 'an empty worktree offers "new session" in the row itself');
  assert.equal(start.textContent, t('sidebar.project.newSession'));
  click(start);
  assert.deepEqual(asked, ['/r/devflow/.devflow-tmp/worktrees/general-skills']);
  assert.ok(tid(c, 'worktree-tag-external'));
  assert.ok(tid(c, 'worktree-new-session'));
  // Without the callback there is nothing to offer.
  const plain = render([machineEntry(tree)]);
  assert.equal(tid(plain, 'worktree-empty').querySelector('.worktree-empty-text').textContent, t('sidebar.worktree.empty'));
  assert.equal(tid(plain, 'worktree-empty-new-session'), null);
});

test('machine_row_shows_connection_state', () => {
  const tree = buildTree([sess('m1', { workdir: '/r/notes' })], [{ id: '/r/notes', name: 'notes', git: false, worktrees: [], sessions: ['m1'] }]);
  const state = (online) => tid(render([machineEntry(tree, { online })]), 'machine-state');
  assert.equal(state(true).textContent, t('workspace.connected'));
  assert.equal(state(true).dataset.state, 'connected');
  assert.equal(state(false).textContent, t('workspace.offline'));
  assert.equal(state(false).dataset.state, 'offline');
  // Still checking: no claim either way.
  assert.equal(state(undefined).textContent, '');
  assert.equal(state(undefined).dataset.state, 'checking');
  // The state is part of the row button, after the name and before the count.
  const row = render([machineEntry(tree, { online: true })]).querySelector('.machine-name');
  assert.deepEqual([...row.children].map((e) => e.className.split(' ')[0]), ['machine-kind-icon', 'machine-name-label', 'machine-state', 'machine-session-count']);
});

// A machine whose sessions are all gone still has its projects and worktrees
// (R2.2): the arrow has to keep working, or a folded machine can never be
// opened again (review D5).
test('collapsed_machine_without_sessions_can_expand', () => {
  const projects = [{
    id: '/r/devflow', name: 'devflow', git: true, worktrees: [
      { path: '/r/devflow', branch: 'main', head: 'a1b2c3d', main: true, sessions: [] },
      { path: '/r/devflow-worktrees/fix-login', branch: 'fix-login', head: '9f8e7d6', managed: true, sessions: [] },
    ], sessions: [],
  }];
  const tree = buildTree([], projects);
  const toggled = [];
  const c = render([machineEntry(tree, { collapsed: true })], acts({ toggleMachine: (mk) => toggled.push(mk) }));
  const toggle = c.querySelector('.machine-toggle');
  assert.equal(c.querySelector('.machine-session-count').textContent, '0', 'the count is still the number of sessions');
  assert.equal(c.querySelector('.session-list').hidden, true);
  assert.equal(tall(c, 'project-row').length, 1, 'the project is there, folded away');
  assert.equal(toggle.disabled, false, 'the arrow works: there are projects to show');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  click(toggle);
  assert.deepEqual(toggled, [MK]);
  // Nothing at all under the machine: nothing to unfold.
  const empty = render([machineEntry([], { collapsed: false })]);
  assert.equal(empty.querySelector('.machine-toggle').disabled, true);
});

test('gone_session_meta', () => {
  const projects = [{ id: '/r/g', name: 'g', git: true, worktrees: [{ path: '/r/g', branch: 'main', head: 'aaaaaaa', main: true, sessions: ['live'] }], sessions: ['go'] }];
  const tree = buildTree([sess('live', { workdir: '/r/g' }), sess('go', { workdir: '/gone' })], projects);
  const c = render([machineEntry(tree)]);
  const gone = tid(c, 'session-gone');
  assert.ok(gone);
  assert.equal(gone.textContent, t('sidebar.session.gone'));
});

test('project_error_row_sessions_usable', () => {
  const failed = buildTree([sess('e1', {})], [{ id: '/r/e', name: 'e', git: true, error: 'git_failed', errorMessage: 'boom', worktrees: [], sessions: ['e1'] }]);
  const opened = [];
  const c = render([machineEntry(failed)], acts({ open: (m, s) => opened.push(s) }), { isOpen: () => true });
  assert.equal(tid(c, 'project-error').textContent, t('sidebar.project.readFailed', { msg: 'boom' }));
  const row = tid(c, 'session-row');
  assert.ok(row);
  click(row.querySelector('.session-label'));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].id, 'e1');

  const missing = buildTree([sess('m1', {})], [{ id: '/r/m', name: 'm', git: true, error: 'repo_missing', worktrees: [], sessions: ['m1'] }]);
  const c2 = render([machineEntry(missing)]);
  assert.equal(tid(c2, 'project-error').textContent, t('sidebar.project.repoMissing'));
});

test('collapsed_project_shows_waiting_dot', () => {
  const projects = [{ id: '/r/w', name: 'w', git: true, worktrees: [{ path: '/r/w', branch: 'main', head: 'x', main: true, sessions: ['s'] }], sessions: [] }];
  const tree = buildTree([sess('s', { workdir: '/r/w' })], projects);
  const dotOf = () => 'waiting';
  const folded = new Set([`${MK}|/r/w`]);
  const collapsed = render([machineEntry(tree)], acts(), { collapsedProjects: folded, dotOf });
  assert.ok(tid(collapsed, 'project-dot'));
  assert.equal(tid(collapsed, 'session-row'), null, 'collapsed hides sessions');
  // It is the "needs you" dot, the same one the session row shows (R1.6) —
  // not the "turn finished" or "new output" one, and not a hidden one.
  const classes = (el) => [...el.classList].sort();
  assert.deepEqual(classes(tid(collapsed, 'project-dot')), ['session-unread', 'waiting']);

  const expanded = render([machineEntry(tree)], acts(), { dotOf });
  assert.equal(tid(expanded, 'project-dot'), null);
  assert.equal(tid(expanded, 'session-row').dataset.dot, 'waiting');
  assert.deepEqual(classes(tid(expanded, 'session-row').querySelector('.session-unread')), classes(tid(collapsed, 'project-dot')), 'folded and unfolded show the same dot');

  // Only "needs you" is rolled up: a folded project whose sessions merely
  // finished a turn or printed something shows no dot at all.
  for (const state of ['idle', 'output', 'none']) {
    const quiet = render([machineEntry(tree)], acts(), { collapsedProjects: folded, dotOf: () => state });
    assert.equal(tid(quiet, 'project-dot'), null, `no project dot for ${state}`);
    assert.equal(tid(quiet, 'project-row').querySelector('.session-unread'), null, `no dot element at all for ${state}`);
  }
  // The session on screen needs no dot, but its project folded away still does
  // when another of its sessions is waiting.
  const two = buildTree([sess('a', { workdir: '/r/w' }), sess('b', { workdir: '/r/w' })], [{ ...projects[0], worktrees: [{ ...projects[0].worktrees[0], sessions: ['a', 'b'] }] }]);
  const mixed = render([machineEntry(two)], acts(), { collapsedProjects: folded, dotOf: (mk, id) => (id === 'b' ? 'waiting' : 'idle') });
  assert.deepEqual(classes(tid(mixed, 'project-dot')), ['session-unread', 'waiting']);
});

test('project_menu_remove', () => {
  const projects = [{ id: '/r/p', name: 'p', git: true, worktrees: [{ path: '/r/p', branch: 'main', head: 'x', main: true, sessions: [] }], sessions: [] }];
  const tree = buildTree([], projects);
  const removed = [];
  const c = render([machineEntry(tree)], acts({ removeProject: (m, project) => removed.push(project) }));
  click(tid(c, 'project-menu'));
  const remove = menuItem('project-remove');
  assert.ok(remove);
  assert.equal(remove.disabled, false);
  click(remove);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, '/r/p');
});

// jsdom has no layout: the boxes are given, the arithmetic is what is tested.
// The real geometry is measured by shell-layout.mjs in the running app.
test('row_menu_stays_inside_the_window', () => {
  const projects = [{ id: '/r/p', name: 'p', git: true, worktrees: [{ path: '/r/p', branch: 'main', head: 'x', main: true, sessions: [] }], sessions: [] }];
  const c = render([machineEntry(buildTree([], projects))]);
  const btn = tid(c, 'project-menu');
  const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
  const proto = window.HTMLElement.prototype;
  const original = proto.getBoundingClientRect;
  const sizes = { innerWidth: window.innerWidth, innerHeight: window.innerHeight };
  const place = (anchor) => {
    proto.getBoundingClientRect = function () {
      if (this === btn) return anchor;
      if (this.classList.contains('menu')) return box(parseFloat(this.style.left) || 0, parseFloat(this.style.top) || 0, 180, 42);
      return original.call(this);
    };
    click(btn);
    const menu = document.querySelector('body > .menu');
    return { top: parseFloat(menu.style.top), left: parseFloat(menu.style.left) };
  };
  try {
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true });
    // Room below: right under the button, left edges aligned.
    assert.deepEqual(place(box(60, 200, 22, 22)), { top: 222, left: 60 });
    // The last row of an 800×500 window: the menu would end at 537, below the window.
    const flipped = place(box(60, 473, 22, 22));
    assert.ok(flipped.top + 42 <= 473, `the menu opens above its button (top ${flipped.top})`);
    assert.ok(flipped.top >= 0);
    // No room on either side of the button: still inside the window.
    Object.defineProperty(window, 'innerHeight', { value: 60, configurable: true });
    const squeezed = place(box(60, 20, 22, 22));
    assert.ok(squeezed.top >= 0 && squeezed.top + 42 <= 60, `inside a 60px-high window (top ${squeezed.top})`);
    // A button at the right edge: the menu is pulled back in.
    Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true });
    const right = place(box(770, 200, 22, 22));
    assert.ok(right.left + 180 <= 800, `inside the window's width (left ${right.left})`);
  } finally {
    proto.getBoundingClientRect = original;
    Object.defineProperty(window, 'innerWidth', { value: sizes.innerWidth, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: sizes.innerHeight, configurable: true });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
});

// The sidebar is rebuilt from scratch whenever what it shows has changed (a
// poll answer that brings something new, a dot, a switch of session). The row
// buttons are visible only while their row is hovered or
// holds the focus, so a keyboard user must not lose the focus to a rebuild
// (review D9).
const DEVFLOW_TWO = [{
  id: '/r/devflow', name: 'devflow', git: true, worktrees: [
    { path: '/r/devflow', branch: 'main', head: 'a1b2c3d', main: true, sessions: ['s1'] },
    { path: '/r/devflow-worktrees/fix-login', branch: 'fix-login', head: '9f8e7d6', managed: true, sessions: ['s2'] },
    { path: '/r/devflow-worktrees/other', branch: 'other', head: '1f2e3d4', managed: true, sessions: [] },
  ], sessions: [],
}];
const twoSessions = () => [sess('s1', { workdir: '/r/devflow' }), sess('s2', { workdir: '/r/devflow-worktrees/fix-login' })];

test('focus_survives_a_rebuild', () => {
  const actions = acts({ newWorktree() {}, newSession() {}, deleteWorktree() {} });
  const second = { machine: { ...M, name: 'other-mac', port: 9000 }, key: '10.0.0.9:9000', online: true, collapsed: false, cap: 'v4', tree: buildTree(twoSessions(), DEVFLOW_TWO) };
  const build = (projects = DEVFLOW_TWO) => model([machineEntry(buildTree(twoSessions(), projects)), second]);
  const c = document.createElement('div');
  document.body.appendChild(c);
  renderSidebar(c, build(), actions);
  const group = (root, path) => [...root.querySelectorAll('.worktree-group')].find((g) => g.dataset.path === path);
  const pickers = {
    'the "new worktree" button of a project': (root) => tid(root, 'project-new-worktree'),
    'the menu button of a worktree row': (root) => tid(group(root, '/r/devflow-worktrees/fix-login'), 'worktree-menu'),
    'the "new session" button of a worktree with no session': (root) => tid(group(root, '/r/devflow-worktrees/other'), 'worktree-empty-new-session'),
    'the close button of a session': (root) => root.querySelector('.session-item[data-session-id="s2"] .session-close'),
    'a session label': (root) => root.querySelector('.session-item[data-session-id="s1"] .session-label'),
    'the arrow of a machine': (root) => root.querySelector('.machine-toggle'),
    'the same button on the second machine': (root) => tid(root.querySelectorAll('.machine-group')[1], 'project-new-worktree'),
  };
  for (const [what, pick] of Object.entries(pickers)) {
    const before = pick(c);
    before.focus();
    assert.equal(document.activeElement, before, `${what} takes the focus`);
    renderSidebar(c, build(), actions);
    assert.ok(!before.isConnected, 'the sidebar was rebuilt');
    assert.equal(document.activeElement, pick(c), `${what} still has the focus after a rebuild`);
  }
  // The focus outside the sidebar is left where it is.
  const outside = document.createElement('button');
  document.body.appendChild(outside);
  outside.focus();
  renderSidebar(c, build(), actions);
  assert.equal(document.activeElement, outside);
  // The focused row is gone after the rebuild: nothing to restore, nothing thrown.
  pickers['the menu button of a worktree row'](c).focus();
  renderSidebar(c, build([{ ...DEVFLOW_TWO[0], worktrees: [DEVFLOW_TWO[0].worktrees[0], DEVFLOW_TWO[0].worktrees[2]], sessions: ['s2'] }]), actions);
  assert.ok(!c.contains(document.activeElement) || document.activeElement === c, 'no other row received the focus');
  outside.remove();
  c.remove();
});

// A double click reaches the page as click, click (detail 2), dblclick. Opening
// a session rebuilds the sidebar, so each of them goes to the label that is
// under the pointer at that moment; a label taken out by the second click
// would leave the browser nothing to send the dblclick to (gui-worktree-smoke
// X2.rename does this with real pointer events).
test('double_click_renames_a_session_that_is_open', () => {
  const tree = buildTree([sess('n1', { workdir: '/tmp/notes', title: 'notes' })], [{ id: '/tmp/notes', name: 'notes', git: false, worktrees: [], sessions: ['n1'] }]);
  const c = document.createElement('div');
  document.body.appendChild(c);
  let opened = 0;
  let renaming = false;
  const actions = acts({ open() { opened++; draw(); }, setRenaming(v) { renaming = v; } });
  const draw = () => renderSidebar(c, model([machineEntry(tree)], { isOpen: () => true }), actions);
  draw();
  const label = () => c.querySelector('.session-label');
  label().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  assert.equal(opened, 1, 'the first click opens the session');
  const second = label();
  second.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
  assert.equal(opened, 1, 'the second click of a double click does not open it again');
  assert.equal(label(), second, 'the label the double click ends on is still in the sidebar');
  second.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
  const input = c.querySelector('.session-rename-input');
  assert.ok(input, 'the name turned into an input');
  assert.equal(input.value, 'notes');
  assert.equal(renaming, true);
  // A click that is not part of a double click (keyboard, a script: detail 0) still opens.
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  draw();
  label().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
  assert.equal(opened, 2);
  c.remove();
});

// While its menu is open the button says so (aria-expanded). The stylesheet
// keeps the row's buttons in place for as long as it does: they otherwise show
// only while the row is hovered or holds the focus, and a rebuilt row is
// neither at the moment the menu is put next to its new button
// (gui-worktree-smoke X8.menu measures that with real pointer events).
test('menu_button_is_marked_expanded_while_its_menu_is_open', async () => {
  const actions = acts({ newWorktree() {}, newSession() {}, deleteWorktree() {} });
  const build = () => model([machineEntry(buildTree(twoSessions(), DEVFLOW_TWO))]);
  const c = document.createElement('div');
  document.body.appendChild(c);
  renderSidebar(c, build(), actions);
  const menuButton = () => tid([...c.querySelectorAll('.worktree-group')].find((g) => g.dataset.path === '/r/devflow-worktrees/fix-login'), 'worktree-menu');
  const expanded = () => [...c.querySelectorAll('[aria-expanded="true"]')].filter((e) => e.dataset.testid === 'worktree-menu' || e.dataset.testid === 'project-menu');
  assert.deepEqual(expanded(), []);
  click(menuButton());
  assert.deepEqual(expanded(), [menuButton()], 'the button of the open menu');
  await new Promise((r) => setTimeout(r, 5));
  const old = menuButton();
  renderSidebar(c, build(), actions);
  assert.notEqual(menuButton(), old, 'the row was rebuilt');
  assert.deepEqual(expanded(), [menuButton()], 'the same button of the rebuilt row');
  // another menu: only its button is marked
  click(tid(c, 'project-menu'));
  assert.deepEqual(expanded(), [tid(c, 'project-menu')]);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.querySelectorAll('body > .menu').length, 0);
  assert.deepEqual(expanded(), [], 'nothing is marked once the menu is closed');
  // the rule that keeps the buttons where they are while a menu is open
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf-8');
  for (const row of ['.project-row', '.worktree-row']) {
    assert.ok(css.includes(`${row} > .row-actions:has([aria-expanded='true'])`), `styles.css keeps the buttons of ${row} shown while one of them has its menu open`);
  }
  c.remove();
});

// The menus from the keyboard: opening one moves the focus to its first item
// that can be chosen, the arrows move between the items, Esc and Tab close it
// and the focus is back on the button (gui-worktree-smoke X3.keys does the
// same with real key events).
test('row_menu_from_the_keyboard', async () => {
  const deleted = [];
  const removed = [];
  const actions = acts({ newWorktree() {}, newSession() {}, deleteWorktree: (m, p, wt) => deleted.push(wt.path), removeProject: (m, p) => removed.push(p.id) });
  const c = document.createElement('div');
  document.body.appendChild(c);
  const draw = (projects, sessions) => renderSidebar(c, model([machineEntry(buildTree(sessions, projects))]), actions);
  draw(DEVFLOW_TWO, twoSessions());
  const menuButton = () => tid([...c.querySelectorAll('.worktree-group')].find((g) => g.dataset.path === '/r/devflow-worktrees/fix-login'), 'worktree-menu');
  const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const openMenus = () => document.querySelectorAll('body > .menu').length;

  menuButton().focus();
  click(menuButton());
  assert.equal(document.activeElement, menuItem('worktree-delete'), 'opening the menu puts the focus on its item');
  key('ArrowDown');
  key('ArrowUp');
  assert.equal(document.activeElement, menuItem('worktree-delete'), 'the arrows stay inside the menu');
  key('Escape');
  assert.equal(openMenus(), 0);
  assert.equal(document.activeElement, menuButton(), 'Esc gives the focus back to the button');

  click(menuButton());
  assert.equal(document.activeElement, menuItem('worktree-delete'));
  key('Tab');
  assert.equal(openMenus(), 0, 'Tab closes the menu');
  assert.equal(document.activeElement, menuButton(), 'and the focus moves on from the button');

  // Choosing an item: the menu is closed (focus back on the button) before the action runs.
  click(menuButton());
  let focusWhenRun = null;
  actions.deleteWorktree = (m, p, wt) => { focusWhenRun = document.activeElement; deleted.push(wt.path); };
  click(menuItem('worktree-delete'));
  assert.deepEqual(deleted, ['/r/devflow-worktrees/fix-login']);
  assert.equal(openMenus(), 0);
  assert.equal(focusWhenRun, menuButton(), 'the action starts with the focus on the button, not on an item that is about to go');

  // The sidebar is rebuilt while the focus is in the menu: it stays there.
  click(menuButton());
  await new Promise((r) => setTimeout(r, 5));
  const item = menuItem('worktree-delete');
  draw(DEVFLOW_TWO, twoSessions());
  assert.equal(document.activeElement, item, 'a rebuild leaves the focus on the menu item');
  key('Escape');
  assert.equal(document.activeElement, menuButton(), 'Esc after a rebuild: the button of the rebuilt row');

  // Several items: the arrows go round, skipping what is off.
  const { openMenu } = await load('src/renderer/menu.ts', { platform: 'browser' });
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  anchor.focus();
  openMenu(anchor, [{ label: 'a', testid: 'm-a' }, { label: 'b', testid: 'm-b', disabled: true, note: 'off' }, { label: 'c', testid: 'm-c' }]);
  const order = [];
  assert.equal(document.activeElement, menuItem('m-a'));
  for (const k of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp', 'End', 'Home']) { key(k); order.push(document.activeElement.dataset.testid); }
  assert.deepEqual(order, ['m-c', 'm-a', 'm-c', 'm-a', 'm-c', 'm-a']);
  key('Escape');
  assert.equal(document.activeElement, anchor);
  // Nothing to choose: the focus stays on the button, Esc still closes.
  openMenu(anchor, [{ label: 'b', testid: 'm-b', disabled: true, note: 'off' }]);
  assert.equal(document.activeElement, anchor, 'a menu with no item to choose leaves the focus on its button');
  key('ArrowDown');
  assert.equal(document.activeElement, anchor);
  key('Escape');
  assert.equal(openMenus(), 0);
  anchor.remove();
  c.remove();
});

// A row menu that is open during a rebuild stays with its row and keeps
// working; when the row is gone the menu goes too.
test('open_menu_follows_its_row_through_a_rebuild', async () => {
  const deleted = [];
  const actions = acts({ newWorktree() {}, newSession() {}, deleteWorktree: (m, p, wt) => deleted.push(wt.path) });
  const build = (projects = DEVFLOW_TWO, over = {}) => model([machineEntry(buildTree(twoSessions(), projects), over)]);
  const c = document.createElement('div');
  document.body.appendChild(c);
  renderSidebar(c, build(), actions);
  const menuButton = () => tid([...c.querySelectorAll('.worktree-group')].find((g) => g.dataset.path === '/r/devflow-worktrees/fix-login'), 'worktree-menu');
  const openMenus = () => document.querySelectorAll('body > .menu').length;
  click(menuButton());
  assert.equal(openMenus(), 1);
  const item = menuItem('worktree-delete');
  // The menu starts listening for clicks outside it one tick after it opens.
  await new Promise((r) => setTimeout(r, 5));
  renderSidebar(c, build(), actions);
  assert.equal(openMenus(), 1, 'the menu is still open after a rebuild');
  assert.equal(menuItem('worktree-delete'), item, 'it is the same menu');
  // A mousedown on the row's new button is not a click outside the menu.
  menuButton().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  assert.equal(openMenus(), 1, 'the rebuilt button still belongs to the menu');
  // (A mousedown anywhere else does close it: the listener is live.)
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  assert.equal(openMenus(), 0);
  click(menuButton());
  const again = menuItem('worktree-delete');
  renderSidebar(c, build(), actions);
  assert.equal(menuItem('worktree-delete'), again);
  click(again);
  assert.deepEqual(deleted, ['/r/devflow-worktrees/fix-login'], 'its entry still works after a rebuild');
  assert.equal(openMenus(), 0);

  // The row disappears while its menu is open.
  click(menuButton());
  assert.equal(openMenus(), 1);
  renderSidebar(c, build([{ ...DEVFLOW_TWO[0], worktrees: [DEVFLOW_TWO[0].worktrees[0], DEVFLOW_TWO[0].worktrees[2]], sessions: ['s2'] }]), actions);
  assert.equal(openMenus(), 0, 'a menu whose row is gone is closed');
  // The machine is folded while a menu is open: its rows are hidden, the menu goes.
  renderSidebar(c, build(), actions);
  click(menuButton());
  assert.equal(openMenus(), 1);
  renderSidebar(c, build(DEVFLOW_TWO, { collapsed: true }), actions);
  assert.equal(openMenus(), 0, 'a menu whose row is hidden is closed');
  c.remove();
});

test('project_remove_disabled_with_sessions', () => {
  const projects = [{ id: '/r/p', name: 'p', git: true, worktrees: [{ path: '/r/p', branch: 'main', head: 'x', main: true, sessions: ['s'] }], sessions: [] }];
  const tree = buildTree([sess('s', { workdir: '/r/p' })], projects);
  const c = render([machineEntry(tree)]);
  click(tid(c, 'project-menu'));
  const remove = menuItem('project-remove');
  assert.equal(remove.disabled, true);
  const note = remove.parentElement.querySelector('.menu-note');
  assert.equal(note.textContent, t('sidebar.project.removeBlocked'));
});

test('main_worktree_has_no_menu', () => {
  const projects = [{
    id: '/r/d', name: 'd', git: true, worktrees: [
      { path: '/r/d', branch: 'main', head: 'x', main: true, sessions: ['s1'] },
      { path: '/r/d-worktrees/ext', branch: 'ext', head: 'y', sessions: ['s2'] },
    ], sessions: [],
  }];
  const tree = buildTree([sess('s1', { workdir: '/r/d' }), sess('s2', { workdir: '/r/d-worktrees/ext' })], projects);
  const c = render([machineEntry(tree)], acts({ deleteWorktree() {} }));
  const rows = tall(c, 'worktree-row');
  const mainRow = rows.find((r) => r.querySelector('[data-testid="worktree-tag-main"]'));
  const extRow = rows.find((r) => r.querySelector('[data-testid="worktree-tag-external"]'));
  assert.equal(mainRow.querySelector('[data-testid="worktree-menu"]'), null);
  assert.ok(extRow.querySelector('[data-testid="worktree-menu"]'));
});

test('legacy_note_and_disabled_entries', () => {
  const projects = [{
    id: '/r/d', name: 'd', git: true, worktrees: [
      { path: '/r/d', branch: 'main', head: 'x', main: true, sessions: ['s1'] },
      { path: '/r/d-worktrees/ext', branch: 'ext', head: 'y', sessions: ['s2'] },
    ], sessions: [],
  }];
  const tree = buildTree([sess('s1', { workdir: '/r/d' }), sess('s2', { workdir: '/r/d-worktrees/ext' })], projects);
  const legacyActs = acts({ newWorktree() {}, deleteWorktree() {} });

  const legacy = render([machineEntry(tree, { cap: 'legacy' })], legacyActs);
  assert.ok(tid(legacy, 'machine-legacy-note'));
  const nw = tid(legacy, 'project-new-worktree');
  assert.equal(nw.disabled, true);
  assert.equal(nw.title, t('sidebar.legacy.needUpgrade'));
  click([...legacy.querySelectorAll('[data-testid="worktree-menu"]')][0]);
  const del = menuItem('worktree-delete');
  assert.equal(del.disabled, true);
  assert.equal(del.parentElement.querySelector('.menu-note').textContent, t('sidebar.legacy.needUpgrade'));

  const unknown = render([machineEntry(tree, { cap: 'unknown' })], legacyActs);
  assert.equal(tid(unknown, 'machine-legacy-note'), null);
  assert.equal(tid(unknown, 'project-new-worktree').disabled, true);
  // Unknown is not old: the reason does not ask for an upgrade.
  assert.equal(tid(unknown, 'project-new-worktree').title, t('sidebar.unknown.notRead'));
  assert.notEqual(t('sidebar.unknown.notRead'), t('sidebar.legacy.needUpgrade'));
  click([...unknown.querySelectorAll('[data-testid="worktree-menu"]')][0]);
  const delUnknown = menuItem('worktree-delete');
  assert.equal(delUnknown.disabled, true);
  assert.equal(delUnknown.parentElement.querySelector('.menu-note').textContent, t('sidebar.unknown.notRead'));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
});

test('project_tag_hue_via_css_var', () => {
  const tree = buildTree([sess('s', { workdir: '/r/devflow' })], [{ id: '/r/devflow', name: 'devflow', git: true, worktrees: [{ path: '/r/devflow', branch: 'main', head: 'x', main: true, sessions: ['s'] }], sessions: [] }]);
  const c = render([machineEntry(tree)]);
  const tag = c.querySelector('.project-tag');
  assert.equal(tag.textContent, 'DE');
  assert.equal(tag.style.getPropertyValue('--tag-hue'), String(projectHue('/r/devflow')));
  assert.equal(tag.style.color, '');
  assert.equal(tag.style.background, '');
  const styleAttr = tag.getAttribute('style') || '';
  assert.ok(styleAttr.includes('--tag-hue'));
  assert.ok(!/color|background/.test(styleAttr), 'no inline color/background');
  // sidebar.ts carries no color literals.
  const src = readFileSync(new URL('../src/renderer/sidebar.ts', import.meta.url), 'utf8');
  assert.ok(!src.includes('hsl('), 'no hsl() in sidebar.ts');
  assert.ok(!src.includes('rgb('), 'no rgb() in sidebar.ts');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(src), 'no hex color in sidebar.ts');
});

test('optional_actions_hide_entries', () => {
  const projects = [
    {
      id: '/r/d', name: 'd', git: true, worktrees: [
        { path: '/r/d', branch: 'main', head: 'x', main: true, sessions: ['s1'] },
        { path: '/r/d-worktrees/ext', branch: 'ext', head: 'y', sessions: ['s2'] },
      ], sessions: [],
    },
    { id: '/tmp/x', name: 'x', git: false, worktrees: [], sessions: ['f'] },
  ];
  const tree = buildTree([sess('s1', { workdir: '/r/d' }), sess('s2', { workdir: '/r/d-worktrees/ext' }), sess('f', { workdir: '/tmp/x' })], projects);
  const c = render([machineEntry(tree)]); // actions without newSession/newWorktree/deleteWorktree
  assert.equal(tid(c, 'worktree-new-session'), null);
  assert.equal(tid(c, 'project-new-session'), null);
  assert.equal(tid(c, 'project-new-worktree'), null);
  assert.equal(tid(c, 'worktree-menu'), null);
});

test('toolbar_title_parts', () => {
  const c = document.createElement('div');
  renderToolbarTitle(c, { project: 'devflow', branch: 'fix-login', name: '登录修复' }, 'fallback');
  assert.equal(tid(c, 'title-project').textContent, 'devflow');
  assert.equal(tid(c, 'title-branch').textContent, 'fix-login');
  assert.equal(tid(c, 'title-session').textContent, '登录修复');

  renderToolbarTitle(c, { project: 'notes', name: 'todo' }, 'fallback');
  assert.equal(tid(c, 'title-project').textContent, 'notes');
  assert.equal(tid(c, 'title-branch'), null);
  assert.equal(tid(c, 'title-session').textContent, 'todo');

  renderToolbarTitle(c, null, 'this-mac');
  assert.equal(tid(c, 'title-project'), null);
  assert.equal(c.textContent, 'this-mac');
});

test('toolbar_title_tag_and_kind', () => {
  const c = document.createElement('div');
  // With the project's hue and the session kind, the title carries the same
  // two-letter tag as the sidebar and the kind glyph; the text parts are unchanged.
  renderToolbarTitle(c, { project: 'devflow', branch: 'fix-login', name: '登录修复', hue: 123, ui: 'chat' }, 'fallback');
  const tag = c.querySelector('.project-tag');
  assert.ok(tag);
  assert.equal(tag.textContent, 'DE');
  assert.equal(tag.style.getPropertyValue('--tag-hue'), '123');
  assert.equal(tag.getAttribute('aria-hidden'), 'true');
  assert.equal(tag.nextElementSibling, tid(c, 'title-project'));
  assert.equal(tid(c, 'title-project').textContent, 'devflow');
  assert.equal(tid(c, 'title-session').textContent, '登录修复');
  assert.ok(tid(c, 'title-session').querySelector('.session-kind-icon svg'));
  assert.equal(tid(c, 'title-session').dataset.ui, 'chat');

  renderToolbarTitle(c, { project: 'notes', name: 'todo' }, 'fallback');
  assert.equal(c.querySelector('.project-tag'), null);
  assert.equal(c.querySelector('.session-kind-icon'), null);
  assert.equal(tid(c, 'title-session').textContent, 'todo');
});

// --- loadIndex-driven cases (real index.ts wiring) ---

test('keeps_tree_when_projects_request_fails', async () => {
  const dom = await indexDom();
  localStorage.setItem('vibe-remote.locale', 'zh');
  const app = await loadIndex();
  app.setMachines([M]);
  app.rebuildRests();
  let round = 0;
  const projects = [{ id: '/r/a', name: 'a', git: true, worktrees: [{ path: '/r/a', branch: 'main', head: 'x', main: true, sessions: [] }], sessions: [] }];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/api/v1/sessions')) return new Response(JSON.stringify({ list: [] }), { status: 200 });
    if (u.endsWith('/api/v1/projects')) {
      round++;
      if (round === 1) return new Response(JSON.stringify({ proto: 4, projects }), { status: 200 });
      return new Response('boom', { status: 500 });
    }
    return new Response(null, { status: 204 });
  };
  await app.refreshAllMachines(true, MK);
  assert.equal(app.machineCaps.get(MK), 'v4');
  app.renderSidebar();
  const before = document.querySelectorAll('[data-testid="project-row"]').length;
  await app.refreshAllMachines(true, MK);
  assert.equal(app.machineCaps.get(MK), 'v4', 'capability survives a failed projects request');
  app.renderSidebar();
  assert.equal(document.querySelectorAll('[data-testid="project-row"]').length, before, 'rows unchanged');
  dom.dom.window.close();
});

// The 5 s poll must not throw away the answers that take longer than 5 s: a
// repository whose git hangs makes the daemon answer /projects after its own
// 5 s timeout, i.e. always after the next poll went out (review D1).
test('slow_answers_survive_the_next_poll', async () => {
  const dom = await indexDom();
  localStorage.setItem('vibe-remote.locale', 'zh');
  localStorage.removeItem('vibe-remote.collapsed-machines');
  localStorage.removeItem('vibe-remote.collapsed-projects');
  const app = await loadIndex();
  app.setMachines([M]);
  app.rebuildRests();
  const json = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });
  const main = (extra = []) => [{ path: '/r/ok', branch: 'main', head: 'a1b2c3d', main: true, sessions: [] }, ...extra];
  const tree = (worktrees, slow = {}) => ({ proto: 4, projects: [
    { id: '/r/ok', name: 'ok', git: true, sessions: [], worktrees },
    { id: '/r/slowrepo', name: 'slowrepo', git: true, sessions: [], worktrees: [{ path: '/r/slowrepo', branch: 'main', head: 'b2c3d4e', main: true, sessions: [] }], ...slow },
  ] });
  const wt = (name) => ({ path: `/r/ok-worktrees/${name}`, branch: name, head: 'c3d4e5f', managed: true, sessions: [] });
  // Every request stays open until the test answers it.
  const pending = { sessions: [], projects: [] };
  globalThis.fetch = (url) => new Promise((resolve, reject) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/v1/sessions') pending.sessions.push({ resolve, reject });
    else if (path === '/api/v1/projects') pending.projects.push({ resolve, reject });
    else resolve(new Response(null, { status: 204 }));
  });
  const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
  const labels = () => [...document.querySelectorAll('[data-testid="worktree-row"] .worktree-label')].map((e) => e.textContent);
  const errors = () => [...document.querySelectorAll('[data-testid="project-error"]')].map((e) => e.textContent);
  const machineState = () => document.querySelector('[data-testid="machine-state"]').dataset.state;

  // Start-up: one refresh, answered.
  const first = app.refreshAllMachines(true, MK);
  pending.sessions[0].resolve(json(200, { list: [] }));
  pending.projects[0].resolve(json(200, tree(main())));
  await first;
  assert.deepEqual(labels(), [], 'one worktree each: both projects are flat');
  assert.equal(machineState(), 'connected');

  // Poll 1 goes out; its /projects answer is still pending when poll 2 goes out.
  void app.pollMachines();
  await settle();
  pending.sessions[1].resolve(json(200, { list: [] }));
  await settle();
  void app.pollMachines();
  await settle();
  assert.equal(pending.projects.length, 3, 'two /projects requests are in flight');
  // Poll 1 is answered now: a new worktree in the healthy repository, and the
  // hung one reported as failed.
  const failed = { error: 'git_failed', errorMessage: 'git worktree list --porcelain: context deadline exceeded', worktrees: [] };
  pending.projects[1].resolve(json(200, tree(main([wt('added-later')]), failed)));
  await settle();
  assert.deepEqual(labels(), ['main', 'added-later'], 'the answer to poll 1 is shown although poll 2 is already out');
  assert.deepEqual(errors(), [t('sidebar.project.readFailed', { msg: failed.errorMessage })], 'the hung repository shows why it could not be read');

  // An answer that arrives out of order never replaces a newer one.
  pending.sessions[2].resolve(json(200, { list: [] }));
  void app.pollMachines();
  await settle();
  pending.sessions[3].resolve(json(200, { list: [] }));
  pending.projects[3].resolve(json(200, tree(main([wt('added-later'), wt('newest')]))));
  await settle();
  assert.deepEqual(labels(), ['main', 'added-later', 'newest']);
  pending.projects[2].resolve(json(200, tree(main([wt('added-later')]), failed)));
  await settle();
  assert.deepEqual(labels(), ['main', 'added-later', 'newest'], 'the late answer to poll 2 is dropped: poll 3 has been applied');
  assert.deepEqual(errors(), []);

  // The same for the session list: a host that stops answering fails each
  // request after the 8 s deadline, later than the next poll.
  void app.pollMachines();
  await settle();
  void app.pollMachines();
  await settle();
  pending.sessions[4].reject(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }));
  await settle();
  assert.equal(machineState(), 'offline', 'a request that timed out after the next poll went out still marks the machine offline');

  // A refresh asked for by an action (here: forced) still supersedes what is in flight.
  const forced = app.refreshAllMachines(true, MK);
  await settle();
  const last = pending.projects.length - 1;
  pending.projects[last - 1].resolve(json(200, tree(main())));
  await settle();
  assert.deepEqual(labels(), ['main', 'added-later', 'newest'], 'an answer from before the forced refresh is not applied');
  pending.sessions[pending.sessions.length - 1].resolve(json(200, { list: [] }));
  pending.projects[last].resolve(json(200, tree(main([wt('after-forced')]))));
  await forced;
  assert.deepEqual(labels(), ['main', 'after-forced']);
  assert.equal(machineState(), 'connected');
  for (const kind of ['sessions', 'projects']) for (const req of pending[kind]) req.resolve(json(200, kind === 'sessions' ? { list: [] } : tree(main([wt('after-forced')]))));
  await settle();
  dom.dom.window.close();
});

test('collapsed_projects_persist', async () => {
  const dom = await indexDom();
  localStorage.setItem('vibe-remote.locale', 'zh');
  localStorage.removeItem('vibe-remote.collapsed-projects');
  globalThis.fetch = async () => new Response(null, { status: 204 });
  let app = await loadIndex();
  app.setMachines([M]);
  app.rebuildRests();
  app.machineSessions.set(MK, [{ id: 's', title: 'one', workdir: '/r/proj', created: '2026-01-01T00:00:00Z', mode: 'normal' }]);
  app.renderSidebar();
  // Legacy grouping (no projects) → the session's workdir is its own project id.
  const pg = document.querySelector('.project-group[data-project-id="/r/proj"]');
  assert.ok(pg, 'project group rendered');
  pg.querySelector('.project-toggle').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const stored = JSON.parse(localStorage.getItem('vibe-remote.collapsed-projects') || '[]');
  assert.ok(stored.includes(`${MK}|/r/proj`), 'collapse persisted');

  // Reload: a fresh index instance reads the persisted set and stays collapsed.
  const app2 = await loadIndex();
  app2.setMachines([M]);
  app2.rebuildRests();
  app2.machineSessions.set(MK, [{ id: 's', title: 'one', workdir: '/r/proj', created: '2026-01-01T00:00:00Z', mode: 'normal' }]);
  app2.renderSidebar();
  const toggle = document.querySelector('.project-group[data-project-id="/r/proj"] .project-toggle');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'still collapsed after reload');
  // Opening a session in it expands the project.
  app2.setActive(`${MK}::s`);
  const after = JSON.parse(localStorage.getItem('vibe-remote.collapsed-projects') || '[]');
  assert.ok(!after.includes(`${MK}|/r/proj`), 'setActive expands the active project');
  dom.dom.window.close();
});

// --- preserved T6a behavior cases ---

async function setupApp(sessions) {
  const dom = await indexDom();
  localStorage.setItem('vibe-remote.locale', 'zh');
  localStorage.removeItem('vibe-remote.collapsed-machines');
  localStorage.removeItem('vibe-remote.collapsed-projects');
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
    if (String(url).endsWith('/api/v1/sessions')) return new Response(JSON.stringify({ list: app.machineSessions.get(MK) || [] }), { status: 200 });
    return new Response(null, { status: 204 });
  };
  const app = await loadIndex();
  app.setMachines([M]);
  app.rebuildRests();
  app.machineOnline.set(MK, true);
  app.machineSessions.set(MK, sessions);
  app.renderSidebar();
  return { dom, app, calls };
}

test('no_rerender_while_renaming', async () => {
  const { dom, app } = await setupApp([{ id: 't1', title: 'build', workdir: '/w/t1', created: '2026-01-01T00:00:00Z', mode: 'normal' }]);
  document.querySelector('.session-label').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const input = document.querySelector('.session-rename-input');
  assert.ok(input, 'rename input appeared');
  input.value = 'half-typed';
  app.renderSidebar(); // must be a no-op while renaming
  assert.equal(document.querySelector('.session-rename-input'), input, 'same input node survives');
  assert.equal(input.value, 'half-typed', 'typed text preserved');
  dom.dom.window.close();
});

test('inline_rename_commits', async () => {
  const { dom, calls } = await setupApp([{ id: 't1', title: 'build', workdir: '/w/t1', created: '2026-01-01T00:00:00Z', mode: 'normal' }]);
  document.querySelector('.session-label').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  let input = document.querySelector('.session-rename-input');
  input.value = '登录修复';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  const renames = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/v1/sessions/t1/rename'));
  assert.equal(renames.length, 1, 'one rename request');
  assert.equal(JSON.parse(renames[0].body).name, '登录修复');

  document.querySelector('.session-label').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  input = document.querySelector('.session-rename-input');
  input.value = 'nope';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.filter((c) => c.url.endsWith('/api/v1/sessions/t1/rename')).length, 1, 'Esc sends no rename');
  dom.dom.window.close();
});

test('actions_fire_once', async () => {
  const { dom, app, calls } = await setupApp([
    { id: 'o', title: 'open', workdir: '/w/o', created: '2026-01-01T00:00:01Z', mode: 'normal', ui: 'chat', state: 'running' },
    { id: 'd', title: 'del', workdir: '/w/d', created: '2026-01-01T00:00:02Z', mode: 'normal' },
  ]);
  const container = document.createElement('div');
  document.getElementById('terminal-container').appendChild(container);
  app.views.set(`${MK}::o`, { ui: 'chat', key: `${MK}::o`, sessionId: 'o', machine: M, container, activity: 'none', client: { state: 'connected' }, show() {} });
  app.showMachineOverview(M);
  assert.equal(app.activeKey, null);

  const labelOf = (name) => [...document.querySelectorAll('.session-item')].find((r) => r.querySelector('.session-label-text')?.textContent === name);
  click(labelOf('open').querySelector('.session-label'));
  assert.equal(app.activeKey, `${MK}::o`, 'open switched active');

  click(labelOf('del').querySelector('.session-close'));
  await new Promise((r) => setTimeout(r, 20));
  const deletes = () => calls.filter((c) => c.method === 'DELETE' && c.url.endsWith('/api/v1/sessions/d')).length;
  assert.equal(deletes(), 0, 'nothing is deleted before the in-app confirmation is answered');
  click(document.querySelector('[data-testid="delete-session-dialog"] [data-testid="dialog-confirm"]'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(deletes(), 1, 'one DELETE');

  assert.equal(document.querySelector('.session-list').hidden, false);
  click(document.querySelector('.machine-toggle'));
  assert.equal(document.querySelector('.session-list').hidden, true, 'machine collapsed');
  assert.ok(JSON.parse(localStorage.getItem('vibe-remote.collapsed-machines')).includes(MK));

  dom.dom.window.close();
});

// --- T14: the delete-worktree flow's result, as index.ts acts on it ---

test('remove_result_closes_views', async () => {
  const dom = await indexDom();
  localStorage.setItem('vibe-remote.locale', 'zh');
  localStorage.removeItem('vibe-remote.collapsed-machines');
  localStorage.removeItem('vibe-remote.collapsed-projects');
  const ROOT = '/r/devflow-worktrees/fix-login';
  const HEAD = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';
  const sessions = [
    { id: 'm1', title: 'devflow', workdir: '/r/devflow', created: '2026-01-01T00:00:01Z', mode: 'normal' },
    { id: 'a', title: 'fix-login', workdir: ROOT, created: '2026-01-01T00:00:02Z', mode: 'normal', ui: 'chat', state: 'running' },
    { id: 'b', title: 'fix-login', workdir: ROOT, created: '2026-01-01T00:00:03Z', mode: 'normal', ui: 'chat', state: 'running' },
  ];
  const projects = [{
    id: '/r/devflow', name: 'devflow', git: true, sessions: [], worktrees: [
      { path: '/r/devflow', branch: 'main', head: 'a1b2c3d', main: true, sessions: ['m1'] },
      { path: ROOT, branch: 'fix-login', head: '9f8e7d6', managed: true, sessions: ['a', 'b'] },
    ],
  }];
  const status = (over = {}) => ({ path: ROOT, project: '/r/devflow', branch: 'fix-login', head: HEAD, main: false, managed: true,
    dirtyFiles: 0, unmergedCommits: 0, ignoredFiles: 0, sessions: ['a', 'b'], ...over });
  const json = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });
  let calls = [];
  let removeAnswers = [];
  let statusAnswers = [];
  // What /api/v1/projects answers, and a promise it waits for first when set
  // (a daemon whose project list takes a while: one repository's git is slow).
  let projectsNow = projects;
  let projectsGate = null;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push(`${init.method || 'GET'} ${u.pathname}`);
    if (u.pathname === '/api/v1/sessions') return json(200, { list: sessions });
    if (u.pathname === '/api/v1/projects') {
      if (projectsGate) await projectsGate;
      return json(200, { proto: 4, projects: projectsNow });
    }
    if (u.pathname === '/api/v1/worktrees/status') return statusAnswers.shift()();
    if (u.pathname === '/api/v1/worktrees/remove') return removeAnswers.shift()();
    return new Response(null, { status: 204 });
  };
  const app = await loadIndex();
  app.setMachines([M]);
  app.rebuildRests();
  const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
  const dialogButton = (id) => document.querySelector(`.modal-overlay [data-testid="${id}"]`);
  const refreshes = () => ({ sessions: calls.filter((c) => c === 'GET /api/v1/sessions').length, projects: calls.filter((c) => c === 'GET /api/v1/projects').length });

  // Opens both sessions of the worktree as views, then starts "Delete worktree" from its menu.
  const start = async () => {
    await app.refreshAllMachines(true, MK);
    assert.equal(app.machineCaps.get(MK), 'v4');
    const disposed = [];
    for (const id of ['a', 'b']) {
      const container = document.createElement('div');
      document.getElementById('terminal-container').appendChild(container);
      app.views.set(`${MK}::${id}`, { ui: 'chat', key: `${MK}::${id}`, sessionId: id, machine: M, container, activity: 'none', client: { state: 'connected' }, show() {}, dispose() { disposed.push(id); container.remove(); } });
    }
    app.renderSidebar();
    const row = [...document.querySelectorAll('[data-testid="worktree-row"]')].find((r) => r.querySelector('.worktree-label').textContent === 'fix-login');
    click(row.querySelector('[data-testid="worktree-menu"]'));
    const item = menuItem('worktree-delete');
    assert.equal(item.disabled, false, 'the entry is usable on a v4 daemon');
    calls = [];
    click(item);
    await settle();
    assert.ok(document.querySelector('.modal-overlay [data-testid="delete-wt-dialog"]'), 'the confirmation opened');
    assert.deepEqual(calls, ['GET /api/v1/worktrees/status']);
    return disposed;
  };
  const openViews = () => ['a', 'b'].filter((id) => app.views.has(`${MK}::${id}`));

  // Removed, both sessions ended.
  statusAnswers = [() => json(200, status())];
  removeAnswers = [() => json(200, { removed: true, branchDeleted: true, endedSessions: ['a', 'b'] })];
  let disposed = await start();
  click(dialogButton('dialog-confirm'));
  await settle();
  assert.deepEqual(disposed, ['a', 'b'], 'both views were closed');
  assert.deepEqual(openViews(), []);
  assert.deepEqual(refreshes(), { sessions: 1, projects: 1 }, 'one refresh of this machine');

  // Sessions ended, worktree still there (the removal failed afterwards): same.
  statusAnswers = [() => json(200, status()), () => json(200, status({ sessions: [] }))];
  removeAnswers = [() => json(500, { error: 'worktree_remove_failed', message: 'fatal: simulated', endedSessions: ['a', 'b'] })];
  disposed = await start();
  click(dialogButton('dialog-confirm'));
  await settle();
  assert.equal(document.querySelector('.modal-overlay [data-testid="delete-wt-error"]').textContent, '删除失败：fatal: simulated');
  assert.deepEqual(disposed, [], 'nothing is closed while the flow is still open');
  click(dialogButton('dialog-cancel'));
  await settle();
  assert.deepEqual(disposed, ['a', 'b']);
  assert.deepEqual(openViews(), []);
  assert.deepEqual(refreshes(), { sessions: 1, projects: 1 });

  // Requested, nothing ended, not removed: no view is closed, but the machine is refreshed.
  statusAnswers = [() => json(200, status())];
  removeAnswers = [() => json(409, { error: 'worktree_changed', message: 'changed', status: status({ dirtyFiles: 1 }), endedSessions: [] })];
  disposed = await start();
  click(dialogButton('dialog-confirm'));
  await settle();
  assert.ok(document.querySelector('.modal-overlay [data-testid="delete-wt-changed"]'));
  click(dialogButton('dialog-cancel'));
  await settle();
  assert.deepEqual(disposed, []);
  assert.deepEqual(openViews(), ['a', 'b']);
  assert.deepEqual(refreshes(), { sessions: 1, projects: 1 });

  // The worktree was removed by someone else while the confirmation was open
  // (`git worktree remove --force` in a terminal): the daemon answers 404
  // before it touches anything, so the sessions listed in the confirmation
  // are still running. Their views stay; the refresh shows where they are now.
  statusAnswers = [() => json(200, status())];
  removeAnswers = [() => json(404, { error: 'worktree_not_found', message: 'not a worktree this daemon can see' })];
  disposed = await start();
  click(dialogButton('dialog-confirm'));
  await settle();
  assert.equal(document.querySelector('.modal-overlay'), null);
  assert.equal(document.getElementById('status-message').textContent, '这个 worktree 已经不存在');
  assert.deepEqual(disposed, [], 'a 404 ended no session: no view is closed');
  assert.deepEqual(openViews(), ['a', 'b']);
  assert.deepEqual(refreshes(), { sessions: 1, projects: 1 }, 'the machine is refreshed');

  // While the removal is under way (the daemon ends the sessions one by one
  // and deletes the directory: several seconds) the row says so, its entries
  // are off, and asking again does nothing (review D7).
  let finishRemove;
  statusAnswers = [() => json(200, status())];
  removeAnswers = [() => new Promise((resolve) => { finishRemove = () => resolve(json(200, { removed: true, branchDeleted: true, endedSessions: [] })); })];
  disposed = await start();
  const staleDelete = (() => {
    // A menu left over from before the request, as after a sidebar rebuild.
    const row = [...document.querySelectorAll('[data-testid="worktree-row"]')].find((r) => r.querySelector('.worktree-label').textContent === 'fix-login');
    click(row.querySelector('[data-testid="worktree-menu"]'));
    return menuItem('worktree-delete');
  })();
  click(dialogButton('dialog-confirm'));
  await settle();
  const removingRow = () => [...document.querySelectorAll('[data-testid="worktree-row"]')].find((r) => r.querySelector('.worktree-label').textContent === 'fix-login');
  assert.equal(document.querySelector('.modal-overlay'), null, 'the confirmation is closed');
  assert.ok(removingRow(), 'the row is still there: the daemon has not answered');
  assert.equal(removingRow().dataset.removing, 'true');
  assert.equal(removingRow().getAttribute('aria-busy'), 'true');
  assert.equal(removingRow().querySelector('[data-testid="worktree-removing"]').textContent, '正在删除…');
  assert.equal(removingRow().querySelector('[data-testid="worktree-new-session"]').disabled, true, 'no new session in a worktree that is being deleted');
  click(removingRow().querySelector('[data-testid="worktree-menu"]'));
  assert.equal(menuItem('worktree-delete').disabled, true, 'the delete entry is off while the request is in flight');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  // A rebuild in between keeps the marker. (The list is rebuilt when what it
  // shows changed: here the poll brought a session renamed elsewhere.)
  const rowBeforeRebuild = removingRow();
  app.machineSessions.set(MK, (app.machineSessions.get(MK) || []).map((s) => (s.id === 'a' ? { ...s, title: 'renamed elsewhere' } : s)));
  app.renderSidebar();
  assert.notEqual(removingRow(), rowBeforeRebuild, 'the list was rebuilt');
  assert.equal(removingRow().dataset.removing, 'true');
  // The entry of the menu opened earlier is still enabled; using it starts nothing.
  calls = [];
  click(staleDelete);
  await settle();
  assert.deepEqual(calls.filter((c) => c.includes('/worktrees/')), [], 'no second status or remove request');
  assert.equal(document.querySelector('.modal-overlay'), null, 'no second confirmation');
  // Other worktrees are not affected.
  const mainRow = [...document.querySelectorAll('[data-testid="worktree-row"]')].find((r) => r.querySelector('.worktree-label').textContent === 'main');
  assert.equal(mainRow.dataset.removing, undefined);
  finishRemove();
  await settle();
  assert.equal(removingRow().dataset.removing, undefined, 'the marker goes when the request is answered');
  assert.equal(removingRow().querySelector('[data-testid="worktree-removing"]'), null);
  assert.equal(removingRow().querySelector('[data-testid="worktree-new-session"]').disabled, false);

  // Removed, and the refresh that follows is slow (the daemon's project list
  // waits for a repository whose git takes its 5 seconds): the worktree is
  // gone on the daemon, so its row stays "being deleted" and unusable until
  // the refreshed list has replaced it. It does not turn back into a row that
  // offers a new session in a directory that no longer exists (review round 2).
  statusAnswers = [() => json(200, status())];
  removeAnswers = [() => new Promise((resolve) => { finishRemove = () => resolve(json(200, { removed: true, branchDeleted: true, endedSessions: ['a', 'b'] })); })];
  disposed = await start();
  click(dialogButton('dialog-confirm'));
  await settle();
  assert.equal(removingRow().dataset.removing, 'true');
  let releaseProjects;
  projectsGate = new Promise((resolve) => { releaseProjects = resolve; });
  projectsNow = [{ ...projects[0], worktrees: [projects[0].worktrees[0]] }];
  finishRemove();
  await settle();
  assert.deepEqual(refreshes(), { sessions: 1, projects: 1 }, 'the refresh is under way');
  assert.ok(removingRow(), 'the old list is still shown: the refreshed one has not arrived');
  assert.equal(removingRow().dataset.removing, 'true', 'removed, list not refreshed yet: the row is still being deleted');
  assert.equal(removingRow().querySelector('[data-testid="worktree-removing"]').textContent, '正在删除…');
  assert.equal(removingRow().querySelector('[data-testid="worktree-new-session"]').disabled, true, 'no new session in a worktree that is gone');
  click(removingRow().querySelector('[data-testid="worktree-menu"]'));
  assert.equal(menuItem('worktree-delete').disabled, true);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  releaseProjects();
  await settle();
  assert.equal(removingRow(), undefined, 'the refreshed list has no such row');
  // The marker did not outlive the refresh: a worktree created again at the
  // same path is an ordinary row.
  projectsGate = null;
  projectsNow = projects;
  await app.refreshAllMachines(true, MK);
  assert.equal(removingRow().dataset.removing, undefined);
  assert.equal(removingRow().querySelector('[data-testid="worktree-new-session"]').disabled, false);

  // Cancelled before anything was requested: nothing happens at all.
  statusAnswers = [() => json(200, status())];
  disposed = await start();
  click(dialogButton('dialog-cancel'));
  await settle();
  assert.deepEqual(disposed, []);
  assert.deepEqual(openViews(), ['a', 'b']);
  assert.deepEqual(refreshes(), { sessions: 0, projects: 0 }, 'no refresh');
  assert.equal(document.querySelector('.modal-overlay'), null);
  dom.dom.window.close();
});

// --- T15: the -c note counts sessions by working directory (d24) ---

test('new_session_count_uses_workdir', async () => {
  const dom = await indexDom();
  localStorage.setItem('vibe-remote.locale', 'zh');
  localStorage.removeItem('vibe-remote.collapsed-machines');
  localStorage.removeItem('vibe-remote.collapsed-projects');
  const ROOT = '/r/devflow-worktrees/fix-login';
  const live = { id: 'a', title: 'fix-login', workdir: ROOT, created: '2026-01-01T00:00:02Z', mode: 'normal' };
  const ended = { id: 'e', title: 'fix-login', workdir: ROOT, created: '2026-01-01T00:00:03Z', mode: 'normal', ui: 'chat', state: 'ended', endReason: 'exited' };
  let sessions = [live, ended];
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === '/api/v1/sessions') return json({ list: sessions });
    if (u.pathname === '/api/v1/projects') {
      return json({ proto: 4, projects: [{
        id: '/r/devflow', name: 'devflow', git: true, sessions: [], worktrees: [
          { path: '/r/devflow', branch: 'main', head: 'a1b2c3d', main: true, sessions: [] },
          { path: ROOT, branch: 'fix-login', head: '9f8e7d6', managed: true, sessions: sessions.map((s) => s.id) },
        ],
      }] });
    }
    if (u.pathname === '/api/v1/info') {
      return json({ hostname: 'h', tmux_enabled: true, default_workdir: '/r', allowed_roots: ['/r'], proto: 4, version: 'test',
        chat: { supported: true, claudeVersion: '2.1.210', minClaudeVersion: '2.1.210' },
        claude_flags: [{ id: 'continue', label: '续上次会话 (-c)' }] });
    }
    if (u.pathname === '/api/v1/fs') return json({ path: u.searchParams.get('path'), entries: [], parent: '/r', chatTrust: 'trusted' });
    return new Response(null, { status: 204 });
  };
  const app = await loadIndex();
  app.setMachines([M]);
  app.rebuildRests();
  const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

  const openDialog = async () => {
    await app.refreshAllMachines(true, MK);
    app.renderSidebar();
    const row = [...document.querySelectorAll('[data-testid="worktree-row"]')].find((r) => r.querySelector('.worktree-label').textContent === 'fix-login');
    click(row.querySelector('[data-testid="worktree-new-session"]'));
    await settle();
    const dialog = document.querySelector('.modal-overlay [data-testid="worktree-session-dialog"]');
    assert.ok(dialog, 'the new-session dialog opened');
    click(dialog.querySelector('.modal-flag input[name="claude-flag-continue"]'));
    return dialog;
  };
  const cancel = async (dialog) => {
    click(dialog.querySelector('[data-testid="dialog-cancel"]'));
    await settle();
    assert.equal(document.querySelector('.modal-overlay'), null);
  };

  // A running session whose workdir is the worktree root, next to an ended chat session.
  let dialog = await openDialog();
  assert.ok(dialog.querySelector('[data-testid="continue-note"]'), 'the running session counts');
  await cancel(dialog);

  // Only the ended one is left: the worktree node still has a session, the note does not show.
  sessions = [ended];
  dialog = await openDialog();
  assert.equal(document.querySelectorAll('[data-testid="session-row"]').length, 1, 'the ended session is still listed under the worktree');
  assert.equal(dialog.querySelector('[data-testid="continue-note"]'), null);
  await cancel(dialog);
  dom.dom.window.close();
});

await run();

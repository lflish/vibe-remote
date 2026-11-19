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
const { renderSidebar, renderToolbarTitle } = await load('src/renderer/sidebar.ts', { platform: 'browser' });
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
  const tree = buildTree([sess('s1', { workdir: '/r/devflow' }), sess('s2', { workdir: '/r/devflow-worktrees/fix-login' })], projects);
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
});

test('flat_project_has_no_worktree_row', () => {
  const projects = [{ id: '/r/new-api', name: 'new-api', git: true, worktrees: [{ path: '/r/new-api', branch: 'dev', head: 'abc1234', main: true, sessions: ['a', 'b'] }], sessions: [] }];
  const tree = buildTree([sess('a', { workdir: '/r/new-api' }), sess('b', { workdir: '/r/new-api' })], projects);
  const c = render([machineEntry(tree)]);
  assert.equal(tall(c, 'worktree-row').length, 0);
  assert.equal(tid(c, 'project-branch').textContent, 'dev');
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
  const collapsed = render([machineEntry(tree)], acts(), { collapsedProjects: new Set([`${MK}|/r/w`]), dotOf });
  assert.ok(tid(collapsed, 'project-dot'));
  assert.equal(tid(collapsed, 'session-row'), null, 'collapsed hides sessions');

  const expanded = render([machineEntry(tree)], acts(), { dotOf });
  assert.equal(tid(expanded, 'project-dot'), null);
  assert.equal(tid(expanded, 'session-row').dataset.dot, 'waiting');
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
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push(`${init.method || 'GET'} ${u.pathname}`);
    if (u.pathname === '/api/v1/sessions') return json(200, { list: sessions });
    if (u.pathname === '/api/v1/projects') return json(200, { proto: 4, projects });
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

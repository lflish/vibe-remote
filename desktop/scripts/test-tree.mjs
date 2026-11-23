// tree.ts: pure tree-building and helper functions (no DOM). Design 4.10.
import { strict as assert } from 'node:assert';
import { load, runner } from './chat-test-util.mjs';

const {
  buildTree,
  visibleSessions,
  projectRollup,
  sessionContext,
  sessionProject,
  notificationTitle,
  nextCapability,
  projectHue,
  countActiveSessionsAt,
} = await load('src/renderer/tree.ts');

const { test, run } = runner('test-tree');

// A minimal SessionInfo. created defaults keep ordering deterministic.
let seq = 0;
const sess = (id, over = {}) => ({
  id,
  title: '',
  workdir: '',
  created: `2026-01-01T00:00:${String(seq++).padStart(2, '0')}Z`,
  mode: 'normal',
  ...over,
});

// Collect every TreeSession id across a whole tree (worktree + project level).
function allIds(tree) {
  const ids = [];
  for (const p of tree) {
    for (const w of p.worktrees) for (const s of w.sessions) ids.push(s.id);
    for (const s of p.sessions) ids.push(s.id);
  }
  return ids;
}

test('two_worktrees_each_with_session', () => {
  const projects = [
    {
      id: '/r/devflow', name: 'devflow', git: true, worktrees: [
        { path: '/r/devflow', branch: 'main', head: 'a1b2c3d', main: true, sessions: ['s1'] },
        { path: '/r/devflow-worktrees/fix-login', branch: 'fix-login', head: '9f8e7d6', managed: true, sessions: ['s2'] },
      ], sessions: [],
    },
  ];
  const sessions = [sess('s1', { workdir: '/r/devflow' }), sess('s2', { workdir: '/r/devflow-worktrees/fix-login' })];
  const tree = buildTree(sessions, projects);
  assert.equal(tree.length, 1);
  const p = tree[0];
  assert.equal(p.flat, false);
  assert.equal(p.worktrees.length, 2);
  assert.equal(p.worktrees[0].sessions.length, 1);
  assert.equal(p.worktrees[1].sessions.length, 1);
  assert.equal(p.worktrees[0].label, 'main');
  assert.equal(p.worktrees[1].label, 'fix-login');
});

test('single_worktree_is_flat', () => {
  const projects = [
    { id: '/r/new-api', name: 'new-api', git: true, worktrees: [{ path: '/r/new-api', branch: 'dev', head: 'abc1234', main: true, sessions: ['a', 'b'] }], sessions: [] },
  ];
  const sessions = [sess('a', { workdir: '/r/new-api' }), sess('b', { workdir: '/r/new-api' })];
  const tree = buildTree(sessions, projects);
  assert.equal(tree[0].flat, true);
  assert.equal(tree[0].branchLabel, 'dev');
  assert.equal(tree[0].worktrees[0].sessions.length, 2);
});

// The repository's main directory is outside the daemon's allowed roots
// (R2.6): the daemon lists only the other worktree. That worktree is not the
// project's own directory, so it keeps its row — the only place its "delete
// worktree" entry lives (review, item to verify 2).
test('single_worktree_that_is_not_main_keeps_its_row', () => {
  const projects = [
    { id: '/outside/repo', name: 'repo', git: true, worktrees: [{ path: '/r/repo-wt/a', branch: 'a', head: 'abc1234', managed: true, sessions: ['s'] }], sessions: [] },
  ];
  const tree = buildTree([sess('s', { workdir: '/r/repo-wt/a' })], projects);
  assert.equal(tree[0].flat, false, 'not flat: the one listed worktree is not the main directory');
  assert.equal(tree[0].branchLabel, undefined, 'the branch is on the worktree row, not on the project row');
  assert.equal(tree[0].worktrees.length, 1);
  assert.equal(tree[0].worktrees[0].main, false);
  assert.deepEqual(tree[0].worktrees[0].sessions.map((x) => x.id), ['s']);
  assert.deepEqual(sessionContext(tree, 's'), { project: 'repo', branch: 'a', name: 'a' });
  // A git project with nothing listed (its list could not be read) stays flat.
  const failed = buildTree([sess('e')], [{ id: '/r/e', name: 'e', git: true, error: 'git_failed', errorMessage: 'boom', worktrees: [], sessions: ['e'] }]);
  assert.equal(failed[0].flat, true);
});

test('non_git_project', () => {
  const projects = [{ id: '/tmp/notes', name: 'notes', git: false, worktrees: [], sessions: ['n1'] }];
  const tree = buildTree([sess('n1', { workdir: '/tmp/notes' })], projects);
  assert.equal(tree[0].flat, true);
  assert.equal(tree[0].branchLabel, undefined);
  assert.equal(tree[0].sessions.length, 1);
});

test('detached_label_is_short_hash', () => {
  const projects = [
    {
      id: '/r/x', name: 'x', git: true, worktrees: [
        { path: '/r/x', branch: 'main', head: 'aaaaaaa', main: true, sessions: [] },
        { path: '/r/x-worktrees/tmp', head: '5a6b7c8', detached: true, sessions: ['d'] },
      ], sessions: [],
    },
  ];
  const tree = buildTree([sess('d', { workdir: '/r/x-worktrees/tmp' })], projects);
  const wt = tree[0].worktrees[1];
  assert.equal(wt.detached, true);
  assert.equal(wt.label, '5a6b7c8');
  assert.equal(wt.label.length, 7);
});

test('gone_sessions', () => {
  const projects = [
    { id: '/r/g', name: 'g', git: true, worktrees: [{ path: '/r/g', branch: 'main', head: 'aaaaaaa', main: true, sessions: ['live'] }], sessions: ['go'] },
  ];
  const tree = buildTree([sess('go', { workdir: '/gone' }), sess('live', { workdir: '/r/g' })], projects);
  const p = tree[0];
  assert.equal(p.sessions.length, 1);
  assert.equal(p.sessions[0].gone, true);
  assert.equal(p.worktrees[0].sessions[0].gone, false);
});

test('project_error', () => {
  const missing = buildTree([sess('e1', {})], [{ id: '/r/e', name: 'e', git: true, error: 'repo_missing', worktrees: [], sessions: ['e1'] }]);
  assert.equal(missing[0].error.code, 'repo_missing');
  assert.equal(missing[0].sessions.length, 1);
  assert.equal(missing[0].sessions[0].gone, false);
  const failed = buildTree([sess('e2', {})], [{ id: '/r/e', name: 'e', git: true, error: 'git_failed', errorMessage: 'boom', worktrees: [], sessions: ['e2'] }]);
  assert.equal(failed[0].error.code, 'git_failed');
  assert.equal(failed[0].error.message, 'boom');
});

test('duplicate_names_get_numbers', () => {
  const mk = (ids) => [{ id: '/r/d', name: 'd', git: true, worktrees: [{ path: '/r/d', branch: 'main', head: 'x', main: true, sessions: ids }], sessions: [] }];
  const names = (tree) => tree[0].worktrees[0].sessions.map((s) => s.name);

  let t = buildTree([sess('1', { title: 'devflow' }), sess('2', { title: 'devflow' }), sess('3', { title: 'devflow' })], mk(['1', '2', '3']));
  assert.deepEqual(names(t), ['devflow', 'devflow 2', 'devflow 3']);

  t = buildTree([sess('1', { title: 'devflow' }), sess('2', { title: '登录修复' }), sess('3', { title: 'devflow' })], mk(['1', '2', '3']));
  assert.deepEqual(names(t), ['devflow', '登录修复', 'devflow 2']);

  // Same name under different worktrees do not number across each other.
  const projects = [{
    id: '/r/d', name: 'd', git: true, worktrees: [
      { path: '/r/d', branch: 'main', head: 'x', main: true, sessions: ['a'] },
      { path: '/r/d-worktrees/y', branch: 'y', head: 'z', managed: true, sessions: ['b'] },
    ], sessions: [],
  }];
  t = buildTree([sess('a', { title: 'devflow' }), sess('b', { title: 'devflow' })], projects);
  assert.equal(t[0].worktrees[0].sessions[0].name, 'devflow');
  assert.equal(t[0].worktrees[1].sessions[0].name, 'devflow');
});

test('keeps_daemon_order', () => {
  const projects = [
    { id: '/r/b', name: 'b', git: true, worktrees: [{ path: '/r/b', branch: 'main', head: 'x', main: true, sessions: ['s2', 's1'] }], sessions: [] },
    { id: '/r/a', name: 'a', git: true, worktrees: [{ path: '/r/a', branch: 'main', head: 'x', main: true, sessions: [] }], sessions: [] },
  ];
  const tree = buildTree([sess('s1', { workdir: '/r/b' }), sess('s2', { workdir: '/r/b' })], projects);
  assert.equal(tree[0].id, '/r/b');
  assert.equal(tree[1].id, '/r/a');
  assert.deepEqual(tree[0].worktrees[0].sessions.map((s) => s.id), ['s2', 's1']);
});

// R1.5 at a realistic size: three projects, eight sessions, several worktrees
// in a project and several sessions in a worktree. The expected order is
// written out here, not taken from a first run: a wrong order that is merely
// stable would pass a "same as last time" comparison.
const flatten = (tree) => {
  const lines = [];
  for (const p of tree) {
    lines.push(`P ${p.name}`);
    for (const w of p.worktrees) {
      lines.push(`  W ${w.label}${w.main ? ' (main)' : ''}`);
      for (const x of w.sessions) lines.push(`    S ${x.id} "${x.name}"`);
    }
    for (const x of p.sessions) lines.push(`  S ${x.id} "${x.name}"`);
  }
  return lines;
};
const shuffles = function* (list, rounds = 40) {
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  yield [...list].reverse();
  for (let i = 0; i < rounds; i++) yield list.map((x) => [rand(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
};
// Session ids sort the opposite way to their creation times, so an order by id
// cannot pass for an order by creation time.
const at = (n) => `2026-03-01T10:00:${String(n).padStart(2, '0')}Z`;

test('order_three_projects_eight_sessions_new_daemon', () => {
  // What the daemon lists (design 4.2): projects by name ignoring case, the main
  // directory first, the other worktrees by branch, sessions by creation time.
  const projects = [
    { id: '/r/alpha', name: 'alpha', git: true, sessions: [], worktrees: [
      { path: '/r/alpha', branch: 'main', head: 'a000001', main: true, sessions: ['z9', 'y8'] },
      { path: '/r/alpha-worktrees/fix', branch: 'fix', head: 'a000002', managed: true, sessions: ['x7', 'w6'] },
      { path: '/r/alpha-worktrees/zeta', branch: 'zeta', head: 'a000003', managed: true, sessions: ['v5'] },
    ] },
    { id: '/r/Beta', name: 'Beta', git: true, sessions: [], worktrees: [
      { path: '/r/Beta', branch: 'main', head: 'b000001', main: true, sessions: [] },
      { path: '/r/Beta-worktrees/x', branch: 'x', head: 'b000002', sessions: ['u4'] },
    ] },
    { id: '/r/gamma', name: 'gamma', git: true, sessions: [], worktrees: [
      { path: '/r/gamma', branch: 'main', head: 'c000001', main: true, sessions: ['t3'] },
      { path: '/r/gamma-worktrees/b', branch: 'b', head: 'c000002', managed: true, sessions: ['s2'] },
    ] },
  ];
  const sessions = [
    { id: 'z9', title: '', workdir: '/r/alpha', created: at(1), mode: 'normal' },
    { id: 'y8', title: '', workdir: '/r/alpha', created: at(2), mode: 'normal', ui: 'chat', state: 'idle' },
    { id: 'x7', title: '', workdir: '/r/alpha-worktrees/fix', created: at(3), mode: 'normal' },
    { id: 'w6', title: '登录', workdir: '/r/alpha-worktrees/fix', created: at(4), mode: 'normal' },
    { id: 'v5', title: '', workdir: '/r/alpha-worktrees/zeta', created: at(5), mode: 'normal' },
    { id: 'u4', title: '', workdir: '/r/Beta-worktrees/x', created: at(6), mode: 'normal' },
    { id: 't3', title: '', workdir: '/r/gamma', created: at(7), mode: 'normal' },
    { id: 's2', title: '', workdir: '/r/gamma-worktrees/b', created: at(8), mode: 'normal' },
  ];
  const expected = [
    'P alpha',
    '  W main (main)',
    '    S z9 "alpha"',
    '    S y8 "alpha 2"',
    '  W fix',
    '    S x7 "fix"',
    '    S w6 "登录"',
    '  W zeta',
    '    S v5 "zeta"',
    'P Beta',
    '  W main (main)',
    '  W x',
    '    S u4 "x"',
    'P gamma',
    '  W main (main)',
    '    S t3 "gamma"',
    '  W b',
    '    S s2 "b"',
  ];
  assert.equal(sessions.length, 8);
  assert.deepEqual(flatten(buildTree(sessions, projects)), expected);
  // Whatever order /api/v1/sessions lists them in, the tree is the daemon's.
  for (const shuffled of shuffles(sessions)) {
    assert.deepEqual(flatten(buildTree(shuffled, projects)), expected, `sessions listed as ${shuffled.map((x) => x.id).join(',')}`);
  }
  assert.deepEqual(visibleSessions([{ key: 'm', collapsed: false, tree: buildTree(sessions, projects) }], new Set()).map((x) => x.id),
    ['z9', 'y8', 'x7', 'w6', 'v5', 'u4', 't3', 's2'], 'the switching keys walk the same order');
});

test('order_three_projects_eight_sessions_old_daemon', () => {
  // No project tree: the order is the desktop's own (design 4.2 again), built
  // from session fields that an old daemon lists in a different order each time.
  const wt = (id, repo, branch, n, over = {}) => ({
    id, title: '', workdir: `${repo}-worktrees/${branch}`, created: at(n), mode: 'worktree',
    sourceWorkdir: repo, sourceRepo: repo, worktreeRoot: `${repo}-worktrees/${branch}`, branch, ...over,
  });
  const sessions = [
    { id: 'z9', title: '', workdir: '/r/alpha', created: at(1), mode: 'normal' },
    { id: 'y8', title: '', workdir: '/r/alpha/src', created: at(2), mode: 'normal' },
    wt('x7', '/r/alpha', 'fix', 3),
    wt('w6', '/r/alpha', 'fix', 4, { workdir: '/r/alpha-worktrees/fix/pkg' }),
    wt('v5', '/r/alpha', 'zeta', 5),
    wt('u4', '/r/Beta', 'x', 6),
    { id: 't3', title: '', workdir: '/r/gamma', created: at(7), mode: 'normal' },
    wt('s2', '/r/gamma', 'b', 8),
  ];
  const expected = [
    'P alpha',
    '  W  (main)',
    '    S z9 "alpha"',
    '    S y8 "src"',
    '  W fix',
    '    S x7 "fix"',
    '    S w6 "pkg"',
    '  W zeta',
    '    S v5 "zeta"',
    'P Beta',
    '  W x',
    '    S u4 "x"',
    'P gamma',
    '  W  (main)',
    '    S t3 "gamma"',
    '  W b',
    '    S s2 "b"',
  ];
  assert.equal(sessions.length, 8);
  assert.deepEqual(flatten(buildTree(sessions, null)), expected);
  let rounds = 0;
  for (const shuffled of shuffles(sessions)) {
    rounds++;
    assert.deepEqual(flatten(buildTree(shuffled, null)), expected, `sessions listed as ${shuffled.map((x) => x.id).join(',')}`);
  }
  assert.equal(rounds, 41);
  // By creation time, not by id and not by listing order: swap two creation times.
  const swapped = sessions.map((x) => (x.id === 'x7' ? { ...x, created: at(4) } : x.id === 'w6' ? { ...x, created: at(3) } : x));
  const lines = flatten(buildTree(swapped, null));
  assert.ok(lines.indexOf('    S w6 "pkg"') < lines.indexOf('    S x7 "fix"'), 'the session created first comes first');
});

test('legacy_order_sorted', () => {
  const base = [
    sess('b', { mode: 'worktree', sourceRepo: '/r/Beta', worktreeRoot: '/r/Beta-wt/x', branch: 'x', workdir: '/r/Beta-wt/x' }),
    sess('a', { mode: 'worktree', sourceRepo: '/r/alpha', worktreeRoot: '/r/alpha-wt/x', branch: 'x', workdir: '/r/alpha-wt/x' }),
    sess('g', { mode: 'worktree', sourceRepo: '/r/gamma', worktreeRoot: '/r/gamma-wt/x', branch: 'x', workdir: '/r/gamma-wt/x' }),
  ];
  const canonical = JSON.stringify(buildTree(base, null).map((p) => p.id));
  assert.deepEqual(JSON.parse(canonical), ['/r/alpha', '/r/Beta', '/r/gamma']);
  for (let i = 0; i < 40; i++) {
    const shuffled = [...base].sort(() => (i % 3) - 1);
    assert.equal(JSON.stringify(buildTree(shuffled, null).map((p) => p.id)), canonical);
  }
});

test('legacy_groups_by_session_fields', () => {
  const sessions = [
    sess('w', { mode: 'worktree', sourceRepo: '/r/devflow', worktreeRoot: '/r/devflow-worktrees/x', branch: 'vibe/x', workdir: '/r/devflow-worktrees/x' }),
    sess('m', { workdir: '/r/devflow/src' }),
    sess('sub', { workdir: '/r/devflow-worktrees/x/sub' }),
    sess('n', { workdir: '/tmp/notes' }),
  ];
  const tree = buildTree(sessions, null);
  const dev = tree.find((p) => p.id === '/r/devflow');
  assert.ok(dev);
  const wtx = dev.worktrees.find((w) => w.path === '/r/devflow-worktrees/x');
  assert.ok(wtx.managed);
  assert.deepEqual(wtx.sessions.map((s) => s.id).sort(), ['sub', 'w']);
  const mainRow = dev.worktrees.find((w) => w.main);
  assert.deepEqual(mainRow.sessions.map((s) => s.id), ['m']);
  const notes = tree.find((p) => p.id === '/tmp/notes');
  assert.equal(notes.git, false);
  assert.ok(notes.sessions.some((s) => s.id === 'n'));
});

// Found by the T17 walk-through against a protocol 3 daemon, which lists its
// sessions in a different order on every poll.
test('legacy_grouping_ignores_input_order', () => {
  const sessions = [
    sess('n1', { workdir: '/tmp/notes' }),
    sess('n2', { workdir: '/tmp/notes' }),
    sess('n3', { workdir: '/tmp/notes' }),
    sess('sub', { workdir: '/tmp/notes/sub' }),
    sess('m1', { workdir: '/r/devflow' }),
    sess('w', { mode: 'worktree', sourceRepo: '/r/devflow', worktreeRoot: '/r/devflow-worktrees/x', branch: 'vibe/x', workdir: '/r/devflow-worktrees/x' }),
    sess('m2', { workdir: '/r/devflow/src' }),
  ];
  const shape = (list) => JSON.stringify(buildTree(list, null).map((p) => ({
    id: p.id, git: p.git, flat: p.flat,
    worktrees: p.worktrees.map((w) => [w.path, w.main, w.sessions.map((x) => `${x.id}=${x.name}`)]),
    sessions: p.sessions.map((x) => `${x.id}=${x.name}`),
  })));
  const tree = buildTree(sessions, null);
  const notes = tree.find((p) => p.id === '/tmp/notes');
  assert.equal(notes.git, false);
  assert.deepEqual(notes.worktrees, [], 'a plain folder never gets a worktree row');
  assert.deepEqual(notes.sessions.map((x) => x.id), ['n1', 'n2', 'n3'], 'creation order');
  assert.deepEqual(notes.sessions.map((x) => x.name), ['notes', 'notes 2', 'notes 3'], 'numbered within the one folder (R1.4)');
  assert.ok(tree.some((p) => p.id === '/tmp/notes/sub' && !p.git), 'a subfolder of a plain folder is its own project');
  const dev = tree.find((p) => p.id === '/r/devflow');
  assert.deepEqual(dev.worktrees.find((w) => w.main).sessions.map((x) => x.id), ['m1', 'm2'], 'a git project still takes its subfolders');
  assert.equal(allIds(tree).length, sessions.length);

  const canonical = shape(sessions);
  let seed = 11;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 40; i++) {
    const shuffled = sessions.map((x) => [rand(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    assert.equal(shape(shuffled), canonical, `order ${shuffled.map((x) => x.id).join(',')}`);
  }
});

// The same rule places a session the daemon's tree has not caught up with.
test('unreferenced_session_in_plain_folder_joins_its_project', () => {
  const projects = [{ id: '/tmp/notes', name: 'notes', git: false, worktrees: [], sessions: ['n1'] }];
  const tree = buildTree([sess('n1', { workdir: '/tmp/notes' }), sess('n2', { workdir: '/tmp/notes' })], projects);
  assert.equal(tree.length, 1);
  assert.deepEqual(tree[0].worktrees, []);
  assert.deepEqual(tree[0].sessions.map((x) => x.id), ['n1', 'n2']);
  assert.deepEqual(tree[0].sessions.map((x) => x.name), ['notes', 'notes 2']);
});

test('tolerates_stale_ids', () => {
  const projects = [{ id: '/r/s', name: 's', git: true, worktrees: [{ path: '/r/s', branch: 'main', head: 'x', main: true, sessions: ['ghost', 'real'] }], sessions: [] }];
  const tree = buildTree([sess('real', { workdir: '/r/s' })], projects);
  assert.deepEqual(tree[0].worktrees[0].sessions.map((s) => s.id), ['real']);
});

test('unreferenced_session_placed_by_legacy_rule', () => {
  const projects = [{ id: '/r/u', name: 'u', git: true, worktrees: [{ path: '/r/u', branch: 'main', head: 'x', main: true, sessions: [] }], sessions: [] }];
  const tree = buildTree([sess('extra', { workdir: '/r/u/deep' })], projects);
  const ids = allIds(tree);
  assert.equal(ids.filter((id) => id === 'extra').length, 1);
});

test('rollup_waiting_only', () => {
  const projects = [{ id: '/r/r', name: 'r', git: true, worktrees: [{ path: '/r/r', branch: 'main', head: 'x', main: true, sessions: ['a', 'b'] }], sessions: [] }];
  const tree = buildTree([sess('a', {}), sess('b', {})], projects);
  assert.equal(projectRollup(tree[0], (id) => (id === 'a' ? 'idle' : 'output')), 'none');
  assert.equal(projectRollup(tree[0], (id) => (id === 'b' ? 'waiting' : 'idle')), 'waiting');
});

test('visible_sessions_skip_collapsed', () => {
  const projects = ['p1', 'p2', 'p3'].map((n) => ({ id: `/${n}`, name: n, git: false, worktrees: [], sessions: [`${n}a`, `${n}b`] }));
  const sessions = projects.flatMap((p) => p.sessions.map((id) => sess(id, { workdir: p.id })));
  const tree = buildTree(sessions, projects);
  const vis = visibleSessions([{ key: 'm1', collapsed: false, tree }], new Set(['m1|/p2']));
  assert.deepEqual(vis, [
    { machineKey: 'm1', id: 'p1a' }, { machineKey: 'm1', id: 'p1b' },
    { machineKey: 'm1', id: 'p3a' }, { machineKey: 'm1', id: 'p3b' },
  ]);
  assert.deepEqual(visibleSessions([{ key: 'm1', collapsed: true, tree }], new Set()), []);
});

test('session_context_and_notification_title', () => {
  const projects = [
    {
      id: '/r/devflow', name: 'devflow', git: true, worktrees: [
        { path: '/r/devflow', branch: 'main', head: 'x', main: true, sessions: [] },
        { path: '/r/devflow-worktrees/fix-login', branch: 'fix-login', head: 'y', managed: true, sessions: ['L'] },
      ], sessions: [],
    },
    { id: '/n/notes', name: 'notes', git: false, worktrees: [], sessions: ['T'] },
  ];
  const tree = buildTree([sess('L', { title: '登录修复', workdir: '/r/devflow-worktrees/fix-login' }), sess('T', { title: 'todo', workdir: '/n/notes' })], projects);
  const ctx = sessionContext(tree, 'L');
  assert.deepEqual(ctx, { project: 'devflow', branch: 'fix-login', name: '登录修复' });
  assert.equal(notificationTitle('this-mac', ctx), 'this-mac · devflow / fix-login · 登录修复');
  const ctxT = sessionContext(tree, 'T');
  assert.equal(ctxT.project, 'notes');
  assert.equal(ctxT.branch, undefined);
  assert.equal(ctxT.name, 'todo');
  assert.equal(notificationTitle('this-mac', ctxT), 'this-mac · notes · todo');
  assert.equal(sessionContext(tree, 'nope'), null);
  // The project a session belongs to (the toolbar tags its title with it).
  assert.equal(sessionProject(tree, 'L').id, '/r/devflow');
  assert.equal(sessionProject(tree, 'T').id, '/n/notes');
  assert.equal(sessionProject(tree, 'nope'), null);
});

test('capability_transitions', () => {
  assert.equal(nextCapability('unknown', []), 'v4');
  assert.equal(nextCapability('v4', null), 'legacy');
  assert.equal(nextCapability('v4', new Error('x')), 'v4');
  assert.equal(nextCapability('unknown', new Error('x')), 'unknown');
});

test('project_hue_stable', () => {
  const h = projectHue('/r/devflow');
  assert.ok(Number.isInteger(h) && h >= 0 && h < 360);
  for (let i = 0; i < 100; i++) assert.equal(projectHue('/r/devflow'), h);
  assert.notEqual(projectHue('/r/devflow'), projectHue('/r/new-api'));
  assert.equal(typeof projectHue(''), 'number');
});

test('count_active_sessions_at', () => {
  const sessions = [
    sess('t', { workdir: '/r/devflow' }),
    sess('c', { workdir: '/r/devflow', ui: 'chat', state: 'ended' }),
    sess('s', { workdir: '/r/devflow/src' }),
  ];
  assert.equal(countActiveSessionsAt(sessions, '/r/devflow'), 1);
  assert.equal(countActiveSessionsAt(sessions, '/r/devflow/src'), 1);
  assert.equal(countActiveSessionsAt(sessions, '/r/other'), 0);
});

await run();

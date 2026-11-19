// worktree-dialogs.ts: the new-worktree dialog (T9), the new-session dialog for
// an existing worktree (T11), the delete-session confirmation (T12) and the
// delete-worktree confirmation and flow (T14). Driven through the real REST
// client against a fake daemon behind fetch.
import { strict as assert } from 'node:assert';
import { indexDom, load, runner } from './chat-test-util.mjs';
import { INFO_V4, afterDebounce, click, fakeDaemon, overlay, planFor, pressKey, settle, tid, typeInto } from './dialog-test-util.mjs';

const page = await indexDom();
localStorage.setItem('vibe-remote.locale', 'zh');
let sockets = 0;
globalThis.WebSocket = class { constructor() { sockets++; } };
const {
  openNewWorktreeDialog, openWorktreeSessionDialog, confirmDeleteSession,
  confirmDeleteWorktree, showDeleteWorktreeFailure, deleteWorktreeFlow, RestError,
} = await load('scripts/worktree-dialogs-entry.ts', { platform: 'browser' });
const { t } = await load('src/renderer/i18n.ts', { platform: 'browser' });

const { test, run } = runner('test-worktree-dialogs');
const M = { name: 'this-mac', addr: '10.0.0.9', port: 8765, token: 't' };
const MAIN = '/r/devflow';
const WT_PATH = '/r/devflow-worktrees/fix-login';

const wt = (over) => ({ path: MAIN, label: 'main', branch: 'main', detached: false, main: false, managed: false, sessions: [], ...over });
const PROJECT = {
  id: MAIN, name: 'devflow', git: true, flat: false, sessions: [],
  worktrees: [wt({ main: true }), wt({ path: WT_PATH, label: 'fix-login', branch: 'fix-login', managed: true })],
};

async function openNew(routes, project = PROJECT) {
  const daemon = fakeDaemon(routes);
  let settled = false;
  const result = openNewWorktreeDialog(M, project).then((v) => { settled = true; return v; });
  await settle(8);
  const root = overlay();
  return {
    daemon, result, root, settled: () => settled,
    input: tid('wt-name-input', root), error: tid('wt-name-error', root),
    confirm: tid('dialog-confirm', root), cancel: tid('dialog-cancel', root),
  };
}

function assertShell(root) {
  const modal = root.querySelector('.modal');
  assert.deepEqual([...modal.children].map((c) => c.className.split(' ')[0]), ['modal-header', 'modal-body', 'modal-footer']);
  assert.equal(modal.getAttribute('role'), 'dialog');
}

test('new_worktree_confirm_resolves', async () => {
  const d = await openNew({ plan: (workdir, name) => planFor(name) });
  assertShell(d.root);
  const header = d.root.querySelector('.modal-header');
  assert.ok(header.textContent.includes('在 devflow 新建 worktree'), header.textContent);
  assert.ok(header.textContent.includes('this-mac · 从 main 发起'), header.textContent);
  assert.equal(d.confirm.textContent, '创建并打开');
  assert.equal(d.confirm.disabled, true, 'no name yet');
  assert.deepEqual(d.daemon.plans(), [{ workdir: MAIN, name: '' }], 'the base is fetched as the dialog opens');
  assert.equal(tid('wt-base-info', d.root).textContent, '基于 main @ a1b2c3d，不包含未提交的改动');
  // The chat card follows the trust of the directory the worktree starts from.
  assert.deepEqual(d.daemon.calls.filter((c) => c.path === '/api/v1/fs').map((c) => c.query.path), [MAIN]);
  assert.equal(d.root.querySelector('.modal-list'), null, 'no directory list');

  typeInto(d.input, 'fix-login');
  await afterDebounce();
  assert.equal(tid('wt-target-path', d.root).textContent, WT_PATH);
  click(tid('picker-ui-chat', d.root));
  assert.equal(d.confirm.disabled, false);
  const before = d.daemon.plans().length;
  click(d.confirm);
  const picked = await d.result;
  const asked = d.daemon.plans().slice(before);
  assert.deepEqual(asked, [{ workdir: MAIN, name: 'fix-login' }], 'confirming checks the name once more');
  assert.deepEqual(picked, { mode: 'worktree', workdir: MAIN, ui: 'chat', flags: ['skip'], worktreeName: 'fix-login', worktreePath: WT_PATH });
  assert.equal(overlay(), null);
  assert.equal(sockets, 0, 'the dialog itself attaches nothing');
  d.daemon.restore();
});

test('plan_rejection_keeps_dialog_open', async () => {
  const cases = [
    { name: 'fix-login', reject: { error: 'worktree_branch_exists', conflict: 'fix-login' }, text: '分支 fix-login 已存在' },
    { name: 'fix/login', reject: { error: 'worktree_branch_exists', conflict: 'fix' }, text: t('wt.error.branch_conflict', { branch: 'fix/login', conflict: 'fix' }) },
    { name: 'fix-login', reject: { error: 'worktree_path_exists' }, text: `目录已存在：${WT_PATH}` },
    { name: 'fix-login', reject: { error: 'worktree_path_not_allowed' }, text: `目录不在允许的范围内：${WT_PATH}` },
  ];
  for (const c of cases) {
    // The name passes while typing and is refused at confirm (someone else got there first).
    let refuse = false;
    const d = await openNew({
      plan: (workdir, name) => (refuse && name === c.name ? { ...planFor(name), ok: false, message: 'refused', ...c.reject } : planFor(name)),
    });
    typeInto(d.input, c.name);
    await afterDebounce();
    assert.equal(d.confirm.disabled, false, c.reject.error);
    refuse = true;
    click(d.confirm);
    await settle(8);
    assert.equal(d.error.textContent, c.text, c.reject.error);
    assert.equal(d.error.hidden, false);
    assert.ok(overlay(), 'the dialog stays open');
    assert.equal(d.settled(), false, 'nothing is returned yet');
    assert.equal(d.confirm.disabled, true);
    if (c.reject.conflict === 'fix') {
      assert.ok(d.error.textContent.includes('fix/login') && d.error.textContent.includes('已有分支 fix'));
      assert.notEqual(d.error.textContent, '分支 fix/login 已存在');
    }

    // Rename and try again.
    typeInto(d.input, 'fix-login-2');
    await afterDebounce();
    assert.equal(d.error.textContent, '');
    assert.equal(d.confirm.disabled, false);
    click(d.confirm);
    const picked = await d.result;
    assert.equal(picked.worktreeName, 'fix-login-2');
    assert.equal(picked.worktreePath, '/r/devflow-worktrees/fix-login-2');
    d.daemon.restore();
  }
});

test('new_worktree_cancel', async () => {
  const a = await openNew({ plan: (workdir, name) => planFor(name) });
  typeInto(a.input, 'fix-login');
  click(a.cancel);
  assert.equal(await a.result, null);
  assert.equal(overlay(), null);
  a.daemon.restore();

  const b = await openNew({ plan: (workdir, name) => planFor(name) });
  typeInto(b.input, 'fix-login');
  pressKey(b.input, 'Escape');
  assert.equal(await b.result, null);
  assert.equal(overlay(), null);
  assert.equal(sockets, 0, 'cancelling attaches nothing');
  b.daemon.restore();
});

test('new_worktree_enter_confirms', async () => {
  const d = await openNew({ plan: (workdir, name) => planFor(name) });
  pressKey(d.input, 'Enter');
  await settle();
  assert.ok(overlay(), 'Enter does nothing while the name is not usable');
  typeInto(d.input, 'fix-login');
  await afterDebounce();
  pressKey(d.input, 'Enter');
  const picked = await d.result;
  assert.equal(picked.worktreeName, 'fix-login');
  assert.equal(picked.ui, 'terminal');
  d.daemon.restore();
});

// "Type the name, press Enter" is the natural way through this dialog. Enter
// must not wait for the 250 ms debounce and the pre-check that enable the
// button: confirming asks the daemon once more anyway (review D8).
test('new_worktree_enter_right_after_typing', async () => {
  const d = await openNew({ plan: (workdir, name) => planFor(name) });
  typeInto(d.input, 'fix-login');
  assert.equal(d.confirm.disabled, true, 'the pre-check has not answered yet');
  const before = d.daemon.plans().length;
  pressKey(d.input, 'Enter');
  await settle(8);
  assert.equal(d.settled(), true, 'Enter right after typing creates the worktree, without a second press');
  const picked = await d.result;
  assert.deepEqual(picked, { mode: 'worktree', workdir: MAIN, ui: 'terminal', flags: ['skip'], worktreeName: 'fix-login', worktreePath: WT_PATH });
  assert.deepEqual(d.daemon.plans().slice(before), [{ workdir: MAIN, name: 'fix-login' }], 'the name was checked once, at confirm');
  assert.equal(overlay(), null);
  d.daemon.restore();

  // A name the daemon refuses: the dialog stays, with the reason, as after a click.
  const e = await openNew({
    plan: (workdir, name) => (name === 'taken' ? { ...planFor(name), ok: false, error: 'worktree_branch_exists', conflict: 'taken', message: 'refused' } : planFor(name)),
  });
  typeInto(e.input, 'taken');
  pressKey(e.input, 'Enter');
  await settle(8);
  assert.ok(overlay(), 'the dialog stays open');
  assert.equal(e.settled(), false);
  assert.equal(e.error.textContent, '分支 taken 已存在');
  // Pressing Enter twice in a row sends one confirmation, not two.
  typeInto(e.input, 'free');
  const sent = e.daemon.plans().length;
  pressKey(e.input, 'Enter');
  pressKey(e.input, 'Enter');
  assert.equal((await e.result).worktreeName, 'free');
  assert.equal(e.daemon.plans().length - sent, 1);
  e.daemon.restore();

  // What Enter still does not do: submit a name the local rules refuse or an
  // empty one, or submit before the machine info is in.
  const f = await openNew({ plan: (workdir, name) => planFor(name) });
  for (const name of ['', 'a b', '-x']) {
    typeInto(f.input, name);
    const asked = f.daemon.plans().length;
    pressKey(f.input, 'Enter');
    await settle();
    assert.ok(overlay() && !f.settled(), `${JSON.stringify(name)} is not submitted`);
    assert.equal(f.daemon.plans().length, asked, 'and the daemon is not asked');
  }
  click(f.cancel);
  await f.result;
  f.daemon.restore();

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const g = await openNew({ plan: (workdir, name) => planFor(name), info: async () => { await gate; return INFO_V4; } });
  typeInto(g.input, 'fix-login');
  pressKey(g.input, 'Enter');
  await settle(8);
  assert.ok(overlay() && !g.settled(), 'not before the machine info is in: the default launch options would be lost');
  release();
  await settle(8);
  pressKey(g.input, 'Enter');
  assert.deepEqual((await g.result).flags, ['skip']);
  g.daemon.restore();
});

test('new_worktree_unsupported_repo', async () => {
  for (const [code, text] of [['unsupported_repo', t('wt.error.unsupported_repo')], ['not_git', '这个目录不在 git 仓库里']]) {
    const d = await openNew({
      plan: () => (code === 'not_git'
        ? { ok: false, error: 'not_git', message: 'not a repository' }
        : { ok: false, error: 'unsupported_repo', message: 'submodule', project: MAIN, projectName: 'devflow', base: { branch: 'main', head: 'a1b2c3d' } }),
    });
    assert.equal(d.error.textContent, text, code);
    assert.equal(d.error.hidden, false);
    assert.equal(d.input.disabled, true, `${code}: the name cannot be typed`);
    assert.equal(d.confirm.disabled, true);
    click(d.confirm);
    await settle();
    assert.equal(d.settled(), false);
    click(d.cancel);
    assert.equal(await d.result, null);
    d.daemon.restore();
  }
});

test('new_worktree_chat_follows_main_trust', async () => {
  const d = await openNew({
    plan: (workdir, name) => planFor(name),
    fs: (path) => ({ path, entries: [], parent: '/r', chatTrust: 'untrusted' }),
  });
  assert.equal(tid('picker-ui-chat', d.root).disabled, true);
  assert.equal(tid('picker-ui-chat-reason', d.root).textContent, t('picker.ui.chat.reason.workdir_untrusted'));
  assert.equal(tid('picker-ui-terminal', d.root).disabled, false);
  typeInto(d.input, 'fix-login');
  await afterDebounce();
  click(d.confirm);
  const picked = await d.result;
  assert.equal(picked.ui, 'terminal');
  d.daemon.restore();
});

// --- T11: new session in an existing worktree ---

const HIDDEN = '/Users/mac/github/devflow/.devflow-tmp/worktrees/general-skills';
const DEVFLOW = {
  id: '/Users/mac/github/devflow', name: 'devflow', git: true, flat: false, sessions: [],
  worktrees: [
    wt({ path: '/Users/mac/github/devflow', main: true }),
    wt({ path: '/Users/mac/github/devflow-worktrees/fix-login', label: 'fix-login', branch: 'fix-login', managed: true }),
    wt({ path: HIDDEN, label: 'change/general-skills', branch: 'change/general-skills' }),
  ],
};

async function openSessionDialog(routes, project, worktree, opts) {
  const daemon = fakeDaemon(routes);
  let settled = false;
  const result = openWorktreeSessionDialog(M, project, worktree, opts).then((v) => { settled = true; return v; });
  await settle(8);
  const root = overlay();
  return { daemon, result, root, settled: () => settled, confirm: tid('dialog-confirm', root), cancel: tid('dialog-cancel', root) };
}

const fsTrust = (chatTrust) => (path) => ({ path, entries: [{ name: 'src', path: `${path}/src` }], parent: '/Users/mac', chatTrust });

test('worktree_session_dialog_shape', async () => {
  const target = DEVFLOW.worktrees[1];
  const d = await openSessionDialog({ fs: fsTrust('trusted') }, DEVFLOW, target);
  assertShell(d.root);
  assert.ok(d.root.querySelector('.modal-title').textContent.includes('fix-login'));
  assert.equal(d.root.querySelector('.modal-title').textContent, '在 fix-login 新建会话');
  const path = tid('session-dialog-path', d.root);
  assert.ok(path.textContent.includes('devflow') && path.textContent.includes(target.path), path.textContent);
  assert.equal(d.confirm.textContent, '新建会话');
  // Only the interface and the launch options: no directory list, no session mode, no name.
  assert.equal(d.root.querySelector('.modal-list'), null);
  assert.equal(d.root.querySelector('.modal-path'), null);
  assert.equal(d.root.querySelectorAll('.modal-mode-card:not(.modal-ui-card)').length, 0);
  assert.equal(tid('wt-name-input', d.root), null);
  assert.ok(tid('picker-ui-terminal', d.root) && tid('picker-ui-chat', d.root));
  assert.equal(d.root.querySelectorAll('.modal-flag input').length, 2);
  // The trust of the worktree itself is asked for, once.
  assert.deepEqual(d.daemon.calls.filter((c) => c.path === '/api/v1/fs').map((c) => c.query.path), [target.path]);
  assert.equal(tid('picker-ui-chat', d.root).disabled, false);
  assert.equal(d.confirm.disabled, false);
  click(d.confirm);
  assert.deepEqual(await d.result, { mode: 'normal', workdir: target.path, ui: 'terminal', flags: ['skip'] });
  assert.equal(overlay(), null);
  assert.equal(sockets, 0);
  d.daemon.restore();

  // Chat picked, flags changed; cancel returns null.
  const e = await openSessionDialog({ fs: fsTrust('trusted') }, DEVFLOW, target);
  click(tid('picker-ui-chat', e.root));
  const boxes = [...e.root.querySelectorAll('.modal-flag input')];
  boxes[0].checked = true;
  boxes[1].checked = false;
  click(e.confirm);
  assert.deepEqual(await e.result, { mode: 'normal', workdir: target.path, ui: 'chat', flags: ['continue'] });
  e.daemon.restore();
  const f = await openSessionDialog({ fs: fsTrust('trusted') }, DEVFLOW, target);
  pressKey(f.confirm, 'Escape');
  assert.equal(await f.result, null);
  f.daemon.restore();
});

test('worktree_session_hidden_dir', async () => {
  const d = await openSessionDialog({ fs: fsTrust('trusted') }, DEVFLOW, DEVFLOW.worktrees[2]);
  assert.ok(tid('session-dialog-path', d.root).textContent.includes(HIDDEN));
  assert.ok(d.root.querySelector('.modal-title').textContent.includes('change/general-skills'));
  click(d.confirm);
  const picked = await d.result;
  assert.equal(picked.workdir, HIDDEN);
  assert.equal(picked.mode, 'normal');
  d.daemon.restore();
});

test('worktree_session_chat_disabled_reason', async () => {
  const d = await openSessionDialog({ fs: fsTrust('untrusted') }, DEVFLOW, DEVFLOW.worktrees[2]);
  const chat = tid('picker-ui-chat', d.root);
  assert.equal(chat.disabled, true);
  const reason = tid('picker-ui-chat-reason', d.root);
  assert.equal(reason.hidden, false);
  assert.equal(reason.textContent, t('picker.ui.chat.reason.worktree_untrusted', { path: '/Users/mac/github/devflow' }));
  assert.ok(reason.textContent.includes('/Users/mac/github/devflow') && reason.textContent.includes('项目主目录'), reason.textContent);
  assert.ok(!reason.textContent.includes(HIDDEN), 'the path named is the main directory, not the worktree');
  const term = tid('picker-ui-terminal', d.root);
  assert.equal(term.disabled, false);
  assert.equal(term.getAttribute('aria-pressed'), 'true');
  assert.equal(d.confirm.disabled, false, 'the terminal interface can still be used');
  click(chat);
  assert.equal(term.getAttribute('aria-pressed'), 'true', 'a disabled card cannot be chosen');
  click(d.confirm);
  assert.equal((await d.result).ui, 'terminal');
  d.daemon.restore();
});

test('worktree_session_main_row_uses_existing_reason', async () => {
  const existing = t('picker.ui.chat.reason.workdir_untrusted');
  // The main directory row.
  const a = await openSessionDialog({ fs: fsTrust('untrusted') }, DEVFLOW, DEVFLOW.worktrees[0]);
  assert.equal(tid('picker-ui-chat', a.root).disabled, true);
  assert.equal(tid('picker-ui-chat-reason', a.root).textContent, existing);
  click(a.cancel);
  await a.result;
  a.daemon.restore();
  // An older daemon only looks at the directory itself: sending the user to the main directory would not help.
  const b = await openSessionDialog({ fs: fsTrust('untrusted'), info: { ...INFO_V4, proto: 3 } }, DEVFLOW, DEVFLOW.worktrees[2]);
  assert.equal(tid('picker-ui-chat', b.root).disabled, true);
  assert.equal(tid('picker-ui-chat-reason', b.root).textContent, existing);
  click(b.cancel);
  await b.result;
  b.daemon.restore();
  // The project's main directory is not listed (outside the allowed roots): nothing to point at.
  const noMain = { ...DEVFLOW, worktrees: DEVFLOW.worktrees.slice(1) };
  const c = await openSessionDialog({ fs: fsTrust('untrusted') }, noMain, noMain.worktrees[1]);
  assert.equal(tid('picker-ui-chat-reason', c.root).textContent, existing);
  click(c.cancel);
  await c.result;
  c.daemon.restore();
});

test('flat_project_new_session', async () => {
  // A non-git project: the sidebar passes a node made from the project itself.
  const notes = { id: '/Users/mac/notes', name: 'notes', git: false, flat: true, worktrees: [], sessions: [] };
  const node = { path: notes.id, label: notes.name, detached: false, main: true, managed: false, sessions: [] };
  const d = await openSessionDialog({ fs: fsTrust('untrusted') }, notes, node);
  assert.equal(d.root.querySelector('.modal-title').textContent, '在 notes 新建会话');
  assert.ok(tid('session-dialog-path', d.root).textContent.includes('/Users/mac/notes'));
  assert.equal(tid('picker-ui-chat-reason', d.root).textContent, t('picker.ui.chat.reason.workdir_untrusted'));
  click(d.confirm);
  assert.deepEqual(await d.result, { mode: 'normal', workdir: '/Users/mac/notes', ui: 'terminal', flags: ['skip'] });
  d.daemon.restore();
});

test('worktree_session_waits_for_launch_options', async () => {
  // Default-checked launch options must not be dropped by a quick confirm.
  let release;
  const gate = new Promise((r) => { release = r; });
  const d = await openSessionDialog({ fs: fsTrust('trusted'), info: async () => { await gate; return INFO_V4; } }, DEVFLOW, DEVFLOW.worktrees[1]);
  assert.equal(d.confirm.disabled, true, 'not confirmable before the machine info has arrived');
  release();
  await settle(8);
  assert.equal(d.confirm.disabled, false);
  click(d.confirm);
  assert.deepEqual((await d.result).flags, ['skip']);
  d.daemon.restore();
  // The info request failing leaves the terminal usable, without options.
  const e = await openSessionDialog({ fs: fsTrust('trusted'), info: new Error('offline') }, DEVFLOW, DEVFLOW.worktrees[1]);
  assert.equal(e.confirm.disabled, false);
  assert.equal(tid('picker-ui-chat', e.root).disabled, true);
  click(e.confirm);
  assert.deepEqual(await e.result, { mode: 'normal', workdir: DEVFLOW.worktrees[1].path, ui: 'terminal', flags: [] });
  e.daemon.restore();
});

// --- T15: what -c does when the worktree's directory already has a session (R6) ---

test('continue_note_counts', async () => {
  const flagBox = (root, id) => root.querySelector(`.modal-flag input[name="claude-flag-${id}"]`);
  const sessionAt = (id, workdir, over = {}) => ({ id, name: id, gone: false, info: { id, title: id, workdir, created: '2026-01-01T00:00:00Z', mode: 'normal', ...over } });
  const base = DEVFLOW.worktrees[1];
  // The worktree node holds two sessions that do not count: one in a subfolder, one that has ended.
  const target = { ...base, sessions: [sessionAt('sub', `${base.path}/src`), sessionAt('old', base.path, { ui: 'chat', state: 'ended' })] };
  const project = { ...DEVFLOW, worktrees: [DEVFLOW.worktrees[0], target, DEVFLOW.worktrees[2]] };

  // One live session in the worktree's own directory.
  const asked = [];
  const a = await openSessionDialog({ fs: fsTrust('trusted') }, project, target, { sessionCountAt: (dir) => { asked.push(dir); return 1; } });
  assert.deepEqual([...new Set(asked)], [target.path], 'the count is asked for the worktree root');
  assert.equal(tid('continue-note', a.root), null, 'not before -c is checked');
  click(flagBox(a.root, 'continue'));
  assert.equal(tid('continue-note', a.root).textContent, t('wt.session.continueNote'));
  assert.equal(a.confirm.disabled, false, 'the confirm button is not greyed out');
  click(a.confirm);
  assert.deepEqual(await a.result, { mode: 'normal', workdir: target.path, ui: 'terminal', flags: ['continue', 'skip'] });
  a.daemon.restore();

  // None there, whatever the worktree node holds.
  const b = await openSessionDialog({ fs: fsTrust('trusted') }, project, target, { sessionCountAt: () => 0 });
  assert.equal(target.sessions.length, 2);
  click(flagBox(b.root, 'continue'));
  assert.equal(tid('continue-note', b.root), null);
  click(b.cancel);
  await b.result;
  b.daemon.restore();

  // No count passed.
  const c = await openSessionDialog({ fs: fsTrust('trusted') }, project, target);
  click(flagBox(c.root, 'continue'));
  assert.equal(tid('continue-note', c.root), null);
  click(c.cancel);
  await c.result;
  c.daemon.restore();

  // A new worktree has no session yet.
  const d = await openNew({ plan: (workdir, name) => planFor(name) }, project);
  click(flagBox(d.root, 'continue'));
  assert.equal(flagBox(d.root, 'continue').checked, true);
  assert.equal(tid('continue-note', d.root), null);
  click(d.cancel);
  await d.result;
  d.daemon.restore();
});

// --- T12: delete-session confirmation ---

/** Opens a confirmation and lets its initial focus land. */
function openConfirm(promise) {
  let settled = false;
  const result = promise.then((v) => { settled = true; return v; });
  page.flushFrames();
  const root = overlay();
  return { result, root, settled: () => settled, confirm: tid('dialog-confirm', root), cancel: tid('dialog-cancel', root) };
}

test('delete_session_keeps_worktree_note', async () => {
  const d = openConfirm(confirmDeleteSession({ name: '登录修复', worktreeLabel: 'fix-login', legacyWorktree: false }));
  assertShell(d.root);
  assert.ok(tid('delete-session-dialog', d.root), 'the dialog carries its test id');
  assert.equal(d.root.querySelector('.modal-title').textContent, '删除会话「登录修复」？');
  assert.ok(d.root.querySelector('.modal-body').textContent.includes('会话会结束，远程进程会被终止，无法撤销。'));
  assert.equal(tid('delete-session-note', d.root).textContent, 'worktree fix-login 的目录和分支都会保留，之后可以在侧边栏继续使用，或者单独删除。');
  assert.equal(d.confirm.textContent, '删除会话');
  assert.equal(document.activeElement, d.cancel, 'the initial focus is on Cancel');
  await settle();
  assert.equal(d.settled(), false, 'nothing is decided until a button is used');
  click(d.confirm);
  assert.equal(await d.result, true);
  assert.equal(overlay(), null);
});

test('delete_session_legacy_note', async () => {
  const legacy = t('session.delete.legacyWorktree');
  assert.ok(legacy.includes('旧版') && legacy.includes('一并删除'), legacy);
  for (const worktreeLabel of [undefined, 'fix-login']) {
    const d = openConfirm(confirmDeleteSession({ name: '接口限流', worktreeLabel, legacyWorktree: true }));
    assert.equal(tid('delete-session-note', d.root).textContent, legacy, 'the old-daemon note wins over the keep note');
    assert.equal(d.root.querySelectorAll('[data-testid="delete-session-note"]').length, 1);
    click(d.cancel);
    assert.equal(await d.result, false);
  }
});

test('delete_session_unknown_daemon_note', async () => {
  const unknown = t('session.delete.unknownWorktree');
  assert.ok(!unknown.includes('是旧版'), unknown);
  for (const worktreeLabel of [undefined, 'vibe/1794824025040-12b763ac']) {
    const d = openConfirm(confirmDeleteSession({ name: '接口限流', worktreeLabel, legacyWorktree: false, unknownWorktree: true }));
    assert.equal(tid('delete-session-note', d.root).textContent, unknown, 'neither promise is made while the version is not known');
    assert.equal(d.root.querySelectorAll('[data-testid="delete-session-note"]').length, 1);
    click(d.cancel);
    assert.equal(await d.result, false);
  }
  // A daemon known to be old keeps its own text.
  const e = openConfirm(confirmDeleteSession({ name: '接口限流', legacyWorktree: true, unknownWorktree: false }));
  assert.equal(tid('delete-session-note', e.root).textContent, t('session.delete.legacyWorktree'));
  click(e.cancel);
  await e.result;
});

test('delete_session_plain', async () => {
  const d = openConfirm(confirmDeleteSession({ name: 'notes', legacyWorktree: false }));
  assert.equal(tid('delete-session-note', d.root), null);
  assert.equal(d.root.querySelector('.modal-body').textContent, t('session.delete.body'));
  // A name is text, never markup.
  click(d.cancel);
  await d.result;
  const e = openConfirm(confirmDeleteSession({ name: '<img src=x onerror=alert(1)>', legacyWorktree: false }));
  assert.equal(e.root.querySelector('img'), null);
  assert.ok(e.root.querySelector('.modal-title').textContent.includes('<img src=x'));
  pressKey(e.cancel, 'Escape');
  assert.equal(await e.result, false);
  assert.equal(overlay(), null);
});

test('delete_session_enter_cancels', async () => {
  const d = openConfirm(confirmDeleteSession({ name: '登录修复', worktreeLabel: 'fix-login', legacyWorktree: false }));
  pressKey(document.activeElement, 'Enter');
  assert.equal(await d.result, false, 'Enter right after opening cancels');
  assert.equal(overlay(), null);
  // Enter on the delete button, once the user has moved there, deletes.
  const e = openConfirm(confirmDeleteSession({ name: '登录修复', legacyWorktree: false }));
  e.confirm.focus();
  pressKey(e.confirm, 'Enter');
  assert.equal(await e.result, true);
});

// --- T14: delete-worktree confirmation ---

const HEAD = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';
const status = (over = {}) => ({
  path: WT_PATH, project: MAIN, branch: 'fix-login', head: HEAD, main: false, managed: true,
  dirtyFiles: 0, unmergedCommits: 0, ignoredFiles: 0, sessions: [], ...over,
});
const EXT_PATH = '/r/devflow/.devflow-tmp/worktrees/general-skills';
const external = (over = {}) => status({ path: EXT_PATH, branch: 'change/general-skills', managed: false, ...over });
const detached = (over = {}) => {
  const st = status({ path: '/r/devflow-worktrees/tmp', managed: false, detached: true, ...over });
  delete st.branch;
  return st;
};

function openWt(st, opts = {}) {
  const d = openConfirm(confirmDeleteWorktree(st, { label: st.branch ?? st.head.slice(0, 7), changed: false, ...opts }));
  const dialog = tid('delete-wt-dialog', d.root);
  return {
    ...d, dialog, variant: dialog?.dataset.variant,
    force: tid('delete-wt-force', d.root),
    text: (id) => tid(id, d.root)?.textContent,
    has: (id) => tid(id, d.root) !== null,
    enter: () => pressKey(document.activeElement, 'Enter'),
  };
}
const BASE = { path: WT_PATH, head: HEAD, sessions: [] };

test('delete_wt_clean', async () => {
  const d = openWt(status({ sessions: ['s1'] }));
  assertShell(d.root);
  assert.equal(d.variant, 'clean');
  assert.equal(d.root.querySelector('.modal-title').textContent, '删除 worktree fix-login？');
  assert.ok(d.root.querySelector('.modal-body').textContent.includes('工作区是干净的，分支上的提交都已包含在其他分支里。目录和分支都会删除。'));
  for (const id of ['delete-wt-files', 'delete-wt-commits', 'delete-wt-external', 'delete-wt-keep-branch', 'delete-wt-force', 'delete-wt-changed', 'delete-wt-error', 'delete-wt-ignored', 'delete-wt-ended']) {
    assert.equal(d.has(id), false, id);
  }
  assert.equal(d.confirm.textContent, '删除');
  assert.equal(d.cancel.textContent, '取消');
  // Which worktree this is about: its directory and branch, as text.
  const body = d.root.querySelector('.modal-body').textContent;
  assert.ok(body.includes(WT_PATH) && body.includes('目录') && body.includes('分支'), body);
  click(d.confirm);
  assert.deepEqual(await d.result, { path: WT_PATH, head: HEAD, sessions: ['s1'], deleteBranch: true });
  assert.equal(overlay(), null);

  const e = openWt(status());
  click(e.cancel);
  assert.equal(await e.result, null);
  const f = openWt(status());
  pressKey(f.confirm, 'Escape');
  assert.equal(await f.result, null);
});

test('delete_wt_files', async () => {
  const d = openWt(status({ dirtyFiles: 3 }));
  assert.equal(d.variant, 'files');
  assert.equal(d.root.querySelector('.modal-title').textContent, 'fix-login 里有还没提交的文件');
  assert.equal(d.text('delete-wt-files'), '有 3 个文件未提交或未跟踪。删除 worktree 会丢弃它们，无法恢复。');
  assert.equal(document.activeElement, d.cancel, 'the initial focus is on Cancel');
  assert.ok(d.force, 'the confirm button is the force button');
  assert.equal(d.force.textContent, '仍然删除');
  assert.equal(d.confirm, null, 'no plain delete button next to it');
  assert.ok(d.root.querySelector('.modal-footer').textContent.includes('回车 = 取消'));
  click(d.cancel);
  assert.equal(await d.result, null);

  const e = openWt(status({ dirtyFiles: 3 }));
  click(e.force);
  // Clean history on a branch vibe-remote created: the branch goes too (see delete_wt_files_managed_merged).
  assert.deepEqual(await e.result, { ...BASE, discardFiles: true, deleteBranch: true });
});

test('delete_wt_commits', async () => {
  const d = openWt(status({ unmergedCommits: 2 }));
  assert.equal(d.variant, 'commits');
  assert.equal(d.root.querySelector('.modal-title').textContent, 'fix-login 有 2 个未合并的提交');
  assert.equal(d.text('delete-wt-commits'), '这 2 个提交不在其他任何本地分支或远程分支上。');
  const keep = tid('delete-wt-keep-branch', d.root);
  const drop = tid('delete-wt-delete-branch', d.root);
  assert.equal(keep.type, 'radio');
  assert.equal(keep.checked, true, 'keeping the branch is preselected');
  assert.equal(drop.checked, false);
  const options = d.root.querySelector('.modal-body').textContent;
  assert.ok(options.includes('只删目录、保留分支') && options.includes('提交还在分支 fix-login 上，以后可以再检出'), options);
  assert.ok(options.includes('目录和分支都删') && options.includes('这 2 个提交将不再属于任何分支'), options);
  assert.equal(d.has('delete-wt-force'), false);
  d.enter();
  assert.deepEqual(await d.result, BASE, 'Enter deletes the directory only');

  const e = openWt(status({ unmergedCommits: 2 }));
  const drop2 = tid('delete-wt-delete-branch', e.root);
  drop2.checked = true;
  drop2.dispatchEvent(new Event('change', { bubbles: true }));
  click(e.confirm);
  assert.deepEqual(await e.result, { ...BASE, deleteBranch: true, dropCommits: true });
});

test('delete_wt_external', async () => {
  const d = openWt(external({ unmergedCommits: 4 }));
  assert.equal(d.variant, 'external');
  assert.equal(d.root.querySelector('.modal-title').textContent, '删除 worktree change/general-skills？');
  const text = d.text('delete-wt-external');
  assert.ok(text.includes('不是由 vibe-remote 创建') && text.includes('change/general-skills'), text);
  assert.equal(d.has('delete-wt-keep-branch'), false, 'no branch choice: the branch always stays');
  assert.equal(d.has('delete-wt-delete-branch'), false);
  assert.equal(d.has('delete-wt-commits'), false);
  click(d.confirm);
  assert.deepEqual(await d.result, { path: EXT_PATH, head: HEAD, sessions: [] });
});

test('delete_wt_detached', async () => {
  const d = openWt(detached({ unmergedCommits: 2 }));
  assert.equal(d.variant, 'detached');
  assert.equal(d.root.querySelector('.modal-title').textContent, '9f8e7d6 有 2 个不属于任何分支的提交');
  assert.equal(d.text('delete-wt-commits'), '这 2 个提交删除后不再属于任何分支，无法恢复。');
  assert.equal(document.activeElement, d.cancel);
  assert.equal(d.has('delete-wt-keep-branch'), false);
  assert.equal(d.text('delete-wt-external'), '这个 worktree 不是由 vibe-remote 创建。');
  click(d.force);
  assert.deepEqual(await d.result, { path: '/r/devflow-worktrees/tmp', head: HEAD, sessions: [], dropCommits: true });
});

test('delete_wt_detached_clean', async () => {
  // The dialog goes by the status it is given; `managed` keeps the external line out of this case.
  const d = openWt(detached({ managed: true }));
  assert.equal(d.variant, 'clean');
  assert.ok(d.root.querySelector('.modal-body').textContent.includes(t('wt.delete.cleanDetached')));
  assert.ok(!d.root.querySelector('.modal-body').textContent.includes(t('wt.delete.clean')));
  assert.equal(d.has('delete-wt-force'), false);
  click(d.confirm);
  assert.deepEqual(await d.result, { path: '/r/devflow-worktrees/tmp', head: HEAD, sessions: [] });
});

test('delete_wt_external_detached', async () => {
  const d = openWt(detached());
  assert.equal(d.text('delete-wt-external'), t('wt.delete.externalDetached'));
  assert.ok(d.root.querySelector('.modal-body').textContent.includes(t('wt.delete.cleanDetached')));
  assert.equal(d.has('delete-wt-force'), false);
  d.enter();
  assert.deepEqual(await d.result, { path: '/r/devflow-worktrees/tmp', head: HEAD, sessions: [] });
});

test('delete_wt_sessions_line', async () => {
  const d = openWt(status({ sessions: ['s1', 's2'] }));
  assert.equal(d.variant, 'clean');
  assert.equal(d.text('delete-wt-sessions'), '会先结束这 2 个会话。');
  click(d.confirm);
  const req = await d.result;
  assert.deepEqual(req.sessions, ['s1', 's2']);
  const none = openWt(status());
  assert.equal(none.has('delete-wt-sessions'), false);
  click(none.cancel);
  await none.result;
});

test('delete_wt_ignored_note', async () => {
  const d = openWt(status({ ignoredFiles: 4 }));
  assert.equal(d.variant, 'clean', 'ignored files do not change what kind of dialog this is');
  assert.equal(d.has('delete-wt-files'), false);
  assert.equal(d.text('delete-wt-ignored'), '另有 4 个被 git 忽略的文件会一并删除。');
  d.enter();
  assert.deepEqual(await d.result, { ...BASE, deleteBranch: true }, 'Enter deletes; no consent goes with the note');

  for (const st of [status({ ignoredFiles: 0 }), (() => { const s = status(); delete s.ignoredFiles; return s; })()]) {
    const none = openWt(st);
    assert.equal(none.has('delete-wt-ignored'), false);
    click(none.cancel);
    await none.result;
  }

  const unknown = openWt(status({ ignoredFiles: -1 }));
  assert.equal(unknown.text('delete-wt-ignored'), t('wt.delete.ignoredUnknown'));
  assert.ok(!/\d/.test(unknown.text('delete-wt-ignored')), 'no number when it could not be counted');
  assert.equal(unknown.variant, 'clean');
  click(unknown.cancel);
  await unknown.result;

  const files = openWt(status({ dirtyFiles: 3, ignoredFiles: 4 }));
  assert.equal(files.variant, 'files');
  assert.ok(files.has('delete-wt-files') && files.has('delete-wt-ignored'));
  files.enter();
  assert.equal(await files.result, null, 'Enter still cancels');
});

test('delete_wt_files_and_commits', async () => {
  const st = status({ dirtyFiles: 3, unmergedCommits: 2 });
  const d = openWt(st);
  assert.equal(d.variant, 'files');
  assert.ok(d.has('delete-wt-files') && d.has('delete-wt-commits'));
  assert.equal(document.activeElement, d.cancel);
  assert.equal(tid('delete-wt-keep-branch', d.root).checked, true);
  d.enter();
  assert.equal(await d.result, null, 'Enter cancels');

  const e = openWt(st);
  click(e.force);
  assert.deepEqual(await e.result, { ...BASE, discardFiles: true });

  const f = openWt(st);
  const drop = tid('delete-wt-delete-branch', f.root);
  drop.checked = true;
  drop.dispatchEvent(new Event('change', { bubbles: true }));
  click(f.force);
  assert.deepEqual(await f.result, { ...BASE, discardFiles: true, deleteBranch: true, dropCommits: true });
});

test('delete_wt_files_managed_merged', async () => {
  const d = openWt(status({ dirtyFiles: 3 }));
  // The branch goes with the directory here, and the dialog says so.
  assert.ok(d.root.querySelector('.modal-body').textContent.includes(t('wt.delete.branchToo', { branch: 'fix-login' })));
  assert.ok(!d.root.querySelector('.modal-body').textContent.includes('工作区是干净的'));
  click(d.force);
  assert.deepEqual(await d.result, { ...BASE, discardFiles: true, deleteBranch: true });

  const ext = openWt(external({ dirtyFiles: 3 }));
  assert.equal(ext.variant, 'files');
  assert.ok(ext.has('delete-wt-external'));
  click(ext.force);
  assert.deepEqual(await ext.result, { path: EXT_PATH, head: HEAD, sessions: [], discardFiles: true });
});

test('delete_wt_enter_key', async () => {
  const cases = [
    ['clean', status(), { ...BASE, deleteBranch: true }],
    ['files', status({ dirtyFiles: 1 }), null],
    ['detached', detached({ unmergedCommits: 1 }), null],
    ['commits', status({ unmergedCommits: 2 }), BASE],
    ['files', status({ dirtyFiles: 1, unmergedCommits: 2 }), null],
    ['files', detached({ dirtyFiles: 1, unmergedCommits: 1 }), null],
    ['external', external(), { path: EXT_PATH, head: HEAD, sessions: [] }],
  ];
  for (const [variant, st, want] of cases) {
    const d = openWt(st);
    assert.equal(d.variant, variant);
    d.enter();
    const got = await d.result;
    if (want === null) assert.equal(got, null, `${variant}: Enter cancels`);
    else assert.deepEqual(got, { ...want, path: st.path }, `${variant}: Enter deletes`);
  }
  // Enter with the focus on a radio runs the default button, not nothing.
  const d = openWt(status({ unmergedCommits: 2 }));
  const keep = tid('delete-wt-keep-branch', d.root);
  keep.focus();
  pressKey(keep, 'Enter');
  assert.deepEqual(await d.result, BASE);
  // Once "delete the branch too" is chosen, Enter no longer deletes: only the button does.
  const e = openWt(status({ unmergedCommits: 2 }));
  const drop = tid('delete-wt-delete-branch', e.root);
  drop.checked = true;
  drop.dispatchEvent(new Event('change', { bubbles: true }));
  drop.focus();
  pressKey(drop, 'Enter');
  assert.equal(await e.result, null, 'Enter cancels when the choice would drop commits');
  // A button that has the focus is the one Enter presses.
  const f = openWt(status({ dirtyFiles: 1 }));
  f.force.focus();
  pressKey(f.force, 'Enter');
  assert.deepEqual(await f.result, { ...BASE, discardFiles: true, deleteBranch: true });
});

test('delete_wt_text_is_never_markup', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const d = openWt(status({ branch: evil, path: `/r/${evil}`, unmergedCommits: 1 }), { label: evil, changed: true, error: evil, ended: 1 });
  assert.equal(d.root.querySelector('img'), null);
  assert.ok(d.text('delete-wt-error').includes(evil));
  assert.ok(d.root.querySelector('.modal-title').textContent.includes(evil));
  click(d.cancel);
  await d.result;
});

// --- T14: delete-worktree flow ---

const restError = (httpStatus, code, body = {}) => new RestError(httpStatus, code, { error: code, ...body });
const abortError = () => Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });

/**
 * Runs deleteWorktreeFlow against scripted answers: `statuses` and `removes` are
 * consumed in order (a value is returned, an Error thrown). Returns helpers to
 * act on the dialog that is open.
 */
function startFlow({ statuses = [], removes = [] }) {
  const calls = { status: [], remove: [] };
  const next = (queue, what) => {
    if (queue.length === 0) throw new Error(`unexpected ${what} call`);
    const v = queue.shift();
    if (v instanceof Error) throw v;
    return v;
  };
  const rest = {
    worktreeStatus: async (path) => { calls.status.push(path); return next(statuses, 'worktreeStatus'); },
    removeWorktree: async (req) => { calls.remove.push(req); return next(removes, 'removeWorktree'); },
  };
  const notices = [];
  let settled = false;
  let outcome;
  const done = deleteWorktreeFlow(rest, { path: WT_PATH, label: 'fix-login' }, (text) => notices.push(text))
    .then((v) => { settled = true; outcome = v; return v; });
  const dialog = async () => {
    await settle(6);
    page.flushFrames();
    return overlay();
  };
  return {
    calls, notices, done, settled: () => settled, outcome: () => outcome, dialog,
    async act(testid) {
      const root = await dialog();
      assert.ok(root, `a dialog is open to click ${testid}`);
      click(tid(testid, root));
      await settle(6);
    },
  };
}

test('delete_flow_success', async () => {
  const st = status({ sessions: ['s1', 's2'] });
  const f = startFlow({ statuses: [st], removes: [{ removed: true, branchDeleted: true, endedSessions: ['s1', 's2'] }] });
  const root = await f.dialog();
  assert.equal(tid('delete-wt-dialog', root).dataset.variant, 'clean');
  assert.equal(tid('delete-wt-changed', root), null);
  await f.act('dialog-confirm');
  assert.deepEqual(await f.done, { removed: true, endedSessions: ['s1', 's2'] });
  assert.deepEqual(f.calls.status, [WT_PATH]);
  assert.deepEqual(f.calls.remove, [{ path: WT_PATH, head: HEAD, sessions: ['s1', 's2'], deleteBranch: true }]);
  assert.deepEqual(f.notices, []);
  assert.equal(overlay(), null);
});

test('delete_flow_cancel_before_any_request', async () => {
  const f = startFlow({ statuses: [status()] });
  await f.act('dialog-cancel');
  assert.equal(await f.done, null);
  assert.equal(f.calls.remove.length, 0);
  assert.deepEqual(f.notices, []);
});

test('delete_flow_404_notifies_gone', async () => {
  const f = startFlow({ statuses: [restError(404, 'worktree_not_found')] });
  assert.equal(await f.done, null);
  assert.equal(overlay(), null, 'no dialog');
  assert.deepEqual(f.notices, ['这个 worktree 已经不存在']);
  assert.equal(f.calls.remove.length, 0);

  // The first look failing some other way: nothing was asked for, say why.
  const g = startFlow({ statuses: [new Error('offline')] });
  assert.equal(await g.done, null);
  assert.equal(overlay(), null);
  assert.deepEqual(g.notices, [t('wt.delete.failed', { msg: 'offline' })]);
});

test('delete_flow_409_reconfirms', async () => {
  const f = startFlow({
    statuses: [status()],
    removes: [restError(409, 'worktree_changed', { status: status({ dirtyFiles: 1 }), endedSessions: [] }), { removed: true, branchDeleted: true, endedSessions: [] }],
  });
  await f.act('dialog-confirm');
  const root = await f.dialog();
  assert.equal(tid('delete-wt-changed', root).textContent, '状态刚刚发生了变化，请按最新的情况重新确认。');
  assert.equal(tid('delete-wt-dialog', root).dataset.variant, 'files', 'the dialog follows the new state');
  assert.ok(tid('delete-wt-files', root).textContent.includes('1'));
  assert.equal(tid('delete-wt-ended', root), null);
  assert.equal(f.calls.status.length, 1, 'the state comes with the 409, no second query');
  await f.act('delete-wt-force');
  assert.deepEqual(await f.done, { removed: true, endedSessions: [] });
  assert.deepEqual(f.calls.remove[1], { ...BASE, discardFiles: true, deleteBranch: true });
});

test('delete_flow_409_then_cancel', async () => {
  const f = startFlow({ statuses: [status()], removes: [restError(409, 'worktree_changed', { status: status({ dirtyFiles: 1 }), endedSessions: [] })] });
  await f.act('dialog-confirm');
  await f.act('dialog-cancel');
  assert.deepEqual(await f.done, { removed: false, endedSessions: [] }, 'not null once a removal was requested');
});

test('delete_flow_409_after_sessions_ended_then_cancel', async () => {
  const f = startFlow({
    statuses: [detached({ sessions: ['s1'] })],
    removes: [restError(409, 'worktree_changed', { status: detached({ head: 'b'.repeat(40), unmergedCommits: 1 }), endedSessions: ['s1'] })],
  });
  await f.act('dialog-confirm');
  const root = await f.dialog();
  assert.ok(tid('delete-wt-changed', root));
  assert.equal(tid('delete-wt-ended', root).textContent, '已结束 1 个会话。');
  assert.equal(tid('delete-wt-sessions', root), null);
  assert.equal(tid('delete-wt-dialog', root).dataset.variant, 'detached');
  await f.act('dialog-cancel');
  const out = await f.done;
  assert.notEqual(out, null);
  assert.deepEqual(out, { removed: false, endedSessions: ['s1'] });
});

test('delete_flow_500_reopens_with_error', async () => {
  const st = status({ sessions: ['s1', 's2'] });
  const f = startFlow({
    statuses: [st, st],
    removes: [restError(500, 'worktree_remove_failed', { message: 'this worktree is locked with git worktree lock (reason: usb)', endedSessions: [] })],
  });
  await f.act('dialog-confirm');
  const root = await f.dialog();
  assert.equal(f.calls.status.length, 2, 'the state is read again after a 500');
  assert.ok(tid('delete-wt-dialog', root), 'the same confirmation is open again');
  assert.equal(tid('delete-wt-error', root).textContent, '删除失败：this worktree is locked with git worktree lock (reason: usb)');
  assert.equal(tid('delete-wt-ended', root), null);
  assert.equal(tid('delete-wt-changed', root), null);
  assert.equal(tid('delete-wt-sessions', root).textContent, '会先结束这 2 个会话。');
  await f.act('dialog-cancel');
  assert.deepEqual(await f.done, { removed: false, endedSessions: [] });
  assert.deepEqual(f.notices, []);
});

test('delete_flow_500_after_sessions_ended', async () => {
  const f = startFlow({
    statuses: [status({ sessions: ['s1', 's2'] }), status()],
    removes: [restError(500, 'worktree_remove_failed', { message: 'fatal: simulated', endedSessions: ['s1', 's2'] })],
  });
  await f.act('dialog-confirm');
  const root = await f.dialog();
  assert.equal(tid('delete-wt-error', root).textContent, '删除失败：fatal: simulated');
  assert.equal(tid('delete-wt-ended', root).textContent, '已结束 2 个会话。');
  assert.equal(tid('delete-wt-sessions', root), null);
  await f.act('dialog-cancel');
  assert.deepEqual(await f.done, { removed: false, endedSessions: ['s1', 's2'] });
});

test('delete_flow_500_then_cancel', async () => {
  const f = startFlow({ statuses: [status(), status()], removes: [restError(500, 'worktree_remove_failed', { message: 'no', endedSessions: [] })] });
  await f.act('dialog-confirm');
  await f.act('dialog-cancel');
  assert.deepEqual(await f.done, { removed: false, endedSessions: [] }, 'not null');
});

test('delete_flow_500_partial_shows_failure', async () => {
  const message = `error: failed to delete '${WT_PATH}': Permission denied`;
  const f = startFlow({
    statuses: [status({ sessions: ['s1', 's2'] }), restError(404, 'worktree_not_found')],
    removes: [restError(500, 'worktree_remove_failed', { message, endedSessions: ['s1', 's2'] })],
  });
  await f.act('dialog-confirm');
  const root = await f.dialog();
  assert.equal(tid('delete-wt-dialog', root), null, 'not the confirmation');
  const failed = tid('delete-wt-failed', root);
  assert.ok(failed);
  assertShell(root);
  assert.equal(root.querySelector('.modal-title').textContent, '删除 fix-login 没有完成');
  assert.equal(tid('delete-wt-error', root).textContent, `删除失败：${message}`);
  assert.equal(tid('delete-wt-ended', root).textContent, '已结束 2 个会话。');
  const partial = tid('delete-wt-partial', root).textContent;
  assert.ok(partial.includes(WT_PATH) && partial.includes('分支没有删除'), partial);
  const buttons = [...root.querySelectorAll('.modal-footer button')];
  assert.equal(buttons.length, 1, 'one button only');
  assert.equal(buttons[0].textContent, '关闭');
  assert.equal(buttons[0].dataset.testid, 'dialog-cancel');
  assert.equal(f.settled(), false);
  await f.act('dialog-cancel');
  assert.deepEqual(await f.done, { removed: false, endedSessions: ['s1', 's2'] });
  assert.equal(overlay(), null);

  // The helper on its own: no "ended" line without ended sessions; Enter and Escape close it.
  let closed = false;
  showDeleteWorktreeFailure({ label: 'fix-login', message: 'x', ended: 0, path: WT_PATH }).then(() => { closed = true; });
  page.flushFrames();
  assert.equal(tid('delete-wt-ended', overlay()), null);
  pressKey(document.activeElement, 'Enter');
  await settle();
  assert.equal(closed, true);
  assert.equal(overlay(), null);
});

test('delete_flow_500_status_query_fails', async () => {
  const f = startFlow({
    statuses: [status({ sessions: ['s1'] }), new Error('offline')],
    removes: [restError(500, 'worktree_remove_failed', { message: 'fatal: simulated', endedSessions: ['s1'] })],
  });
  await f.act('dialog-confirm');
  assert.deepEqual(await f.done, { removed: false, endedSessions: ['s1'] });
  assert.deepEqual(f.notices, [t('wt.delete.failed', { msg: 'fatal: simulated' })]);
  assert.equal(overlay(), null);
});

// The caller is told while a removal request is in flight, and only then:
// not while a confirmation is on screen.
test('delete_flow_reports_request_in_flight', async () => {
  const busy = [];
  let answer;
  const rest = {
    worktreeStatus: async () => status({ sessions: ['s1'] }),
    removeWorktree: () => new Promise((resolve, reject) => { answer = { resolve, reject }; }),
  };
  const done = deleteWorktreeFlow(rest, { path: WT_PATH, label: 'fix-login' }, () => {}, (inFlight) => busy.push(inFlight));
  await settle(6);
  page.flushFrames();
  assert.deepEqual(busy, [], 'nothing is in flight while the confirmation is open');
  click(tid('dialog-confirm', overlay()));
  await settle(6);
  assert.deepEqual(busy, [true]);
  // 409: the confirmation comes back, the request is over.
  answer.reject(restError(409, 'worktree_changed', { status: status({ sessions: ['s1'], dirtyFiles: 1 }), endedSessions: [] }));
  await settle(6);
  page.flushFrames();
  assert.ok(tid('delete-wt-changed', overlay()));
  assert.deepEqual(busy, [true, false]);
  click(tid('delete-wt-force', overlay()));
  await settle(6);
  assert.deepEqual(busy, [true, false, true]);
  answer.resolve({ removed: true, branchDeleted: true, endedSessions: ['s1'] });
  assert.deepEqual(await done, { removed: true, endedSessions: ['s1'] });
  assert.deepEqual(busy, [true, false, true, false]);
});

test('delete_flow_branch_error', async () => {
  const f = startFlow({ statuses: [status({ sessions: ['s1'] })], removes: [{ removed: true, branchDeleted: false, branchError: 'x', endedSessions: ['s1'] }] });
  await f.act('dialog-confirm');
  assert.deepEqual(await f.done, { removed: true, endedSessions: ['s1'] });
  assert.deepEqual(f.notices, ['目录已删除，分支没删掉：x']);
});

test('delete_flow_remove_404', async () => {
  const f = startFlow({ statuses: [status({ sessions: ['s1', 's2'] })], removes: [restError(404, 'worktree_not_found')] });
  await f.act('dialog-confirm');
  // The daemon refuses with 404 before it ends any session: the ones listed in
  // the confirmation are not reported as ended.
  assert.deepEqual(await f.done, { removed: true, endedSessions: [] });
  assert.deepEqual(f.notices, ['这个 worktree 已经不存在']);

  // Sessions an earlier answer of the same flow reported as ended still are.
  const g = startFlow({
    statuses: [status({ sessions: ['s1', 's2'] }), status({ sessions: ['s2'] })],
    removes: [restError(500, 'worktree_remove_failed', { message: 'fatal: simulated', endedSessions: ['s1'] }), restError(404, 'worktree_not_found')],
  });
  await g.act('dialog-confirm');
  await g.act('dialog-confirm');
  assert.deepEqual(await g.done, { removed: true, endedSessions: ['s1'] });
  assert.deepEqual(g.notices, ['这个 worktree 已经不存在']);
});

test('delete_flow_timeout_then_gone', async () => {
  const f = startFlow({ statuses: [status({ sessions: ['s1', 's2'] }), restError(404, 'worktree_not_found')], removes: [abortError()] });
  await f.act('dialog-confirm');
  assert.deepEqual(await f.done, { removed: true, endedSessions: ['s1', 's2'] });
  assert.deepEqual(f.notices, [], 'it is simply gone: nothing to report');
  assert.equal(overlay(), null, 'no error dialog');
});

test('delete_flow_timeout_still_there', async () => {
  const timeoutText = '删除请求没有收到结果，这个 worktree 可能还在删除中，稍后以侧边栏显示的为准';
  for (const second of [status({ sessions: ['s1'] }), new Error('offline')]) {
    const f = startFlow({ statuses: [status({ sessions: ['s1'] }), second], removes: [abortError()] });
    await f.act('dialog-confirm');
    assert.deepEqual(await f.done, { removed: false, endedSessions: [] });
    assert.deepEqual(f.notices, [timeoutText]);
    assert.equal(overlay(), null);
  }
  // Sessions an earlier answer reported as ended stay in the outcome.
  const g = startFlow({
    statuses: [status({ sessions: ['s1'] }), status()],
    removes: [restError(409, 'worktree_changed', { status: status({ dirtyFiles: 1 }), endedSessions: ['s1'] }), abortError()],
  });
  await g.act('dialog-confirm');
  await g.act('delete-wt-force');
  assert.deepEqual(await g.done, { removed: false, endedSessions: ['s1'] });
  assert.deepEqual(g.notices, [timeoutText]);
});

test('delete_flow_ended_union', async () => {
  const f = startFlow({
    statuses: [status({ sessions: ['a', 'b'] }), status()],
    removes: [
      restError(409, 'worktree_changed', { status: status({ sessions: ['b'], dirtyFiles: 1 }), endedSessions: ['a'] }),
      restError(500, 'worktree_remove_failed', { message: 'no', endedSessions: ['b', 'a'] }),
    ],
  });
  await f.act('dialog-confirm');
  await f.act('delete-wt-force');
  const root = await f.dialog();
  assert.equal(tid('delete-wt-ended', root).textContent, '已结束 2 个会话。');
  await f.act('dialog-cancel');
  assert.deepEqual(await f.done, { removed: false, endedSessions: ['a', 'b'] });
});

test('delete_flow_other_refusal', async () => {
  const f = startFlow({ statuses: [status()], removes: [restError(400, 'worktree_is_main', { message: 'the main directory of a repository cannot be removed' })] });
  await f.act('dialog-confirm');
  assert.deepEqual(await f.done, { removed: false, endedSessions: [] });
  assert.deepEqual(f.notices, [t('wt.delete.failed', { msg: 'the main directory of a repository cannot be removed' })]);
  assert.equal(overlay(), null);
});

await run();

// worktree-dialogs.ts: the new-worktree dialog (T9) and the new-session dialog
// for an existing worktree (T11). Driven through the real REST client against a
// fake daemon behind fetch.
import { strict as assert } from 'node:assert';
import { indexDom, load, runner } from './chat-test-util.mjs';
import { INFO_V4, afterDebounce, click, fakeDaemon, overlay, planFor, pressKey, settle, tid, typeInto } from './dialog-test-util.mjs';

await indexDom();
localStorage.setItem('vibe-remote.locale', 'zh');
let sockets = 0;
globalThis.WebSocket = class { constructor() { sockets++; } };
const { openNewWorktreeDialog, openWorktreeSessionDialog } = await load('src/renderer/worktree-dialogs.ts', { platform: 'browser' });
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

await run();

// worktree-dialogs.ts: the new-worktree dialog (T9). Driven through the real
// REST client against a fake daemon behind fetch.
import { strict as assert } from 'node:assert';
import { indexDom, load, runner } from './chat-test-util.mjs';
import { afterDebounce, click, fakeDaemon, overlay, planFor, pressKey, settle, tid, typeInto } from './dialog-test-util.mjs';

await indexDom();
localStorage.setItem('vibe-remote.locale', 'zh');
let sockets = 0;
globalThis.WebSocket = class { constructor() { sockets++; } };
const { openNewWorktreeDialog } = await load('src/renderer/worktree-dialogs.ts', { platform: 'browser' });
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

await run();

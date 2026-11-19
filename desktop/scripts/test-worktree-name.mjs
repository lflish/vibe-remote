// worktree-name.ts: the desktop side of the worktree name rules (T9). The
// vectors are shared with the daemon (vibe-remoted/internal/session/testdata),
// so the two ends cannot drift on what a name is rejected for.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { load, runner } from './chat-test-util.mjs';

// i18n (imported by worktree-name.ts) reads these at module load.
const store = new Map([['vibe-remote.locale', 'zh']]);
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });

const { validateWorktreeName, worktreeDirName, worktreeErrorText } = await load('src/renderer/worktree-name.ts');
const { t } = await load('src/renderer/i18n.ts');
const { test, run } = runner('test-worktree-name');

const vectors = JSON.parse(readFileSync('../vibe-remoted/internal/session/testdata/worktree-names.json', 'utf8'));

test('shared_vectors', () => {
  assert.ok(vectors.length >= 18, 'the shared vectors were read');
  let local = 0;
  for (const v of vectors) {
    const got = validateWorktreeName(v.name);
    if (v.ok) {
      assert.equal(got, null, `${JSON.stringify(v.name)} is a usable name`);
    } else if (v.local) {
      local++;
      assert.equal(got, v.reason, `${JSON.stringify(v.name)} is rejected locally as ${v.reason}`);
    }
    // ok:false without local (a~b, HEAD…) needs git; the desktop need not catch it.
  }
  assert.ok(local >= 12, 'the vectors include the locally decidable rules');
  for (const name of ['@{-1}', '@{-2}', 'a@{b']) assert.equal(validateWorktreeName(name), 'invalid', name);
  // A name breaking several rules reports the first one in the daemon's order.
  assert.equal(validateWorktreeName('-x y'), 'whitespace');
  assert.equal(validateWorktreeName('-a..b'), 'dotdot');
  assert.equal(validateWorktreeName('-@{-1}'), 'leading_dash');
});

test('dir_name', () => {
  assert.equal(worktreeDirName('change/foo'), 'change-foo');
  assert.equal(worktreeDirName('fix-login'), 'fix-login');
  assert.equal(worktreeDirName('a/b/c'), 'a-b-c');
});

test('error_text', () => {
  assert.equal(worktreeErrorText('worktree_branch_exists', { branch: 'fix-login' }), '分支 fix-login 已存在');
  assert.equal(worktreeErrorText('worktree_branch_exists', { branch: 'fix-login', conflict: 'fix-login' }), '分支 fix-login 已存在');
  const conflict = worktreeErrorText('worktree_branch_exists', { branch: 'fix/login', conflict: 'fix' });
  assert.equal(conflict, t('wt.error.branch_conflict', { branch: 'fix/login', conflict: 'fix' }));
  assert.ok(conflict.includes('fix/login') && conflict.includes('已有分支 fix'), conflict);
  assert.equal(worktreeErrorText('invalid_worktree_name', {}), 'git 不接受这个分支名');
  assert.equal(worktreeErrorText('worktree_path_exists', { path: '/r/devflow-worktrees/fix-login' }), '目录已存在：/r/devflow-worktrees/fix-login');
  assert.equal(
    worktreeErrorText('worktree_path_not_allowed', { path: '/r/devflow-worktrees/fix-login' }),
    '目录不在允许的范围内：/r/devflow-worktrees/fix-login',
  );
  assert.equal(worktreeErrorText('unsupported_repo', {}), t('wt.error.unsupported_repo'));
  assert.notEqual(t('wt.error.unsupported_repo'), 'wt.error.unsupported_repo', 'the key exists');
  assert.equal(worktreeErrorText('not_git', {}), '这个目录不在 git 仓库里');
  assert.equal(worktreeErrorText('create_failed', {}), null);
  assert.equal(worktreeErrorText('something_new', { branch: 'x' }), null);
});

await run();

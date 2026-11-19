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

// Two rules the daemon applies before git (review G9); the shared vector file
// is the daemon's, so the cases are spelled out here. Both come after the older
// rules and report `invalid`.
test('segment_length_and_invisible_characters', () => {
  const bytes = (text) => new TextEncoder().encode(text).length;
  // No path segment of the name may be longer than 250 bytes of UTF-8: the
  // segment becomes a file name under refs/heads/ and in the worktree folder.
  assert.equal(validateWorktreeName('a'.repeat(250)), null);
  assert.equal(validateWorktreeName('a'.repeat(251)), 'invalid');
  assert.equal(validateWorktreeName(`${'a'.repeat(250)}/${'b'.repeat(250)}`), null, 'the limit is per segment, not for the whole name');
  assert.equal(validateWorktreeName(`fix/${'a'.repeat(251)}`), 'invalid');
  assert.equal(validateWorktreeName(`${'a'.repeat(251)}/fix`), 'invalid');
  assert.equal(validateWorktreeName(`fix/${'a'.repeat(251)}/x`), 'invalid');
  // Bytes, not characters.
  assert.equal(bytes('名'.repeat(83)), 249);
  assert.equal(validateWorktreeName('名'.repeat(83)), null);
  assert.equal(bytes('名'.repeat(84)), 252);
  assert.equal(validateWorktreeName('名'.repeat(84)), 'invalid', '84 characters, 252 bytes');
  assert.equal(validateWorktreeName(`${'名'.repeat(83)}a`), null, 'exactly 250 bytes');
  assert.equal(validateWorktreeName(`${'名'.repeat(83)}ab`), 'invalid', '251 bytes');

  // Format characters (Unicode Cf) cannot be seen in a name: zero-width space
  // and joiners, direction controls, the byte order mark, soft hyphen.
  for (const [what, ch] of [
    ['zero-width space', '\u200b'], ['zero-width non-joiner', '\u200c'], ['zero-width joiner', '\u200d'],
    ['left-to-right mark', '\u200e'], ['right-to-left override', '\u202e'], ['pop directional isolate', '\u2069'],
    ['word joiner', '\u2060'], ['byte order mark', '\ufeff'], ['soft hyphen', '\u00ad'], ['arabic letter mark', '\u061c'],
    ['language tag', '\u{e0001}'],
  ]) {
    assert.equal(validateWorktreeName(`fix${ch}login`), 'invalid', `${what} inside`);
    assert.equal(validateWorktreeName(`${ch}fix`), 'invalid', `${what} first`);
    assert.equal(validateWorktreeName(`fix${ch}`), 'invalid', `${what} last`);
  }
  // Line and paragraph separators (Zl, Zp) are refused too; the older
  // whitespace rule already names them.
  assert.equal(validateWorktreeName('a\u2028b'), 'whitespace');
  assert.equal(validateWorktreeName('a\u2029b'), 'whitespace');
  // Visible characters outside ASCII stay usable.
  for (const name of ['修复/登录', 'café', 'ñandú', 'fix-🚀', 'データ', 'a\u0301']) assert.equal(validateWorktreeName(name), null, name);

  // The older rules still answer first.
  assert.equal(validateWorktreeName(''), 'empty');
  assert.equal(validateWorktreeName(`a b${'x'.repeat(300)}`), 'whitespace');
  assert.equal(validateWorktreeName(' \u200b'), 'whitespace');
  assert.equal(validateWorktreeName(`a..${'x'.repeat(300)}`), 'dotdot');
  assert.equal(validateWorktreeName('a..\u200b'), 'dotdot');
  assert.equal(validateWorktreeName(`-${'x'.repeat(300)}`), 'leading_dash');
  assert.equal(validateWorktreeName('-\u200b'), 'leading_dash');
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

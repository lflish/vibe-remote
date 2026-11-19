// worktree-name.ts — the desktop side of the worktree name rules (design 4.1).
// The daemon decides; this only answers early what it can without git, in the
// daemon's order (vibe-remoted/internal/session/worktree.go worktreeNameProblem,
// shared vectors in testdata/worktree-names.json).
import { t } from './i18n';

export type WorktreeNameProblem = 'empty' | 'whitespace' | 'dotdot' | 'leading_dash' | 'invalid';

// Go's unicode.IsSpace and unicode.IsControl, spelled out: JavaScript's \s
// differs from the former (it has U+FEFF and lacks U+0085).
const SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// Characters nobody can see in a name: Unicode format characters (Cf: zero-width
// space and joiners, direction controls, the byte order mark…) and the line and
// paragraph separators (Zl, Zp).
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}]/u;
// The whole name, in bytes of UTF-8 (the daemon's maxWorktreeNameBytes): with
// its slashes turned into hyphens it becomes one directory name, and file
// systems stop at 255 bytes per name. So the limit is not per "/" part.
const MAX_NAME_BYTES = 250;
const utf8 = new TextEncoder();

/** Returns the first rule the name breaks, or null when only git can still object. */
export function validateWorktreeName(name: string): WorktreeNameProblem | null {
  if (name === '') return 'empty';
  if (SPACE.test(name)) return 'whitespace';
  if (name.includes('..')) return 'dotdot';
  if (name.startsWith('-')) return 'leading_dash';
  // "@{" is git's syntax for the previous or upstream branch.
  if (name.includes('@{') || CONTROL.test(name)) return 'invalid';
  if (INVISIBLE.test(name)) return 'invalid';
  if (utf8.encode(name).length > MAX_NAME_BYTES) return 'invalid';
  return null;
}

/** The directory name a worktree named `name` gets: slashes become hyphens. */
export function worktreeDirName(name: string): string {
  return name.replaceAll('/', '-');
}

const ERROR_KEYS = new Set([
  'worktree_branch_exists',
  'worktree_path_exists',
  'worktree_path_not_allowed',
  'unsupported_repo',
  'not_git',
]);

/**
 * The text for a refused worktree name: a plan answer's `error`, or the code of
 * an attach error frame. Unknown codes return null (the caller keeps its
 * generic error text).
 */
export function worktreeErrorText(code: string, ctx: { branch?: string; path?: string; conflict?: string }): string | null {
  if (code === 'invalid_worktree_name') return t('wt.name.invalid');
  const branch = ctx.branch ?? '';
  // A different branch is in the way: git cannot keep `fix` next to `fix/login`.
  if (code === 'worktree_branch_exists' && ctx.conflict && ctx.conflict !== branch) {
    return t('wt.error.branch_conflict', { branch, conflict: ctx.conflict });
  }
  if (!ERROR_KEYS.has(code)) return null;
  return t(`wt.error.${code}`, { branch, path: ctx.path ?? '' });
}

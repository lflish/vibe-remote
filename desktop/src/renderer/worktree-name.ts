// worktree-name.ts — the desktop side of the worktree name rules (design 4.1).
export type WorktreeNameProblem = 'empty' | 'whitespace' | 'dotdot' | 'leading_dash' | 'invalid';

export function validateWorktreeName(_name: string): WorktreeNameProblem | null {
  return null;
}

export function worktreeDirName(name: string): string {
  return name;
}

export function worktreeErrorText(_code: string, _ctx: { branch?: string; path?: string; conflict?: string }): string | null {
  return null;
}

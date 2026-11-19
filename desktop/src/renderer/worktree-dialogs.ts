// worktree-dialogs.ts — dialogs for creating worktrees and sessions in them.
import type { MachineConfig } from '../shared/protocol';
import type { PickedSession } from './dirpicker';
import type { TreeProject } from './tree';

export function openNewWorktreeDialog(
  _machine: MachineConfig,
  _project: TreeProject,
): Promise<(PickedSession & { worktreeName: string; worktreePath: string }) | null> {
  return Promise.resolve(null);
}

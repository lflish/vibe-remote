// Whether a new session on this machine can use the chat UI, and if not, the
// reason to show on the greyed-out "Chat" card (R1.3, R1.4, R17.2, c3). Pure:
// the picker passes in what it has loaded (machine info, its error, and the
// listed directory's chatTrust).

import type { ChatTrust, MachineInfo } from '../rest';
import { CHAT_MIN_PROTO } from '../../shared/protocol';

export interface ChatAvailability {
  enabled: boolean;
  /** i18n key explaining why the card is disabled. */
  reasonKey?: string;
  params?: Record<string, string | number>;
  /** What the user has to upgrade, when that is the fix. */
  upgrade?: 'claude' | 'daemon';
}

const DAEMON_REASONS = new Set([
  'not_claude',
  'shell_syntax',
  'conflicting_args',
  'claude_not_found',
  'claude_too_old',
  'state_dir_unwritable',
]);

/**
 * `info` undefined and no `error` = still loading. `trust` is the listed
 * directory's chatTrust; only 'trusted' allows a chat session (c3: untrusted
 * and unknown alike, as the daemon decides).
 *
 * `opts.mainPath` is for a worktree that is not its project's main directory,
 * on a daemon that accepts worktree roots of a trusted main directory (v4):
 * the reason then names the main directory as the place to open claude once
 * (R4.4). Callers leave it out for everything else.
 */
export function chatAvailability(
  info?: MachineInfo,
  error?: unknown,
  trust?: ChatTrust,
  opts?: { mainPath?: string },
): ChatAvailability {
  if (!info) {
    if (error !== undefined) {
      const msg = error instanceof Error ? error.message : String(error);
      return { enabled: false, reasonKey: 'picker.ui.chat.reason.infoFailed', params: { msg } };
    }
    return { enabled: false, reasonKey: 'picker.ui.chat.reason.checking' };
  }
  const proto = info.proto ?? 1;
  if (proto < CHAT_MIN_PROTO || !info.chat) {
    return {
      enabled: false,
      reasonKey: 'picker.ui.chat.reason.daemonOld',
      params: { proto, want: CHAT_MIN_PROTO },
      upgrade: 'daemon',
    };
  }
  const chat = info.chat;
  if (!chat.supported) {
    const reason = chat.reason ?? '';
    if (reason === 'claude_too_old') {
      return {
        enabled: false,
        reasonKey: 'picker.ui.chat.reason.claude_too_old',
        params: { version: chat.claudeVersion || '?', min: chat.minClaudeVersion },
        upgrade: 'claude',
      };
    }
    if (DAEMON_REASONS.has(reason)) return { enabled: false, reasonKey: `picker.ui.chat.reason.${reason}` };
    return { enabled: false, reasonKey: 'picker.ui.chat.reason.other', params: { reason: reason || '?' } };
  }
  if (trust === 'untrusted' && opts?.mainPath) {
    return { enabled: false, reasonKey: 'picker.ui.chat.reason.worktree_untrusted', params: { path: opts.mainPath } };
  }
  if (trust !== 'trusted') return { enabled: false, reasonKey: 'picker.ui.chat.reason.workdir_untrusted' };
  return { enabled: true };
}

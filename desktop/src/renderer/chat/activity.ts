// Sidebar dot of a chat session and whether to raise a desktop notification
// (R16.1–R16.4). Pure: index.ts feeds it events from an open ChatView's live
// frames, or from the 5 s REST poll (activitySeq / epoch / state) for chat
// sessions not open here. No hooks involved — the state comes from claude's
// structured output (R16.4).
//
// Dots: 'output' = grey (new messages), 'idle' = green (turn finished),
// 'waiting' = yellow (a permission / plan / question prompt waits for you).

import type { ChatStatus } from '../../shared/protocol';

export type Dot = 'none' | 'output' | 'idle' | 'waiting';

/** What the REST session list says about a chat session. */
export interface RestSnapshot {
  state?: ChatStatus;
  activitySeq?: number;
  epoch?: string;
}

export type ActivityEvent =
  /** A live chat message arrived. */
  | { kind: 'chat' }
  /** A turn finished. */
  | { kind: 'result' }
  /** A new prompt is waiting for an answer. */
  | { kind: 'prompt' }
  /** No prompt is waiting any more (answered here or elsewhere, cancelled). */
  | { kind: 'promptsCleared' }
  /** A poll of a session not open here; `prev` absent = first sight. */
  | { kind: 'rest'; prev?: RestSnapshot; next: RestSnapshot }
  /** Outcome of a notification we asked the main process to show. */
  | { kind: 'notifyResult'; result: 'shown' | 'fallback' }
  /** The user clicked a notification for this session. */
  | { kind: 'notificationClick' };

export interface DotContext {
  /** The session is the one shown in the main area. */
  isActive: boolean;
  windowFocused: boolean;
}

export interface DotUpdate {
  dot: Dot;
  notify: boolean;
  /** Open (switch to) the session. Only ever set for a notification click (d12). */
  open?: boolean;
}

export function nextDot(prev: Dot, ev: ActivityEvent, ctx: DotContext): DotUpdate {
  // New messages and finished turns only mark sessions that are not the one
  // on screen (R16.1, R16.2).
  const shown = (dot: Dot): Dot => (ctx.isActive ? 'none' : dot);
  // "Needs you" also marks the session on screen while the window is in the
  // background (R16.3); it is seen once the window is focused with that
  // session in front.
  const seen = ctx.isActive && ctx.windowFocused;
  const waiting = (): Dot => (seen ? 'none' : 'waiting');
  switch (ev.kind) {
    case 'chat':
      return { dot: prev === 'waiting' ? waiting() : shown('output'), notify: false };
    case 'result':
      return { dot: shown('idle'), notify: false };
    case 'prompt':
      return { dot: waiting(), notify: !seen };
    case 'promptsCleared':
      return { dot: shown(prev === 'waiting' ? 'output' : prev), notify: false };
    case 'rest':
      return fromRest(prev, ev.prev, ev.next, ctx);
    case 'notifyResult':
      // Shown or not (d12: unsigned builds fall back to a Dock bounce), the
      // dot stays and the current session is never switched.
      return { dot: prev === 'waiting' ? waiting() : shown(prev), notify: false };
    case 'notificationClick':
      return { dot: 'none', notify: false, open: true };
  }
}

function fromRest(dot: Dot, prev: RestSnapshot | undefined, next: RestSnapshot, ctx: DotContext): DotUpdate {
  if (!prev) return { dot: ctx.isActive ? 'none' : dot, notify: false };
  if (next.state === 'waiting' && prev.state !== 'waiting') return nextDot(dot, { kind: 'prompt' }, ctx);
  if (next.state === 'idle' && (prev.state === 'running' || prev.state === 'waiting')) {
    return nextDot(dot, { kind: 'result' }, ctx);
  }
  if (prev.state === 'waiting' && next.state !== 'waiting') {
    const cleared = nextDot(dot, { kind: 'promptsCleared' }, ctx);
    return changed(prev, next) ? nextDot(cleared.dot, { kind: 'chat' }, ctx) : cleared;
  }
  if (changed(prev, next)) return nextDot(dot, { kind: 'chat' }, ctx);
  return { dot: ctx.isActive ? 'none' : dot, notify: false };
}

function changed(prev: RestSnapshot, next: RestSnapshot): boolean {
  return prev.epoch !== next.epoch || (prev.activitySeq ?? 0) !== (next.activitySeq ?? 0) || prev.state !== next.state;
}

// Virtual list window for the chat transcript (design 4.12, d13): the session
// keeps every message; the DOM only holds [start, end). Pure logic.

/** Messages rendered when a transcript first loads. */
export const INITIAL = 300;
/** Messages added per scroll to the top. */
export const PAGE = 200;

export interface Window {
  start: number;
  end: number;
}

/** The newest INITIAL messages of `total`. */
export function initialWindow(total: number): Window {
  return { start: Math.max(0, total - INITIAL), end: total };
}

/** Grows the window `page` messages upwards (scrolled to the top). */
export function expandUp(win: Window, page = PAGE): Window {
  return { start: Math.max(0, win.start - page), end: win.end };
}

/**
 * The window after the transcript grew or was rebuilt to `total` messages:
 * at the bottom it follows new messages, scrolled up it stays where it is. A
 * transcript shorter than the window (a reset rebuilt it) starts over.
 */
export function follow(win: Window, total: number, atBottom: boolean): Window {
  if (total < win.end) return initialWindow(total);
  if (!atBottom) return win;
  return { start: win.start, end: total };
}

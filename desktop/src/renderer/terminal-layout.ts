// Layout-only helpers for xterm initialization. Keeping the visibility gate
// outside Electron/xterm makes the startup race deterministic and testable.

export type LayoutElement = {
  clientWidth: number;
  clientHeight: number;
};

export type FrameScheduler = (callback: () => void) => void;

export function dimensionsWhenVisible<T>(
  element: LayoutElement,
  propose: () => T,
): T | null {
  if (element.clientWidth <= 0 || element.clientHeight <= 0) return null;
  return propose();
}

export function fitWhenVisible(
  element: LayoutElement,
  fit: () => void,
  scheduleFrame: FrameScheduler = (callback) => requestAnimationFrame(callback),
): void {
  if (element.clientWidth > 0 && element.clientHeight > 0) {
    fit();
    return;
  }

  // The element may be changing from display:none to block. Retry on the next
  // frame instead of fitting a zero-sized xterm; the ResizeObserver/window
  // resize paths handle later steady-state changes.
  scheduleFrame(() => {
    if (element.clientWidth > 0 && element.clientHeight > 0) fit();
  });
}

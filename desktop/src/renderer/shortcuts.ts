// shortcuts.ts — the keys that switch sessions (R7): ⌘1–⌘9 opens the n-th
// session the sidebar shows, ⌘⇧[ / ⌘⇧] the previous / next one, wrapping.

export type ShortcutAction = { kind: 'index'; n: number } | { kind: 'prev' } | { kind: 'next' };

const DIGIT = /^Digit([1-9])$/;

/**
 * The action a keydown stands for, or null. Decided by the physical key
 * (`code`): with ⇧ held, `key` is `{` / `}` or whatever the layout produces.
 * Only ⌘ may be held besides ⇧ — ⌘⌥ and ⌃⌘ combinations belong to others.
 */
export function matchShortcut(e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'code'>): ShortcutAction | null {
  if (!e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.shiftKey) {
    if (e.code === 'BracketLeft') return { kind: 'prev' };
    if (e.code === 'BracketRight') return { kind: 'next' };
    return null;
  }
  const digit = DIGIT.exec(e.code);
  return digit ? { kind: 'index', n: Number(digit[1]) } : null;
}

/**
 * The position to open among `count` sessions, or null to stay.
 * `activeIndex` is -1 when no session is shown: next is then the first one,
 * previous the last.
 */
export function pickTarget(count: number, activeIndex: number, action: ShortcutAction): number | null {
  if (count <= 0) return null;
  if (action.kind === 'index') return action.n <= count ? action.n - 1 : null;
  if (action.kind === 'next') return activeIndex < 0 ? 0 : (activeIndex + 1) % count;
  return activeIndex < 0 ? count - 1 : (activeIndex - 1 + count) % count;
}

/**
 * Listens on `target` in the capture phase, so the key is taken before the
 * terminal or a text field sees it: a shortcut never reaches the remote or
 * the input, even when there is nothing to switch to. While `blocked()` (a
 * dialog is open, a name is being edited) the keys are left alone entirely.
 * Returns the function that removes the listener.
 */
export function installShortcuts(
  target: Window,
  deps: { blocked(): boolean; count(): number; activeIndex(): number; open(index: number): void },
): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const action = matchShortcut(e);
    if (!action || deps.blocked()) return;
    e.preventDefault();
    e.stopPropagation();
    const index = pickTarget(deps.count(), deps.activeIndex(), action);
    if (index !== null) deps.open(index);
  };
  target.addEventListener('keydown', onKeyDown, true);
  return () => target.removeEventListener('keydown', onKeyDown, true);
}

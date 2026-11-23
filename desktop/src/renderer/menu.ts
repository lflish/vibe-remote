// menu.ts — a small dropdown list anchored to a button, used by the project
// and worktree "more" buttons in the sidebar (design 7.4). It opens under the
// button, or above it when there is no room below. Esc or a click outside
// closes it; only one menu is open at a time.
//
// Keyboard: opening moves the focus to the first item that can be chosen (the
// menu hangs off <body>, so Tab from the button would never get to it); the
// arrows, Home and End move between such items; Enter or Space choose; Esc and
// Tab close the menu, and whenever it closes while the focus is inside, the
// focus goes back to the button.
export interface MenuItem {
  label: string;
  testid: string;
  disabled?: boolean;
  note?: string;
  onClick?: () => void;
}

let current: { el: HTMLElement; anchor: HTMLElement; onKey: (e: KeyboardEvent) => void; onDown: (e: Event) => void } | null = null;

/** The button the open menu belongs to, or null when no menu is open. */
export function menuAnchor(): HTMLElement | null {
  return current?.anchor ?? null;
}

/**
 * Hands the open menu over to `anchor`: the sidebar rebuilt the row it belongs
 * to, and this is the same button in the new row. The menu stays open, moves
 * next to it, and a mousedown on it no longer counts as a click outside.
 */
export function moveMenu(anchor: HTMLElement): void {
  if (!current) return;
  current.anchor = anchor;
  // Marked before it is measured: see openMenu.
  anchor.setAttribute('aria-expanded', 'true');
  placeMenu(current.el, anchor);
}

export function closeMenu(): void {
  if (!current) return;
  const { el, anchor } = current;
  document.removeEventListener('keydown', current.onKey, true);
  document.removeEventListener('mousedown', current.onDown, true);
  anchor.removeAttribute('aria-expanded');
  // The focus does not go down with the menu.
  const focusInside = el.contains(document.activeElement);
  el.remove();
  current = null;
  if (focusInside && anchor.isConnected) anchor.focus({ preventScroll: true });
}

export function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'menu';
  for (const it of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menu-item';
    btn.dataset.testid = it.testid;
    btn.textContent = it.label;
    if (it.disabled) btn.disabled = true;
    btn.addEventListener('click', () => {
      if (it.disabled) return;
      // Closed first: the focus is back on the button when the action starts
      // (a dialog it opens remembers where to return the focus to).
      closeMenu();
      it.onClick?.();
    });
    el.appendChild(btn);
    if (it.note) {
      const note = document.createElement('div');
      note.className = 'menu-note';
      note.textContent = it.note;
      el.appendChild(note);
    }
  }
  el.style.position = 'fixed';
  document.body.appendChild(el);
  // The button says its menu is open. The stylesheet keeps a row's buttons in
  // place while one of them does: they otherwise show only while the row is
  // hovered or holds the focus, and the row the sidebar has just rebuilt is
  // neither yet — the menu would be put where the hidden button collapses to.
  anchor.setAttribute('aria-expanded', 'true');
  placeMenu(el, anchor);

  // The items that can be chosen, in order.
  const choices = () => [...el.querySelectorAll<HTMLButtonElement>('.menu-item')].filter((b) => !b.disabled);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
    // Tab leaves the menu: closed, the focus is on the button again, and the
    // key then moves it on from there as usual.
    if (e.key === 'Tab') { closeMenu(); return; }
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (step === 0 && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const list = choices();
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? list.length - 1
      : at < 0 ? (step > 0 ? 0 : list.length - 1)
      : (at + step + list.length) % list.length;
    list[next].focus({ preventScroll: true });
  };
  const onDown = (e: Event) => {
    const owner = current && current.el === el ? current.anchor : anchor;
    if (e.target instanceof Node && (el.contains(e.target) || owner.contains(e.target))) return;
    closeMenu();
  };
  current = { el, anchor, onKey, onDown };
  document.addEventListener('keydown', onKey, true);
  choices()[0]?.focus({ preventScroll: true });
  // Defer the outside-click listener so the click that opened the menu does not
  // immediately close it.
  setTimeout(() => {
    if (current && current.el === el) document.addEventListener('mousedown', onDown, true);
  }, 0);
}

// Keeps the menu this far from the window's edges.
const EDGE = 6;

// placeMenu puts the (already attached) menu next to its button: below it,
// left edges aligned; above it when the window ends before the menu does (a
// row at the bottom of the sidebar); and never past an edge of the window. The
// gap to the button is the stylesheet's margin-top.
function placeMenu(el: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  // Read once: the margin is taken over by the computed position below.
  if (el.dataset.gap === undefined) el.dataset.gap = String(parseFloat(window.getComputedStyle(el).marginTop) || 0);
  const gap = Number(el.dataset.gap);
  el.style.margin = '0';
  const { width, height } = el.getBoundingClientRect();
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  let top = rect.bottom + gap;
  if (top + height > viewH - EDGE && rect.top - gap - height >= EDGE) top = rect.top - gap - height;
  top = Math.max(EDGE, Math.min(top, viewH - EDGE - height));
  const left = Math.max(EDGE, Math.min(rect.left, viewW - EDGE - width));
  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
}

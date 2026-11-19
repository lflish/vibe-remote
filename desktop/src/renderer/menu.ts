// menu.ts — a small dropdown list anchored to a button, used by the project
// and worktree "more" buttons in the sidebar (design 7.4). It opens under the
// button, or above it when there is no room below. Esc or a click outside
// closes it; only one menu is open at a time.
export interface MenuItem {
  label: string;
  testid: string;
  disabled?: boolean;
  note?: string;
  onClick?: () => void;
}

let current: { el: HTMLElement; onKey: (e: KeyboardEvent) => void; onDown: (e: Event) => void } | null = null;

export function closeMenu(): void {
  if (!current) return;
  document.removeEventListener('keydown', current.onKey, true);
  document.removeEventListener('mousedown', current.onDown, true);
  current.el.remove();
  current = null;
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
      it.onClick?.();
      closeMenu();
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
  placeMenu(el, anchor);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
  };
  const onDown = (e: Event) => {
    if (e.target instanceof Node && (el.contains(e.target) || anchor.contains(e.target))) return;
    closeMenu();
  };
  current = { el, onKey, onDown };
  document.addEventListener('keydown', onKey, true);
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
  const gap = parseFloat(window.getComputedStyle(el).marginTop) || 0;
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

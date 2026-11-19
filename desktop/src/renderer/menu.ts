// menu.ts — a small dropdown list anchored under a button, used by the project
// and worktree "more" buttons in the sidebar (design 7.4). Esc or a click
// outside closes it; only one menu is open at a time.
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
  const rect = anchor.getBoundingClientRect();
  el.style.position = 'fixed';
  el.style.top = `${rect.bottom}px`;
  el.style.left = `${rect.left}px`;
  document.body.appendChild(el);

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

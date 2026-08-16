let modalId = 0;

const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Adds the desktop-dialog behavior shared by renderer modals: semantics,
 * Escape-to-close, a contained Tab order, and focus restoration.
 */
export function activateModal(
  overlay: HTMLElement,
  modal: HTMLElement,
  heading: HTMLElement,
  initialFocus: HTMLElement,
  requestClose: () => void,
): () => void {
  const previousFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const headingId = `modal-title-${++modalId}`;

  heading.id = headingId;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', headingId);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      requestClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = [...modal.querySelectorAll<HTMLElement>(focusableSelector)]
      .filter((element) => !element.hidden && element.getClientRects().length > 0);
    if (focusable.length === 0) {
      event.preventDefault();
      modal.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  overlay.addEventListener('keydown', onKeyDown);
  requestAnimationFrame(() => initialFocus.focus());

  return () => {
    overlay.removeEventListener('keydown', onKeyDown);
    if (previousFocus?.isConnected) previousFocus.focus();
  };
}

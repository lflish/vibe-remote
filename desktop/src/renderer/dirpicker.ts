import { VibeRemoteRest, type DirEntry } from './rest';
import type { MachineConfig } from '../shared/protocol';

/**
 * Remote directory picker modal — lets the user browse the remote machine's
 * filesystem (constrained to allowed_roots server-side) and pick a workdir
 * for a new claude session. Similar to VSCode Remote SSH "open folder".
 *
 * Uses safe DOM construction (textContent / createElement) — never innerHTML
 * with server-provided names.
 */
export function openDirPicker(
  machine: MachineConfig,
): Promise<{ workdir: string; flags: string[] } | null> {
  return new Promise((resolve) => {
    const rest = new VibeRemoteRest(machine);
    let currentPath = '';
    const flagChecks: Array<{ id: string; input: HTMLInputElement }> = [];

    // --- Build modal DOM ---
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal');

    const header = el('div', 'modal-header');
    header.textContent = `Choose folder on ${machine.name}`;
    modal.appendChild(header);

    const pathBar = el('div', 'modal-path');
    modal.appendChild(pathBar);

    const list = el('div', 'modal-list');
    modal.appendChild(list);

    const flagsBox = el('div', 'modal-flags');
    modal.appendChild(flagsBox);

    // Load selectable launch flags from the machine's info endpoint. Rendered as
    // checkboxes below the directory list; the picker still works (workdir only)
    // if info fails or the machine has no claude_flags configured.
    rest
      .info()
      .then((info) => {
        const flags = info.claude_flags || [];
        if (flags.length === 0) return;
        const title = el('div', 'modal-flags-title');
        title.textContent = 'Launch options';
        flagsBox.appendChild(title);
        for (const f of flags) {
          const row = el('label', 'modal-flag');
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = f.default === true;
          const span = document.createElement('span');
          span.textContent = f.label; // safe: textContent, not innerHTML
          row.append(input, span);
          flagsBox.appendChild(row);
          flagChecks.push({ id: f.id, input });
        }
      })
      .catch(() => {
        /* info failed: no flags shown, workdir selection still works */
      });

    const footer = el('div', 'modal-footer');
    const cancelBtn = el('button', 'btn-secondary');
    cancelBtn.textContent = 'Cancel';
    const selectBtn = el('button', 'btn-primary');
    selectBtn.textContent = 'Open here';
    footer.append(cancelBtn, selectBtn);
    modal.appendChild(footer);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // --- Behavior ---
    function close(result: { workdir: string; flags: string[] } | null) {
      overlay.remove();
      resolve(result);
    }

    async function load(path?: string) {
      try {
        const listing = await rest.listDir(path);
        currentPath = listing.path;
        renderPath(listing.path);
        renderEntries(listing.path, listing.entries);
      } catch (e) {
        list.textContent = '';
        const err = el('div', 'modal-error');
        err.textContent = `Failed to list directory: ${(e as Error).message}`;
        list.appendChild(err);
      }
    }

    function renderPath(path: string) {
      pathBar.textContent = path;
    }

    function renderEntries(path: string, entries: DirEntry[]) {
      list.textContent = '';

      // Parent directory entry (go up)
      const parent = parentPath(path);
      if (parent && parent !== path) {
        const up = el('div', 'modal-item modal-item-up');
        up.textContent = '.. (up)';
        up.addEventListener('click', () => load(parent));
        list.appendChild(up);
      }

      if (entries.length === 0) {
        const empty = el('div', 'modal-empty');
        empty.textContent = '(no subdirectories)';
        list.appendChild(empty);
        return;
      }

      for (const entry of entries) {
        const item = el('div', 'modal-item');
        const icon = el('span', 'modal-item-icon');
        icon.textContent = '📁';
        const name = el('span');
        name.textContent = entry.name; // safe: textContent, not innerHTML
        item.append(icon, name);
        item.addEventListener('click', () => load(entry.path));
        list.appendChild(item);
      }
    }

    cancelBtn.addEventListener('click', () => close(null));
    selectBtn.addEventListener('click', () => {
      const flags = flagChecks.filter((c) => c.input.checked).map((c) => c.id);
      close({ workdir: currentPath, flags });
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });

    // Start at default workdir
    load();
  });
}

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function parentPath(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return '/';
  return path.slice(0, idx);
}

import { VibeRemoteRest, type DirEntry } from './rest';
import type { MachineConfig, SessionMode } from '../shared/protocol';
import { t } from './i18n';

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
  initialMode: SessionMode = 'normal',
): Promise<{ workdir: string; flags: string[]; mode: SessionMode } | null> {
  return new Promise((resolve) => {
    const rest = new VibeRemoteRest(machine);
    let currentPath = '';
    let mode: SessionMode = initialMode;
    const flagChecks: Array<{ id: string; input: HTMLInputElement }> = [];

    // --- Build modal DOM ---
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal');

    const header = el('div', 'modal-header');
    header.textContent = t('picker.chooseFolder', { name: machine.name });
    modal.appendChild(header);

    const pathBar = el('div', 'modal-path');
    modal.appendChild(pathBar);

    const modesBox = el('div', 'modal-modes');
    const modesTitle = el('div', 'modal-flags-title');
    modesTitle.textContent = t('picker.sessionMode');
    modesBox.appendChild(modesTitle);
    const modeCards = [
      { value: 'normal' as const, title: t('picker.mode.normal.title'), description: t('picker.mode.normal.desc') },
      { value: 'worktree' as const, title: t('picker.mode.worktree.title'), description: t('picker.mode.worktree.desc') },
    ];
    const modeButtons: HTMLButtonElement[] = [];
    for (const card of modeCards) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'modal-mode-card';
      button.setAttribute('aria-pressed', String(card.value === mode));
      const title = el('span', 'modal-mode-title');
      title.textContent = card.title;
      const description = el('span', 'modal-mode-description');
      description.textContent = card.description;
      button.append(title, description);
      button.addEventListener('click', () => {
        mode = card.value;
        modeButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(modeCards[i].value === mode)));
        modeNote.hidden = mode !== 'worktree';
      });
      modeButtons.push(button);
      modesBox.appendChild(button);
    }
    const modeNote = el('div', 'modal-mode-note');
    modeNote.textContent = t('picker.modeNote');
    modeNote.hidden = mode !== 'worktree';
    modesBox.appendChild(modeNote);
    modal.appendChild(modesBox);

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
        title.textContent = t('picker.launchOptions');
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
    cancelBtn.textContent = t('picker.cancel');
    const selectBtn = el('button', 'btn-primary');
    selectBtn.textContent = t('picker.openHere');
    footer.append(cancelBtn, selectBtn);
    modal.appendChild(footer);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // --- Behavior ---
    function close(result: { workdir: string; flags: string[]; mode: SessionMode } | null) {
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
        err.textContent = t('picker.listFailed', { msg: (e as Error).message });
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
        up.textContent = t('picker.up');
        up.addEventListener('click', () => load(parent));
        list.appendChild(up);
      }

      if (entries.length === 0) {
        const empty = el('div', 'modal-empty');
        empty.textContent = t('picker.noSubdirs');
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
      close({ workdir: currentPath, flags, mode });
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

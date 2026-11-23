import { VibeRemoteRest, type ChatTrust, type DirEntry, type DirListing, type MachineInfo } from './rest';
import type { MachineConfig, SessionMode, SessionUI } from '../shared/protocol';
import { PROTOCOL_VERSION } from '../shared/protocol';
import { t } from './i18n';
import { activateModal } from './modal';
import { chatAvailability } from './chat/availability';
import { createFlagsSection, createNameSection, createUiSection } from './session-form';

// Naming a new worktree (attach.worktreeName, GET /api/v1/worktrees/plan) needs
// a protocol 4 daemon; an older one ignores the name and picks its own.
const WORKTREE_NAME_MIN_PROTO = 4;

export interface PickedSession {
  workdir: string;
  flags: string[];
  mode: SessionMode;
  /** Session kind (R1); terminal unless the user picked the chat card. */
  ui: SessionUI;
  /** Worktree mode on a protocol 4 daemon: the new branch, and the directory the daemon planned for it. */
  worktreeName?: string;
  worktreePath?: string;
}

/**
 * Remote directory picker modal — lets the user browse the remote machine's
 * filesystem (constrained to allowed_roots server-side) and pick a workdir
 * for a new claude session. Similar to VSCode Remote SSH "open folder".
 *
 * Uses safe DOM construction (textContent / createElement) — never innerHTML
 * with server-provided names.
 *
 * `opts.sessionCountAt(workdir)` is the number of live sessions already running
 * in that directory.
 */
export function openDirPicker(
  machine: MachineConfig,
  initialMode: SessionMode = 'normal',
  opts?: { sessionCountAt?(workdir: string): number },
): Promise<PickedSession | null> {
  return new Promise((resolve) => {
    const rest = new VibeRemoteRest(machine);
    let currentPath = '';
    let mode: SessionMode = initialMode;
    let info: MachineInfo | undefined;
    let infoError: unknown;
    let trust: ChatTrust | undefined;
    let listingReady = false;
    let confirming = false;
    let closed = false;
    let loadGeneration = 0;

    // --- Build modal DOM ---
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal');

    const header = el('h2', 'modal-header');
    header.textContent = t('picker.chooseFolder', { name: machine.name });
    modal.appendChild(header);

    const body = el('div', 'modal-body');
    modal.appendChild(body);

    const pathBar = el('div', 'modal-path');
    body.appendChild(pathBar);

    // Interface (R1.1, d4): terminal by default; chat only when the machine
    // and the listed folder allow it (R1.3, R1.4, c3).
    const uiSection = createUiSection({ onChange: refreshUI });
    body.appendChild(uiSection.el);

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
        refreshMode();
      });
      modeButtons.push(button);
      modesBox.appendChild(button);
    }
    const modeNote = el('div', 'modal-mode-note');
    modeNote.textContent = t('picker.modeNote');
    modeNote.hidden = mode !== 'worktree';
    modesBox.appendChild(modeNote);
    // Shown instead of the mode note when the machine info could not be read:
    // whether this daemon names worktrees is then unknown.
    const worktreeUnavailable = el('div', 'modal-mode-note modal-mode-note-error');
    worktreeUnavailable.dataset.testid = 'picker-worktree-unavailable';
    worktreeUnavailable.setAttribute('role', 'alert');
    worktreeUnavailable.textContent = t('picker.worktreeNeedsInfo');
    body.appendChild(modesBox);
    // Worktree mode on a protocol 4 daemon: the new worktree gets a name (R3.9).
    // It is in the dialog only while that applies; an older daemon keeps the
    // mode note and names the worktree itself (R9.1).
    const nameSection = createNameSection({
      plan: (name) => rest.planWorktree(currentPath, name),
      onChange: refreshUI,
    });

    const list = el('div', 'modal-list');
    list.setAttribute('aria-live', 'polite');
    body.appendChild(list);

    const flagsSection = createFlagsSection({ existingSessions: 0 });
    body.appendChild(flagsSection.el);

    // Load selectable launch flags from the machine's info endpoint. Rendered as
    // checkboxes below the directory list; the picker still works (workdir only)
    // if info fails or the machine has no claude_flags configured.
    rest
      .info()
      .then((loaded) => {
        if (closed) return;
        info = loaded;
        refreshMode();
        // Warn before the user commits to a session on an older daemon: it
        // accepts the attach and quietly ignores what it doesn't understand.
        const proto = loaded.proto ?? 1;
        if (proto < PROTOCOL_VERSION) {
          const warn = el('div', 'modal-mode-note');
          warn.setAttribute('role', 'note');
          warn.textContent = t('picker.oldDaemon', { proto, want: PROTOCOL_VERSION, version: loaded.version ?? '?' });
          body.insertBefore(warn, modesBox);
        }
        flagsSection.setFlags(loaded.claude_flags || []);
      })
      .catch((e: unknown) => {
        // info failed: no flags shown, workdir selection still works (terminal,
        // normal mode). Worktree mode is off: see worktreeBlocked().
        if (closed) return;
        infoError = e ?? new Error('info failed');
        refreshMode();
      });

    const footer = el('div', 'modal-footer');
    const cancelBtn = el('button', 'btn-secondary');
    (cancelBtn as HTMLButtonElement).type = 'button';
    cancelBtn.dataset.testid = 'dialog-cancel';
    cancelBtn.textContent = t('picker.cancel');
    const selectBtn = el('button', 'btn-primary');
    (selectBtn as HTMLButtonElement).type = 'button';
    selectBtn.dataset.testid = 'dialog-confirm';
    (selectBtn as HTMLButtonElement).disabled = true;
    selectBtn.textContent = t('picker.openHere');
    footer.append(cancelBtn, selectBtn);
    modal.appendChild(footer);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // --- Behavior ---
    const naming = () => mode === 'worktree' && (info?.proto ?? 1) >= WORKTREE_NAME_MIN_PROTO;
    // The machine info is in, or has failed. Before that the dialog knows
    // neither whether the daemon names worktrees nor which launch options are
    // on by default, so nothing can be confirmed yet.
    const infoSettled = () => info !== undefined || infoError !== undefined;
    // Without the machine info a protocol 4 daemon cannot be told from an older
    // one: confirming Worktree mode would create a worktree with no name there
    // (`vibe/<session id>`), which nothing cleans up afterwards.
    const worktreeBlocked = () => mode === 'worktree' && info === undefined && infoError !== undefined;

    // The sessions the new one would share its directory with. Worktree mode
    // starts in a worktree that does not exist yet.
    function syncExistingSessions() {
      const here = mode === 'worktree' || !currentPath ? 0 : opts?.sessionCountAt?.(currentPath) ?? 0;
      flagsSection.setExistingSessions(here);
    }

    // Re-evaluated whenever the mode or the machine info changes.
    function refreshMode() {
      const named = naming();
      syncExistingSessions();
      const blocked = worktreeBlocked();
      modeNote.hidden = mode !== 'worktree' || named || blocked;
      if (blocked) modesBox.appendChild(worktreeUnavailable);
      else worktreeUnavailable.remove();
      if (named && !nameSection.el.isConnected) {
        modesBox.appendChild(nameSection.el);
        if (listingReady) nameSection.refresh();
      } else if (!named) {
        nameSection.el.remove();
      }
      refreshUI();
    }

    // Re-evaluated whenever the machine info, the listed folder, the chosen
    // interface or the worktree name changes.
    function refreshUI() {
      const a = chatAvailability(info, infoError, trust);
      const ui = uiSection.value();
      uiSection.setAvailability(a);
      flagsSection.setUI(ui);
      // Chat stays chosen if the user browses into a folder it can't use, but
      // nothing is created until they pick another folder or the terminal.
      (selectBtn as HTMLButtonElement).disabled = !listingReady || confirming
        || !infoSettled() || worktreeBlocked()
        || (ui === 'chat' && !a.enabled)
        || (naming() && !nameSection.ready());
    }

    let deactivateModal = () => {};
    function close(result: PickedSession | null) {
      if (closed) return;
      closed = true;
      deactivateModal();
      overlay.remove();
      resolve(result);
    }

    async function load(path?: string) {
      const generation = ++loadGeneration;
      list.setAttribute('aria-busy', 'true');
      listingReady = false;
      (selectBtn as HTMLButtonElement).disabled = true;
      list.textContent = '';
      const loading = el('div', 'modal-empty');
      loading.textContent = t('picker.loading');
      list.appendChild(loading);
      try {
        const listing = await rest.listDir(path);
        if (closed || generation !== loadGeneration) return;
        currentPath = listing.path;
        trust = listing.chatTrust;
        renderPath(listing.path);
        renderEntries(listing, listing.entries);
        listingReady = true;
        syncExistingSessions();
        // The base commit and the target directory depend on the listed folder.
        if (naming()) nameSection.refresh();
        refreshUI();
      } catch (e) {
        if (closed || generation !== loadGeneration) return;
        currentPath = '';
        trust = undefined;
        syncExistingSessions();
        refreshUI();
        list.textContent = '';
        const err = el('div', 'modal-error');
        err.setAttribute('role', 'alert');
        err.textContent = t('picker.listFailed', { msg: (e as Error).message });
        list.appendChild(err);
      } finally {
        if (generation === loadGeneration) list.removeAttribute('aria-busy');
      }
    }

    function renderPath(path: string) {
      pathBar.textContent = path;
    }

    function renderEntries(listing: DirListing, entries: DirEntry[]) {
      list.textContent = '';

      // Parent directory entry (go up). The server reports the parent only when
      // it is actually listable, so at an allowed root we show a disabled hint
      // instead of a button that would always 403. Older daemons omit `parent`
      // entirely; fall back to deriving it so they keep working (an out-of-root
      // click there still surfaces a readable error).
      const parent = listing.parent !== undefined
        ? listing.parent
        : parentPath(listing.path);
      if (parent && parent !== listing.path) {
        const up = el('button', 'modal-item modal-item-up') as HTMLButtonElement;
        up.type = 'button';
        up.textContent = t('picker.up');
        up.addEventListener('click', () => load(parent));
        list.appendChild(up);
      } else {
        const atRoot = el('div', 'modal-item modal-item-up modal-item-disabled');
        atRoot.textContent = t('picker.atRoot');
        list.appendChild(atRoot);
      }

      if (entries.length === 0) {
        const empty = el('div', 'modal-empty');
        empty.textContent = t('picker.noSubdirs');
        list.appendChild(empty);
        return;
      }

      for (const entry of entries) {
        const item = el('button', 'modal-item') as HTMLButtonElement;
        item.type = 'button';
        const icon = folderIcon();
        const name = el('span');
        name.textContent = entry.name; // safe: textContent, not innerHTML
        item.append(icon, name);
        item.addEventListener('click', () => load(entry.path));
        list.appendChild(item);
      }
    }

    cancelBtn.addEventListener('click', () => close(null));
    selectBtn.addEventListener('click', async () => {
      const picked: PickedSession = { workdir: currentPath, flags: flagsSection.value(), mode, ui: uiSection.value() };
      if (!naming()) {
        close(picked);
        return;
      }
      // Ask once more: the name may have been taken since it was typed.
      confirming = true;
      refreshUI();
      const plan = await nameSection.confirm();
      confirming = false;
      if (closed) return;
      if (!plan || !plan.branch || !plan.path || picked.workdir !== currentPath) {
        refreshUI();
        return;
      }
      close({ ...picked, worktreeName: plan.branch, worktreePath: plan.path });
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });
    const termCard = uiSection.el.querySelector<HTMLElement>('[data-testid="picker-ui-terminal"]')!;
    deactivateModal = activateModal(overlay, modal, header, termCard, () => close(null));

    refreshMode();
    // Start at default workdir
    load();
  });
}

function folderIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'modal-item-icon');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M2.5 5.5h5l1.5 2h8.5v7.75a1.25 1.25 0 0 1-1.25 1.25H3.75a1.25 1.25 0 0 1-1.25-1.25V5.5Zm0 2h15');
  svg.appendChild(path);
  return svg;
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

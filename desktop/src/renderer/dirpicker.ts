import { VibeRemoteRest, type ChatTrust, type DirEntry, type DirListing, type MachineInfo } from './rest';
import type { MachineConfig, SessionMode, SessionUI } from '../shared/protocol';
import { PROTOCOL_VERSION } from '../shared/protocol';
import { t } from './i18n';
import { activateModal } from './modal';
import { chatAvailability } from './chat/availability';

export interface PickedSession {
  workdir: string;
  flags: string[];
  mode: SessionMode;
  /** Session kind (R1); terminal unless the user picked the chat card. */
  ui: SessionUI;
}

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
): Promise<PickedSession | null> {
  return new Promise((resolve) => {
    const rest = new VibeRemoteRest(machine);
    let currentPath = '';
    let mode: SessionMode = initialMode;
    // Interface (R1.1, d4): terminal by default; chat only when the machine
    // and the listed folder allow it (R1.3, R1.4, c3).
    let ui: SessionUI = 'terminal';
    let info: MachineInfo | undefined;
    let infoError: unknown;
    let trust: ChatTrust | undefined;
    let listingReady = false;
    let closed = false;
    let loadGeneration = 0;
    const flagChecks: Array<{ id: string; input: HTMLInputElement }> = [];

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

    const uiBox = el('div', 'modal-modes modal-ui');
    const uiTitle = el('div', 'modal-flags-title');
    uiTitle.textContent = t('picker.ui.title');
    const uiCards = el('div', 'modal-ui-cards');
    const termCard = uiCard('terminal', t('picker.ui.terminal.title'), t('picker.ui.terminal.desc'));
    const chatCard = uiCard('chat', t('picker.ui.chat.title'), t('picker.ui.chat.desc'), t('picker.ui.chat.only'));
    const chatReason = el('span', 'modal-ui-reason');
    chatReason.dataset.testid = 'picker-ui-chat-reason';
    chatCard.appendChild(chatReason);
    uiCards.append(termCard, chatCard);
    const uiNote = el('div', 'modal-mode-note');
    const uiFixed = el('div', 'modal-mode-note');
    uiFixed.textContent = t('picker.ui.note.fixed');
    uiBox.append(uiTitle, uiCards, uiNote, uiFixed);
    body.appendChild(uiBox);
    termCard.addEventListener('click', () => setUI('terminal'));
    chatCard.addEventListener('click', () => {
      if (!chatCard.disabled) setUI('chat');
    });

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
    body.appendChild(modesBox);

    const list = el('div', 'modal-list');
    list.setAttribute('aria-live', 'polite');
    body.appendChild(list);

    const flagsBox = el('div', 'modal-flags');
    body.appendChild(flagsBox);
    // How -c / bypass behave in the chat interface (prototype scene 4).
    const flagNote = el('div', 'modal-mode-note modal-ui-flag-note');
    flagNote.textContent = t('picker.ui.flagNote');

    // Load selectable launch flags from the machine's info endpoint. Rendered as
    // checkboxes below the directory list; the picker still works (workdir only)
    // if info fails or the machine has no claude_flags configured.
    rest
      .info()
      .then((loaded) => {
        if (closed) return;
        info = loaded;
        refreshUI();
        // Warn before the user commits to a session on an older daemon: it
        // accepts the attach and quietly ignores what it doesn't understand.
        const proto = loaded.proto ?? 1;
        if (proto < PROTOCOL_VERSION) {
          const warn = el('div', 'modal-mode-note');
          warn.setAttribute('role', 'note');
          warn.textContent = t('picker.oldDaemon', { proto, want: PROTOCOL_VERSION, version: loaded.version ?? '?' });
          body.insertBefore(warn, modesBox);
        }
        const flags = loaded.claude_flags || [];
        if (flags.length === 0) return;
        const title = el('div', 'modal-flags-title');
        title.textContent = t('picker.launchOptions');
        flagsBox.appendChild(title);
        for (const f of flags) {
          const row = el('label', 'modal-flag');
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.name = `claude-flag-${f.id}`;
          input.checked = f.default === true;
          const span = document.createElement('span');
          span.textContent = f.label; // safe: textContent, not innerHTML
          row.append(input, span);
          flagsBox.appendChild(row);
          flagChecks.push({ id: f.id, input });
        }
        flagsBox.appendChild(flagNote);
      })
      .catch((e: unknown) => {
        // info failed: no flags shown, workdir selection still works (terminal).
        if (closed) return;
        infoError = e;
        refreshUI();
      });

    const footer = el('div', 'modal-footer');
    const cancelBtn = el('button', 'btn-secondary');
    (cancelBtn as HTMLButtonElement).type = 'button';
    cancelBtn.textContent = t('picker.cancel');
    const selectBtn = el('button', 'btn-primary');
    (selectBtn as HTMLButtonElement).type = 'button';
    (selectBtn as HTMLButtonElement).disabled = true;
    selectBtn.textContent = t('picker.openHere');
    footer.append(cancelBtn, selectBtn);
    modal.appendChild(footer);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // --- Behavior ---
    function setUI(next: SessionUI) {
      ui = next;
      refreshUI();
    }

    // Re-evaluated whenever the machine info or the listed folder changes.
    function refreshUI() {
      const a = chatAvailability(info, infoError, trust);
      chatCard.disabled = !a.enabled;
      chatCard.setAttribute('aria-disabled', String(!a.enabled));
      chatCard.classList.toggle('unavailable', !a.enabled);
      chatReason.hidden = a.enabled;
      chatReason.textContent = a.enabled || !a.reasonKey ? '' : t(a.reasonKey, a.params);
      termCard.setAttribute('aria-pressed', String(ui === 'terminal'));
      chatCard.setAttribute('aria-pressed', String(ui === 'chat'));
      uiNote.textContent = ui === 'chat' ? t('picker.ui.note.chat') : t('picker.ui.note.terminal');
      flagNote.hidden = ui !== 'chat';
      // Chat stays chosen if the user browses into a folder it can't use, but
      // nothing is created until they pick another folder or the terminal.
      (selectBtn as HTMLButtonElement).disabled = !listingReady || (ui === 'chat' && !a.enabled);
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
        refreshUI();
      } catch (e) {
        if (closed || generation !== loadGeneration) return;
        currentPath = '';
        trust = undefined;
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
    selectBtn.addEventListener('click', () => {
      const flags = flagChecks.filter((c) => c.input.checked).map((c) => c.id);
      close({ workdir: currentPath, flags, mode, ui });
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });
    deactivateModal = activateModal(overlay, modal, header, termCard, () => close(null));

    refreshUI();
    // Start at default workdir
    load();
  });
}

function uiCard(value: SessionUI, title: string, description: string, tag?: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'modal-mode-card modal-ui-card';
  button.dataset.testid = `picker-ui-${value}`;
  button.dataset.ui = value;
  const head = el('span', 'modal-mode-title');
  head.textContent = title;
  if (tag) {
    const only = el('span', 'modal-ui-only');
    only.textContent = tag;
    head.appendChild(only);
  }
  const desc = el('span', 'modal-mode-description');
  desc.textContent = description;
  button.append(head, desc);
  return button;
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

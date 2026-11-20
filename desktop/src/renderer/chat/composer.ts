// Chat input (R3.1, R3.4, R8–R11): a textarea with the permission-mode
// switcher, slash command menu, queued messages and send / stop button.
// Enter sends, Shift+Enter adds a line, Esc interrupts a running turn,
// Shift+Tab cycles the permission mode.

import { t } from '../i18n';
import type { ChatStatus, SlashCommand } from '../../shared/protocol';
import { filterSlashCommands, type QueueItem } from './queue';

export type SettableMode = 'default' | 'acceptEdits' | 'plan';

/** Shift+Tab order (R11.1). */
export const MODE_CYCLE: readonly SettableMode[] = ['default', 'acceptEdits', 'plan'];

export interface ComposerHandlers {
  /** Submit the input text; returns true when it was taken (the input clears). */
  onSubmit(text: string): boolean;
  onInterrupt(): void;
  onSetMode(mode: SettableMode): void;
  onRemoveQueued(id: string): void;
  /** "Continue in a new terminal session" from the terminal-only notice; absent = no button. */
  onHandoff?: () => void;
}

export interface ComposerState {
  status: ChatStatus;
  connected: boolean;
  ended: boolean;
  /** Right side of the hint line (machine · workdir). */
  where: string;
  mode: string;
  locked: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function modeLabel(mode: string): string {
  switch (mode) {
    case 'acceptEdits':
    case 'plan':
    case 'bypassPermissions':
    case 'default':
      return t(`chat.mode.${mode}`);
    default:
      return mode;
  }
}

export class Composer {
  readonly root: HTMLElement;
  readonly input: HTMLTextAreaElement;
  private box: HTMLElement;
  private sendBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;
  private modeChip: HTMLButtonElement;
  private modeMenu: HTMLElement;
  private slashBtn: HTMLButtonElement;
  private slashMenu: HTMLElement;
  private queueList: HTMLElement;
  private notice: HTMLElement;
  private hintLeft: HTMLElement;
  private hintRight: HTMLElement;
  private state: ComposerState = { status: 'idle', connected: false, ended: false, where: '', mode: 'default', locked: false };
  private slashCommands: readonly SlashCommand[] = [];
  private slashItems: SlashCommand[] = [];
  private slashIndex = 0;
  private queueKey = '';
  /** Command named by the open terminal-only notice ('' = none). */
  private terminalOnlyCmd = '';

  constructor(private handlers: ComposerHandlers) {
    this.root = el('div', 'cwrap');
    this.box = el('div', 'composer');

    this.input = el('textarea', 'c-in');
    this.input.rows = 1;
    this.input.dataset.testid = 'chat-input';
    this.input.addEventListener('focus', () => this.box.classList.add('focus'));
    this.input.addEventListener('blur', () => this.box.classList.remove('focus'));
    this.input.addEventListener('input', () => {
      this.autosize();
      this.syncButtons();
      this.hideTerminalOnly();
      this.refreshSlash();
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));

    const bar = el('div', 'c-bar');
    this.modeChip = el('button', 'chip');
    this.modeChip.type = 'button';
    this.modeChip.dataset.testid = 'chat-mode';
    this.modeChip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleModeMenu();
    });
    this.slashBtn = el('button', 'ib', '/');
    this.slashBtn.type = 'button';
    this.slashBtn.addEventListener('click', () => {
      if (!this.input.value) this.input.value = '/';
      this.input.focus();
      this.refreshSlash();
    });
    const spacer = el('span', 'sp');

    this.sendBtn = el('button', 'send');
    this.sendBtn.type = 'button';
    this.sendBtn.dataset.testid = 'chat-send';
    this.sendBtn.appendChild(arrowIcon());
    this.sendBtn.addEventListener('click', () => this.submit());

    this.stopBtn = el('button', 'send stop');
    this.stopBtn.type = 'button';
    this.stopBtn.dataset.testid = 'chat-stop';
    this.stopBtn.addEventListener('click', () => this.handlers.onInterrupt());

    bar.append(this.modeChip, this.slashBtn, spacer, this.sendBtn, this.stopBtn);
    this.box.append(this.input, bar);

    this.modeMenu = el('div', 'menu mode-menu');
    this.modeMenu.hidden = true;
    this.modeMenu.setAttribute('role', 'menu');
    this.slashMenu = el('div', 'menu slash-menu');
    this.slashMenu.hidden = true;
    this.slashMenu.dataset.testid = 'chat-slash-menu';
    this.slashMenu.setAttribute('role', 'listbox');
    this.queueList = el('div', 'queue');
    this.notice = el('div', 'c-notice');
    this.notice.dataset.testid = 'chat-terminal-only';
    this.notice.hidden = true;

    const hint = el('div', 'c-hint');
    this.hintLeft = el('span');
    this.hintRight = el('span', 'c-where');
    hint.append(this.hintLeft, this.hintRight);
    this.root.append(this.modeMenu, this.slashMenu, this.queueList, this.notice, this.box, hint);

    document.addEventListener('click', this.closeModeMenuOnOutside);
    this.relabel();
  }

  private closeModeMenuOnOutside = (e: MouseEvent) => {
    if (!this.modeMenu.hidden && !this.modeMenu.contains(e.target as Node)) this.modeMenu.hidden = true;
  };

  dispose() {
    document.removeEventListener('click', this.closeModeMenuOnOutside);
  }

  update(state: ComposerState) {
    this.state = state;
    // Nothing can be sent or handed off from here once the session has ended.
    if (state.ended) this.hideTerminalOnly();
    this.relabel();
  }

  /** Locale switch: also re-renders the open terminal-only notice. */
  relocalize() {
    if (this.terminalOnlyCmd) this.renderTerminalOnly();
    this.relabel();
  }

  setSlashCommands(commands: readonly SlashCommand[]) {
    if (commands === this.slashCommands) return;
    this.slashCommands = commands;
    if (!this.slashMenu.hidden) this.refreshSlash();
  }

  /** Shows the queued (not yet sent) messages, each removable (R9.1, R9.2). */
  setQueue(items: readonly QueueItem[]) {
    const key = items.map((i) => i.id).join(',') + t('chat.queue.queued');
    if (key === this.queueKey) return;
    this.queueKey = key;
    this.queueList.textContent = '';
    for (const item of items) {
      const row = el('div', 'qi');
      row.dataset.testid = 'chat-queue-item';
      row.dataset.clientMsgId = item.id;
      const remove = el('button', 'qi-x', '×');
      remove.type = 'button';
      remove.title = t('chat.queue.remove');
      remove.setAttribute('aria-label', t('chat.queue.remove'));
      remove.addEventListener('click', () => this.handlers.onRemoveQueued(item.id));
      row.append(remove, el('span', 'qi-text', item.text), el('span', 'qi-tag', t('chat.queue.queued')));
      this.queueList.appendChild(row);
    }
  }

  /** "This command only works in the terminal" (R10.2); the input keeps the text. */
  showTerminalOnly(command: string) {
    this.terminalOnlyCmd = command;
    this.renderTerminalOnly();
  }

  private hideTerminalOnly() {
    this.terminalOnlyCmd = '';
    this.notice.hidden = true;
  }

  private renderTerminalOnly() {
    const command = this.terminalOnlyCmd;
    this.notice.textContent = '';
    this.notice.appendChild(el('span', undefined, t('chat.slash.terminalOnly', { cmd: command })));
    if (this.handlers.onHandoff) {
      const b = el('button', 'btn-s', t('chat.handoff'));
      b.type = 'button';
      b.addEventListener('click', () => this.handlers.onHandoff?.());
      this.notice.appendChild(b);
    }
    this.notice.hidden = false;
  }

  /** Re-applies texts (locale switch) and control states. */
  relabel() {
    const busy = this.state.status === 'running' || this.state.status === 'waiting';
    this.input.placeholder = busy ? t('chat.input.placeholderBusy') : t('chat.input.placeholder');
    this.input.setAttribute('aria-label', t('chat.input.label'));
    this.sendBtn.title = t('chat.send');
    this.sendBtn.setAttribute('aria-label', t('chat.send'));
    this.stopBtn.title = t('chat.stopTitle');
    this.stopBtn.textContent = '';
    const kbd = el('kbd', undefined, 'Esc');
    this.stopBtn.append(el('i'), document.createTextNode(t('chat.stop')), kbd);
    this.stopBtn.hidden = !busy || this.state.ended;
    this.sendBtn.hidden = !this.stopBtn.hidden;
    this.box.classList.toggle('dis', this.state.ended || !this.state.connected);
    this.input.disabled = this.state.ended;
    this.slashBtn.title = t('chat.slash.button');

    const mode = this.state.mode;
    this.modeChip.dataset.mode = mode;
    this.modeChip.className = `chip mode-${mode}`;
    this.modeChip.textContent = modeLabel(mode);
    const title = this.state.locked ? t('chat.mode.lockedTitle') : t('chat.mode.title', { mode: modeLabel(mode) });
    this.modeChip.title = title;
    this.modeChip.setAttribute('aria-label', title);
    this.modeChip.disabled = this.state.ended;

    this.hintLeft.textContent = this.state.ended
      ? t('chat.hint.ended')
      : !this.state.connected
        ? t('chat.hint.disconnected')
        : busy
          ? t('chat.hint.busy')
          : t('chat.hint.idle');
    this.hintRight.textContent = this.state.where;
    this.syncButtons();
  }

  focus() {
    if (!this.input.disabled) this.input.focus();
  }

  /** Puts text back into the input (interrupted queue, R9.3). */
  restore(text: string) {
    if (!text) return;
    this.input.value = this.input.value.trim() ? `${text}\n\n${this.input.value}` : text;
    this.autosize();
    this.syncButtons();
  }

  setText(text: string) {
    this.input.value = text;
    this.autosize();
    this.syncButtons();
  }

  submit() {
    const text = this.input.value;
    // Blank input sends nothing (R3.4).
    if (!text.trim() || this.state.ended) return;
    if (this.handlers.onSubmit(text)) {
      this.input.value = '';
      this.autosize();
      this.syncButtons();
      this.closeSlash();
    }
  }

  // --- permission mode (R11) ---

  private toggleModeMenu() {
    if (!this.modeMenu.hidden) {
      this.modeMenu.hidden = true;
      return;
    }
    this.modeMenu.textContent = '';
    // Started with --dangerously-skip-permissions: bypass only, and why (R11.2).
    const modes: string[] = this.state.locked ? ['bypassPermissions'] : [...MODE_CYCLE];
    for (const m of modes) {
      const item = el('button', `mi${m === this.state.mode ? ' on' : ''}`);
      item.type = 'button';
      item.dataset.testid = 'chat-mode-option';
      item.dataset.mode = m;
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(m === this.state.mode));
      item.append(el('span', 'ck', m === this.state.mode ? '✓' : ''), el('b', undefined, modeLabel(m)));
      item.disabled = this.state.locked;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this.modeMenu.hidden = true;
        if (!this.state.locked && m !== this.state.mode) this.handlers.onSetMode(m as SettableMode);
      });
      this.modeMenu.appendChild(item);
    }
    if (this.state.locked) {
      const why = el('div', 'mf', t('chat.mode.lockedReason'));
      why.dataset.testid = 'chat-mode-locked';
      this.modeMenu.appendChild(why);
    } else {
      this.modeMenu.appendChild(el('div', 'mf', t('chat.mode.cycleHint')));
    }
    this.modeMenu.hidden = false;
  }

  private cycleMode() {
    if (this.state.locked || this.state.ended) return;
    const i = MODE_CYCLE.indexOf(this.state.mode as SettableMode);
    this.handlers.onSetMode(MODE_CYCLE[(i + 1) % MODE_CYCLE.length]);
  }

  // --- slash menu (R10.1) ---

  private refreshSlash() {
    this.slashItems = filterSlashCommands(this.slashCommands, this.input.value);
    if (!this.slashItems.length) {
      this.closeSlash();
      return;
    }
    this.slashIndex = Math.min(this.slashIndex, this.slashItems.length - 1);
    const scrolled = this.slashMenu.scrollTop;
    this.slashMenu.textContent = '';
    const head = this.slashMenu.appendChild(el('div', 'mh', t('chat.slash.title')));
    let selected: HTMLElement | null = null;
    this.slashItems.forEach((c, i) => {
      const item = el('div', `mi${i === this.slashIndex ? ' on' : ''}`);
      item.dataset.testid = 'chat-slash-item';
      item.setAttribute('role', 'option');
      const name = `/${c.name.replace(/^\//, '')}`;
      item.appendChild(el('span', 'cmd', name)).title = name;
      if (c.description) item.appendChild(el('small', undefined, c.description)).title = c.description;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.pickSlash(i);
      });
      this.slashMenu.appendChild(item);
      if (i === this.slashIndex) selected = item;
    });
    this.slashMenu.hidden = false;
    this.revealSlashItem(selected, head.offsetTop, scrolled);
  }

  /** Restores the scroll position after a rebuild, moved just enough to show the selected row. */
  private revealSlashItem(item: HTMLElement | null, pad: number, scrolled: number) {
    if (!item) return;
    const top = this.slashIndex ? item.offsetTop - pad : 0;
    const bottom = item.offsetTop + item.offsetHeight + pad - this.slashMenu.clientHeight;
    this.slashMenu.scrollTop = Math.min(top, Math.max(bottom, scrolled));
  }

  private closeSlash() {
    this.slashMenu.hidden = true;
    this.slashItems = [];
    this.slashIndex = 0;
  }

  private pickSlash(i: number) {
    const c = this.slashItems[i];
    if (!c) return;
    this.input.value = `/${c.name.replace(/^\//, '')} `;
    this.closeSlash();
    this.autosize();
    this.syncButtons();
    this.input.focus();
  }

  private onKey(e: KeyboardEvent) {
    if (e.isComposing) return;
    const slashOpen = !this.slashMenu.hidden && this.slashItems.length > 0;
    if (slashOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = this.slashItems.length;
        this.slashIndex = (this.slashIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        this.refreshSlash();
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        this.pickSlash(this.slashIndex);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeSlash();
        return;
      }
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      this.cycleMode();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.submit();
    } else if (e.key === 'Escape') {
      // Esc interrupts a running turn; when idle it does nothing (R8.3).
      const busy = this.state.status === 'running' || this.state.status === 'waiting';
      if (busy) {
        e.preventDefault();
        this.handlers.onInterrupt();
      }
    }
  }

  private syncButtons() {
    const empty = !this.input.value.trim();
    this.sendBtn.classList.toggle('idle', empty || this.state.ended);
    this.sendBtn.disabled = this.state.ended;
  }

  private autosize() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 240)}px`;
  }
}

function arrowIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M10 15.5v-11m-4.5 4.5L10 4.5l4.5 4.5');
  svg.appendChild(p);
  return svg;
}

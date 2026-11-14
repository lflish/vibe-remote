// Chat input (R3.1, R3.4, R8): a textarea, send / stop button and hint line.
// Enter sends, Shift+Enter adds a line, Esc interrupts a running turn.

import { t } from '../i18n';
import type { ChatStatus } from '../../shared/protocol';

export interface ComposerHandlers {
  /** Submit the input text; returns true when it was taken (the input clears). */
  onSubmit(text: string): boolean;
  onInterrupt(): void;
}

export interface ComposerState {
  status: ChatStatus;
  connected: boolean;
  ended: boolean;
  /** Right side of the hint line (machine · workdir). */
  where: string;
}

export class Composer {
  readonly root: HTMLElement;
  readonly input: HTMLTextAreaElement;
  private box: HTMLElement;
  private sendBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;
  private hintLeft: HTMLElement;
  private hintRight: HTMLElement;
  private bar: HTMLElement;
  private state: ComposerState = { status: 'idle', connected: false, ended: false, where: '' };

  constructor(private handlers: ComposerHandlers) {
    this.root = document.createElement('div');
    this.root.className = 'cwrap';
    this.box = document.createElement('div');
    this.box.className = 'composer';

    this.input = document.createElement('textarea');
    this.input.className = 'c-in';
    this.input.rows = 1;
    this.input.dataset.testid = 'chat-input';
    this.input.addEventListener('focus', () => this.box.classList.add('focus'));
    this.input.addEventListener('blur', () => this.box.classList.remove('focus'));
    this.input.addEventListener('input', () => {
      this.autosize();
      this.syncButtons();
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));

    this.bar = document.createElement('div');
    this.bar.className = 'c-bar';
    const spacer = document.createElement('span');
    spacer.className = 'sp';

    this.sendBtn = document.createElement('button');
    this.sendBtn.type = 'button';
    this.sendBtn.className = 'send';
    this.sendBtn.dataset.testid = 'chat-send';
    this.sendBtn.appendChild(arrowIcon());
    this.sendBtn.addEventListener('click', () => this.submit());

    this.stopBtn = document.createElement('button');
    this.stopBtn.type = 'button';
    this.stopBtn.className = 'send stop';
    this.stopBtn.dataset.testid = 'chat-stop';
    this.stopBtn.addEventListener('click', () => this.handlers.onInterrupt());

    this.bar.append(spacer, this.sendBtn, this.stopBtn);
    this.box.append(this.input, this.bar);

    const hint = document.createElement('div');
    hint.className = 'c-hint';
    this.hintLeft = document.createElement('span');
    this.hintRight = document.createElement('span');
    this.hintRight.className = 'c-where';
    hint.append(this.hintLeft, this.hintRight);
    this.root.append(this.box, hint);
    this.relabel();
  }

  /** Slot for controls before the spacer (mode switcher, slash button). */
  get leftBar(): HTMLElement {
    return this.bar;
  }

  /** The bordered input box (slash menu anchors above it). */
  get boxEl(): HTMLElement {
    return this.box;
  }

  update(state: ComposerState) {
    this.state = state;
    this.relabel();
  }

  /** Re-applies texts (locale switch) and button states. */
  relabel() {
    const busy = this.state.status === 'running' || this.state.status === 'waiting';
    this.input.placeholder = busy ? t('chat.input.placeholderBusy') : t('chat.input.placeholder');
    this.input.setAttribute('aria-label', t('chat.input.label'));
    this.sendBtn.title = t('chat.send');
    this.sendBtn.setAttribute('aria-label', t('chat.send'));
    this.stopBtn.title = t('chat.stopTitle');
    this.stopBtn.textContent = '';
    const sq = document.createElement('i');
    const kbd = document.createElement('kbd');
    kbd.textContent = 'Esc';
    this.stopBtn.append(sq, document.createTextNode(t('chat.stop')), kbd);
    this.stopBtn.hidden = !busy || this.state.ended;
    this.sendBtn.hidden = !this.stopBtn.hidden;
    this.box.classList.toggle('dis', this.state.ended || !this.state.connected);
    this.input.disabled = this.state.ended;
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
    }
  }

  private onKey(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
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

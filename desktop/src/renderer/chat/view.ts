// ChatView: one open chat session — its own connection (VibeRemoteClient, shared
// with terminal views for reconnect/backoff/watchdog/replay) and a transcript
// rendered from ChatSession. The DOM is a virtual window over the messages
// (d13): the newest 300 first, 200 more per scroll to the top. Rendering is
// batched to one frame; streaming text re-renders only the message that
// changed (per-message rev).

import type { MachineConfig, ChatAckFrame } from '../../shared/protocol';
import type { VibeRemoteClient } from '../client';
import { t } from '../i18n';
import { Composer, type SettableMode } from './composer';
import { createMarkdownRenderer } from './markdown';
import type { ActivityEvent } from './activity';
import { buildAnswer, type AnswerChoice } from './permission';
import { createPromptCard, type PromptCard } from './prompts';
import { classifySlash, SendQueue } from './queue';
import { ChatSession, endedView, type EndedAction, type TurnEvent } from './session';
import { renderToolBlock } from './tools';
import type { AssistantMessage, ChatState, Message, NoticeMessage, Part, Prompt, UserMessage } from './types';
import { expandUp, follow, initialWindow, type Window as ListWindow } from './window';

export type Activity = 'none' | 'output' | 'idle' | 'waiting';

/** clientMsgId for a chat message (≤64 chars, unique enough per desktop). */
export function newClientMsgId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `m-${Date.now().toString(36)}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

interface RenderedNode {
  el: HTMLElement;
  sig: string;
}

export class ChatView {
  readonly ui = 'chat' as const;
  key: string;
  sessionId: string;
  activity: Activity = 'none';
  warnedProto = false;
  readonly machine: MachineConfig;
  readonly client: VibeRemoteClient;
  readonly container: HTMLElement;
  readonly banner: HTMLElement;
  readonly session = new ChatSession();
  readonly queue: SendQueue;
  readonly composer: Composer;

  /** Fired when anything sidebar-relevant changes (status, prompts). */
  onActivity?: () => void;
  /** Status bar message for the user (send refused, …). */
  onMessage?: (text: string) => void;
  /** "Continue in a new terminal session" (handoff, wired by index.ts). */
  onHandoff?: () => void;
  /**
   * Sidebar-dot events from live frames (R16): new messages, turn results,
   * new / cleared prompts. Not fired for history or a reset sync's replay.
   */
  onActivityEvent?: (ev: ActivityEvent, prompt?: Prompt) => void;
  /** Ended banner: restart the claude process (reload, same conversation). */
  onRestart?: () => void;
  /** Ended banner (version too old): probe claude again, then restart. */
  onRecheck?: () => void;
  /** Ended banner (handed off): open the terminal session that took over. */
  onOpenTerminal?: (sessionId: string) => void;

  private transcript: HTMLElement;
  private inner: HTMLElement;
  private spinner: HTMLElement;
  private welcome: HTMLElement;
  private bottom: HTMLElement;
  private nodes = new Map<string, RenderedNode>();
  private card: PromptCard | null = null;
  private cardWrap: HTMLElement | null = null;
  private toolOpen = new Map<string, boolean>();
  private win: ListWindow = { start: 0, end: 0 };
  private renderedMessages: Message[] | null = null;
  private frame = 0;
  private connected = false;
  private synced = false;
  // Activity bookkeeping (onActivityEvent).
  private syncing = false;
  private syncBacklog = false;
  private firstSync = true;
  // A reset sync is rebuilding the transcript (history comes in batches with
  // frames between): keep the window on the newest messages until it ends.
  private clampTail = false;
  private seenPrompts = new Set<string>();
  private hadPrompts = false;
  // Reload in flight (REST 202): the outcome arrives as chat_state (d10).
  private epoch = '';
  private restarting = false;
  private restartFromEpoch = '';
  private endedEl: HTMLElement;
  private endedSig = '';
  private workdir = '';
  private renderMarkdown = createMarkdownRenderer(window, {
    copyLabel: t('chat.copy'),
    copiedLabel: t('chat.copied'),
  });

  constructor(machine: MachineConfig, client: VibeRemoteClient, key: string, sessionId: string, workdir = '') {
    this.machine = machine;
    this.client = client;
    this.key = key;
    this.sessionId = sessionId;
    this.workdir = workdir;

    this.container = el('div', 'chat-instance');
    this.container.dataset.testid = 'chat-view';
    const chat = el('div', 'chat');
    this.transcript = el('div', 'tl');
    this.transcript.dataset.testid = 'chat-transcript';
    this.inner = el('div', 'tl-in');
    this.spinner = el('div', 'spin');
    this.welcome = el('div', 'welcome');
    this.transcript.append(this.welcome, this.inner);
    this.bottom = el('div', 'chat-bottom');

    this.banner = el('div', 'reconnect-banner');
    this.banner.style.display = 'none';
    const bannerText = el('span', 'reconnect-banner-text', t('banner.reconnecting'));
    const retry = el('button', 'reconnect-banner-retry', t('banner.retry'));
    retry.type = 'button';
    retry.addEventListener('click', () => this.client.reconnectNow());
    this.banner.append(bannerText, retry);

    this.queue = new SendQueue((item) => this.sendNow(item.id, item.text), newClientMsgId);
    const handoff = () => this.onHandoff;
    this.composer = new Composer({
      onSubmit: (text) => this.submit(text),
      onInterrupt: () => this.interrupt(),
      onSetMode: (mode) => this.setMode(mode),
      onRemoveQueued: (id) => {
        this.queue.remove(id);
        this.schedule();
      },
      // Read when the notice shows: the button appears only once index.ts wires a handoff.
      get onHandoff() {
        return handoff();
      },
    });
    this.endedEl = el('div', 'chat-ended');
    this.endedEl.dataset.testid = 'chat-ended';
    this.endedEl.hidden = true;
    this.bottom.append(this.endedEl, this.composer.root);
    chat.append(this.transcript, this.bottom);
    this.container.append(chat, this.banner);

    this.transcript.addEventListener('scroll', () => this.onScroll());
    this.transcript.addEventListener('toggle', (e) => {
      const d = e.target as HTMLElement;
      if (d instanceof HTMLDetailsElement && d.dataset.toolUseId) this.toolOpen.set(d.dataset.toolUseId, d.open);
    }, true);

    this.session.onUpdate = () => this.schedule();
    this.session.onTurn = (ev) => this.onTurn(ev);
    this.wireClient();
    this.renderWelcome();
    this.updateComposer();
  }

  /** The bottom area (prompts replace the composer there). */
  get bottomEl(): HTMLElement {
    return this.bottom;
  }

  setWorkdir(workdir: string) {
    this.workdir = workdir;
    this.updateComposer();
  }

  setConnected(connected: boolean) {
    this.connected = connected;
    if (!connected) this.synced = false;
    this.updateComposer();
  }

  /** Called when this view becomes visible. */
  show() {
    this.schedule();
    requestAnimationFrame(() => this.composer.focus());
  }

  /** Locale switch: re-render texts. */
  relabel() {
    this.renderMarkdown = createMarkdownRenderer(window, { copyLabel: t('chat.copy'), copiedLabel: t('chat.copied') });
    const text = this.banner.querySelector('.reconnect-banner-text');
    if (text) text.textContent = t('banner.reconnecting');
    const retry = this.banner.querySelector('.reconnect-banner-retry');
    if (retry) retry.textContent = t('banner.retry');
    this.nodes.clear();
    this.endedSig = '';
    this.cardWrap?.remove();
    this.card = null;
    this.cardWrap = null;
    this.renderWelcome();
    this.updateComposer();
    this.schedule();
  }

  /** A reload request is about to be sent; its result comes back as chat_state. */
  beginRestart() {
    this.restarting = true;
    this.restartFromEpoch = this.epoch;
    this.schedule();
  }

  /** The reload request was refused (REST error): nothing is restarting. */
  cancelRestart() {
    this.restarting = false;
    this.schedule();
  }

  dispose() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.composer.dispose();
    this.client.disconnect();
    this.container.remove();
  }

  // --- connection ---

  private wireClient() {
    this.client.onChatSync = (sync) => {
      this.synced = false;
      this.syncing = true;
      // Missed messages caught up by an incremental sync are new activity; a
      // reset sync replays what was already there.
      this.syncBacklog = !sync.reset && sync.backlog > 0;
      this.epoch = sync.epoch;
      if (sync.reset) this.clampTail = true;
      this.session.applySync(sync);
    };
    this.client.onChat = (seq, msg, history) => {
      if (history) this.session.applyHistory(msg);
      else this.session.applyChat(seq, msg);
      if (!history && !this.syncing) {
        const m = msg as { type?: unknown; vr_stale?: unknown };
        this.onActivityEvent?.(m.type === 'result' && m.vr_stale !== true ? { kind: 'result' } : { kind: 'chat' });
      }
    };
    this.client.onChatState = (st) => {
      this.synced = true;
      const closingSync = this.syncing;
      this.syncing = false;
      this.session.applyState(st);
      this.trackRestart(st.ended);
      this.updateComposer();
      this.trackActivity(st.pending.map((p) => p.requestId), closingSync);
      this.onActivity?.();
    };
    this.client.onChatAck = (ack) => this.onAck(ack);
  }

  // Reload outcome (d10): success = running again under a new epoch;
  // restart_failed (or a handoff that won the race) ends it. `stopped` is the
  // reload's own first step.
  private trackRestart(ended: ChatState['ended']) {
    if (!this.restarting) return;
    if (!ended && this.epoch !== this.restartFromEpoch) {
      this.restarting = false;
      this.onMessage?.(t('chat.reload.done'));
    } else if (ended && ended.reason !== 'stopped') {
      this.restarting = false;
      if (ended.reason === 'restart_failed') this.onMessage?.(t('chat.reload.failed', { msg: ended.message || ended.reason }));
    }
  }

  private trackActivity(pendingIds: string[], closingSync: boolean) {
    const fresh = pendingIds.filter((id) => !this.seenPrompts.has(id));
    for (const id of fresh) this.seenPrompts.add(id);
    const first = this.firstSync;
    if (closingSync) this.firstSync = false;
    // Prompts already open when this view first synced were there before the
    // user opened it: they show as cards, not as a new notification.
    if (!first) {
      if (closingSync && this.syncBacklog) this.onActivityEvent?.({ kind: 'chat' });
      if (fresh.length > 0) {
        const prompt = this.session.getState().pending.find((p) => p.requestId === fresh[0]);
        this.onActivityEvent?.({ kind: 'prompt' }, prompt);
      } else if (this.hadPrompts && pendingIds.length === 0) {
        this.onActivityEvent?.({ kind: 'promptsCleared' });
      }
    }
    this.hadPrompts = pendingIds.length > 0;
  }

  private onAck(ack: ChatAckFrame) {
    if (ack.ok) {
      // Already written before (a resend, or a message whose echo a reset
      // sync could not replay): no new echo comes, the ack settles it.
      if (ack.op === 'send' && ack.ref && ack.duplicate) this.session.markDuplicate(ack.ref, ack.completed === true);
      return;
    }
    const why = ack.message || ack.code || '';
    switch (ack.op) {
      case 'send':
        if (ack.ref && ack.code !== 'empty') {
          this.session.markUndelivered(ack.ref);
          this.onMessage?.(t('chat.sendFailed', { msg: why }));
        }
        break;
      case 'respond':
        if (!ack.ref) break;
        if (ack.code === 'request_not_pending') {
          // Someone answered first, or claude withdrew it (R5.7).
          this.session.markHandledElsewhere(ack.ref);
        } else {
          // Not taken (queue full, rejected): answerable again.
          this.session.markOpen(ack.ref);
          this.onMessage?.(ack.code === 'chat_busy' ? t('chat.busy') : t('chat.respondFailed', { msg: why }));
        }
        break;
      case 'interrupt':
        this.onMessage?.(ack.code === 'chat_busy' ? t('chat.busy') : t('chat.interruptFailed', { msg: why }));
        break;
      case 'set_mode':
        this.onMessage?.(ack.code === 'mode_locked' ? t('chat.mode.lockedReason') : t('chat.mode.failed', { msg: why }));
        break;
    }
  }

  private answer(prompt: Prompt, choice: AnswerChoice) {
    const { response, setMode } = buildAnswer(prompt.request, choice);
    if (this.client.respond(prompt.requestId, response, setMode)) {
      this.session.markSubmitting(prompt.requestId);
    } else {
      this.onMessage?.(t('chat.hint.disconnected'));
    }
  }

  private setMode(mode: SettableMode) {
    if (!this.client.setMode(mode)) this.onMessage?.(t('chat.hint.disconnected'));
  }

  private resend(clientMsgId: string) {
    const msg = this.session
      .getState()
      .messages.find((m): m is UserMessage => m.role === 'user' && m.clientMsgId === clientMsgId);
    if (!msg || this.queue.has(clientMsgId)) return;
    this.queue.enqueue(msg.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''), clientMsgId);
    this.schedule();
  }

  private onTurn(ev: TurnEvent) {
    switch (ev.kind) {
      case 'echo':
        this.queue.onEcho(ev.clientMsgId);
        break;
      case 'result':
        this.queue.onResult(ev.stale);
        break;
      case 'staleTurn':
        this.queue.onStaleTurn(ev.clientMsgId);
        break;
      case 'undelivered':
        this.queue.onUndelivered(ev.clientMsgId);
        break;
      case 'unconfirmed':
        // Same id: the daemon answers a duplicate instead of writing it twice.
        if (!this.client.sendChat(ev.text, ev.clientMsgId)) this.session.markUndelivered(ev.clientMsgId);
        break;
      case 'duplicate':
        this.queue.onDuplicate(ev.clientMsgId, ev.completed);
        break;
      case 'reset':
        this.queue.resetPairing();
        break;
      case 'status':
        this.queue.setStatus(ev.status);
        break;
    }
  }

  // Sends one queued message. Held back while disconnected or mid-sync: a
  // message sent then could be judged undelivered by the sync that follows.
  private sendNow(id: string, text: string): boolean {
    if (!this.connected || !this.synced || this.session.getState().ended) return false;
    if (!this.client.sendChat(text, id)) return false;
    if (this.session.resend(id) === null) this.session.addLocalUser(id, text);
    return true;
  }

  private submit(text: string): boolean {
    // TUI-only commands are not sent; point at the terminal instead (R10.2).
    if (classifySlash(text, this.session.getState().slashCommands) === 'terminalOnly') {
      this.composer.showTerminalOnly(text.trim().split(/\s+/)[0]);
      return false;
    }
    const taken = this.queue.enqueue(text) !== null;
    this.schedule();
    return taken;
  }

  // Retry after a turn error: the same text as a new message (R13.1).
  private retry(text: string) {
    this.queue.enqueue(text);
    this.schedule();
  }

  private interrupt() {
    this.client.interrupt();
    // Queued messages go back to the input box, not out (R9.3).
    this.composer.restore(this.queue.takeBackAll());
    this.schedule();
  }

  private updateComposer() {
    const st = this.session.getState();
    const where = [this.machine.name, this.workdir].filter(Boolean).join(' · ');
    this.composer.update({
      status: st.status,
      connected: this.connected,
      ended: !!st.ended,
      where,
      mode: st.permissionMode,
      locked: st.permissionLocked,
    });
    this.composer.setSlashCommands(st.slashCommands);
    this.composer.setQueue(this.queue.queued());
  }

  // The first open prompt replaces the composer (prototype scenes 2/3); the
  // card is kept while it is the same request so typed notes survive.
  private renderPrompt(st: ChatState) {
    const prompt = st.pending[0];
    if (!prompt) {
      if (this.card) {
        this.cardWrap?.remove();
        this.card = null;
        this.cardWrap = null;
      }
      this.composer.root.hidden = false;
      return;
    }
    if (!this.card || this.card.requestId !== prompt.requestId) {
      this.cardWrap?.remove();
      this.card = createPromptCard(prompt, {
        cwd: this.workdir,
        renderMarkdown: (text) => this.renderMarkdown(text),
        onAnswer: (p, choice) => this.answer(p, choice),
        onInterrupt: () => this.interrupt(),
      });
      this.cardWrap = el('div', 'cwrap prompt-wrap');
      this.cardWrap.appendChild(this.card.el);
      this.bottom.insertBefore(this.cardWrap, this.composer.root);
      const card = this.card;
      requestAnimationFrame(() => card.el.focus());
    }
    this.card.update(prompt.state, st.pending.length - 1);
    this.composer.root.hidden = true;
  }

  // --- rendering ---

  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private atBottom(): boolean {
    const tl = this.transcript;
    return tl.scrollHeight - tl.scrollTop - tl.clientHeight < 48;
  }

  private onScroll() {
    if (this.transcript.scrollTop < 80 && this.win.start > 0) {
      const before = this.transcript.scrollHeight;
      this.win = expandUp(this.win);
      this.render(false);
      // Keep the message under the cursor in place while older ones load above.
      this.transcript.scrollTop += this.transcript.scrollHeight - before;
    }
  }

  private render(stick = true) {
    const st = this.session.getState();
    const msgs = st.messages;
    const bottom = this.atBottom();
    if (msgs !== this.renderedMessages) {
      // A reset sync rebuilt the transcript: start at the newest messages.
      this.renderedMessages = msgs;
      this.win = initialWindow(msgs.length);
      this.nodes.clear();
    } else if (this.clampTail) {
      // Still rebuilding (or just done): the newest messages only; scrolling
      // up extends the window once the sync is over.
      this.win = initialWindow(msgs.length);
    } else {
      this.win = follow(this.win, msgs.length, bottom);
    }
    const pendingTools = new Set(
      st.pending.map((p) => p.request.tool_use_id).filter((id): id is string => typeof id === 'string'),
    );

    if (!this.syncing) this.clampTail = false;

    const els: HTMLElement[] = [];
    const keep = new Set<string>();
    for (let i = this.win.start; i < this.win.end; i++) {
      const m = msgs[i];
      const sig = this.signature(m, pendingTools);
      let node = this.nodes.get(m.key);
      if (!node || node.sig !== sig) {
        node = { el: this.renderMessage(m, pendingTools), sig };
        this.nodes.set(m.key, node);
      }
      keep.add(m.key);
      els.push(node.el);
    }
    for (const k of [...this.nodes.keys()]) if (!keep.has(k)) this.nodes.delete(k);

    this.spinner.textContent = '';
    const running = st.status === 'running' && !st.ended;
    if (running) {
      const star = el('span', 'star', '✻');
      this.spinner.append(star, document.createTextNode(st.apiRetry ? t('chat.apiRetry', { attempt: st.apiRetry.attempt }) : t('chat.thinking')));
      els.push(this.spinner);
    }
    const same = els.length === this.inner.children.length && els.every((e, i) => this.inner.children[i] === e);
    if (!same) this.inner.replaceChildren(...els);
    this.welcome.hidden = msgs.length > 0 || !this.synced;

    // The bottom area (prompt card or composer) changes the transcript height:
    // settle it before sticking to the bottom.
    this.updateComposer();
    this.renderEnded(st);
    this.renderPrompt(st);
    if (stick && bottom) this.transcript.scrollTop = this.transcript.scrollHeight;
  }

  // "Session ended" banner above the (disabled) composer: why, and what can
  // be done about it (R13.2, R13.4, R14.1, R15.3).
  private renderEnded(st: ChatState) {
    const ended = st.ended;
    const view = this.restarting ? null : ended ? endedView(ended) : null;
    const sig = this.restarting ? 'restarting' : view ? `${ended?.reason}|${JSON.stringify(view.params)}|${view.detail ?? ''}|${ended?.handedOffTo ?? ''}` : '';
    if (sig === this.endedSig) return;
    this.endedSig = sig;
    this.endedEl.textContent = '';
    this.endedEl.hidden = !sig;
    delete this.endedEl.dataset.reason;
    if (!sig) return;
    if (this.restarting) {
      this.endedEl.dataset.reason = 'restarting';
      this.endedEl.appendChild(el('h4', undefined, t('chat.ended.restarting')));
      return;
    }
    if (!view || !ended) return;
    this.endedEl.dataset.reason = ended.reason;
    this.endedEl.appendChild(el('h4', undefined, t(view.titleKey, view.params)));
    if (view.detail) this.endedEl.appendChild(el('pre', 'chat-ended-detail', view.detail));
    const actions = el('div', 'chat-ended-actions');
    for (const action of view.actions) {
      const b = this.endedButton(action, ended.handedOffTo);
      if (b) actions.appendChild(b);
    }
    this.endedEl.appendChild(actions);
  }

  private endedButton(action: EndedAction, handedOffTo?: string): HTMLButtonElement | null {
    const spec: Record<EndedAction, { testid: string; label: string; primary: boolean; run?: () => void }> = {
      restart: { testid: 'chat-restart', label: t('chat.ended.restart'), primary: true, run: this.onRestart },
      recheck: { testid: 'chat-recheck', label: t('chat.ended.recheck'), primary: true, run: this.onRecheck },
      handoff: { testid: 'chat-handoff', label: t('chat.handoff'), primary: false, run: this.onHandoff },
      openTerminal: {
        testid: 'chat-open-terminal',
        label: t('chat.ended.openTerminal'),
        primary: true,
        run: handedOffTo && this.onOpenTerminal ? () => this.onOpenTerminal?.(handedOffTo) : undefined,
      },
    };
    const s = spec[action];
    if (!s.run) return null;
    const run = s.run;
    const b = el('button', s.primary ? 'btn-primary' : 'btn-secondary', s.label);
    b.type = 'button';
    b.dataset.testid = s.testid;
    b.addEventListener('click', () => run());
    return b;
  }

  private signature(m: Message, pendingTools: Set<string>): string {
    // A queued resend disables the bubble's resend button.
    if (m.role === 'user') return m.clientMsgId && this.queue.has(m.clientMsgId) ? `${m.rev}:q` : String(m.rev);
    if (m.role !== 'assistant') return String(m.rev);
    const waiting = m.parts.filter((p) => p.type === 'tool_use' && pendingTools.has(p.id)).map((p) => (p as { id: string }).id);
    return `${m.rev}:${waiting.join(',')}`;
  }

  private renderMessage(m: Message, pendingTools: Set<string>): HTMLElement {
    if (m.role === 'user') return this.renderUser(m);
    if (m.role === 'assistant') return this.renderAssistant(m, pendingTools);
    return this.renderNotice(m);
  }

  private renderUser(m: UserMessage): HTMLElement {
    const box = el('div', 'u-msg');
    box.dataset.testid = 'chat-msg-user';
    if (m.clientMsgId) box.dataset.clientMsgId = m.clientMsgId;
    box.appendChild(el('span', 'u-text', m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')));
    if (m.delivery === 'sending' || m.delivery === 'undelivered') {
      box.dataset.delivery = m.delivery;
      box.appendChild(el('span', `u-delivery ${m.delivery}`, t(`chat.delivery.${m.delivery}`)));
    }
    if (m.delivery === 'undelivered' && m.clientMsgId) {
      // Same clientMsgId: the daemon drops it if it did arrive after all (6.8).
      const id = m.clientMsgId;
      const again = el('button', 'u-resend', t('chat.resend'));
      again.type = 'button';
      again.dataset.testid = 'chat-resend';
      // Already queued to go out again: one resend per message.
      again.disabled = this.queue.has(id);
      again.addEventListener('click', () => this.resend(id));
      box.appendChild(again);
    }
    return box;
  }

  private renderPart(p: Part, pendingTools: Set<string>): HTMLElement {
    if (p.type === 'text') {
      const div = el('div', 'ti txt md');
      div.appendChild(this.renderMarkdown(p.text));
      return div;
    }
    if (p.type === 'thinking') {
      const div = el('div', 'ti thk');
      const d = el('details');
      d.append(el('summary', 'thk-s', t('chat.thought')), el('div', 'thk-b', p.text));
      div.appendChild(d);
      return div;
    }
    return renderToolBlock(p, pendingTools.has(p.id), this.toolOpen.get(p.id));
  }

  private renderAssistant(m: AssistantMessage, pendingTools: Set<string>): HTMLElement {
    const box = el('div', 'a-msg');
    box.dataset.testid = 'chat-msg-assistant';
    if (m.id) box.dataset.id = m.id;
    if (m.streaming) box.classList.add('streaming');
    if (m.interrupted) box.classList.add('interrupted');
    for (const p of m.parts) box.appendChild(this.renderPart(p, pendingTools));
    if (m.error) {
      const card = el('div', 'errc');
      card.dataset.testid = 'chat-turn-error';
      card.append(el('h4', undefined, t('chat.turnError')), el('pre', undefined, m.error));
      if (m.retryText) {
        const text = m.retryText;
        const retry = el('button', 'btn-secondary', t('chat.retry'));
        retry.type = 'button';
        retry.dataset.testid = 'chat-retry';
        retry.addEventListener('click', () => this.retry(text));
        card.appendChild(retry);
      }
      box.appendChild(card);
    }
    return box;
  }

  private renderNotice(n: NoticeMessage): HTMLElement {
    switch (n.kind) {
      case 'interrupted':
        return el('div', 'ghost chat-interrupted', t('chat.notice.interrupted'));
      case 'compact_summary': {
        const div = el('div', 'ti thk chat-compact');
        const d = el('details');
        d.append(el('summary', 'thk-s', t('chat.notice.compacted')), el('div', 'thk-b', n.text ?? ''));
        div.appendChild(d);
        return div;
      }
      case 'command_output': {
        const div = el('div', 'ti chat-command-output');
        const pre = el('pre', 'cmd-out', n.text ?? '');
        pre.title = t('chat.notice.commandOutput');
        div.appendChild(pre);
        return div;
      }
      case 'compact_boundary':
        return el('div', 'divider muted', t('chat.notice.compactBoundary'));
      case 'omitted': {
        const d = el('div', 'divider muted', t('chat.notice.omitted', { count: n.count ?? 0 }));
        d.dataset.testid = 'chat-omitted';
        return d;
      }
      case 'resync': {
        const wrap = el('div', 'chat-resync');
        wrap.dataset.testid = 'chat-resync-divider';
        wrap.append(el('div', 'ghost', t('chat.notice.dropped')), el('div', 'divider', t('chat.notice.resync', { count: n.count ?? 0 })));
        return wrap;
      }
      case 'prompt':
        return el('div', 'ghost', t(`chat.prompt.${n.outcome ?? 'cancelled'}`, { tool: n.toolName || '—' }));
      case 'notice':
      default:
        return el('div', 'ghost chat-notice', n.text ? `${n.code ?? ''}: ${n.text}` : (n.code ?? ''));
    }
  }

  private renderWelcome() {
    this.welcome.textContent = '';
    this.welcome.append(el('h3', undefined, t('chat.empty.title')), el('p', undefined, t('chat.empty.desc')));
  }

  /** Current chat state (for the sidebar dot / tests). */
  state(): ChatState {
    return this.session.getState();
  }
}

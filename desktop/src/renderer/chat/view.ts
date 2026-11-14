// ChatView: one open chat session — its own connection (VibeRemoteClient, shared
// with terminal views for reconnect/backoff/watchdog/replay) and a transcript
// rendered from ChatSession. The DOM is a virtual window over the messages
// (d13): the newest 300 first, 200 more per scroll to the top. Rendering is
// batched to one frame; streaming text re-renders only the message that
// changed (per-message rev).

import type { MachineConfig, ChatAckFrame } from '../../shared/protocol';
import type { VibeRemoteClient } from '../client';
import { t } from '../i18n';
import { Composer } from './composer';
import { createMarkdownRenderer } from './markdown';
import { SendQueue } from './queue';
import { ChatSession, type TurnEvent } from './session';
import { renderToolBlock } from './tools';
import type { AssistantMessage, ChatState, Message, NoticeMessage, Part, UserMessage } from './types';
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

  private transcript: HTMLElement;
  private inner: HTMLElement;
  private spinner: HTMLElement;
  private welcome: HTMLElement;
  private bottom: HTMLElement;
  private nodes = new Map<string, RenderedNode>();
  private toolOpen = new Map<string, boolean>();
  private win: ListWindow = { start: 0, end: 0 };
  private renderedMessages: Message[] | null = null;
  private frame = 0;
  private connected = false;
  private synced = false;
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
    this.composer = new Composer({
      onSubmit: (text) => this.submit(text),
      onInterrupt: () => this.interrupt(),
    });
    this.bottom.appendChild(this.composer.root);
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
    this.renderWelcome();
    this.updateComposer();
    this.schedule();
  }

  dispose() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.client.disconnect();
    this.container.remove();
  }

  // --- connection ---

  private wireClient() {
    this.client.onChatSync = (sync) => {
      this.synced = false;
      this.session.applySync(sync);
    };
    this.client.onChat = (seq, msg, history) => {
      if (history) this.session.applyHistory(msg);
      else this.session.applyChat(seq, msg);
    };
    this.client.onChatState = (st) => {
      this.synced = true;
      this.session.applyState(st);
      this.updateComposer();
      this.onActivity?.();
    };
    this.client.onChatAck = (ack) => this.onAck(ack);
  }

  private onAck(ack: ChatAckFrame) {
    if (ack.ok) return;
    if (ack.op === 'send' && ack.ref && ack.code !== 'empty') {
      this.session.markUndelivered(ack.ref);
      this.onMessage?.(t('chat.sendFailed', { msg: ack.message || ack.code || '' }));
    }
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
    return this.queue.enqueue(text) !== null;
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
    this.composer.update({ status: st.status, connected: this.connected, ended: !!st.ended, where });
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
    } else {
      this.win = follow(this.win, msgs.length, bottom);
    }
    const pendingTools = new Set(
      st.pending.map((p) => p.request.tool_use_id).filter((id): id is string => typeof id === 'string'),
    );

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

    if (stick && bottom) this.transcript.scrollTop = this.transcript.scrollHeight;
    this.updateComposer();
  }

  private signature(m: Message, pendingTools: Set<string>): string {
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

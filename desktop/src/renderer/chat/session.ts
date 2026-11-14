// ChatSession: DOM-free state machine for one chat session. Consumes chat
// frames (sync, history, live messages, chat_state) and keeps a renderable
// Message[] plus the open prompts. The view subscribes to onUpdate.
//
// Ported from 69d8c70:packages/core/src/chat/session.ts (skeleton, preview →
// complete block sealing, tool_result pairing by id). Changes (design 4.12):
// no local "streaming" gate — another desktop's turn shows the same way; turn
// boundaries come from user echoes and results (FIFO); previews and complete
// blocks merge on message.id + block index, so a reply caught up after a
// reconnect appears once (R12.4); prompts come from chat_state.pending only;
// no built-in slash list, checkpoints, rollback or cost.

import type { ChatEnded, ChatStateFrame, ChatStatus, ChatSyncFrame } from '../../shared/protocol';
import { parseChatMessage, type ChatEvent } from './parser';
import { classifyPermissionKind } from './permission';
import type {
  AssistantMessage,
  CanUseToolRequest,
  ChatState,
  Message,
  NoticeMessage,
  Part,
  Prompt,
  PromptOutcome,
  PromptState,
  ToolResult,
  UserMessage,
} from './types';

/** Turn bookkeeping the send queue follows (design 6.8). Live frames only, never history. */
export type TurnEvent =
  | { kind: 'echo'; clientMsgId: string }
  | { kind: 'result'; stale: boolean }
  | { kind: 'staleTurn'; clientMsgId: string }
  | { kind: 'undelivered'; clientMsgId: string }
  | { kind: 'reset' }
  | { kind: 'status'; status: ChatStatus };

type ToolUsePart = Extract<Part, { type: 'tool_use' }>;

interface Blocks {
  // Complete blocks, in order: block i of the message.
  sealed: Part[];
  // Streaming previews by content block index; only those past `sealed` show.
  preview: Map<number, Part>;
}

interface LocalSend {
  msg: UserMessage;
  // Sync generation it was sent in: a later sync that ends without its echo
  // means it never reached the daemon.
  gen: number;
}

export class ChatSession {
  onUpdate?: (state: ChatState) => void;
  onTurn?: (ev: TurnEvent) => void;

  private messages: Message[] = [];
  private keySeq = 0;
  private version = 0;

  private status: ChatStatus = 'idle';
  private permissionMode = 'default';
  private permissionLocked = false;
  private slashCommands: ChatState['slashCommands'] = [];
  private ended: ChatState['ended'] = null;
  private degraded: string[] = [];
  private claudeVersion = '';
  private claudeSessionId = '';
  private omitted = 0;
  private resyncDividerAt?: string;
  private apiRetry?: ChatState['apiRetry'];

  // Prompts: the open ones (daemon's pending order) and every state seen.
  private prompts: Prompt[] = [];
  private promptStates = new Map<string, PromptState>();
  private requests = new Map<string, CanUseToolRequest>();

  // Assistant assembly.
  private byId = new Map<string, AssistantMessage>();
  private blocks = new Map<AssistantMessage, Blocks>();
  private live: AssistantMessage | null = null;
  private toolParts = new Map<string, { part: ToolUsePart; owner: AssistantMessage }>();
  private toolResults = new Map<string, ToolResult>();

  // Turn tracking (live only): echoes waiting for their result, and what the
  // current turn produced.
  private turnUsers: UserMessage[] = [];
  private turnAssistants: AssistantMessage[] = [];
  private interruptSeen = false;
  private interruptNoticed = false;

  // Our own sends.
  private ownIds = new Set<string>();
  private localSending = new Map<string, LocalSend>();

  // Sync in progress (between chat_sync and its closing chat_state).
  private syncing = false;
  private syncGen = 0;
  private pendingOmitted = 0;

  /** Current renderable state. `messages` is shared, treat it as read-only. */
  getState(): ChatState {
    return {
      messages: this.messages,
      status: this.status,
      permissionMode: this.permissionMode,
      permissionLocked: this.permissionLocked,
      pending: this.prompts.slice(),
      slashCommands: this.slashCommands,
      ended: this.ended,
      degraded: this.degraded,
      claudeVersion: this.claudeVersion,
      claudeSessionId: this.claudeSessionId,
      omitted: this.omitted,
      resyncDividerAt: this.resyncDividerAt,
      apiRetry: this.apiRetry,
      version: this.version,
    };
  }

  /** State of one prompt as seen here, including closed ones. */
  promptState(requestId: string): PromptState | undefined {
    return this.prompts.find((p) => p.requestId === requestId)?.state ?? this.promptStates.get(requestId);
  }

  /** Clears the transcript (a reset sync rebuilds it). Local sends survive. */
  reset() {
    this.messages = [];
    this.byId.clear();
    this.blocks.clear();
    this.live = null;
    this.toolParts.clear();
    this.toolResults.clear();
    this.turnUsers = [];
    this.turnAssistants = [];
    this.interruptSeen = false;
    this.interruptNoticed = false;
    this.prompts = [];
    this.resyncDividerAt = undefined;
    this.apiRetry = undefined;
    this.pendingOmitted = 0;
    this.omitted = 0;
    this.onTurn?.({ kind: 'reset' });
    this.emit();
  }

  /** Opens a sync (design 4.4). */
  applySync(sync: ChatSyncFrame) {
    this.syncGen++;
    if (sync.reset) {
      this.reset();
      this.omitted = sync.omitted;
      this.pendingOmitted = sync.omitted;
    } else if (sync.backlog > 0) {
      // Incremental catch-up: mark where the connection dropped (R12.2).
      const n = this.pushNotice({ kind: 'resync', count: sync.backlog });
      this.resyncDividerAt = n.key;
    }
    this.syncing = true;
    this.emit();
  }

  /** One history message (from the JSONL, seq 0). */
  applyHistory(msg: unknown) {
    this.apply(parseChatMessage(msg), true);
  }

  /** One live or backlog message. */
  applyChat(_seq: number, msg: unknown) {
    this.flushOmitted();
    this.apply(parseChatMessage(msg), false);
  }

  /** chat_state: authoritative status, mode, prompts, end state. Closes a sync. */
  applyState(st: ChatStateFrame) {
    const closingSync = this.syncing;
    this.syncing = false;
    if (closingSync) this.flushOmitted();

    this.status = st.status;
    this.permissionMode = st.permissionMode;
    this.permissionLocked = st.permissionLocked;
    this.slashCommands = st.slashCommands ?? [];
    this.ended = st.ended ?? null;
    this.degraded = st.degraded ?? [];
    this.claudeVersion = st.claudeVersion ?? '';
    this.claudeSessionId = st.claudeSessionId ?? '';

    const prev = new Map(this.prompts.map((p) => [p.requestId, p]));
    this.prompts = (st.pending ?? []).map((pr) => {
      const old = prev.get(pr.requestId);
      // After a sync, anything still pending is unanswered: an answer we
      // marked "submitting" never reached the daemon (R5.6).
      const state: PromptState = !closingSync && old ? old.state : 'open';
      const request = (pr.request ?? {}) as CanUseToolRequest;
      const toolName = typeof request.tool_name === 'string' ? request.tool_name : '';
      this.requests.set(pr.requestId, request);
      this.promptStates.set(pr.requestId, state);
      return { requestId: pr.requestId, kind: classifyPermissionKind(toolName), toolName, request, state };
    });

    if (closingSync) {
      // Sent before this sync and still not echoed: it never got there.
      for (const [id, rec] of this.localSending) {
        if (rec.gen >= this.syncGen) continue;
        this.localSending.delete(id);
        rec.msg.delivery = 'undelivered';
        rec.msg.rev++;
        if (!this.messages.includes(rec.msg)) this.messages.push(rec.msg);
        this.onTurn?.({ kind: 'undelivered', clientMsgId: id });
      }
    }
    if (st.status === 'idle' || st.status === 'ended') this.finishStreaming();
    this.onTurn?.({ kind: 'status', status: st.status });
    this.emit();
  }

  /** Shows a message this desktop just sent, before its echo (R3.1). */
  addLocalUser(clientMsgId: string, text: string): UserMessage {
    this.ownIds.add(clientMsgId);
    const msg: UserMessage = {
      role: 'user',
      key: this.nextKey(),
      rev: 0,
      parts: [{ type: 'text', text }],
      clientMsgId,
      delivery: 'sending',
    };
    this.messages.push(msg);
    this.localSending.set(clientMsgId, { msg, gen: this.syncGen });
    this.emit();
    return msg;
  }

  /**
   * Re-sends a message under the same id, reusing its bubble (one bubble per
   * id). Returns its text, or null if there is no such message.
   */
  resend(clientMsgId: string): string | null {
    const msg = this.messages.find((m): m is UserMessage => m.role === 'user' && m.clientMsgId === clientMsgId);
    if (!msg) return null;
    if (msg.delivery !== 'sent') {
      msg.delivery = 'sending';
      msg.rev++;
      this.localSending.set(clientMsgId, { msg, gen: this.syncGen });
      this.emit();
    }
    return textOf(msg);
  }

  /** The daemon refused a message we sent (chat_ack not ok): it was not delivered. */
  markUndelivered(clientMsgId: string) {
    this.localSending.delete(clientMsgId);
    const msg = this.messages.find((m): m is UserMessage => m.role === 'user' && m.clientMsgId === clientMsgId);
    if (msg) {
      msg.delivery = 'undelivered';
      msg.rev++;
    }
    this.onTurn?.({ kind: 'undelivered', clientMsgId });
    this.emit();
  }

  /** We answered this prompt; waiting for the daemon (design 6.7). */
  markSubmitting(requestId: string) {
    this.setPromptState(requestId, 'submitting');
  }

  /** The answer was not taken (chat_busy, socket closed): the prompt is answerable again. */
  markOpen(requestId: string) {
    this.setPromptState(requestId, 'open');
  }

  /** chat_ack request_not_pending: someone else answered first (R5.7). */
  markHandledElsewhere(requestId: string) {
    const toolName = this.requests.get(requestId)?.tool_name ?? '';
    this.setPromptState(requestId, 'handledElsewhere');
    this.pushNotice({ kind: 'prompt', outcome: 'handledElsewhere', toolName });
    this.emit();
  }

  // --- internals ---

  private emit() {
    this.version++;
    this.onUpdate?.(this.getState());
  }

  private nextKey(): string {
    return `m${++this.keySeq}`;
  }

  private setPromptState(requestId: string, state: PromptState) {
    this.promptStates.set(requestId, state);
    const p = this.prompts.find((x) => x.requestId === requestId);
    if (p) p.state = state;
    this.emit();
  }

  private pushNotice(fields: Omit<NoticeMessage, 'role' | 'key' | 'rev'>): NoticeMessage {
    const n: NoticeMessage = { role: 'notice', key: this.nextKey(), rev: 0, ...fields };
    this.messages.push(n);
    return n;
  }

  // The "N earlier messages omitted" marker goes where the dropped messages
  // were: after the history, before the first backlog message (R12.3).
  private flushOmitted() {
    if (this.pendingOmitted > 0) {
      this.pushNotice({ kind: 'omitted', count: this.pendingOmitted });
      this.pendingOmitted = 0;
    }
  }

  private apply(ev: ChatEvent, history: boolean) {
    switch (ev.kind) {
      case 'user_echo':
        this.onEcho(ev.clientMsgId, ev.text, history);
        break;
      case 'user_text':
        this.messages.push({ role: 'user', key: this.nextKey(), rev: 0, parts: [{ type: 'text', text: ev.text }] });
        break;
      case 'interrupt_marker':
        this.pushNotice({ kind: 'interrupted' });
        if (!history) {
          this.interruptSeen = true;
          this.interruptNoticed = true;
        }
        break;
      case 'tool_results':
        for (const r of ev.results) this.attachToolResult(r.toolUseId, r.result);
        break;
      case 'compact_summary':
        this.pushNotice({ kind: 'compact_summary', text: ev.text });
        break;
      case 'command_output':
        this.pushNotice({ kind: 'command_output', text: ev.text });
        break;
      case 'compact_boundary':
        this.pushNotice({ kind: 'compact_boundary' });
        break;
      case 'assistant':
        this.onAssistant(ev.id, ev.model, ev.parts, history);
        break;
      case 'message_start': {
        const msg = this.assistantFor(ev.id, history);
        if (ev.model) msg.model = ev.model;
        msg.streaming = !history;
        msg.rev++;
        this.live = msg;
        this.apiRetry = undefined;
        break;
      }
      case 'block_start':
        this.onPreview(ev.index, ev.part, history);
        break;
      case 'text_delta':
      case 'thinking_delta':
        this.onDelta(ev.kind === 'text_delta' ? 'text' : 'thinking', ev.index, ev.text, history);
        break;
      case 'message_stop':
        if (this.live) {
          this.live.streaming = false;
          this.live.rev++;
          this.live = null;
        }
        break;
      case 'result':
        if (!history) this.onResult(ev);
        break;
      case 'api_retry':
        if (!history) this.apiRetry = { attempt: ev.attempt, maxRetries: ev.maxRetries };
        break;
      case 'can_use_tool':
        this.requests.set(ev.requestId, ev.request);
        break;
      case 'resolved':
        this.onResolved(ev.requestId, ev.outcome);
        break;
      case 'notice':
        this.onNotice(ev.code, ev.text, ev.clientMsgId, history);
        break;
      case 'exit':
      case 'ignored':
        return;
    }
    this.emit();
  }

  private onEcho(clientMsgId: string, text: string, history: boolean) {
    let msg: UserMessage | undefined;
    const local = this.localSending.get(clientMsgId);
    if (local && this.messages.includes(local.msg)) {
      msg = local.msg;
      msg.delivery = 'sent';
      msg.rev++;
    } else {
      msg = {
        role: 'user',
        key: this.nextKey(),
        rev: 0,
        parts: [{ type: 'text', text }],
        clientMsgId,
        delivery: this.ownIds.has(clientMsgId) ? 'sent' : undefined,
      };
      this.messages.push(msg);
    }
    this.localSending.delete(clientMsgId);
    if (history) return;
    this.turnUsers.push(msg);
    this.onTurn?.({ kind: 'echo', clientMsgId });
  }

  private onResult(ev: Extract<ChatEvent, { kind: 'result' }>) {
    this.apiRetry = undefined;
    if (ev.stale) {
      // Its turn was already written off by the daemon's watchdog.
      this.onTurn?.({ kind: 'result', stale: true });
      return;
    }
    const user = this.turnUsers.shift();
    const last = this.turnAssistants[this.turnAssistants.length - 1];
    const interrupted = ev.interrupted || (ev.duringExecution && this.interruptSeen);
    if (interrupted) {
      // "Interrupted" is a normal end, not a turn error (V3, V12).
      if (last) {
        last.interrupted = true;
        last.rev++;
      }
      if (!this.interruptNoticed) this.pushNotice({ kind: 'interrupted' });
    } else if (ev.isError) {
      const target = last ?? this.newAssistant(undefined, false);
      target.error = ev.errorText ?? 'error';
      if (user) target.retryText = textOf(user);
      target.rev++;
    }
    this.finishStreaming();
    this.turnAssistants = [];
    this.interruptSeen = false;
    this.interruptNoticed = false;
    this.onTurn?.({ kind: 'result', stale: false });
  }

  private finishStreaming() {
    for (const m of this.turnAssistants) {
      if (m.streaming) {
        m.streaming = false;
        m.rev++;
      }
    }
    if (this.live) {
      this.live.streaming = false;
      this.live.rev++;
    }
    this.live = null;
  }

  private onResolved(requestId: string, outcome: PromptOutcome) {
    const was = this.promptStates.get(requestId);
    this.promptStates.set(requestId, outcome);
    this.prompts = this.prompts.filter((p) => p.requestId !== requestId);
    // Allowed / denied show in the tool block itself; the others close the
    // prompt without a tool result, so the transcript says why (R5.8, R8.2).
    if (was !== 'handledElsewhere' && (outcome === 'cancelled' || outcome === 'interrupted' || outcome === 'exited')) {
      this.pushNotice({ kind: 'prompt', outcome, toolName: this.requests.get(requestId)?.tool_name ?? '' });
    }
  }

  private onNotice(code: string, text: string | undefined, clientMsgId: string | undefined, history: boolean) {
    if (code === 'stale_turn' || code === 'dropped_on_stop') {
      if (clientMsgId) {
        const i = this.turnUsers.findIndex((u) => u.clientMsgId === clientMsgId);
        if (i >= 0) this.turnUsers.splice(i, 1);
        if (code === 'dropped_on_stop') {
          const msg = this.messages.find((m): m is UserMessage => m.role === 'user' && m.clientMsgId === clientMsgId);
          if (msg) {
            msg.delivery = 'undelivered';
            msg.rev++;
          }
        }
        if (!history) this.onTurn?.({ kind: 'staleTurn', clientMsgId });
      }
      return;
    }
    this.pushNotice({ kind: 'notice', code, text });
  }

  private newAssistant(id: string | undefined, history: boolean): AssistantMessage {
    const msg: AssistantMessage = { role: 'assistant', key: this.nextKey(), rev: 0, id, parts: [], streaming: false };
    this.messages.push(msg);
    this.blocks.set(msg, { sealed: [], preview: new Map() });
    if (id) this.byId.set(id, msg);
    if (!history) this.turnAssistants.push(msg);
    return msg;
  }

  private assistantFor(id: string | undefined, history: boolean): AssistantMessage {
    if (id) {
      const existing = this.byId.get(id);
      if (existing) return existing;
    }
    return this.newAssistant(id, history);
  }

  private compose(msg: AssistantMessage) {
    const b = this.blocks.get(msg)!;
    const previews = [...b.preview.entries()]
      .filter(([i]) => i >= b.sealed.length)
      .sort((x, y) => x[0] - y[0])
      .map(([, p]) => p);
    msg.parts = [...b.sealed, ...previews];
    msg.rev++;
  }

  private onAssistant(id: string | undefined, model: string | undefined, parts: Part[], history: boolean) {
    // claude sends each content block of a reply as its own complete
    // assistant line, all with the same message.id: they append in order and
    // replace the preview of the same block index.
    const msg = this.assistantFor(id, history);
    const b = this.blocks.get(msg)!;
    for (const p of parts) {
      b.sealed.push(p);
      if (p.type === 'tool_use') {
        this.toolParts.set(p.id, { part: p, owner: msg });
        const r = this.toolResults.get(p.id);
        if (r) p.result = r;
      }
    }
    if (model) msg.model = model;
    this.compose(msg);
    this.apiRetry = undefined;
  }

  private onPreview(index: number, part: Part, history: boolean) {
    const msg = this.live ?? (this.live = this.assistantFor(undefined, history));
    const b = this.blocks.get(msg)!;
    if (index < b.sealed.length) return;
    b.preview.set(index, { ...part });
    this.compose(msg);
  }

  private onDelta(type: 'text' | 'thinking', index: number, text: string, history: boolean) {
    const msg = this.live ?? (this.live = this.assistantFor(undefined, history));
    const b = this.blocks.get(msg)!;
    if (index < b.sealed.length) return; // already complete
    const p = b.preview.get(index);
    if (p && p.type === type) p.text += text;
    else b.preview.set(index, { type, text });
    this.apiRetry = undefined;
    this.compose(msg);
  }

  private attachToolResult(toolUseId: string, result: ToolResult) {
    this.toolResults.set(toolUseId, result);
    const t = this.toolParts.get(toolUseId);
    if (t) {
      t.part.result = result;
      t.owner.rev++;
    }
  }
}

function textOf(msg: UserMessage): string {
  return msg.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

/** What the "session ended" banner offers (R13.2, R13.4, R14.1, R15.3). */
export type EndedAction = 'restart' | 'recheck' | 'handoff' | 'openTerminal';

export interface EndedView {
  /** i18n key of the banner title. */
  titleKey: string;
  params: Record<string, string | number>;
  /** Extra text shown under the title (failure message, stderr tail). */
  detail?: string;
  actions: EndedAction[];
}

/**
 * The banner for `chat_state.ended`: "restart" (reload with --resume, same
 * conversation), "recheck" (claude upgraded? probe again, then restart),
 * "handoff" (continue in a new terminal session) or, once handed off, open
 * that terminal session.
 */
export function endedView(ended: ChatEnded): EndedView {
  switch (ended.reason) {
    case 'handed_off':
      return { titleKey: 'chat.ended.handed_off', params: {}, actions: ['openTerminal'] };
    case 'version_unsupported':
      return {
        titleKey: 'chat.ended.version_unsupported',
        params: { version: ended.claudeVersion || '?', min: ended.minClaudeVersion || '?' },
        actions: ['recheck', 'handoff'],
      };
    case 'restart_failed':
      return { titleKey: 'chat.ended.restart_failed', params: {}, detail: ended.message, actions: ['restart', 'handoff'] };
    case 'exited':
      return {
        titleKey: 'chat.ended.exited',
        params: { code: ended.code ?? 0 },
        detail: ended.stderrTail || ended.message,
        actions: ['restart', 'handoff'],
      };
    case 'daemon_restart':
      return { titleKey: 'chat.ended.daemon_restart', params: {}, actions: ['restart', 'handoff'] };
    case 'stopped':
      return { titleKey: 'chat.ended.stopped', params: {}, actions: ['restart', 'handoff'] };
    default:
      return { titleKey: 'chat.ended.other', params: { reason: String(ended.reason) }, detail: ended.message, actions: ['restart', 'handoff'] };
  }
}

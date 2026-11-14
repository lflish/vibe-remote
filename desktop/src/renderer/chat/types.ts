// Renderable chat model. Zero DOM. Ported from 69d8c70:packages/core/src/chat/types.ts
// (checkpoint / local rollback / cost dropped, see design 4.12).
//
// Data flow: chat frame msg (claude stream-json line or daemon vr_* message)
//   → parser.ts (msg → ChatEvent) → session.ts (state machine → Message[])
//   → view.ts renders.

import type { ChatEnded, ChatStatus, SlashCommand } from '../../shared/protocol';

export type { SlashCommand };

/** Result of a tool run, filled into the tool_use part that started it. */
export interface ToolResult {
  content: string;
  isError: boolean;
}

/** One content block of a message. */
export type Part =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: unknown;
      // Filled when the matching tool_result arrives.
      result?: ToolResult;
    };

/** Delivery of a message this desktop sent. */
export type Delivery = 'sending' | 'sent' | 'undelivered';

interface MessageBase {
  /** Stable, unique per message for the life of the session object (DOM key). */
  key: string;
  /** Bumped on every in-place change, so a view can tell what to redraw. */
  rev: number;
}

export interface UserMessage extends MessageBase {
  role: 'user';
  parts: Part[];
  clientMsgId?: string;
  delivery?: Delivery;
}

export interface AssistantMessage extends MessageBase {
  role: 'assistant';
  /** claude's message.id: previews and complete blocks merge on it. */
  id?: string;
  parts: Part[];
  model?: string;
  streaming: boolean;
  interrupted?: boolean;
  /** Turn error text (result.is_error); the view shows it with a retry button. */
  error?: string;
  /** Text of the user message whose turn failed (R13.1 retry). */
  retryText?: string;
}

/**
 * Non-bubble entries in the transcript. The view maps `kind` to an i18n string.
 *  - interrupted: claude's "[Request interrupted by user…]" marker
 *  - compact_summary: the summary claude writes after /compact (collapsible)
 *  - command_output: <local-command-stdout>…</local-command-stdout>
 *  - compact_boundary: divider where the context was compacted
 *  - omitted: "N earlier messages were omitted" after a buffer overflow (R12.3)
 *  - resync: reconnect divider with the number of messages caught up (R12.2)
 *  - prompt: a prompt closed without an answer from here (cancelled,
 *    interrupted, exited, handled elsewhere)
 *  - notice: a daemon vr_notice worth showing (line dropped, stderr, …)
 */
export type NoticeKind =
  | 'interrupted'
  | 'compact_summary'
  | 'command_output'
  | 'compact_boundary'
  | 'omitted'
  | 'resync'
  | 'prompt'
  | 'notice';

export interface NoticeMessage extends MessageBase {
  role: 'notice';
  kind: NoticeKind;
  text?: string;
  count?: number;
  /** kind 'prompt': how it closed, and which tool asked. */
  outcome?: PromptOutcome | 'handledElsewhere';
  toolName?: string;
  /** kind 'notice': the vr_notice code. */
  code?: string;
}

export type Message = UserMessage | AssistantMessage | NoticeMessage;

/** Kind of prompt card for a can_use_tool request. */
export type PromptKind = 'tool' | 'plan' | 'question';

/** How the daemon says a pending request was resolved (vr_resolved.outcome). */
export type PromptOutcome = 'allowed' | 'denied' | 'cancelled' | 'interrupted' | 'exited';

/**
 * Lifecycle of one prompt as seen from this desktop:
 * open → submitting (we answered, waiting for the daemon) → one of the
 * outcomes; handledElsewhere = our answer lost to another one (R5.7).
 */
export type PromptState = 'open' | 'submitting' | PromptOutcome | 'handledElsewhere';

/** The can_use_tool request object, as claude sent it. */
export interface CanUseToolRequest {
  subtype?: string;
  tool_name?: string;
  display_name?: string;
  input?: Record<string, unknown>;
  description?: string;
  permission_suggestions?: unknown[];
  blocked_path?: string;
  tool_use_id?: string;
  requires_user_interaction?: boolean;
  [k: string]: unknown;
}

export interface Prompt {
  requestId: string;
  kind: PromptKind;
  toolName: string;
  request: CanUseToolRequest;
  state: PromptState;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  /** Original question text: the key of updatedInput.answers. */
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/** Whole renderable chat state. */
export interface ChatState {
  messages: Message[];
  status: ChatStatus;
  permissionMode: string;
  permissionLocked: boolean;
  /** Open prompts, in the daemon's pending order (open / submitting / handledElsewhere). */
  pending: Prompt[];
  slashCommands: SlashCommand[];
  ended: ChatEnded | null;
  degraded: string[];
  claudeVersion: string;
  claudeSessionId: string;
  /** Count from the last reset sync's `omitted` (R12.3). */
  omitted: number;
  /** Key of the reconnect divider inserted by the last incremental sync, if any. */
  resyncDividerAt?: string;
  /** API retry in progress (system/api_retry), cleared by the next output. */
  apiRetry?: { attempt: number; maxRetries?: number };
  /** Bumped on every change. */
  version: number;
}

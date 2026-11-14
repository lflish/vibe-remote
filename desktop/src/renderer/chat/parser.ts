// Parses one chat message (the `msg` of a chat frame) into a ChatEvent.
// The input is claude's own structured protocol (stream-json, one stdout line
// already JSON-decoded by the daemon) or a daemon-synthesized vr_* message —
// never terminal output, so this does not touch the terminal-mode rule that
// the client never parses PTY bytes.
//
// Ported from 69d8c70:packages/core/src/chat/parser.ts. Changes (design 4.12):
// input is an object, not a line; a user message yields all of its
// tool_results; message ids and block indexes are kept so previews merge with
// complete blocks; claude's interrupt markers, string-content user messages
// (/compact summary, local command output), compact_boundary, control
// requests, vr_* messages and result error/interrupt shapes are recognized.
// Never throws: anything unknown is { kind: 'ignored' }.

import type { CanUseToolRequest, Part, PromptOutcome, ToolResult } from './types';

export type ChatEvent =
  // Daemon echo of a user message written to claude's stdin (any desktop).
  | { kind: 'user_echo'; clientMsgId: string; text: string }
  // A user prompt without an echo id (history from the JSONL).
  | { kind: 'user_text'; text: string }
  // claude's "[Request interrupted by user]" / "… for tool use" text.
  | { kind: 'interrupt_marker'; forToolUse: boolean }
  | { kind: 'tool_results'; results: { toolUseId: string; result: ToolResult }[] }
  // String-content user messages claude produces for local commands (V20).
  | { kind: 'compact_summary'; text: string }
  | { kind: 'command_output'; text: string }
  // A complete assistant message (usually one content block per line).
  | { kind: 'assistant'; id?: string; model?: string; parts: Part[] }
  | { kind: 'message_start'; id?: string; model?: string }
  | { kind: 'block_start'; index: number; part: Part }
  | { kind: 'text_delta'; index: number; text: string }
  | { kind: 'thinking_delta'; index: number; text: string }
  | { kind: 'message_stop' }
  | {
      kind: 'result';
      // vr_stale: a result the daemon's watchdog already gave up on.
      stale: boolean;
      // error_during_execution + aborted_streaming / aborted_tools (V3, V12).
      interrupted: boolean;
      // Only error_during_execution: lets the session treat it as interrupted
      // when it has seen claude's interrupt marker this turn.
      duringExecution: boolean;
      isError: boolean;
      errorText?: string;
    }
  | { kind: 'compact_boundary' }
  | { kind: 'api_retry'; attempt: number; maxRetries?: number }
  | { kind: 'can_use_tool'; requestId: string; request: CanUseToolRequest }
  | { kind: 'resolved'; requestId: string; outcome: PromptOutcome; message?: string }
  | { kind: 'notice'; code: string; text?: string; clientMsgId?: string }
  | { kind: 'exit'; code?: number; reason?: string; stderrTail?: string }
  // system/init, system/status and other metadata: the daemon's chat_state is
  // authoritative for all of it.
  | { kind: 'ignored' };

const INTERRUPTED = '[Request interrupted by user]';
const INTERRUPTED_TOOL = '[Request interrupted by user for tool use]';
const COMPACT_SUMMARY_PREFIX = 'This session is being continued from a previous conversation';
const LOCAL_OUTPUT_RE = /^\s*<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>\s*$/;
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const OUTCOMES: readonly PromptOutcome[] = ['allowed', 'denied', 'cancelled', 'interrupted', 'exited'];

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** tool_result content is a string or [{type:'text',text}]; flatten to text. */
export function flattenResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (isObj(b) && typeof b.text === 'string') return b.text;
        return '';
      })
      .join('');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

function blockToPart(b: unknown): Part | null {
  if (!isObj(b)) return null;
  if (b.type === 'text' && typeof b.text === 'string') return { type: 'text', text: b.text };
  if (b.type === 'thinking' && typeof b.thinking === 'string') return { type: 'thinking', text: b.thinking };
  if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
    return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
  }
  return null;
}

/** Converts a complete assistant message's content[] into parts. */
export function parseAssistantContent(content: unknown): Part[] {
  if (!Array.isArray(content)) return [];
  const parts: Part[] = [];
  for (const b of content) {
    const p = blockToPart(b);
    if (p) parts.push(p);
  }
  return parts;
}

// A user message whose content is a plain string: claude writes these for
// local commands (V20); in history they are also the user's own prompts.
function parseStringUser(msg: Obj, text: string): ChatEvent {
  if (msg.isCompactSummary === true || text.startsWith(COMPACT_SUMMARY_PREFIX)) {
    return { kind: 'compact_summary', text };
  }
  const local = LOCAL_OUTPUT_RE.exec(text);
  if (local) return { kind: 'command_output', text: local[2].trim() };
  const name = COMMAND_NAME_RE.exec(text);
  if (name) {
    const args = COMMAND_ARGS_RE.exec(text)?.[1].trim();
    return { kind: 'user_text', text: args ? `${name[1].trim()} ${args}` : name[1].trim() };
  }
  if (text === INTERRUPTED || text === INTERRUPTED_TOOL) {
    return { kind: 'interrupt_marker', forToolUse: text === INTERRUPTED_TOOL };
  }
  return { kind: 'user_text', text };
}

function parseUser(msg: Obj): ChatEvent {
  const message = isObj(msg.message) ? msg.message : {};
  const content = message.content;
  const echoId = str(msg.vr_client_msg_id);
  if (typeof content === 'string') {
    if (echoId) return { kind: 'user_echo', clientMsgId: echoId, text: content };
    return parseStringUser(msg, content);
  }
  if (!Array.isArray(content)) return { kind: 'ignored' };

  const results: { toolUseId: string; result: ToolResult }[] = [];
  const texts: string[] = [];
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      results.push({
        toolUseId: b.tool_use_id,
        result: { content: flattenResultContent(b.content), isError: b.is_error === true },
      });
    } else if (b.type === 'text' && typeof b.text === 'string') {
      texts.push(b.text);
    }
  }
  if (results.length) return { kind: 'tool_results', results };
  if (!texts.length) return { kind: 'ignored' };
  const text = texts.join('\n');
  if (echoId) return { kind: 'user_echo', clientMsgId: echoId, text };
  if (text === INTERRUPTED || text === INTERRUPTED_TOOL) {
    return { kind: 'interrupt_marker', forToolUse: text === INTERRUPTED_TOOL };
  }
  return parseStringUser(msg, text);
}

function parseStreamEvent(ev: unknown): ChatEvent {
  if (!isObj(ev)) return { kind: 'ignored' };
  const index = num(ev.index) ?? 0;
  switch (ev.type) {
    case 'message_start': {
      const m = isObj(ev.message) ? ev.message : {};
      return { kind: 'message_start', id: str(m.id), model: str(m.model) };
    }
    case 'content_block_start': {
      const part = blockToPart(ev.content_block);
      if (!part) return { kind: 'ignored' };
      return { kind: 'block_start', index, part };
    }
    case 'content_block_delta': {
      const d = isObj(ev.delta) ? ev.delta : {};
      if (d.type === 'text_delta' && typeof d.text === 'string') return { kind: 'text_delta', index, text: d.text };
      if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
        return { kind: 'thinking_delta', index, text: d.thinking };
      }
      return { kind: 'ignored' };
    }
    case 'message_stop':
      return { kind: 'message_stop' };
    default:
      return { kind: 'ignored' };
  }
}

function parseResult(msg: Obj): ChatEvent {
  const subtype = str(msg.subtype);
  const reason = str(msg.terminal_reason);
  const duringExecution = subtype === 'error_during_execution';
  const interrupted = duringExecution && (reason === 'aborted_streaming' || reason === 'aborted_tools');
  const isError = msg.is_error === true && !interrupted;
  let errorText: string | undefined;
  if (isError) {
    const errors = Array.isArray(msg.errors) ? msg.errors.filter((e): e is string => typeof e === 'string' && !!e) : [];
    errorText = str(msg.result) ?? errors[0] ?? subtype ?? 'error';
  }
  return { kind: 'result', stale: msg.vr_stale === true, interrupted, duringExecution, isError, errorText };
}

function parseSystem(msg: Obj): ChatEvent {
  if (msg.subtype === 'compact_boundary') return { kind: 'compact_boundary' };
  if (msg.subtype === 'api_retry') {
    return { kind: 'api_retry', attempt: num(msg.attempt) ?? 1, maxRetries: num(msg.max_retries) };
  }
  // init (re-sent every turn), status, hook_*, thinking_tokens and future
  // subtypes: metadata the daemon already folds into chat_state.
  return { kind: 'ignored' };
}

/** Parses one chat message. Never throws. */
export function parseChatMessage(raw: unknown): ChatEvent {
  if (!isObj(raw)) return { kind: 'ignored' };
  try {
    switch (raw.type) {
      case 'user':
        return parseUser(raw);
      case 'assistant': {
        const m = isObj(raw.message) ? raw.message : {};
        const parts = parseAssistantContent(m.content);
        if (!parts.length) return { kind: 'ignored' };
        return { kind: 'assistant', id: str(m.id), model: str(m.model), parts };
      }
      case 'stream_event':
        return parseStreamEvent(raw.event);
      case 'result':
        return parseResult(raw);
      case 'system':
        return parseSystem(raw);
      case 'control_request': {
        const req = isObj(raw.request) ? raw.request : {};
        const requestId = str(raw.request_id);
        if (req.subtype !== 'can_use_tool' || !requestId) return { kind: 'ignored' };
        return { kind: 'can_use_tool', requestId, request: req as CanUseToolRequest };
      }
      case 'vr_resolved': {
        const requestId = str(raw.request_id);
        const outcome = raw.outcome as PromptOutcome;
        if (!requestId || !OUTCOMES.includes(outcome)) return { kind: 'ignored' };
        return { kind: 'resolved', requestId, outcome, message: str(raw.message) };
      }
      case 'vr_notice': {
        const code = str(raw.code);
        if (!code) return { kind: 'ignored' };
        return { kind: 'notice', code, text: str(raw.text), clientMsgId: str(raw.clientMsgId) };
      }
      case 'vr_exit':
        return { kind: 'exit', code: num(raw.code), reason: str(raw.reason), stderrTail: str(raw.stderrTail) };
      default:
        // keep_alive, control_response, control_cancel_request (resolution
        // arrives as vr_resolved), unknown types.
        return { kind: 'ignored' };
    }
  } catch {
    return { kind: 'ignored' };
  }
}

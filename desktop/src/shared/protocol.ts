// Protocol frame types — mirrors vibe-remoted/internal/protocol/protocol.go

/**
 * Protocol revision this client speaks (protocol.Version in Go). Daemons that
 * predate the field report nothing, which reads as 1.
 *   2: attach.newSessionId, error.code/fatal, proto
 *   3: chat UI (attach.ui/epoch/since/handoffFrom, chat* frames,
 *      ready.ui/claudeSessionId/existing/handoffFrom,
 *      sessions[].ui/state/activitySeq/epoch/endReason, info.chat (+?recheck=1),
 *      fs chatTrust, chat reload 202, errors ui_mismatch/chat_unsupported/
 *      claude_session_busy)
 */
export const PROTOCOL_VERSION = 3;

export const FrameType = {
  Auth: 'auth',
  Attach: 'attach',
  Ready: 'ready',
  Data: 'data',
  Resize: 'resize',
  Sessions: 'sessions',
  Ping: 'ping',
  Pong: 'pong',
  Exit: 'exit',
  Error: 'error',
  Notify: 'notify',
  // Chat UI (v3). Server → client.
  Chat: 'chat',
  ChatSync: 'chat_sync',
  ChatState: 'chat_state',
  ChatAck: 'chat_ack',
  // Chat UI (v3). Client → server, only after a ui:'chat' ready.
  ChatSend: 'chat_send',
  ChatRespond: 'chat_respond',
  ChatInterrupt: 'chat_interrupt',
  ChatSetMode: 'chat_set_mode',
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

// --- Client → Server ---

export type SessionMode = 'normal' | 'worktree';

/** Session kind. Omitted on the wire = terminal (every pre-v3 peer). */
export type SessionUI = 'terminal' | 'chat';

export interface AuthFrame {
  type: typeof FrameType.Auth;
  token: string;
}

export interface AttachFrame {
  type: typeof FrameType.Attach;
  sessionId?: string; // empty = create new
  // Client-chosen id for a session being created. Makes create idempotent: a
  // replay after a drop before `ready` resumes the session instead of making a
  // second one. Ignored by pre-v2 daemons.
  newSessionId?: string;
  cols: number;
  rows: number;
  workdir?: string; // working directory for new sessions
  flags?: string[]; // selected claude_flags ids (new session only)
  mode?: SessionMode; // omitted = normal
  // v3. Session kind on create; must match the session on resume, otherwise
  // ui_mismatch. Omitted = terminal.
  ui?: SessionUI;
  // v3, chat resume only: the last position this client fully received, read
  // when the attach is sent. Both present and still valid = incremental resync.
  epoch?: string;
  since?: number;
  // v3, create with ui terminal only: hand this chat session over to the new
  // terminal session (workdir/flags/mode are then ignored).
  handoffFrom?: string;
}

export interface DataFrameC2S {
  type: typeof FrameType.Data;
  payload: string; // base64
}

export interface ResizeFrame {
  type: typeof FrameType.Resize;
  cols: number;
  rows: number;
}

export interface PingFrame {
  type: typeof FrameType.Ping;
}

// --- Server → Client ---

export interface ReadyFrame {
  type: typeof FrameType.Ready;
  sessionId: string;
  workdir: string;
  proto?: number; // daemon's protocol version; absent = 1
  mode: SessionMode;
  sourceWorkdir?: string;
  sourceRepo?: string;
  worktreeRoot?: string;
  branch?: string;
  // v3, chat sessions only (absent on a terminal ready).
  ui?: SessionUI;
  claudeSessionId?: string;
  /** A create became an attach of another session already running that claude conversation. */
  existing?: boolean;
  /** Echoed for a terminal session created by a handoff. */
  handoffFrom?: string;
}

export interface DataFrameS2C {
  type: typeof FrameType.Data;
  payload: string; // base64
}

export interface SessionInfo {
  id: string;
  title: string;
  workdir: string;
  created: string;
  mode: SessionMode;
  sourceWorkdir?: string;
  sourceRepo?: string;
  worktreeRoot?: string;
  branch?: string;
  // v3, chat sessions only (absent on terminal entries).
  ui?: SessionUI;
  state?: ChatStatus;
  /** Highest seq of `epoch`; a change means new activity. */
  activitySeq?: number;
  epoch?: string;
  endReason?: ChatEndReason;
}

export interface SessionsFrame {
  type: typeof FrameType.Sessions;
  list: SessionInfo[];
}

export interface ExitFrame {
  type: typeof FrameType.Exit;
  code: number;
}

export interface ErrorFrame {
  type: typeof FrameType.Error;
  message: string;
  // Stable reason (open set, e.g. 'session_not_found'). Absent on pre-v2 daemons.
  code?: string;
  // Retrying the same request cannot succeed: stop reconnecting.
  fatal?: boolean;
}

export interface PongFrame {
  type: typeof FrameType.Pong;
}

export interface NotifyFrame {
  type: typeof FrameType.Notify;
  sessionId: string;
  kind: string; // 'idle' | 'waiting' | future kinds (open enum)
  message?: string;
}

// --- Chat UI (v3) ---

export type ChatStatus = 'idle' | 'running' | 'waiting' | 'ended';
export type ChatEndReason =
  | 'exited'
  | 'daemon_restart'
  | 'handed_off'
  | 'version_unsupported'
  | 'stopped'
  | 'restart_failed';
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/**
 * One chat message: a claude stream-json stdout line verbatim, or a
 * daemon-synthesized one (user echo with vr_client_msg_id, vr_resolved,
 * vr_notice, vr_exit). History frames have seq 0 and h true.
 */
export interface ChatFrame {
  type: typeof FrameType.Chat;
  seq: number;
  h?: boolean;
  msg: Record<string, unknown>;
}

/** Opens a sync: historyCount history frames (reset only), backlog frames, then chat_state. */
export interface ChatSyncFrame {
  type: typeof FrameType.ChatSync;
  epoch: string;
  reset: boolean;
  omitted: number;
  historyCount: number;
  backlog: number;
}

export interface PendingRequest {
  requestId: string;
  seq: number;
  /** claude's can_use_tool request object verbatim. */
  request: Record<string, unknown>;
}

export interface SlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}

export interface ChatEnded {
  reason: ChatEndReason;
  code?: number;
  message?: string;
  handedOffTo?: string;
  stderrTail?: string;
  claudeVersion?: string;
  minClaudeVersion?: string;
}

/** Full chat state; broadcast on change and sent as the end mark of a sync. */
export interface ChatStateFrame {
  type: typeof FrameType.ChatState;
  status: ChatStatus;
  permissionMode: PermissionMode | string;
  permissionLocked: boolean;
  /** Authoritative list of open prompts. */
  pending: PendingRequest[];
  degraded?: string[];
  slashCommands: SlashCommand[];
  claudeVersion: string;
  claudeSessionId: string;
  ended: ChatEnded | null;
}

export type ChatAckOp = 'send' | 'respond' | 'interrupt' | 'set_mode';

/** Reply to one chat C→S frame, sent to its sender only (not an error frame). */
export interface ChatAckFrame {
  type: typeof FrameType.ChatAck;
  op: ChatAckOp;
  /** clientMsgId (send), requestId (respond) or the requested mode (set_mode) */
  ref?: string;
  ok: boolean;
  // 'empty' | 'too_large' | 'chat_not_running' | 'request_not_pending' |
  // 'foreign_rule' | 'chat_busy' | 'invalid_mode' | 'invalid_response' |
  // 'mode_locked' (open set)
  code?: string;
  message?: string;
  /** op 'send' only: this clientMsgId was already accepted; nothing was written again */
  duplicate?: boolean;
  /** with duplicate: whether a result for that message has been seen */
  completed?: boolean;
}

export interface ChatSendFrame {
  type: typeof FrameType.ChatSend;
  clientMsgId: string;
  text: string;
}

export interface ChatResponse {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
  message?: string;
  interrupt?: boolean;
}

export interface ChatRespondFrame {
  type: typeof FrameType.ChatRespond;
  requestId: string;
  response: ChatResponse;
  /** Only when answering ExitPlanMode; a permissionLocked session drops it silently. */
  setMode?: 'acceptEdits' | 'default';
}

export interface ChatInterruptFrame {
  type: typeof FrameType.ChatInterrupt;
}

export interface ChatSetModeFrame {
  type: typeof FrameType.ChatSetMode;
  mode: 'default' | 'acceptEdits' | 'plan';
}

// Union of all server→client frames
export type ServerFrame =
  | ReadyFrame
  | DataFrameS2C
  | SessionsFrame
  | ExitFrame
  | ErrorFrame
  | PongFrame
  | NotifyFrame
  | ChatFrame
  | ChatSyncFrame
  | ChatStateFrame
  | ChatAckFrame;

// Union of all client→server frames
export type ClientFrame =
  | AuthFrame
  | AttachFrame
  | DataFrameC2S
  | ResizeFrame
  | PingFrame
  | ChatSendFrame
  | ChatRespondFrame
  | ChatInterruptFrame
  | ChatSetModeFrame;

// --- Machine config (client-side) ---

export interface MachineConfig {
  name: string;
  addr: string; // tailscale IP or MagicDNS name
  port: number;
  token: string;
}

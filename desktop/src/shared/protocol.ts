// Protocol frame types — mirrors vibe-remoted/internal/protocol/protocol.go

/**
 * Protocol revision this client speaks (protocol.Version in Go). Daemons that
 * predate the field report nothing, which reads as 1.
 */
export const PROTOCOL_VERSION = 2;

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
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

// --- Client → Server ---

export type SessionMode = 'normal' | 'worktree';

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

// Union of all server→client frames
export type ServerFrame =
  | ReadyFrame
  | DataFrameS2C
  | SessionsFrame
  | ExitFrame
  | ErrorFrame
  | PongFrame
  | NotifyFrame;

// Union of all client→server frames
export type ClientFrame =
  | AuthFrame
  | AttachFrame
  | DataFrameC2S
  | ResizeFrame
  | PingFrame;

// --- Machine config (client-side) ---

export interface MachineConfig {
  name: string;
  addr: string; // tailscale IP or MagicDNS name
  port: number;
  token: string;
}

// Protocol frame types — 与 vibe-remoted/internal/protocol/protocol.go 手工对齐。
// 单一事实来源 TS 端在此。desktop/src/shared/protocol.ts 只是 re-export 薄壳。

export const FrameType = {
  Auth: 'auth',
  Attach: 'attach',
  Ready: 'ready',
  Data: 'data',
  Ping: 'ping',
  Pong: 'pong',
  Exit: 'exit',
  Error: 'error',
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

// --- Client → Server ---
export interface AuthFrame {
  type: typeof FrameType.Auth;
  token: string;
}

export interface AttachFrame {
  type: typeof FrameType.Attach;
  workdir?: string;  // 会话 = workdir（headless 唯一线）
  flags?: string[];  // 选中的 claude_flags id 列表
}

export interface DataFrameC2S {
  type: typeof FrameType.Data;
  payload: string; // base64
}

export interface PingFrame {
  type: typeof FrameType.Ping;
}

// --- Server → Client ---
export interface ReadyFrame {
  type: typeof FrameType.Ready;
  workdir: string;
}

export interface DataFrameS2C {
  type: typeof FrameType.Data;
  payload: string; // base64
}

export interface ExitFrame {
  type: typeof FrameType.Exit;
  code: number;
}

export interface ErrorFrame {
  type: typeof FrameType.Error;
  message: string;
}

export interface PongFrame {
  type: typeof FrameType.Pong;
}

export type ServerFrame = ReadyFrame | DataFrameS2C | ExitFrame | ErrorFrame | PongFrame;
export type ClientFrame = AuthFrame | AttachFrame | DataFrameC2S | PingFrame;

// --- Machine config (client-side) ---
export interface MachineConfig {
  name: string;
  addr: string;
  port: number;
  token: string;
}

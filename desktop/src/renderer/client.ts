import {
  FrameType,
  type AuthFrame,
  type AttachFrame,
  type DataFrameC2S,
  type ResizeFrame,
  type PingFrame,
  type ServerFrame,
  type SessionInfo,
  type MachineConfig,
} from '../shared/protocol';

export enum ConnectionState {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
  Reconnecting = 'reconnecting',
  Error = 'error',
}

const RECONNECT_BASE_DELAY = 1000; // 1s
const RECONNECT_MAX_DELAY = 30000; // 30s
const PING_INTERVAL = 25000; // 25s

/**
 * VibeRemoteClient manages the WebSocket connection to a single vibe-remoted instance.
 * Handles auth, attach, data relay, ping/pong, and auto-reconnect.
 */
export class VibeRemoteClient {
  machine: MachineConfig;
  state: ConnectionState = ConnectionState.Disconnected;

  // Callbacks
  onStateChange?: (state: ConnectionState, attempt: number) => void;
  onData?: (payload: string) => void;
  onSessionList?: (sessions: SessionInfo[]) => void;
  onExit?: (code: number) => void;
  onError?: (message: string) => void;
  onReady?: (sessionId: string, workdir: string) => void;
  onNotify?: (kind: string, message?: string) => void;

  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private currentSessionId: string | null = null;
  private pendingAttach: { sessionId: string; cols: number; rows: number; workdir?: string } | null = null;
  // Last known terminal size, so a reconnect re-attaches at the correct
  // dimensions instead of a default 80x24 (which would misdraw until resize).
  private lastCols = 80;
  private lastRows = 24;

  constructor(machine: MachineConfig) {
    this.machine = machine;
  }

  /** Initiate connection to the server. */
  connect() {
    if (this.ws) {
      this.ws.close();
    }

    this.setState(ConnectionState.Connecting);

    const url = `ws://${this.machine.addr}:${this.machine.port}/ws`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      // Note: reconnectAttempt is reset on `ready` (a proven-healthy
      // connection), not here — otherwise a server that accepts the socket
      // then immediately closes it (bad token, attach failure) would reset the
      // backoff every cycle and hammer the server once per second forever.
      // Send auth immediately
      this.send<AuthFrame>({ type: FrameType.Auth, token: this.machine.token });
      this.setState(ConnectionState.Connected);
      this.startPing();

      // If we have a pending attach (initial connect or reconnect), send it
      if (this.pendingAttach) {
        this.send<AttachFrame>({
          type: FrameType.Attach,
          sessionId: this.pendingAttach.sessionId || undefined,
          cols: this.pendingAttach.cols,
          rows: this.pendingAttach.rows,
          workdir: this.pendingAttach.workdir,
        });
        this.pendingAttach = null;
      }
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data as string);
    };

    this.ws.onclose = () => {
      this.stopPing();
      if (this.state !== ConnectionState.Disconnected) {
        this.setState(ConnectionState.Reconnecting);
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this.setState(ConnectionState.Error);
    };
  }

  /** Disconnect and stop reconnecting. */
  disconnect() {
    this.setState(ConnectionState.Disconnected);
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Skip the backoff wait and reconnect immediately (manual retry). */
  reconnectNow() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.currentSessionId) {
      this.pendingAttach = {
        sessionId: this.currentSessionId,
        cols: this.lastCols,
        rows: this.lastRows,
      };
    }
    this.connect();
  }

  /** Attach to a session (empty sessionId = create new). */
  attach(sessionId: string, cols: number, rows: number, workdir?: string) {
    this.currentSessionId = sessionId || null;
    this.lastCols = cols;
    this.lastRows = rows;

    if (this.state === ConnectionState.Connected && this.ws) {
      this.send<AttachFrame>({
        type: FrameType.Attach,
        sessionId: sessionId || undefined,
        cols,
        rows,
        workdir,
      });
    } else {
      // Connection not ready yet — store the full attach (including workdir)
      // to send on open. Dropping workdir here is what made new sessions
      // always land in the default dir instead of the chosen one.
      this.pendingAttach = { sessionId, cols, rows, workdir };
    }
  }

  /** Send terminal data (keyboard input). */
  sendData(base64Payload: string) {
    this.send<DataFrameC2S>({ type: FrameType.Data, payload: base64Payload });
  }

  /** Send resize event. */
  sendResize(cols: number, rows: number) {
    this.lastCols = cols;
    this.lastRows = rows;
    this.send<ResizeFrame>({ type: FrameType.Resize, cols, rows });
  }

  // --- Private ---

  private handleMessage(raw: string) {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }

    switch (frame.type) {
      case FrameType.Ready:
        // A ready frame means auth + attach succeeded — the connection is
        // healthy, so it's safe to reset the backoff counter now.
        this.reconnectAttempt = 0;
        this.currentSessionId = frame.sessionId;
        this.onReady?.(frame.sessionId, frame.workdir);
        break;

      case FrameType.Data:
        this.onData?.(frame.payload);
        break;

      case FrameType.Sessions:
        this.onSessionList?.(frame.list);
        break;

      case FrameType.Exit:
        this.onExit?.(frame.code);
        this.currentSessionId = null;
        break;

      case FrameType.Error:
        this.onError?.(frame.message);
        break;

      case FrameType.Notify:
        this.onNotify?.(frame.kind, frame.message);
        break;

      case FrameType.Pong:
        // Keepalive acknowledged
        break;
    }
  }

  private send<T>(frame: T) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private setState(state: ConnectionState) {
    this.state = state;
    this.onStateChange?.(state, this.reconnectAttempt);
  }

  private scheduleReconnect() {
    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_DELAY,
    );
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      // Re-attach the same session at the last known size so the restored
      // screen draws correctly instead of at a default 80x24.
      if (this.currentSessionId) {
        this.pendingAttach = {
          sessionId: this.currentSessionId,
          cols: this.lastCols,
          rows: this.lastRows,
        };
      }
      this.connect();
    }, delay);
  }

  private startPing() {
    this.pingTimer = setInterval(() => {
      this.send<PingFrame>({ type: FrameType.Ping });
    }, PING_INTERVAL);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

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
 * CcdeskClient manages the WebSocket connection to a single ccdeskd instance.
 * Handles auth, attach, data relay, ping/pong, and auto-reconnect.
 */
export class CcdeskClient {
  machine: MachineConfig;
  state: ConnectionState = ConnectionState.Disconnected;

  // Callbacks
  onStateChange?: (state: ConnectionState) => void;
  onData?: (payload: string) => void;
  onSessionList?: (sessions: SessionInfo[]) => void;
  onExit?: (code: number) => void;
  onError?: (message: string) => void;
  onReady?: (sessionId: string, workdir: string) => void;

  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private currentSessionId: string | null = null;
  private pendingAttach: { sessionId: string; cols: number; rows: number } | null = null;

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
      this.reconnectAttempt = 0;
      // Send auth immediately
      this.send<AuthFrame>({ type: FrameType.Auth, token: this.machine.token });
      this.setState(ConnectionState.Connected);
      this.startPing();

      // If we have a pending attach (reconnect scenario), send it
      if (this.pendingAttach) {
        this.send<AttachFrame>({
          type: FrameType.Attach,
          sessionId: this.pendingAttach.sessionId,
          cols: this.pendingAttach.cols,
          rows: this.pendingAttach.rows,
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

  /** Attach to a session (empty sessionId = create new). */
  attach(sessionId: string, cols: number, rows: number, workdir?: string) {
    this.currentSessionId = sessionId || null;

    if (this.state === ConnectionState.Connected && this.ws) {
      this.send<AttachFrame>({
        type: FrameType.Attach,
        sessionId: sessionId || undefined,
        cols,
        rows,
        workdir,
      });
    } else {
      // Store for when connection is established
      this.pendingAttach = { sessionId, cols, rows };
    }
  }

  /** Send terminal data (keyboard input). */
  sendData(base64Payload: string) {
    this.send<DataFrameC2S>({ type: FrameType.Data, payload: base64Payload });
  }

  /** Send resize event. */
  sendResize(cols: number, rows: number) {
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
    this.onStateChange?.(state);
  }

  private scheduleReconnect() {
    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_DELAY,
    );
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      // Set up pending attach for reconnect (re-attach same session)
      if (this.currentSessionId) {
        this.pendingAttach = { sessionId: this.currentSessionId, cols: 80, rows: 24 };
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

import {
  FrameType,
  type AuthFrame,
  type AttachFrame,
  type DataFrameC2S,
  type PingFrame,
  type ServerFrame,
  type MachineConfig,
} from './protocol';

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
 *
 * headless 唯一线：会话 = workdir，无 sessionId/cols/rows/resize/mode。
 */
export class VibeRemoteClient {
  machine: MachineConfig;
  state: ConnectionState = ConnectionState.Disconnected;

  // Callbacks
  onStateChange?: (state: ConnectionState, attempt: number) => void;
  onData?: (payload: string) => void;
  onExit?: (code: number) => void;
  onError?: (message: string) => void;
  onReady?: (workdir: string) => void;

  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pendingAttach: { workdir?: string; flags?: string[] } | null = null;
  // Last attach args, so a reconnect re-attaches the same workdir instead of
  // falling back to the default dir (dropping workdir on reconnect was a past bug).
  private lastAttach: { workdir?: string; flags?: string[] } | null = null;

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
          workdir: this.pendingAttach.workdir,
          flags: this.pendingAttach.flags,
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
    if (this.lastAttach) {
      this.pendingAttach = { workdir: this.lastAttach.workdir, flags: this.lastAttach.flags };
    }
    this.connect();
  }

  /** Attach to a session by workdir (headless 唯一线). */
  attach(workdir?: string, flags?: string[]) {
    this.lastAttach = { workdir, flags };

    if (this.state === ConnectionState.Connected && this.ws) {
      this.send<AttachFrame>({ type: FrameType.Attach, workdir, flags });
    } else {
      // Connection not ready yet — store the attach (including workdir/flags)
      // to send on open. Dropping workdir here is what made new sessions
      // always land in the default dir instead of the chosen one.
      this.pendingAttach = { workdir, flags };
    }
  }

  /** Send terminal data (keyboard input). */
  sendData(base64Payload: string) {
    this.send<DataFrameC2S>({ type: FrameType.Data, payload: base64Payload });
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
        this.onReady?.(frame.workdir);
        break;

      case FrameType.Data:
        this.onData?.(frame.payload);
        break;

      case FrameType.Exit:
        this.onExit?.(frame.code);
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
    this.onStateChange?.(state, this.reconnectAttempt);
  }

  private scheduleReconnect() {
    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_DELAY,
    );
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      // Re-attach the same workdir so the restored session resumes the right
      // conversation instead of landing in the default dir.
      if (this.lastAttach) {
        this.pendingAttach = { workdir: this.lastAttach.workdir, flags: this.lastAttach.flags };
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

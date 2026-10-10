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
  type SessionMode,
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
/** Everything needed to (re)issue an attach, so a reconnect can replay it. */
type AttachIntent = {
  sessionId: string;
  cols: number;
  rows: number;
  workdir?: string;
  flags?: string[];
  mode?: SessionMode;
};

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
  private pendingAttach: AttachIntent | null = null;
  // The attach we sent but haven't seen a `ready` for yet. A reconnect resends
  // this verbatim: until ready arrives we have no sessionId (a brand-new session
  // gets its id from the server), so without it a drop in that window would
  // leave the client connected but attached to nothing. It also carries
  // workdir/flags/mode, which a sessionId-only re-attach would lose.
  private unconfirmedAttach: AttachIntent | null = null;
  // Last known terminal size, so a reconnect re-attaches at the correct
  // dimensions instead of a default 80x24 (which would misdraw until resize).
  private lastCols = 80;
  private lastRows = 24;

  constructor(machine: MachineConfig) {
    this.machine = machine;
  }

  /** Initiate connection to the server. */
  connect() {
    // Retire the old socket before closing it. Its onclose would otherwise
    // fire after this.ws already points at the new socket, stop the new
    // socket's ping timer and schedule another reconnect — which calls
    // connect() again and loops.
    this.detachSocket();
    this.stopPing();
    // A direct connect() supersedes any backoff already queued; letting that
    // timer fire later would tear down the socket we are about to open.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.setState(ConnectionState.Connecting);

    const url = `ws://${this.machine.addr}:${this.machine.port}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;

    // Every handler checks it still belongs to the current socket: a late
    // event from a superseded socket (e.g. one queued before the nulling
    // above took effect) must not touch the live connection's state.
    ws.onopen = () => {
      if (ws !== this.ws) return;
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
        this.sendAttach(this.pendingAttach);
        this.pendingAttach = null;
      }
    };

    ws.onmessage = (event) => {
      if (ws !== this.ws) return;
      this.handleMessage(event.data as string);
    };

    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.stopPing();
      if (this.state !== ConnectionState.Disconnected) {
        this.setState(ConnectionState.Reconnecting);
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      if (ws !== this.ws) return;
      this.setState(ConnectionState.Error);
    };
  }

  // detachSocket unbinds and closes the current socket so none of its events
  // can reach this client any more.
  private detachSocket() {
    const old = this.ws;
    if (!old) return;
    this.ws = null;
    old.onopen = null;
    old.onclose = null;
    old.onerror = null;
    old.onmessage = null;
    old.close();
  }

  /** Disconnect and stop reconnecting. */
  disconnect() {
    this.setState(ConnectionState.Disconnected);
    this.stopPing();
    // Deliberate close: drop any attach we were holding for replay so a later
    // connect() doesn't resurrect a session the caller already walked away from.
    this.unconfirmedAttach = null;
    this.pendingAttach = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.detachSocket();
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
  attach(sessionId: string, cols: number, rows: number, workdir?: string, flags?: string[], mode?: SessionMode) {
    this.currentSessionId = sessionId || null;
    this.lastCols = cols;
    this.lastRows = rows;

    if (this.state === ConnectionState.Connected && this.ws) {
      this.sendAttach({ sessionId, cols, rows, workdir, flags, mode });
    } else {
      // Connection not ready yet — store the full attach (including workdir/flags)
      // to send on open. Dropping workdir here is what made new sessions
      // always land in the default dir instead of the chosen one.
      this.pendingAttach = { sessionId, cols, rows, workdir, flags, mode };
    }
  }

  // sendAttach writes the frame and remembers the intent until `ready` confirms
  // it, so a disconnect in between can replay the exact same attach.
  private sendAttach(intent: AttachIntent) {
    this.unconfirmedAttach = intent;
    this.send<AttachFrame>({
      type: FrameType.Attach,
      sessionId: intent.sessionId || undefined,
      cols: intent.cols,
      rows: intent.rows,
      workdir: intent.workdir,
      flags: intent.flags,
      mode: intent.mode,
    });
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
        // healthy, so it's safe to reset the backoff counter now. The attach is
        // confirmed, so stop holding it for replay: from here on the server has
        // given us a sessionId and a plain re-attach is enough.
        this.reconnectAttempt = 0;
        this.unconfirmedAttach = null;
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
      // Re-attach at the last known size so the restored screen draws correctly
      // instead of at a default 80x24.
      if (this.unconfirmedAttach) {
        // Never confirmed by a `ready`. Replay it as-is: for a new session we
        // still have no sessionId, and workdir/flags/mode would be lost if we
        // rebuilt the attach from currentSessionId alone.
        this.pendingAttach = { ...this.unconfirmedAttach, cols: this.lastCols, rows: this.lastRows };
      } else if (this.currentSessionId) {
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
    // Never stack intervals: a leaked one would keep pinging forever.
    this.stopPing();
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

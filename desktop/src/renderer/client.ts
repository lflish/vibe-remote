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
  type SessionUI,
  type ReadyFrame,
  type ChatSyncFrame,
  type ChatStateFrame,
  type ChatAckFrame,
  type ChatSendFrame,
  type ChatRespondFrame,
  type ChatResponse,
  type ChatInterruptFrame,
  type ChatSetModeFrame,
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
// A connection whose last MAX_MISSED_PONGS pings each went by without a single
// incoming frame is treated as dead. Without this a half-open socket (lid
// closed, network switched) never fires onclose and the UI shows "connected"
// indefinitely.
//
// This counts unanswered pings instead of comparing wall-clock silence to a
// timeout on purpose: Chromium throttles timers in a hidden/minimized window to
// about one tick a minute, so pings (and therefore pongs) arrive far apart even
// on a perfectly healthy link, and any fixed silence timeout would tear every
// background session down in a loop.
const MAX_MISSED_PONGS = 2;

// newSessionId returns the client-chosen id for a session being created. The
// daemon uses it to make create idempotent (see AttachFrame.newSessionId).
// Shape matches the daemon's generated ids: <ms timestamp>-<8 hex>.
export function newSessionId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${Date.now()}-${hex}`;
}

/**
 * VibeRemoteClient manages the WebSocket connection to a single vibe-remoted instance.
 * Handles auth, attach, data relay, ping/pong, and auto-reconnect.
 */
/** Everything needed to (re)issue an attach, so a reconnect can replay it. */
type AttachIntent = {
  sessionId: string;
  // Set for creates: replaying the same id resumes the session the first
  // attempt created instead of creating another.
  newSessionId?: string;
  cols: number;
  rows: number;
  workdir?: string;
  flags?: string[];
  mode?: SessionMode;
  // Session kind. A property of the session, so it is replayed on every
  // re-attach (automatic and manual), not just the create.
  ui?: SessionUI;
  // Create-only: the chat session this new terminal session takes over.
  handoffFrom?: string;
  // Create-only (worktree mode): the new branch's name. A replay before
  // `ready` must carry it again, with the same newSessionId.
  worktreeName?: string;
};

/** Options for attach() beyond the terminal-era positional arguments. */
export type AttachOptions = { ui?: SessionUI; handoffFrom?: string; worktreeName?: string };

/** Last fully-synced chat position: the epoch and the highest seq received in it. */
export type ChatPosition = { epoch: string; seq: number };

export class VibeRemoteClient {
  machine: MachineConfig;
  state: ConnectionState = ConnectionState.Disconnected;

  // Callbacks
  onStateChange?: (state: ConnectionState, attempt: number) => void;
  onData?: (payload: string) => void;
  onSessionList?: (sessions: SessionInfo[]) => void;
  onExit?: (code: number) => void;
  // fatal = the daemon says retrying cannot help; the client has already
  // stopped reconnecting (state is Disconnected).
  onError?: (message: string, fatal: boolean, code?: string) => void;
  onReady?: (sessionId: string, workdir: string, proto: number, ready: ReadyFrame) => void;
  onNotify?: (kind: string, message?: string) => void;
  // Chat (v3). onChat only sees frames past the last seq of the current epoch
  // (history frames, seq 0 + h, always pass).
  onChatSync?: (sync: ChatSyncFrame) => void;
  onChat?: (seq: number, msg: Record<string, unknown>, history: boolean) => void;
  onChatState?: (state: ChatStateFrame) => void;
  onChatAck?: (ack: ChatAckFrame) => void;

  /**
   * Resync position reported by a chat re-attach; read each time an attach is
   * sent (the position moves on between reconnects). Defaults to the client's
   * own tracking, which is non-null only after the closing chat_state of a
   * sync for the current epoch: a sync cut off halfway must resync from
   * scratch, not claim it already has everything.
   */
  chatPosition: () => ChatPosition | null = () =>
    this.chatSynced && this.chatEpoch ? { epoch: this.chatEpoch, seq: this.chatLastSeq } : null;

  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivity = 0; // ms timestamp of the last frame received
  private lastPingSent = 0; // ms timestamp of the last ping; 0 = none yet on this socket
  private missedPongs = 0; // consecutive pings followed by no incoming frame at all
  // Set by a fatal error frame. The server closes the socket right after it;
  // that close must not schedule a reconnect.
  private fatalError = false;
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
  // Kind of the attached session, so replays keep ui:'chat'.
  private currentUI: SessionUI | undefined;
  // Chat resync tracking (see chatPosition).
  private chatEpoch = '';
  private chatLastSeq = 0;
  private chatSynced = false;
  private chatSyncing = false;

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
    this.fatalError = false;

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
      this.lastActivity = Date.now();
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
      this.lastActivity = Date.now();
      this.handleMessage(event.data as string);
    };

    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.stopPing();
      if (this.fatalError) {
        // The daemon rejected the request outright; replaying it would fail
        // the same way, forever. Stay down until the caller reconnects.
        this.setState(ConnectionState.Disconnected);
        return;
      }
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
    this.pendingAttach = this.replayIntent();
    this.connect();
  }

  /** Attach to a session (empty sessionId = create new). */
  attach(
    sessionId: string,
    cols: number,
    rows: number,
    workdir?: string,
    flags?: string[],
    mode?: SessionMode,
    opts?: AttachOptions,
  ) {
    this.currentSessionId = sessionId || null;
    this.currentUI = opts?.ui;
    this.lastCols = cols;
    this.lastRows = rows;
    this.resetChatTracking();
    // A create gets its id now, not from the server, so every replay of this
    // attach names the same session (see AttachFrame.newSessionId).
    const intent: AttachIntent = sessionId
      ? { sessionId, cols, rows, ui: opts?.ui }
      : {
          sessionId: '',
          newSessionId: newSessionId(),
          cols,
          rows,
          workdir,
          flags,
          mode,
          ui: opts?.ui,
          handoffFrom: opts?.handoffFrom,
          worktreeName: opts?.worktreeName,
        };

    if (this.state === ConnectionState.Connected && this.ws) {
      this.sendAttach(intent);
    } else {
      // Connection not ready yet — store the full attach (including workdir/flags)
      // to send on open. Dropping workdir here is what made new sessions
      // always land in the default dir instead of the chosen one.
      this.pendingAttach = intent;
    }
  }

  // sendAttach writes the frame and remembers the intent until `ready` confirms
  // it, so a disconnect in between can replay the exact same attach.
  private sendAttach(intent: AttachIntent) {
    this.unconfirmedAttach = intent;
    // A chat resume reports where it got to, read now rather than when the
    // intent was made: the position has moved on since.
    const pos = intent.ui === 'chat' && intent.sessionId ? this.chatPosition() : null;
    this.send<AttachFrame>({
      type: FrameType.Attach,
      sessionId: intent.sessionId || undefined,
      newSessionId: intent.newSessionId,
      cols: intent.cols,
      rows: intent.rows,
      workdir: intent.workdir,
      flags: intent.flags,
      mode: intent.mode,
      ui: intent.ui,
      epoch: pos ? pos.epoch : undefined,
      since: pos ? pos.seq : undefined,
      handoffFrom: intent.handoffFrom,
      worktreeName: intent.worktreeName,
    });
  }

  // replayIntent is the attach a reconnect should send, at the last known size
  // so the restored screen draws correctly instead of at a default 80x24. An
  // attach never confirmed by `ready` is replayed as-is: for a new session it
  // carries the newSessionId and the workdir/flags/mode that a rebuild from
  // currentSessionId alone would lose.
  private replayIntent(): AttachIntent | null {
    if (this.unconfirmedAttach) {
      return { ...this.unconfirmedAttach, cols: this.lastCols, rows: this.lastRows };
    }
    if (this.currentSessionId) {
      // handoffFrom and worktreeName belong to the create only; ui stays with the session.
      return { sessionId: this.currentSessionId, cols: this.lastCols, rows: this.lastRows, ui: this.currentUI };
    }
    return null;
  }

  private resetChatTracking() {
    this.chatEpoch = '';
    this.chatLastSeq = 0;
    this.chatSynced = false;
    this.chatSyncing = false;
  }

  /** Send terminal data (keyboard input). */
  sendData(base64Payload: string) {
    this.send<DataFrameC2S>({ type: FrameType.Data, payload: base64Payload });
  }

  /** Send a chat message. Returns false when the socket is not open. */
  sendChat(text: string, clientMsgId: string): boolean {
    return this.send<ChatSendFrame>({ type: FrameType.ChatSend, clientMsgId, text });
  }

  /** Answer a pending can_use_tool request. */
  respond(requestId: string, response: ChatResponse, setMode?: 'acceptEdits' | 'default'): boolean {
    return this.send<ChatRespondFrame>({ type: FrameType.ChatRespond, requestId, response, setMode });
  }

  /** Interrupt the running turn. */
  interrupt(): boolean {
    return this.send<ChatInterruptFrame>({ type: FrameType.ChatInterrupt });
  }

  /** Switch the permission mode. */
  setMode(mode: 'default' | 'acceptEdits' | 'plan'): boolean {
    return this.send<ChatSetModeFrame>({ type: FrameType.ChatSetMode, mode });
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
        if (frame.ui) this.currentUI = frame.ui;
        this.onReady?.(frame.sessionId, frame.workdir, frame.proto ?? 1, frame);
        break;

      case FrameType.Data:
        this.onData?.(frame.payload);
        break;

      case FrameType.Sessions:
        this.onSessionList?.(frame.list);
        break;

      case FrameType.Exit:
        this.onExit?.(frame.code);
        // A chat session outlives its process: reload restarts it under the
        // same id, so keep re-attaching to it. A terminal session is gone.
        if (this.currentUI !== 'chat') this.currentSessionId = null;
        break;

      case FrameType.Error:
        if (frame.fatal) {
          // Retrying the same attach cannot succeed (session gone, workdir
          // rejected, bad token). Drop everything we would replay; onclose
          // sees fatalError and stops instead of reconnecting forever.
          this.fatalError = true;
          this.unconfirmedAttach = null;
          this.pendingAttach = null;
          this.currentSessionId = null;
        }
        this.onError?.(frame.message, frame.fatal === true, frame.code);
        break;

      case FrameType.Notify:
        this.onNotify?.(frame.kind, frame.message);
        break;

      case FrameType.Pong:
        // Keepalive acknowledged
        break;

      case FrameType.ChatSync:
        if (frame.reset || frame.epoch !== this.chatEpoch) this.chatLastSeq = 0;
        this.chatEpoch = frame.epoch;
        this.chatSynced = false;
        this.chatSyncing = true;
        this.onChatSync?.(frame);
        break;

      case FrameType.Chat:
        if (frame.h) {
          this.onChat?.(0, frame.msg, true);
          break;
        }
        // Drop anything already seen in this epoch (a replayed backlog that
        // overlaps the live stream).
        if (frame.seq <= this.chatLastSeq) break;
        this.chatLastSeq = frame.seq;
        this.onChat?.(frame.seq, frame.msg, false);
        break;

      case FrameType.ChatState:
        // The chat_state closing a sync: the position is now trustworthy.
        if (this.chatSyncing) {
          this.chatSyncing = false;
          this.chatSynced = true;
        }
        this.onChatState?.(frame);
        break;

      case FrameType.ChatAck:
        // An answer to one of our chat frames, not a connection error.
        this.onChatAck?.(frame);
        break;
    }
  }

  private send<T>(frame: T): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
      return true;
    }
    return false;
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
      this.pendingAttach = this.replayIntent();
      this.connect();
    }, delay);
  }

  private startPing() {
    // Never stack intervals: a leaked one would keep pinging forever.
    this.stopPing();
    // Fresh socket, fresh count: an unanswered ping on the previous socket
    // says nothing about this one.
    this.lastPingSent = 0;
    this.missedPongs = 0;
    this.pingTimer = setInterval(() => {
      // Liveness watchdog. Any frame since the previous ping (pong, data,
      // sessions…) proves the link is alive; see MAX_MISSED_PONGS for why this
      // is not a silence timeout. A half-open socket never fires onclose, so
      // close it ourselves; detachSocket + scheduleReconnect mirror onclose.
      if (this.lastPingSent > 0 && this.lastActivity < this.lastPingSent) {
        this.missedPongs++;
      } else {
        this.missedPongs = 0;
      }
      if (this.missedPongs >= MAX_MISSED_PONGS) {
        this.stopPing();
        this.detachSocket();
        this.setState(ConnectionState.Reconnecting);
        this.scheduleReconnect();
        return;
      }
      this.send<PingFrame>({ type: FrameType.Ping });
      this.lastPingSent = Date.now();
    }, PING_INTERVAL);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

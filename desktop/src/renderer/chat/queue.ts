// Client send queue (design 6.8, R9). Pure logic, zero DOM.
//
// A message is sent only when this desktop's previous message has been echoed
// by the daemon AND paired with its result. Results pair FIFO with echoes of
// every desktop (claude runs written messages one by one, each yielding exactly
// one result), so another desktop's turn never confuses which result is ours,
// and the global status is not needed while we have a previous message. With
// no previous message we follow the daemon's status: idle → send, busy → wait.

import type { ChatStatus, SlashCommand } from '../../shared/protocol';

export interface QueueItem {
  /** clientMsgId the message is sent with. */
  id: string;
  text: string;
}

/** Commands that only work in claude's TUI (R10.2). */
export const TERMINAL_ONLY_COMMANDS: readonly string[] = [
  'login',
  'logout',
  'theme',
  'vim',
  'terminal-setup',
  'ide',
  'config',
  'doctor',
  'exit',
  'resume',
];

/** 'terminalOnly' for a /command that is not offered by the session and only works in the terminal. */
export function classifySlash(text: string, slashCommands: readonly SlashCommand[]): 'send' | 'terminalOnly' {
  const m = /^\/([^\s/]+)/.exec(text.trim());
  if (!m) return 'send';
  const name = m[1];
  if (slashCommands.some((c) => c.name.replace(/^\//, '') === name)) return 'send';
  return TERMINAL_ONLY_COMMANDS.includes(name) ? 'terminalOnly' : 'send';
}

/**
 * Slash menu entries for the input text (R10.1): only while the input is a
 * single word starting with `/`; prefix match on the name, case-insensitive.
 */
export function filterSlashCommands(commands: readonly SlashCommand[], input: string): SlashCommand[] {
  const m = /^\/(\S*)$/.exec(input);
  if (!m) return [];
  const q = m[1].toLowerCase();
  return commands.filter((c) => c.name.replace(/^\//, '').toLowerCase().startsWith(q));
}

export class SendQueue {
  /** Waiting to be sent, in order. */
  private items: QueueItem[] = [];
  /** Echoed messages (any desktop) still waiting for their result, in order. */
  private unpaired: string[] = [];
  /** Our last sent message and how far it got. */
  private lastOwn: string | null = null;
  private lastOwnEchoed = false;
  private lastOwnPaired = false;
  private status: ChatStatus = 'idle';

  /**
   * @param send writes the message to the connection; false = not sent (socket
   *   down), the item stays queued.
   * @param newId generates a clientMsgId.
   */
  constructor(
    private send: (item: QueueItem) => boolean,
    private newId: () => string,
  ) {}

  /** Queued (not yet sent) items, in order. */
  queued(): readonly QueueItem[] {
    return this.items;
  }

  /**
   * Adds a message and sends what can be sent. Blank text is ignored (R3.4):
   * returns null. `id` re-sends an undelivered message under its old
   * clientMsgId (the daemon drops duplicates).
   */
  enqueue(text: string, id?: string): QueueItem | null {
    if (!text.trim()) return null;
    if (id !== undefined) {
      // One entry per id: a second resend of the same message is the same
      // message, and the daemon would only answer it as a duplicate.
      const queued = this.items.find((it) => it.id === id);
      if (queued) return queued;
      if (this.inFlight(id)) return null;
    }
    const item = { id: id ?? this.newId(), text };
    this.items.push(item);
    this.pump();
    return item;
  }

  /** Whether this id is queued or sent and still waiting for its echo / result. */
  has(id: string): boolean {
    return this.items.some((it) => it.id === id) || this.inFlight(id);
  }

  private inFlight(id: string): boolean {
    return id === this.lastOwn && !(this.lastOwnEchoed && this.lastOwnPaired);
  }

  /** Withdraws a queued message (R9.2). */
  remove(id: string): boolean {
    const i = this.items.findIndex((it) => it.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    return true;
  }

  /** Whether a new message may be sent right now. */
  canSend(): boolean {
    if (this.lastOwn === null) return this.status === 'idle';
    return this.lastOwnEchoed && this.lastOwnPaired;
  }

  /** Sends queued items while allowed. Returns what was sent. */
  pump(): QueueItem[] {
    const sent: QueueItem[] = [];
    while (this.items.length && this.canSend()) {
      const item = this.items[0];
      if (!this.send(item)) break;
      this.items.shift();
      this.lastOwn = item.id;
      this.lastOwnEchoed = false;
      this.lastOwnPaired = false;
      sent.push(item);
    }
    return sent;
  }

  /** A user echo arrived (from any desktop). */
  onEcho(clientMsgId: string) {
    if (this.unpaired.includes(clientMsgId)) return;
    this.unpaired.push(clientMsgId);
    if (clientMsgId === this.lastOwn) this.lastOwnEchoed = true;
  }

  /** A result arrived; vr_stale results were already written off and pair with nothing. */
  onResult(stale = false) {
    if (stale) return;
    const id = this.unpaired.shift();
    if (id !== undefined && id === this.lastOwn) this.lastOwnPaired = true;
    this.pump();
  }

  /** vr_notice stale_turn / dropped_on_stop: the named message will get no result. */
  onStaleTurn(clientMsgId: string) {
    const i = this.unpaired.indexOf(clientMsgId);
    if (i >= 0) this.unpaired.splice(i, 1);
    if (clientMsgId === this.lastOwn) {
      this.lastOwnEchoed = true;
      this.lastOwnPaired = true;
    }
    this.pump();
  }

  /**
   * The daemon already had this message (chat_ack duplicate) and sends no new
   * echo for it. Completed: its result is in the past, nothing to wait for.
   * Not completed: it is the oldest message still waiting for a result (its
   * echo was evicted before anything we saw), so the next result is its.
   */
  onDuplicate(clientMsgId: string, completed: boolean) {
    const i = this.unpaired.indexOf(clientMsgId);
    if (completed) {
      if (i >= 0) this.unpaired.splice(i, 1);
      if (clientMsgId === this.lastOwn) {
        this.lastOwnEchoed = true;
        this.lastOwnPaired = true;
      }
    } else {
      if (i < 0) this.unpaired.unshift(clientMsgId);
      if (clientMsgId === this.lastOwn) this.lastOwnEchoed = true;
    }
    this.pump();
  }

  /** Our message never reached the daemon (no echo after a resync): stop waiting for it. */
  onUndelivered(clientMsgId: string) {
    this.onStaleTurn(clientMsgId);
  }

  /** The daemon's status. Idle means every written message has its result. */
  setStatus(status: ChatStatus) {
    this.status = status;
    if (status === 'idle') {
      this.unpaired = [];
      if (this.lastOwnEchoed) this.lastOwnPaired = true;
    }
    this.pump();
  }

  /** A reset sync replays the epoch's messages: pairing restarts from them. */
  resetPairing() {
    this.unpaired = [];
  }

  /** Interrupt: everything queued goes back to the input box, joined by blank lines (R9.3). */
  takeBackAll(): string {
    const text = this.items.map((it) => it.text).join('\n\n');
    this.items = [];
    return text;
  }
}

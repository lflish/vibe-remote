// Whether the bytes a background terminal session received changed what is on
// its screen — which is what decides the "new messages" dot (c7 of
// docs/changes/2026-11-16-project-worktrees).
//
// Bytes alone do not say that. tmux repaints every attached client whenever a
// session option is set, and the daemon sets options each time any session is
// created or renamed: every other open terminal session then receives a full
// repaint of the screen it already shows.
//
// Terminal mode is plain byte passthrough, and this keeps it so. Nothing here
// looks at the bytes, and nothing is read out of the screen: the bytes go to
// xterm as they came, always, and afterwards the text xterm now has on the
// screen is compared — equal or not equal — with the text it had before.

/** The part of an xterm `Terminal` that is read here. */
export interface ScreenSource {
  readonly rows: number;
  readonly buffer: {
    readonly active: {
      /** 'normal' or 'alternate'. */
      readonly type: string;
      /** The buffer line the first row of the screen shows; grows as lines scroll off the top. */
      readonly baseY: number;
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
}

/** A terminal that can be written to: the bytes, and a callback for when xterm has taken them in. */
export interface ScreenSink extends ScreenSource {
  write(data: Uint8Array, callback?: () => void): void;
}

/**
 * The screen as text: which buffer, how far it has scrolled, and the text of
 * each row without the blanks at its end. Only for comparing one screen with
 * another.
 *
 * Text only (d74). Where the cursor is and how the text is coloured are not in
 * it: a repaint moves the cursor about and sets colours again without
 * changing a thing the user would call new, and a prompt that sits idle must
 * not light the dot because the cursor went somewhere. How far the buffer has
 * scrolled is in it, so output that scrolls counts even when every line reads
 * the same as the one before.
 */
export function screenText(term: ScreenSource): string {
  const buf = term.buffer.active;
  let text = `${buf.type} ${buf.baseY}`;
  for (let y = 0; y < term.rows; y++) {
    text += '\n' + (buf.getLine(buf.baseY + y)?.translateToString(true) ?? '');
  }
  return text;
}

/**
 * Remembers the screen of one terminal while its session is in the background
 * and says whether it has changed since. Nothing is remembered, and nothing
 * computed, for a session that is being looked at.
 */
export class ScreenWatch {
  private seen: string | null = null;

  constructor(private readonly term: ScreenSource) {}

  /** Before bytes are written: the screen as it is now is what they are compared with, unless one is remembered already. */
  remember(): void {
    if (this.seen === null) this.seen = screenText(this.term);
  }

  /** After xterm has taken bytes in: whether the screen differs from the one remembered. The new one is remembered. */
  changed(): boolean {
    if (this.seen === null) return false;
    const now = screenText(this.term);
    if (now === this.seen) return false;
    this.seen = now;
    return true;
  }

  /** The session is being looked at, or its screen was reset: the next bytes that come in while it is in the background start from the screen as it is then. */
  forget(): void {
    this.seen = null;
  }
}

/**
 * Writes `data` to the terminal, as it is, and calls `onChange` if the screen
 * is another one once xterm has taken it in.
 */
export function writeWatched(term: ScreenSink, data: Uint8Array, watch: ScreenWatch, onChange: () => void): void {
  watch.remember();
  term.write(data, () => {
    if (watch.changed()) onChange();
  });
}

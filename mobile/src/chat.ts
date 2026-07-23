import { parseStreamLine } from './stream';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  text: string;
}

// ChatController owns the chat state (messages, loading, activity, cost/tokens)
// and is pure logic — no DOM. The view subscribes via onUpdate and re-renders.
// Keeping it DOM-free makes the accumulation logic unit-testable in isolation.
export class ChatController {
  messages: ChatMessage[] = [];
  loading = false;
  activity?: string; // current tool activity text ("Bash · git status"), shown in loading
  lastCostUsd?: number;
  lastInputTokens?: number;
  lastOutputTokens?: number;
  onUpdate?: () => void;

  // Seed prior history (from the jsonl-backed REST endpoint) before streaming.
  // Replaces the message list wholesale; does not touch loading/cost.
  setHistory(messages: ChatMessage[]): void {
    this.messages = messages;
    this.onUpdate?.();
  }

  // Start a new turn: record the user's prompt and an empty assistant bubble
  // that streamed deltas will fill in. loading=true drives the "思考中" state.
  startUserTurn(text: string): void {
    this.messages.push({ role: 'user', text });
    this.messages.push({ role: 'assistant', text: '' });
    this.loading = true;
    this.activity = undefined;
    this.onUpdate?.();
  }

  // Apply one NDJSON line. Text deltas append to the current assistant bubble;
  // tool events push a tool message + set activity; result ends the turn.
  applyLine(line: string): void {
    const ev = parseStreamLine(line);
    switch (ev.kind) {
      case 'delta': {
        let last = this.messages[this.messages.length - 1];
        // If the previous message was a tool card (not an assistant bubble),
        // open a fresh assistant bubble so text doesn't merge into the card.
        if (!last || last.role !== 'assistant') {
          this.messages.push({ role: 'assistant', text: '' });
          last = this.messages[this.messages.length - 1];
        }
        last.text += ev.text;
        this.onUpdate?.();
        break;
      }
      case 'tool': {
        const text = ev.summary ? `${ev.name} · ${ev.summary}` : ev.name;
        this.messages.push({ role: 'tool', text });
        this.activity = text;
        this.onUpdate?.();
        break;
      }
      case 'result':
        this.loading = false;
        this.activity = undefined;
        this.lastCostUsd = ev.costUsd;
        this.lastInputTokens = ev.inputTokens;
        this.lastOutputTokens = ev.outputTokens;
        this.onUpdate?.();
        break;
      case 'ignored':
        break;
    }
  }
}

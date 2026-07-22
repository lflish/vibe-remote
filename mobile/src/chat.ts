import { parseStreamLine } from './stream';

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

// ChatController owns the chat state (message list, loading, last cost) and is
// pure logic — no DOM. The view subscribes via onUpdate and re-renders. Keeping
// it DOM-free makes the accumulation logic unit-testable in isolation.
export class ChatController {
  messages: ChatMessage[] = [];
  loading = false;
  lastCostUsd?: number;
  onUpdate?: () => void;

  // Start a new turn: record the user's prompt and an empty assistant bubble
  // that streamed deltas will fill in. loading=true drives the "思考中" state
  // (the first delta can be ~6s away — TTFT).
  startUserTurn(text: string): void {
    this.messages.push({ role: 'user', text });
    this.messages.push({ role: 'assistant', text: '' });
    this.loading = true;
    this.onUpdate?.();
  }

  // Apply one NDJSON line. Text deltas append to the current assistant bubble;
  // the result line ends the turn. Noise/malformed lines are ignored.
  applyLine(line: string): void {
    const ev = parseStreamLine(line);
    switch (ev.kind) {
      case 'delta': {
        const last = this.messages[this.messages.length - 1];
        if (last && last.role === 'assistant') {
          last.text += ev.text;
          this.onUpdate?.();
        }
        break;
      }
      case 'result':
        this.loading = false;
        this.lastCostUsd = ev.costUsd;
        this.onUpdate?.();
        break;
      case 'ignored':
        break;
    }
  }
}

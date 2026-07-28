// ChatSession：DOM-free 状态机。消费 parser 的 StreamEvent，累积成可渲染的
// Message[]。对标 pi-web 的 useAgentSession + mobile 的 ChatController，但做深：
// tool_use↔tool_result 按 id 配对回填、thinking/text 分块、流式打字机、
// interrupted 标记、cost 累积。视图层订阅 onUpdate 重渲染。
//
// 事实来源策略：完整 assistant 块一到，就用它「落定」当前 turn 的 parts
// （覆盖流式预览拼出的临时文本），保证与 claude 官方内容 1:1。text_delta/
// thinking_delta 仅在完整块到达前提供打字机预览。

import type { ChatState, CostInfo, Message, Part, Phase } from './types';
import { parseStreamLine, type StreamEvent } from './parser';

export class ChatSession {
  private messages: Message[] = [];
  private streaming = false;
  private phase: Phase = 'idle';
  private cost?: CostInfo;
  private model?: string;

  // 当前流式 assistant 消息的引用（打字机预览写入它；完整块到达时被落定内容覆盖）。
  private liveAssistant: Extract<Message, { role: 'assistant' }> | null = null;
  // 是否已收到本 turn 的完整 assistant 块（收到后忽略后续同 turn 的预览 delta）。
  private sealedThisTurn = false;

  onUpdate?: (state: ChatState) => void;

  /** 当前可渲染状态快照。 */
  getState(): ChatState {
    return {
      messages: this.messages,
      streaming: this.streaming,
      phase: this.phase,
      cost: this.cost,
    };
  }

  private emit(): void {
    this.onUpdate?.(this.getState());
  }

  /** 用历史（来自 jsonl-backed REST）批量填充消息，替换整个列表。 */
  setHistory(messages: Message[]): void {
    this.messages = messages;
    this.liveAssistant = null;
    this.emit();
  }

  /** 开始一轮：记录用户 prompt，进入等待模型状态。 */
  startUserTurn(text: string): void {
    this.messages.push({ role: 'user', parts: [{ type: 'text', text }] });
    this.streaming = true;
    this.phase = 'waiting_model';
    this.sealedThisTurn = false;
    this.liveAssistant = null;
    this.emit();
  }

  /** 处理一整块 chunk（可能含多行 NDJSON）。委托给 lines 分割后逐行 apply。 */
  applyLine(line: string): void {
    this.apply(parseStreamLine(line));
  }

  /** 用户主动中断当前 turn（对应服务端 interrupt）。 */
  markInterrupted(): void {
    if (this.liveAssistant) this.liveAssistant.interrupted = true;
    this.endTurn();
  }

  private endTurn(): void {
    this.streaming = false;
    this.phase = 'idle';
    if (this.liveAssistant) this.liveAssistant.streaming = false;
    this.liveAssistant = null;
    this.emit();
  }

  // 确保有一个「活的」流式 assistant 消息可写入预览。
  private ensureLiveAssistant(): Extract<Message, { role: 'assistant' }> {
    if (!this.liveAssistant) {
      const msg: Extract<Message, { role: 'assistant' }> = {
        role: 'assistant',
        parts: [],
        streaming: true,
        model: this.model,
      };
      this.messages.push(msg);
      this.liveAssistant = msg;
    }
    return this.liveAssistant;
  }

  private apply(ev: StreamEvent): void {
    switch (ev.kind) {
      case 'model':
        this.model = ev.model;
        if (this.liveAssistant && !this.liveAssistant.model) this.liveAssistant.model = ev.model;
        break;

      case 'text_delta':
        // 完整块落定后忽略预览 delta（避免重复）。
        if (this.sealedThisTurn) break;
        this.appendPreview('text', ev.text);
        break;

      case 'thinking_delta':
        if (this.sealedThisTurn) break;
        this.appendPreview('thinking', ev.text);
        break;

      case 'assistant_message':
        this.sealAssistant(ev.parts, ev.model);
        break;

      case 'tool_result':
        this.attachToolResult(ev.toolUseId, ev.result);
        break;

      case 'result':
        this.cost = {
          usd: ev.costUsd,
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
          numTurns: ev.numTurns,
        };
        this.endTurn();
        break;

      case 'ignored':
        return; // 不触发 emit
    }
    this.emit();
  }

  // 打字机预览：把增量文本追加到当前 live assistant 的末尾同类型 part。
  private appendPreview(type: 'text' | 'thinking', text: string): void {
    this.phase = 'waiting_model';
    const msg = this.ensureLiveAssistant();
    const last = msg.parts[msg.parts.length - 1];
    if (last && last.type === type) {
      last.text += text;
    } else {
      msg.parts.push(type === 'text' ? { type: 'text', text } : { type: 'thinking', text });
    }
  }

  // 完整 assistant 块到达：用官方内容落定本 turn 的 parts（覆盖预览拼的临时文本）。
  // claude 一个 turn 可能发多条 assistant 块（thinking 一条、tool_use 一条），
  // 因此第一条落定后，后续块追加到已落定内容之后，而不是再覆盖。
  private sealAssistant(parts: Part[], model?: string): void {
    if (!this.sealedThisTurn) {
      // 首个完整块：丢弃预览（可能不完整），改用官方 parts。
      const msg = this.ensureLiveAssistant();
      msg.parts = mergeParts([], parts);
      if (model) msg.model = model;
      this.sealedThisTurn = true;
    } else {
      // 同 turn 后续完整块（如 tool_use 之后模型继续）：追加。
      const msg = this.ensureLiveAssistant();
      msg.parts = mergeParts(msg.parts, parts);
      if (model && !msg.model) msg.model = model;
    }
    // 若本块含 tool_use，进入 running_tool；否则维持 waiting_model。
    this.phase = parts.some((p) => p.type === 'tool_use') ? 'running_tool' : 'waiting_model';
  }

  // tool_result 到达：按 id 找到对应 tool_use part 回填 result。
  // 工具结果属于「上一条 assistant 的 tool_use」，且该 turn 会继续（claude 会再发
  // assistant 块），所以这里不 endTurn；只有 result 事件才结束整轮。
  private attachToolResult(toolUseId: string, result: { content: string; isError: boolean }): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== 'assistant') continue;
      for (const p of m.parts) {
        if (p.type === 'tool_use' && p.id === toolUseId) {
          p.result = result;
          // 工具结果回填后，模型通常继续 → 下一条 assistant 块会开新的 live 消息。
          this.sealedThisTurn = false;
          this.liveAssistant = null;
          return;
        }
      }
    }
  }
}

// 把 incoming parts 合并到 base 之后。若 base 末尾与 incoming 首个都是同类型
// text/thinking，合并文本（避免相邻同类型碎片），否则直接拼接。
function mergeParts(base: Part[], incoming: Part[]): Part[] {
  const out = base.slice();
  for (const p of incoming) {
    const last = out[out.length - 1];
    if (last && (last.type === 'text' || last.type === 'thinking') && last.type === p.type) {
      (last as { text: string }).text += (p as { text: string }).text;
    } else {
      out.push(p);
    }
  }
  return out;
}

# 移动端 UX 增强（借鉴 opencode_ios_client）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 iOS MVP 已合入的 headless 聊天线基础上，参考 opencode_ios_client 的 UI/功能设计，补齐 6 项增强：Markdown 渲染、工具调用可见性、动态 loading、token/成本显示、会话历史加载、自适应输入框+键盘避让，并把散乱 CSS 重构为设计令牌系统。

**Architecture:** 沿用现有「服务端哑管道 + 移动端展示层解析 claude 官方 stream-json」架构。前端增强集中在 `mobile/src/`（`stream.ts` 解析层扩展、`chat.ts` 状态机扩展、`main.ts` 视图层、`styles.css`→设计令牌）。历史加载新增一个服务端 REST 端点读取 `~/.claude/projects/<dir>/*.jsonl`（仍是「读文件搬运」，解析结构在服务端做但只提取对话文本，不涉及 TUI）。

**Tech Stack:** Go（服务端 REST）、TypeScript + Vite + Vitest（移动端）、markdown-it + DOMPurify（渲染）。

## Global Constraints

- **纯字节透传/不解析 TUI 铁律**：解析对象只能是 claude 官方 stream-json（NDJSON 事件）或官方 jsonl 会话文件，绝不解析 TUI/ANSI 像素。
- **桌面端零行为改动**：不改 `desktop/` 下任何运行时行为；共享传输层（`client.ts`/`rest.ts`）如需新增只加可选、缺省省略的成员。
- **协议两端手动对齐**：若动 `protocol.ts`/`protocol.go` 必须两端同改 + 同步 `docs/protocol.md`。
- **安全模型复用**：新 REST 端点必须过 `checkToken`（Bearer）鉴权 + `IsAllowedWorkdir` 白名单；明文 ws/私有网段绑定不变。
- **Go module 前缀**：`github.com/lflish/vibe-remote/vibe-remoted`。
- **XSS 防护**：所有插入 innerHTML 的内容，纯文本走 `escapeHtml`，Markdown 走 markdown-it + DOMPurify 消毒后再插入。
- Go 命令在 `vibe-remoted/` 下跑；移动端命令在 `mobile/` 下跑。
- **DOM-free 可测原则**：解析/状态逻辑（stream.ts/chat.ts）保持无 DOM，单测覆盖；视图层（main.ts）薄。

---

### Task 1: stream.ts 扩展 —— 工具调用 + token 事件解析

**Files:**
- Modify: `mobile/src/stream.ts`
- Test: `mobile/src/stream.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces（扩展 `ChatEvent` 联合，新增两个分支 + result 加 token 字段）:
  ```typescript
  export type ChatEvent =
    | { kind: 'delta'; text: string }
    | { kind: 'tool'; name: string; summary?: string }   // 新增：工具调用开始
    | { kind: 'result'; costUsd?: number; numTurns?: number; inputTokens?: number; outputTokens?: number } // 扩展
    | { kind: 'ignored' };
  ```

- [ ] **Step 1: 追加失败测试（工具调用 + token 提取）**

在 `mobile/src/stream.test.ts` 末尾（现有 7 个测试之后）追加：

```typescript
  it('extracts tool_use from content_block_start', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'Bash', input: {} },
      },
    });
    expect(parseStreamLine(line)).toEqual({ kind: 'tool', name: 'Bash', summary: undefined });
  });

  it('extracts tool_use with input summary (Bash command)', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'Bash', input: { command: 'git status' } },
      },
    });
    expect(parseStreamLine(line)).toEqual({ kind: 'tool', name: 'Bash', summary: 'git status' });
  });

  it('extracts tool_use with file_path summary (Read)', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } },
      },
    });
    expect(parseStreamLine(line)).toEqual({ kind: 'tool', name: 'Read', summary: '/a/b.ts' });
  });

  it('extracts input/output tokens from result', () => {
    const line = JSON.stringify({
      type: 'result', subtype: 'success', total_cost_usd: 0.12, num_turns: 1,
      usage: { input_tokens: 100, output_tokens: 42 },
    });
    expect(parseStreamLine(line)).toEqual({
      kind: 'result', costUsd: 0.12, numTurns: 1, inputTokens: 100, outputTokens: 42,
    });
  });

  it('ignores text content_block_start (only tool_use surfaces)', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'text', text: '' } },
    });
    expect(parseStreamLine(line)).toEqual({ kind: 'ignored' });
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd mobile && npm test -- stream`
Expected: 新增 5 例 FAIL（旧 7 例仍 PASS）——`tool` 分支未实现、result 无 token 字段。

- [ ] **Step 3: 实现 stream.ts 扩展**

把 `mobile/src/stream.ts` 整体替换为：

```typescript
// Parse one NDJSON line from `claude -p --output-format stream-json`.
// The stream mixes hook/system events with the actual model output; we filter
// by top-level `type` and surface text deltas, tool-call starts, and the final
// result. We parse claude's OFFICIAL structured protocol here (not TUI pixels),
// so this respects the "no parsing of TUI output" rule — parsing is display-only.

export type ChatEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'tool'; name: string; summary?: string }
  | { kind: 'result'; costUsd?: number; numTurns?: number; inputTokens?: number; outputTokens?: number }
  | { kind: 'ignored' };

// Pull a short human-readable summary from a tool_use input, best-effort.
// Common claude tools carry their most salient arg under one of these keys.
function toolSummary(input: any): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const candidates = ['command', 'file_path', 'path', 'pattern', 'url', 'description'];
  for (const k of candidates) {
    if (typeof input[k] === 'string' && input[k]) return input[k];
  }
  return undefined;
}

export function parseStreamLine(line: string): ChatEvent {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'ignored' };

  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // Malformed line — skip it, never crash the stream (dumb-pipe tolerance).
    return { kind: 'ignored' };
  }

  switch (obj?.type) {
    case 'stream_event': {
      const ev = obj.event;
      if (
        ev?.type === 'content_block_delta' &&
        ev.delta?.type === 'text_delta' &&
        typeof ev.delta.text === 'string'
      ) {
        return { kind: 'delta', text: ev.delta.text };
      }
      if (
        ev?.type === 'content_block_start' &&
        ev.content_block?.type === 'tool_use' &&
        typeof ev.content_block.name === 'string'
      ) {
        return { kind: 'tool', name: ev.content_block.name, summary: toolSummary(ev.content_block.input) };
      }
      return { kind: 'ignored' };
    }
    case 'result':
      return {
        kind: 'result',
        costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
        numTurns: typeof obj.num_turns === 'number' ? obj.num_turns : undefined,
        inputTokens: typeof obj.usage?.input_tokens === 'number' ? obj.usage.input_tokens : undefined,
        outputTokens: typeof obj.usage?.output_tokens === 'number' ? obj.usage.output_tokens : undefined,
      };
    default:
      // 'system', 'assistant', hook events, etc. — noise for the chat view.
      return { kind: 'ignored' };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd mobile && npm test -- stream`
Expected: 12 例全 PASS。

- [ ] **Step 5: Commit**

```bash
cd /Users/mac/github/vibe-remote
git add mobile/src/stream.ts mobile/src/stream.test.ts
git commit -m "feat(mobile): stream 解析扩展 tool_use + token 提取"
```

---

### Task 2: chat.ts 扩展 —— 工具调用消息 + 动态活动 + token 状态

**Files:**
- Modify: `mobile/src/chat.ts`
- Test: `mobile/src/chat.test.ts`

**Interfaces:**
- Consumes: `parseStreamLine`, `ChatEvent`（Task 1）。
- Produces（扩展 `ChatMessage` 支持 tool 角色 + Controller 加 activity/token 字段）:
  ```typescript
  export interface ChatMessage { role: 'user' | 'assistant' | 'tool'; text: string }
  // ChatController 新增: activity?: string（当前工具活动文案）; lastInputTokens?/lastOutputTokens?: number
  ```

- [ ] **Step 1: 追加失败测试**

在 `mobile/src/chat.test.ts` 末尾追加（保留现有测试）：

```typescript
function toolLine(name: string, summary?: string): string {
  const input = summary ? { command: summary } : {};
  return JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_start', content_block: { type: 'tool_use', name, input } },
  });
}
function resultLineFull(cost: number, inTok: number, outTok: number): string {
  return JSON.stringify({ type: 'result', total_cost_usd: cost, num_turns: 1, usage: { input_tokens: inTok, output_tokens: outTok } });
}

describe('ChatController tool + tokens', () => {
  it('tool event pushes a tool message and sets activity', () => {
    const c = new ChatController();
    c.startUserTurn('do it');
    c.applyLine(toolLine('Bash', 'git status'));
    const toolMsg = c.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toEqual({ role: 'tool', text: 'Bash · git status' });
    expect(c.activity).toBe('Bash · git status');
    expect(c.loading).toBe(true);
  });

  it('tool event without summary uses name only', () => {
    const c = new ChatController();
    c.startUserTurn('x');
    c.applyLine(toolLine('Glob'));
    expect(c.messages.find((m) => m.role === 'tool')).toEqual({ role: 'tool', text: 'Glob' });
    expect(c.activity).toBe('Glob');
  });

  it('result records tokens and clears activity', () => {
    const c = new ChatController();
    c.startUserTurn('x');
    c.applyLine(toolLine('Bash', 'ls'));
    c.applyLine(resultLineFull(0.05, 100, 42));
    expect(c.loading).toBe(false);
    expect(c.lastCostUsd).toBe(0.05);
    expect(c.lastInputTokens).toBe(100);
    expect(c.lastOutputTokens).toBe(42);
    expect(c.activity).toBeUndefined();
  });

  it('delta after a tool message starts a fresh assistant bubble', () => {
    const c = new ChatController();
    c.startUserTurn('x');
    c.applyLine(toolLine('Read', '/a.ts'));
    c.applyLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '结果' } } }));
    const last = c.messages[c.messages.length - 1];
    expect(last).toEqual({ role: 'assistant', text: '结果' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd mobile && npm test -- chat`
Expected: 新增 4 例 FAIL（旧例仍 PASS）。

- [ ] **Step 3: 实现 chat.ts 扩展**

把 `mobile/src/chat.ts` 整体替换为：

```typescript
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
```

注意：现有 `chat.test.ts` 里「delta 累积进最后一条 assistant」的旧测试仍成立（startUserTurn 后最后一条就是 assistant 占位，delta 落进去）；「delta after tool starts fresh bubble」由新逻辑覆盖。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd mobile && npm test -- chat`
Expected: 全部 PASS（旧 5 例 + 新 4 例）。

- [ ] **Step 5: Commit**

```bash
cd /Users/mac/github/vibe-remote
git add mobile/src/chat.ts mobile/src/chat.test.ts
git commit -m "feat(mobile): ChatController 支持工具卡片/动态活动/token 状态"
```

---

### Task 3: 服务端 REST —— 会话历史端点（读 jsonl）

**Files:**
- Create: `vibe-remoted/internal/session/history.go`
- Test: `vibe-remoted/internal/session/history_test.go`
- Modify: `vibe-remoted/internal/server/server.go`（注册路由 + handler）
- Test: `vibe-remoted/internal/server/history_test.go`

**Interfaces:**
- Consumes: `config.IsAllowedWorkdir`（现有）。
- Produces:
  ```go
  // session/history.go
  type HistoryTurn struct {
      Role string `json:"role"` // "user" | "assistant"
      Text string `json:"text"`
  }
  // ReadHistory reads the most recent claude session jsonl for workdir and
  // returns the last `limit` conversation turns (user prompts + assistant text),
  // oldest-first. Returns empty slice (not error) when no session exists.
  func ReadHistory(workdir string, limit int) ([]HistoryTurn, error)
  ```
- REST: `GET /api/v1/history?path=<workdir>&limit=<n>` → `{"turns":[{role,text},...]}`（Bearer 鉴权 + workdir 白名单）。

- [ ] **Step 1: 写失败测试（jsonl 解析）**

创建 `vibe-remoted/internal/session/history_test.go`：

```go
package session

import (
	"os"
	"path/filepath"
	"testing"
)

// writeFakeProject writes a jsonl file into a temp fake ~/.claude/projects dir
// and returns (homeDir, workdir) so ReadHistory can be pointed at it.
func writeFakeProject(t *testing.T, workdir string, lines []string) string {
	t.Helper()
	home := t.TempDir()
	// claude encodes the workdir path as the project dir name: / and . → -
	enc := encodeProjectDir(workdir)
	projDir := filepath.Join(home, ".claude", "projects", enc)
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}
	content := ""
	for _, l := range lines {
		content += l + "\n"
	}
	if err := os.WriteFile(filepath.Join(projDir, "sess.jsonl"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return home
}

func TestReadHistoryExtractsTurns(t *testing.T) {
	workdir := "/Users/x/proj"
	lines := []string{
		`{"type":"mode","mode":"normal"}`,
		`{"type":"user","message":{"role":"user","content":"你好"}}`,
		`{"type":"assistant","message":{"content":[{"type":"thinking","text":"..."},{"type":"text","text":"你好，有什么可以帮忙"}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ok"}]}}`,
		`{"type":"attachment","attachment":{}}`,
		`{"type":"user","message":{"role":"user","content":"第二问"}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"回答二"}]}}`,
	}
	home := writeFakeProject(t, workdir, lines)
	t.Setenv("HOME", home)

	turns, err := ReadHistory(workdir, 100)
	if err != nil {
		t.Fatalf("ReadHistory: %v", err)
	}
	// tool_result user line and non-conversation lines are dropped.
	want := []HistoryTurn{
		{Role: "user", Text: "你好"},
		{Role: "assistant", Text: "你好，有什么可以帮忙"},
		{Role: "user", Text: "第二问"},
		{Role: "assistant", Text: "回答二"},
	}
	if len(turns) != len(want) {
		t.Fatalf("got %d turns, want %d: %+v", len(turns), len(want), turns)
	}
	for i := range want {
		if turns[i] != want[i] {
			t.Fatalf("turn %d = %+v, want %+v", i, turns[i], want[i])
		}
	}
}

func TestReadHistoryLimit(t *testing.T) {
	workdir := "/Users/x/proj"
	lines := []string{
		`{"type":"user","message":{"role":"user","content":"a"}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"A"}]}}`,
		`{"type":"user","message":{"role":"user","content":"b"}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"B"}]}}`,
	}
	home := writeFakeProject(t, workdir, lines)
	t.Setenv("HOME", home)

	turns, err := ReadHistory(workdir, 2)
	if err != nil {
		t.Fatal(err)
	}
	// last 2 turns only, oldest-first
	if len(turns) != 2 || turns[0].Text != "b" || turns[1].Text != "B" {
		t.Fatalf("limit not applied: %+v", turns)
	}
}

func TestReadHistoryNoSession(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	turns, err := ReadHistory("/no/such/dir", 100)
	if err != nil {
		t.Fatalf("expected nil error for missing session, got %v", err)
	}
	if len(turns) != 0 {
		t.Fatalf("expected empty, got %+v", turns)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd vibe-remoted && go test ./internal/session/ -run TestReadHistory`
Expected: 编译失败 `undefined: ReadHistory` / `encodeProjectDir` / `HistoryTurn`。

- [ ] **Step 3: 实现 history.go**

创建 `vibe-remoted/internal/session/history.go`：

```go
package session

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// HistoryTurn is one conversation turn extracted from a claude session jsonl.
type HistoryTurn struct {
	Role string `json:"role"` // "user" | "assistant"
	Text string `json:"text"`
}

// encodeProjectDir mirrors claude's project-dir naming: the absolute workdir
// path with every '/' and '.' replaced by '-'. e.g. /Users/x/proj →
// -Users-x-proj. This is how ~/.claude/projects/<dir>/ is named.
func encodeProjectDir(workdir string) string {
	r := strings.NewReplacer("/", "-", ".", "-")
	return r.Replace(workdir)
}

// jsonlLine is the minimal shape we read from each jsonl line. content is
// json.RawMessage because a user line's content is either a plain string (real
// prompt) or an array of parts (tool_result — skipped).
type jsonlLine struct {
	Type    string `json:"type"`
	Message struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

// contentPart is one element of an assistant message's content array.
type contentPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// ReadHistory reads the most recently modified jsonl in the workdir's claude
// project dir and returns the last `limit` conversation turns (user prompts +
// assistant text), oldest-first. Missing project/session → empty slice, nil err
// (a not-yet-started session is not an error). We parse claude's own official
// jsonl records, not TUI output — extraction is limited to conversation text.
func ReadHistory(workdir string, limit int) ([]HistoryTurn, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	projDir := filepath.Join(home, ".claude", "projects", encodeProjectDir(workdir))
	entries, err := os.ReadDir(projDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []HistoryTurn{}, nil
		}
		return nil, err
	}

	// Pick the most recently modified .jsonl (the active session).
	type jf struct {
		path string
		mod  int64
	}
	var files []jf
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, jf{filepath.Join(projDir, e.Name()), info.ModTime().UnixNano()})
	}
	if len(files) == 0 {
		return []HistoryTurn{}, nil
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod > files[j].mod })

	f, err := os.Open(files[0].path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var turns []HistoryTurn
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		var ln jsonlLine
		if err := json.Unmarshal(scanner.Bytes(), &ln); err != nil {
			continue // skip malformed / non-object lines
		}
		switch ln.Type {
		case "user":
			// content is a plain string only for real user prompts; an array
			// means tool_result feedback, which we skip.
			var s string
			if err := json.Unmarshal(ln.Message.Content, &s); err == nil && s != "" {
				turns = append(turns, HistoryTurn{Role: "user", Text: s})
			}
		case "assistant":
			var parts []contentPart
			if err := json.Unmarshal(ln.Message.Content, &parts); err != nil {
				continue
			}
			var b strings.Builder
			for _, p := range parts {
				if p.Type == "text" && p.Text != "" {
					b.WriteString(p.Text)
				}
			}
			if b.Len() > 0 {
				turns = append(turns, HistoryTurn{Role: "assistant", Text: b.String()})
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	if limit > 0 && len(turns) > limit {
		turns = turns[len(turns)-limit:]
	}
	return turns, nil
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd vibe-remoted && go test ./internal/session/ -run TestReadHistory -v`
Expected: 3 例全 PASS。

- [ ] **Step 5: 写服务端 handler 失败测试**

创建 `vibe-remoted/internal/server/history_test.go`：

```go
package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/config"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/session"
)

func TestHandleHistory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	workdir := filepath.Join(home, "proj")
	os.MkdirAll(workdir, 0o755)

	// seed a jsonl in the encoded project dir
	enc := home + "/.claude/projects/" + encodeForTest(workdir)
	os.MkdirAll(enc, 0o755)
	os.WriteFile(filepath.Join(enc, "s.jsonl"), []byte(
		`{"type":"user","message":{"role":"user","content":"hi"}}`+"\n"+
			`{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}`+"\n"), 0o644)

	cfg := &config.Config{
		BindAddr: "127.0.0.1", Port: 0, Token: "tok",
		DefaultWorkdir: workdir, AllowedRoots: []string{home},
		UseTmux: false, ClaudeCmd: "true",
	}
	mgr := session.NewManager(false, "true", false, "/bin/sh")
	srv := New(cfg, mgr)
	ts := httptest.NewServer(withCORS(srv.mux))
	defer ts.Close()

	// authorized request
	req, _ := http.NewRequest("GET", ts.URL+"/api/v1/history?path="+workdir+"&limit=10", nil)
	req.Header.Set("Authorization", "Bearer tok")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("status = %d", res.StatusCode)
	}
	var body struct {
		Turns []session.HistoryTurn `json:"turns"`
	}
	json.NewDecoder(res.Body).Decode(&body)
	res.Body.Close()
	if len(body.Turns) != 2 || body.Turns[0].Text != "hi" || body.Turns[1].Text != "hello" {
		t.Fatalf("turns = %+v", body.Turns)
	}

	// disallowed workdir → 403
	req2, _ := http.NewRequest("GET", ts.URL+"/api/v1/history?path=/etc&limit=10", nil)
	req2.Header.Set("Authorization", "Bearer tok")
	res2, _ := http.DefaultClient.Do(req2)
	if res2.StatusCode != http.StatusForbidden {
		t.Fatalf("disallowed workdir status = %d, want 403", res2.StatusCode)
	}
	res2.Body.Close()

	// missing token → 401
	req3, _ := http.NewRequest("GET", ts.URL+"/api/v1/history?path="+workdir, nil)
	res3, _ := http.DefaultClient.Do(req3)
	if res3.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no-token status = %d, want 401", res3.StatusCode)
	}
	res3.Body.Close()
}

// encodeForTest mirrors session.encodeProjectDir (unexported); duplicated here
// only to seed the fixture path.
func encodeForTest(workdir string) string {
	out := make([]rune, 0, len(workdir))
	for _, r := range workdir {
		if r == '/' || r == '.' {
			out = append(out, '-')
		} else {
			out = append(out, r)
		}
	}
	return string(out)
}
```

- [ ] **Step 6: 运行测试确认失败**

Run: `cd vibe-remoted && go test ./internal/server/ -run TestHandleHistory`
Expected: 404（路由未注册）→ 测试失败。

- [ ] **Step 7: 注册路由 + 实现 handler**

在 `vibe-remoted/internal/server/server.go` 的 `routes()`（第 45 行 `handleFS` 之后）加一行：

```go
	s.mux.HandleFunc("GET /api/v1/history", s.handleHistory)
```

在 `server.go` 的 `handleFS` 函数之后追加 handler：

```go
// handleHistory returns recent conversation turns for a workdir's claude
// session, read from the shared jsonl. Same Bearer auth + workdir whitelist as
// every other endpoint. Powers the mobile chat's "show prior context on open".
func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	if !s.checkToken(r, w) {
		return
	}
	workdir := r.URL.Query().Get("path")
	if workdir == "" {
		workdir = s.cfg.DefaultWorkdir
	}
	if !s.cfg.IsAllowedWorkdir(workdir) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "path not in allowed roots"})
		return
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	turns, err := session.ReadHistory(workdir, limit)
	if err != nil {
		writeJSON(w, http.StatusInternalError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"turns": turns})
}
```

在 `server.go` import 块补 `"strconv"`（若未存在）。注意 `http.StatusInternalError` 不存在，用 `http.StatusInternalServerError`。

- [ ] **Step 8: 运行测试确认通过 + 全量回归**

Run: `cd vibe-remoted && go test ./... && go vet ./...`
Expected: 全 PASS，vet 干净。

- [ ] **Step 9: Commit**

```bash
cd /Users/mac/github/vibe-remote
git add vibe-remoted/internal/session/history.go vibe-remoted/internal/session/history_test.go vibe-remoted/internal/server/server.go vibe-remoted/internal/server/history_test.go
git commit -m "feat(server): /api/v1/history 端点读 jsonl 返回对话历史"
```

---

### Task 4: rest.ts 加 history 方法 + 协议历史类型

**Files:**
- Modify: `desktop/src/renderer/rest.ts`
- Modify: `docs/protocol.md`

**Interfaces:**
- Consumes: 无。
- Produces（rest.ts 新增方法，桌面不调用故零影响）:
  ```typescript
  export interface HistoryTurn { role: 'user' | 'assistant'; text: string }
  // VibeRemoteRest.history(workdir: string, limit?: number): Promise<HistoryTurn[]>
  ```

- [ ] **Step 1: 加 history 方法与类型**

在 `desktop/src/renderer/rest.ts` 的 `VibeRemoteRest` 类内（`listDir` 方法之后）追加：

```typescript
  /** Fetch recent conversation turns for a workdir (mobile chat history). */
  async history(workdir: string, limit = 50): Promise<HistoryTurn[]> {
    const url = new URL(`${this.base()}/api/v1/history`);
    url.searchParams.set('path', workdir);
    url.searchParams.set('limit', String(limit));
    const res = await fetch(url.toString(), { headers: this.headers() });
    if (!res.ok) throw new Error(`history failed: ${res.status}`);
    const data = await res.json();
    return data.turns || [];
  }
```

在 `rest.ts` 文件末尾（其它 interface 旁）追加类型：

```typescript
export interface HistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}
```

- [ ] **Step 2: 两端 typecheck（桌面零回归）**

Run: `cd desktop && npm run typecheck && cd ../mobile && npm run typecheck`
Expected: 均无错误（新增方法/类型可选，桌面未调用）。

- [ ] **Step 3: 更新协议文档**

在 `docs/protocol.md` 的 REST 端点小节追加：

```markdown
### GET /api/v1/history（会话历史，headless 聊天线）

`GET /api/v1/history?path=<workdir>&limit=<n>`（Bearer 鉴权 + workdir 白名单）。
读取该 workdir 对应 claude 会话 jsonl（`~/.claude/projects/<编码目录>/*.jsonl`，取最近修改的一个），
返回最近 `limit`（默认 50）轮对话，oldest-first：
`{"turns":[{"role":"user"|"assistant","text":"..."}]}`。
仅提取 user 纯文本 prompt 与 assistant 的 text 片段（tool_result / thinking / 附件等跳过）。
无会话时返回 `{"turns":[]}`。
```

- [ ] **Step 4: Commit**

```bash
cd /Users/mac/github/vibe-remote
git add desktop/src/renderer/rest.ts docs/protocol.md
git commit -m "feat(mobile): rest.ts 加 history() + 协议文档"
```

---

### Task 5: 设计令牌 CSS 重构 + Markdown 渲染依赖

**Files:**
- Modify: `mobile/src/styles.css`
- Modify: `mobile/package.json`（加 markdown-it + dompurify 依赖）

**Interfaces:**
- Consumes: 无。
- Produces: CSS 自定义属性令牌（供 Task 6 视图用）+ `.bubble.tool` / `.md` 样式类。markdown-it/dompurify 依赖就绪（Task 6 import）。

- [ ] **Step 1: 加依赖**

在 `mobile/package.json` 的 `dependencies` 加两项：

```json
    "markdown-it": "^14.0.0",
    "dompurify": "^3.1.0"
```

在 `devDependencies` 加类型：

```json
    "@types/markdown-it": "^14.0.0"
```

Run: `cd mobile && npm install`
Expected: 安装成功，`package-lock.json` 更新。

- [ ] **Step 2: 重构 styles.css 为设计令牌**

把 `mobile/src/styles.css` 整体替换为：

```css
:root {
  /* Colors (Catppuccin-ish dark, matching desktop) */
  --color-bg: #1e1e2e;
  --color-surface: #313244;
  --color-surface-alt: #45475a;
  --color-border: #333;
  --color-border-subtle: #2a2a3a;
  --color-text: #e6e6e6;
  --color-text-dim: #888;
  --color-accent: #89b4fa;
  --color-tool: #f9e2af; /* tool card accent (yellow) */
  /* Typography */
  --text-lg: 16px;
  --text-md: 14px;
  --text-sm: 13px;
  --text-xs: 11px;
  /* Spacing / shape */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --radius: 12px;
  --radius-sm: 8px;
  /* Keyboard avoidance (set by main.ts via visualViewport) */
  --keyboard-height: 0px;
}

* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
body { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: var(--color-bg); color: var(--color-text); }
#app { display: flex; flex-direction: column; height: 100vh; height: 100dvh; }

.header { padding-top: max(env(safe-area-inset-top), var(--space-3)); padding-left: var(--space-3); padding-right: var(--space-3); padding-bottom: var(--space-2); font-weight: 600; border-bottom: 1px solid var(--color-border); display: flex; align-items: center; gap: var(--space-2); }
.back { background: none; border: none; color: var(--color-accent); font-size: var(--text-lg); }

.list { flex: 1; overflow-y: auto; }
.list-item { padding: 14px var(--space-4); border-bottom: 1px solid var(--color-border-subtle); }
.list-item .title { font-weight: 600; }
.list-item .sub { font-size: var(--text-sm); color: var(--color-text-dim); margin-top: 2px; }

.chat { flex: 1; overflow-y: auto; padding: var(--space-3); }
.bubble { max-width: 85%; padding: var(--space-2) var(--space-3); border-radius: var(--radius); margin: 6px 0; word-break: break-word; }
.bubble.user { background: var(--color-surface-alt); margin-left: auto; white-space: pre-wrap; }
.bubble.assistant { background: var(--color-surface); }
.bubble.tool { background: transparent; border: 1px solid var(--color-tool); color: var(--color-tool); font-size: var(--text-sm); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; max-width: 100%; opacity: 0.85; }

/* Markdown-rendered assistant content */
.md { line-height: 1.5; }
.md p { margin: 0.4em 0; }
.md pre { background: var(--color-bg); border-radius: var(--radius-sm); padding: var(--space-2); overflow-x: auto; font-size: var(--text-sm); }
.md code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
.md :not(pre) > code { background: var(--color-bg); padding: 1px 4px; border-radius: 4px; }
.md ul, .md ol { padding-left: 1.3em; margin: 0.4em 0; }
.md h1, .md h2, .md h3 { margin: 0.5em 0 0.3em; font-size: var(--text-lg); }

.loading { font-style: italic; color: var(--color-text-dim); padding: var(--space-1) var(--space-3); font-size: var(--text-sm); }

.composer { display: flex; gap: var(--space-2); padding: var(--space-2); padding-bottom: max(env(safe-area-inset-bottom), var(--space-2)); border-top: 1px solid var(--color-border); margin-bottom: var(--keyboard-height); }
.composer textarea { flex: 1; resize: none; background: var(--color-surface); color: var(--color-text); border: 1px solid #444; border-radius: var(--radius-sm); padding: var(--space-2); font-size: var(--text-lg); max-height: 120px; overflow-y: auto; line-height: 1.4; }
.composer button { background: var(--color-accent); color: var(--color-bg); border: none; border-radius: var(--radius-sm); padding: 0 var(--space-4); font-weight: 600; }

.cost { font-size: var(--text-xs); color: var(--color-text-dim); text-align: center; padding: var(--space-1); }
```

- [ ] **Step 3: typecheck + 构建确认依赖 OK**

Run: `cd mobile && npm run typecheck && npm run build`
Expected: typecheck 无错误；build 成功（markdown-it/dompurify 可被 vite 解析）。

- [ ] **Step 4: Commit**

```bash
cd /Users/mac/github/vibe-remote
git add mobile/package.json mobile/package-lock.json mobile/src/styles.css
git commit -m "feat(mobile): CSS 设计令牌重构 + markdown-it/dompurify 依赖"
```

---

### Task 6: main.ts 视图集成 —— Markdown/工具卡片/动态loading/token/历史/输入框

**Files:**
- Modify: `mobile/src/main.ts`
- Create: `mobile/src/render.ts`（markdown 渲染 + 消毒，抽出可测）
- Test: `mobile/src/render.test.ts`

**Interfaces:**
- Consumes: `ChatController`/`ChatMessage`（Task 2）、`VibeRemoteRest.history`/`HistoryTurn`（Task 4）、设计令牌 CSS（Task 5）、`markdown-it`/`dompurify`（Task 5）。
- Produces:
  ```typescript
  // render.ts
  export function renderMarkdown(text: string): string; // md → sanitized HTML
  ```

- [ ] **Step 1: 写 render.ts 失败测试**

创建 `mobile/src/render.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './render';

describe('renderMarkdown', () => {
  it('renders basic markdown to html', () => {
    const html = renderMarkdown('**bold** and `code`');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
  });

  it('renders fenced code blocks', () => {
    const html = renderMarkdown('```\nconst x = 1;\n```');
    expect(html).toContain('<pre>');
    expect(html).toContain('const x = 1;');
  });

  it('sanitizes script tags (XSS defense)', () => {
    const html = renderMarkdown('hi <script>alert(1)</script>');
    expect(html).not.toContain('<script>');
  });

  it('sanitizes javascript: hrefs and onerror handlers', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('onerror');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd mobile && npm test -- render`
Expected: FAIL — `Cannot find module './render'`。

- [ ] **Step 3: 实现 render.ts**

创建 `mobile/src/render.ts`：

```typescript
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

// Assistant text is claude's official output (markdown); we render it to HTML
// for readable code blocks / lists, then sanitize with DOMPurify before it ever
// touches innerHTML. This is display-layer formatting of official model output,
// not TUI parsing. User/tool text does NOT go through here (escapeHtml instead).
const md = new MarkdownIt({
  html: false, // do not pass raw HTML in the source through
  linkify: true,
  breaks: true,
});

export function renderMarkdown(text: string): string {
  const raw = md.render(text);
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd mobile && npm test -- render`
Expected: 4 例 PASS。

- [ ] **Step 5: 重写 main.ts 集成所有增强**

把 `mobile/src/main.ts` 整体替换为（分两块写，先写前半）：

```typescript
import './styles.css';
import { VibeRemoteClient } from '@net/client';
import { VibeRemoteRest } from '@net/rest';
import { ChatController, type ChatMessage } from './chat';
import { makeLineSplitter } from './lines';
import { makeMachineStore, defaultKV } from './storage';
import { renderMarkdown } from './render';
import type { MachineConfig, SessionInfo } from '@shared/protocol';

const app = document.getElementById('app')!;
const store = makeMachineStore(defaultKV());

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function base64ToText(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}

// Render one chat message. assistant → markdown (sanitized); user/tool → escaped.
function renderMessage(msg: ChatMessage): string {
  if (msg.role === 'assistant') {
    return `<div class="bubble assistant"><div class="md">${renderMarkdown(msg.text)}</div></div>`;
  }
  if (msg.role === 'tool') {
    return `<div class="bubble tool">🔧 ${escapeHtml(msg.text)}</div>`;
  }
  return `<div class="bubble user">${escapeHtml(msg.text)}</div>`;
}

async function renderMachineList() {
  const machines = await store.getMachines();
  app.innerHTML = `<div class="header">vibe-remote</div><div class="list" id="list"></div>`;
  const list = document.getElementById('list')!;
  if (machines.length === 0) {
    list.innerHTML = `<div class="list-item"><div class="sub">machines.json 为空。请在设备上预置机器清单（name/addr/port/token）。</div></div>`;
    return;
  }
  for (const m of machines) {
    const rest = new VibeRemoteRest(m);
    let sessions: SessionInfo[] = [];
    try {
      sessions = await rest.listSessions();
    } catch {
      // machine unreachable — show it but empty
    }
    const header = document.createElement('div');
    header.className = 'list-item';
    header.innerHTML = `<div class="title">${escapeHtml(m.name)}</div><div class="sub">${escapeHtml(m.addr)}:${m.port} · ${sessions.length} sessions</div>`;
    list.appendChild(header);
    for (const s of sessions) {
      const item = document.createElement('div');
      item.className = 'list-item';
      item.innerHTML = `<div class="title">${escapeHtml(s.title)}</div><div class="sub">${escapeHtml(s.workdir)}</div>`;
      item.onclick = () => openChat(m, s);
      list.appendChild(item);
    }
  }
}

// PLACEHOLDER_OPENCHAT
```

- [ ] **Step 6: 写入 main.ts 后半（openChat + 增强）**

把 `main.ts` 里的 `// PLACEHOLDER_OPENCHAT` 一行替换为：

```typescript
function openChat(machine: MachineConfig, session: SessionInfo) {
  const controller = new ChatController();
  app.innerHTML = `
    <div class="header"><button class="back" id="back">‹ 返回</button><span>${escapeHtml(session.title)}</span></div>
    <div class="chat" id="chat"></div>
    <div class="cost" id="cost"></div>
    <div class="composer">
      <textarea id="input" rows="1" placeholder="发消息…"></textarea>
      <button id="send">发送</button>
    </div>`;
  const chat = document.getElementById('chat')!;
  const cost = document.getElementById('cost')!;
  const input = document.getElementById('input') as HTMLTextAreaElement;

  controller.onUpdate = () => {
    const loadingText = controller.activity ? `${controller.activity}…` : '思考中…';
    chat.innerHTML =
      controller.messages.map(renderMessage).join('') +
      (controller.loading ? `<div class="loading">${escapeHtml(loadingText)}</div>` : '');
    const parts: string[] = [];
    if (controller.lastCostUsd != null) parts.push(`$${controller.lastCostUsd.toFixed(4)}`);
    if (controller.lastInputTokens != null && controller.lastOutputTokens != null) {
      parts.push(`${controller.lastInputTokens}→${controller.lastOutputTokens} tok`);
    }
    cost.textContent = parts.join(' · ');
    chat.scrollTop = chat.scrollHeight;
  };

  // Load prior history so opening a session shows what happened before.
  const rest = new VibeRemoteRest(machine);
  rest.history(session.workdir, 50)
    .then((turns) => {
      if (controller.messages.length === 0) {
        controller.setHistory(turns.map((t) => ({ role: t.role, text: t.text }) as ChatMessage));
      }
    })
    .catch(() => { /* history is best-effort; empty chat is fine */ });

  const client = new VibeRemoteClient(machine);
  const feed = makeLineSplitter((line) => controller.applyLine(line));
  client.onData = (payload) => feed(base64ToText(payload));
  client.onError = () => controller.applyLine(JSON.stringify({ type: 'result' }));
  client.connect();
  client.attach('', 80, 24, session.workdir, undefined, 'headless');

  // Auto-grow textarea (32→120px) as the user types.
  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  };
  input.addEventListener('input', autoGrow);

  const send = () => {
    const text = input.value.trim();
    if (!text || controller.loading) return; // don't send while a turn streams
    controller.startUserTurn(text);
    client.sendData(bytesToBase64(new TextEncoder().encode(text)));
    input.value = '';
    autoGrow();
  };
  document.getElementById('send')!.onclick = send;

  document.getElementById('back')!.onclick = () => {
    client.disconnect();
    detachKeyboardAvoidance();
    renderMachineList();
  };

  attachKeyboardAvoidance();
}

// Keyboard avoidance: when the soft keyboard shows, visualViewport shrinks;
// push the composer up by the covered height via the --keyboard-height token.
let vvHandler: (() => void) | null = null;
function attachKeyboardAvoidance() {
  const vv = window.visualViewport;
  if (!vv) return;
  vvHandler = () => {
    const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--keyboard-height', covered + 'px');
  };
  vv.addEventListener('resize', vvHandler);
  vv.addEventListener('scroll', vvHandler);
  vvHandler();
}
function detachKeyboardAvoidance() {
  const vv = window.visualViewport;
  if (vv && vvHandler) {
    vv.removeEventListener('resize', vvHandler);
    vv.removeEventListener('scroll', vvHandler);
  }
  vvHandler = null;
  document.documentElement.style.setProperty('--keyboard-height', '0px');
}

renderMachineList();
```

- [ ] **Step 7: 两端 typecheck + 全量测试 + 构建**

Run: `cd desktop && npm run typecheck && cd ../mobile && npm run typecheck && npm test && npm run build`
Expected: 桌面 typecheck 干净；mobile typecheck 干净；全部测试 PASS；build 成功。

- [ ] **Step 8: 手动冒烟（留待验收环境）**

前置：真实 vibe-remoted + 一个有历史的 workdir。Run: `cd mobile && npm run dev`，浏览器预置机器后：
1. 点会话 → **立即看到历史对话**（不再空白）。
2. 发一句含代码请求 → 回复气泡里**代码块有背景/等宽字体**（markdown 渲染）。
3. claude 调工具时 → 出现**黄色工具卡片**「🔧 Bash · ...」+ loading 显示「Bash · ...…」而非静态「思考中」。
4. 成本行显示 `$0.xxxx · 100→42 tok`。
5. 输入多行 → textarea **自动长高**；聚焦时**键盘不遮挡**输入框。

subagent 无法执行此步，标注留待最终验收即可。

- [ ] **Step 9: Commit**

```bash
cd /Users/mac/github/vibe-remote
git add mobile/src/main.ts mobile/src/render.ts mobile/src/render.test.ts
git commit -m "feat(mobile): 集成 markdown/工具卡片/动态loading/token/历史/自适应输入"
```

---

## Self-Review

**1. Spec 覆盖检查（6 项增强）：**

| 增强项 | 对应任务 |
|---|---|
| ① Markdown 渲染气泡 | Task 5（依赖+CSS）、Task 6（render.ts + renderMessage） |
| ② 工具调用可见性 | Task 1（解析 tool_use）、Task 2（tool 消息）、Task 6（黄色卡片渲染） |
| ③ 动态 loading 文案 | Task 2（activity 字段）、Task 6（loadingText） |
| ④ token/成本显示 | Task 1（result 提 token）、Task 2（lastInput/OutputTokens）、Task 6（cost 行） |
| ⑤ 会话历史加载 | Task 3（服务端 ReadHistory + 端点）、Task 4（rest.history）、Task 2（setHistory）、Task 6（openChat 拉历史） |
| ⑥ 自适应输入框+键盘避让 | Task 5（CSS max-height + --keyboard-height）、Task 6（autoGrow + visualViewport） |
| 附加：CSS 设计令牌 | Task 5 |

**2. 占位符扫描：** 无 TBD/TODO。Task 6 用 `// PLACEHOLDER_OPENCHAT` 是分块写入的显式锚点（Step 6 会替换掉），非未完成占位——符合「写文件超 50 行分块」的操作要求。每个代码步骤含完整代码，每个测试步骤含完整断言。

**3. 类型一致性核对：**
- `ChatEvent` 新增 `tool` 分支 + result 加 `inputTokens`/`outputTokens`（Task 1）→ ChatController.applyLine 消费（Task 2）一致。
- `ChatMessage.role` 加 `'tool'`（Task 2）→ main.ts renderMessage 三分支处理（Task 6）一致。
- `ChatController` 新增 `activity`/`lastInputTokens`/`lastOutputTokens`/`setHistory`（Task 2）→ main.ts onUpdate + openChat 消费（Task 6）一致。
- `HistoryTurn{Role,Text}` Go（Task 3）↔ `HistoryTurn{role,text}` TS（Task 4）字段对齐（json tag 小写）→ main.ts `t.role`/`t.text`（Task 6）一致。
- `ReadHistory(workdir string, limit int)`（Task 3 session）↔ handleHistory 调用（Task 3 server）一致；`encodeProjectDir` 在 session 包内定义、server 测试用 `encodeForTest` 复刻（不跨包引用未导出函数）。
- `renderMarkdown(text)`（Task 6 render.ts）↔ renderMessage 调用（Task 6 main.ts）一致。
- `VibeRemoteRest.history(workdir, limit)`（Task 4）↔ openChat 调用（Task 6）一致。

**4. 铁律/约束核对：**
- 纯透传：Task 3 服务端读的是 claude 官方 jsonl（提取对话文本），Task 1/6 解析官方 stream-json/markdown，均非 TUI 像素 ✅
- 桌面零改动：Task 4 只给 rest.ts 加桌面不调用的方法；无其它 desktop 运行时改动 ✅
- 协议对齐：Task 4 同步 docs/protocol.md ✅
- 安全：Task 3 handleHistory 过 checkToken + IsAllowedWorkdir（测试覆盖 401/403）✅
- XSS：assistant 走 markdown-it(html:false)+DOMPurify，user/tool 走 escapeHtml（Task 6，render.test 覆盖 script/onerror 消毒）✅

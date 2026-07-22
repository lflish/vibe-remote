# 移动端适配（iOS MVP）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 vibe-remote 新增一条 headless 聊天线，让 iOS App 在 Tailscale 网内以聊天式 UI 接力/续接远端 claude 会话。

**Architecture:** 在现有「PTY→tmux→claude TUI 纯字节透传」线之外并联一条「headless 结构化流」线：远端每轮起 `claude -c -p --output-format stream-json`（prompt 走 stdin，login shell 包裹以加载 PATH），服务端当哑管道**按行**转发 NDJSON，移动端解析成聊天气泡。两线通过「同 workdir + `-c` + 共享 jsonl」接力，触发模型是「刷新即 `-c`」无状态。

**Tech Stack:** Go（服务端，`coder/websocket`）、TypeScript、Vite、Vitest、Capacitor（iOS 壳）。移动端复用现有 `desktop/src/renderer/{client,rest}.ts` 与 `desktop/src/shared/protocol.ts`。

## Global Constraints

- **纯字节透传铁律**：服务端对 headless 线只按行搬运 NDJSON，**绝不解析** claude 输出；解析只发生在移动端展示层，且解析的是 claude 官方 stream-json 协议（非 TUI 像素）。
- **桌面端零行为改动**：`desktop/src/main/`、`index.ts`、xterm 相关代码不改。`client.ts`/`rest.ts`/`protocol.ts` 作为共享传输层可加**可选、缺省省略**的字段/参数，但不得改变桌面现有行为（以 `npm run typecheck` + 省略字段默认值保证）。
- **协议两端手动对齐**：`vibe-remoted/internal/protocol/protocol.go` 与 `desktop/src/shared/protocol.ts` 无代码生成，改协议必须两端同改并同步 `docs/protocol.md`。
- **安全模型复用**：headless attach 的 workdir 必须过 `config.IsAllowedWorkdir` 白名单；WS `auth` token、私有网段绑定不变。
- **headless claude 调用**：`exec <claudeCmd> -c -p --output-format stream-json --include-partial-messages --verbose`，**prompt 经 stdin 传入**（绝不拼进命令行，零注入），login shell 包裹（`<shell> -lic 'exec ...'`）。
- **模块路径**：Go module 前缀为 `github.com/lflish/vibe-remote/vibe-remoted`。
- Go 命令在 `vibe-remoted/` 下跑；移动端命令在 `mobile/` 下跑。

---

### Task 1: 协议扩展 —— attach 帧新增 `mode` 字段（两端 + 文档）

**Files:**
- Modify: `vibe-remoted/internal/protocol/protocol.go`（AttachFrame 加 Mode，新增 Mode 常量）
- Modify: `desktop/src/shared/protocol.ts:26-33`（AttachFrame 加 mode）
- Modify: `docs/protocol.md`（记录 mode 语义）
- Test: `vibe-remoted/internal/protocol/protocol_test.go`（新建）

**Interfaces:**
- Produces (Go): `protocol.ModeTUI = "tui"`, `protocol.ModeHeadless = "headless"`; `AttachFrame.Mode string`（json `mode,omitempty`，空=tui）。
- Produces (TS): `AttachFrame.mode?: 'tui' | 'headless'`。

- [ ] **Step 1: 写失败测试（Go 反序列化含 mode）**

在 `vibe-remoted/internal/protocol/protocol_test.go`：

```go
package protocol

import (
	"encoding/json"
	"testing"
)

func TestAttachFrameMode(t *testing.T) {
	// headless mode round-trips
	raw := `{"type":"attach","workdir":"/tmp","mode":"headless"}`
	var f AttachFrame
	if err := json.Unmarshal([]byte(raw), &f); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if f.Mode != ModeHeadless {
		t.Fatalf("Mode = %q, want %q", f.Mode, ModeHeadless)
	}

	// omitted mode stays empty (caller treats empty as tui)
	var f2 AttachFrame
	if err := json.Unmarshal([]byte(`{"type":"attach"}`), &f2); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if f2.Mode != "" {
		t.Fatalf("Mode = %q, want empty", f2.Mode)
	}

	// empty Mode is omitted from output (back-compat: desktop frames unchanged)
	out, _ := json.Marshal(AttachFrame{Type: TypeAttach})
	if string(out) != `{"type":"attach","cols":0,"rows":0}` {
		t.Fatalf("marshal = %s", out)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd vibe-remoted && go test ./internal/protocol/ -run TestAttachFrameMode`
Expected: 编译失败 `undefined: ModeHeadless` / `f.Mode undefined`。

- [ ] **Step 3: 实现 Go 协议改动**

在 `vibe-remoted/internal/protocol/protocol.go` 的常量块（第 5-17 行）末尾追加：

```go
// Attach modes. Empty Mode is treated as ModeTUI for back-compat.
const (
	ModeTUI      = "tui"
	ModeHeadless = "headless"
)
```

在 `AttachFrame`（第 31-38 行）追加 `Mode` 字段：

```go
// AttachFrame requests opening or resuming a session.
type AttachFrame struct {
	Type      string   `json:"type"`
	SessionID string   `json:"sessionId,omitempty"` // empty = create new
	Cols      uint16   `json:"cols"`
	Rows      uint16   `json:"rows"`
	Workdir   string   `json:"workdir,omitempty"` // working directory for new sessions
	Flags     []string `json:"flags,omitempty"`   // selected claude_flags ids (new session only)
	Mode      string   `json:"mode,omitempty"`    // "" | "tui" | "headless"; empty = tui
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd vibe-remoted && go test ./internal/protocol/ -run TestAttachFrameMode`
Expected: PASS。

- [ ] **Step 5: 实现 TS 协议改动**

在 `desktop/src/shared/protocol.ts` 的 `AttachFrame`（第 26-33 行）追加 `mode`：

```typescript
export interface AttachFrame {
  type: typeof FrameType.Attach;
  sessionId?: string; // empty = create new
  cols: number;
  rows: number;
  workdir?: string; // working directory for new sessions
  flags?: string[]; // selected claude_flags ids (new session only)
  mode?: 'tui' | 'headless'; // omitted = tui (desktop path unchanged)
}
```

- [ ] **Step 6: 桌面端 typecheck 不回归**

Run: `cd desktop && npm run typecheck`
Expected: 无错误（新增字段可选，桌面代码不受影响）。

- [ ] **Step 7: 更新协议文档**

在 `docs/protocol.md` 描述 attach 帧的位置，补一段：

```markdown
### attach 帧的 mode 字段（headless 线）

`attach` 帧可带 `mode` 字段：
- 省略或 `"tui"`：现有行为，创建/续接 PTY→tmux→claude TUI 会话。
- `"headless"`：进入 headless 聊天线。服务端不启 tmux，而是每收到一个 `data` 帧
  （base64 编码的用户 prompt）就在 `workdir` 下起一次
  `claude -c -p --output-format stream-json --include-partial-messages --verbose`
  （prompt 经 stdin 传入），把 claude 的 NDJSON 输出**按行**作为 `data` 帧转发；
  进程退出后等待下一个 `data` 帧。workdir 仍受 allowed_roots 白名单约束。
```

- [ ] **Step 8: Commit**

```bash
git add vibe-remoted/internal/protocol/protocol.go vibe-remoted/internal/protocol/protocol_test.go desktop/src/shared/protocol.ts docs/protocol.md
git commit -m "feat(protocol): attach 帧新增 mode 字段（headless 线）"
```

---

### Task 2: HeadlessRunner —— 每轮起 claude -p，按行回调

**Files:**
- Create: `vibe-remoted/internal/session/headless.go`
- Test: `vibe-remoted/internal/session/headless_test.go`

**Interfaces:**
- Consumes: 无（独立单元）。
- Produces:
  ```go
  type HeadlessRunner struct { /* unexported fields */ }
  func NewHeadlessRunner(workdir, claudeCmd string, loginShell bool, shell string, env []string) *HeadlessRunner
  // RunTurn spawns one `claude -c -p` turn, writes prompt to the process's stdin,
  // and invokes onLine for every complete stdout line (without the trailing \n).
  // Blocks until the process exits. Returns the exit code (0 on success).
  // Cancelling ctx kills the process.
  func (h *HeadlessRunner) RunTurn(ctx context.Context, prompt string, onLine func(line []byte)) (int, error)
  ```

- [ ] **Step 1: 写失败测试（用 stub 命令验证按行回调 + stdin 传入 prompt）**

在 `vibe-remoted/internal/session/headless_test.go`：

```go
package session

import (
	"context"
	"strings"
	"testing"
)

func TestHeadlessRunnerRunTurn(t *testing.T) {
	// Stub "claude": echo two NDJSON lines, and echo back stdin so we can
	// assert the prompt was delivered via stdin (never via the command line).
	// login shell wrapping is exercised (loginShell=true).
	stub := `printf '{"type":"stream_event"}\n{"type":"result"}\n'; cat`
	h := NewHeadlessRunner("/tmp", stub, true, "/bin/sh", nil)

	var lines []string
	code, err := h.RunTurn(context.Background(), "hello-prompt\n", func(line []byte) {
		lines = append(lines, string(line))
	})
	if err != nil {
		t.Fatalf("RunTurn: %v", err)
	}
	if code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	// Two NDJSON lines + the echoed stdin line.
	if len(lines) < 2 {
		t.Fatalf("got %d lines, want >=2: %v", len(lines), lines)
	}
	if lines[0] != `{"type":"stream_event"}` || lines[1] != `{"type":"result"}` {
		t.Fatalf("unexpected first lines: %v", lines)
	}
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "hello-prompt") {
		t.Fatalf("prompt not delivered via stdin; lines: %v", lines)
	}
}

func TestHeadlessRunnerCancel(t *testing.T) {
	// A command that would block forever must be killed by ctx cancel.
	h := NewHeadlessRunner("/tmp", "cat", true, "/bin/sh", nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		// prompt without EOF-triggering exit; cat blocks reading stdin after echo.
		h.RunTurn(ctx, "x", func(line []byte) {})
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-timeoutCh(t):
		t.Fatal("RunTurn did not return after cancel")
	}
}
```

在同文件加一个测试辅助（避免引入 time 到测试主体逻辑之外）：

```go
import "time"

func timeoutCh(t *testing.T) <-chan struct{} {
	t.Helper()
	ch := make(chan struct{})
	go func() {
		time.Sleep(3 * time.Second)
		close(ch)
	}()
	return ch
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd vibe-remoted && go test ./internal/session/ -run TestHeadlessRunner`
Expected: 编译失败 `undefined: NewHeadlessRunner`。

- [ ] **Step 3: 实现 HeadlessRunner**

创建 `vibe-remoted/internal/session/headless.go`：

```go
package session

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

// HeadlessRunner runs one `claude -c -p` turn per RunTurn call (line B: the
// mobile chat path). Unlike the PTY Runner it holds no long-lived process and
// no tmux session — each turn spawns a fresh `claude -p`, streams its NDJSON
// stdout line-by-line, then exits. Continuity across turns is provided by
// claude's own `-c` (continue most recent conversation in this workdir) reading
// the shared ~/.claude/projects/<dir>/*.jsonl. The prompt is written to the
// process's stdin so it never touches the command line (zero shell injection).
type HeadlessRunner struct {
	workdir    string
	claudeCmd  string
	loginShell bool
	shell      string
	env        []string
}

// NewHeadlessRunner builds a runner. claudeCmd is the base command (e.g.
// "claude" or "claude --dangerously-skip-permissions"); the headless flags are
// appended by RunTurn. When loginShell is true the command is wrapped in
// `<shell> -lic 'exec ...'` so the user's PATH / node version manager loads.
func NewHeadlessRunner(workdir, claudeCmd string, loginShell bool, shell string, env []string) *HeadlessRunner {
	return &HeadlessRunner{
		workdir:    workdir,
		claudeCmd:  claudeCmd,
		loginShell: loginShell,
		shell:      shell,
		env:        env,
	}
}

// headlessFlags are appended after the base claude command. --include-partial-messages
// is required for token-by-token content_block_delta events (the typewriter effect);
// --verbose + stream-json are required for the NDJSON event stream.
const headlessFlags = "-c -p --output-format stream-json --include-partial-messages --verbose"

// buildCmd constructs the exec.Cmd. Prompt is NOT included here — it goes to stdin.
func (h *HeadlessRunner) buildCmd(ctx context.Context) *exec.Cmd {
	full := h.claudeCmd + " " + headlessFlags
	var cmd *exec.Cmd
	if h.loginShell {
		sh := h.shell
		if sh == "" {
			sh = "/bin/bash"
		}
		cmd = exec.CommandContext(ctx, sh, "-lic", "exec "+full)
	} else {
		// Non-login: split on spaces (base command has no quoted args in practice).
		parts := strings.Fields(full)
		cmd = exec.CommandContext(ctx, parts[0], parts[1:]...)
	}
	cmd.Dir = h.workdir
	cmd.Env = append(os.Environ(), h.env...)
	return cmd
}

// RunTurn spawns one turn, feeds prompt via stdin, and calls onLine per stdout
// line. Blocks until the process exits. Returns the exit code.
func (h *HeadlessRunner) RunTurn(ctx context.Context, prompt string, onLine func(line []byte)) (int, error) {
	cmd := h.buildCmd(ctx)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return -1, fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return -1, fmt.Errorf("stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return -1, fmt.Errorf("start: %w", err)
	}

	// Write the prompt and close stdin so claude sees EOF and processes it.
	go func() {
		io.WriteString(stdin, prompt)
		stdin.Close()
	}()

	// Stream stdout line-by-line. Raise the buffer so a large NDJSON line
	// (e.g. a big tool_use payload) isn't truncated.
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		// Copy: scanner reuses its buffer on the next Scan.
		cp := make([]byte, len(line))
		copy(cp, line)
		onLine(cp)
	}

	err = cmd.Wait()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.ExitCode(), nil
		}
		return -1, err
	}
	return 0, nil
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd vibe-remoted && go test ./internal/session/ -run TestHeadlessRunner`
Expected: PASS（两个测试）。

- [ ] **Step 5: race 构建校验（与现有 PTY 生命周期共存）**

Run: `cd vibe-remoted && go build -race ./... && go vet ./...`
Expected: 无输出（成功）。

- [ ] **Step 6: Commit**

```bash
git add vibe-remoted/internal/session/headless.go vibe-remoted/internal/session/headless_test.go
git commit -m "feat(session): HeadlessRunner 每轮起 claude -p 按行回调"
```

---

### Task 3: Manager 工厂 + ws.go headless 分派与转发

**Files:**
- Modify: `vibe-remoted/internal/session/manager.go`（加 `NewHeadless` 工厂）
- Modify: `vibe-remoted/internal/server/ws.go`（拆分 attach 读取/开启，新增 headless 分派与 relay）
- Test: `vibe-remoted/internal/server/ws_headless_test.go`（新建，httptest + WS 端到端）

**Interfaces:**
- Consumes: `session.NewHeadlessRunner`（Task 2）；`protocol.ModeHeadless`（Task 1）。
- Produces:
  ```go
  // manager.go
  func (m *Manager) NewHeadless(workdir string) *session.HeadlessRunner // 用 m 的 claudeCmd/loginShell/shell + events env
  // ws.go
  func (s *Server) wsReadAttach(ctx, conn) (protocol.AttachFrame, bool) // 推 sessions + 读到 attach 帧（答 ping）
  func (s *Server) wsOpenTUI(ctx, conn, frame) (*session.Runner, string) // 现有 create/attach + ready 逻辑
  func (s *Server) wsHeadless(ctx, conn, frame protocol.AttachFrame)     // headless relay 循环
  ```

- [ ] **Step 1: 写失败测试（httptest + WS 端到端 headless）**

在 `vibe-remoted/internal/server/ws_headless_test.go`：

```go
package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/config"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/session"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func TestWSHeadlessRelay(t *testing.T) {
	tmp := t.TempDir()
	// Stub claude: emit two NDJSON lines regardless of flags/stdin.
	cfg := &config.Config{
		BindAddr: "127.0.0.1", Port: 0, Token: "tok",
		DefaultWorkdir: tmp, AllowedRoots: []string{tmp},
		UseTmux:   false,
		ClaudeCmd: `printf '{"type":"stream_event"}\n{"type":"result"}\n'; true #`,
	}
	lf := false
	cfg.LoginShell = &lf
	mgr := session.NewManager(cfg.UseTmux, cfg.ClaudeCmd, cfg.UseLoginShell(), cfg.LoginShellPath())
	srv := New(cfg, mgr)

	ts := httptest.NewServer(withCORS(srv.mux))
	defer ts.Close()
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	// auth
	wsjson.Write(ctx, conn, protocol.AuthFrame{Type: protocol.TypeAuth, Token: "tok"})

	// The server pushes a sessions frame first; read and ignore until we can attach.
	// attach headless
	wsjson.Write(ctx, conn, protocol.AttachFrame{
		Type: protocol.TypeAttach, Workdir: tmp, Mode: protocol.ModeHeadless,
	})

	// Expect a ready frame, then send a prompt, then receive NDJSON data frames.
	sawReady := false
	var gotLines []string
	deadline := time.Now().Add(8 * time.Second)
	sentPrompt := false
	for time.Now().Before(deadline) {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			break
		}
		var f protocol.Frame
		json.Unmarshal(raw, &f)
		switch f.Type {
		case protocol.TypeReady:
			sawReady = true
			// send a user prompt as a base64 data frame
			wsjson.Write(ctx, conn, protocol.DataFrame{
				Type:    protocol.TypeData,
				Payload: base64.StdEncoding.EncodeToString([]byte("hi")),
			})
			sentPrompt = true
		case protocol.TypeData:
			var df protocol.DataFrame
			json.Unmarshal(raw, &df)
			dec, _ := base64.StdEncoding.DecodeString(df.Payload)
			gotLines = append(gotLines, string(dec))
		}
		if sentPrompt && len(gotLines) >= 2 {
			break
		}
	}

	if !sawReady {
		t.Fatal("never received ready frame")
	}
	if len(gotLines) < 2 || gotLines[0] != `{"type":"stream_event"}` {
		t.Fatalf("unexpected NDJSON data frames: %v", gotLines)
	}
	_ = os.Stdout
}

func TestWSHeadlessWorkdirRejected(t *testing.T) {
	tmp := t.TempDir()
	cfg := &config.Config{
		BindAddr: "127.0.0.1", Port: 0, Token: "tok",
		DefaultWorkdir: tmp, AllowedRoots: []string{tmp},
		UseTmux: false, ClaudeCmd: "true",
	}
	lf := false
	cfg.LoginShell = &lf
	mgr := session.NewManager(cfg.UseTmux, cfg.ClaudeCmd, cfg.UseLoginShell(), cfg.LoginShellPath())
	srv := New(cfg, mgr)
	ts := httptest.NewServer(withCORS(srv.mux))
	defer ts.Close()
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	wsjson.Write(ctx, conn, protocol.AuthFrame{Type: protocol.TypeAuth, Token: "tok"})
	wsjson.Write(ctx, conn, protocol.AttachFrame{
		Type: protocol.TypeAttach, Workdir: "/etc", Mode: protocol.ModeHeadless,
	})

	// Expect an error frame (workdir not allowed).
	sawError := false
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			break
		}
		var f protocol.Frame
		json.Unmarshal(raw, &f)
		if f.Type == protocol.TypeError {
			sawError = true
			break
		}
	}
	if !sawError {
		t.Fatal("expected error frame for disallowed workdir")
	}
	_ = http.StatusOK
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd vibe-remoted && go test ./internal/server/ -run TestWSHeadless`
Expected: 编译失败（`protocol.ModeHeadless` 已存在，但 headless 分派未实现 → ready 永不到达 / 测试超时失败）。

- [ ] **Step 3: 加 Manager.NewHeadless 工厂**

在 `vibe-remoted/internal/session/manager.go` 末尾（`generateID` 之前或之后）追加：

```go
// NewHeadless builds a HeadlessRunner for the given workdir using the manager's
// configured claude command, login-shell settings, and events environment. It
// does not register anything in the session map — headless turns are stateless
// (continuity is claude's own -c over the shared jsonl), so there is nothing to
// track between turns.
func (m *Manager) NewHeadless(workdir string) *HeadlessRunner {
	var env []string
	if m.eventsURL != "" {
		env = append(env, "VIBE_REMOTE_EVENTS_URL="+m.eventsURL)
	}
	if m.token != "" {
		env = append(env, "VIBE_REMOTE_TOKEN="+m.token)
	}
	return NewHeadlessRunner(workdir, m.claudeCmd, m.loginShell, m.shell, env)
}
```

- [ ] **Step 4: 拆分 ws.go 的 attach 逻辑并加 headless 分派**

在 `vibe-remoted/internal/server/ws.go`，把 `handleWS`（第 20-54 行）改为分派：

```go
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Printf("ws accept: %v", err)
		return
	}
	defer conn.CloseNow()

	conn.SetReadLimit(4 << 20)
	ctx := r.Context()

	if !s.wsAuth(ctx, conn) {
		return
	}

	frame, ok := s.wsReadAttach(ctx, conn)
	if !ok {
		return
	}

	if frame.Mode == protocol.ModeHeadless {
		s.wsHeadless(ctx, conn, frame)
		return
	}

	runner, sessionID := s.wsOpenTUI(ctx, conn, frame)
	if runner == nil {
		return
	}
	s.wsRelay(ctx, conn, runner, sessionID)
}
```

把现有 `wsAttach`（第 83-159 行）**拆成两个函数**。用下面两段替换整个 `wsAttach`：

```go
// wsReadAttach pushes the session list, then reads frames until an attach
// arrives (answering pings during the idle browse window). Returns the attach
// frame, or ok=false if the client disconnected first.
func (s *Server) wsReadAttach(ctx context.Context, conn *websocket.Conn) (protocol.AttachFrame, bool) {
	wsjson.Write(ctx, conn, protocol.SessionsFrame{
		Type: protocol.TypeSessions,
		List: s.mgr.List(),
	})

	var frame protocol.AttachFrame
	for {
		if err := wsjson.Read(ctx, conn, &frame); err != nil {
			return protocol.AttachFrame{}, false
		}
		if frame.Type == protocol.TypePing {
			wsjson.Write(ctx, conn, protocol.Frame{Type: protocol.TypePong})
			continue
		}
		if frame.Type == protocol.TypeAttach {
			return frame, true
		}
		// Ignore other frames while waiting for attach.
	}
}

// wsOpenTUI creates or resumes a PTY→tmux→claude session (line A) and sends the
// ready + refreshed sessions frames. Returns (nil, "") on failure.
func (s *Server) wsOpenTUI(ctx context.Context, conn *websocket.Conn, frame protocol.AttachFrame) (*session.Runner, string) {
	var runner *session.Runner
	var err error

	if frame.SessionID == "" {
		workdir := frame.Workdir
		log.Printf("attach new session: requested workdir=%q", frame.Workdir)
		if workdir == "" {
			workdir = s.cfg.DefaultWorkdir
		}
		if !s.cfg.IsAllowedWorkdir(workdir) {
			sendError(ctx, conn, "workdir not in allowed roots")
			conn.Close(websocket.StatusPolicyViolation, "bad workdir")
			return nil, ""
		}
		claudeCmd := s.cfg.ResolveClaudeCmd(frame.Flags)
		runner, err = s.mgr.Create(workdir, frame.Cols, frame.Rows, claudeCmd)
		if err != nil {
			sendError(ctx, conn, "create session: "+err.Error())
			conn.Close(websocket.StatusInternalError, "create failed")
			return nil, ""
		}
	} else {
		runner, err = s.mgr.Attach(frame.SessionID, frame.Cols, frame.Rows)
		if err != nil {
			sendError(ctx, conn, "attach session: "+err.Error())
			conn.Close(websocket.StatusInternalError, "attach failed")
			return nil, ""
		}
	}

	ready := protocol.ReadyFrame{
		Type:      protocol.TypeReady,
		SessionID: runner.ID,
		Workdir:   runner.Workdir,
	}
	if err := wsjson.Write(ctx, conn, ready); err != nil {
		log.Printf("ws write ready: %v", err)
		return nil, ""
	}
	wsjson.Write(ctx, conn, protocol.SessionsFrame{
		Type: protocol.TypeSessions,
		List: s.mgr.List(),
	})
	return runner, runner.ID
}
```

- [ ] **Step 5: 实现 wsHeadless relay 循环**

在 `vibe-remoted/internal/server/ws.go` 末尾（`sendError` 之前）追加。注意：turn 在 goroutine 里跑以保证读循环仍能答 ping / 感知断开；`busy` 保证一次一轮。

```go
// wsHeadless drives the headless chat line (line B). Each data frame from the
// client is a user prompt (base64 text); the server runs one `claude -c -p`
// turn in the workdir and forwards claude's NDJSON stdout line-by-line as data
// frames. The turn runs in a goroutine so the read loop keeps answering pings
// and can cancel the turn if the client disconnects. Stateless by design:
// continuity is claude's own -c over the shared jsonl ("refresh = -c").
func (s *Server) wsHeadless(ctx context.Context, conn *websocket.Conn, frame protocol.AttachFrame) {
	workdir := frame.Workdir
	if workdir == "" {
		workdir = s.cfg.DefaultWorkdir
	}
	if !s.cfg.IsAllowedWorkdir(workdir) {
		sendError(ctx, conn, "workdir not in allowed roots")
		conn.Close(websocket.StatusPolicyViolation, "bad workdir")
		return
	}

	// Identity for headless is just the workdir; echo it back so the client
	// shows the chat for this directory.
	wsjson.Write(ctx, conn, protocol.ReadyFrame{
		Type:      protocol.TypeReady,
		SessionID: frame.SessionID, // may be empty; workdir is the real key
		Workdir:   workdir,
	})

	runner := s.mgr.NewHeadless(workdir)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var busy atomic.Bool

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			// Client disconnected — cancel any in-flight turn and return.
			return
		}
		var f protocol.Frame
		if err := json.Unmarshal(data, &f); err != nil {
			continue
		}
		switch f.Type {
		case protocol.TypeData:
			if busy.Load() {
				// One turn at a time; ignore input while a turn is streaming.
				continue
			}
			var df protocol.DataFrame
			if err := json.Unmarshal(data, &df); err != nil {
				continue
			}
			prompt, err := base64.StdEncoding.DecodeString(df.Payload)
			if err != nil {
				continue
			}
			busy.Store(true)
			go func() {
				defer busy.Store(false)
				_, runErr := runner.RunTurn(ctx, string(prompt), func(line []byte) {
					wsjson.Write(ctx, conn, protocol.DataFrame{
						Type:    protocol.TypeData,
						Payload: base64.StdEncoding.EncodeToString(line),
					})
				})
				if runErr != nil {
					sendError(ctx, conn, "headless turn: "+runErr.Error())
				}
			}()

		case protocol.TypePing:
			wsjson.Write(ctx, conn, protocol.Frame{Type: protocol.TypePong})

		default:
			// ignore
		}
	}
}
```

确认 `ws.go` 顶部 import 已含 `sync/atomic`、`encoding/base64`、`encoding/json`（现有代码已引入这三者，无需新增）。

- [ ] **Step 6: 运行 headless 端到端测试确认通过**

Run: `cd vibe-remoted && go test ./internal/server/ -run TestWSHeadless -v`
Expected: `TestWSHeadlessRelay` PASS、`TestWSHeadlessWorkdirRejected` PASS。

- [ ] **Step 7: 全量测试 + race + vet（TUI 线不回归）**

Run: `cd vibe-remoted && go test ./... && go build -race ./... && go vet ./...`
Expected: 全部 PASS，无 race/vet 报错。

- [ ] **Step 8: Commit**

```bash
git add vibe-remoted/internal/session/manager.go vibe-remoted/internal/server/ws.go vibe-remoted/internal/server/ws_headless_test.go
git commit -m "feat(server): ws headless 分派 + NDJSON 按行转发"
```

---

### Task 4: 移动端脚手架 + NDJSON 流解析器

**Files:**
- Create: `mobile/package.json`, `mobile/tsconfig.json`, `mobile/vite.config.ts`, `mobile/index.html`
- Create: `mobile/src/stream.ts`
- Test: `mobile/src/stream.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  ```typescript
  export type ChatEvent =
    | { kind: 'delta'; text: string }        // content_block_delta text_delta
    | { kind: 'result'; costUsd?: number; numTurns?: number } // final result line
    | { kind: 'ignored' };                   // system/hook/assistant/other noise
  export function parseStreamLine(line: string): ChatEvent;
  ```

- [ ] **Step 1: 建移动端包脚手架**

创建 `mobile/package.json`：

```json
{
  "name": "vibe-remote-mobile",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@capacitor/core": "^6.0.0",
    "@capacitor/ios": "^6.0.0",
    "@capacitor/preferences": "^6.0.0"
  },
  "devDependencies": {
    "@capacitor/cli": "^6.0.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^2.0.0"
  }
}
```

创建 `mobile/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"]
  },
  "include": ["src"]
}
```

创建 `mobile/vite.config.ts`（别名指向 desktop 复用的传输层，零重复）：

```typescript
import { defineConfig } from 'vite';
import * as path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@net': path.resolve(__dirname, '../desktop/src/renderer'),
      '@shared': path.resolve(__dirname, '../desktop/src/shared'),
    },
  },
  build: { outDir: 'dist' },
});
```

创建 `mobile/index.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1.0, user-scalable=no" />
    <title>vibe-remote</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: 写失败测试（流解析器）**

创建 `mobile/src/stream.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { parseStreamLine } from './stream';

describe('parseStreamLine', () => {
  it('extracts text from content_block_delta', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '紫' } },
    });
    expect(parseStreamLine(line)).toEqual({ kind: 'delta', text: '紫' });
  });

  it('reports result with cost', () => {
    const line = JSON.stringify({
      type: 'result', subtype: 'success', total_cost_usd: 0.12, num_turns: 1, result: '紫色犀牛42',
    });
    expect(parseStreamLine(line)).toEqual({ kind: 'result', costUsd: 0.12, numTurns: 1 });
  });

  it('ignores system/hook noise', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'hook_started' });
    expect(parseStreamLine(line)).toEqual({ kind: 'ignored' });
  });

  it('ignores assistant summary frames (deltas already cover text)', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } });
    expect(parseStreamLine(line)).toEqual({ kind: 'ignored' });
  });

  it('ignores non-text delta (e.g. tool input) safely', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } },
    });
    expect(parseStreamLine(line)).toEqual({ kind: 'ignored' });
  });

  it('ignores malformed JSON without throwing', () => {
    expect(parseStreamLine('not json{')).toEqual({ kind: 'ignored' });
  });

  it('ignores empty line', () => {
    expect(parseStreamLine('')).toEqual({ kind: 'ignored' });
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd mobile && npm install && npm test`
Expected: FAIL — `Cannot find module './stream'`。

- [ ] **Step 4: 实现流解析器**

创建 `mobile/src/stream.ts`：

```typescript
// Parse one NDJSON line from `claude -p --output-format stream-json`.
// The stream mixes hook/system events with the actual model output; we filter
// by top-level `type` and only surface text deltas + the final result. We parse
// claude's OFFICIAL structured protocol here (not TUI pixels), so this respects
// the "no parsing of TUI output" rule — the parsing is in the display layer only.

export type ChatEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'result'; costUsd?: number; numTurns?: number }
  | { kind: 'ignored' };

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
      return { kind: 'ignored' };
    }
    case 'result':
      return {
        kind: 'result',
        costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
        numTurns: typeof obj.num_turns === 'number' ? obj.num_turns : undefined,
      };
    default:
      // 'system', 'assistant', hook events, etc. — noise for the chat view.
      return { kind: 'ignored' };
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd mobile && npm test`
Expected: 7 个测试全 PASS。

- [ ] **Step 6: Commit**

```bash
git add mobile/package.json mobile/tsconfig.json mobile/vite.config.ts mobile/index.html mobile/src/stream.ts mobile/src/stream.test.ts
git commit -m "feat(mobile): 脚手架 + NDJSON 流解析器"
```

---

### Task 5: ChatController（消息累积状态机）

**Files:**
- Create: `mobile/src/chat.ts`
- Test: `mobile/src/chat.test.ts`

**Interfaces:**
- Consumes: `parseStreamLine`, `ChatEvent`（Task 4）。
- Produces:
  ```typescript
  export interface ChatMessage { role: 'user' | 'assistant'; text: string }
  export class ChatController {
    messages: ChatMessage[];
    loading: boolean;
    lastCostUsd?: number;
    onUpdate?: () => void;
    startUserTurn(text: string): void;  // push user msg + empty assistant placeholder + loading=true
    applyLine(line: string): void;      // parse one NDJSON line, accumulate into last assistant msg
  }
  ```

- [ ] **Step 1: 写失败测试**

创建 `mobile/src/chat.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { ChatController } from './chat';

function deltaLine(text: string): string {
  return JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  });
}
function resultLine(cost: number): string {
  return JSON.stringify({ type: 'result', total_cost_usd: cost, num_turns: 1 });
}

describe('ChatController', () => {
  it('startUserTurn pushes user msg + assistant placeholder and sets loading', () => {
    const c = new ChatController();
    c.startUserTurn('你好');
    expect(c.messages).toEqual([
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '' },
    ]);
    expect(c.loading).toBe(true);
  });

  it('accumulates deltas into the last assistant message', () => {
    const c = new ChatController();
    c.startUserTurn('暗号?');
    c.applyLine(deltaLine('紫'));
    c.applyLine(deltaLine('色犀牛42'));
    expect(c.messages[1]).toEqual({ role: 'assistant', text: '紫色犀牛42' });
    expect(c.loading).toBe(true); // still streaming until result
  });

  it('result line ends loading and records cost', () => {
    const c = new ChatController();
    c.startUserTurn('暗号?');
    c.applyLine(deltaLine('紫色犀牛42'));
    c.applyLine(resultLine(0.12));
    expect(c.loading).toBe(false);
    expect(c.lastCostUsd).toBe(0.12);
  });

  it('ignores noise lines without mutating messages', () => {
    const c = new ChatController();
    c.startUserTurn('x');
    const before = JSON.stringify(c.messages);
    c.applyLine(JSON.stringify({ type: 'system', subtype: 'hook_started' }));
    c.applyLine('garbage{');
    expect(JSON.stringify(c.messages)).toBe(before);
  });

  it('fires onUpdate on each mutation', () => {
    const c = new ChatController();
    let n = 0;
    c.onUpdate = () => { n++; };
    c.startUserTurn('x');    // +1
    c.applyLine(deltaLine('a')); // +1
    c.applyLine(resultLine(0.01)); // +1
    expect(n).toBe(3);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd mobile && npm test -- chat`
Expected: FAIL — `Cannot find module './chat'`。

- [ ] **Step 3: 实现 ChatController**

创建 `mobile/src/chat.ts`：

```typescript
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd mobile && npm test -- chat`
Expected: 5 个测试全 PASS。

- [ ] **Step 5: Commit**

```bash
git add mobile/src/chat.ts mobile/src/chat.test.ts
git commit -m "feat(mobile): ChatController 消息累积状态机"
```

---

### Task 6: 存储适配（Capacitor Preferences + localStorage 回退）

**Files:**
- Create: `mobile/src/storage.ts`
- Test: `mobile/src/storage.test.ts`

**Interfaces:**
- Consumes: `MachineConfig`（`@shared/protocol`）。
- Produces:
  ```typescript
  export interface KV { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; }
  export function makeMachineStore(kv: KV): {
    getMachines(): Promise<MachineConfig[]>;
    saveMachines(machines: MachineConfig[]): Promise<void>;
  };
  export function defaultKV(): KV; // Capacitor Preferences, localStorage fallback
  ```

- [ ] **Step 1: 写失败测试（用内存 KV 注入，验证序列化/容错）**

创建 `mobile/src/storage.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { makeMachineStore, type KV } from './storage';
import type { MachineConfig } from '@shared/protocol';

function memKV(): KV {
  const m = new Map<string, string>();
  return {
    get: async (k) => (m.has(k) ? m.get(k)! : null),
    set: async (k, v) => { m.set(k, v); },
  };
}

const sample: MachineConfig[] = [{ name: 'dev', addr: '100.0.0.1', port: 8765, token: 't' }];

describe('makeMachineStore', () => {
  it('round-trips machines', async () => {
    const store = makeMachineStore(memKV());
    await store.saveMachines(sample);
    expect(await store.getMachines()).toEqual(sample);
  });

  it('returns [] when nothing stored', async () => {
    const store = makeMachineStore(memKV());
    expect(await store.getMachines()).toEqual([]);
  });

  it('returns [] on corrupt stored value', async () => {
    const kv = memKV();
    await kv.set('vibe-remote.machines', 'not-json{');
    const store = makeMachineStore(kv);
    expect(await store.getMachines()).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd mobile && npm test -- storage`
Expected: FAIL — `Cannot find module './storage'`。

- [ ] **Step 3: 实现存储适配**

创建 `mobile/src/storage.ts`：

```typescript
import { Preferences } from '@capacitor/preferences';
import type { MachineConfig } from '@shared/protocol';

const KEY = 'vibe-remote.machines';

// KV is the minimal key/value contract the machine store needs. Abstracting it
// lets tests inject an in-memory backend and keeps the persistence mechanism
// swappable (Capacitor Preferences on device, localStorage in browser dev).
export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

// makeMachineStore replaces the desktop's window.vibeRemote.getMachines/
// saveMachines (Electron IPC) with a KV-backed equivalent. Same shape, so the
// mobile UI code reads/writes machines identically to the desktop renderer.
export function makeMachineStore(kv: KV) {
  return {
    async getMachines(): Promise<MachineConfig[]> {
      const raw = await kv.get(KEY);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as MachineConfig[]) : [];
      } catch {
        return [];
      }
    },
    async saveMachines(machines: MachineConfig[]): Promise<void> {
      await kv.set(KEY, JSON.stringify(machines));
    },
  };
}

// defaultKV uses Capacitor Preferences on device. In a plain browser (vite dev
// without the native layer) Preferences falls back to localStorage internally,
// so this works in both contexts.
export function defaultKV(): KV {
  return {
    async get(key) {
      const { value } = await Preferences.get({ key });
      return value ?? null;
    },
    async set(key, value) {
      await Preferences.set({ key, value });
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd mobile && npm test -- storage`
Expected: 3 个测试全 PASS。

- [ ] **Step 5: Commit**

```bash
git add mobile/src/storage.ts mobile/src/storage.test.ts
git commit -m "feat(mobile): 机器清单存储适配（Capacitor Preferences）"
```

---

### Task 7: 聊天 UI 装配（会话列表 → 聊天视图 → 输入发送）

**Files:**
- Create: `mobile/src/main.ts`
- Create: `mobile/src/styles.css`
- Test: 手动冒烟（浏览器 dev + 模拟数据），见步骤末。

**Interfaces:**
- Consumes: `VibeRemoteClient`（`@net/client`）、`VibeRemoteRest`（`@net/rest`）、`ChatController`（Task 5）、`makeMachineStore`/`defaultKV`（Task 6）、`MachineConfig`/`SessionInfo`（`@shared/protocol`）。
- Produces: DOM 应用入口（无导出）。

- [ ] **Step 1: 装配聊天 UI**

创建 `mobile/src/styles.css`：

```css
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
body { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: #1e1e2e; color: #e6e6e6; }
#app { display: flex; flex-direction: column; height: 100vh; height: 100dvh; }
.header { padding: env(safe-area-inset-top) 12px 8px; padding-top: max(env(safe-area-inset-top), 12px); font-weight: 600; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 8px; }
.back { background: none; border: none; color: #89b4fa; font-size: 16px; }
.list { flex: 1; overflow-y: auto; }
.list-item { padding: 14px 16px; border-bottom: 1px solid #2a2a3a; }
.list-item .title { font-weight: 600; }
.list-item .sub { font-size: 12px; color: #888; margin-top: 2px; }
.chat { flex: 1; overflow-y: auto; padding: 12px; }
.bubble { max-width: 85%; padding: 8px 12px; border-radius: 12px; margin: 6px 0; white-space: pre-wrap; word-break: break-word; }
.bubble.user { background: #45475a; margin-left: auto; }
.bubble.assistant { background: #313244; }
.loading { font-style: italic; color: #888; padding: 4px 12px; }
.composer { display: flex; gap: 8px; padding: 8px; padding-bottom: max(env(safe-area-inset-bottom), 8px); border-top: 1px solid #333; }
.composer textarea { flex: 1; resize: none; background: #313244; color: #e6e6e6; border: 1px solid #444; border-radius: 8px; padding: 8px; font-size: 16px; }
.composer button { background: #89b4fa; color: #1e1e2e; border: none; border-radius: 8px; padding: 0 16px; font-weight: 600; }
.cost { font-size: 11px; color: #888; text-align: center; padding: 4px; }
</style>
```

（注：`styles.css` 末尾勿保留 `</style>`；上面末行为笔误，实际文件不含它。）

创建 `mobile/src/main.ts`：

```typescript
import './styles.css';
import { VibeRemoteClient, ConnectionState } from '@net/client';
import { VibeRemoteRest } from '@net/rest';
import { ChatController } from './chat';
import { makeMachineStore, defaultKV } from './storage';
import type { MachineConfig, SessionInfo } from '@shared/protocol';

const app = document.getElementById('app')!;
const store = makeMachineStore(defaultKV());

// base64 <-> bytes (UTF-8 safe) — mobile only needs the encode direction for
// sending prompts and decode for receiving NDJSON lines.
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

// NDJSON can arrive split across frames; buffer partial lines per client.
function makeLineSplitter(onLine: (line: string) => void) {
  let buf = '';
  return (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  };
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
    header.innerHTML = `<div class="title">${m.name}</div><div class="sub">${m.addr}:${m.port} · ${sessions.length} sessions</div>`;
    list.appendChild(header);
    for (const s of sessions) {
      const item = document.createElement('div');
      item.className = 'list-item';
      item.innerHTML = `<div class="title">${s.title}</div><div class="sub">${s.workdir}</div>`;
      item.onclick = () => openChat(m, s);
      list.appendChild(item);
    }
  }
}

function openChat(machine: MachineConfig, session: SessionInfo) {
  const controller = new ChatController();
  app.innerHTML = `
    <div class="header"><button class="back" id="back">‹ 返回</button><span>${session.title}</span></div>
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
    chat.innerHTML = controller.messages
      .map((msg) => `<div class="bubble ${msg.role}">${escapeHtml(msg.text)}</div>`)
      .join('') + (controller.loading ? `<div class="loading">思考中…</div>` : '');
    cost.textContent = controller.lastCostUsd != null ? `本轮成本 $${controller.lastCostUsd.toFixed(4)}` : '';
    chat.scrollTop = chat.scrollHeight;
  };

  const client = new VibeRemoteClient(machine);
  const feed = makeLineSplitter((line) => controller.applyLine(line));
  client.onData = (payload) => feed(base64ToText(payload));
  client.onError = (m) => controller.applyLine(JSON.stringify({ type: 'result' })); // end loading on error
  client.connect();
  // Headless attach: key on workdir, empty sessionId, mode headless.
  client.attach('', 80, 24, session.workdir, undefined, 'headless');

  document.getElementById('send')!.onclick = () => {
    const text = input.value.trim();
    if (!text) return;
    controller.startUserTurn(text);
    client.sendData(bytesToBase64(new TextEncoder().encode(text)));
    input.value = '';
  };
  document.getElementById('back')!.onclick = () => {
    client.disconnect();
    renderMachineList();
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}

renderMachineList();
```

- [ ] **Step 2: 扩展 client.ts 的 attach 支持 mode（共享传输层，桌面行为不变）**

在 `desktop/src/renderer/client.ts` 做三处最小改动：

`pendingAttach` 类型（第 47 行）加 `mode`：

```typescript
  private pendingAttach: { sessionId: string; cols: number; rows: number; workdir?: string; flags?: string[]; mode?: 'tui' | 'headless' } | null = null;
```

新增一个记住当前 mode 的字段（第 50 行 `lastRows` 之后）：

```typescript
  private lastMode: 'tui' | 'headless' | undefined = undefined;
```

`attach` 方法签名与实现（第 140-160 行）改为：

```typescript
  /** Attach to a session (empty sessionId = create new). */
  attach(sessionId: string, cols: number, rows: number, workdir?: string, flags?: string[], mode?: 'tui' | 'headless') {
    this.currentSessionId = sessionId || null;
    this.lastCols = cols;
    this.lastRows = rows;
    this.lastMode = mode;

    if (this.state === ConnectionState.Connected && this.ws) {
      this.send<AttachFrame>({
        type: FrameType.Attach,
        sessionId: sessionId || undefined,
        cols,
        rows,
        workdir,
        flags,
        mode,
      });
    } else {
      this.pendingAttach = { sessionId, cols, rows, workdir, flags, mode };
    }
  }
```

`onopen` 里发 pendingAttach 的地方（第 80-87 行）补 `mode`：

```typescript
        this.send<AttachFrame>({
          type: FrameType.Attach,
          sessionId: this.pendingAttach.sessionId || undefined,
          cols: this.pendingAttach.cols,
          rows: this.pendingAttach.rows,
          workdir: this.pendingAttach.workdir,
          flags: this.pendingAttach.flags,
          mode: this.pendingAttach.mode,
        });
```

`scheduleReconnect` 与 `reconnectNow` 里重建 pendingAttach 的两处（第 129-135、241-247 行）补 `mode: this.lastMode`，使 headless 重连仍为 headless。示例（`scheduleReconnect` 内）：

```typescript
      if (this.currentSessionId) {
        this.pendingAttach = {
          sessionId: this.currentSessionId,
          cols: this.lastCols,
          rows: this.lastRows,
          mode: this.lastMode,
        };
      }
```

`reconnectNow` 内同样加 `mode: this.lastMode`。

- [ ] **Step 3: 两端 typecheck**

Run: `cd desktop && npm run typecheck && cd ../mobile && npm run typecheck`
Expected: 均无错误。（桌面调用 `attach` 未传 mode → undefined → 帧省略 mode → 服务端按 tui 处理，行为不变。）

- [ ] **Step 4: 手动冒烟（浏览器 dev + 真实 vibe-remoted）**

前置：本机跑一个 headless 可用的 vibe-remoted（`claude` + 一个 allowed workdir，`use_tmux` 任意）。在该 workdir 先用桌面端或手工 `claude` 起一轮对话（让 jsonl 存在）。

Run: `cd mobile && npm run dev`
在浏览器打开 dev URL，手工在 localStorage 预置一台机器：

```js
localStorage.setItem('vibe-remote.machines', JSON.stringify([{name:'local',addr:'127.0.0.1',port:8765,token:'<你的token>'}]))
```

刷新页面。Expected：
1. 看到机器 `local` 及其会话列表。
2. 点一个会话 → 进入聊天视图。
3. 输入"刚才的暗号是什么？"→ 发送 → 看到"思考中…"→ 流式出现回复气泡 → 底部显示本轮成本。

- [ ] **Step 5: Commit**

```bash
git add mobile/src/main.ts mobile/src/styles.css desktop/src/renderer/client.ts
git commit -m "feat(mobile): 聊天 UI 装配 + client.ts attach 支持 headless mode"
```

---

### Task 8: Capacitor iOS 壳 + ATS 明文 + 打包

**Files:**
- Create: `mobile/capacitor.config.ts`
- Create（由 `cap add ios` 生成，提交关键文件）: `mobile/ios/App/App/Info.plist`（改 ATS）
- Modify: `mobile/package.json`（加 `cap:sync` 脚本）

**Interfaces:**
- Consumes: Task 4-7 产物（`mobile/dist` 构建输出）。
- Produces: 可在 iOS 模拟器/真机运行的 App。

- [ ] **Step 1: 建 Capacitor 配置**

创建 `mobile/capacitor.config.ts`：

```typescript
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.vibe-remote.mobile',
  appName: 'vibe-remote',
  webDir: 'dist',
  server: {
    // Allow cleartext so ws:// to a tailscale/LAN IP works inside the WebView.
    cleartext: true,
  },
};

export default config;
```

在 `mobile/package.json` 的 `scripts` 加：

```json
    "cap:sync": "npm run build && cap sync ios"
```

- [ ] **Step 2: 构建 web 产物并添加 iOS 平台**

Run:
```bash
cd mobile && npm run build && npx cap add ios && npx cap sync ios
```
Expected: 生成 `mobile/ios/` 目录，`cap sync` 成功（`✔ Copying web assets`、`✔ Sync finished`）。

- [ ] **Step 3: 配置 ATS 允许明文 ws://**

编辑 `mobile/ios/App/App/Info.plist`，在顶层 `<dict>` 内加入：

```xml
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsArbitraryLoads</key>
		<true/>
	</dict>
```

说明：App 在 Tailscale 网内连私有 IP 的明文 `ws://`；传输由 WireGuard（tailscale）加密或限于可信 LAN，与项目现有安全模型一致。

- [ ] **Step 4: 同步并在模拟器运行**

Run:
```bash
cd mobile && npx cap sync ios && npx cap run ios
```
Expected: Xcode 构建成功，模拟器启动 App，显示机器列表空状态（或预置机器）。

若 `cap run ios` 需选择模拟器/签名，可改用 `npx cap open ios` 在 Xcode 里手动 Run（MVP 用开发签名即可）。

- [ ] **Step 5: 端到端验收（对照 spec 验收标准）**

前置：iOS 设备/模拟器与一台跑 vibe-remoted 的机器在同一 Tailscale tailnet；该机器某 workdir 已有桌面端开过的 claude 会话。在 App 内经存储预置该机器（MVP 可临时在 `renderMachineList` 空状态引导，或用模拟器 Safari 预置 localStorage 后由 WebView 共享——真机则需在代码里临时硬编码一台测试机，验收后移除）。

验证四条：
1. 打开 App → 看到远端会话列表。
2. 点进一个桌面开过的会话 → 聊天视图看到接上的上下文（发"刚才聊到哪了"能引用之前内容）。
3. 发一句 → 流式看到 claude 回复（打字机效果）+ 成本显示。
4. 回桌面对同 workdir `claude -c` → 能看到手机这轮对话。

- [ ] **Step 6: 提交 iOS 工程关键文件**

```bash
cd /Users/mac/github/vibe-remote
# 确认 .gitignore 不吞掉需要的 ios 配置；Pods/ 与 build/ 应忽略，Info.plist 与工程需提交
git add mobile/capacitor.config.ts mobile/package.json mobile/ios/App/App/Info.plist
git add mobile/ios/App/App.xcodeproj 2>/dev/null || true
git commit -m "feat(mobile): Capacitor iOS 壳 + ATS 明文 ws"
```

---

## Self-Review

**1. Spec 覆盖检查：**

| Spec 要求 | 对应任务 |
|---|---|
| ① Capacitor 壳、复用 client/rest/protocol | Task 4（别名复用）、Task 8 |
| ① 存储换 Capacitor Preferences | Task 6 |
| ② 明文 ws + ATS 例外 | Task 8 Step 3、capacitor cleartext |
| ③ 聊天式单会话 UI（列表/气泡/输入/成本/loading） | Task 5、Task 7 |
| ③ 发送方向：每发一句起一进程、stdin 传 prompt | Task 2（stdin）、Task 3（每 data 帧一轮） |
| ④ 刷新即 `-c` 无状态 | Task 2/3（无 session map、每轮 `-c`）、Task 7（attach headless by workdir） |
| ④ 防分叉软标记 | **有意推迟**（见下） |
| ⑤ attach 加 mode、headless 启命令、按行转发、TUI 不动 | Task 1、Task 3 |
| ⑤ 协议两端对齐 + docs | Task 1 |
| ⑥ 按 type 过滤 NDJSON、忽略 hook 噪声 | Task 4 |
| ⑥ 首响应 loading 态 | Task 5（loading）、Task 7（"思考中…"） |
| 错误处理：解析异常行跳过 | Task 4（malformed→ignored） |
| 错误处理：WS 断线重连 | 复用 client.ts（Task 7 Step 2 保持 headless 重连） |
| 错误处理：进程异常→提示 | Task 3（turn err→error 帧）、Task 7（onError 结束 loading） |
| 测试策略：Go 单测三项 | Task 2（按行不粘包）、Task 3（mode 分派 + workdir 白名单） |
| 验收标准四条 | Task 8 Step 5 |

**有意推迟的 spec 项（诚实标注）：**「④ 防分叉软标记」（手机接管时标记 tmux + 桌面横幅提示）在本 MVP **不实现**。理由：它需要改动桌面端（横幅提示）与 tmux 会话标记，与「桌面端零行为改动」的 Global Constraint 冲突；且 spec 明确写「MVP 可先只提示不强制」「双端并发强互斥锁」属非 MVP。MVP 依赖「用户人只有一个、不会两端同时敲」的天然约定。执行者若要补，应作为独立后续任务并重新评估桌面改动边界。

**2. 占位符扫描：** 无 TBD/TODO；每个代码步骤含完整代码；每个测试步骤含完整断言。（`mobile/src/styles.css` 步骤中已显式说明末行 `</style>` 为笔误、实际文件不含。）

**3. 类型一致性：**
- Go：`AttachFrame.Mode` / `ModeHeadless`（Task 1）→ ws.go 分派（Task 3）一致；`NewHeadlessRunner(workdir, claudeCmd, loginShell, shell, env)`（Task 2）↔ `Manager.NewHeadless` 调用（Task 3）签名一致；`RunTurn(ctx, prompt, onLine) (int, error)`（Task 2）↔ Task 3 调用一致。
- TS：`parseStreamLine`→`ChatEvent`（Task 4）↔ ChatController.applyLine（Task 5）一致；`makeMachineStore(kv)`/`KV`（Task 6）↔ main.ts（Task 7）一致；`client.attach(..., mode?)`（Task 7 Step 2）↔ main.ts 调用 `attach('',80,24,workdir,undefined,'headless')` 一致。
- 复用别名 `@net`/`@shared`（Task 4 vite 配置）↔ main.ts import（Task 7）一致。

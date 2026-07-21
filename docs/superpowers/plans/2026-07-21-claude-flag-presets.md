# Claude 参数预设（多选 flag）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 服务端定义可选的 claude 启动 flag 白名单（含默认勾选），客户端新建会话时在目录选择器里多选，per-session 决定 claude 带哪些参数。

**Architecture:** 服务端 config 加 `claude_flags`（`{id,label,arg,default}` 列表），经 `/api/v1/info` 下发给客户端。客户端在 dirpicker 里渲染勾选框，把选中的 **id 列表** 走 `AttachFrame.flags` 传回。服务端用 id 查白名单表取出 `arg`，拼在 `claude_cmd` 后面得到该会话的完整启动命令，通过 `Manager.Create` 的新参数传给 Runner——**Runner/RunnerConfig 结构不变**（只是收到的 `ClaudeCmd` 值不同）。客户端只传 id、服务端查表拼接 = 零命令注入面。

**Tech Stack:** Go 1.26（服务端）、TypeScript/Electron（客户端）、coder/websocket。协议两端手动对齐（`protocol.go` ↔ `protocol.ts`）。

## Global Constraints

- **纯字节透传架构不变**：本改动只影响「启动 claude 时带什么参数」，不碰 PTY 字节流。
- **协议两端手动对齐**：改 `AttachFrame` 必须同步改 `vibe-remoted/internal/protocol/protocol.go` 和 `desktop/src/shared/protocol.ts`，并更新 `docs/protocol.md`。
- **向后兼容**：没配 `claude_flags` 时，行为与现状完全一致（localhost 那台 `vibe-remoted.local-tmux.json` 不受影响）。
- **安全**：客户端只传 flag `id`；服务端只接受出现在 `claude_flags` 白名单里的 id，未知 id 忽略。绝不接受客户端直传参数串。
- **冲突不处理**：选中的 flag 按 `claude_flags` 声明顺序全部拼接，不去重、不互斥（用户自负）。
- Go 测试：`cd vibe-remoted && go test ./...`；类型检查：`cd desktop && npm run typecheck`。
- 提交信息结尾附 `Co-Authored-By: Claude <noreply@anthropic.com>`。

---

## 文件结构

**服务端（Go）**
- `vibe-remoted/internal/config/config.go` — 加 `ClaudeFlag` 类型 + `Config.ClaudeFlags` 字段 + `ResolveClaudeCmd(ids []string) string` 方法（查表拼命令）。
- `vibe-remoted/internal/config/config_test.go` — 测 `ResolveClaudeCmd`（白名单过滤、顺序、未知 id 忽略、空列表回退）。
- `vibe-remoted/internal/protocol/protocol.go` — `AttachFrame` 加 `Flags []string`。
- `vibe-remoted/internal/server/server.go` — `handleInfo` 下发 `claude_flags`（label + default，**不含 arg**，arg 不必给客户端）。
- `vibe-remoted/internal/server/ws.go` — wsAttach 解析 `frame.Flags` → `cfg.ResolveClaudeCmd` → 传给 `Manager.Create`。
- `vibe-remoted/internal/session/manager.go` — `Create` 加 `claudeCmdOverride string` 参数（空则用 `m.claudeCmd`）。
- `vibe-remoted/internal/server/events_test.go` — 若 `Create` 签名变动导致编译错，同步修调用。

**客户端（TS）**
- `desktop/src/shared/protocol.ts` — `AttachFrame` 加 `flags?: string[]`。
- `desktop/src/renderer/rest.ts` — `MachineInfo` 加 `claude_flags?: ClaudeFlagInfo[]`。
- `desktop/src/renderer/client.ts` — `attach()` 签名加 `flags`，两处 send + `pendingAttach` 类型同步。
- `desktop/src/renderer/dirpicker.ts` — 拉 info 拿 flags，渲染勾选框，返回类型改 `{workdir, flags}`。
- `desktop/src/renderer/index.ts` — `openSession` 加 `flags` 参数透传到 `client.attach`；`wireNewSessionButton` 接新返回类型。

**文档 & 配置**
- `docs/protocol.md` — AttachFrame 加 flags 字段说明。
- `vibe-remoted.example.json` — 加 `claude_flags` 示例。
- `CLAUDE.md` — 配置章节补一句 claude_flags 用法。

---

## Task 1: 服务端 config —— ClaudeFlag 类型与 ResolveClaudeCmd

**Files:**
- Modify: `vibe-remoted/internal/config/config.go`（`Config` 结构体 :14-41 内加字段；文件末尾加类型和方法）
- Test: `vibe-remoted/internal/config/config_test.go`

**Interfaces:**
- Produces:
  - `type ClaudeFlag struct { ID, Label, Arg string; Default bool }`（json tag: `id/label/arg/default`）
  - `Config.ClaudeFlags []ClaudeFlag`（json: `claude_flags`）
  - `func (c *Config) ResolveClaudeCmd(ids []string) string` — 返回 `claude_cmd` + 空格 + 选中 flag 的 arg（按 `ClaudeFlags` 声明顺序，只认白名单内 id，未知忽略）。ids 为空或无匹配时返回原 `c.ClaudeCmd`。

- [ ] **Step 1: Write the failing test**

在 `config_test.go` 末尾追加：

```go
func TestResolveClaudeCmd(t *testing.T) {
	cfg := &Config{
		ClaudeCmd: "claude",
		ClaudeFlags: []ClaudeFlag{
			{ID: "continue", Label: "续会话", Arg: "-c", Default: false},
			{ID: "skip", Label: "跳过权限", Arg: "--dangerously-skip-permissions", Default: true},
			{ID: "model", Label: "opus", Arg: "--model opus", Default: false},
		},
	}
	tests := []struct {
		name string
		ids  []string
		want string
	}{
		{"no flags", nil, "claude"},
		{"empty slice", []string{}, "claude"},
		{"one flag", []string{"continue"}, "claude -c"},
		{"two flags keep declared order", []string{"model", "continue"}, "claude -c --model opus"},
		{"unknown id ignored", []string{"continue", "bogus"}, "claude -c"},
		{"all unknown falls back", []string{"nope"}, "claude"},
		{"duplicate id not deduped by us", []string{"continue", "continue"}, "claude -c -c"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := cfg.ResolveClaudeCmd(tt.ids)
			if got != tt.want {
				t.Errorf("ResolveClaudeCmd(%v) = %q, want %q", tt.ids, got, tt.want)
			}
		})
	}
}

func TestResolveClaudeCmdNoFlagsConfigured(t *testing.T) {
	cfg := &Config{ClaudeCmd: "claude -c"}
	if got := cfg.ResolveClaudeCmd([]string{"anything"}); got != "claude -c" {
		t.Errorf("with no ClaudeFlags configured, want unchanged %q, got %q", "claude -c", got)
	}
}
```

> 注意 "two flags keep declared order" 用例：传入 `["model","continue"]`，但输出按 `ClaudeFlags` **声明顺序**（continue 在 model 前）得 `claude -c --model opus`。这锁定「顺序由服务端声明决定，不由客户端勾选顺序决定」。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd vibe-remoted && go test ./internal/config -run TestResolveClaudeCmd`
Expected: 编译失败 —— `ClaudeFlag` 未定义 / `ResolveClaudeCmd` 未定义。

- [ ] **Step 3: 加字段与类型**

在 `config.go` 的 `Config` 结构体里 `ClaudeCmd` 字段（:28）后面加一行：

```go
	// Claude command (default: "claude").
	ClaudeCmd string `json:"claude_cmd"`
	// Optional whitelist of selectable launch flags. When set, clients can
	// pick flags per-session (by id); the server appends each selected flag's
	// Arg to ClaudeCmd. Empty = feature off (ClaudeCmd used as-is).
	ClaudeFlags []ClaudeFlag `json:"claude_flags,omitempty"`
```

在文件末尾（`IsAllowedWorkdir` 方法之后）追加：

```go
// ClaudeFlag is one selectable launch flag offered to clients. Id is the stable
// key the client sends back; Label is shown in the picker; Arg is the actual
// command-line fragment appended to ClaudeCmd; Default controls initial checked
// state in the client UI.
type ClaudeFlag struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Arg     string `json:"arg"`
	Default bool   `json:"default,omitempty"`
}

// ResolveClaudeCmd returns the full claude command for a new session: ClaudeCmd
// plus the Arg of every configured flag whose id is in ids. Flags are appended
// in ClaudeFlags declaration order (not the order ids arrives in), so ordering
// is server-controlled. Ids not present in ClaudeFlags are ignored — the client
// can only ever select from the whitelist, never inject arbitrary args.
func (c *Config) ResolveClaudeCmd(ids []string) string {
	if len(ids) == 0 || len(c.ClaudeFlags) == 0 {
		return c.ClaudeCmd
	}
	selected := make(map[string]int) // id -> count (allow dupes to append multiple times)
	for _, id := range ids {
		selected[id]++
	}
	cmd := c.ClaudeCmd
	for _, f := range c.ClaudeFlags {
		for n := 0; n < selected[f.ID]; n++ {
			cmd += " " + f.Arg
		}
	}
	return cmd
}
```

> 说明：用 count map 支持「重复 id 重复拼」（测试用例 "duplicate id not deduped by us"）。仍按 `ClaudeFlags` 声明顺序遍历，所以多个不同 flag 的顺序由服务端定。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd vibe-remoted && go test ./internal/config -run TestResolveClaudeCmd -v`
Expected: 所有子用例 PASS。

- [ ] **Step 5: 跑全量 config 测试确保没破坏**

Run: `cd vibe-remoted && go test ./internal/config`
Expected: `ok`。

- [ ] **Step 6: Commit**

```bash
git add vibe-remoted/internal/config/config.go vibe-remoted/internal/config/config_test.go
git commit -m "feat(config): claude_flags 白名单 + ResolveClaudeCmd 查表拼接

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 协议 —— AttachFrame 加 Flags（两端 + 文档）

**Files:**
- Modify: `vibe-remoted/internal/protocol/protocol.go`（`AttachFrame` :31-37）
- Modify: `desktop/src/shared/protocol.ts`（`AttachFrame` :26-32）
- Modify: `docs/protocol.md`

**Interfaces:**
- Produces:
  - Go: `AttachFrame.Flags []string`（json: `flags,omitempty`）
  - TS: `AttachFrame.flags?: string[]`

- [ ] **Step 1: 改 Go 协议**

`protocol.go` 的 `AttachFrame`（在 `Workdir` 字段后）加：

```go
// AttachFrame requests opening or resuming a session.
type AttachFrame struct {
	Type      string   `json:"type"`
	SessionID string   `json:"sessionId,omitempty"` // empty = create new
	Cols      uint16   `json:"cols"`
	Rows      uint16   `json:"rows"`
	Workdir   string   `json:"workdir,omitempty"` // working directory for new sessions
	Flags     []string `json:"flags,omitempty"`   // selected claude_flags ids (new session only)
}
```

- [ ] **Step 2: 改 TS 协议**

`desktop/src/shared/protocol.ts` 的 `AttachFrame`：

```ts
export interface AttachFrame {
  type: typeof FrameType.Attach;
  sessionId?: string; // empty = create new
  cols: number;
  rows: number;
  workdir?: string; // working directory for new sessions
  flags?: string[]; // selected claude_flags ids (new session only)
}
```

- [ ] **Step 3: 更新协议文档**

`docs/protocol.md` 中 attach 帧的字段说明处，补一行（找到描述 attach 帧字段的表格/列表，加）：

```
- `flags`（可选，仅新建会话）：客户端勾选的 claude 启动 flag id 列表，服务端按 claude_flags 白名单查表拼接
```

- [ ] **Step 4: 编译验证两端**

Run: `cd vibe-remoted && go build ./... && cd ../desktop && npm run typecheck`
Expected: 均无错误（此步只加字段，无消费方，不会破坏编译）。

- [ ] **Step 5: Commit**

```bash
git add vibe-remoted/internal/protocol/protocol.go desktop/src/shared/protocol.ts docs/protocol.md
git commit -m "feat(protocol): AttachFrame 加 flags 字段（两端对齐）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 服务端 —— wsAttach 解析 flags 并透传（含 Manager.Create 签名）

**Files:**
- Modify: `vibe-remoted/internal/session/manager.go`（`Create` :48-72）
- Modify: `vibe-remoted/internal/server/ws.go`（wsAttach 新建分支 :110-128）
- Modify: `vibe-remoted/internal/server/events_test.go`（若引用 `Create`）

**Interfaces:**
- Consumes: `Config.ResolveClaudeCmd`（Task 1）、`AttachFrame.Flags`（Task 2）
- Produces: `func (m *Manager) Create(workdir string, cols, rows uint16, claudeCmdOverride string) (*Runner, error)` — `claudeCmdOverride` 非空时用它替代 `m.claudeCmd` 作为本会话启动命令；空则用 `m.claudeCmd`（向后兼容）。

- [ ] **Step 1: 改 Manager.Create 签名**

`manager.go` 的 `Create`：

```go
// Create starts a new session and registers it. claudeCmdOverride, when
// non-empty, replaces the manager's default claude command for this session
// only (used to inject per-session flags resolved from the client's selection).
func (m *Manager) Create(workdir string, cols, rows uint16, claudeCmdOverride string) (*Runner, error) {
	id := generateID()

	claudeCmd := m.claudeCmd
	if claudeCmdOverride != "" {
		claudeCmd = claudeCmdOverride
	}

	runner, err := NewRunner(RunnerConfig{
		ID:         id,
		Workdir:    workdir,
		UseTmux:    m.useTmux,
		ClaudeCmd:  claudeCmd,
		LoginShell: m.loginShell,
		Shell:      m.shell,
		Cols:       cols,
		Rows:       rows,
		EventsURL:  m.eventsURL,
		Token:      m.token,
	})
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	m.sessions[id] = runner
	m.mu.Unlock()

	return runner, nil
}
```

- [ ] **Step 2: 改 ws.go 调用点，解析 flags**

`ws.go` 新建会话分支（当前 :123 `runner, err = s.mgr.Create(workdir, frame.Cols, frame.Rows)`）改为：

```go
		claudeCmd := s.cfg.ResolveClaudeCmd(frame.Flags)
		runner, err = s.mgr.Create(workdir, frame.Cols, frame.Rows, claudeCmd)
```

（放在 `if !s.cfg.IsAllowedWorkdir(...)` 校验块之后、原 Create 调用处。）

- [ ] **Step 3: 修其他 Create 调用点**

Run: `cd vibe-remoted && go build ./... 2>&1`
Expected: 报错指出 `events_test.go`（或其他）调用 `Create` 参数不足。找到每处 `mgr.Create(...)` / `.Create(...)` 调用，在末尾加 `, ""`（空 override，保持原行为）。

在 `events_test.go` 里搜 `.Create(`，把 `Create(workdir, cols, rows)` 改为 `Create(workdir, cols, rows, "")`。

- [ ] **Step 4: 编译 + 全量测试**

Run: `cd vibe-remoted && go build ./... && go test ./... && go vet ./...`
Expected: build OK、`ok`、vet 无输出。

- [ ] **Step 5: Commit**

```bash
git add vibe-remoted/internal/session/manager.go vibe-remoted/internal/server/ws.go vibe-remoted/internal/server/events_test.go
git commit -m "feat(server): wsAttach 解析 flags → per-session claude 命令

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 服务端 —— /api/v1/info 下发 claude_flags

**Files:**
- Modify: `vibe-remoted/internal/server/server.go`（`handleInfo` :80-92）

**Interfaces:**
- Produces: info JSON 里新增 `claude_flags`，每项为 `{id, label, default}`（**不含 arg** —— arg 是服务端内部拼接细节，客户端无需知道，也避免泄露完整命令）。

- [ ] **Step 1: 改 handleInfo**

`server.go` 的 `handleInfo`，在构造 info map 处加 `claude_flags`：

```go
func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	if !s.checkToken(r, w) {
		return
	}
	hostname, _ := os.Hostname()
	// Expose only id/label/default to the client — never Arg (an internal
	// server-side concatenation detail).
	flags := make([]map[string]any, 0, len(s.cfg.ClaudeFlags))
	for _, f := range s.cfg.ClaudeFlags {
		flags = append(flags, map[string]any{
			"id":      f.ID,
			"label":   f.Label,
			"default": f.Default,
		})
	}
	info := map[string]any{
		"hostname":        hostname,
		"tmux_enabled":    s.cfg.UseTmux,
		"default_workdir": s.cfg.DefaultWorkdir,
		"allowed_roots":   s.cfg.AllowedRoots,
		"claude_flags":    flags,
	}
	writeJSON(w, http.StatusOK, info)
}
```

- [ ] **Step 2: 编译 + 手动验证下发**

Run: `cd vibe-remoted && go build ./...`
Expected: OK。

手动冒烟（用带 claude_flags 的临时配置）：

```bash
cat > /tmp/vr-flags.json <<'JSON'
{
  "bind_addr": "127.0.0.1", "port": 8799, "token": "t",
  "default_workdir": "/tmp", "allowed_roots": ["/tmp"], "use_tmux": false,
  "claude_cmd": "/bin/echo",
  "claude_flags": [
    {"id":"continue","label":"续会话 (-c)","arg":"-c","default":false},
    {"id":"skip","label":"跳过权限","arg":"--dangerously-skip-permissions","default":true}
  ]
}
JSON
cd vibe-remoted && go run ./cmd/vibe-remoted --config /tmp/vr-flags.json &
sleep 2
curl -s -H "Authorization: Bearer t" http://127.0.0.1:8799/api/v1/info
kill %1; rm -f /tmp/vr-flags.json
```
Expected: 返回的 JSON 含 `"claude_flags":[{"default":false,"id":"continue","label":"续会话 (-c)"},{"default":true,"id":"skip","label":"跳过权限"}]`（无 arg 字段）。

- [ ] **Step 3: Commit**

```bash
git add vibe-remoted/internal/server/server.go
git commit -m "feat(server): /api/v1/info 下发 claude_flags（id/label/default）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 客户端 —— MachineInfo + client.attach 加 flags

**Files:**
- Modify: `desktop/src/renderer/rest.ts`（`MachineInfo` :58-63）
- Modify: `desktop/src/renderer/client.ts`（`pendingAttach` :47、`attach` :139-157、pending 重发 :79-87）

**Interfaces:**
- Produces:
  - `interface ClaudeFlagInfo { id: string; label: string; default?: boolean }`
  - `MachineInfo.claude_flags?: ClaudeFlagInfo[]`
  - `VibeRemoteClient.attach(sessionId, cols, rows, workdir?, flags?)` — flags 为选中的 id 列表

- [ ] **Step 1: 改 rest.ts 的 MachineInfo**

`rest.ts` 末尾类型区，`MachineInfo` 接口加字段，并加 `ClaudeFlagInfo`：

```ts
export interface ClaudeFlagInfo {
  id: string;
  label: string;
  default?: boolean;
}

export interface MachineInfo {
  hostname: string;
  tmux_enabled: boolean;
  default_workdir: string;
  allowed_roots: string[];
  claude_flags?: ClaudeFlagInfo[];
}
```

- [ ] **Step 2: 改 client.ts 的 attach 与 pendingAttach**

`pendingAttach` 字段类型（:47）加 `flags`：

```ts
  private pendingAttach: { sessionId: string; cols: number; rows: number; workdir?: string; flags?: string[] } | null = null;
```

`attach()` 方法（:139）：

```ts
  attach(sessionId: string, cols: number, rows: number, workdir?: string, flags?: string[]) {
    this.currentSessionId = sessionId || null;
    this.lastCols = cols;
    this.lastRows = rows;

    if (this.state === ConnectionState.Connected && this.ws) {
      this.send<AttachFrame>({
        type: FrameType.Attach,
        sessionId: sessionId || undefined,
        cols,
        rows,
        workdir,
        flags,
      });
    } else {
      this.pendingAttach = { sessionId, cols, rows, workdir, flags };
    }
  }
```

pending 重发处（:79-87，连接建立后重发 `this.pendingAttach`）同步加 `flags: this.pendingAttach.flags`：

```ts
      if (this.pendingAttach) {
        this.send<AttachFrame>({
          type: FrameType.Attach,
          sessionId: this.pendingAttach.sessionId || undefined,
          cols: this.pendingAttach.cols,
          rows: this.pendingAttach.rows,
          workdir: this.pendingAttach.workdir,
          flags: this.pendingAttach.flags,
        });
```

> 注意：重连恢复已有会话不传 flags（flags 只对新建有意义，服务端 resume 分支不读它），但 pendingAttach 是新建会话首连时的载体，必须带上 flags，否则首连排队场景会丢参数。

- [ ] **Step 3: 类型检查**

Run: `cd desktop && npm run typecheck`
Expected: 通过（此步无调用方变动，openSession 下一 Task 才传 flags）。

- [ ] **Step 4: Commit**

```bash
git add desktop/src/renderer/rest.ts desktop/src/renderer/client.ts
git commit -m "feat(desktop): MachineInfo.claude_flags + client.attach 传 flags

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: 客户端 —— dirpicker 渲染 flag 勾选框，返回 {workdir, flags}

**Files:**
- Modify: `desktop/src/renderer/dirpicker.ts`（`openDirPicker` 返回类型 + DOM）
- Modify: `desktop/src/renderer/index.ts`（`openSession` :208、:317、`wireNewSessionButton` :576-585）
- Modify: `desktop/src/renderer/styles.css`（勾选框样式，小量）

**Interfaces:**
- Consumes: `MachineInfo.claude_flags`（Task 5）、`client.attach(...flags)`（Task 5）
- Produces: `openDirPicker(machine): Promise<{ workdir: string; flags: string[] } | null>`（取消返回 null）；`openSession(machine, sessionId, workdir?, flags?)`

- [ ] **Step 1: 改 openDirPicker 返回类型 + 拉 flags + 渲染勾选框**

`dirpicker.ts` 改动：

1. 函数签名与 Promise 类型：

```ts
export function openDirPicker(
  machine: MachineConfig,
): Promise<{ workdir: string; flags: string[] } | null> {
  return new Promise((resolve) => {
    const rest = new VibeRemoteRest(machine);
    let currentPath = '';
    const flagChecks: Array<{ id: string; input: HTMLInputElement }> = [];
```

2. `close` 函数改为返回对象：

```ts
    function close(result: { workdir: string; flags: string[] } | null) {
      overlay.remove();
      resolve(result);
    }
```

3. 在 footer 之前（`modal.appendChild(list)` 之后、`const footer` 之前）插入 flags 区，并异步填充：

```ts
    const flagsBox = el('div', 'modal-flags');
    modal.appendChild(flagsBox);

    // Load selectable launch flags from the machine's info endpoint.
    rest.info().then((info) => {
      const flags = info.claude_flags || [];
      if (flags.length === 0) return;
      const title = el('div', 'modal-flags-title');
      title.textContent = 'Launch options';
      flagsBox.appendChild(title);
      for (const f of flags) {
        const row = el('label', 'modal-flag');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = f.default === true;
        const span = document.createElement('span');
        span.textContent = f.label; // safe: textContent
        row.append(input, span);
        flagsBox.appendChild(row);
        flagChecks.push({ id: f.id, input });
      }
    }).catch(() => { /* info failed: no flags shown, workdir still works */ });
```

4. selectBtn 收集勾选：

```ts
    cancelBtn.addEventListener('click', () => close(null));
    selectBtn.addEventListener('click', () => {
      const flags = flagChecks.filter((c) => c.input.checked).map((c) => c.id);
      close({ workdir: currentPath, flags });
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });
```

- [ ] **Step 2: 改 index.ts 的 openSession 与 wireNewSessionButton**

`openSession` 签名（:208 附近）加 flags 参数：

```ts
function openSession(machine: MachineConfig, sessionId: string, workdir?: string, flags?: string[]): SessionView {
```

其内部 `client.attach(...)` 调用（:317 附近）传 flags：

```ts
  client.attach(sessionId, dims?.cols || 80, dims?.rows || 24, workdir, flags);
```

`wireNewSessionButton`（:576-585）接新返回类型：

```ts
    const machine = active?.machine || selected || machines[0];
    const picked = await openDirPicker(machine);
    if (picked === null) return; // cancelled
    openSession(machine, '', picked.workdir, picked.flags);
```

> 检查：文件里是否还有其他 `openDirPicker(` 调用点？Run `grep -n "openDirPicker" desktop/src/renderer/*.ts` 确认只有 wireNewSessionButton 一处；若有其他，同步改成解构 `.workdir`。

- [ ] **Step 3: 加勾选框样式**

`desktop/src/renderer/styles.css` 末尾追加（取现有变量）：

```css
.modal-flags {
  padding: 8px 12px;
  border-top: 1px solid var(--border, #DCD6C9);
}
.modal-flags-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-muted);
  margin-bottom: 6px;
}
.modal-flag {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
}
```

> `--border` 变量若不存在则 fallback 到 `#DCD6C9`（已在 CSS 里内联 fallback）。确认 `--border` 是否存在：`grep -n "\-\-border" desktop/src/renderer/styles.css`；不存在就保留 fallback 值。

- [ ] **Step 4: 类型检查**

Run: `cd desktop && npm run typecheck`
Expected: 通过。

- [ ] **Step 5: Commit**

```bash
git add desktop/src/renderer/dirpicker.ts desktop/src/renderer/index.ts desktop/src/renderer/styles.css
git commit -m "feat(desktop): 新建会话目录选择器加 claude flag 多选

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: 示例配置 + 文档 + 端到端真机验证

**Files:**
- Modify: `vibe-remoted.example.json`
- Modify: `CLAUDE.md`（配置章节）

- [ ] **Step 1: 更新示例配置**

`vibe-remoted.example.json` 加 `claude_flags`（放在 `claude_cmd` 之后）：

```json
  "claude_flags": [
    { "id": "continue",   "label": "续上次会话 (-c)",   "arg": "-c",                             "default": false },
    { "id": "skip-perms", "label": "跳过权限确认",       "arg": "--dangerously-skip-permissions", "default": false }
  ],
```

- [ ] **Step 2: CLAUDE.md 配置章节补说明**

在 CLAUDE.md「## 配置」段，`claude_cmd` 说明之后加一句：

```
可选 `claude_flags`（`[{id,label,arg,default}]`）：客户端新建会话时按 label 多选启动 flag，服务端按 id 查白名单把 arg 拼到 `claude_cmd` 后（per-session，客户端只传 id，零注入）。default 控制初始勾选。
```

- [ ] **Step 3: 全量测试 + 类型检查**

Run: `cd vibe-remoted && go test ./... && go vet ./... && cd ../desktop && npm run typecheck`
Expected: 全绿。

- [ ] **Step 4: 端到端真机验证（本机 LAN）**

用带 flags 的配置起本机服务端：

```bash
# 基于 vibe-remoted.local-tmux.json 加 claude_flags，绑本机 LAN IP
cd /Users/mac/github/ccdesk
LAN=$(ifconfig | grep 'inet ' | grep -v 127.0.0.1 | grep -v 'inet 100\.' | awk '{print $2}' | head -1)
# 临时配置见下（含 claude_flags：continue/-c、skip/skip-permissions default:true）
# 起服务端后 curl /api/v1/info 确认 claude_flags 下发
curl -s -H "Authorization: Bearer local-selftest-token" http://$LAN:8765/api/v1/info | grep claude_flags
```
Expected: info 返回含 `claude_flags`。

起桌面端（带 CDP：`VIBE_REMOTE_DEBUG_PORT=9222 VIBE_REMOTE_NO_DEVTOOLS=1 npm run dev`），CDP 或手动验证：
- 点「+ New session」→ 目录选择器底部出现 flag 勾选框，`skip` 默认勾上。
- 勾/不勾若干 → Open here → 新会话在服务端以对应命令启动。
- CDP 断言：`document.querySelectorAll('.modal-flag').length >= 1` 且默认勾选项 `input.checked` 与配置 default 一致。

服务端侧验证拼接正确：查该会话 tmux 里 claude 的实际命令行（`use_tmux:false` 时看进程 `ps`，或用 `claude_cmd:"/bin/echo"` 让 PTY 打印出被拼的参数）。

- [ ] **Step 5: Commit**

```bash
git add vibe-remoted.example.json CLAUDE.md
git commit -m "docs: claude_flags 示例配置与说明

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review

**Spec 覆盖**：
- 服务端预设 + 白名单 → Task 1（ResolveClaudeCmd）✅
- 页面多选 → Task 6（dirpicker 勾选框）✅
- 默认勾选（服务端配、页面可改）→ Task 1（Default 字段）+ Task 4（下发）+ Task 6（`input.checked = f.default`，用户可改）✅
- per-session → Task 2（flags 走 AttachFrame，每次新建独立）+ Task 3（Create per-call override）✅
- 安全零注入 → Task 1（只认白名单 id）+ Task 4（不下发 arg）✅
- 冲突全拼 → Task 1（count map + 声明顺序）✅
- 向后兼容 → Task 1（空 flags 回退 ClaudeCmd）+ Task 3（override 空则用默认）✅
- 合进目录选择器 → Task 6 ✅

**类型一致性**：`ResolveClaudeCmd(ids []string) string`（Task1 定义、Task3 消费）；`Create(workdir, cols, rows, claudeCmdOverride)`（Task3 定义、events_test 修）；`ClaudeFlagInfo{id,label,default}`（Task5 定义、Task6 消费）；`openDirPicker → Promise<{workdir,flags}|null>`（Task6 定义、index.ts 消费）——一致。

**占位符扫描**：无 TBD/TODO，每步含完整代码与命令。

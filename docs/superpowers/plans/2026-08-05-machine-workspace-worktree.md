# 机器工作台与 Worktree Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将桌面端机器概览升级为 Claudette 风格机器工作台，并让新建 Session 支持原目录与服务端编排的 Git worktree 两种模式。

**Architecture:** 在协议中加入向后兼容的 `SessionMode` 和 Worktree 元数据；新增服务端 `worktree.go` 作为 Git 资源边界，Manager 负责编排 Worktree→Runner 创建、回滚、删除和 tmux 恢复；Runner 只维护 PTY/tmux，但负责将元数据写入 tmux option。桌面端统一由创建窗口返回 `workdir/mode/flags`，机器工作台和全局按钮共享同一路径。

**Tech Stack:** Go 1.x、`os/exec` Git CLI、tmux user options、JSON WebSocket、Electron、TypeScript、xterm.js、原生 DOM/CSS。

## Global Constraints

- 客户端绝不解析 Claude 输出；PTY 数据继续以 base64 原始字节透传。
- `mode` 缺失时必须按 `normal` 处理，旧客户端保持兼容。
- Worktree Git 命令只能在 vibe-remoted 服务端执行。
- 用户选择的 `sourceWorkdir` 必须先通过 `allowed_roots` 校验。
- Worktree 位于源仓库同级 `<repo-name>-worktrees/<session-id>`。
- 自动分支固定为 `vibe/<session-id>`，基线固定为源仓库当前 `HEAD`。
- 删除前先停止 Claude；有未提交修改时保留 Worktree 和分支并返回 409。
- tmux 继续是 Session 单一事实来源；Worktree 元数据写入 tmux options。
- Go/TS 协议定义与 `docs/protocol.md` 必须同步。
- 不提交临时仓库、生成截图、`.superpowers/` 或本机配置。

---

### Task 1: Extend protocol types for Session modes

**Files:**
- Modify: `vibe-remoted/internal/protocol/protocol.go:30-66`
- Modify: `desktop/src/shared/protocol.ts:19-68`
- Modify: `docs/protocol.md:44-101`

**Interfaces:**
- Produces Go `SessionMode`, constants `SessionModeNormal` / `SessionModeWorktree`, `SessionMetadata`, and protocol fields.
- Produces TS `SessionMode = 'normal' | 'worktree'` and matching frame fields.

- [ ] **Step 1: Add Go protocol types**

```go
type SessionMode string

const (
    SessionModeNormal   SessionMode = "normal"
    SessionModeWorktree SessionMode = "worktree"
)

type SessionMetadata struct {
    Mode           SessionMode `json:"mode"`
    SourceWorkdir  string      `json:"sourceWorkdir,omitempty"`
    SourceRepo     string      `json:"sourceRepo,omitempty"`
    WorktreeRoot   string      `json:"worktreeRoot,omitempty"`
    Branch         string      `json:"branch,omitempty"`
}
```

Embed or repeat these fields in `AttachFrame`, `ReadyFrame`, and `SessionInfo`. `AttachFrame` only needs `Mode`; Ready/SessionInfo include authoritative metadata.

- [ ] **Step 2: Add matching TS types**

```ts
export type SessionMode = 'normal' | 'worktree';
```

Add optional `mode?: SessionMode` to `AttachFrame`; add required `mode: SessionMode` plus optional source/branch fields to Ready and SessionInfo.

- [ ] **Step 3: Update protocol documentation**

Document `mode`, default-normal compatibility, Worktree metadata, and update JSON examples.

- [ ] **Step 4: Run protocol package checks**

Run: `cd vibe-remoted && go test ./internal/protocol ./internal/server`
Expected: existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add vibe-remoted/internal/protocol/protocol.go desktop/src/shared/protocol.ts docs/protocol.md
git commit -m "feat(protocol): add normal and worktree session modes"
```

---

### Task 2: Build the isolated Git worktree service with TDD

**Files:**
- Create: `vibe-remoted/internal/session/worktree.go`
- Create: `vibe-remoted/internal/session/worktree_test.go`

**Interfaces:**
- Produces:

```go
type WorktreeMetadata struct {
    SourceWorkdir string
    SourceRepo    string
    WorktreeRoot  string
    Branch        string
}

type WorktreePreservedError struct { WorktreeRoot, Branch string }

func CreateWorktree(sourceWorkdir, sessionID string) (WorktreeMetadata, string, error)
func RollbackWorktree(meta WorktreeMetadata) error
func CleanupWorktree(meta WorktreeMetadata) error
```

The second return from `CreateWorktree` is the mapped Session workdir.

- [ ] **Step 1: Write failing tests using temporary Git repositories**

Tests must configure local Git identity and commit one file. Cover:
- repository root selection;
- nested subdirectory mapping;
- non-Git directory;
- generated branch/path;
- clean cleanup removes Worktree and branch;
- dirty cleanup returns `*WorktreePreservedError` and leaves both intact;
- rollback tolerates already-missing Worktree or branch.

Use real public behavior (`git` CLI + filesystem), not private mock-only assertions.

- [ ] **Step 2: Run tests and observe failure**

Run: `cd vibe-remoted && go test ./internal/session -run Worktree -v`
Expected: compile failure because functions are not defined.

- [ ] **Step 3: Implement safe command helpers**

Use `exec.Command("git", "-C", dir, ...)` with argument arrays only. Capture stderr and wrap errors with operation names. Do not invoke a shell.

- [ ] **Step 4: Implement repository discovery and nested path mapping**

`rev-parse --show-toplevel`, `filepath.Abs`, `filepath.Rel`, reject `..` escape, then generate:

```go
parent := filepath.Dir(repoRoot)
container := filepath.Join(parent, filepath.Base(repoRoot)+"-worktrees")
worktreeRoot := filepath.Join(container, sessionID)
branch := "vibe/" + sessionID
```

- [ ] **Step 5: Implement create, rollback, and safe cleanup**

Create with `git worktree add -b <branch> <root> HEAD`. Cleanup checks `status --porcelain`; non-empty returns `WorktreePreservedError`; clean removal uses `git -C <sourceRepo> worktree remove <root>` then `branch -D` and best-effort `os.Remove(container)`.

- [ ] **Step 6: Run tests**

Run: `cd vibe-remoted && go test ./internal/session -run Worktree -v`
Expected: all Worktree tests pass.

- [ ] **Step 7: Commit**

```bash
git add vibe-remoted/internal/session/worktree.go vibe-remoted/internal/session/worktree_test.go
git commit -m "feat(server): manage isolated git worktrees"
```

---

### Task 3: Persist Session metadata in tmux and recover it

**Files:**
- Modify: `vibe-remoted/internal/session/runner.go:28-110,149-201`
- Modify: `vibe-remoted/internal/session/manager.go:13-219`
- Modify: `vibe-remoted/internal/session/manager_test.go`

**Interfaces:**
- `Runner` gains `Mode`, `SourceWorkdir`, `SourceRepo`, `WorktreeRoot`, `Branch`.
- `RunnerConfig` gains matching fields.
- `tmuxSessionInfo` gains metadata fields.
- `Runner.Metadata() protocol.SessionMetadata` returns normalized default mode.

- [ ] **Step 1: Add tests for metadata normalization and list serialization**

Test that an empty Runner mode serializes as `normal`, while Worktree fields pass through unchanged.

- [ ] **Step 2: Extend the batched tmux format**

Append tab-separated options to `list-sessions -F`:

```text
#{@vibe_remote_mode}	#{@vibe_remote_source_workdir}	#{@vibe_remote_source_repo}	#{@vibe_remote_worktree_root}	#{@vibe_remote_branch}
```

Parse with a fixed field count, preserving empty values.

- [ ] **Step 3: Write metadata options immediately after tmux creation**

After `new-session` starts, set each option with `tmux set-option -t <session> @key <value>`. Store `normal` too, so future recovery is explicit. Avoid shell interpolation.

- [ ] **Step 4: Recover and expose metadata**

Backfill all fields in `Manager.List()` reconciliation, including recovered Runner entries. Populate Ready/SessionInfo from `Runner.Metadata()`.

- [ ] **Step 5: Run session tests**

Run: `cd vibe-remoted && go test ./internal/session -v`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add vibe-remoted/internal/session/runner.go vibe-remoted/internal/session/manager.go vibe-remoted/internal/session/manager_test.go
git commit -m "feat(server): persist worktree session metadata in tmux"
```

---

### Task 4: Orchestrate Worktree create/delete in Manager and server

**Files:**
- Modify: `vibe-remoted/internal/session/manager.go:47-139`
- Modify: `vibe-remoted/internal/server/ws.go:107-158`
- Modify: `vibe-remoted/internal/server/server.go:120-134`
- Create: `vibe-remoted/internal/server/worktree_test.go`

**Interfaces:**
- Replace Manager create signature with:

```go
type CreateOptions struct {
    Workdir string
    Mode protocol.SessionMode
    Cols, Rows uint16
    ClaudeCmdOverride string
}
func (m *Manager) Create(opts CreateOptions) (*Runner, error)
```

- `Manager.Delete` may return `*WorktreePreservedError`.

- [ ] **Step 1: Write failing server/manager tests**

Cover default normal mode, Worktree creation, Runner-start rollback using an invalid command, and DELETE mapping preserved error to HTTP 409 with JSON:

```json
{"error":"worktree_preserved","message":"...","worktreeRoot":"...","branch":"..."}
```

- [ ] **Step 2: Generate the Session ID before Worktree creation**

Manager owns ID generation, then calls `CreateWorktree(opts.Workdir, id)` before `NewRunner`. On runner failure call `RollbackWorktree`.

- [ ] **Step 3: Update wsAttach**

Normalize empty mode to `normal`; reject unknown values; validate the requested source directory before Manager create. Send authoritative metadata in ReadyFrame.

- [ ] **Step 4: Implement safe deletion**

Remove Runner from map and kill it, then run `CleanupWorktree` for Worktree mode. On preserve/conflict, keep Worktree metadata recoverable long enough to return the structured error. Normal deletion remains unchanged.

- [ ] **Step 5: Map delete errors to HTTP responses**

`WorktreePreservedError` → 409; not found → 404; other cleanup failure → 500. Include path/branch only for the preserved result.

- [ ] **Step 6: Run server and session tests**

Run: `cd vibe-remoted && go test ./internal/session ./internal/server -v`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add vibe-remoted/internal/session/manager.go vibe-remoted/internal/server/ws.go vibe-remoted/internal/server/server.go vibe-remoted/internal/server/worktree_test.go
git commit -m "feat(server): orchestrate worktree session lifecycle"
```

---

### Task 5: Add mode selection to the Session creation UI

**Files:**
- Modify: `desktop/src/renderer/dirpicker.ts:1-142`
- Modify: `desktop/src/renderer/client.ts:1-160`
- Modify: `desktop/src/renderer/index.ts:219-333,593-609`
- Modify: `desktop/src/renderer/styles.css:297+`

**Interfaces:**
- `openDirPicker` returns `{ workdir: string; flags: string[]; mode: SessionMode } | null`.
- `VibeRemoteClient.attach(..., mode?: SessionMode)` preserves mode in pending initial attach.
- `openSession(..., mode: SessionMode = 'normal')` sends it for new sessions.

- [ ] **Step 1: Add two selectable mode cards to the picker**

Render `Open existing directory` and `Create isolated worktree`, defaulting to Normal. Worktree selection shows the confirmed explanatory copy.

- [ ] **Step 2: Return mode from the picker**

Include selected mode in the resolved result. Keep flags and path behavior unchanged.

- [ ] **Step 3: Thread mode through client attach**

Add mode to `pendingAttach`, immediate send, initial delayed send, and `attach()` parameters. Reconnect of an established Session uses session ID only and does not need creation mode.

- [ ] **Step 4: Thread mode through `openSession` and all creation call sites**

Both global create and machine-workspace create use the same helper and pass `picked.mode`.

- [ ] **Step 5: Add picker styling**

Use bordered mode cards, selected accent outline, short descriptions, and a non-warning informational note.

- [ ] **Step 6: Run desktop typecheck**

Run: `cd desktop && npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add desktop/src/renderer/dirpicker.ts desktop/src/renderer/client.ts desktop/src/renderer/index.ts desktop/src/renderer/styles.css
git commit -m "feat(desktop): choose normal or worktree sessions"
```

---

### Task 6: Replace the overview card with the Scheme A machine workspace

**Files:**
- Modify: `desktop/src/renderer/index.ts` machine overview functions
- Modify: `desktop/src/renderer/styles.css` overview styles
- Modify: `desktop/src/renderer/rest.ts:18-22`

**Interfaces:**
- Machine info cache keyed by `machineKey` provides default workdir and tmux state.
- `renderMachineOverview` renders header, stats, recent sessions, and mode actions.
- `startNewSession(machine, initialMode?)` is the single create entry point.

- [ ] **Step 1: Cache MachineInfo during refresh**

Add `machineInfo` Map. Fetch `listSessions()` and `info()` concurrently per machine, retaining the previous info if a transient info request fails.

- [ ] **Step 2: Extract a single Session creation helper**

```ts
async function startNewSession(machine: MachineConfig, initialMode?: SessionMode) {
    const picked = await openDirPicker(machine, initialMode);
    if (!picked) return;
    openSession(machine, '', picked.workdir, picked.flags, picked.mode);
}
```

Use it from global button, header CTA, and both mode cards.

- [ ] **Step 3: Render Scheme A header and stats**

Header contains eyebrow/name/metadata and Manage/New Session. Stats use session count, local open-view count for that machine, and Local/Remote classification.

- [ ] **Step 4: Render recent sessions**

Sort by `created` descending, slice to 5, show title/workdir/mode/status, and open on click. Empty state says `No sessions on this machine yet.`

- [ ] **Step 5: Render the two mode cards**

Normal and Worktree cards call `startNewSession(machine, mode)`, so the picker opens with the selected card preselected.

- [ ] **Step 6: Replace the current centered-card CSS**

Implement full-height workspace page: page header, flat stat strip, sections, recent rows, and mode cards. Keep responsive behavior for narrow windows.

- [ ] **Step 7: Run desktop checks**

Run: `cd desktop && npm run typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add desktop/src/renderer/index.ts desktop/src/renderer/styles.css desktop/src/renderer/rest.ts
git commit -m "feat(desktop): build Claudette-style machine workspace"
```

---

### Task 7: End-to-end verification and review

**Files:**
- No production files expected unless runtime verification reveals a defect.

**Interfaces:**
- Verifies full Electron→WS→Manager→Git→tmux→Claude path.

- [ ] **Step 1: Run all automated checks**

```bash
cd vibe-remoted && go test ./...
cd ../desktop && npm run typecheck
```

- [ ] **Step 2: Launch a safe local server and Electron dev app**

Use loopback, a temporary allowed Git repository, tmux enabled, `/bin/bash` or real Claude as appropriate, and CDP port 9222.

- [ ] **Step 3: Verify Scheme A pixels and navigation**

Capture a screenshot and inspect it. Click a machine, recent session, Manage, header create, and both mode cards. Confirm switching to overview never destroys existing `.term-instance` elements.

- [ ] **Step 4: Verify Normal mode**

Create in an existing directory and run `pwd`; output must equal the selected original directory.

- [ ] **Step 5: Verify Worktree mode**

Select a nested repository subdirectory. Confirm Ready/SessionInfo mode and metadata, `pwd` maps into `<repo>-worktrees/<id>/<relative-subdir>`, and branch is `vibe/<id>`.

- [ ] **Step 6: Verify clean deletion**

Delete the clean Session and confirm tmux Session, Worktree directory, and branch are all gone.

- [ ] **Step 7: Probe dirty deletion**

Create an untracked file, delete the Session, and confirm HTTP 409/UI message plus preserved directory/branch. Confirm Claude/tmux stopped.

- [ ] **Step 8: Verify restart recovery**

Keep a Worktree Session alive in tmux, restart vibe-remoted, list/attach it, and verify all metadata returns and deletion still works.

- [ ] **Step 9: Run code review and simplify changed code**

Invoke `/code-review high` and `/simplify`; apply confirmed fixes, then repeat runtime verification for affected paths.

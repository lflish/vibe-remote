# Task 4 Report

## Status
Implemented Manager/server Worktree create/delete orchestration.

## RED evidence
Ran:
```text
cd /Users/mac/github/vibe-remote/vibe-remoted && go test ./internal/session ./internal/server -run 'TestManagerCreate|TestManagerDeleteDirty|TestDeleteDirty' -v
```

Initial result was the expected build failure because `CreateOptions` did not yet exist and `Manager.Create` still had the old positional signature:
```text
internal/session/manager_test.go:17:21: undefined: CreateOptions
internal/session/manager_test.go:17:21: not enough arguments in call to m.Create
have (unknown type)
want (string, uint16, uint16, string)
internal/server/worktree_test.go:20:36: undefined: session.CreateOptions
FAIL
```

## Changes
- Added `session.CreateOptions` and changed `Manager.Create` to generate the session ID before worktree creation.
- Added normal-mode defaulting and unknown-mode rejection.
- Added worktree creation metadata propagation to Runner and rollback when Runner startup fails.
- Added safe worktree deletion: stop/remove the Runner first, then clean clean worktrees; dirty worktrees return `*WorktreePreservedError` while preserving Git resources.
- Updated WebSocket attach to validate allowed source workdir before Manager orchestration and send mode-aware authoritative metadata through the existing Ready frame.
- Mapped preserved worktrees to structured HTTP 409 JSON; not found remains 404 and other cleanup failures are 500.
- Added focused Manager and HTTP tests.

## Verification
```text
cd /Users/mac/github/vibe-remote/vibe-remoted && go test ./internal/session ./internal/server -v
PASS
ok   github.com/lflish/vibe-remote/vibe-remoted/internal/session 4.053s
ok   github.com/lflish/vibe-remote/vibe-remoted/internal/server 1.320s

cd /Users/mac/github/vibe-remote/vibe-remoted && go test ./...
PASS
ok   github.com/lflish/vibe-remote/vibe-remoted/internal/config (cached)
ok   github.com/lflish/vibe-remote/vibe-remoted/internal/server 0.794s
ok   github.com/lflish/vibe-remote/vibe-remoted/internal/session 3.643s

cd /Users/mac/github/vibe-remote/vibe-remoted && go test -race ./internal/session ./internal/server
PASS
ok   github.com/lflish/vibe-remote/vibe-remoted/internal/session 5.303s
ok   github.com/lflish/vibe-remote/vibe-remoted/internal/server 1.690s
```

## Scoped files
- `/Users/mac/github/vibe-remote/vibe-remoted/internal/session/manager.go`
- `/Users/mac/github/vibe-remote/vibe-remoted/internal/session/manager_test.go`
- `/Users/mac/github/vibe-remote/vibe-remoted/internal/server/ws.go`
- `/Users/mac/github/vibe-remote/vibe-remoted/internal/server/server.go`
- `/Users/mac/github/vibe-remote/vibe-remoted/internal/server/worktree_test.go`

Unrelated pre-existing working-tree changes were not touched.

## Task 4 Fixes

### Finding 1 — canonical workdir validation
- Root cause: `wsAttach` called lexical `IsAllowedWorkdir` before `CreateWorktree`, so an allowed-root symlink could resolve outside the allowlist.
- Fix: added `Config.ResolveAllowedWorkdir`, which canonicalizes absolute paths and allowed roots with `filepath.EvalSymlinks` before containment checking; `wsAttach` and `/api/v1/fs` now use the canonical result. Normal session mode remains unchanged, while worktree creation receives the canonical source path.
- Regression: `TestIsAllowedWorkdirRejectsSymlinkEscape`.

### Finding 2 — delete recovered tmux sessions
- Root cause: `Manager.Delete` looked only in memory, unlike `List`, so sessions surviving a daemon restart were reported not found.
- Fix: tmux-mode `Delete` now queries the injected live-tmux seam and reconciles under the manager lock before lookup. It does not call `List`, avoiding lock recursion/deadlock.
- Regression: `TestManagerDeleteRecoversLiveTmuxSessionBeforeLookup`.

## Task 4 Verification
```text
cd /Users/mac/github/vibe-remote/vibe-remoted && go test ./...
PASS

cd /Users/mac/github/vibe-remote/vibe-remoted && go test -race ./internal/session ./internal/server
PASS

cd /Users/mac/github/vibe-remote/vibe-remoted && go vet ./...
PASS

git diff --check
PASS
```

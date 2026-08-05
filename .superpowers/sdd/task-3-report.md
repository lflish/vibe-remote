
## Review fixes (coordinator follow-up)

- Replaced `TrimSpace` with newline-only trimming in `liveTmuxSessions`, preserving trailing empty tab fields. Parsing now requires exactly eight fields and rejects empty session IDs.
- Every metadata option is now sent through an argument-array `tmux set-option` invocation, including empty values.
- Added parser tests for empty IDs, malformed field counts, and trailing-empty metadata output; reconciliation continues through the tested Manager.List serialization path.

### Follow-up verification
- `cd /Users/mac/github/vibe-remote/vibe-remoted && go test ./internal/session -v` — PASS.
- `cd /Users/mac/github/vibe-remote/vibe-remoted && go test -race ./internal/session` — PASS.

## Re-review fix: reconciliation coverage

- Extracted the existing tmux snapshot reconciliation into a deterministic helper, preserving production behavior while avoiding a real tmux daemon in unit tests.
- Added focused tests proving worktree metadata is applied both to an existing Runner and to a Runner recovered after daemon restart. The existing Runner test also verifies its non-empty Workdir remains authoritative.

### Exact verification

- `cd /Users/mac/github/vibe-remote/vibe-remoted && go test ./internal/session -v` — `PASS`; `ok github.com/lflish/vibe-remote/vibe-remoted/internal/session 3.365s`.
- `cd /Users/mac/github/vibe-remote/vibe-remoted && go test -race ./internal/session` — `ok github.com/lflish/vibe-remote/vibe-remoted/internal/session 4.153s`.
- `git -C /Users/mac/github/vibe-remote diff --check` — PASS (no output).

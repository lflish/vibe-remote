---
name: check
description: Run the repository's full pre-merge gate (`make check` — gofmt, go vet, go test -race, desktop typecheck and regression tests) and diagnose failures. Use before committing, before opening a PR, after any code change in vibe-remoted/ or desktop/, or when the user asks whether the change "passes CI".
---

# check

`make check` is the single source of truth: CI (`.github/workflows/ci.yml`),
CONTRIBUTING.md and the release workflow all run exactly this. Do not invent a
separate command list.

## Run

```bash
make check                      # everything
make check-server               # Go only: gofmt -l, go vet, go test -race -count=1
make check-desktop              # desktop only: tsc --noEmit, npm test
VIBE_REMOTE_REQUIRE_TMUX=1 make check-server   # what CI does: tmux tests fail instead of skip
```

`check-desktop` needs `cd desktop && npm ci` first if `node_modules` is missing.

## Reading failures

- **`gofmt needed:`** — run `make fmt`, re-run.
- **`DATA RACE`** — never "fix" by removing `-race`. Find the two goroutines in the
  report; in this repo the usual suspects are Runner fields read outside
  `r.mu`/`metaMu`, or Manager map access outside `m.mu`. Keep the lock order
  described in `vibe-remoted/internal/session/runner.go`.
- **tmux tests** — `no server running` means the test assumed a live tmux
  server; tests must create their own session on a unique name and clean it up
  with `t.Cleanup`. Leftover sessions: `tmux -L vibe-remote ls`.
- **`test:terminal-selection`** — the xterm version pin or
  `mouseEventsRequireAlt` changed. Read the "终端选区与复制" section of
  CLAUDE.md before touching it.
- **`test:i18n-parity`** — a key exists in one locale only; add it to both.

## Rules

- Report the real outcome. If anything failed or was skipped, say which step
  and paste the relevant output; do not summarize a red run as green.
- New regression scripts go into the desktop `test` script in
  `desktop/package.json`; new Go tests just need to live under `vibe-remoted/`.
  Both are then picked up by `make check` automatically.

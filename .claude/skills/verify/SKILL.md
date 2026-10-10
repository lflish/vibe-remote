---
name: verify
description: End-to-end smoke test of the real client↔daemon path on this Mac, without a remote machine — starts a throwaway vibe-remoted (tmux + /bin/bash) and drives it over the actual WebSocket/REST protocol (auth, attach, PTY round-trip, hook env/token, events→notify, per-session env isolation, delete). Use after changing vibe-remoted, the protocol, or desktop connection code, before claiming the change works.
---

# verify

Unit tests cover seams; this proves the assembled daemon behaves. The CLI is
`/bin/bash` because byte passthrough does not care what runs.

## 1. Start a throwaway daemon

Use a random port and a temp config so you never collide with a daemon the user
already runs (`tmux -L vibe-remote` is shared — only touch sessions you create).

```bash
PORT=$((20000 + RANDOM % 10000))
CFG=$(mktemp -t vr-verify).json
TOKEN=$(openssl rand -hex 32)
sed -e "s/8765/$PORT/" -e "s/local-development-only/$TOKEN/" vibe-remoted.tmux.json > "$CFG"
(cd vibe-remoted && go run ./cmd/vibe-remoted --config "$CFG") > /tmp/vr-verify.log 2>&1 &
```

Run the `go run` in the background (Bash `run_in_background`), then poll
`curl -sf http://127.0.0.1:$PORT/healthz` until it answers (~10s max). If it
never does, read `/tmp/vr-verify.log` — a config validation error is the usual
cause.

## 2. Drive the protocol

```bash
VR_TOKEN=$TOKEN node .claude/skills/verify/scripts/ws-smoke.mjs 127.0.0.1:$PORT /tmp
```

Each line is `PASS`/`FAIL`; exit code is non-zero on any failure. Never print
`$TOKEN` in your reply.

## 3. GUI (only when desktop code changed)

The script covers the wire protocol, not rendering. For renderer changes, run
the app with `VIBE_REMOTE_DEBUG_PORT=9222 VIBE_REMOTE_NO_DEVTOOLS=1 npm run dev`
in `desktop/`, add the machine `127.0.0.1:$PORT` with the token, and inspect via
raw CDP over WebSocket (`http://127.0.0.1:9222/json` lists targets; the
chrome-devtools MCP is unreliable against this Electron version). Check: the
terminal fills the window, typing echoes, drag-select + ⌘C copies, killing the
daemon shows the reconnect banner and restarting it recovers the session.

## 4. Clean up — always, even on failure

```bash
kill %1 2>/dev/null || pkill -f "vibe-remoted --config $CFG"
rm -f "$CFG" /tmp/vr-verify.log
tmux -L vibe-remote ls 2>/dev/null   # should show none of the smoke sessions
```

## Report

State which steps ran, paste the PASS/FAIL lines, and say explicitly what was
not covered (e.g. "GUI not exercised").

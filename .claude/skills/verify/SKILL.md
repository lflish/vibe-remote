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

## 3. GUI (when desktop code, Electron, xterm or clipboard changed)

`ws-smoke.mjs` covers the wire protocol, not the app. For the desktop, run the
CDP-driven GUI regression (macOS, needs a display; ~1 min). It starts its own
daemon and launches the built app with a throwaway userData dir and
`--use-mock-keychain`, so steps 1/2/4 here are not needed for it:

```bash
node .claude/skills/verify/scripts/gui-smoke.mjs          # builds desktop/dist first
node .claude/skills/verify/scripts/gui-smoke.mjs --keep   # leave the app open afterwards
```

It checks:
- legacy `machines.json` gets encrypted on launch;
- new session via the picker, and the terminal fills its container;
- typing echoes;
- drag-select works under remote mouse reporting, and ⌘C copies;
- ⌘V pastes;
- navigation and `window.open` are blocked;
- a hook event raises a desktop notification (it reports `shown` or `fallback`);
- after a daemon restart the client reconnects and the session still works.

Neither script covers packaged-build-only behaviour, which differs for
notifications because unsigned builds use the Dock fallback. Check that by
hand in `release/mac-*/vibe-remote.app` after `npm run build -- --dir`.

## 4. Clean up — always, even on failure

```bash
kill %1 2>/dev/null || pkill -f "vibe-remoted --config $CFG"
rm -f "$CFG" /tmp/vr-verify.log
tmux -L vibe-remote ls 2>/dev/null   # should show none of the smoke sessions
```

## Report

State which steps ran, paste the PASS/FAIL lines, and say explicitly what was
not covered (e.g. "GUI not exercised").

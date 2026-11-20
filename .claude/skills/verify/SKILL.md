---
name: verify
description: End-to-end smoke test of the real client↔daemon path on this Mac, without a remote machine — starts a throwaway vibe-remoted (tmux + /bin/bash) and drives it over the actual WebSocket/REST protocol (auth, attach, PTY round-trip, hook env/token, events→notify, per-session env isolation, delete), plus a chat-session smoke against a throwaway daemon running the fake claude. Use after changing vibe-remoted, the protocol, or desktop connection code, before claiming the change works.
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

### Chat sessions (protocol v3)

Chat mode only runs claude, so `/bin/bash` can't stand in. `ws-chat-smoke.mjs`
needs no daemon from step 1: it builds vibe-remoted and the fake claude
(`vibe-remoted/internal/chat/fakeclaude`), starts its own daemon with
`claude_cmd` pointing at the fake, its own `state_dir`, `CLAUDE_CONFIG_DIR`
(with a workspace-trust file for its temp folders) and tmux server
(`TMUX_TMPDIR`), and removes all of it afterwards:

```bash
node .claude/skills/verify/scripts/ws-chat-smoke.mjs
```

Cases: `chat: create`, `chat: replay before ready`, `chat: two clients`,
`chat: pending survives reconnect`, `chat: resync 50`, `chat: handoff`,
`chat: daemon restart → ended`, `chat: state without hooks`,
`chat: delete keeps jsonl`. Same PASS/FAIL output and exit code.

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
- after a daemon restart the client reconnects and the session still works;
- chat (a second throwaway daemon running the fake claude, listed as a second
  machine): `chat session created via picker`, `chat reply rendered`,
  `permission allow once resumes`.

The terminal cases stay on the `/bin/bash` daemon.

### Chat acceptance cases (GUI)

`gui-chat-smoke.mjs` is the browser half of the chat acceptance scenarios
(the `R…` ids of docs/changes/2026-11-13-dual-mode/spec.md). Same launch
model as gui-smoke (built app, throwaway userData, `--use-mock-keychain`,
~1 min), with five throwaway machines: `/bin/bash`, fake claude (with `-c`
and `--dangerously-skip-permissions` as `claude_flags`), fake claude
reporting 1.0.51, fake claude whose `system/init` says 1.0.0, and a daemon
built from the `main` branch (protocol 2; built through a temporary
`git worktree`, or pass `VR_MAIN_DAEMON=<binary>`). The app is forced to the
zh locale; assertions use the zh strings.

```bash
node .claude/skills/verify/scripts/gui-chat-smoke.mjs                 # builds desktop/dist first
DEVFLOW_EVIDENCE_DIR=docs/changes/<change>/evidence node …/gui-chat-smoke.mjs --no-build   # + one PNG per case
VR_CDP_PORT=39222 VR_INSPECT_PORT=49229 node …/gui-chat-smoke.mjs --keep   # leave it running to poke around
```

Cases: picker 界面 (R1.1 default terminal, R1.3 not claude, R1.4 claude too
old, R17.2 old daemon + terminal on it), `-c` with a 3000-line history in a
300-message window (R1.5), bypass locked (R1.6/R11.2), Markdown + copy
(R3.2), raw HTML / `javascript:` / links via `open-external` (R3.3), tool
blocks + diff (R4), answer lost before reaching the daemon (R5.6), answered
elsewhere first (R5.7), plan review (R6), AskUserQuestion (R7), Esc / stop
(R8), queue (R9), slash menu + terminal-only commands (R10), mode switcher
(R11.1), offline while 500 messages arrive → divider, render ≤2000 ms
(R12/R12.2), turn error + retry (R13.1), background prompt → yellow dot,
Dock fallback, notification click (R16.3), claude exits → restart (R13.2),
handoff while running (R14.2), init version too old (R13.4).

Cases driven with real input events (CDP `Input.dispatchMouseEvent` wheel /
press / release with `clickCount`, `insertText`, key events — not
`element.click()` or setting `scrollTop`), each on sessions of its own:
`X7-send` (scrolled up with the wheel → a typed message and its reply show,
replies do not drag the view, the bottom has them), `X7-background` (more than
a screen arrives while another session is open → back at the bottom; left
scrolled up → same place), `X8-chat` / `X8-terminal` (double click on the
sidebar name of an open session, current and background → renamed, nothing
typed into the session, sidebar still updates), `X10-prompt` (a background
session asks for permission → real click on its sidebar name → `1` answers,
Esc interrupts, the next message is typed, all without clicking the card or
the input), `X10-rename-chat` / `X10-rename-terminal` (after a rename ended by
Enter, Esc, or a click on another session, the next keys go into the current
session without a click), `X6` (current session, app
really hidden → yellow dot + notification, cleared on focus). `VR_ONLY=<ids>`
runs a subset, e.g. `VR_ONLY=X7-send,X7-background,X8-chat,X8-terminal`,
`VR_ONLY=X10-prompt,X10-rename-chat,X10-rename-terminal` or
`VR_ONLY=S1,X6` (cases after `S1` need the main chat session it creates).

How it fakes things (so failures can be read): network faults are a wrapped
`WebSocket` in the renderer (`window.__vrNet`: hold incoming frames, drop
outgoing ones, close a socket, refuse new connections); the "other desktop"
is a plain WebSocket client in the script; the main process is driven over
`--inspect` (Dock badge, `app.hide()`, a stubbed `shell.openExternal` so no
real browser opens, a simulated `notification-click`). Unsigned builds never
show a native notification (Dock fallback), so a real notification click is
not covered.

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

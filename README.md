# vibe-remote

**English** ｜ [简体中文](./README.zh-CN.md)

A cross-platform "remote Claude" client: Claude Code CLI runs on a remote Linux
machine while desktop / web / iOS clients present a structured, chat-style rich
UI over it — tool-call cards, side-by-side diffs, collapsible thinking, token /
cost, streamed markdown. All three clients share one framework-agnostic core and
one React view layer.

See [REQUIREMENTS.md](./REQUIREMENTS.md) and [docs/protocol.md](./docs/protocol.md) for details.

## Architecture

```
Desktop (Electron) ┐
Web (Vite SPA)     ┼─ws (JSON frames)─►  vibe-remoted (Go)  ──►  claude -p --output-format stream-json
iOS (Capacitor)    ┘   @vibe-remote/{core,ui}   one per machine     (headless line: structured events)
```

- **Structured events, not TUI bytes**: the server runs `claude -p --output-format stream-json`
  and relays claude's **official NDJSON protocol** line-by-line. Clients parse it *only for display*
  (tool_use ↔ tool_result pairing, thinking, cost) — this is not TUI-pixel parsing, so the
  "clients never parse the terminal" rule still holds.
- **Shared core + UI**: [`@vibe-remote/core`](./packages/core) holds the protocol, WS/REST clients,
  and the chat parser/state machine (zero DOM, unit-tested); [`@vibe-remote/ui`](./packages/ui) holds
  the React components. Desktop / web / iOS are thin shells over them.
- **Two data planes**: the structured **headless line** is the default. A raw-byte **TUI line**
  (PTY → tmux → claude, xterm passthrough) is retained on the server as an escape hatch for
  interactive full-screen programs.
- **tmux persistence** (TUI line): the claude session survives client disconnects and is restored
  on reconnect. The headless line keeps continuity via claude's own `-c` over the shared jsonl.
- **No central hub**: each machine runs its own vibe-remoted and clients connect directly. The server
  binds a private-network address (LAN / tailscale) with a static token as the primary access boundary;
  cross-network reach and encryption can be delegated to Tailscale.

## Features

- **Rich chat UI**: streamed markdown, tool-call cards (collapsible, success/error state), side-by-side
  diffs for Edit/Write, collapsible thinking blocks, and a token/cost bar — all rendered from claude's
  structured stream-json.
- **Three clients, one codebase**: desktop (Electron), web (browser SPA + a tiny Go static portal),
  and iOS (Capacitor) all consume the same `@vibe-remote/core` + `@vibe-remote/ui`.
- **Multi-machine**: machines grouped in the sidebar with a reachability dot; sessions key on workdir
  (`claude -c` continues a directory's most recent conversation).
- **Reconnection**: the status bar shows reconnect progress, with a disconnect banner + Retry.
- **claude flag presets**: the server defines a `claude_flags` whitelist; on new-session you multi-select
  flags (e.g. `-c` to continue, skip-permissions) — applied per-session.
- **In-app machine management**: add / edit / remove machines + test connection, no need to hand-edit
  the stored machine list.

## Layout

```
packages/core/   @vibe-remote/core — framework-agnostic shared kernel (protocol, WS/REST, chat parser)
packages/ui/     @vibe-remote/ui   — shared React view components (ChatView, ToolCard, DiffToolCard, …)
vibe-remoted/    Go server (single binary) + cmd/vibe-portal (static web host)
desktop/         Electron client (thin shell over core+ui)
mobile/          iOS client (Capacitor, thin shell over core+ui)
web/             Web SPA (Vite + React, thin shell over core+ui)
docs/            protocol docs
```

This is an npm-workspaces monorepo; run `npm install` at the root once.

## Server: vibe-remoted

### Build

```bash
make server          # produces bin/vibe-remoted
# or
cd vibe-remoted && go build -o ../bin/vibe-remoted ./cmd/vibe-remoted
```

### Configuration

Copy `vibe-remoted.example.json` and adjust per machine:

```json
{
  "bind_addr": "192.168.x.x",      // private-network address (RFC1918 / loopback /
                                    //   link-local / tailscale 100.64.0.0/10); enforced
  "port": 8765,
  "token": "your-secure-token",     // static auth token, the core access boundary (constant-time compare)
  "default_workdir": "/home/user",
  "allowed_roots": ["/home/user"],  // workdir whitelist, prevents path escape
  "use_tmux": true,                 // false = run claude directly (no persistence)
  "claude_cmd": "claude",           // base command, passed as one string to the shell
  "claude_flags": [                 // optional: flags the client can multi-select on new session
    { "id": "continue",   "label": "Continue last session (-c)", "arg": "-c",                             "default": false },
    { "id": "skip-perms", "label": "Skip permission prompts",    "arg": "--dangerously-skip-permissions", "default": false }
  ],
  "login_shell": true,              // launch via login shell to load user env
                                    //   (PATH, fnm/nvm, etc.); default true
  "shell": "",                      // login shell path; empty = $SHELL or /bin/bash
  "allow_insecure_bind": false      // true allows binding a public address (not recommended); wildcards always rejected
}
```

**Appending launch args**: `claude_cmd` is a full command string — append args directly, e.g.
`"claude_cmd": "claude --dangerously-skip-permissions -c"`. It launches via a login shell as
`<shell> -lic 'exec <claude_cmd>'`, so args are parsed by shell rules.

**Flag presets (`claude_flags`)**: optional. Define a list of `{id, label, arg, default}`; on new
session the client multi-selects by `label`, and the server looks up each `id` in the whitelist and
appends its `arg` to `claude_cmd` (**per-session**, independent for each session). The client only
sends ids and the server resolves them from the table = zero command injection; `default` controls the
initial checked state. If unset, `claude_cmd` is used as-is.

Environment overrides: `VIBE_REMOTED_BIND_ADDR`, `VIBE_REMOTED_TOKEN`.

### Run

```bash
./bin/vibe-remoted --config vibe-remoted.json
```

### Test

```bash
cd vibe-remoted && go test ./...   # unit tests (incl. path-escape protection)
```

## Clients

All clients share `@vibe-remote/core` + `@vibe-remote/ui`. Install once at the repo root:

```bash
npm install      # installs all workspaces (packages/*, desktop, mobile, web)
```

Each machine is configured with `name / addr / port / token` via in-app machine management
(add / edit / remove + test connection). The stored list lives in each client's local storage
(Electron userData on desktop, Capacitor Preferences on iOS, `localStorage` on web).

### Desktop (Electron)

```bash
npm run dev --workspace=vibe-remote      # Vite + Electron hot reload
npm run build --workspace=vibe-remote    # tsc + vite build + electron-builder → .dmg
```

### Web (SPA + Go portal)

The web client is a static SPA; a tiny Go binary (`vibe-portal`) embeds and serves it. Browsers then
connect directly to each machine's vibe-remoted over `ws://` (Tailscale-encrypted).

```bash
npm run dev --workspace=@vibe-remote/web  # Vite dev server
make portal                               # build web/dist + embed → bin/vibe-portal
./bin/vibe-portal -addr 127.0.0.1:9000    # serve the portal; open the URL in a browser
```

### iOS (Capacitor)

```bash
npm run build --workspace=vibe-remote-mobile   # tsc + vite build
cd mobile && npx cap sync ios                  # sync web assets into the Xcode project, then build in Xcode
```

### Tests

```bash
npm test                    # all JS workspaces (core / ui / mobile / web)
npm run typecheck           # all workspaces
```

## Prerequisites

- The client and target machine just need network reachability: same **Tailscale tailnet**
  (recommended — built-in encryption + cross-network) or the same **trusted LAN**
  (plaintext `ws://` on the LAN; use only on trusted networks).
- The target Linux host has `claude` and `tmux`. `go` is only needed to build vibe-remoted /
  vibe-portal, not to run them (cross-compile and copy the binary over).
- When using Tailscale, the Mac must be up (`tailscale up`).
- Browsers on an HTTPS page can't open a plaintext `ws://` (mixed-content). Serve the web portal
  over `http://` inside the tailnet, or terminate TLS in front of vibe-remoted.

## Local smoke test (no remote machine)

macOS has PTY + tmux, so you can run vibe-remoted locally for a smoke test. Use `claude_cmd: "/bin/bash"`
as a stand-in to verify the passthrough chain (raw passthrough doesn't care what command runs).

### Self-connect test (make dev-local)

The Mac acts as both server and client, running real `claude` through the full chain:

```bash
make dev-local   # binds this host's tailscale IP with a real address (no allow_insecure_bind)
```

It prints the `addr:port` to fill in on the client (this host's tailscale IP + 8765). In the desktop
"machine management", add this machine (token is in `vibe-remoted.local-tmux.json`) to verify
passthrough / tmux persistence / reconnect end-to-end. Requires `tailscale up` and `tmux` + `claude`
installed locally.

### Web-portal smoke (headless line, no tmux)

Verifies the full structured chain (browser → vibe-portal → headless vibe-remoted → real claude →
stream-json → chat rich UI) on one machine:

```bash
# 1) config: bind loopback, use_tmux false, real claude
cat > /tmp/vibe-remoted.headless.json <<'EOF'
{"bind_addr":"127.0.0.1","port":8799,"token":"smoke",
 "default_workdir":"/tmp","allowed_roots":["/tmp","/Users"],
 "use_tmux":false,"claude_cmd":"claude --dangerously-skip-permissions","login_shell":true}
EOF
./bin/vibe-remoted -config /tmp/vibe-remoted.headless.json &

# 2) build + serve the portal
make portal
./bin/vibe-portal -addr 127.0.0.1:9100 &

# 3) open http://127.0.0.1:9100 in a browser, add machine (127.0.0.1 / 8799 / smoke),
#    "+ 选目录开聊" → send a message → verify tool cards / diff / thinking / cost render.
```

## License

[MIT](./LICENSE) © 2026 lflish

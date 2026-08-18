# vibe-remote

**English** ｜ [简体中文](./README.zh-CN.md)

A macOS desktop client for using Claude Code CLI on a remote machine like a
local terminal. The interactive CLI runs inside a remote PTY while the Electron
app renders the original terminal byte stream.

> **Project status:** early public preview. The only supported client is the macOS desktop app.
> This repository intentionally ships one client: remote PTY→tmux terminal access.

vibe-remote is an independent open-source project and is not affiliated with or
endorsed by Anthropic. Claude and Claude Code are trademarks of their respective
owners.

See [docs/protocol.md](./docs/protocol.md) for protocol details.

## Architecture

```
Desktop (Electron + xterm.js)  ──ws (JSON frames)──►  vibe-remoted (Go)  ──►  PTY→tmux→claude
    "dumb terminal", raw byte passthrough              one per machine       bidirectional bytes
```

- **Raw byte passthrough**: the client never parses claude's output. PTY bytes are relayed verbatim in both directions, so streaming / colors / cursor render with zero loss.
- **tmux persistence**: the claude session survives client disconnects and is restored on reconnect.
- **No central hub**: each machine runs its own vibe-remoted and the client connects directly. The server binds a private-network address (LAN / tailscale) with a static token as the primary access boundary; cross-network reach and encryption can be delegated to Tailscale.

## What's new in v0.1.1

- Terminal text is selectable and copyable again: drag to select, ⌘C to copy, ⌘V to paste. Mouse events reach the remote app only while ⌥ is held (scrolling is unaffected).
- First-launch terminal layout is now measured only after the xterm host is visible, so a newly opened terminal fills the window without requiring a manual resize.
- Added a regression check for the initial terminal layout timing.
- The repository is now desktop-only: the ignored mobile, web, shared-package, and portal trees have been removed from the working tree.

## Features
- **Session naming / background hints**: double-click to rename; a sidebar dot lights up when a background session has output or is waiting for input.
- **Reconnection**: the status bar shows reconnect progress, with a disconnect banner + Retry on the active session.
- **claude flag presets**: the server defines a `claude_flags` whitelist; on new-session you multi-select flags (e.g. `-c` to continue, skip-permissions) — applied per-session.
- **In-app machine management**: add / edit / remove machines + test connection, no need to hand-edit `machines.json`.
- **Copy / paste**: drag to select and ⌘C to copy, ⌘V to paste — even though claude enables mouse reporting. Hold ⌥ to send drags/clicks to the remote app instead; the scroll wheel always reaches it.

## Layout

```
vibe-remoted/    Go server (single binary)
desktop/         Electron + xterm.js client
docs/            protocol docs
```

## Quick start

1. Copy `vibe-remoted.example.json` to a private config file outside the
   repository and set a random token, bind address, and allowed roots.
2. Build and start `vibe-remoted` on the remote machine.
3. Run the desktop app with `make dev-desktop`.
4. Add the remote machine from the app's machine manager.

Do not expose `vibe-remoted` directly to the public internet. Read
[SECURITY.md](./SECURITY.md) before deployment.

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
  "claude_reload_cmd": "claude -c", // command used by per-session Reload
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

## Client: desktop

### Install deps

```bash
cd desktop && npm ci
```

### Dev run

```bash
npm run dev      # Vite + Electron hot reload
```

### Deploy to a remote Linux host

The desktop client and `vibe-remoted` must be kept on compatible versions. After changing the Go daemon or the WebSocket/REST protocol, cross-compile and replace the remote binary before testing from the desktop app:

```bash
cd vibe-remoted
go test ./...
GOOS=linux GOARCH=amd64 go build -o /tmp/vibe-remoted-linux-amd64 ./cmd/vibe-remoted
scp /tmp/vibe-remoted-linux-amd64 dev:/home/<user>/vibe-remoted.new
ssh dev 'systemctl --user stop vibe-remoted.service && install -m 0755 /home/<user>/vibe-remoted.new /home/<user>/vibe-remoted && rm -f /home/<user>/vibe-remoted.new && systemctl --user start vibe-remoted.service'
```

Use the daemon's configured NAT/private address and token in the desktop machine manager. The SSH address and the daemon's listening address may differ when the Linux guest is behind a Windows/VM NAT port mapping. Verify all client endpoints after deployment:

```bash
curl http://<daemon-address>:8765/healthz
curl -H 'Authorization: Bearer <token>' http://<daemon-address>:8765/api/v1/info
curl -H 'Authorization: Bearer <token>' http://<daemon-address>:8765/api/v1/sessions
```



On first run, click "machine management" in the sidebar to add / edit / remove machines and test
connections in-app (recommended). Each machine takes `name / addr / port / token`. With multiple
machines, click a machine name in the sidebar to select it — new sessions then land on the selected machine.

The list is stored under the Electron userData dir as `machines.json` (rarely edited by hand):

```json
[
  { "name": "machine-a", "addr": "192.168.1.x or 100.x.x.x", "port": 8765, "token": "your-secure-token" }
]
```

macOS path is typically `~/Library/Application Support/vibe-remote/machines.json`.

### Package (.dmg)

```bash
npm run build    # tsc + vite build + electron-builder
```

Local builds are unsigned. macOS may require explicitly allowing the app in
System Settings. Official signed binaries are not yet provided.

## Prerequisites

- The client and target machine just need network reachability: same **Tailscale tailnet**
  (recommended — built-in encryption + cross-network) or the same **trusted LAN**
  (plaintext `ws://` on the LAN; use only on trusted networks).
- The target host has `claude` and `tmux`. Go is required only when building the
  daemon from source.
- When using Tailscale, the Mac must be up (`tailscale up`).

## Local smoke test (no remote machine)

macOS has PTY + tmux, so you can run vibe-remoted locally for a smoke test. Use `claude_cmd: "/bin/bash"`
as a stand-in to verify the passthrough chain (raw passthrough doesn't care what command runs).

### Self-connect test (make dev-local)

The Mac acts as both server and client, running real `claude` through the full chain:

```bash
make dev-local   # binds this host's tailscale IP with a real address (no allow_insecure_bind)
```

It prints the `addr:port` and a one-time token to fill in on the client. In the desktop
"machine management", add this machine to verify
passthrough / tmux persistence / reconnect end-to-end. Requires `tailscale up` and `tmux` + `claude`
installed locally.

## Contributing and security

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the
development workflow. Report vulnerabilities according to
[SECURITY.md](./SECURITY.md), not through public issues.

## License

[MIT](./LICENSE) © 2026 lflish

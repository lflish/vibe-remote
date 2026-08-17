# Contributing to vibe-remote

Thanks for helping improve vibe-remote. The initial public release focuses on
the macOS desktop client and the Go daemon.

## Current product scope

The current repository contains one product line: a macOS Electron desktop client connected to the Go daemon over the PTY→tmux terminal protocol. Mobile, web, and shared-package implementations are not part of the active tree; do not add them back without a new product decision.

## Development setup



Requirements:

- Go 1.22 or newer
- Node.js 22 or newer
- npm
- tmux for persistence and worktree integration tests
- macOS for running and packaging the Electron desktop app

Install the desktop dependencies:

```bash
cd desktop
npm ci
```

Run the desktop app in development mode:

```bash
make dev-desktop
```

Run a loopback daemon backed by `/bin/bash`:

```bash
make dev-server
```

For a full self-connect test over Tailscale with the real `claude` command:

```bash
make dev-local
```

`make dev-local` generates a one-time token. Do not commit machine addresses,
tokens, personal paths, or local machine configuration.

## Checks

Run these before opening a pull request:

```bash
cd vibe-remoted && go test ./... && go vet ./...
cd ../desktop && npm run typecheck && npm run test:preserved-notice && npm run test:attach-replay && npm run test:terminal-layout
```

## Architecture rules

- PTY data is raw byte passthrough. The client must not parse CLI output.
- `docs/protocol.md`, `vibe-remoted/internal/protocol/protocol.go`, and
  `desktop/src/shared/protocol.ts` must stay aligned when the protocol changes.
- Treat tmux as the persistent session source of truth.
- Keep work directories behind the server-side `allowed_roots` boundary.
- Preserve unrelated local changes in a dirty worktree.

## Pull requests

- Keep changes focused and explain user-visible behavior.
- Add or update tests for server lifecycle, protocol, and security changes.
- Include screenshots for desktop UI changes.
- Never include generated builds, dependency directories, private configs, or
  credentials.

Maintainers should follow [docs/releasing.md](./docs/releasing.md) when preparing
a release.

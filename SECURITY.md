# Security Policy

## Supported versions

Security fixes are provided for the latest released version on the default
branch.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting feature for this repository. If it is not
available, contact the maintainer privately through the address listed on the
maintainer's GitHub profile.

Include reproduction steps, affected versions, impact, and any suggested
mitigation. Please allow reasonable time for investigation before public
disclosure.

## Current product scope

The supported product surface is the macOS Electron desktop client and the Go `vibe-remoted` daemon. The repository does not currently ship mobile or web clients.

## Deployment boundary



`vibe-remoted` gives an authenticated client interactive access to a shell-like
CLI running with the daemon user's permissions. Treat it as remote shell access:
the token is the boundary. `allowed_roots` and the `claude_flags` whitelist
constrain what the *client UI* can request, but they are not a sandbox: once a
session is running, its CLI can reach anything the daemon user can.

Agent processes never receive the main token. Each session gets a hook token
(`VIBE_REMOTE_TOKEN`, derived per session) that can only post events for that
session to `/api/v1/events`, so a prompt-injected agent or one of its tools
cannot use it to control other sessions or the daemon.

- Use a unique, randomly generated token for every machine (at least 16
  characters is enforced; use `openssl rand -hex 32`).
- Never commit tokens or a `machines.json` file.
- Bind only to loopback, a trusted private network, or a Tailscale address.
- Prefer Tailscale because the application protocol currently uses plaintext
  `ws://`; a trusted LAN does not provide transport encryption.
- Never expose the daemon directly to the public internet.
- Keep `allowed_roots` as narrow as practical.
- Run the daemon as a dedicated, minimally privileged user when possible.
- Enabling permission-skipping CLI flags materially increases risk.

### Chat sessions

Chat sessions run `claude -p` (stream-json) directly, without the TUI. In that
mode claude shows no workspace-trust prompt and runs the project's hooks from
`.claude/settings.json` straight away. The daemon therefore creates a chat
session only in a directory claude has already trusted
(`projects[<dir>].hasTrustDialogAccepted` is `true` in `~/.claude.json`, or in
`$CLAUDE_CONFIG_DIR/.claude.json`); anything else is refused with
`workdir_untrusted`. Open claude once in that directory from a terminal session
to trust it first.

"Allow and don't ask again" on a permission card sends back only the rule
suggestion claude itself offered. claude writes that rule on the remote
machine, usually into the project's `.claude/settings.local.json` (the card
names the destination), and later sessions in that project stop asking for it.
Review or remove such rules there. The daemon never writes `.claude` settings
files and never reads claude credentials.

The daemon rejects wildcard bind addresses and rejects public addresses unless
`allow_insecure_bind` is explicitly enabled. That escape hatch is intended for
controlled development only and is not a secure production configuration.

## Credential handling

Machine credentials are stored in Electron's user-data directory
(`machines.json`, mode `0600`). Tokens are encrypted with the OS keychain via
Electron `safeStorage`; if keychain encryption is unavailable they fall back to
plaintext and the app logs a warning. They are not intended to be checked into
this repository. If a token is ever printed
in logs, copied into an issue, or committed to Git, rotate it immediately.


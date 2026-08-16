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
CLI running with the daemon user's permissions. Treat it as remote shell access.

- Use a unique, randomly generated token for every machine.
- Never commit tokens or a `machines.json` file.
- Bind only to loopback, a trusted private network, or a Tailscale address.
- Prefer Tailscale because the application protocol currently uses plaintext
  `ws://`; a trusted LAN does not provide transport encryption.
- Never expose the daemon directly to the public internet.
- Keep `allowed_roots` as narrow as practical.
- Run the daemon as a dedicated, minimally privileged user when possible.
- Enabling permission-skipping CLI flags materially increases risk.

The daemon rejects wildcard bind addresses and rejects public addresses unless
`allow_insecure_bind` is explicitly enabled. That escape hatch is intended for
controlled development only and is not a secure production configuration.

## Credential handling

Machine credentials are stored locally in Electron's user-data directory. They
are not intended to be checked into this repository. If a token is ever printed
in logs, copied into an issue, or committed to Git, rotate it immediately.


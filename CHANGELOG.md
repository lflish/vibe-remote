# Changelog

All notable user-facing changes. The release workflow publishes the section
whose heading matches the pushed tag, so every release needs one here first.

## [Unreleased]

### Security
- The daemon no longer exposes its main token to the agent process.
  `VIBE_REMOTE_TOKEN` inside a session is now a per-session hook token that can
  only post events for that session.
- Desktop: machine tokens are encrypted with the macOS Keychain (`safeStorage`)
  and `machines.json` is written with `0600` permissions. Existing plaintext
  files are encrypted on first launch. Downgrading to 0.1.3 or earlier
  afterwards means re-entering every machine's token.
- Desktop: the window refuses navigation and new windows, so a dropped link can
  no longer load a page that sees the preload bridge.
- Daemon: HTTP header/idle timeouts, request body limits, and a small read
  limit on WebSocket frames until authentication succeeds.

### Fixed
- A dropped connection while creating a session no longer creates it twice.
  The client now picks the new session's id and replays it, so the daemon
  resumes the first attempt; in worktree mode this used to leave an orphaned
  worktree and `vibe/*` branch behind.
- The desktop app no longer reconnects forever to a session that is gone
  (deleted elsewhere, tmux killed): the daemon marks such errors fatal and the
  client stops, instead of retrying every 30s.
- Half-open connections (lid closed, network switched) are detected on both
  ends. The status bar no longer shows "connected" for a dead link, and the
  daemon releases the session's PTY instead of holding it indefinitely.
- REST calls time out after 8s, so an unreachable machine is marked offline
  instead of piling up hung requests every poll.
- "Retry now" during a session's creation sent nothing; it now replays the
  create.
- Every tmux session after the first inherited the first session's
  `VIBE_REMOTE_SESSION_ID`, so hook events were routed to the wrong session.
- Desktop: retrying while a connection was still being established could start
  a reconnect loop that dropped healthy connections every second or two.
- Daemon: binding an IPv6 address failed at listen time.
- Daemon: worktree sessions are now rejected if the worktree would land
  outside `allowed_roots`.

### Changed
- Protocol version 2 (`proto` in `ready` and `/api/v1/info`). The app warns
  when a machine runs an older daemon, which accepts requests but silently
  ignores newer fields. Update the daemon together with the app.
- Config validation is stricter: unknown keys, tokens shorter than 16
  characters, the example token, missing `allowed_roots`, and a
  `default_workdir` outside `allowed_roots` are now startup errors.
- `vibe-remoted --version`, and `/api/v1/info` reports `version`.
- Desktop defaults to English unless the system language is Chinese.

- Desktop: Electron 33 → 44 (33 no longer receives security fixes).
  **macOS 13 Ventura or later is now required.**
- Desktop: background-session "waiting" notifications are sent from the main
  process. Since Electron 42, macOS only delivers notifications for
  code-signed apps, so in the unsigned release DMGs the app bounces the Dock
  icon and shows a Dock badge instead (cleared when the window is focused).

### Added
- Prebuilt `vibe-remoted` binaries for Linux and macOS (amd64/arm64) are
  attached to releases, with `SHA256SUMS` and build provenance attestations.
- Example systemd user unit: `docs/deploy/vibe-remoted.service`.

## [0.1.3] - 2026-08-19

### Fixed
- Intel Macs are supported again: the release ships separate `-arm64` (Apple
  silicon) and `-x64` (Intel) DMGs. Previous releases contained an arm64-only
  build that would not launch on Intel hardware.

## [0.1.2] - 2026-08-18

### Fixed
- Terminal text is selectable and copyable again: drag to select, ⌘C to copy,
  ⌘V to paste. Mouse drags/clicks reach the remote app while ⌥ is held; the
  scroll wheel always does.
- Inline session rename is no longer overwritten by the 5s session poll, and
  falls back to the server's title if the rename fails.

## [0.1.1] - 2026-08-17

### Fixed
- First-launch terminal layout is measured only after the xterm host is
  visible, so a new terminal fills the window without a manual resize.

### Changed
- The repository is desktop-only: the mobile, web, shared-package, and portal
  trees were removed.

## [0.1.0] - 2026-08-12

First public release: macOS desktop client and Go daemon over PTY→tmux, with
session naming, background-session hints, reconnect UI, in-app machine
management, `claude_flags` presets, per-session reload, worktree sessions, and
Chinese/English UI.

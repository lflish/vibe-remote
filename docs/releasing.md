# Release checklist

## Before the first public release

- Publish from a repository history that contains no credentials, private
  network details, usernames, or personal filesystem paths.
- Rotate any token that has appeared in logs, local automation output, issues,
  or shared development artifacts.
- Confirm ignored local configs are not staged with `git status --ignored`.
- Enable GitHub private vulnerability reporting.

If an existing private repository history contains environment-specific data,
prefer creating the public repository from a reviewed squash of the current
tree instead of making the old history public.

## Current artifact scope

The current release contains two supported artifacts: the macOS Electron desktop DMG for arm64 (Apple silicon) and for x64 (Intel). Both are built from an Apple silicon machine via electron-builder cross-compilation. Mobile, web, and portal artifacts are not built or published from this repository.

The x64 DMG cannot be launch-tested on an Apple silicon build host — verification there is limited to confirming the architecture slices (`lipo -info` on the executable and on Electron Framework) and mounting the image. Confirm startup on real Intel hardware before relying on it.

## Build verification
```bash
cd vibe-remoted
go test ./...
go vet ./...
go test -race ./internal/session ./internal/server

cd ../desktop
npm ci
npm run typecheck
npm run test:preserved-notice
npm run test:attach-replay
npm run test:terminal-layout
npm run test:terminal-clipboard
npm run test:terminal-selection
npm run build
```

The desktop build currently produces an unsigned macOS DMG. State that clearly
in the release notes and document the expected Gatekeeper prompt.

## Versioning

1. Update `desktop/package.json` and `desktop/package-lock.json` to the release
   version.
2. Update user-facing release notes.
3. Commit the release changes.
4. Create an annotated tag such as `v0.1.1`.
5. Build artifacts from the tagged commit.
6. Publish SHA-256 checksums alongside downloadable artifacts.

Do not reuse tags or replace artifacts after publishing a release.


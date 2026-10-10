# Release checklist

Releases are tag-driven. Pushing `vX.Y.Z` runs `.github/workflows/release.yml`,
which re-runs CI, builds every artifact from the tagged commit, checksums and
attests them, and opens a **draft** GitHub release. Nothing is public until a
maintainer reviews and publishes the draft.

## Artifacts

| File | Built on | Notes |
|---|---|---|
| `vibe-remote-X.Y.Z-arm64.dmg` | macos-latest | Apple silicon |
| `vibe-remote-X.Y.Z-x64.dmg` | macos-latest (cross) | Intel |
| `vibe-remoted-vX.Y.Z-{linux,darwin}-{amd64,arm64}` | ubuntu-latest | static (`CGO_ENABLED=0`), version via `-ldflags` |
| `SHA256SUMS` | — | covers every file above |

Every artifact also gets a GitHub build provenance attestation
(`gh attestation verify <file> --repo lflish/vibe-remote`).

The DMGs are unsigned. The x64 DMG is cross-built on Apple silicon and cannot
be launch-tested there; confirm startup on real Intel hardware when the
packaging setup changes.

## Steps

1. Make sure `main` is green and `make check` passes locally.
2. Move the `## [Unreleased]` entries in `CHANGELOG.md` under a new
   `## [X.Y.Z] - YYYY-MM-DD` heading. The workflow fails if this heading is
   missing, because it becomes the release notes.
3. Bump the version: `cd desktop && npm version X.Y.Z --no-git-tag-version`
   (updates `package.json` and `package-lock.json`). The workflow fails if the
   tag and `package.json` disagree.
4. `main` is protected (PR + the four CI checks required, no direct pushes),
   so the release commit goes through a PR: commit `release: prepare vX.Y.Z`
   on a `release/vX.Y.Z` branch, open a PR, and merge it once CI is green.
   Then tag the merged commit on `main` and push only the tag:
   `git checkout main && git pull && git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.
5. Wait for the Release workflow, open the draft release, check the notes and
   the asset list, then publish it.

Do not reuse tags or replace artifacts after publishing a release. If a release
is broken, fix forward with a new patch version.

## Signing (not yet enabled)

`release.yml` sets `CSC_IDENTITY_AUTO_DISCOVERY=false`. To sign and notarize,
add `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`
and `APPLE_TEAM_ID` as repository secrets, pass them to the desktop build step,
and enable `hardenedRuntime` / `notarize` in the electron-builder config.

## Repository hygiene

- Never commit tokens, `machines.json`, personal paths, or private network
  details. Rotate any token that has appeared in logs, issues, or artifacts.
- Confirm ignored local configs are not staged: `git status --ignored`.
- Keep GitHub private vulnerability reporting enabled.

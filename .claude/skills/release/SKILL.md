---
name: release
description: Prepare and cut a vibe-remote release following docs/releasing.md — CHANGELOG section, version bump, tag, then watch the tag-driven Release workflow and review the draft release. Usage — /release <X.Y.Z>
disable-model-invocation: true
---

# release

Follows `docs/releasing.md`; read it first, it wins if this file disagrees.
Pushing a tag and publishing a release are outward-facing: confirm with the
user before step 4 and before step 6.

Argument: `$ARGUMENTS` = the version without `v` (e.g. `0.2.0`).

1. **Preconditions**: on `main`, clean tree (`git status --porcelain` empty),
   up to date with `origin/main`, latest CI on `main` green
   (`gh run list --branch main --workflow CI --limit 1`), and `make check` passes.
2. **CHANGELOG**: move everything under `## [Unreleased]` into a new
   `## [X.Y.Z] - <today>` section and leave an empty `## [Unreleased]` above it.
   If Unreleased is empty, stop — there is nothing to release. Show the user the
   section; it becomes the release notes verbatim.
3. **Version**: on a new `release/vX.Y.Z` branch, run
   `cd desktop && npm version X.Y.Z --no-git-tag-version`, then commit
   `CHANGELOG.md`, `desktop/package.json`, `desktop/package-lock.json` as
   `release: prepare vX.Y.Z`. `main` is protected — direct pushes are rejected —
   so push the branch, `gh pr create`, wait for the four required checks, and
   merge it (after user confirmation).
4. **Tag** the merged commit (after user confirmation):
   `git checkout main && git pull && git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.
5. **Watch**: find the run with `gh run list --workflow Release --limit 1` and
   follow it with `gh run watch <id> --exit-status`. On failure, show the failing
   job's log (`gh run view <id> --log-failed`). Never delete or move a pushed
   tag to retry — fix forward with the next patch version.
6. **Review the draft**: `gh release view vX.Y.Z --json isDraft,assets,body`.
   Expect 2 DMGs, 4 daemon binaries, and `SHA256SUMS`. Summarize for the user;
   publish (`gh release edit vX.Y.Z --draft=false`) only after they confirm.

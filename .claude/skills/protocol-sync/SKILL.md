---
name: protocol-sync
description: Cross-check that the WebSocket/REST protocol is identical across vibe-remoted/internal/protocol/protocol.go, desktop/src/shared/protocol.ts (plus desktop/src/renderer/rest.ts) and docs/protocol.md. Use whenever a frame type, frame field, REST endpoint, or event kind is added, renamed, or removed, and before merging any change that touches one of those files.
---

# protocol-sync

There is no code generation: the Go and TypeScript definitions are kept aligned
by hand, and `docs/protocol.md` is the declared source of truth. Drift here
breaks old/new client–daemon pairs silently.

## Procedure

1. Read all three in full:
   - `vibe-remoted/internal/protocol/protocol.go`
   - `desktop/src/shared/protocol.ts` and the REST types in `desktop/src/renderer/rest.ts`
   - `docs/protocol.md`
2. Build a table, one row per frame type / endpoint:

   | name | Go type + json tags | TS type + fields | documented fields | match? |

   Compare: the `type` string constant, every field's **JSON name** (Go
   `json:"..."` tag vs TS property), optionality (`omitempty` ↔ `?`), and value
   types (base64 strings, numeric widths, enums such as `mode`).
3. For REST, also compare `routes()` in `vibe-remoted/internal/server/server.go`
   with the endpoint table in `docs/protocol.md` and the calls in `rest.ts`:
   method, path, auth requirement, request body and response shape.
4. Chat UI (v3) — include these rows as well:
   - S→C frames `chat`, `chat_sync`, `chat_state` (and nested `PendingRequest`,
     `ChatEnded`, `SlashCommand`), `chat_ack`; C→S frames `chat_send`,
     `chat_respond` (`ChatResponse`), `chat_interrupt`, `chat_set_mode`.
   - New fields on `attach` (`ui`, `epoch`, `since`, `handoffFrom`), `ready`
     (`ui`, `claudeSessionId`, `existing`, `handoffFrom`) and `sessions[]`
     (`ui`, `state`, `activitySeq`, `epoch`, `endReason`).
   - Open sets, listed in all three places: error codes (`ui_mismatch`,
     `chat_unsupported`, `claude_session_busy` are fatal), `chat_ack` codes
     (compare with the `Ack*` constants and what `internal/chat/session.go`
     actually returns), `vr_*` message types, `vr_resolved` outcomes,
     `vr_notice` codes, `ended.reason`, `chat.reason`, `chatTrust` values.
   - REST: `/api/v1/info.chat` and `?recheck=1`, `/api/v1/fs` `chatTrust`,
     reload 202 / 409 `claude_session_busy` body for chat sessions.
   - The version table row for 3.
5. Projects and worktrees (v4) — include these rows as well. v4 adds no S→C
   frame and no field to an existing one; `TestTerminalFramesUnchangedV3` must
   still pass untouched.
   - `attach.worktreeName` (optional; only with `mode:"worktree"` on create).
   - REST types, field by field including which are optional: `Project`,
     `ProjectWorktree`, `WorktreePlan` (and its `WorktreeBase`),
     `WorktreeStatus`, `WorktreeRemoveRequest`, `WorktreeRemoveResult`.
     Arrays that are documented as always present (`projects[].worktrees`,
     `.sessions`, `status.sessions`, `endedSessions`) must not be `omitempty`.
   - The five endpoints — method, path, query or body, and every error code:
     - `GET /api/v1/projects` (404 on an older daemon is how the desktop
       detects it).
     - `POST /api/v1/projects/remove`: 204, 404 `project_not_found`, 409
       `project_has_sessions`.
     - `GET /api/v1/worktrees/plan`: `ok:false` reasons `not_git`,
       `unsupported_repo`, `invalid_worktree_name`, `worktree_branch_exists`,
       `worktree_path_exists`, `worktree_path_not_allowed`; the optional
       `conflict` (only with `worktree_branch_exists`); HTTP 400
       `invalid_request`, 403, 500 `git_failed`.
     - `GET /api/v1/worktrees/status`: `ignoredFiles` (always present, `-1` =
       not counted); 400 `invalid_request`, 404 `worktree_not_found`, 500
       `git_failed`.
     - `POST /api/v1/worktrees/remove`: 200 with `removed`, `branchDeleted`,
       optional `branchError`, `endedSessions`; 400 `worktree_is_main`; 404
       `worktree_not_found`; 409 `worktree_changed` with `status` and
       `endedSessions`; 500 `worktree_remove_failed` with `endedSessions` —
       both of its sources are documented (refused before any session was
       ended: locked, submodule or embedded-repository checkout, nested
       worktree, with `endedSessions: []`; and failures after sessions were
       ended); 500 `git_failed` with `endedSessions: []`.
   - `DELETE /api/v1/sessions/{id}`: a v4 daemon never answers 409
     `worktree_preserved`; the desktop still handles that body for v3 daemons.
   - `/api/v1/fs` `chatTrust`: the worktree rule is described the same way in
     the doc and in `rest.ts`.
   - The four new `error` frame codes (`invalid_worktree_name`,
     `worktree_branch_exists`, `worktree_path_exists`,
     `worktree_path_not_allowed`) are all fatal, in the Go constants, the TS
     list and the doc.
   - The version table row for 4, `Version` / `PROTOCOL_VERSION` = 4, and
     `CHAT_MIN_PROTO` = 3 (chat availability is gated on it, not on
     `PROTOCOL_VERSION`).
   - The "版本互连" section of the doc still matches what the desktop does
     against a v3 daemon (`tree.ts` legacy grouping, greyed-out entries).
6. Report mismatches as a list, each with the file:line on both sides and which
   side is wrong (the doc wins unless the change being reviewed intentionally
   updates it).
7. Only edit files if the user asked for fixes. When fixing, update all three
   in the same change.

## Compatibility rules to check

- New fields must be optional on the receiving side (`omitempty` / `?`) so an
  older peer still parses frames.
- Unknown frame types and unknown `notify.kind` values must be ignored, not
  treated as errors, on both sides.
- Never reuse a removed field name with a different meaning.

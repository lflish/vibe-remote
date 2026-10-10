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
4. Report mismatches as a list, each with the file:line on both sides and which
   side is wrong (the doc wins unless the change being reviewed intentionally
   updates it).
5. Only edit files if the user asked for fixes. When fixing, update all three
   in the same change.

## Compatibility rules to check

- New fields must be optional on the receiving side (`omitempty` / `?`) so an
  older peer still parses frames.
- Unknown frame types and unknown `notify.kind` values must be ignored, not
  treated as errors, on both sides.
- Never reuse a removed field name with a different meaning.

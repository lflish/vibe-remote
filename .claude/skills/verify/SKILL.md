---
name: verify
description: End-to-end smoke test of the real client↔daemon path on this Mac, without a remote machine — starts a throwaway vibe-remoted (tmux + /bin/bash) and drives it over the actual WebSocket/REST protocol (auth, attach, PTY round-trip, hook env/token, events→notify, per-session env isolation, delete), plus a chat-session smoke against a throwaway daemon running the fake claude, and the GUI acceptance scripts (chat sessions; projects and worktrees in the sidebar, creating and deleting worktrees, the switching keys, the M1 look). Use after changing vibe-remoted, the protocol, or desktop code, before claiming the change works.
---

# verify

Unit tests cover seams; this proves the assembled daemon behaves. The CLI is
`/bin/bash` because byte passthrough does not care what runs.

## 0. Rules for everything below

- **Every command that can start tmux gets its own `TMUX_TMPDIR`**: `go test`,
  `make check`, a daemon started by hand, `gui-smoke.mjs`, `gui-chat-smoke.mjs`,
  `ws-smoke.mjs`'s daemon. vibe-remoted's sessions live on `tmux -L vibe-remote`
  in `$TMUX_TMPDIR` (default `/tmp/tmux-<uid>/`); a daemon started without the
  variable shares that server with whatever vibe-remoted the user is running.
  Write it as `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) <command>` (a short path:
  macOS caps socket paths at ~104 bytes). Never run a tmux command against the
  default socket directory, not even `tmux -L vibe-remote ls`.
  `gui-worktree-smoke.mjs`, `ws-worktree-smoke.mjs` and `ws-chat-smoke.mjs` set
  a directory of their own for every process they start, whatever the caller's
  environment says; the other scripts rely on the caller.
- **Never the daemon the user runs** (usually 127.0.0.1:8765), their
  `machines.json`, keychain, `~/.claude.json` or installed app. Random ports,
  temp configs, temp `state_dir`, temp `CLAUDE_CONFIG_DIR`, temp userData,
  `--use-mock-keychain`.
- **Every daemon and every `go test` / `make check` gets a claude config
  directory that is not the user's.** vibe-remoted reads claude's trust file
  (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`) whenever a
  directory is listed for the picker, also when it runs `/bin/bash`, and a
  continue (`-c`) session reads `…/projects`. The GUI and ws scripts give each
  daemon they start a directory of the run; for a daemon started by hand, and
  for `go test` and `make check` (some server tests list directories), add
  `CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/vr-cc-XXXXXX)` next to `TMUX_TMPDIR`.
- **`allowed_roots` of a throwaway daemon are directories you created under
  `/tmp`.** Since protocol 4 the daemon deletes worktree directories and
  branches inside its allowed roots; a test daemon must not be able to reach a
  real repository. Test repositories are built in the temp directory too.
- Only stop processes you started (keep the pid, or let the script do it).
- A token never goes into a reply, a log you keep, or a screenshot.

## 1. Start a throwaway daemon

A random port, a temp config and a tmux socket directory of its own:

```bash
PORT=$((20000 + RANDOM % 10000))
CFG=$(mktemp -t vr-verify).json
TOKEN=$(openssl rand -hex 32)
export TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX)
export CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/vr-cc-XXXXXX)
sed -e "s/8765/$PORT/" -e "s/local-development-only/$TOKEN/" vibe-remoted.tmux.json > "$CFG"
(cd vibe-remoted && go run ./cmd/vibe-remoted --config "$CFG") > /tmp/vr-verify.log 2>&1 &
```

Run the `go run` in the background (Bash `run_in_background`), then poll
`curl -sf http://127.0.0.1:$PORT/healthz` until it answers (~10s max). If it
never does, read `/tmp/vr-verify.log` — a config validation error is the usual
cause. (`vibe-remoted.tmux.json` allows `/tmp`: fine for the byte round-trip of
step 2; for anything that creates or deletes worktrees use the scripts of the
"Projects and worktrees" section, which build their own roots.)

## 2. Drive the protocol

```bash
VR_TOKEN=$TOKEN node .claude/skills/verify/scripts/ws-smoke.mjs 127.0.0.1:$PORT /tmp
```

Each line is `PASS`/`FAIL`; exit code is non-zero on any failure. Never print
`$TOKEN` in your reply.

### Chat sessions (protocol v3)

Chat mode only runs claude, so `/bin/bash` can't stand in. `ws-chat-smoke.mjs`
needs no daemon from step 1: it builds vibe-remoted and the fake claude
(`vibe-remoted/internal/chat/fakeclaude`), starts its own daemon with
`claude_cmd` pointing at the fake, its own `state_dir`, `CLAUDE_CONFIG_DIR`
(with a workspace-trust file for its temp folders) and tmux server
(`TMUX_TMPDIR`), and removes all of it afterwards:

```bash
node .claude/skills/verify/scripts/ws-chat-smoke.mjs
```

Cases: `chat: create`, `chat: replay before ready`, `chat: two clients`,
`chat: pending survives reconnect`, `chat: resync 50`, `chat: handoff`,
`chat: daemon restart → ended`, `chat: state without hooks`,
`chat: delete keeps jsonl`. Same PASS/FAIL output and exit code.

## 3. GUI (when desktop code, Electron, xterm or clipboard changed)

`ws-smoke.mjs` covers the wire protocol, not the app. For the desktop, run the
CDP-driven GUI regression (macOS, needs a display; ~1 min). It starts its own
daemon and launches the built app with a throwaway userData dir and
`--use-mock-keychain`, so steps 1/2/4 here are not needed for it. Its terminal
daemon inherits the environment: give it a tmux socket directory (rule 0):

```bash
TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-smoke.mjs          # builds desktop/dist first
TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-smoke.mjs --keep   # leave the app open afterwards
```

It checks:
- legacy `machines.json` gets encrypted on launch;
- new session via the picker, and the terminal fills its container;
- typing echoes;
- drag-select works under remote mouse reporting, and ⌘C copies;
- ⌘V pastes;
- navigation and `window.open` are blocked;
- a hook event raises a desktop notification (it reports `shown` or `fallback`);
- after a daemon restart the client reconnects and the session still works;
- the three-level sidebar is readable at the default width and at 800×500
  (row menus, the toolbar title under a long branch, the note under "continue");
- the session-switching keys (⌘1–9, ⌘⇧[, ⌘⇧]) from a terminal and from the chat
  input;
- chat (a second throwaway daemon running the fake claude, listed as a second
  machine): `chat session created via picker`, `chat reply rendered`,
  `permission allow once resumes`.

The terminal cases stay on the `/bin/bash` daemon.

### Chat acceptance cases (GUI)

`gui-chat-smoke.mjs` is the browser half of the chat acceptance scenarios
(the `R…` ids of docs/changes/2026-11-13-dual-mode/spec.md). Same launch
model as gui-smoke (built app, throwaway userData, `--use-mock-keychain`,
~1 min), with five throwaway machines: `/bin/bash`, fake claude (with `-c`
and `--dangerously-skip-permissions` as `claude_flags`), fake claude
reporting 1.0.51, fake claude whose `system/init` says 1.0.0, and a daemon
built from the `main` branch (protocol 2; built through a temporary
`git worktree`, or pass `VR_MAIN_DAEMON=<binary>`). The app is forced to the
zh locale; assertions use the zh strings.

```bash
TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-chat-smoke.mjs   # builds desktop/dist first
DEVFLOW_EVIDENCE_DIR=docs/changes/<change>/evidence node …/gui-chat-smoke.mjs --no-build   # + one PNG per case
VR_CDP_PORT=39222 VR_INSPECT_PORT=49229 node …/gui-chat-smoke.mjs --keep   # leave it running to poke around
```

Cases: picker 界面 (R1.1 default terminal, R1.3 not claude, R1.4 claude too
old, R17.2 old daemon + terminal on it), `-c` with a 3000-line history in a
300-message window (R1.5), bypass locked (R1.6/R11.2), Markdown + copy
(R3.2), raw HTML / `javascript:` / links via `open-external` (R3.3), tool
blocks + diff (R4), answer lost before reaching the daemon (R5.6), answered
elsewhere first (R5.7), plan review (R6), AskUserQuestion (R7), Esc / stop
(R8), queue (R9), slash menu + terminal-only commands (R10), mode switcher
(R11.1), offline while 500 messages arrive → divider, render ≤2000 ms
(R12/R12.2), turn error + retry (R13.1), background prompt → yellow dot,
Dock fallback, notification click (R16.3), claude exits → restart (R13.2),
handoff while running (R14.2), init version too old (R13.4).

Cases driven with real input events (CDP `Input.dispatchMouseEvent` wheel /
press / release with `clickCount`, `insertText`, key events — not
`element.click()` or setting `scrollTop`), each on sessions of its own:
`X7-send` (scrolled up with the wheel → a typed message and its reply show,
replies do not drag the view, the bottom has them), `X7-background` (more than
a screen arrives while another session is open → back at the bottom; left
scrolled up → same place), `X8-chat` / `X8-terminal` (double click on the
sidebar name of an open session, current and background → renamed, nothing
typed into the session, sidebar still updates), `X10-prompt` (a background
session asks for permission → real click on its sidebar name → `1` answers,
Esc interrupts, the next message is typed, all without clicking the card or
the input), `X10-rename-chat` / `X10-rename-terminal` (after a rename ended by
Enter, Esc, or a click on another session, the next keys go into the current
session without a click), `X6` (current session, app
really hidden → yellow dot + notification, cleared on focus). A double click
in these cases is one real double click, made once and never repeated: the
sidebar list is rebuilt only when what it shows has changed, so a refresh that
brings nothing new no longer takes a row out from under the pointer. A `NOTE`
line is what a case prints about the state of the page when something it is
about to assert looks wrong (`X7-send`: the scroll position; `M.X7` of
gui-worktree-smoke: where the focus went); list the `NOTE` lines of a run when
reporting it. `VR_ONLY=<ids>`
runs a subset, e.g. `VR_ONLY=X7-send,X7-background,X8-chat,X8-terminal`,
`VR_ONLY=X10-prompt,X10-rename-chat,X10-rename-terminal` or
`VR_ONLY=S1,X6` (cases after `S1` need the main chat session it creates).

How it fakes things (so failures can be read): network faults are a wrapped
`WebSocket` in the renderer (`window.__vrNet`: hold incoming frames, drop
outgoing ones, close a socket, refuse new connections); the "other desktop"
is a plain WebSocket client in the script; the main process is driven over
`--inspect` (Dock badge, `app.hide()`, a stubbed `shell.openExternal` so no
real browser opens, a simulated `notification-click`). Unsigned builds never
show a native notification (Dock fallback), so a real notification click is
not covered.

### Projects and worktrees (protocol 4)

What the feature is, where a user reaches it, and how the scripts operate it
(`docs/changes/2026-11-16-project-worktrees/spec.md` has the scenarios, R1–R9):

| Feature | Where | How to operate / what proves it |
|---------|-------|---------------------------------|
| Sidebar: machine → project → worktree → session | `#machine-list`: `.machine-group` > `.project-group[data-project-id]` (`[data-testid=project-row]`, `project-branch`, `project-error`, `project-dot`) > `.worktree-group[data-path]` (`worktree-row`, tags `worktree-tag-main` / `worktree-tag-external` / `worktree-removing`, `worktree-empty`) > `.session-item[data-session-id][data-ui][data-dot]` | Find rows by the names shown (`.project-name`, `.worktree-label`, `.session-label-text`); compare with `GET /api/v1/projects` and with `git worktree list` on disk. A one-worktree or non-git project has no worktree rows. The app's 5 s poll can be asked for directly in the scripts (`window.__vrPoll()`) |
| New named worktree | project row → `project-new-worktree` → dialog `new-worktree-dialog` (`wt-name-input`, `wt-name-error`, `wt-base-info`, `wt-target-path`, `dialog-confirm`); machine overview → "创建隔离 Worktree" → the picker with the same name field | Type with `Input.insertText`; wait for an error or a target path; after confirming read the disk: `refs/heads/<name>`, `<repo>-worktrees/<name with / → ->`, `git worktree list` |
| New session in an existing worktree | worktree row → `worktree-new-session` (or `worktree-empty-new-session`, `project-new-session` on a flat project) → dialog `worktree-session-dialog` (`session-dialog-path`, `picker-ui-terminal` / `picker-ui-chat` + `picker-ui-chat-reason`, launch options, `continue-note`) | The chat card's state is final only once both `/api/v1/info` and `/api/v1/fs` have answered. Chat trust comes from the daemon's `CLAUDE_CONFIG_DIR/.claude.json` |
| Delete a session | session row → `.session-close` → dialog `delete-session-dialog` (`delete-session-note`), focus on `dialog-cancel` | Afterwards the worktree row says "没有会话"; directory, branch and commits are still on disk |
| Delete a worktree | worktree row → `worktree-menu` → `worktree-delete` → dialog `delete-wt-dialog[data-variant=clean|files|commits|detached|external]` (`delete-wt-files`, `-commits`, `-sessions`, `-external`, `-ignored`, `-error`, `-ended`, `-changed`, radios `delete-wt-keep-branch` / `delete-wt-delete-branch`, `delete-wt-force`); a half-finished removal ends in `delete-wt-failed` (`delete-wt-partial`) | **Always read the disk afterwards**: the directory, `git worktree list`, the branch, and whether the commits are still on a branch. The main row has no menu |
| Remove a project from the sidebar | project row → `project-menu` → `project-remove` (disabled with a note while the project has sessions) | The daemon's list (`/api/v1/projects`) loses it; nothing on disk changes |
| Switching keys | ⌘1–⌘9, ⌘⇧[ / ⌘⇧] | `Input.dispatchKeyEvent` to the app's page (never keys to the system). Listeners added on window/document show whether the key was taken (prevented, not delivered) |
| Old daemon / old desktop | a machine whose daemon is built from the commit before the change | `machine-legacy-note`, the two entries disabled with a reason, the picker without a name field; `ws-smoke.mjs` of that commit against a new daemon |

`gui-worktree-smoke.mjs` runs all of it against the built app (same launch
model as the other two GUI scripts, ~3 min, 73 cases: 62 named by scenario, five
found by using the app by hand — X1.redraw, X2.rename, X3.keys, X6.scroll,
X8.menu — four that repeat what the chat sessions' rework fixed on session
rows *under a worktree row* (gui-chat-smoke.mjs has them on rows under a
project row): `M.X8` (double click renames a chat and a terminal session, the
next keys go into the session), `M.X10` (yellow dot → real click → `1` answers
the card), `M.X6` (window in the background → yellow dot on the session
shown), `M.X7` (back at the bottom after a burst in the background) —
`--only=M` runs the four — and `T34.quiet`: nothing under `#machine-list` is
changed across two polls of all five machines that bring nothing new (counted
by a `MutationObserver`), and with a poll asked for every 150 ms 20 real clicks
(button held 60 ms) switch the session and 10 real double clicks start a
rename, none lost; and `T35.overview`: with the machine overview shown and
nothing changing, the page is redrawn at most once per answer about the
sessions — not for the answers about the project tree — over two polls):

```bash
node .claude/skills/verify/scripts/gui-worktree-smoke.mjs                 # builds desktop/dist and the daemons first
node …/gui-worktree-smoke.mjs --no-build --only=R5,R3.7                   # some cases (a requirement, or one scenario)
node …/gui-worktree-smoke.mjs --list
DEVFLOW_EVIDENCE_DIR=docs/changes/<change>/evidence node …/gui-worktree-smoke.mjs --no-build   # + one PNG per case
VR_BASE_DAEMON=<binary> node …      # reuse a build of the previous protocol (default: built from commit VR_BASE_REF through a temporary git worktree)
VR_CDP_PORT=39222 VR_INSPECT_PORT=49229 node … --keep                     # leave it running to poke around
node …/gui-worktree-smoke.mjs --no-build --with-existing --only=R8.3      # R8.3 also runs gui-smoke.mjs and gui-chat-smoke.mjs
```

It needs no `TMUX_TMPDIR` from the caller: it makes one directory in `/tmp`
(`vr-wt-*`), sets `TMUX_TMPDIR` inside it for itself and gives every daemon a
socket directory of its own there. Machines: `this-mac` (the spec's example:
devflow with four worktrees, new-api, notes), `lab-mac` (repositories the cases
change), `keep-mac` (/bin/bash; its git is a wrapper that fails `worktree
remove` while a flag file exists; restarted by R2.2), `narrow-mac`
(`allowed_roots` is one repository), `old-mac` (protocol 3). `this-mac` and
`lab-mac` run a two-line `claude` wrapper: the fake claude for chat sessions,
`/bin/bash` for terminal sessions, so one daemon has both kinds.

Most cases click through the DOM (`click()` calls the element's own click()),
which is fast and blind to three things: what the pointer hovers, what lies
over the element, and what a double click really sends. The X cases use
`pointerClick()` / `pointerOver()` (`Input.dispatchMouseEvent`: the pointer
moves there first, `count: 2` is click, click, dblclick) and real key events.
Use those for anything about hover-revealed buttons, menus, double clicks and
focus — a sidebar row is rebuilt whenever something the sidebar shows changes,
and a rebuilt row is neither hovered nor focused. A refresh that brings
nothing the sidebar shows leaves the list alone: a case about what a rebuild
does has to change something first (X11.menu and X8.menu rename a session over
REST, as another desktop would).

How it fakes things: `window.__vrNet` (installed before the app's code) cuts a
connection between the daemon's `ready` and the desktop (R3.7), refuses new
connections, delays one REST path (the "being deleted" row), records attach
frames and the bytes sent to a PTY; the main process is paused at its first
statement (`--inspect-brk`) to record the window's background and the first
painted frame (R8.6); colors are read from screenshots (`png-pixels.mjs`) and
dialogs are measured in an emulated 800×500 window (`dialog-layout.mjs`, next
to `shell-layout.mjs` / `sidebar-layout.mjs`). The app is forced to zh; R8.5
switches to en and back with the language button.

`VR_DESKTOP_DIR=<dir>` / `VR_DAEMON=<binary>` run the same cases against
another build. Use them to check that a case can fail: copy `desktop/` to a
temp directory, put a defect into the copy, `npx vite build` there, and the
case that covers it has to FAIL.

`ws-worktree-smoke.mjs` is the half without a window: creating and deleting
worktrees over REST/WebSocket in the environments where the daemon has the
hardest time knowing which sessions run — a fresh tmux socket directory, no
tmux program on PATH, a server that has exited, the socket file removed while
the server runs (and SIGUSR1 to that server), no tmux program but a socket, a
tmux session left by an older vibe-remoted — in repositories whose main
directory git does not name (a submodule, `--separate-git-dir`), and with
whatever git it is given (9 cases, ~15 s):

```bash
node .claude/skills/verify/scripts/ws-worktree-smoke.mjs
VR_GIT=<prefix>/bin/git node …/ws-worktree-smoke.mjs      # e.g. a git older than 2.31, installed under a temp prefix
```

(An old git has to be *installed* under its prefix — `make prefix=<dir> install`
— not run from its build directory: without its exec-path it finds `git` for
its own child processes through PATH.)

None of the scripts covers: real key presses going through the macOS menu and
input method (CDP keys do not), packaged-build-only behaviour (notifications
differ because unsigned builds use the Dock fallback; the traffic lights'
position) — check those by hand in `release/mac-*/vibe-remote.app` after
`npm run build -- --dir`.

### Logs

The daemons log to stderr; the GUI scripts keep it and write it with Electron's
output to the file named by `VR_GUI_LOG=<file>` (gui-chat-smoke, gui-worktree-smoke).
A failing case of gui-worktree-smoke saves `<case>-FAIL.png` when
`DEVFLOW_EVIDENCE_DIR` is set. Lines that mean trouble in a daemon log:
`could not read the running sessions from tmux`, `projects store: write failed`,
`worktree`-prefixed errors with `exit status`.

## 4. Clean up — always, even on failure

```bash
kill %1 2>/dev/null || pkill -f "vibe-remoted --config $CFG"
# The tmux server of step 1 only. The shell of a later tool call no longer has
# the variable: write the directory out, and never run this line without it —
# with no TMUX_TMPDIR it would stop the user's own vibe-remote sessions.
case "$TMUX_TMPDIR" in /tmp/vr-*|/private/tmp/vr-*) tmux -L vibe-remote kill-server 2>/dev/null; rm -rf "$TMUX_TMPDIR";; *) echo "TMUX_TMPDIR is not the directory of step 1: nothing stopped";; esac
rm -f "$CFG" /tmp/vr-verify.log
```

The scripts clean up after themselves (daemons, tmux servers under their own
socket directories, temp repositories, the temporary `git worktree` of an older
commit). After an interrupted run look for leftovers by name: `/tmp/vr-wt-*`,
`/tmp/vr-wr-*`, `/tmp/vr-gc-*`, `/tmp/vr-chat-*`, and `git worktree list` for an
entry under `/tmp`.

## Report

State which steps ran, paste the PASS/FAIL lines, and say explicitly what was
not covered (e.g. "GUI not exercised"). For anything that deletes — a session, a
worktree, a branch — say what was read back from disk, not only what the window
showed.

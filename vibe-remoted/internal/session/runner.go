// Package session manages PTY→tmux→claude sessions.
package session

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// tmuxSocket is the dedicated tmux server socket name for vibe-remote.
// Using a separate server isolates vibe-remote sessions from the user's own tmux,
// lets us disable the status bar globally (so claude gets full PTY height),
// and makes cleanup safe.
const tmuxSocket = "vibe-remote"

var ErrReloadRequiresTmux = errors.New("session reload requires tmux mode")

// tmuxCmd builds a tmux command on the dedicated vibe-remote socket. The env
// goes through utf8Env because tmux mangles its own output without a UTF-8
// locale — see utf8Env for why that matters here.
func tmuxCmd(args ...string) *exec.Cmd {
	cmd := exec.Command("tmux", append([]string{"-L", tmuxSocket}, args...)...)
	cmd.Env = utf8Env()
	return cmd
}

// tmuxSocketPath is where `tmux -L vibe-remote` puts its socket for this
// process: <dir>/tmux-<uid>/vibe-remote, where <dir> is TMUX_TMPDIR when that
// is set and not empty, and /tmp otherwise (tmux's TMUX_SOCK search path,
// "$TMUX_TMPDIR:/tmp/"). tmuxCmd passes the daemon's own TMUX_TMPDIR on, so
// this is the path its tmux commands use. It is only ever looked at (os.Stat),
// never created, removed or connected to from here.
func tmuxSocketPath() string {
	dir := os.Getenv("TMUX_TMPDIR")
	if dir == "" {
		dir = "/tmp"
	}
	return filepath.Join(dir, fmt.Sprintf("tmux-%d", os.Getuid()), tmuxSocket)
}

// utf8Env returns the process environment with a UTF-8 locale guaranteed.
//
// tmux decides whether it is in UTF-8 mode from LC_ALL/LC_CTYPE/LANG. With none
// set it assumes non-UTF-8 and rewrites every byte it deems unprintable as "_",
// which corrupts two things at once: the tab delimiters in our `-F` format
// strings (breaking list-sessions parsing) and the box-drawing/CJK bytes in the
// attached PTY stream (breaking the byte-passthrough guarantee). launchd-started
// daemons inherit no locale at all, so this is the default path in production.
//
// An inherited locale is left untouched — the user's own setting wins.
//
// The daemon's main token variable (chat.MainTokenEnv) is never passed on:
// main unsets it at startup, and this filter keeps it out of every terminal
// session, tmux server and chat process even if it is set again.
func utf8Env(extra ...string) []string {
	var env []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, chat.MainTokenEnv+"=") {
			env = append(env, kv)
		}
	}
	env = append(env, extra...)
	if os.Getenv("LC_ALL") == "" && os.Getenv("LC_CTYPE") == "" && os.Getenv("LANG") == "" {
		env = append(env, "LC_CTYPE=UTF-8")
	}
	return env
}

// tmuxSessionInfo captures the per-session fields vibe-remote needs from a single
// `tmux list-sessions` query: the working directory and the user-set display
// name (@vibe_remote_name, empty when unset).
type tmuxSessionInfo struct {
	workdir       string
	name          string
	mode          string
	sourceWorkdir string
	sourceRepo    string
	worktreeRoot  string
	branch        string
	// claudeU is @vibe_remote_claude_u: the claude conversation this terminal
	// session holds (handed off from a chat session, or started with -c).
	claudeU string
	// project and home are the session's attribution (@vibe_remote_project,
	// @vibe_remote_home); created/sessionCreated recover its creation time
	// (@vibe_remote_created as RFC 3339 nanos, then tmux's session_created).
	project        string
	home           string
	created        string
	sessionCreated string
	// startDir is @vibe_remote_workdir: the directory the session was started
	// in. workdir above is where its process is now (pane_current_path). Empty
	// for a session started before the option existed.
	startDir string
}

func parseTmuxSessionLine(line string) (tmuxSessionInfo, bool) {
	// Eight columns is the format before @vibe_remote_claude_u was added; nine
	// adds it; thirteen adds project/home/created/session_created (design 5.1);
	// fourteen adds the start directory (@vibe_remote_workdir).
	parts := strings.SplitN(line, "\t", 14)
	if (len(parts) != 8 && len(parts) != 9 && len(parts) != 13 && len(parts) != 14) || !strings.HasPrefix(parts[0], "vibe-remote-") || strings.TrimPrefix(parts[0], "vibe-remote-") == "" {
		return tmuxSessionInfo{}, false
	}
	info := tmuxSessionInfo{}
	if len(parts) > 1 {
		info.workdir = parts[1]
	}
	if len(parts) > 2 {
		info.name = strings.TrimSpace(parts[2])
	}
	if len(parts) > 3 {
		info.mode = parts[3]
	}
	if len(parts) > 4 {
		info.sourceWorkdir = parts[4]
	}
	if len(parts) > 5 {
		info.sourceRepo = parts[5]
	}
	if len(parts) > 6 {
		info.worktreeRoot = parts[6]
	}
	if len(parts) > 7 {
		info.branch = parts[7]
	}
	if len(parts) > 8 {
		info.claudeU = strings.TrimSpace(parts[8])
	}
	if len(parts) > 12 {
		info.project = parts[9]
		info.home = parts[10]
		info.created = strings.TrimSpace(parts[11])
		info.sessionCreated = strings.TrimSpace(parts[12])
	}
	if len(parts) > 13 {
		info.startDir = parts[13]
	}
	return info, true
}

// isNoTmuxServer reports whether tmux's stderr means "there is nothing running"
// (an honest empty set) rather than "the query failed". tmux prints
// "no server running on <socket>" for the former and "error connecting to
// <socket> (...)" for the latter, both with a non-zero exit. A socket file that
// is not there also gets the second message, whether no server was ever started
// or a running server lost its file; readTmuxSessions tells those apart without
// reading the message.
func isNoTmuxServer(stderr []byte) bool {
	msg := strings.ToLower(string(stderr))
	return strings.Contains(msg, "no server running") ||
		strings.Contains(msg, "no sessions")
}

// tmuxSocketGone reports whether the socket file of the vibe-remote tmux
// server does not exist. A file that is there, and one that could not be
// looked at, are both "not gone".
func tmuxSocketGone() bool {
	_, err := os.Stat(tmuxSocketPath())
	return errors.Is(err, fs.ErrNotExist)
}

// readTmuxSessions returns the vibe-remote session IDs that currently have a
// live tmux session, mapped to each session's working directory (from tmux's
// pane_current_path), user-set name (@vibe_remote_name) and the other options.
// ok is false when it could not be told which sessions there are, so callers
// can distinguish "no sessions" from "couldn't tell" and avoid wrongly
// discarding live sessions; why then says what is known about the failure, for
// the log and for the user ("" when there is nothing to add). Pulling the name
// here (rather than a per-session show-options) keeps Manager.List to a single
// tmux exec.
//
// haveTerminal reports whether the caller's own session table has a terminal
// session. The rule, whenever it is not certain that there is no tmux session,
// is that the reading failed:
//
//  1. tmux answered: its answer is the set.
//  2. tmux said that no server is running (isNoTmuxServer): no sessions.
//  3. The query failed, the socket file does not exist and haveTerminal is
//     false: no sessions. No server was started since the socket directory was
//     last cleared (a reboot, or a daemon that has only ever run chat
//     sessions). Decided from the error value and the file system, not from
//     tmux's words.
//  4. Everything else is a failed reading. That includes a socket file that is
//     gone while haveTerminal is true: a tmux server outlives its socket file
//     (someone cleared /tmp) and creates it again on SIGUSR1, so the sessions
//     the table remembers may well be running.
func readTmuxSessions(haveTerminal func() bool) (sessions map[string]tmuxSessionInfo, ok bool, why string) {
	out, err := tmuxCmd("list-sessions", "-F", "#{session_name}\t#{pane_current_path}\t#{@vibe_remote_name}\t#{@vibe_remote_mode}\t#{@vibe_remote_source_workdir}\t#{@vibe_remote_source_repo}\t#{@vibe_remote_worktree_root}\t#{@vibe_remote_branch}\t#{@vibe_remote_claude_u}\t#{@vibe_remote_project}\t#{@vibe_remote_home}\t#{@vibe_remote_created}\t#{session_created}\t#{@vibe_remote_workdir}").Output()
	if err != nil {
		// tmux exits non-zero both when there genuinely are no sessions and when
		// the query could not run at all. Treating every non-zero exit as an
		// empty set would let a transient failure (unreachable socket,
		// permission problem) wipe every session from the in-memory table via
		// reconcile; treating every one as a failure would leave a daemon that
		// never started a tmux server unable to say "no terminal sessions".
		var exitErr *exec.ExitError
		ran := errors.As(err, &exitErr)
		if ran && isNoTmuxServer(exitErr.Stderr) {
			return map[string]tmuxSessionInfo{}, true, ""
		}
		if errors.Is(err, exec.ErrNotFound) {
			return map[string]tmuxSessionInfo{}, true, ""
		}
		if ran && tmuxSocketGone() {
			if !haveTerminal() {
				return map[string]tmuxSessionInfo{}, true, ""
			}
			why = fmt.Sprintf("tmux's socket file %s is gone while the daemon remembers terminal sessions. If tmux is still running, sending SIGUSR1 to the tmux server process makes it create the socket again; otherwise restart the daemon", tmuxSocketPath())
		}
		detail := ""
		if why != "" {
			detail = ": " + why
		}
		if ran {
			log.Printf("tmux list-sessions failed: %v (stderr=%q)%s", err, exitErr.Stderr, detail)
		} else {
			log.Printf("tmux list-sessions failed: %v%s", err, detail)
		}
		return nil, false, why
	}
	sessions = make(map[string]tmuxSessionInfo)
	for _, line := range strings.Split(strings.TrimRight(string(out), "\r\n"), "\n") {
		info, ok := parseTmuxSessionLine(line)
		if !ok {
			// A line that doesn't parse means tmux and vibe-remote disagree on
			// the format contract — the session would silently vanish from the
			// list, so make it loud rather than skipping in silence.
			log.Printf("tmux list-sessions unparsed line: %q", line)
			continue
		}
		id := strings.TrimPrefix(strings.SplitN(line, "\t", 2)[0], "vibe-remote-")
		sessions[id] = info
	}
	return sessions, true, ""
}

// Runner manages a single PTY session connected to tmux→claude (or bare claude).
type Runner struct {
	ID      string
	Created time.Time

	// Workdir and the worktree metadata below are guarded by metaMu, not mu:
	// reconcile fills them in from tmux under Manager.mu while relays and REST
	// handlers read them concurrently, and none of those paths should contend
	// with the PTY lock. Outside construction, read them through Metadata /
	// CurrentWorkdir. metaMu is a leaf lock — nothing else is acquired under it.
	metaMu        sync.Mutex
	Workdir       string
	Mode          string
	SourceWorkdir string
	SourceRepo    string
	WorktreeRoot  string
	Branch        string
	// claudeU (guarded by metaMu) is the claude conversation this session
	// holds in the Manager's claudeOwners table; "" = none.
	claudeU string
	// project and home (guarded by metaMu) are the session's attribution
	// (design 5.1); fixed at creation, recovered from tmux options, never
	// following a later cd. Read them through Home().
	project string
	home    string
	// startDir (guarded by metaMu) is the directory the session was started
	// in: Workdir at creation, @vibe_remote_workdir for a recovered session,
	// "" for one recovered from before that option existed. Unlike a recovered
	// session's Workdir it never follows the process. Read it through StartDir().
	startDir string

	ptmx    *os.File // PTY master (guarded by mu)
	cmd     *exec.Cmd
	mu      sync.Mutex
	stopped bool
	// epoch increments each time a new PTY is installed (initial start or a
	// reconnect's AttachExisting). A relay captures the epoch it owns; Detach
	// only closes the PTY if the caller still owns the current epoch, so a
	// slow teardown of an old connection can't close a newer connection's PTY.
	epoch uint64

	useTmux    bool
	claudeCmd  string
	claudeArgv []string // when set, the command as argv (claudeCmd is its shell form)
	loginShell bool
	shell      string
	eventsURL  string
	hookToken  string   // per-session HookToken, never the main token
	extraEnv   []string // further KEY=VALUE for the CLI (ChatConfig.Env)
}

// RunnerConfig holds parameters for creating a new Runner.
type RunnerConfig struct {
	ID            string
	Workdir       string
	Mode          string
	SourceWorkdir string
	SourceRepo    string
	WorktreeRoot  string
	Branch        string
	UseTmux       bool
	ClaudeCmd     string
	// ClaudeArgv, when set, is the command as argv (a daemon-built handoff or
	// continue command); ClaudeCmd is then ignored.
	ClaudeArgv []string
	LoginShell bool
	Shell      string
	Cols       uint16
	Rows       uint16
	EventsURL  string
	HookToken  string // injected as VIBE_REMOTE_TOKEN; see HookToken
	ClaudeU    string // claude conversation the session holds (@vibe_remote_claude_u)
	// Project and Home are the session's attribution (design 5.1); empty when
	// it could not be resolved (git failure), to be backfilled later.
	Project string
	Home    string
	// Created is the session's creation time; the zero value means now.
	Created  time.Time
	ExtraEnv []string
}

// NewRunner creates and starts a new session.
func NewRunner(cfg RunnerConfig) (*Runner, error) {
	r := &Runner{
		ID:            cfg.ID,
		Workdir:       cfg.Workdir,
		Mode:          cfg.Mode,
		SourceWorkdir: cfg.SourceWorkdir,
		SourceRepo:    cfg.SourceRepo,
		WorktreeRoot:  cfg.WorktreeRoot,
		Branch:        cfg.Branch,
		Created:       cfg.Created,
		useTmux:       cfg.UseTmux,
		claudeCmd:     cfg.ClaudeCmd,
		claudeArgv:    cfg.ClaudeArgv,
		loginShell:    cfg.LoginShell,
		shell:         cfg.Shell,
		eventsURL:     cfg.EventsURL,
		hookToken:     cfg.HookToken,
		claudeU:       cfg.ClaudeU,
		project:       cfg.Project,
		home:          cfg.Home,
		startDir:      cfg.Workdir,
		extraEnv:      cfg.ExtraEnv,
	}
	if r.Created.IsZero() {
		r.Created = time.Now()
	}

	if err := r.start(cfg.Cols, cfg.Rows); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *Runner) Metadata() protocol.SessionMetadata {
	r.metaMu.Lock()
	defer r.metaMu.Unlock()
	mode := protocol.SessionMode(r.Mode)
	if mode == "" {
		mode = protocol.SessionModeNormal
	}
	return protocol.SessionMetadata{Mode: mode, SourceWorkdir: r.SourceWorkdir, SourceRepo: r.SourceRepo, WorktreeRoot: r.WorktreeRoot, Branch: r.Branch}
}

// ClaudeU returns the claude conversation this session holds ("" = none).
func (r *Runner) ClaudeU() string {
	r.metaMu.Lock()
	defer r.metaMu.Unlock()
	return r.claudeU
}

func (r *Runner) setClaudeUMeta(u string) {
	r.metaMu.Lock()
	r.claudeU = u
	r.metaMu.Unlock()
}

// Home returns the session's attribution (project id and the root of the
// worktree it sits in). Both are empty when attribution was not resolved.
func (r *Runner) Home() (project, home string) {
	r.metaMu.Lock()
	defer r.metaMu.Unlock()
	return r.project, r.home
}

// StartDir returns the directory the session was started in, or "" when that
// is not known (a session recovered from before @vibe_remote_workdir existed).
func (r *Runner) StartDir() string {
	r.metaMu.Lock()
	defer r.metaMu.Unlock()
	return r.startDir
}

// backfillHome records attribution resolved after creation (design 5.4): it
// updates memory and, for a tmux session, persists the two options so a later
// daemon restart recovers them. A persist failure is tolerated; the next
// Projects() retries.
func (r *Runner) backfillHome(project, home string) {
	r.metaMu.Lock()
	r.project, r.home = project, home
	r.metaMu.Unlock()
	if r.useTmux {
		name := fmt.Sprintf("vibe-remote-%s", r.ID)
		_ = setTmuxOption(name, "@vibe_remote_project", project)
		_ = setTmuxOption(name, "@vibe_remote_home", home)
	}
}

// CurrentWorkdir returns the session's working directory under metaMu, since a
// recovered runner's Workdir may still be filled in by a concurrent reconcile.
func (r *Runner) CurrentWorkdir() string {
	r.metaMu.Lock()
	defer r.metaMu.Unlock()
	return r.Workdir
}

// initial process). When loginShell is enabled, claude is launched through a
// login+interactive shell (`<shell> -lic 'exec <claudeCmd>'`) so the user's
// full shell environment — PATH, node version managers (fnm/nvm), etc. — is
// loaded, matching what the user gets running claude by hand. `exec` replaces
// the shell so no extra process lingers.
func (r *Runner) launchCommand() []string {
	if len(r.claudeArgv) > 0 {
		return r.launchArgv(r.claudeArgv)
	}
	return r.launchCommandFor(r.claudeCmd)
}

// launchArgv is launchCommandFor for a command known as argv: exec'd as is
// when no shell is involved (bare session without a login shell), quoted
// word by word for a shell otherwise.
func (r *Runner) launchArgv(argv []string) []string {
	if !r.loginShell && !r.useTmux {
		return argv
	}
	return r.launchCommandFor(chat.ShellJoin(argv))
}

func (r *Runner) launchCommandFor(command string) []string {
	if !r.loginShell {
		return []string{command}
	}
	sh := r.shell
	if sh == "" {
		sh = "/bin/bash"
	}
	return []string{sh, "-lic", "exec " + command}
}

// setTmuxOption stores a user option using an explicit option terminator. The
// terminator prevents values such as "worktree" and "/private/tmp/..." from
// being parsed as tmux flags, while separate argv entries preserve spaces and
// empty values without involving a shell.
func setTmuxOption(sessionName, key, value string) error {
	return tmuxCmd("set-option", "-t", sessionName, "--", key, value).Run()
}

// waitTmuxSession polls until the named tmux session is registered (or the
// timeout elapses). `pty.StartWithSize` returns as soon as the `tmux
// new-session` process is spawned, but the tmux server registers the session
// asynchronously — a set-option issued immediately can hit "can't find
// session" and fail. Polling has-session closes that race without a fixed
// sleep. Returns true once the session exists.
func waitTmuxSession(sessionName string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if tmuxCmd("has-session", "-t", sessionName).Run() == nil {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// start launches the PTY process.
func (r *Runner) start(cols, rows uint16) error {
	var cmd *exec.Cmd

	tmuxSessionName := fmt.Sprintf("vibe-remote-%s", r.ID)

	launch := r.launchCommand()
	workdir := r.CurrentWorkdir()

	if r.useTmux {
		// tmux new-session -A -s <name> -c <workdir> -e K=V... -- <launch...>
		// -A: attach if exists, create if not
		// -c: set working directory
		// -e: see tmuxEnvArgs — cmd.Env alone does not reach the session
		args := append([]string{"new-session", "-A", "-s", tmuxSessionName,
			"-c", workdir}, r.tmuxEnvArgs()...)
		args = append(append(args, "--"), launch...)
		cmd = tmuxCmd(args...)
	} else {
		// Bare claude without tmux (no persistence)
		cmd = exec.Command(launch[0], launch[1:]...)
		cmd.Dir = workdir
	}

	// Still needed in tmux mode: it is the whole env in bare mode, and in tmux
	// mode the first client's env seeds a freshly started server.
	cmd.Env = utf8Env(
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	)
	cmd.Env = append(cmd.Env, r.vibeRemoteEnv()...)
	cmd.Env = append(cmd.Env, r.extraEnv...)

	// Start in PTY
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{
		Rows: rows,
		Cols: cols,
	})
	if err != nil {
		return fmt.Errorf("pty start: %w", err)
	}

	// Install under mu like AttachExisting does. The lock is released before
	// the tmux setup below because its failure path calls Kill, which takes mu.
	r.mu.Lock()
	r.ptmx = ptmx
	r.cmd = cmd
	r.epoch++
	r.mu.Unlock()

	if r.useTmux {
		// The tmux server registers the new session asynchronously after the
		// new-session process spawns; wait for it before set-option so metadata
		// writes don't race "can't find session".
		if !waitTmuxSession(tmuxSessionName, 3*time.Second) {
			r.Kill()
			return fmt.Errorf("tmux session %s did not become ready", tmuxSessionName)
		}
		meta := r.Metadata()
		project, home := r.Home()
		options := []struct{ key, value string }{
			{"@vibe_remote_mode", string(meta.Mode)},
			{"@vibe_remote_source_workdir", meta.SourceWorkdir},
			{"@vibe_remote_source_repo", meta.SourceRepo},
			{"@vibe_remote_worktree_root", meta.WorktreeRoot},
			{"@vibe_remote_branch", meta.Branch},
			{"@vibe_remote_claude_u", r.ClaudeU()},
			{"@vibe_remote_project", project},
			{"@vibe_remote_home", home},
			{"@vibe_remote_created", r.Created.UTC().Format(time.RFC3339Nano)},
			{"@vibe_remote_workdir", workdir},
		}
		for _, option := range options {
			if err := setTmuxOption(tmuxSessionName, option.key, option.value); err != nil {
				r.Kill()
				return fmt.Errorf("persist tmux metadata %s: %w", option.key, err)
			}
		}
		// Disable the status bar on the vibe-remote tmux server so claude gets the
		// full PTY height (tmux reserves 1 row for the status bar by default).
		// Runs slightly delayed so the server/session exists first.
		go func() {
			time.Sleep(150 * time.Millisecond)
			tmuxCmd("set-option", "-g", "status", "off").Run()
			// Force a resize/repaint so claude picks up the reclaimed row.
			tmuxCmd("refresh-client", "-t", tmuxSessionName).Run()
		}()
	}

	return nil
}

// AttachExisting re-attaches to an existing tmux session (for reconnect).
func (r *Runner) AttachExisting(cols, rows uint16) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Hand off the outgoing PTY and its tmux attach process, then clear the
	// fields before doing anything that can fail. Leaving a closed *os.File in
	// r.ptmx would make ptmxSnapshot hand out a dead descriptor instead of nil.
	// reap() waits on the old process so repeated reconnects don't pile up
	// zombies — closing the PTY master alone does not reclaim the child.
	oldPTY, oldCmd := r.ptmx, r.cmd
	r.ptmx, r.cmd = nil, nil
	reap(oldPTY, oldCmd)

	tmuxSessionName := fmt.Sprintf("vibe-remote-%s", r.ID)

	// tmux attach-session -t <name>
	cmd := tmuxCmd("attach-session", "-t", tmuxSessionName)
	cmd.Env = utf8Env(
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	)
	cmd.Env = append(cmd.Env, r.vibeRemoteEnv()...)

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{
		Rows: rows,
		Cols: cols,
	})
	if err != nil {
		return fmt.Errorf("pty attach: %w", err)
	}

	r.ptmx = ptmx
	r.cmd = cmd
	r.stopped = false
	r.epoch++

	// Force tmux to repaint for the new client dimensions
	go func() {
		time.Sleep(100 * time.Millisecond)
		tmuxCmd("refresh-client", "-t", tmuxSessionName).Run()
	}()

	return nil
}

// reap retires a PTY master and the tmux attach process behind it.
//
// Order matters. Closing the master alone does NOT wake a relay already blocked
// in Read on it (PTY masters support neither that nor SetReadDeadline), so the
// old relay's goroutine would hang forever — one leak per reconnect. Killing
// the attach process closes the slave side, which surfaces as EOF and lets the
// reader exit. That only detaches a tmux *client*; the session and the CLI
// inside it keep running, which is the whole point of tmux persistence.
//
// The Wait is what actually reclaims the child: on Unix an exited process stays
// in the table until someone Waits for it. It runs in a goroutine because
// callers hold r.mu and the process may take a moment to die.
func reap(ptmx *os.File, cmd *exec.Cmd) {
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	if ptmx != nil {
		ptmx.Close()
	}
	if cmd == nil || cmd.Process == nil {
		return
	}
	go func() { _ = cmd.Wait() }()
}

// CurrentEpoch returns the current PTY epoch. A relay captures this right
// after (re)attach and passes it to DetachEpoch so a stale connection's
// teardown cannot close a newer connection's PTY.
func (r *Runner) CurrentEpoch() uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.epoch
}

// ErrEpochSuperseded means a newer connection has installed its own PTY, so the
// caller's epoch no longer owns the session. A relay seeing this must stop
// quietly: the session is alive and now belongs to someone else, so reporting a
// process exit to its (already gone) client would be wrong.
var ErrEpochSuperseded = errors.New("pty epoch superseded by a newer attach")

// ptmxSnapshot returns the current PTY master under lock. The blocking
// Read/Write then operate on the snapshot without holding the mutex (so a
// blocked Read can't deadlock Resize/Detach). If the PTY is later closed the
// snapshot's Read/Write unblocks with an error, which is the intended signal.
func (r *Runner) ptmxSnapshot() *os.File {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.ptmx
}

// ptmxSnapshotEpoch is ptmxSnapshot for a caller that owns a specific epoch. It
// refuses to hand back a PTY that a newer attach installed — without this check
// an old relay's next Read would silently start consuming the new connection's
// bytes, and the two relays would split the stream between them (each client
// rendering a partial screen).
func (r *Runner) ptmxSnapshotEpoch(epoch uint64) (*os.File, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.epoch != epoch {
		return nil, ErrEpochSuperseded
	}
	return r.ptmx, nil
}

// Read reads from the PTY master (blocks until data available).
func (r *Runner) Read(buf []byte) (int, error) {
	ptmx := r.ptmxSnapshot()
	if ptmx == nil {
		return 0, io.EOF
	}
	return ptmx.Read(buf)
}

// ReadEpoch is Read for a relay that owns a given epoch. It returns
// ErrEpochSuperseded once a reconnect has taken over, so the caller can exit
// without mistaking the handover for a process exit.
func (r *Runner) ReadEpoch(epoch uint64, buf []byte) (int, error) {
	ptmx, err := r.ptmxSnapshotEpoch(epoch)
	if err != nil {
		return 0, err
	}
	if ptmx == nil {
		return 0, io.EOF
	}
	return ptmx.Read(buf)
}

// Write sends data to the PTY master (keyboard input from client).
func (r *Runner) Write(data []byte) (int, error) {
	ptmx := r.ptmxSnapshot()
	if ptmx == nil {
		return 0, io.ErrClosedPipe
	}
	return ptmx.Write(data)
}

// WriteEpoch is Write for a relay that owns a given epoch, so a stale
// connection's buffered keystrokes can't leak into a newer session's PTY.
func (r *Runner) WriteEpoch(epoch uint64, data []byte) (int, error) {
	ptmx, err := r.ptmxSnapshotEpoch(epoch)
	if err != nil {
		return 0, err
	}
	if ptmx == nil {
		return 0, io.ErrClosedPipe
	}
	return ptmx.Write(data)
}

// Resize updates the PTY window size.
func (r *Runner) Resize(cols, rows uint16) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.ptmx == nil {
		return fmt.Errorf("no PTY")
	}

	if err := pty.Setsize(r.ptmx, &pty.Winsize{
		Rows: rows,
		Cols: cols,
	}); err != nil {
		return fmt.Errorf("pty resize: %w", err)
	}

	// Also tell tmux to refresh if applicable
	if r.useTmux {
		tmuxSessionName := fmt.Sprintf("vibe-remote-%s", r.ID)
		tmuxCmd("refresh-client", "-t", tmuxSessionName).Run()
	}

	return nil
}

// Detach closes the PTY but leaves the tmux session alive (if tmux is enabled).
func (r *Runner) Detach() {
	r.mu.Lock()
	defer r.mu.Unlock()

	oldPTY, oldCmd := r.ptmx, r.cmd
	r.ptmx, r.cmd = nil, nil
	reap(oldPTY, oldCmd)
	r.stopped = true
}

// DetachEpoch closes the PTY only if the given epoch is still the current one.
// A relay calls this on teardown with the epoch it captured at attach time, so
// a slow-dying old connection won't close the PTY that a newer reconnect
// already installed. Returns true if it actually detached.
func (r *Runner) DetachEpoch(epoch uint64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.epoch != epoch {
		// A newer connection owns the PTY now; leave it alone. Its own teardown
		// (or the next AttachExisting) reaps the process it installed.
		return false
	}
	oldPTY, oldCmd := r.ptmx, r.cmd
	r.ptmx, r.cmd = nil, nil
	reap(oldPTY, oldCmd)
	r.stopped = true
	return true
}

// bareProcessGone reports whether a session without tmux has lost its CLI:
// its PTY was detached or killed (which ends the CLI in bare mode), or the
// process exited and was reaped. Always false with tmux, where the CLI's
// lifetime follows the tmux session instead.
func (r *Runner) bareProcessGone() bool {
	if r.useTmux {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cmd == nil || r.cmd.Process == nil {
		return true
	}
	return !pidAlive(r.cmd.Process.Pid)
}

// Kill terminates the session entirely (including the tmux session).
func (r *Runner) Kill() {
	r.mu.Lock()
	defer r.mu.Unlock()

	oldPTY, oldCmd := r.ptmx, r.cmd
	r.ptmx, r.cmd = nil, nil

	if r.useTmux {
		tmuxSessionName := fmt.Sprintf("vibe-remote-%s", r.ID)
		if err := tmuxCmd("kill-session", "-t", tmuxSessionName).Run(); err != nil {
			log.Printf("warning: failed to kill tmux session %s: %v", tmuxSessionName, err)
		}
	}
	// reap kills the process and waits for it, which covers both cases: the
	// tmux attach client above, or the directly-spawned CLI when tmux is off.
	reap(oldPTY, oldCmd)

	r.stopped = true
}

// Reload replaces the process in the session's only pane while leaving tmux
// and attached clients alive. A fresh login shell reloads the user's shell
// environment before the configured resume command starts.
func (r *Runner) Reload(command string) error {
	if !r.useTmux {
		return ErrReloadRequiresTmux
	}
	if strings.TrimSpace(command) == "" {
		return fmt.Errorf("session reload command is empty")
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	tmuxSessionName := fmt.Sprintf("vibe-remote-%s", r.ID)
	launch := r.launchCommandFor(command)
	args := append([]string{"respawn-pane", "-k", "-t", tmuxSessionName + ":0.0", "-c", r.CurrentWorkdir()}, r.tmuxEnvArgs()...)
	args = append(append(args, "--"), launch...)
	if out, err := tmuxCmd(args...).CombinedOutput(); err != nil {
		message := strings.TrimSpace(string(out))
		if message != "" {
			return fmt.Errorf("reload tmux session: %w: %s", err, message)
		}
		return fmt.Errorf("reload tmux session: %w", err)
	}
	return nil
}

// Wait waits for the process to exit and returns the exit code. Only the relay
// that saw a genuine read error calls this, on the process it still owns —
// retired processes are reaped by reap() instead, so no cmd is ever Waited twice.
func (r *Runner) Wait() int {
	r.mu.Lock()
	cmd := r.cmd
	r.mu.Unlock()
	if cmd == nil {
		return -1
	}
	err := cmd.Wait()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.ExitCode()
		}
		return -1
	}
	return 0
}

// TmuxSessionExists checks if the tmux session for this runner still exists.
func (r *Runner) TmuxSessionExists() bool {
	tmuxSessionName := fmt.Sprintf("vibe-remote-%s", r.ID)
	err := tmuxCmd("has-session", "-t", tmuxSessionName).Run()
	return err == nil
}

// sanitizeSessionName cleans a user-supplied session name before it's stored
// as a tmux option: strip control characters (including ANSI escape sequences)
// and trim surrounding whitespace, then cap the length. tmux gets the value as
// a set-option argument (not a shell string), so this is defense-in-depth
// against display corruption, not shell injection.
func sanitizeSessionName(name string) string {
	var b strings.Builder
	i := 0
	for i < len(name) {
		c := name[i]
		// Drop an ANSI escape sequence: ESC '[' ... final byte in @-~.
		if c == 0x1b {
			i++
			if i < len(name) && name[i] == '[' {
				i++
				for i < len(name) && !(name[i] >= 0x40 && name[i] <= 0x7e) {
					i++
				}
				if i < len(name) {
					i++ // consume the final byte
				}
			}
			continue
		}
		// Drop other control characters (newline, tab, CR, etc.).
		if c < 0x20 || c == 0x7f {
			i++
			continue
		}
		b.WriteByte(c)
		i++
	}
	out := strings.TrimSpace(b.String())
	if len(out) > 200 {
		out = out[:200]
	}
	return out
}

// SetName stores a user-set display name on the tmux session as a custom user
// option (@vibe_remote_name). Empty name clears it (falls back to the default rule).
func (r *Runner) SetName(name string) error {
	if !r.useTmux {
		return fmt.Errorf("naming requires tmux mode")
	}
	tmuxSessionName := fmt.Sprintf("vibe-remote-%s", r.ID)
	if name == "" {
		// Unset so displayTitle falls back to workdir/id.
		return tmuxCmd("set-option", "-t", tmuxSessionName, "-u", "--", "@vibe_remote_name").Run()
	}
	// Through setTmuxOption so the "--" terminator keeps a name like "-g" or
	// "-u" from being parsed as a tmux flag.
	return setTmuxOption(tmuxSessionName, "@vibe_remote_name", name)
}

// readName reads the @vibe_remote_name user option, or "" if unset / tmux errors.
func (r *Runner) readName() string {
	if !r.useTmux {
		return ""
	}
	tmuxSessionName := fmt.Sprintf("vibe-remote-%s", r.ID)
	out, err := tmuxCmd("show-options", "-t", tmuxSessionName, "-qv", "@vibe_remote_name").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// titleFrom applies the three-level display-title fallback given already-known
// values: user-set name → workdir basename → session ID. Both displayTitle
// (per-session tmux read) and Manager.List (single batched tmux read) resolve
// titles through this one function so the fallback semantics can't drift apart.
func titleFrom(name, workdir, id string) string {
	if name != "" {
		return name
	}
	if workdir != "" {
		trimmed := strings.TrimRight(workdir, "/")
		if idx := strings.LastIndex(trimmed, "/"); idx >= 0 && idx+1 < len(trimmed) {
			return trimmed[idx+1:]
		}
		if trimmed != "" {
			return trimmed
		}
	}
	return id
}

// displayTitle resolves the session's display name at read time (not stored):
// user-set @vibe_remote_name → workdir basename → session ID. This reads the name
// per-session; Manager.List batches the name read instead (see titleFrom).
func (r *Runner) displayTitle() string {
	return titleFrom(r.readName(), r.CurrentWorkdir(), r.ID)
}

// vibeRemoteEnv returns the VIBE_REMOTE_* environment variables injected into the claude
// process so a hook (claude's child) can report out-of-band events back to this
// daemon's events endpoint. These are inert unless a hook actually uses them —
// the hook wiring itself is intentionally out of scope for now (see plan).
// VIBE_REMOTE_TOKEN carries the per-session hook token, which only authorizes
// events for this session — never the main token (see HookToken).
func (r *Runner) vibeRemoteEnv() []string {
	env := []string{"VIBE_REMOTE_SESSION_ID=" + r.ID}
	if r.eventsURL != "" {
		env = append(env, "VIBE_REMOTE_EVENTS_URL="+r.eventsURL)
	}
	if r.hookToken != "" {
		env = append(env, "VIBE_REMOTE_TOKEN="+r.hookToken)
	}
	return env
}

// tmuxEnvArgs renders vibeRemoteEnv as `-e KEY=VAL` arguments for new-session
// and respawn-pane. Setting cmd.Env is not enough under tmux: the pane's
// environment comes from the server, and a server that is already running was
// seeded from whichever client started it. Without -e, every session after the
// first inherits that first session's VIBE_REMOTE_SESSION_ID (and token), so
// its hooks would report events against the wrong session.
func (r *Runner) tmuxEnvArgs() []string {
	env := append(r.vibeRemoteEnv(), r.extraEnv...)
	args := make([]string, 0, 2*len(env))
	for _, kv := range env {
		args = append(args, "-e", kv)
	}
	return args
}

// setClaudeU records the claude conversation this session holds, in memory
// and as the tmux option a restarted daemon recovers it from.
func (r *Runner) setClaudeU(u string) error {
	r.setClaudeUMeta(u)
	if !r.useTmux {
		return nil
	}
	return setTmuxOption(fmt.Sprintf("vibe-remote-%s", r.ID), "@vibe_remote_claude_u", u)
}

// Stop timings for a pane process (design 6.9 step 6, same as 6.6).
const (
	paneTermWait = 2 * time.Second
	paneKillWait = time.Second
)

// pidAlive reports whether pid exists (kill(pid, 0) is not ESRCH).
func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || !errors.Is(err, syscall.ESRCH)
}

func waitPidGone(pid int, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for pidAlive(pid) {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
	return true
}

func tmuxDisplay(target, format string) (string, error) {
	out, err := tmuxCmd("display-message", "-p", "-t", target, format).Output()
	return strings.TrimSpace(string(out)), err
}

// reloadStoppingFirst replaces the pane's process for a session that holds a
// claude conversation: unlike Reload (respawn-pane -k, which starts the new
// process while the old one is still exiting), the old process is stopped and
// confirmed gone first, so the conversation never runs twice (R2). The pane
// is kept through remain-on-exit; failBeforeStart is a test seam.
func (r *Runner) reloadStoppingFirst(command string, failBeforeStart error) error {
	if !r.useTmux {
		return ErrReloadRequiresTmux
	}
	if strings.TrimSpace(command) == "" {
		return fmt.Errorf("session reload command is empty")
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	name := fmt.Sprintf("vibe-remote-%s", r.ID)
	target := name + ":0.0"
	if out, err := tmuxCmd("set-option", "-w", "-t", target, "remain-on-exit", "on").CombinedOutput(); err != nil {
		return fmt.Errorf("reload: keep pane: %w: %s", err, strings.TrimSpace(string(out)))
	}
	pidText, err := tmuxDisplay(target, "#{pane_pid}")
	if err != nil {
		return fmt.Errorf("reload: pane pid: %w", err)
	}
	if pid, _ := strconv.Atoi(pidText); pid > 0 {
		// The pane process leads its own process group (tmux setsid()s it).
		_ = syscall.Kill(-pid, syscall.SIGTERM)
		if !waitPidGone(pid, paneTermWait) {
			_ = syscall.Kill(-pid, syscall.SIGKILL)
			if !waitPidGone(pid, paneKillWait) {
				return fmt.Errorf("reload: process %d did not exit", pid)
			}
		}
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		if dead, _ := tmuxDisplay(target, "#{pane_dead}"); dead == "1" {
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("reload: pane did not report its process exit")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if failBeforeStart != nil {
		return failBeforeStart
	}
	launch := r.launchCommandFor(command)
	args := append([]string{"respawn-pane", "-t", target, "-c", r.CurrentWorkdir()}, r.tmuxEnvArgs()...)
	args = append(append(args, "--"), launch...)
	if out, err := tmuxCmd(args...).CombinedOutput(); err != nil {
		return fmt.Errorf("reload tmux session: %w: %s", err, strings.TrimSpace(string(out)))
	}
	_ = tmuxCmd("set-option", "-w", "-t", target, "remain-on-exit", "off").Run()
	return nil
}

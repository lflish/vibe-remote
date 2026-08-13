// Package session manages PTY→tmux→claude sessions.
package session

import (
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// tmuxSocket is the dedicated tmux server socket name for vibe-remote.
// Using a separate server isolates vibe-remote sessions from the user's own tmux,
// lets us disable the status bar globally (so claude gets full PTY height),
// and makes cleanup safe.
const tmuxSocket = "vibe-remote"

var ErrReloadRequiresTmux = errors.New("session reload requires tmux mode")

// tmuxCmd builds a tmux command on the dedicated vibe-remote socket.
func tmuxCmd(args ...string) *exec.Cmd {
	return exec.Command("tmux", append([]string{"-L", tmuxSocket}, args...)...)
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
}

func parseTmuxSessionLine(line string) (tmuxSessionInfo, bool) {
	parts := strings.SplitN(line, "\t", 8)
	if len(parts) != 8 || !strings.HasPrefix(parts[0], "vibe-remote-") || strings.TrimPrefix(parts[0], "vibe-remote-") == "" {
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
	return info, true
}

// liveTmuxSessions returns the vibe-remote session IDs that currently have a live
// tmux session, mapped to each session's working directory (from tmux's
// pane_current_path) and user-set name (@vibe_remote_name). The bool return is
// false if the query itself failed (server not running or command error) so
// callers can distinguish "no sessions" from "couldn't tell" and avoid wrongly
// discarding live sessions on a transient failure. Pulling name here (rather
// than a per-session show-options) keeps Manager.List to a single tmux exec.
// isNoTmuxServer reports whether tmux's stderr means "there is nothing running"
// (an honest empty set) rather than "the query failed". tmux prints
// "no server running on <socket>" for the former and "error connecting to
// <socket> (...)" for the latter, both with a non-zero exit.
func isNoTmuxServer(stderr []byte) bool {
	msg := strings.ToLower(string(stderr))
	return strings.Contains(msg, "no server running") ||
		strings.Contains(msg, "no sessions")
}

func liveTmuxSessions() (map[string]tmuxSessionInfo, bool) {
	out, err := tmuxCmd("list-sessions", "-F", "#{session_name}\t#{pane_current_path}\t#{@vibe_remote_name}\t#{@vibe_remote_mode}\t#{@vibe_remote_source_workdir}\t#{@vibe_remote_source_repo}\t#{@vibe_remote_worktree_root}\t#{@vibe_remote_branch}").Output()
	if err != nil {
		// tmux exits non-zero both when there genuinely are no sessions and when
		// the query could not run at all, and only stderr tells them apart.
		// Treating every non-zero exit as an empty set would let a transient
		// failure (unreachable socket, permission problem) wipe every session
		// from the in-memory table via reconcile.
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && isNoTmuxServer(exitErr.Stderr) {
			return map[string]tmuxSessionInfo{}, true
		}
		return nil, false
	}
	sessions := make(map[string]tmuxSessionInfo)
	for _, line := range strings.Split(strings.TrimRight(string(out), "\r\n"), "\n") {
		info, ok := parseTmuxSessionLine(line)
		if !ok {
			continue
		}
		id := strings.TrimPrefix(strings.SplitN(line, "\t", 2)[0], "vibe-remote-")
		sessions[id] = info
	}
	return sessions, true
}

// Runner manages a single PTY session connected to tmux→claude (or bare claude).
type Runner struct {
	ID            string
	Workdir       string
	Created       time.Time
	Mode          string
	SourceWorkdir string
	SourceRepo    string
	WorktreeRoot  string
	Branch        string

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
	loginShell bool
	shell      string
	eventsURL  string
	token      string
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
	LoginShell    bool
	Shell         string
	Cols          uint16
	Rows          uint16
	EventsURL     string
	Token         string
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
		Created:       time.Now(),
		useTmux:       cfg.UseTmux,
		claudeCmd:     cfg.ClaudeCmd,
		loginShell:    cfg.LoginShell,
		shell:         cfg.Shell,
		eventsURL:     cfg.EventsURL,
		token:         cfg.Token,
	}

	if err := r.start(cfg.Cols, cfg.Rows); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *Runner) Metadata() protocol.SessionMetadata {
	mode := protocol.SessionMode(r.Mode)
	if mode == "" {
		mode = protocol.SessionModeNormal
	}
	return protocol.SessionMetadata{Mode: mode, SourceWorkdir: r.SourceWorkdir, SourceRepo: r.SourceRepo, WorktreeRoot: r.WorktreeRoot, Branch: r.Branch}
}

// initial process). When loginShell is enabled, claude is launched through a
// login+interactive shell (`<shell> -lic 'exec <claudeCmd>'`) so the user's
// full shell environment — PATH, node version managers (fnm/nvm), etc. — is
// loaded, matching what the user gets running claude by hand. `exec` replaces
// the shell so no extra process lingers.
func (r *Runner) launchCommand() []string {
	return r.launchCommandFor(r.claudeCmd)
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

	if r.useTmux {
		// tmux new-session -A -s <name> -c <workdir> -- <launch...>
		// -A: attach if exists, create if not
		// -c: set working directory
		args := append([]string{"new-session", "-A", "-s", tmuxSessionName,
			"-c", r.Workdir, "--"}, launch...)
		cmd = tmuxCmd(args...)
	} else {
		// Bare claude without tmux (no persistence)
		cmd = exec.Command(launch[0], launch[1:]...)
		cmd.Dir = r.Workdir
	}

	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	)
	cmd.Env = append(cmd.Env, r.vibeRemoteEnv()...)

	// Start in PTY
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{
		Rows: rows,
		Cols: cols,
	})
	if err != nil {
		return fmt.Errorf("pty start: %w", err)
	}

	r.ptmx = ptmx
	r.cmd = cmd
	r.epoch++

	if r.useTmux {
		// The tmux server registers the new session asynchronously after the
		// new-session process spawns; wait for it before set-option so metadata
		// writes don't race "can't find session".
		if !waitTmuxSession(tmuxSessionName, 3*time.Second) {
			r.Kill()
			return fmt.Errorf("tmux session %s did not become ready", tmuxSessionName)
		}
		options := []struct{ key, value string }{
			{"@vibe_remote_mode", string(r.Metadata().Mode)},
			{"@vibe_remote_source_workdir", r.SourceWorkdir},
			{"@vibe_remote_source_repo", r.SourceRepo},
			{"@vibe_remote_worktree_root", r.WorktreeRoot},
			{"@vibe_remote_branch", r.Branch},
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
	cmd.Env = append(os.Environ(),
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
	args := append([]string{"respawn-pane", "-k", "-t", tmuxSessionName + ":0.0", "-c", r.Workdir, "--"}, launch...)
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
		return tmuxCmd("set-option", "-t", tmuxSessionName, "-u", "@vibe_remote_name").Run()
	}
	return tmuxCmd("set-option", "-t", tmuxSessionName, "@vibe_remote_name", name).Run()
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
	return titleFrom(r.readName(), r.Workdir, r.ID)
}

// vibeRemoteEnv returns the VIBE_REMOTE_* environment variables injected into the claude
// process so a hook (claude's child) can report out-of-band events back to this
// daemon's events endpoint. These are inert unless a hook actually uses them —
// the hook wiring itself is intentionally out of scope for now (see plan).
func (r *Runner) vibeRemoteEnv() []string {
	env := []string{"VIBE_REMOTE_SESSION_ID=" + r.ID}
	if r.eventsURL != "" {
		env = append(env, "VIBE_REMOTE_EVENTS_URL="+r.eventsURL)
	}
	if r.token != "" {
		env = append(env, "VIBE_REMOTE_TOKEN="+r.token)
	}
	return env
}

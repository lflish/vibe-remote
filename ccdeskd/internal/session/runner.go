// Package session manages PTY→tmux→claude sessions.
package session

import (
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
)

// tmuxSocket is the dedicated tmux server socket name for ccdesk.
// Using a separate server isolates ccdesk sessions from the user's own tmux,
// lets us disable the status bar globally (so claude gets full PTY height),
// and makes cleanup safe.
const tmuxSocket = "ccdesk"

// tmuxCmd builds a tmux command on the dedicated ccdesk socket.
func tmuxCmd(args ...string) *exec.Cmd {
	return exec.Command("tmux", append([]string{"-L", tmuxSocket}, args...)...)
}

// liveTmuxSessions returns the ccdesk session IDs that currently have a live
// tmux session, mapped to each session's current working directory (from
// tmux's pane_current_path). The bool return is false if the query itself
// failed (server not running or command error) so callers can distinguish
// "no sessions" from "couldn't tell" and avoid wrongly discarding live
// sessions on a transient failure.
func liveTmuxSessions() (map[string]string, bool) {
	out, err := tmuxCmd("list-sessions", "-F", "#{session_name}\t#{pane_current_path}").Output()
	if err != nil {
		// tmux exits non-zero when the server has no sessions; that's a
		// legitimate empty set, not a query failure.
		if _, ok := err.(*exec.ExitError); ok {
			return map[string]string{}, true
		}
		return nil, false
	}
	sessions := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if !strings.HasPrefix(line, "ccdesk-") {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		id := strings.TrimPrefix(parts[0], "ccdesk-")
		workdir := ""
		if len(parts) == 2 {
			workdir = parts[1]
		}
		sessions[id] = workdir
	}
	return sessions, true
}

// Runner manages a single PTY session connected to tmux→claude (or bare claude).
type Runner struct {
	ID      string
	Workdir string
	Created time.Time

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
}

// RunnerConfig holds parameters for creating a new Runner.
type RunnerConfig struct {
	ID         string
	Workdir    string
	UseTmux    bool
	ClaudeCmd  string
	LoginShell bool
	Shell      string
	Cols       uint16
	Rows       uint16
}

// NewRunner creates and starts a new session.
func NewRunner(cfg RunnerConfig) (*Runner, error) {
	r := &Runner{
		ID:         cfg.ID,
		Workdir:    cfg.Workdir,
		Created:    time.Now(),
		useTmux:    cfg.UseTmux,
		claudeCmd:  cfg.ClaudeCmd,
		loginShell: cfg.LoginShell,
		shell:      cfg.Shell,
	}

	if err := r.start(cfg.Cols, cfg.Rows); err != nil {
		return nil, err
	}
	return r, nil
}

// launchCommand returns the command to run inside the PTY (or as tmux's
// initial process). When loginShell is enabled, claude is launched through a
// login+interactive shell (`<shell> -lic 'exec <claudeCmd>'`) so the user's
// full shell environment — PATH, node version managers (fnm/nvm), etc. — is
// loaded, matching what the user gets running claude by hand. `exec` replaces
// the shell so no extra process lingers.
func (r *Runner) launchCommand() []string {
	if !r.loginShell {
		return []string{r.claudeCmd}
	}
	sh := r.shell
	if sh == "" {
		sh = "/bin/bash"
	}
	return []string{sh, "-lic", "exec " + r.claudeCmd}
}

// start launches the PTY process.
func (r *Runner) start(cols, rows uint16) error {
	var cmd *exec.Cmd

	tmuxSessionName := fmt.Sprintf("ccdesk-%s", r.ID)

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
		// Disable the status bar on the ccdesk tmux server so claude gets the
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

	// Close old PTY if any
	if r.ptmx != nil {
		r.ptmx.Close()
	}

	tmuxSessionName := fmt.Sprintf("ccdesk-%s", r.ID)

	// tmux attach-session -t <name>
	cmd := tmuxCmd("attach-session", "-t", tmuxSessionName)
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	)

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

// CurrentEpoch returns the current PTY epoch. A relay captures this right
// after (re)attach and passes it to DetachEpoch so a stale connection's
// teardown cannot close a newer connection's PTY.
func (r *Runner) CurrentEpoch() uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.epoch
}

// ptmxSnapshot returns the current PTY master under lock. The blocking
// Read/Write then operate on the snapshot without holding the mutex (so a
// blocked Read can't deadlock Resize/Detach). If the PTY is later closed the
// snapshot's Read/Write unblocks with an error, which is the intended signal.
func (r *Runner) ptmxSnapshot() *os.File {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.ptmx
}

// Read reads from the PTY master (blocks until data available).
func (r *Runner) Read(buf []byte) (int, error) {
	ptmx := r.ptmxSnapshot()
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
		tmuxSessionName := fmt.Sprintf("ccdesk-%s", r.ID)
		tmuxCmd("refresh-client", "-t", tmuxSessionName).Run()
	}

	return nil
}

// Detach closes the PTY but leaves the tmux session alive (if tmux is enabled).
func (r *Runner) Detach() {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.ptmx != nil {
		r.ptmx.Close()
		r.ptmx = nil
	}
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
		// A newer connection owns the PTY now; leave it alone.
		return false
	}
	if r.ptmx != nil {
		r.ptmx.Close()
		r.ptmx = nil
	}
	r.stopped = true
	return true
}

// Kill terminates the session entirely (including the tmux session).
func (r *Runner) Kill() {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.ptmx != nil {
		r.ptmx.Close()
		r.ptmx = nil
	}

	if r.useTmux {
		tmuxSessionName := fmt.Sprintf("ccdesk-%s", r.ID)
		if err := tmuxCmd("kill-session", "-t", tmuxSessionName).Run(); err != nil {
			log.Printf("warning: failed to kill tmux session %s: %v", tmuxSessionName, err)
		}
	} else if r.cmd != nil && r.cmd.Process != nil {
		r.cmd.Process.Kill()
	}

	r.stopped = true
}

// Wait waits for the process to exit and returns the exit code.
func (r *Runner) Wait() int {
	if r.cmd == nil {
		return -1
	}
	err := r.cmd.Wait()
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
	tmuxSessionName := fmt.Sprintf("ccdesk-%s", r.ID)
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
// option (@ccdesk_name). Empty name clears it (falls back to the default rule).
func (r *Runner) SetName(name string) error {
	if !r.useTmux {
		return fmt.Errorf("naming requires tmux mode")
	}
	tmuxSessionName := fmt.Sprintf("ccdesk-%s", r.ID)
	if name == "" {
		// Unset so displayTitle falls back to workdir/id.
		return tmuxCmd("set-option", "-t", tmuxSessionName, "-u", "@ccdesk_name").Run()
	}
	return tmuxCmd("set-option", "-t", tmuxSessionName, "@ccdesk_name", name).Run()
}

// readName reads the @ccdesk_name user option, or "" if unset / tmux errors.
func (r *Runner) readName() string {
	if !r.useTmux {
		return ""
	}
	tmuxSessionName := fmt.Sprintf("ccdesk-%s", r.ID)
	out, err := tmuxCmd("show-options", "-t", tmuxSessionName, "-qv", "@ccdesk_name").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// displayTitle resolves the session's display name at read time (not stored):
// user-set @ccdesk_name → workdir basename → session ID.
func (r *Runner) displayTitle() string {
	if name := r.readName(); name != "" {
		return name
	}
	if r.Workdir != "" {
		trimmed := strings.TrimRight(r.Workdir, "/")
		if idx := strings.LastIndex(trimmed, "/"); idx >= 0 && idx+1 < len(trimmed) {
			return trimmed[idx+1:]
		}
		if trimmed != "" {
			return trimmed
		}
	}
	return r.ID
}

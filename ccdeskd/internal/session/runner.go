// Package session manages PTY→tmux→claude sessions.
package session

import (
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
)

// Runner manages a single PTY session connected to tmux→claude (or bare claude).
type Runner struct {
	ID      string
	Workdir string
	Created time.Time

	ptmx    *os.File // PTY master
	cmd     *exec.Cmd
	mu      sync.Mutex
	stopped bool

	useTmux   bool
	claudeCmd string
}

// RunnerConfig holds parameters for creating a new Runner.
type RunnerConfig struct {
	ID        string
	Workdir   string
	UseTmux   bool
	ClaudeCmd string
	Cols      uint16
	Rows      uint16
}

// NewRunner creates and starts a new session.
func NewRunner(cfg RunnerConfig) (*Runner, error) {
	r := &Runner{
		ID:        cfg.ID,
		Workdir:   cfg.Workdir,
		Created:   time.Now(),
		useTmux:   cfg.UseTmux,
		claudeCmd: cfg.ClaudeCmd,
	}

	if err := r.start(cfg.Cols, cfg.Rows); err != nil {
		return nil, err
	}
	return r, nil
}

// start launches the PTY process.
func (r *Runner) start(cols, rows uint16) error {
	var cmd *exec.Cmd

	tmuxSessionName := fmt.Sprintf("ccdesk-%s", r.ID)

	if r.useTmux {
		// tmux new-session -A -s <name> -c <workdir> -- claude
		// -A: attach if exists, create if not
		// -c: set working directory
		cmd = exec.Command("tmux", "new-session", "-A", "-s", tmuxSessionName,
			"-c", r.Workdir, "--", r.claudeCmd)
	} else {
		// Bare claude without tmux (no persistence)
		cmd = exec.Command(r.claudeCmd)
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
	cmd := exec.Command("tmux", "attach-session", "-t", tmuxSessionName)
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

	// Force tmux to repaint for the new client dimensions
	go func() {
		time.Sleep(100 * time.Millisecond)
		exec.Command("tmux", "refresh-client", "-t", tmuxSessionName).Run()
	}()

	return nil
}

// Read reads from the PTY master (blocks until data available).
func (r *Runner) Read(buf []byte) (int, error) {
	if r.ptmx == nil {
		return 0, io.EOF
	}
	return r.ptmx.Read(buf)
}

// Write sends data to the PTY master (keyboard input from client).
func (r *Runner) Write(data []byte) (int, error) {
	if r.ptmx == nil {
		return 0, io.ErrClosedPipe
	}
	return r.ptmx.Write(data)
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
		exec.Command("tmux", "refresh-client", "-t", tmuxSessionName).Run()
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
		if err := exec.Command("tmux", "kill-session", "-t", tmuxSessionName).Run(); err != nil {
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
	err := exec.Command("tmux", "has-session", "-t", tmuxSessionName).Run()
	return err == nil
}

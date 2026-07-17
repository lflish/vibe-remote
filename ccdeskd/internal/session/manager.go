package session

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"github.com/anthropic/ccdesk/ccdeskd/internal/protocol"
)

// Manager tracks all sessions on this machine.
type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Runner

	useTmux    bool
	claudeCmd  string
	loginShell bool
	shell      string
}

// NewManager creates a session manager.
func NewManager(useTmux bool, claudeCmd string, loginShell bool, shell string) *Manager {
	return &Manager{
		sessions:   make(map[string]*Runner),
		useTmux:    useTmux,
		claudeCmd:  claudeCmd,
		loginShell: loginShell,
		shell:      shell,
	}
}

// Create starts a new session and registers it.
func (m *Manager) Create(workdir string, cols, rows uint16) (*Runner, error) {
	id := generateID()

	runner, err := NewRunner(RunnerConfig{
		ID:         id,
		Workdir:    workdir,
		UseTmux:    m.useTmux,
		ClaudeCmd:  m.claudeCmd,
		LoginShell: m.loginShell,
		Shell:      m.shell,
		Cols:       cols,
		Rows:       rows,
	})
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	m.sessions[id] = runner
	m.mu.Unlock()

	return runner, nil
}

// Get returns a session by ID.
func (m *Manager) Get(id string) (*Runner, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	r, ok := m.sessions[id]
	return r, ok
}

// Attach re-attaches to an existing session (reconnect after disconnect).
func (m *Manager) Attach(id string, cols, rows uint16) (*Runner, error) {
	m.mu.RLock()
	runner, ok := m.sessions[id]
	m.mu.RUnlock()

	if !ok {
		// Check if there's a tmux session we can recover
		if m.useTmux {
			runner = &Runner{
				ID:         id,
				Workdir:    "", // will be recovered from tmux metadata if possible
				Created:    time.Now(),
				useTmux:    m.useTmux,
				claudeCmd:  m.claudeCmd,
				loginShell: m.loginShell,
				shell:      m.shell,
			}
			if !runner.TmuxSessionExists() {
				return nil, fmt.Errorf("session %q not found", id)
			}
			// Re-register
			m.mu.Lock()
			m.sessions[id] = runner
			m.mu.Unlock()
		} else {
			return nil, fmt.Errorf("session %q not found", id)
		}
	}

	if err := runner.AttachExisting(cols, rows); err != nil {
		return nil, err
	}

	return runner, nil
}

// Delete kills and removes a session.
func (m *Manager) Delete(id string) error {
	m.mu.Lock()
	runner, ok := m.sessions[id]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("session %q not found", id)
	}
	delete(m.sessions, id)
	m.mu.Unlock()

	runner.Kill()
	return nil
}

// Rename sets a user display name on a session (persisted as a tmux option).
// An empty name clears the custom name, reverting to the default title rule.
func (m *Manager) Rename(id, name string) error {
	m.mu.RLock()
	runner, ok := m.sessions[id]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("session %q not found", id)
	}
	return runner.SetName(sanitizeSessionName(name))
}

// List returns info for all sessions.
func (m *Manager) List() []protocol.SessionInfo {
	m.mu.Lock()
	defer m.mu.Unlock()

	// In tmux mode, tmux is the source of truth for which sessions exist.
	// Query once (not per-session) so a transient failure can't wrongly evict
	// live sessions: on query failure we fall back to the in-memory list. The
	// query also brings back @ccdesk_name, so Title assembly below needs no
	// extra per-session tmux exec (which would block under m.mu).
	var live map[string]tmuxSessionInfo
	haveLive := false
	if m.useTmux {
		var ok bool
		live, ok = liveTmuxSessions()
		if ok {
			haveLive = true
			// Prune map entries tmux says are gone.
			for id := range m.sessions {
				if _, alive := live[id]; !alive {
					delete(m.sessions, id)
				}
			}
			// Reconcile the other direction: a session can exist in tmux but
			// not in the map (e.g. the daemon restarted while the tmux session
			// kept running). Register a recovery entry so it shows up and can
			// be re-attached, using the working directory tmux reports.
			for id, info := range live {
				if r, exists := m.sessions[id]; exists {
					// Backfill workdir if we never recorded it (recovered entry).
					if r.Workdir == "" && info.workdir != "" {
						r.Workdir = info.workdir
					}
				} else {
					m.sessions[id] = &Runner{
						ID:         id,
						Workdir:    info.workdir,
						Created:    time.Now(),
						useTmux:    m.useTmux,
						claudeCmd:  m.claudeCmd,
						loginShell: m.loginShell,
						shell:      m.shell,
					}
				}
			}
		}
	}

	list := make([]protocol.SessionInfo, 0, len(m.sessions))
	for _, r := range m.sessions {
		// Prefer the name from the batched tmux query; only fall back to a
		// per-session read if we couldn't batch it (query failed / not in the
		// live set). titleFrom applies the identical three-level fallback.
		name := ""
		if haveLive {
			name = live[r.ID].name
		} else if r.useTmux {
			name = r.readName()
		}
		list = append(list, protocol.SessionInfo{
			ID:      r.ID,
			Title:   titleFrom(name, r.Workdir, r.ID),
			Workdir: r.Workdir,
			Created: r.Created.Format(time.RFC3339),
		})
	}
	return list
}

// generateID creates a short unique session ID. It combines a millisecond
// timestamp (keeps IDs roughly sortable by creation time) with a random
// suffix, so two sessions created in the same millisecond don't collide —
// a collision would make `tmux new-session -A` attach both to one session.
func generateID() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		// Fall back to nanosecond precision if crypto/rand is unavailable.
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("%d-%s", time.Now().UnixNano()/1e6, hex.EncodeToString(b[:]))
}

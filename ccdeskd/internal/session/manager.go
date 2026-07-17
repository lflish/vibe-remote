package session

import (
	"fmt"
	"sync"
	"time"

	"github.com/anthropic/ccdesk/ccdeskd/internal/protocol"
)

// Manager tracks all sessions on this machine.
type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Runner

	useTmux   bool
	claudeCmd string
}

// NewManager creates a session manager.
func NewManager(useTmux bool, claudeCmd string) *Manager {
	return &Manager{
		sessions:  make(map[string]*Runner),
		useTmux:   useTmux,
		claudeCmd: claudeCmd,
	}
}

// Create starts a new session and registers it.
func (m *Manager) Create(workdir string, cols, rows uint16) (*Runner, error) {
	id := generateID()

	runner, err := NewRunner(RunnerConfig{
		ID:        id,
		Workdir:   workdir,
		UseTmux:   m.useTmux,
		ClaudeCmd: m.claudeCmd,
		Cols:      cols,
		Rows:      rows,
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
				ID:        id,
				Workdir:   "", // will be recovered from tmux metadata if possible
				Created:   time.Now(),
				useTmux:   m.useTmux,
				claudeCmd: m.claudeCmd,
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

// List returns info for all sessions.
func (m *Manager) List() []protocol.SessionInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()

	list := make([]protocol.SessionInfo, 0, len(m.sessions))
	for _, r := range m.sessions {
		list = append(list, protocol.SessionInfo{
			ID:      r.ID,
			Title:   r.ID, // TODO: allow user-set titles
			Workdir: r.Workdir,
			Created: r.Created.Format(time.RFC3339),
		})
	}
	return list
}

// generateID creates a short unique session ID.
func generateID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano()/1e6)
}

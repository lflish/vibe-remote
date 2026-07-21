package session

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"github.com/anthropic/vibe-remote/vibe-remoted/internal/protocol"
)

// Manager tracks all sessions on this machine.
type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Runner
	subs     map[string][]chan protocol.NotifyFrame // sessionID → notify subscribers

	useTmux    bool
	claudeCmd  string
	loginShell bool
	shell      string
	eventsURL  string
	token      string
}

// NewManager creates a session manager.
func NewManager(useTmux bool, claudeCmd string, loginShell bool, shell string) *Manager {
	return &Manager{
		sessions:   make(map[string]*Runner),
		subs:       make(map[string][]chan protocol.NotifyFrame),
		useTmux:    useTmux,
		claudeCmd:  claudeCmd,
		loginShell: loginShell,
		shell:      shell,
	}
}

// SetEventEnv configures the events endpoint URL and token injected into new
// sessions' environment (for hook-based out-of-band reporting). Called once at
// startup after the bind address/port/token are known.
func (m *Manager) SetEventEnv(eventsURL, token string) {
	m.eventsURL = eventsURL
	m.token = token
}

// Create starts a new session and registers it. claudeCmdOverride, when
// non-empty, replaces the manager's default claude command for this session
// only (used to inject per-session flags resolved from the client's selection).
func (m *Manager) Create(workdir string, cols, rows uint16, claudeCmdOverride string) (*Runner, error) {
	id := generateID()

	claudeCmd := m.claudeCmd
	if claudeCmdOverride != "" {
		claudeCmd = claudeCmdOverride
	}

	runner, err := NewRunner(RunnerConfig{
		ID:         id,
		Workdir:    workdir,
		UseTmux:    m.useTmux,
		ClaudeCmd:  claudeCmd,
		LoginShell: m.loginShell,
		Shell:      m.shell,
		Cols:       cols,
		Rows:       rows,
		EventsURL:  m.eventsURL,
		Token:      m.token,
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
	// query also brings back @vibe_remote_name, so Title assembly below needs no
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

// Subscribe registers a subscriber for a session's out-of-band notify events.
// Returns a receive-only channel (buffered so a brief consumer stall doesn't
// block the publisher) and an idempotent unsubscribe function. A wsRelay
// subscribes on attach and unsubscribes on teardown.
func (m *Manager) Subscribe(sessionID string) (<-chan protocol.NotifyFrame, func()) {
	ch := make(chan protocol.NotifyFrame, 16)
	m.mu.Lock()
	m.subs[sessionID] = append(m.subs[sessionID], ch)
	m.mu.Unlock()

	var once sync.Once
	unsub := func() {
		once.Do(func() {
			m.mu.Lock()
			defer m.mu.Unlock()
			subs := m.subs[sessionID]
			for i, c := range subs {
				if c == ch {
					m.subs[sessionID] = append(subs[:i], subs[i+1:]...)
					break
				}
			}
			if len(m.subs[sessionID]) == 0 {
				delete(m.subs, sessionID)
			}
			// Close under the write lock so it's mutually exclusive with the
			// sends in PublishEvent (which run under RLock). Otherwise a
			// concurrent Publish could send on this channel after it's closed
			// and panic — select's default only guards a full buffer, not a
			// closed channel. Task 9's forwarder relies on this close to end
			// its `for f := range ch` loop, so the close must still happen.
			close(ch)
		})
	}
	return ch, unsub
}

// PublishEvent broadcasts a notify frame to every subscriber of a session.
// Non-blocking: if a subscriber's buffer is full, that event is dropped for
// that subscriber rather than stalling the events endpoint. The send happens
// under RLock so it's mutually exclusive with unsubscribe's close (which holds
// the write lock) — this prevents a send-on-closed-channel panic. The select's
// default keeps every send non-blocking, so holding RLock stays bounded and
// multiple publishers can proceed concurrently.
func (m *Manager) PublishEvent(sessionID string, f protocol.NotifyFrame) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, ch := range m.subs[sessionID] {
		select {
		case ch <- f:
		default: // subscriber lagging — drop rather than block
		}
	}
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

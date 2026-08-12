package session

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// Manager tracks all sessions on this machine.
type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Runner
	subs     map[string][]chan protocol.NotifyFrame // sessionID → notify subscribers

	useTmux          bool
	claudeCmd        string
	loginShell       bool
	shell            string
	liveTmuxSessions func() (map[string]tmuxSessionInfo, bool)
	eventsURL        string
	token            string
}

// NewManager creates a session manager.
func NewManager(useTmux bool, claudeCmd string, loginShell bool, shell string) *Manager {
	return &Manager{
		sessions:         make(map[string]*Runner),
		subs:             make(map[string][]chan protocol.NotifyFrame),
		useTmux:          useTmux,
		claudeCmd:        claudeCmd,
		loginShell:       loginShell,
		shell:            shell,
		liveTmuxSessions: liveTmuxSessions,
	}
}

// SetEventEnv configures the events endpoint URL and token injected into new
// sessions' environment (for hook-based out-of-band reporting). Called once at
// startup after the bind address/port/token are known.
func (m *Manager) SetEventEnv(eventsURL, token string) {
	m.eventsURL = eventsURL
	m.token = token
}

// CreateOptions holds parameters for creating a new session.
type CreateOptions struct {
	Workdir           string
	Mode              protocol.SessionMode
	Cols, Rows        uint16
	ClaudeCmdOverride string
}

// Create starts a new session and registers it. Worktree resources are created
// before the runner starts so a failed launch can roll them back safely.
func (m *Manager) Create(opts CreateOptions) (*Runner, error) {
	id := generateID()
	mode := opts.Mode
	if mode == "" {
		mode = protocol.SessionModeNormal
	}
	if mode != protocol.SessionModeNormal && mode != protocol.SessionModeWorktree {
		return nil, fmt.Errorf("unknown session mode %q", mode)
	}

	workdir := opts.Workdir
	var meta WorktreeMetadata
	var err error
	if mode == protocol.SessionModeWorktree {
		meta, workdir, err = CreateWorktree(opts.Workdir, id)
		if err != nil {
			return nil, err
		}
	}

	claudeCmd := m.claudeCmd
	if opts.ClaudeCmdOverride != "" {
		claudeCmd = opts.ClaudeCmdOverride
	}
	runner, err := NewRunner(RunnerConfig{
		ID:            id,
		Workdir:       workdir,
		Mode:          string(mode),
		SourceWorkdir: meta.SourceWorkdir,
		SourceRepo:    meta.SourceRepo,
		WorktreeRoot:  meta.WorktreeRoot,
		Branch:        meta.Branch,
		UseTmux:       m.useTmux,
		ClaudeCmd:     claudeCmd,
		LoginShell:    m.loginShell,
		Shell:         m.shell,
		Cols:          opts.Cols,
		Rows:          opts.Rows,
		EventsURL:     m.eventsURL,
		Token:         m.token,
	})
	if err != nil {
		if mode == protocol.SessionModeWorktree {
			if rollbackErr := RollbackWorktree(meta); rollbackErr != nil {
				return nil, fmt.Errorf("%v; rollback worktree: %w", err, rollbackErr)
			}
		}
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
	if m.useTmux {
		if !ok {
			// Reconcile this one session from tmux before attaching, so Ready has
			// the persisted worktree metadata after a daemon restart.
			if live, queryOK := m.liveTmuxSessions(); queryOK {
				if info, exists := live[id]; exists {
					runner = &Runner{ID: id, Workdir: info.workdir, Mode: info.mode, SourceWorkdir: info.sourceWorkdir, SourceRepo: info.sourceRepo, WorktreeRoot: info.worktreeRoot, Branch: info.branch, Created: time.Now(), useTmux: true, claudeCmd: m.claudeCmd, loginShell: m.loginShell, shell: m.shell, eventsURL: m.eventsURL, token: m.token}
					m.mu.Lock()
					m.sessions[id] = runner
					m.mu.Unlock()
					ok = true
				}
			}
		}
		if !ok {
			return nil, fmt.Errorf("session %q not found", id)
		}
	} else if !ok {
		return nil, fmt.Errorf("session %q not found", id)
	}

	if err := runner.AttachExisting(cols, rows); err != nil {
		return nil, err
	}

	return runner, nil
}

// Delete kills and removes a session. Worktree cleanup happens after the
// runner is stopped; dirty resources are intentionally preserved and surfaced.
func (m *Manager) Delete(id string) error {
	if m.useTmux {
		if live, ok := m.liveTmuxSessions(); ok {
			m.mu.Lock()
			reconcileTmuxSessions(m.sessions, live, time.Now(), m.useTmux, m.claudeCmd, m.shell, m.loginShell)
			m.mu.Unlock()
		}
	}
	m.mu.Lock()
	runner, ok := m.sessions[id]
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("session %q not found", id)
	}

	runner.Kill()
	if protocol.SessionMode(runner.Mode) == protocol.SessionModeWorktree {
		err := CleanupWorktree(WorktreeMetadata{
			SourceWorkdir: runner.SourceWorkdir,
			SourceRepo:    runner.SourceRepo,
			WorktreeRoot:  runner.WorktreeRoot,
			Branch:        runner.Branch,
		})
		if err != nil {
			return err
		}
	}
	m.mu.Lock()
	delete(m.sessions, id)
	m.mu.Unlock()
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

// Reload replaces the CLI process inside an existing tmux session. The tmux
// session itself remains alive, preserving its id, metadata and attached client.
func (m *Manager) Reload(id, command string) error {
	if !m.useTmux {
		return ErrReloadRequiresTmux
	}
	if live, ok := m.liveTmuxSessions(); ok {
		m.mu.Lock()
		reconcileTmuxSessions(m.sessions, live, time.Now(), m.useTmux, m.claudeCmd, m.shell, m.loginShell)
		m.mu.Unlock()
	}
	m.mu.RLock()
	runner, ok := m.sessions[id]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("session %q not found", id)
	}
	return runner.Reload(command)
}

func applyTmuxSessionMetadata(r *Runner, info tmuxSessionInfo) {
	if r.Workdir == "" {
		r.Workdir = info.workdir
	}
	// A complete Worktree snapshot is authoritative for a recovered runner whose
	// zero/default mode was already normalized to "normal". Apply the metadata as
	// one unit so List, Ready, and Delete cannot observe a mixed Normal/Worktree
	// state. Conversely, never let a partial snapshot erase a complete in-memory
	// Worktree identity while tmux options are still being written.
	if completeTmuxWorktreeMetadata(info) && !completeRunnerWorktreeMetadata(r) {
		r.Mode = info.mode
		r.SourceWorkdir = info.sourceWorkdir
		r.SourceRepo = info.sourceRepo
		r.WorktreeRoot = info.worktreeRoot
		r.Branch = info.branch
		return
	}
	if r.Mode == "" {
		r.Mode = info.mode
	}
	if r.SourceWorkdir == "" {
		r.SourceWorkdir = info.sourceWorkdir
	}
	if r.SourceRepo == "" {
		r.SourceRepo = info.sourceRepo
	}
	if r.WorktreeRoot == "" {
		r.WorktreeRoot = info.worktreeRoot
	}
	if r.Branch == "" {
		r.Branch = info.branch
	}
}

func completeTmuxWorktreeMetadata(info tmuxSessionInfo) bool {
	return protocol.SessionMode(info.mode) == protocol.SessionModeWorktree &&
		info.sourceWorkdir != "" && info.sourceRepo != "" && info.worktreeRoot != "" && info.branch != ""
}

func completeRunnerWorktreeMetadata(r *Runner) bool {
	return protocol.SessionMode(r.Mode) == protocol.SessionModeWorktree &&
		r.SourceWorkdir != "" && r.SourceRepo != "" && r.WorktreeRoot != "" && r.Branch != ""
}

// reconcileTmuxSessions updates the in-memory session table from tmux's live
// snapshot. Keeping this seam separate makes reconciliation testable without
// depending on a running tmux daemon.
func reconcileTmuxSessions(sessions map[string]*Runner, live map[string]tmuxSessionInfo, now time.Time, useTmux bool, claudeCmd, shell string, loginShell bool) {
	for id := range sessions {
		if _, alive := live[id]; !alive {
			delete(sessions, id)
		}
	}
	for id, info := range live {
		if r, exists := sessions[id]; exists {
			applyTmuxSessionMetadata(r, info)
			continue
		}
		sessions[id] = &Runner{
			ID:            id,
			Workdir:       info.workdir,
			Mode:          info.mode,
			SourceWorkdir: info.sourceWorkdir,
			SourceRepo:    info.sourceRepo,
			WorktreeRoot:  info.worktreeRoot,
			Branch:        info.branch,
			Created:       now,
			useTmux:       useTmux,
			claudeCmd:     claudeCmd,
			loginShell:    loginShell,
			shell:         shell,
		}
	}
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
		live, ok = m.liveTmuxSessions()
		if ok {
			haveLive = true
			reconcileTmuxSessions(m.sessions, live, time.Now(), m.useTmux, m.claudeCmd, m.shell, m.loginShell)
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
			ID:              r.ID,
			Title:           titleFrom(name, r.Workdir, r.ID),
			Workdir:         r.Workdir,
			Created:         r.Created.Format(time.RFC3339),
			SessionMetadata: r.Metadata(),
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

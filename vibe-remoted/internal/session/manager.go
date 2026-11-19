package session

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"strconv"
	"sync"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// ErrSessionNotFound is wrapped by every "session %q not found" error so HTTP
// handlers can map it to 404 without matching on the message.
var ErrSessionNotFound = errors.New("not found")

func sessionNotFound(id string) error {
	return fmt.Errorf("session %q %w", id, ErrSessionNotFound)
}

// Manager tracks all sessions on this machine: terminal sessions (Runner, in
// tmux) and chat sessions (chat.Session, a claude process the daemon owns).
//
// Lock order, only ever downward (design 2): a creating placeholder (per id)
// → chat.Session.opMu → Manager.mu → Runner.mu / chat.Session.mu →
// Runner.metaMu / store. Manager.mu is never acquired while holding a Runner
// or Session lock, metaMu is a leaf, and no tmux command or file IO runs under
// Manager.mu (a slow tmux would otherwise stall every handler).
type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Runner
	chats    map[string]*chatEntry
	// claudeOwners maps a claude conversation id (U) to the one session —
	// chat or terminal, or "orphan:<pid>" — allowed to run a claude process on
	// it. Every spawn claims first (R2, design 2).
	claudeOwners map[string]string
	orphans      map[string]chat.Orphan
	subs         map[string][]chan protocol.NotifyFrame // sessionID → notify subscribers
	// creating holds the client-chosen ids whose Create is still in flight;
	// the channel closes when it finishes. A replayed attach for the same id
	// waits on it instead of racing a second CreateWorktree / new-session.
	creating map[string]chan struct{}
	// gen counts session-table mutations (create, delete, recovery). A tmux
	// snapshot taken outside mu is only applied if gen hasn't moved since the
	// query started — otherwise reconcile could evict a session created after
	// the snapshot, or resurrect one deleted after it.
	gen uint64

	useTmux          bool
	claudeCmd        string
	loginShell       bool
	shell            string
	liveTmuxSessions func() (map[string]tmuxSessionInfo, bool)
	eventsURL        string
	// mainToken is held only to derive per-session hook tokens; it is never
	// injected into a session's environment.
	mainToken string

	chatCfg      ChatConfig
	store        *chat.Store
	projectStore *ProjectStore
	persist      persister
	// closing (guarded by mu) is set by Shutdown: no new chat process starts.
	// chatCreates counts the CreateChat calls Shutdown waits for.
	closing     bool
	chatCreates sync.WaitGroup

	// Seams for tests.
	orphanCleanup             func([]chat.Record) ([]chat.Record, []chat.Orphan)
	testAfterResolve          func(workdir string) // after a -c terminal resolved its conversation
	testFailRespawn           error                // makes the next fixed-identity reload fail to start
	testAfterWorktreeSnapshot func()               // Projects: after the worktree-record snapshot, before reading lists
	testUndoLocked            func()               // undoing a created worktree: repository lock held, nothing removed yet
}

// NewManager creates a session manager.
func NewManager(useTmux bool, claudeCmd string, loginShell bool, shell string) *Manager {
	m := &Manager{
		sessions:         make(map[string]*Runner),
		chats:            make(map[string]*chatEntry),
		claudeOwners:     make(map[string]string),
		orphans:          make(map[string]chat.Orphan),
		orphanCleanup:    chat.CleanupOrphans,
		subs:             make(map[string][]chan protocol.NotifyFrame),
		creating:         make(map[string]chan struct{}),
		useTmux:          useTmux,
		claudeCmd:        claudeCmd,
		loginShell:       loginShell,
		shell:            shell,
		liveTmuxSessions: liveTmuxSessions,
	}
	if useTmux {
		scrubTmuxMainToken()
	}
	return m
}

// scrubTmuxMainToken removes the daemon's main token variable from the global
// environment of a tmux server an older daemon may have started with it (a
// server copies its first client's environment into every new pane). Best
// effort: with no server running there is nothing to remove.
func scrubTmuxMainToken() {
	_ = tmuxCmd("set-environment", "-g", "-u", chat.MainTokenEnv).Run()
}

// SetEventEnv configures the events endpoint URL injected into new sessions'
// environment, and the main token from which each session's hook token is
// derived (for hook-based out-of-band reporting). Called once at startup after
// the bind address/port/token are known.
func (m *Manager) SetEventEnv(eventsURL, mainToken string) {
	m.eventsURL = eventsURL
	m.mainToken = mainToken
}

// hookTokenFor returns the session's hook token, or "" when no main token is
// configured (nothing to derive from, so nothing is injected).
func (m *Manager) hookTokenFor(id string) string {
	if m.mainToken == "" {
		return ""
	}
	return HookToken(m.mainToken, id)
}

// recoveredRunner builds the in-memory entry for a session that exists in tmux
// but not in the table (daemon restart). It carries the same event env as a
// freshly created runner so a later Reload injects the right values.
func (m *Manager) recoveredRunner(id string, info tmuxSessionInfo, now time.Time) *Runner {
	return &Runner{
		ID:            id,
		Workdir:       info.workdir,
		Mode:          info.mode,
		SourceWorkdir: info.sourceWorkdir,
		SourceRepo:    info.sourceRepo,
		WorktreeRoot:  info.worktreeRoot,
		Branch:        info.branch,
		Created:       recoveredCreated(info, now),
		useTmux:       m.useTmux,
		claudeCmd:     m.claudeCmd,
		loginShell:    m.loginShell,
		shell:         m.shell,
		eventsURL:     m.eventsURL,
		hookToken:     m.hookTokenFor(id),
		claudeU:       info.claudeU,
		project:       info.project,
		home:          info.home,
		extraEnv:      m.chatCfg.Env,
	}
}

// recoveredCreated reconstructs a recovered session's creation time: the
// RFC 3339 @vibe_remote_created option if it parses, else tmux's own
// session_created (unix seconds), else the recovery moment (design 5.1). The
// value is converted to local time so /api/v1/sessions formats it identically
// across restarts.
func recoveredCreated(info tmuxSessionInfo, now time.Time) time.Time {
	if info.created != "" {
		if t, err := time.Parse(time.RFC3339Nano, info.created); err == nil {
			return t.Local()
		}
	}
	if info.sessionCreated != "" {
		if secs, err := strconv.ParseInt(info.sessionCreated, 10, 64); err == nil {
			return time.Unix(secs, 0).Local()
		}
	}
	return now
}

// ErrInvalidSessionID rejects a client-chosen session id that could not be
// used safely as a tmux session name, branch name and directory name.
var ErrInvalidSessionID = errors.New("invalid session id")

// maxSessionIDLen bounds client-chosen ids; they end up in tmux session names,
// git branch names and worktree paths.
const maxSessionIDLen = 64

// ValidSessionID reports whether id is acceptable as a client-chosen id.
func ValidSessionID(id string) bool {
	return len(id) <= maxSessionIDLen && safeSessionID.MatchString(id)
}

// CreateOptions holds parameters for creating a new session.
type CreateOptions struct {
	// ID is the client-chosen session id. When set, Create is idempotent: if a
	// session with this id already exists (or is being created) the call
	// attaches to it instead. Empty = generate one.
	ID                string
	Workdir           string
	Mode              protocol.SessionMode
	Cols, Rows        uint16
	ClaudeCmdOverride string
	// ClaudeArgv, when set, is the command as argv (handoff); it takes
	// precedence over ClaudeCmdOverride.
	ClaudeArgv []string
	// ValidateWorkdir, when set, re-checks the workdir a worktree session will
	// actually run in. The caller validated the source directory, but the
	// worktree is created next to the repo root — possibly outside the allowed
	// roots — so the derived path needs the same check.
	ValidateWorkdir func(string) (string, error)
	// ClaudeU, when set, is a claude conversation the caller already claimed
	// for this session (handoff); the command must already open it.
	ClaudeU string
	// Worktree, when set, is an existing worktree the session takes over
	// (handoff) instead of creating one; Workdir is then used as is.
	Worktree *WorktreeMetadata
	// Home, when set, is the attribution to record verbatim (a handoff copies
	// the chat session's); when nil, Create resolves it from the workdir.
	Home *Home
	// WorktreeName (worktree mode only) names the new branch; empty keeps the
	// original naming, vibe/<session id>.
	WorktreeName string
}

// Create starts a new session and registers it. Worktree resources are created
// before the runner starts so a failed launch can roll them back safely.
//
// With opts.ID set the call is idempotent, which is what makes a client's
// "attach sent, connection dropped before ready" replay safe: the replay
// attaches to the session the first attempt created rather than creating a
// second one (and, in worktree mode, a second worktree and branch).
func (m *Manager) Create(opts CreateOptions) (*Runner, error) {
	id := opts.ID
	if id == "" {
		id = generateID()
	} else {
		if !ValidSessionID(id) {
			return nil, ErrInvalidSessionID
		}
		done, exists := m.beginCreate(id)
		if !exists && m.useTmux {
			// The table can miss a session that tmux still has (daemon restarted
			// between the first attempt and the replay).
			if _, err := m.lookupOrRecover(id); err == nil {
				exists = true
				done()
			}
		}
		if exists {
			return m.Attach(id, opts.Cols, opts.Rows)
		}
		defer done()
	}
	return m.createTerminalLocked(id, opts)
}

// createTerminalLocked starts terminal session id. The caller holds id's
// creating placeholder (or generated id), so it must not call beginCreate
// again — a handoff, which already holds the placeholder, would wait for
// itself.
//
// A command that continues the latest conversation (-c) gets a fixed identity
// first (design 6.9, c4): the conversation is resolved and claimed, and -c is
// replaced by --resume U (or --session-id U for a new one), so the process
// that runs is exactly the one the claim table knows about.
// resolveSessionHome computes the attribution to record for a new session
// (design 5.1). A handoff supplies it directly (opts.Home). A worktree session
// sits in the new worktree root and takes its project from the source repo
// (itself when the repo has no recognizable main worktree). Otherwise it is
// ResolveHome(workdir). A git failure leaves both empty for later backfill.
// git reports whether the project should enter the project list (H18: only git
// projects, and a handoff's project was already added by its origin).
func resolveSessionHome(opts CreateOptions, mode protocol.SessionMode, workdir string, meta WorktreeMetadata, ownWorktree bool) (project, home string, git bool) {
	if opts.Home != nil {
		return opts.Home.Project, opts.Home.Path, false
	}
	if ownWorktree {
		h, err := ResolveHome(meta.SourceRepo)
		if err != nil {
			return "", "", false
		}
		project = h.Project
		if h.Single {
			project = meta.WorktreeRoot
		}
		return project, meta.WorktreeRoot, true
	}
	h, err := ResolveHome(workdir)
	if err != nil {
		return "", "", false
	}
	return h.Project, h.Path, h.Git
}

func (m *Manager) createTerminalLocked(id string, opts CreateOptions) (*Runner, error) {
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
	if opts.Worktree != nil {
		meta = *opts.Worktree
	} else if mode == protocol.SessionModeWorktree {
		created, cerr := CreateWorktree(WorktreeSpec{Source: opts.Workdir, SessionID: id, Name: opts.WorktreeName})
		if cerr != nil {
			return nil, cerr
		}
		meta, workdir = created.Meta, created.Workdir
		if opts.ValidateWorkdir != nil {
			if _, err := opts.ValidateWorkdir(workdir); err != nil {
				err = fmt.Errorf("worktree workdir %q: %w", workdir, err)
				if rollbackErr := RollbackWorktree(meta); rollbackErr != nil {
					return nil, fmt.Errorf("%v; rollback worktree: %w", err, rollbackErr)
				}
				return nil, err
			}
		}
	}

	claudeCmd := m.claudeCmd
	if opts.ClaudeCmdOverride != "" {
		claudeCmd = opts.ClaudeCmdOverride
	}
	claudeArgv := opts.ClaudeArgv
	if len(claudeArgv) > 0 {
		claudeCmd = chat.ShellJoin(claudeArgv)
	}
	ownWorktree := mode == protocol.SessionModeWorktree && opts.Worktree == nil
	claudeU := opts.ClaudeU
	claimedHere := false
	if claudeU == "" {
		if p, reason := chat.ParseClaudeCmd(claudeCmd); reason == "" && p.Continue {
			u, found := chat.LatestSessionForWorkdir(m.projectsDir(), workdir)
			if m.testAfterResolve != nil {
				m.testAfterResolve(workdir)
			}
			if !found {
				u = chat.NewUUID()
			}
			if err := m.claimClaude(u, id); err != nil {
				if ownWorktree {
					if rollbackErr := RollbackWorktree(meta); rollbackErr != nil {
						return nil, fmt.Errorf("%v; rollback worktree: %w", err, rollbackErr)
					}
				}
				return nil, err
			}
			claudeArgv = chat.HandoffArgv(p.Exe, p.Args, u, found)
			claudeCmd = chat.ShellJoin(claudeArgv)
			claudeU, claimedHere = u, true
		}
	}
	project, home, git := resolveSessionHome(opts, mode, workdir, meta, ownWorktree)
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
		ClaudeArgv:    claudeArgv,
		LoginShell:    m.loginShell,
		Shell:         m.shell,
		Cols:          opts.Cols,
		Rows:          opts.Rows,
		EventsURL:     m.eventsURL,
		HookToken:     m.hookTokenFor(id),
		ClaudeU:       claudeU,
		Project:       project,
		Home:          home,
		ExtraEnv:      m.chatCfg.Env,
	})
	if err != nil {
		if claimedHere {
			m.releaseClaude(claudeU, id)
		}
		if ownWorktree {
			if rollbackErr := RollbackWorktree(meta); rollbackErr != nil {
				return nil, fmt.Errorf("%v; rollback worktree: %w", err, rollbackErr)
			}
		}
		return nil, err
	}

	m.mu.Lock()
	m.sessions[id] = runner
	m.gen++
	m.mu.Unlock()
	m.recordCreated(project, git, ownWorktree, meta)
	return runner, nil
}

// recordCreated adds a newly created session's git project to the store and, in
// worktree mode, records the created worktree (design 5.2). It takes the
// store's own leaf lock, never Manager.mu.
func (m *Manager) recordCreated(project string, git, ownWorktree bool, meta WorktreeMetadata) {
	if m.projectStore == nil {
		return
	}
	if git && project != "" {
		m.projectStore.AddProject(project)
	}
	if ownWorktree && project != "" {
		m.projectStore.AddWorktree(project, meta.WorktreeRoot, meta.Branch)
	}
}

// beginCreate claims id for creation. It returns exists=true (and no done
// func) when the session is already registered, waiting first for any
// in-flight Create of the same id to finish. Otherwise the caller owns the
// claim and must call done when its Create returns, success or not.
func (m *Manager) beginCreate(id string) (done func(), exists bool) {
	for {
		m.mu.Lock()
		if _, ok := m.sessions[id]; ok || m.chats[id] != nil {
			m.mu.Unlock()
			return nil, true
		}
		inflight, busy := m.creating[id]
		if !busy {
			if m.creating == nil {
				m.creating = make(map[string]chan struct{})
			}
			ch := make(chan struct{})
			m.creating[id] = ch
			m.mu.Unlock()
			return func() {
				m.mu.Lock()
				delete(m.creating, id)
				m.mu.Unlock()
				close(ch)
			}, false
		}
		m.mu.Unlock()
		<-inflight
	}
}

// Get returns a session by ID.
func (m *Manager) Get(id string) (*Runner, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	r, ok := m.sessions[id]
	return r, ok
}

// lookupOrRecover returns the registered runner for id, recovering it from
// tmux (daemon restart) when the table doesn't have it. The tmux query runs
// outside mu; the table is re-checked under the write lock so two concurrent
// attaches to the same unregistered session share one Runner instead of each
// installing their own (and fighting over the PTY epoch).
func (m *Manager) lookupOrRecover(id string) (*Runner, error) {
	m.mu.RLock()
	runner, ok := m.sessions[id]
	_, isChat := m.chats[id]
	m.mu.RUnlock()
	if isChat {
		return nil, ErrUIMismatch
	}
	if ok {
		return runner, nil
	}
	if !m.useTmux {
		return nil, sessionNotFound(id)
	}
	// Reconcile this one session from tmux before attaching, so Ready has the
	// persisted worktree metadata after a daemon restart.
	live, queryOK := m.liveTmuxSessions()
	if !queryOK {
		return nil, sessionNotFound(id)
	}
	info, exists := live[id]
	if !exists {
		return nil, sessionNotFound(id)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.sessions[id]; ok {
		return existing, nil
	}
	runner = m.recoveredRunner(id, info, time.Now())
	m.sessions[id] = runner
	m.gen++
	m.reclaimLocked(id, info.claudeU)
	return runner, nil
}

// Attach re-attaches to an existing session (reconnect after disconnect).
func (m *Manager) Attach(id string, cols, rows uint16) (*Runner, error) {
	if !m.useTmux {
		// Without tmux the CLI is the PTY's own child, and detaching killed it
		// (see reap). Report the session as gone rather than failing in a way
		// the client would keep retrying.
		return nil, fmt.Errorf("session %q did not survive the disconnect (tmux disabled): %w", id, ErrSessionNotFound)
	}
	runner, err := m.lookupOrRecover(id)
	if err != nil {
		return nil, err
	}
	if err := runner.AttachExisting(cols, rows); err != nil {
		return nil, err
	}
	return runner, nil
}

// syncFromTmux queries tmux outside mu and then reconciles the table under it.
// It returns the snapshot only if it was applied: when another goroutine
// mutated the table while the query was in flight, the snapshot may predate
// that change, so it is dropped (as if the query had failed) and the next poll
// reconciles from fresh data.
func (m *Manager) syncFromTmux() (map[string]tmuxSessionInfo, bool) {
	if !m.useTmux {
		return nil, false
	}
	m.mu.RLock()
	startGen := m.gen
	m.mu.RUnlock()

	live, ok := m.liveTmuxSessions()
	if !ok {
		return nil, false
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.gen != startGen {
		return nil, false
	}
	removed := reconcileTmuxSessions(m.sessions, live, time.Now(), m.recoveredRunner)
	// A terminal session's claim follows its tmux session: gone → released,
	// recovered after a daemon restart → claimed again (@vibe_remote_claude_u).
	for _, id := range removed {
		m.releaseOwnerLocked(id)
	}
	for id, info := range live {
		if _, ok := m.sessions[id]; ok {
			m.reclaimLocked(id, info.claudeU)
		}
	}
	return live, true
}

// Delete kills and removes a session. Worktree cleanup happens after the
// runner is stopped; dirty resources are intentionally preserved and surfaced.
func (m *Manager) Delete(id string) error {
	m.mu.RLock()
	entry := m.chats[id]
	m.mu.RUnlock()
	if entry != nil {
		return m.deleteChat(id, entry)
	}
	m.syncFromTmux()
	m.mu.RLock()
	runner, ok := m.sessions[id]
	m.mu.RUnlock()
	if !ok {
		return sessionNotFound(id)
	}

	runner.Kill()
	m.mu.Lock()
	m.releaseOwnerLocked(id) // its claude process is gone with the tmux session
	m.mu.Unlock()
	if meta := runner.Metadata(); meta.Mode == protocol.SessionModeWorktree {
		err := CleanupWorktree(WorktreeMetadata{
			SourceWorkdir: meta.SourceWorkdir,
			SourceRepo:    meta.SourceRepo,
			WorktreeRoot:  meta.WorktreeRoot,
			Branch:        meta.Branch,
		})
		if err != nil {
			return err
		}
	}
	m.mu.Lock()
	delete(m.sessions, id)
	m.releaseOwnerLocked(id)
	m.gen++
	m.mu.Unlock()
	return nil
}

// Rename sets a user display name on a session (persisted as a tmux option).
// An empty name clears the custom name, reverting to the default title rule.
func (m *Manager) Rename(id, name string) error {
	if m.renameChat(id, sanitizeSessionName(name)) {
		return nil
	}
	m.mu.RLock()
	runner, ok := m.sessions[id]
	m.mu.RUnlock()
	if !ok {
		return sessionNotFound(id)
	}
	return runner.SetName(sanitizeSessionName(name))
}

// Reload replaces the CLI process inside an existing tmux session. The tmux
// session itself remains alive, preserving its id, metadata and attached client.
//
// A session that holds a claude conversation (handed off from a chat session,
// or started with -c) keeps a fixed identity across the reload (design 6.9
// step 6): the conversation to resume is resolved and claimed, the old process
// is stopped and confirmed gone, then the new one starts; the old claim is
// held until then, and a failed start never releases it.
func (m *Manager) Reload(id, command string) error {
	if _, ok := m.ChatGet(id); ok {
		return m.ReloadChat(id)
	}
	if !m.useTmux {
		return ErrReloadRequiresTmux
	}
	m.syncFromTmux()
	m.mu.RLock()
	runner, ok := m.sessions[id]
	m.mu.RUnlock()
	if !ok {
		return sessionNotFound(id)
	}
	oldU := runner.ClaudeU()
	cmd, newU, fixed := m.terminalReloadPlan(id, runner, command, oldU)
	if !fixed {
		return runner.Reload(command)
	}
	newClaim := false
	if newU != oldU {
		if err := m.claimClaude(newU, id); err != nil {
			return err
		}
		newClaim = true
	}
	if err := runner.reloadStoppingFirst(cmd, m.testFailRespawn); err != nil {
		if newClaim {
			m.releaseClaude(newU, id)
		}
		return err
	}
	if newU != oldU {
		if err := runner.setClaudeU(newU); err != nil {
			log.Printf("session %s: persist @vibe_remote_claude_u: %v", id, err)
		}
		if oldU != "" {
			m.releaseClaude(oldU, id)
		}
	}
	return nil
}

// terminalReloadPlan decides a terminal reload's command and the claude
// conversation it runs. fixed=false keeps the plain reload (no conversation
// is involved).
func (m *Manager) terminalReloadPlan(id string, runner *Runner, command, oldU string) (cmd, u string, fixed bool) {
	pd := m.projectsDir()
	m.mu.RLock()
	var from *chat.Record
	for _, e := range m.chats {
		if e.rec.HandedOffTo == id {
			r := e.rec
			from = &r
		}
	}
	m.mu.RUnlock()
	if from != nil && oldU != "" {
		// Handed off from a chat session: always that conversation.
		_, found := chat.FindTranscript(pd, oldU)
		return chat.HandoffCommand(from.Exe, from.Args, oldU, found), oldU, true
	}
	p, reason := chat.ParseClaudeCmd(command)
	if reason != "" {
		return command, "", false
	}
	if p.Continue {
		u, found := chat.LatestSessionForWorkdir(pd, runner.CurrentWorkdir())
		if m.testAfterResolve != nil {
			m.testAfterResolve(runner.CurrentWorkdir())
		}
		if !found {
			if oldU != "" {
				u = oldU
				_, found = chat.FindTranscript(pd, u)
			} else {
				u = chat.NewUUID()
			}
		}
		return chat.HandoffCommand(p.Exe, p.Args, u, found), u, true
	}
	if oldU != "" {
		_, found := chat.FindTranscript(pd, oldU)
		return chat.HandoffCommand(p.Exe, p.Args, oldU, found), oldU, true
	}
	return command, "", false
}

func applyTmuxSessionMetadata(r *Runner, info tmuxSessionInfo) {
	r.metaMu.Lock()
	defer r.metaMu.Unlock()
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
	if r.claudeU == "" {
		r.claudeU = info.claudeU
	}
}

func completeTmuxWorktreeMetadata(info tmuxSessionInfo) bool {
	return protocol.SessionMode(info.mode) == protocol.SessionModeWorktree &&
		info.sourceWorkdir != "" && info.sourceRepo != "" && info.worktreeRoot != "" && info.branch != ""
}

// completeRunnerWorktreeMetadata expects the caller to hold r.metaMu.
func completeRunnerWorktreeMetadata(r *Runner) bool {
	return protocol.SessionMode(r.Mode) == protocol.SessionModeWorktree &&
		r.SourceWorkdir != "" && r.SourceRepo != "" && r.WorktreeRoot != "" && r.Branch != ""
}

// reconcileTmuxSessions updates the in-memory session table from tmux's live
// snapshot. Keeping this seam separate makes reconciliation testable without
// depending on a running tmux daemon. recover builds the entry for a session
// that tmux has but the table doesn't.
// It returns the ids it removed.
func reconcileTmuxSessions(sessions map[string]*Runner, live map[string]tmuxSessionInfo, now time.Time, recover func(id string, info tmuxSessionInfo, now time.Time) *Runner) (removed []string) {
	for id := range sessions {
		if _, alive := live[id]; !alive {
			delete(sessions, id)
			removed = append(removed, id)
		}
	}
	for id, info := range live {
		if r, exists := sessions[id]; exists {
			applyTmuxSessionMetadata(r, info)
			continue
		}
		sessions[id] = recover(id, info, now)
	}
	return removed
}

// List returns info for all sessions.
func (m *Manager) List() []protocol.SessionInfo {
	// In tmux mode, tmux is the source of truth for which sessions exist.
	// Query once (not per-session) so a transient failure can't wrongly evict
	// live sessions: on query failure we fall back to the in-memory list. The
	// query also brings back @vibe_remote_name, so Title assembly below needs no
	// extra per-session tmux exec. The query runs outside m.mu; only the
	// reconcile and the snapshot below hold it.
	live, haveLive := m.syncFromTmux()

	m.mu.Lock()
	runners := make([]*Runner, 0, len(m.sessions))
	for id, r := range m.sessions {
		runners = append(runners, r)
		if r.bareProcessGone() {
			// Without tmux the CLI is gone with its PTY; so is its claim.
			m.releaseOwnerLocked(id)
		}
	}
	m.mu.Unlock()

	list := make([]protocol.SessionInfo, 0, len(runners))
	for _, r := range runners {
		// Prefer the name from the batched tmux query; only fall back to a
		// per-session read if we couldn't batch it (query failed / not in the
		// live set). titleFrom applies the identical three-level fallback.
		name := ""
		if haveLive {
			name = live[r.ID].name
		} else if r.useTmux {
			name = r.readName()
		}
		workdir := r.CurrentWorkdir()
		list = append(list, protocol.SessionInfo{
			ID:              r.ID,
			Title:           titleFrom(name, workdir, r.ID),
			Workdir:         workdir,
			Created:         r.Created.Format(time.RFC3339),
			SessionMetadata: r.Metadata(),
		})
	}
	return append(list, m.listChats()...)
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

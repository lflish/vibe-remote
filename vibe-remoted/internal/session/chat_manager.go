package session

import (
	"errors"
	"fmt"
	"log"
	"sort"
	"sync"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// ChatConfig configures chat sessions (and the conversation lookups of -c
// terminal sessions).
type ChatConfig struct {
	// ProjectsDir is where claude keeps transcripts; "" = chat.ProjectsDir().
	ProjectsDir string
	// Env holds further KEY=VALUE pairs for every claude process this daemon
	// starts, chat or terminal (tests point claude at a private config dir).
	Env []string
}

// SetChatConfig sets the chat configuration; call before any session exists.
func (m *Manager) SetChatConfig(c ChatConfig) { m.chatCfg = c }

func (m *Manager) projectsDir() string {
	if m.chatCfg.ProjectsDir != "" {
		return m.chatCfg.ProjectsDir
	}
	return chat.ProjectsDir()
}

// chatEntry is a chat session and its stored metadata (rec is guarded by
// Manager.mu; status fields are filled from the session when persisting).
type chatEntry struct {
	sess *chat.Session
	rec  chat.Record
}

// ErrUIMismatch: the session exists but is of the other kind (terminal vs chat).
var ErrUIMismatch = errors.New("session is of a different ui kind")

// ErrClaudeSessionBusy matches every *ClaudeSessionBusyError.
var ErrClaudeSessionBusy = errors.New("claude session busy")

// ClaudeSessionBusyError: the claude conversation already runs in another
// session (R2).
type ClaudeSessionBusyError struct {
	ClaudeSessionID string
	Owner           string // session id, or "orphan:<pid>"
	OwnerName       string
}

func (e *ClaudeSessionBusyError) Error() string {
	return fmt.Sprintf("this claude conversation is already open in session %q", e.OwnerName)
}

// Is makes errors.Is(err, ErrClaudeSessionBusy) true.
func (e *ClaudeSessionBusyError) Is(target error) bool { return target == ErrClaudeSessionBusy }

// --- claims ---

// claimClaudeLocked gives conversation u to owner, which must happen before
// any claude process for u is started. Claiming again for the same owner
// succeeds; an orphan's claim lapses once its process is gone.
func (m *Manager) claimClaudeLocked(u, owner string) error {
	if cur, held := m.claudeOwners[u]; held && cur != owner {
		if o, ok := m.orphans[u]; !ok || cur != o.Owner() || !o.Gone() {
			return m.busyLocked(u, cur)
		}
		delete(m.orphans, u)
	}
	m.claudeOwners[u] = owner
	return nil
}

func (m *Manager) claimClaude(u, owner string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.claimClaudeLocked(u, owner)
}

func (m *Manager) releaseClaudeLocked(u, owner string) {
	if u != "" && m.claudeOwners[u] == owner {
		delete(m.claudeOwners, u)
	}
}

func (m *Manager) releaseClaude(u, owner string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.releaseClaudeLocked(u, owner)
}

// releaseOwnerLocked drops every claim of owner (session deleted or gone).
func (m *Manager) releaseOwnerLocked(owner string) {
	for u, o := range m.claudeOwners {
		if o == owner {
			delete(m.claudeOwners, u)
		}
	}
}

// reclaimLocked restores a terminal session's claim recorded in tmux.
func (m *Manager) reclaimLocked(id, u string) {
	if u == "" {
		return
	}
	if r := m.sessions[id]; r != nil && r.ClaudeU() == "" {
		r.setClaudeUMeta(u)
	}
	if err := m.claimClaudeLocked(u, id); err != nil {
		log.Printf("session %s: cannot reclaim claude conversation %s: %v", id, u, err)
	}
}

func (m *Manager) busyLocked(u, owner string) *ClaudeSessionBusyError {
	name := owner
	if e := m.chats[owner]; e != nil {
		name = titleFrom(e.rec.Name, e.rec.Workdir, owner)
	} else if r := m.sessions[owner]; r != nil {
		// The tmux name is not read here (no tmux under Manager.mu).
		name = titleFrom("", r.CurrentWorkdir(), owner)
	}
	return &ClaudeSessionBusyError{ClaudeSessionID: u, Owner: owner, OwnerName: name}
}

// --- create ---

// ChatCreateOptions holds parameters for a new chat session.
type ChatCreateOptions struct {
	ID      string // client-chosen id; replays attach (as Create)
	Workdir string // validated by the caller
	Mode    protocol.SessionMode
	Flags   []string    // selected claude_flags ids (stored)
	Parsed  chat.Parsed // claude_cmd plus flags, parsed and checked by the caller
	// ValidateWorkdir re-checks a worktree's path (see CreateOptions).
	ValidateWorkdir func(string) (string, error)
}

// ChatAttachment is the result of CreateChat.
type ChatAttachment struct {
	Session *chat.Session
	ID      string
	// Existing: the create continued (-c) a conversation that already runs
	// in session ID, which is returned instead of starting another (R2.6).
	Existing bool
}

// ChatGet returns a chat session.
func (m *Manager) ChatGet(id string) (*chat.Session, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if e := m.chats[id]; e != nil {
		return e.sess, true
	}
	return nil, false
}

// chatAttachExisting resolves a create replay of an id that already exists.
func (m *Manager) chatAttachExisting(id string) (ChatAttachment, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if e := m.chats[id]; e != nil {
		return ChatAttachment{Session: e.sess, ID: id}, nil
	}
	if _, ok := m.sessions[id]; ok {
		return ChatAttachment{}, ErrUIMismatch
	}
	return ChatAttachment{}, sessionNotFound(id)
}

// CreateChat starts a chat session (design 6.2). With a client-chosen id it
// is idempotent like Create. Exactly one claude process ever runs a given
// conversation: a -c create whose conversation already runs in chat session X
// returns X (Existing), and one held by a terminal session fails with
// ErrClaudeSessionBusy.
func (m *Manager) CreateChat(opts ChatCreateOptions) (ChatAttachment, error) {
	id := opts.ID
	if id == "" {
		id = generateID()
	} else {
		if !ValidSessionID(id) {
			return ChatAttachment{}, ErrInvalidSessionID
		}
		done, exists := m.beginCreate(id)
		if exists {
			return m.chatAttachExisting(id)
		}
		defer done()
		if m.useTmux {
			// A terminal session the table lost track of (daemon restart).
			if _, err := m.lookupOrRecover(id); err == nil {
				return ChatAttachment{}, ErrUIMismatch
			}
		}
	}
	mode := opts.Mode
	if mode == "" {
		mode = protocol.SessionModeNormal
	}
	if mode != protocol.SessionModeNormal && mode != protocol.SessionModeWorktree {
		return ChatAttachment{}, fmt.Errorf("unknown session mode %q", mode)
	}

	// The conversation: -c continues the workdir's latest one (a new
	// worktree has none), anything else starts a new one.
	u := ""
	if opts.Parsed.Continue && mode == protocol.SessionModeNormal {
		u, _ = chat.LatestSessionForWorkdir(m.projectsDir(), opts.Workdir)
	}
	if u == "" {
		u = chat.NewUUID()
	}
	for {
		m.mu.Lock()
		err := m.claimClaudeLocked(u, id)
		if err == nil {
			m.mu.Unlock()
			break
		}
		owner := m.claudeOwners[u]
		if e := m.chats[owner]; e != nil {
			m.mu.Unlock()
			return ChatAttachment{Session: e.sess, ID: owner, Existing: true}, nil
		}
		if ch, creating := m.creating[owner]; creating {
			m.mu.Unlock()
			<-ch // the owner is still being created; ask again when it is done
			continue
		}
		m.mu.Unlock()
		return ChatAttachment{}, err
	}

	workdir := opts.Workdir
	var meta WorktreeMetadata
	if mode == protocol.SessionModeWorktree {
		var err error
		meta, workdir, err = CreateWorktree(opts.Workdir, id)
		if err != nil {
			m.releaseClaude(u, id)
			return ChatAttachment{}, err
		}
		if opts.ValidateWorkdir != nil {
			if _, err := opts.ValidateWorkdir(workdir); err != nil {
				m.releaseClaude(u, id)
				err = fmt.Errorf("worktree workdir %q: %w", workdir, err)
				if rollbackErr := RollbackWorktree(meta); rollbackErr != nil {
					return ChatAttachment{}, fmt.Errorf("%v; rollback worktree: %w", err, rollbackErr)
				}
				return ChatAttachment{}, err
			}
		}
	}
	rec := chat.Record{
		ID: id, Workdir: workdir, Mode: string(mode),
		SourceWorkdir: meta.SourceWorkdir, SourceRepo: meta.SourceRepo, WorktreeRoot: meta.WorktreeRoot, Branch: meta.Branch,
		Flags: opts.Flags, Exe: opts.Parsed.Exe, Args: opts.Parsed.Args, ClaudeSessionID: u,
		PermissionLocked: opts.Parsed.Bypass, PermissionMode: opts.Parsed.PermissionMode,
		CreatedAt: time.Now().UTC().Format(time.RFC3339), Status: chat.StatusRunning,
	}
	sess, err := chat.Start(m.chatSpec(rec))
	if err != nil {
		m.releaseClaude(u, id)
		err = fmt.Errorf("start claude: %w", err)
		if mode == protocol.SessionModeWorktree {
			if rollbackErr := RollbackWorktree(meta); rollbackErr != nil {
				return ChatAttachment{}, fmt.Errorf("%v; rollback worktree: %w", err, rollbackErr)
			}
		}
		return ChatAttachment{}, err
	}
	m.mu.Lock()
	m.chats[id] = &chatEntry{sess: sess, rec: rec}
	m.gen++
	m.persistLocked()
	m.mu.Unlock()
	return ChatAttachment{Session: sess, ID: id}, nil
}

// chatEnv is a chat process's environment: the daemon's (UTF-8 locale
// guaranteed) plus the session's VIBE_REMOTE_* — the hook token, never the
// main token. chat.Start strips claude's nested-session guards.
func (m *Manager) chatEnv(id string) []string {
	r := Runner{ID: id, eventsURL: m.eventsURL, hookToken: m.hookTokenFor(id)}
	env := utf8Env(r.vibeRemoteEnv()...)
	return append(env, m.chatCfg.Env...)
}

func (m *Manager) chatSpec(rec chat.Record) chat.Spec {
	id := rec.ID
	return chat.Spec{
		ID: id, Workdir: rec.Workdir, Exe: rec.Exe, Args: rec.Args, ClaudeSessionID: rec.ClaudeSessionID,
		LoginShell: m.loginShell, Shell: m.shell, Env: m.chatEnv(id), ProjectsDir: m.projectsDir(),
		Lock: rec.PermissionLocked, PermissionMode: rec.PermissionMode,
		Hooks: chat.Hooks{
			Claim:  func(u string) error { return m.claimClaude(u, id) },
			OnExit: m.onChatExit,
		},
	}
}

// onChatExit runs on its own goroutine after a chat process ended: release
// the conversation (except between the two halves of a restart) and persist.
func (m *Manager) onChatExit(ev chat.ExitEvent) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id := ev.Session.ID()
	if ev.Release {
		m.releaseClaudeLocked(ev.ClaudeSessionID, id)
	}
	if e := m.chats[id]; e != nil && e.sess == ev.Session {
		if ev.Release {
			e.rec.EndedAt = time.Now().UTC().Format(time.RFC3339)
		}
		m.persistLocked()
	}
}

// --- list, rename, delete, reload ---

func (m *Manager) chatInfo(id string) protocol.SessionMetadata {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if e := m.chats[id]; e != nil {
		return chatMetadata(e.rec)
	}
	return protocol.SessionMetadata{}
}

func chatMetadata(rec chat.Record) protocol.SessionMetadata {
	mode := protocol.SessionMode(rec.Mode)
	if mode == "" {
		mode = protocol.SessionModeNormal
	}
	return protocol.SessionMetadata{Mode: mode, SourceWorkdir: rec.SourceWorkdir, SourceRepo: rec.SourceRepo,
		WorktreeRoot: rec.WorktreeRoot, Branch: rec.Branch}
}

// ChatMetadata returns a chat session's working directory and metadata.
func (m *Manager) ChatMetadata(id string) (workdir string, meta protocol.SessionMetadata, ok bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	e := m.chats[id]
	if e == nil {
		return "", protocol.SessionMetadata{}, false
	}
	return e.rec.Workdir, chatMetadata(e.rec), true
}

// listChats returns the chat entries of List (design 4.8).
func (m *Manager) listChats() []protocol.SessionInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]protocol.SessionInfo, 0, len(m.chats))
	for id, e := range m.chats {
		info := e.sess.Snapshot()
		si := protocol.SessionInfo{
			ID: id, Title: titleFrom(e.rec.Name, e.rec.Workdir, id), Workdir: e.rec.Workdir,
			Created: e.rec.CreatedAt, SessionMetadata: chatMetadata(e.rec),
			UI: protocol.UIChat, State: info.Status, ActivitySeq: info.Seq, Epoch: info.Epoch,
		}
		if info.Ended != nil && info.Status == protocol.ChatStatusEnded {
			si.EndReason = info.Ended.Reason
		}
		out = append(out, si)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (m *Manager) renameChat(id, name string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.chats[id]
	if e == nil {
		return false
	}
	e.rec.Name = name
	m.persistLocked()
	return true
}

// deleteChat stops the process, removes the record and cleans the worktree
// (unless a terminal session took it over). The transcript stays (R15.2).
func (m *Manager) deleteChat(id string, e *chatEntry) error {
	var err error
	e.sess.WithOp(func(ops chat.OpHandle) {
		m.mu.RLock()
		cur := m.chats[id]
		m.mu.RUnlock()
		if cur != e {
			err = sessionNotFound(id)
			return
		}
		_ = ops.StopLocked(protocol.EndReasonStopped)
		m.mu.Lock()
		rec := e.rec
		delete(m.chats, id)
		m.releaseOwnerLocked(id)
		m.gen++
		m.persistLocked()
		m.mu.Unlock()
		e.sess.Close()
		if protocol.SessionMode(rec.Mode) == protocol.SessionModeWorktree && !rec.WorktreeHandedOff {
			err = CleanupWorktree(WorktreeMetadata{SourceWorkdir: rec.SourceWorkdir, SourceRepo: rec.SourceRepo,
				WorktreeRoot: rec.WorktreeRoot, Branch: rec.Branch})
		}
	})
	return err
}

// ReloadChat restarts a chat session's claude process on the same
// conversation (R15.3, design 4.9). The checks run now, under Manager.mu
// only; the restart itself runs in the background and reports through
// chat_state, so the caller answers 202 at once. A second request while one
// is in progress is accepted without a second restart.
func (m *Manager) ReloadChat(id string) error {
	m.syncFromTmux() // a restarted daemon learns terminal claims from tmux
	m.mu.Lock()
	e := m.chats[id]
	if e == nil {
		m.mu.Unlock()
		return sessionNotFound(id)
	}
	u := e.rec.ClaudeSessionID
	if owner, held := m.claudeOwners[u]; held && owner != id {
		if o, ok := m.orphans[u]; ok && owner == o.Owner() && o.Gone() {
			delete(m.orphans, u)
			delete(m.claudeOwners, u)
		} else {
			err := m.busyLocked(u, owner)
			m.mu.Unlock()
			return err
		}
	}
	if !e.sess.BeginReload() {
		m.mu.Unlock()
		return nil
	}
	handedOff := e.rec.HandedOffTo
	m.mu.Unlock()

	go e.sess.WithOp(func(ops chat.OpHandle) {
		defer e.sess.EndReload()
		m.mu.RLock()
		cur := m.chats[id]
		nowHandedOff := e.rec.HandedOffTo
		m.mu.RUnlock()
		switch {
		case cur != e:
			return // deleted meanwhile
		case nowHandedOff != handedOff:
			e.sess.BroadcastState() // handed off meanwhile: nothing to restart
			return
		}
		if err := ops.RestartLocked(); err != nil {
			log.Printf("chat %s: reload: %v", id, err)
		}
		m.mu.Lock()
		if e.sess.Snapshot().Status != protocol.ChatStatusEnded {
			e.rec.HandedOffTo = ""
			e.rec.EndedAt = ""
		}
		m.persistLocked()
		m.mu.Unlock()
	})
	return nil
}

// --- daemon start and stop ---

// LoadChats reads the chat table at daemon start. Records whose process
// belonged to the previous daemon become ended/daemon_restart after any
// leftover process is stopped (Q2=A); a process that would not die keeps its
// conversation claimed as an orphan. Terminal sessions' claims come back from
// tmux.
func (m *Manager) LoadChats(store *chat.Store) error {
	recs, err := store.Load()
	if err != nil {
		return err
	}
	recs, orphans := m.orphanCleanup(recs)
	m.mu.Lock()
	m.store = store
	m.persist.start(store)
	for _, r := range recs {
		var ended *protocol.ChatEnded
		if r.Status != chat.StatusRunning {
			ended = &protocol.ChatEnded{Reason: r.EndReason, HandedOffTo: r.HandedOffTo}
			if r.EndReason == protocol.EndReasonExited {
				code := r.ExitCode
				ended.Code = &code
			}
		}
		m.chats[r.ID] = &chatEntry{sess: chat.Load(m.chatSpec(r), ended), rec: r}
	}
	for _, o := range orphans {
		m.claudeOwners[o.ClaudeSessionID] = o.Owner()
		m.orphans[o.ClaudeSessionID] = o
	}
	m.gen++
	m.persistLocked()
	m.mu.Unlock()
	m.syncFromTmux()
	return nil
}

// Shutdown stops every chat process (they cannot outlive the daemon, Q2=A)
// within timeout and writes the table a final time.
func (m *Manager) Shutdown(timeout time.Duration) {
	m.mu.RLock()
	entries := make([]*chatEntry, 0, len(m.chats))
	for _, e := range m.chats {
		entries = append(entries, e)
	}
	m.mu.RUnlock()
	var wg sync.WaitGroup
	for _, e := range entries {
		wg.Add(1)
		go func(e *chatEntry) {
			defer wg.Done()
			e.sess.WithOp(func(ops chat.OpHandle) { _ = ops.StopLocked(protocol.EndReasonDaemonRestart) })
		}(e)
	}
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		log.Printf("chat: some claude processes did not stop within %v", timeout)
	}
	m.persist.stop()
	m.flush()
}

// --- persistence ---

// persister writes chat-sessions.json on one goroutine; a newer snapshot
// replaces one not written yet, and an older one is never written after a
// newer (design 2, "持久化单通道").
type persister struct {
	store   *chat.Store
	slot    chan versioned
	quit    chan struct{}
	done    chan struct{}
	once    sync.Once
	version uint64 // guarded by Manager.mu

	saveMu sync.Mutex
	saved  uint64
}

type versioned struct {
	v    uint64
	recs []chat.Record
}

func (p *persister) start(store *chat.Store) {
	p.store = store
	p.slot = make(chan versioned, 1)
	p.quit = make(chan struct{})
	p.done = make(chan struct{})
	go func() {
		defer close(p.done)
		for {
			select {
			case s := <-p.slot:
				p.save(s)
			case <-p.quit:
				return
			}
		}
	}()
}

func (p *persister) save(s versioned) {
	p.saveMu.Lock()
	defer p.saveMu.Unlock()
	if s.v <= p.saved {
		return
	}
	if err := p.store.Save(s.recs); err != nil {
		log.Printf("chat: save %s: %v", p.store.Path(), err)
		return
	}
	p.saved = s.v
}

func (p *persister) stop() {
	if p.quit == nil {
		return
	}
	p.once.Do(func() { close(p.quit) })
	<-p.done
}

// persistLocked queues the current table for writing; never blocks.
func (m *Manager) persistLocked() {
	if m.store == nil {
		return
	}
	m.persist.version++
	s := versioned{v: m.persist.version, recs: m.recordsLocked()}
	select {
	case <-m.persist.slot:
	default:
	}
	m.persist.slot <- s
}

// flush writes the current table now (shutdown; tests).
func (m *Manager) flush() {
	m.mu.Lock()
	if m.store == nil {
		m.mu.Unlock()
		return
	}
	m.persist.version++
	s := versioned{v: m.persist.version, recs: m.recordsLocked()}
	m.mu.Unlock()
	m.persist.save(s)
}

func (m *Manager) recordsLocked() []chat.Record {
	out := make([]chat.Record, 0, len(m.chats))
	for _, e := range m.chats {
		r := e.rec
		info := e.sess.Snapshot()
		if info.Status == protocol.ChatStatusEnded {
			r.Status, r.Pid = chat.StatusEnded, 0
			if info.Ended != nil {
				r.EndReason = info.Ended.Reason
				if info.Ended.Code != nil {
					r.ExitCode = *info.Ended.Code
				}
				if info.Ended.HandedOffTo != "" {
					r.HandedOffTo = info.Ended.HandedOffTo
				}
			}
			if r.EndedAt == "" {
				r.EndedAt = time.Now().UTC().Format(time.RFC3339)
			}
		} else {
			r.Status, r.Pid, r.EndReason, r.EndedAt, r.ExitCode = chat.StatusRunning, info.Pid, "", "", 0
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt != out[j].CreatedAt {
			return out[i].CreatedAt < out[j].CreatedAt
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// --- handoff ---

// Handoff moves chat session chatID's conversation to a new terminal session
// newID running `claude --resume U` (design 6.5, R14). It is idempotent like
// Create: a replay of newID attaches to the session the first attempt made,
// and a chat already handed off to a live terminal session returns that one.
// The chat process is stopped (its turn interrupted first) before the
// terminal's claude starts, and the terminal session holds U from then on.
func (m *Manager) Handoff(chatID, newID string, cols, rows uint16) (*Runner, error) {
	if newID == "" {
		newID = generateID()
	} else {
		if !ValidSessionID(newID) {
			return nil, ErrInvalidSessionID
		}
		done, exists := m.beginCreate(newID)
		if exists {
			return m.Attach(newID, cols, rows)
		}
		// Held until the end: the new terminal session is created under this
		// placeholder (createTerminalLocked), never through beginCreate again.
		defer done()
	}
	m.mu.RLock()
	e := m.chats[chatID]
	m.mu.RUnlock()
	if e == nil {
		return nil, sessionNotFound(chatID)
	}
	var runner *Runner
	var err error
	e.sess.WithOp(func(ops chat.OpHandle) {
		m.mu.RLock()
		cur := m.chats[chatID]
		rec := e.rec
		m.mu.RUnlock()
		if cur != e {
			err = sessionNotFound(chatID)
			return
		}
		if rec.HandedOffTo != "" {
			if r, aerr := m.Attach(rec.HandedOffTo, cols, rows); aerr == nil {
				runner = r
				return
			}
		}
		_ = ops.StopLocked(protocol.EndReasonStopped) // releases U before returning
		u := rec.ClaudeSessionID
		if err = m.claimClaude(u, newID); err != nil {
			return
		}
		_, found := chat.FindTranscript(m.projectsDir(), u)
		opts := CreateOptions{
			Workdir: rec.Workdir, Mode: protocol.SessionMode(rec.Mode), Cols: cols, Rows: rows,
			ClaudeCmdOverride: chat.HandoffCommand(rec.Exe, rec.Args, u, found), ClaudeU: u,
		}
		worktree := protocol.SessionMode(rec.Mode) == protocol.SessionModeWorktree
		if worktree {
			// The terminal session takes the worktree over; deleting the chat
			// later leaves it alone.
			opts.Worktree = &WorktreeMetadata{SourceWorkdir: rec.SourceWorkdir, SourceRepo: rec.SourceRepo,
				WorktreeRoot: rec.WorktreeRoot, Branch: rec.Branch}
		}
		if runner, err = m.createTerminalLocked(newID, opts); err != nil {
			m.releaseClaude(u, newID)
			runner = nil
			return
		}
		m.mu.Lock()
		e.rec.HandedOffTo = newID
		if worktree {
			e.rec.WorktreeHandedOff = true
		}
		m.persistLocked()
		m.mu.Unlock()
		e.sess.SetHandedOff(newID)
	})
	return runner, err
}

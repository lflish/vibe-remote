package session

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// AllowFunc resolves path (following symlinks) and returns its canonical form,
// or an error when it is outside the allowed roots. The server passes
// cfg.ResolveAllowedWorkdir (design 4.9).
type AllowFunc func(path string) (canonical string, err error)

var (
	// ErrProjectNotFound is returned by RemoveProject for an unknown id.
	ErrProjectNotFound = errors.New("project_not_found")
	// ErrProjectHasSessions is returned by RemoveProject when sessions still
	// belong to the project.
	ErrProjectHasSessions = errors.New("project_has_sessions")
)

// projectsGitConcurrency bounds the simultaneous `git worktree list` calls.
const projectsGitConcurrency = 8

// SetProjectStore attaches the persistent project list.
func (m *Manager) SetProjectStore(s *ProjectStore) { m.projectStore = s }

// sessAttr is a session reduced to what the project tree needs.
type sessAttr struct {
	id      string
	project string
	home    string
	workdir string
	created time.Time
}

// Projects returns this machine's project tree (design 4.2). It reconciles with
// tmux first, backfills missing attribution, then runs one `git worktree list`
// per project (at most projectsGitConcurrency at once, none under Manager.mu)
// and groups sessions under their worktree.
func (m *Manager) Projects(allow AllowFunc) []protocol.Project {
	m.syncFromTmux()
	sessions := m.collectSessions()

	inStore := map[string]bool{}
	if m.projectStore != nil {
		for _, id := range m.projectStore.Projects() {
			inStore[id] = true
		}
	}
	// Candidate project ids: the stored list plus every session's project (its
	// workdir when attribution is still unresolved → a temporary project).
	candidates := map[string]bool{}
	for id := range inStore {
		candidates[id] = true
	}
	byProject := map[string][]sessAttr{}
	for _, s := range sessions {
		key := s.project
		if key == "" {
			key = s.workdir
		}
		candidates[key] = true
		byProject[key] = append(byProject[key], s)
	}

	// Snapshot the worktree records before reading any list, so a record whose
	// `git worktree add` finished after the snapshot is never pruned (design
	// 5.2). The test hook runs in the gap.
	var recSnapshot []WorktreeRecord
	if m.projectStore != nil {
		recSnapshot = m.projectStore.Worktrees()
	}
	if m.testAfterWorktreeSnapshot != nil {
		m.testAfterWorktreeSnapshot()
	}

	lists := m.listWorktreesConcurrently(candidates)

	// Build each project.
	projects := make([]protocol.Project, 0, len(candidates))
	for id := range candidates {
		p := m.buildProject(id, inStore[id], lists[id], byProject[id], allow)
		if !p.Git && len(byProject[id]) == 0 {
			// A listed id that is not a repository's main directory (any more)
			// and has no session: a non-git project is gone with its sessions.
			continue
		}
		// A git project discovered only through its sessions joins the store so
		// it survives after those sessions end (design 5.4, H18).
		if m.projectStore != nil && p.Git && p.Error == "" && !inStore[id] {
			m.projectStore.AddProject(id)
		}
		projects = append(projects, p)
	}

	// Drop stale records: those in the snapshot whose project's list was read
	// this round and no longer has the path (someone else removed the worktree).
	// A record whose project was not read — it is not in the project list and
	// has no session right now — or whose list failed to read is kept: not
	// having looked is not the worktree being gone, and a dropped record turns
	// the worktree "external" for good. The test is git's own list, not the rows
	// shown, which also leave out what the allowed roots do not cover.
	// RemoveWorktreeIfSame leaves a record that was replaced since the snapshot
	// alone.
	if m.projectStore != nil {
		for _, rec := range recSnapshot {
			res, read := lists[rec.Project]
			if !read || res.err != nil {
				continue
			}
			if !listsWorktreeDir(res.wts, rec.Path) {
				m.projectStore.RemoveWorktreeIfSame(rec)
			}
		}
	}

	sortProjects(projects)
	return projects
}

// buildProject classifies one project id and attaches its sessions.
func (m *Manager) buildProject(id string, inStore bool, res listResult, sess []sessAttr, allow AllowFunc) protocol.Project {
	p := protocol.Project{ID: id, Name: baseName(id), Worktrees: []protocol.ProjectWorktree{}, Sessions: []string{}}
	sortSessions(sess)

	if res.err != nil {
		if inStore {
			p.Git = true
			if _, statErr := os.Stat(id); os.IsNotExist(statErr) {
				p.Error = "repo_missing"
			} else {
				p.Error = "git_failed"
				p.ErrorMessage = firstLine(res.err)
			}
		}
		// git_failed / repo_missing / non-git: every session sits at the project level.
		for _, s := range sess {
			p.Sessions = append(p.Sessions, s.id)
		}
		return p
	}

	wts := res.wts
	single := len(wts) > 0 && !wts[0].Bare && !hasDotGit(wts[0].Path)
	// git answers from anywhere inside a repository, so a list alone does not
	// make id a project: it has to be what the list is the list of — the main
	// directory (the first entry), or, where there is none to recognize, a work
	// tree's own top. A session's plain directory that a repository later grew
	// around is neither: it stays the non-git project it was created as, and
	// the repository's real main directory is not shown under it.
	if (!single && len(wts) > 0 && wts[0].Path != id) || (single && !hasDotGit(id)) {
		for _, s := range sess {
			p.Sessions = append(p.Sessions, s.id)
		}
		return p
	}
	p.Git = true
	if single {
		// No recognizable main worktree (submodule, --separate-git-dir): the
		// project is this id alone, as a single main worktree (design 4.2).
		entry := wts[0]
		for _, w := range wts {
			if w.Path == id {
				entry = w
				break
			}
		}
		main := protocol.ProjectWorktree{Path: id, Head: shortHead(entry.Head), Main: true, Sessions: []string{}}
		if !entry.Detached {
			main.Branch = entry.Branch
		} else {
			main.Detached = true
		}
		p.Worktrees = []protocol.ProjectWorktree{main}
	} else {
		for _, wt := range wts {
			if wt.Prunable || wt.Bare {
				continue
			}
			if allow != nil {
				if _, err := allow(wt.Path); err != nil {
					continue
				}
			}
			pw := protocol.ProjectWorktree{Path: wt.Path, Head: shortHead(wt.Head), Sessions: []string{}}
			if wt.Detached {
				pw.Detached = true
			} else {
				pw.Branch = wt.Branch
			}
			if wt.Path == id {
				pw.Main = true
			} else if m.projectStore != nil {
				pw.Managed = m.projectStore.Managed(id, wt.Path, wt.Branch)
			}
			p.Worktrees = append(p.Worktrees, pw)
		}
	}

	// Attach sessions to the worktree they sit in; the rest sit at the project
	// level (R2.5: the worktree is gone from the list).
	for _, s := range sess {
		placed := false
		for i := range p.Worktrees {
			if p.Worktrees[i].Path == s.home {
				p.Worktrees[i].Sessions = append(p.Worktrees[i].Sessions, s.id)
				placed = true
				break
			}
		}
		if !placed {
			p.Sessions = append(p.Sessions, s.id)
		}
	}
	return p
}

// listsWorktreeDir reports whether wts has a worktree at path whose directory
// is still there.
func listsWorktreeDir(wts []Worktree, path string) bool {
	for _, wt := range wts {
		if wt.Path == path && !wt.Prunable {
			return true
		}
	}
	return false
}

type listResult struct {
	wts []Worktree
	err error
}

func (m *Manager) listWorktreesConcurrently(ids map[string]bool) map[string]listResult {
	results := make(map[string]listResult, len(ids))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, projectsGitConcurrency)
	for id := range ids {
		id := id
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			wts, err := ListWorktrees(id)
			mu.Lock()
			results[id] = listResult{wts: wts, err: err}
			mu.Unlock()
		}()
	}
	wg.Wait()
	return results
}

// recLite is a chat record reduced to the fields Projects needs.
type recLite struct {
	id, project, home, workdir, createdAt, mode, worktreeRoot, sourceRepo string
}

// collectSessions snapshots all sessions and backfills any missing attribution
// (design 5.4), writing resolved values back to tmux / the chat record.
func (m *Manager) collectSessions() []sessAttr {
	m.mu.RLock()
	runners := make([]*Runner, 0, len(m.sessions))
	for _, r := range m.sessions {
		runners = append(runners, r)
	}
	recs := make([]recLite, 0, len(m.chats))
	for _, e := range m.chats {
		recs = append(recs, recLite{
			id: e.rec.ID, project: e.rec.Project, home: e.rec.Home, workdir: e.rec.Workdir,
			createdAt: e.rec.CreatedAt, mode: e.rec.Mode, worktreeRoot: e.rec.WorktreeRoot, sourceRepo: e.rec.SourceRepo,
		})
	}
	m.mu.RUnlock()

	out := make([]sessAttr, 0, len(runners)+len(recs))
	for _, r := range runners {
		p, h := r.Home()
		if p == "" && h == "" {
			p, h = m.backfillTerminal(r)
		}
		out = append(out, sessAttr{id: r.ID, project: p, home: h, workdir: r.CurrentWorkdir(), created: r.Created})
	}
	for _, rec := range recs {
		p, h := rec.project, rec.home
		if p == "" && h == "" {
			if np, nh, ok := resolveRecordHome(rec); ok {
				p, h = np, nh
				m.backfillChatHome(rec.id, np, nh)
			}
		}
		out = append(out, sessAttr{id: rec.id, project: p, home: h, workdir: rec.workdir, created: parseCreated(rec.createdAt)})
	}
	return out
}

// backfillTerminal resolves and persists a terminal session's attribution.
func (m *Manager) backfillTerminal(r *Runner) (project, home string) {
	meta := r.Metadata()
	if meta.Mode == protocol.SessionModeWorktree && meta.WorktreeRoot != "" {
		home = meta.WorktreeRoot
		if h, err := ResolveHome(meta.WorktreeRoot); err == nil {
			project = h.Project
		} else if meta.SourceRepo != "" {
			if h, err := ResolveHome(meta.SourceRepo); err == nil {
				project = h.Project
				if h.Single {
					project = meta.WorktreeRoot
				}
			}
		}
		if project == "" {
			return "", "" // unresolved: retry next round
		}
		r.backfillHome(project, home)
		return project, home
	}
	h, err := ResolveHome(r.CurrentWorkdir())
	if err != nil {
		return "", ""
	}
	r.backfillHome(h.Project, h.Path)
	return h.Project, h.Path
}

func (m *Manager) backfillChatHome(id, project, home string) {
	m.mu.Lock()
	if e := m.chats[id]; e != nil {
		e.rec.Project = project
		e.rec.Home = home
		m.persistLocked()
	}
	m.mu.Unlock()
}

func resolveRecordHome(rec recLite) (project, home string, ok bool) {
	if protocol.SessionMode(rec.mode) == protocol.SessionModeWorktree && rec.worktreeRoot != "" {
		home = rec.worktreeRoot
		if h, err := ResolveHome(rec.worktreeRoot); err == nil {
			project = h.Project
		} else if rec.sourceRepo != "" {
			if h, err := ResolveHome(rec.sourceRepo); err == nil {
				project = h.Project
				if h.Single {
					project = rec.worktreeRoot
				}
			}
		}
		if project == "" {
			return "", "", false
		}
		return project, home, true
	}
	h, err := ResolveHome(rec.workdir)
	if err != nil {
		return "", "", false
	}
	return h.Project, h.Path, true
}

// RemoveProject drops a project from the list; it fails if the project is
// unknown or still has sessions (design 4.3). The disk is untouched.
func (m *Manager) RemoveProject(id string) error {
	if m.projectStore == nil {
		return ErrProjectNotFound
	}
	found := false
	for _, p := range m.projectStore.Projects() {
		if p == id {
			found = true
			break
		}
	}
	if !found {
		return ErrProjectNotFound
	}
	for _, s := range m.collectSessions() {
		key := s.project
		if key == "" {
			key = s.workdir
		}
		if key == id {
			return ErrProjectHasSessions
		}
	}
	if !m.projectStore.RemoveProject(id) {
		return ErrProjectNotFound
	}
	return nil
}

// within reports whether dir is root or lies below it.
func within(root, dir string) bool {
	return dir == root || strings.HasPrefix(dir, root+string(filepath.Separator))
}

// beginStart registers workdir as a directory a session is about to start in,
// and returns the func that ends the registration. It is called once the
// workdir is settled and before any process starts; done is called once the
// session is in the table, or the create has failed and cleaned up. A removal
// therefore finds a session of its worktree either here or in the table.
// ErrWorktreeBusy: the workdir is in a worktree that is being removed.
func (m *Manager) beginStart(workdir string) (done func(), err error) {
	m.mu.Lock()
	for root := range m.removingRoots {
		if within(root, workdir) {
			m.mu.Unlock()
			return nil, fmt.Errorf("%w: %s", ErrWorktreeBusy, root)
		}
	}
	if m.startingDirs == nil {
		m.startingDirs = make(map[string]int)
	}
	m.startingDirs[workdir]++
	m.mu.Unlock()
	var once sync.Once
	done = func() {
		once.Do(func() {
			m.mu.Lock()
			if m.startingDirs[workdir]--; m.startingDirs[workdir] <= 0 {
				delete(m.startingDirs, workdir)
			}
			m.mu.Unlock()
		})
	}
	// A removal that finished just before the registration took the directory
	// with it.
	if _, statErr := os.Stat(workdir); os.IsNotExist(statErr) {
		done()
		return nil, fmt.Errorf("working directory %s does not exist", workdir)
	}
	return done, nil
}

// locateWorktree is the first step of looking at or removing a worktree
// (design 6.2 step 1). path must be the canonical path of a worktree root
// inside the allowed roots; anything else is ErrWorktreeNotFound, decided
// before git is run on it. An error that is not ErrWorktreeNotFound is a git
// failure.
func locateWorktree(path string, allow AllowFunc) (Home, error) {
	if allow == nil || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return Home{}, ErrWorktreeNotFound
	}
	if canonical, err := allow(path); err != nil || canonical != path {
		return Home{}, ErrWorktreeNotFound
	}
	home, err := ResolveHome(path)
	if err != nil {
		if !errors.Is(err, context.DeadlineExceeded) && orphanedWorktreeDir(path) {
			return Home{}, ErrWorktreeNotFound
		}
		return Home{}, fmt.Errorf("read repository: %w", err)
	}
	if !home.Git || home.Path != path {
		return Home{}, ErrWorktreeNotFound
	}
	return home, nil
}

// orphanedWorktreeDir reports whether dir is what a half-finished removal
// leaves behind: a linked worktree's directory whose .git file still names an
// administrative directory that git has already deleted. git cannot read such
// a directory, and no repository lists it any more.
func orphanedWorktreeDir(dir string) bool {
	dotGit := filepath.Join(dir, ".git")
	info, err := os.Lstat(dotGit)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
		return false
	}
	data, err := os.ReadFile(dotGit)
	if err != nil {
		return false
	}
	target, ok := strings.CutPrefix(strings.TrimSpace(string(data)), "gitdir: ")
	if !ok || target == "" {
		return false
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(dir, target)
	}
	_, err = os.Stat(target)
	return os.IsNotExist(err)
}

// listedWorktree reads the repository's worktree list and returns it with the
// index of the entry for path. Only an entry the repository itself lists, with
// its directory still there, counts; anything else is ErrWorktreeNotFound.
func listedWorktree(home Home, path string) ([]Worktree, int, error) {
	wts, err := ListWorktrees(home.Repo)
	if err != nil {
		return nil, 0, fmt.Errorf("list worktrees: %w", err)
	}
	for i, wt := range wts {
		if wt.Path == path && !wt.Prunable && !wt.Bare {
			return wts, i, nil
		}
	}
	return nil, 0, ErrWorktreeNotFound
}

// sessionsIn returns the ids of the sessions that lose their directory when
// the worktree at root goes (design 6.2 step 3): those attributed to it, and
// those whose workdir is in it whatever they are attributed to — no
// attribution yet, or a repository of its own nested in the worktree. The
// workdir test is the one beginStart and markRemoving apply. Oldest first.
func (m *Manager) sessionsIn(root string) []string {
	var in []sessAttr
	for _, s := range m.collectSessions() {
		if (s.home != "" && within(root, s.home)) || within(root, s.workdir) {
			in = append(in, s)
		}
	}
	sortSessions(in)
	ids := make([]string, 0, len(in))
	for _, s := range in {
		ids = append(ids, s.id)
	}
	return ids
}

// worktreeState reads what a removal of the listed worktree wt would lose
// (design 4.5), without the ignored-file count and the sessions.
func (m *Manager) worktreeState(home Home, wt Worktree, main bool) (protocol.WorktreeStatus, error) {
	st := protocol.WorktreeStatus{Path: wt.Path, Project: home.Project, Branch: wt.Branch, Head: wt.Head,
		Detached: wt.Branch == "", Main: main, Sessions: []string{}}
	if !main && m.projectStore != nil {
		st.Managed = m.projectStore.Managed(home.Project, wt.Path, wt.Branch)
	}
	var err error
	if st.DirtyFiles, err = DirtyFiles(wt.Path); err != nil {
		return protocol.WorktreeStatus{}, err
	}
	switch {
	case isZeroOID(wt.Head):
		// A branch with no commit yet: there is nothing to count, and rev-list
		// cannot name a branch that does not exist.
	case wt.Branch != "":
		st.UnmergedCommits, err = UnmergedCommits(home.Repo, wt.Branch)
	default:
		st.UnmergedCommits, err = UnmergedCommits(wt.Path, "")
	}
	if err != nil {
		return protocol.WorktreeStatus{}, err
	}
	return st, nil
}

// ignoredFilesOrUnknown is the ignored-file count for a status: -1 when it
// could not be counted. It is a note in the confirmation, and must not keep a
// worktree from being looked at or removed (d31).
func ignoredFilesOrUnknown(path string) int {
	n, err := IgnoredFiles(path)
	if err != nil {
		return -1
	}
	return n
}

// WorktreeStatus reports the state of the worktree at path: what the delete
// confirmation tells the user (design 4.5). ErrWorktreeNotFound when path is
// not a worktree root the daemon itself read from its repository, inside the
// allowed roots; any other error is a git failure.
func (m *Manager) WorktreeStatus(path string, allow AllowFunc) (protocol.WorktreeStatus, error) {
	home, err := locateWorktree(path, allow)
	if err != nil {
		return protocol.WorktreeStatus{}, err
	}
	if home.Single {
		return protocol.WorktreeStatus{}, ErrWorktreeNotFound
	}
	wts, i, err := listedWorktree(home, path)
	if err != nil {
		return protocol.WorktreeStatus{}, err
	}
	// A daemon that has just restarted may not have its tmux sessions in the
	// table yet.
	m.syncFromTmux()
	st, err := m.worktreeState(home, wts[i], i == 0)
	if err != nil {
		return protocol.WorktreeStatus{}, err
	}
	st.IgnoredFiles = ignoredFilesOrUnknown(path)
	st.Sessions = m.sessionsIn(path)
	return st, nil
}

// markRemoving declares the worktree at root as being removed, unless a
// session is being created in it right now. From then until the returned func
// is called, beginStart refuses sessions in it.
func (m *Manager) markRemoving(root string) (unmark func(), ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for dir := range m.startingDirs {
		if within(root, dir) {
			return nil, false
		}
	}
	if m.removingRoots == nil {
		m.removingRoots = make(map[string]struct{})
	}
	m.removingRoots[root] = struct{}{}
	return func() {
		m.mu.Lock()
		delete(m.removingRoots, root)
		m.mu.Unlock()
	}, true
}

// gitOutput is what to show of a failed git call: git's own words when it said
// anything.
func gitOutput(out []byte, err error) string {
	if text := strings.TrimSpace(string(out)); text != "" {
		return text
	}
	return err.Error()
}

// RemoveWorktree removes the worktree at req.Path and, when asked and allowed,
// its branch (design 6.2). It only ever acts on a worktree the daemon read
// from the repository's own list — never the main directory — and only does
// what the user confirmed: the state is read again under the repository's
// lock, and anything that differs from the request comes back as a
// *WorktreeChangedError with the current state and nothing more lost.
//
// Until the first session is ended, a failure changes nothing. From there on
// every error carries the sessions already ended: ending them cannot be taken
// back. A branch is deleted only for a worktree vibe-remote created, by its
// full ref name and only while it still points at the confirmed commit.
func (m *Manager) RemoveWorktree(req protocol.WorktreeRemoveRequest, allow AllowFunc) (protocol.WorktreeRemoveResult, error) {
	none := protocol.WorktreeRemoveResult{}
	path := req.Path
	home, err := locateWorktree(path, allow)
	if err != nil {
		return none, err
	}
	if home.Single {
		// The only worktree of a repository with no recognizable main directory.
		return none, ErrWorktreeIsMain
	}
	unlock := m.lockRepo(home.Repo)
	defer unlock()
	wts, i, err := listedWorktree(home, path)
	if err != nil {
		return none, err
	}
	if i == 0 {
		return none, ErrWorktreeIsMain
	}
	wt := wts[i]

	m.syncFromTmux()
	st, err := m.worktreeState(home, wt, false)
	if err != nil {
		return none, err
	}
	st.Sessions = m.sessionsIn(path)
	ended := []string{}
	// changed is the "not what you confirmed" answer for state cur.
	changed := func(cur protocol.WorktreeStatus) error {
		cur.IgnoredFiles = ignoredFilesOrUnknown(path)
		return &WorktreeChangedError{Status: cur, EndedSessions: ended}
	}
	// current re-reads the state after something went wrong; listed=false when
	// git no longer lists the worktree.
	current := func() (cur protocol.WorktreeStatus, listed bool, err error) {
		again, j, err := listedWorktree(home, path)
		if errors.Is(err, ErrWorktreeNotFound) {
			return cur, false, nil
		}
		if err != nil {
			return cur, false, err
		}
		if cur, err = m.worktreeState(home, again[j], false); err != nil {
			return cur, true, err
		}
		cur.Sessions = m.sessionsIn(path)
		return cur, true, nil
	}

	unmark, free := m.markRemoving(path)
	if !free {
		return none, changed(st) // a session is being created in here
	}
	defer unmark()
	// Every session registered before the mark is in the table by now.
	st.Sessions = m.sessionsIn(path)
	if m.testAfterRemovingMarked != nil {
		m.testAfterRemovingMarked()
	}

	// What git would refuse, or would take along without the confirmation
	// having mentioned it, is refused whatever was agreed to, before any
	// session is ended.
	if wt.Locked {
		reason := ""
		if wt.LockReason != "" {
			reason = " (reason: " + wt.LockReason + ")"
		}
		return none, &WorktreeRemoveError{EndedSessions: ended,
			Message: fmt.Sprintf("this worktree is locked with git worktree lock%s; unlock it first: git worktree unlock %s", reason, path)}
	}
	hasCheckouts, err := HasSubmoduleCheckouts(path)
	if err != nil {
		return none, err
	}
	if hasCheckouts {
		return none, &WorktreeRemoveError{EndedSessions: ended,
			Message: "this worktree holds a checked-out submodule or embedded repository, which may contain commits that exist nowhere else; " +
				"vibe-remote does not remove it. To remove it yourself: git worktree remove --force " + path}
	}
	for _, other := range wts {
		if !other.Prunable && strings.HasPrefix(other.Path, path+string(filepath.Separator)) {
			name := "detached at " + shortHead(other.Head)
			if other.Branch != "" {
				name = "branch " + other.Branch
			}
			return none, &WorktreeRemoveError{EndedSessions: ended,
				Message: fmt.Sprintf("another worktree is inside this one: %s (%s); remove that one first", other.Path, name)}
		}
	}

	confirmed := make(map[string]bool, len(req.Sessions))
	for _, id := range req.Sessions {
		confirmed[id] = true
	}
	for _, id := range st.Sessions {
		if !confirmed[id] {
			return none, changed(st)
		}
	}
	deleteBranch := req.DeleteBranch && st.Managed && st.Branch != ""
	losesCommits := st.UnmergedCommits > 0 && (deleteBranch || st.Branch == "")
	if st.Head != req.Head || (st.DirtyFiles > 0 && !req.DiscardFiles) || (losesCommits && !req.DropCommits) {
		return none, changed(st)
	}

	end := m.Delete
	if m.testEndSession != nil {
		end = m.testEndSession
	}
	for _, id := range st.Sessions {
		// A session that is already gone ended on its own just now.
		if err := end(id); err != nil && !errors.Is(err, ErrSessionNotFound) {
			return none, &WorktreeRemoveError{EndedSessions: ended, Message: fmt.Sprintf("could not end session %s: %v", id, err)}
		}
		ended = append(ended, id)
	}
	if m.testAfterSessionsEnded != nil {
		m.testAfterSessionsEnded()
	}
	// The sessions were still running when the state was read, and they are
	// the likeliest thing to have committed since. On a detached worktree such
	// a commit would be on no branch and go unnoticed with the directory.
	headNow, out, err := headAgain(wt.Path, req.Head)
	if err != nil {
		return none, &WorktreeRemoveError{EndedSessions: ended, Message: "could not read HEAD again: " + gitOutput(out, err)}
	}
	if headNow != req.Head {
		cur, listed, err := current()
		if err != nil || !listed {
			return none, &WorktreeRemoveError{EndedSessions: ended, Message: "HEAD moved while the sessions were being ended, and the worktree could not be read again"}
		}
		return none, changed(cur)
	}
	if m.testBeforeWorktreeRemove != nil {
		m.testBeforeWorktreeRemove()
	}

	args := []string{"worktree", "remove"}
	if req.DiscardFiles {
		args = append(args, "--force")
	}
	if out, err := gitAt(home.Repo, append(args, wt.Path)...); err != nil {
		// Why it failed is found by looking again, not by reading git's message.
		failure := gitOutput(out, err)
		cur, listed, curErr := current()
		switch {
		case curErr != nil:
		case !listed:
			// git forgets the worktree before it deletes the directory.
			if _, statErr := os.Lstat(path); statErr == nil {
				failure += fmt.Sprintf("; git no longer lists this worktree, but part of its directory is left at %s", path)
			}
			failure += "; the branch was not deleted"
		case cur.Head != req.Head || (cur.DirtyFiles > 0 && !req.DiscardFiles):
			return none, changed(cur)
		}
		return none, &WorktreeRemoveError{EndedSessions: ended, Message: failure}
	}

	res := protocol.WorktreeRemoveResult{Removed: true, EndedSessions: ended}
	if deleteBranch {
		res.BranchDeleted, res.BranchError = deleteWorktreeBranch(home.Repo, wt.Branch, wt.Head)
	}
	if m.projectStore != nil {
		m.projectStore.RemoveWorktree(path)
	}
	// The container is ours to tidy; any other parent directory is not.
	if container := filepath.Join(filepath.Dir(home.Project), filepath.Base(home.Project)+"-worktrees"); filepath.Dir(path) == container {
		_ = os.Remove(container) // stays unless empty
	}
	return res, nil
}

// headAgain re-reads HEAD of the worktree at dir, to compare with the head the
// user confirmed. A worktree confirmed with no commit yet (the null object
// name) that still has none reads as confirmed.
func headAgain(dir, confirmed string) (head string, out []byte, err error) {
	if !isZeroOID(confirmed) {
		out, err = gitAtTimeout(dir, "rev-parse", "HEAD")
		return strings.TrimSpace(string(out)), out, err
	}
	// `rev-parse HEAD` cannot tell "no commit yet" from a failure; the quiet
	// form exits with status 1 for it.
	out, err = gitAtTimeout(dir, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")
	if code, exited := gitExitCode(err); exited && code == 1 {
		return confirmed, nil, nil
	}
	return strings.TrimSpace(string(out)), out, err
}

// deleteWorktreeBranch deletes refs/heads/<branch> after its worktree is gone,
// if no other worktree has it checked out and it still points at head. The
// branch is named by its full ref, which git neither expands nor reads as an
// option. It reports why the branch is still there when it is.
func deleteWorktreeBranch(repo, branch, head string) (deleted bool, problem string) {
	wts, err := ListWorktrees(repo)
	if err != nil {
		return false, fmt.Sprintf("could not check whether branch %s is checked out elsewhere: %v", branch, err)
	}
	for _, wt := range wts {
		if wt.Branch == branch {
			return false, fmt.Sprintf("branch %s is still checked out in %s", branch, wt.Path)
		}
	}
	if out, err := gitAt(repo, "update-ref", "-d", "refs/heads/"+branch, head); err != nil {
		return false, gitOutput(out, err)
	}
	// Leftover tracking configuration; there being none is not an error.
	_, _ = gitAt(repo, "config", "--remove-section", "branch."+branch)
	return true, ""
}

// PlanWorktree is the read-only pre-check for creating a worktree named name
// from workdir (design 4.4): the same checks, in the same order, that
// CreateWorktree makes before it creates anything. A git failure or timeout is
// returned as an error; every other outcome is a plan.
func (m *Manager) PlanWorktree(workdir, name string, allowPath func(string) error) (protocol.WorktreePlan, error) {
	checks, err := precheckWorktree(WorktreeSpec{Source: workdir, Name: name, AllowPath: allowPath}, true)
	if errors.Is(err, errNotInGit) {
		return protocol.WorktreePlan{Error: "not_git", Message: err.Error()}, nil
	}
	if !checks.home.Git {
		return protocol.WorktreePlan{}, err // the repository could not be read
	}
	plan := protocol.WorktreePlan{
		Project: checks.home.Project, ProjectName: baseName(checks.home.Project),
		Branch: checks.claim.branch, Path: checks.claim.root,
	}
	base, baseErr := worktreeBase(checks.home.Path)
	if baseErr != nil {
		return protocol.WorktreePlan{}, baseErr
	}
	plan.Base = &base
	var exists *BranchExistsError
	switch {
	case err == nil:
		plan.OK = true
		return plan, nil
	case errors.Is(err, ErrUnsupportedRepo):
		plan.Error = "unsupported_repo"
	case errors.Is(err, ErrSourceNoCommits):
		plan.Error = "no_commits"
	case errors.Is(err, ErrInvalidWorktreeName):
		plan.Error = protocol.ErrCodeInvalidWorktreeName
	case errors.Is(err, ErrWorktreePathNotAllowed):
		plan.Error = protocol.ErrCodeWorktreePathNotAllowed
	case errors.As(err, &exists):
		plan.Error = protocol.ErrCodeWorktreeBranchExists
		plan.Conflict = exists.Conflict
	case errors.Is(err, ErrWorktreePathExists):
		plan.Error = protocol.ErrCodeWorktreePathExists
	default:
		return protocol.WorktreePlan{}, err
	}
	plan.Message = err.Error()
	return plan, nil
}

// worktreeBase reads what is checked out in the worktree rooted at root from
// the repository's worktree list.
func worktreeBase(root string) (protocol.WorktreeBase, error) {
	wts, err := ListWorktrees(root)
	if err != nil {
		return protocol.WorktreeBase{}, err
	}
	if len(wts) == 0 {
		return protocol.WorktreeBase{}, fmt.Errorf("git lists no worktree for %s", root)
	}
	cur := wts[0]
	for _, wt := range wts {
		if wt.Path == root {
			cur = wt
			break
		}
	}
	return protocol.WorktreeBase{Branch: cur.Branch, Head: shortHead(cur.Head), Detached: cur.Detached}, nil
}

func baseName(id string) string {
	id = strings.TrimRight(id, "/")
	if i := strings.LastIndex(id, "/"); i >= 0 {
		return id[i+1:]
	}
	return id
}

func shortHead(head string) string {
	if len(head) > 7 {
		return head[:7]
	}
	return head
}

func firstLine(err error) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return s
}

func parseCreated(s string) time.Time {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t
	}
	return time.Time{}
}

func sortProjects(ps []protocol.Project) {
	sort.SliceStable(ps, func(i, j int) bool {
		li, lj := strings.ToLower(ps[i].Name), strings.ToLower(ps[j].Name)
		if li != lj {
			return li < lj
		}
		return ps[i].ID < ps[j].ID
	})
	for k := range ps {
		sortWorktrees(ps[k].Worktrees)
	}
}

func sortWorktrees(ws []protocol.ProjectWorktree) {
	sort.SliceStable(ws, func(i, j int) bool {
		a, b := ws[i], ws[j]
		if a.Main != b.Main {
			return a.Main
		}
		if a.Detached != b.Detached {
			return !a.Detached // branched before detached
		}
		if a.Detached {
			if a.Head != b.Head {
				return a.Head < b.Head
			}
			return a.Path < b.Path
		}
		if a.Branch != b.Branch {
			return a.Branch < b.Branch
		}
		return a.Path < b.Path
	})
}

func sortSessions(ss []sessAttr) {
	sort.SliceStable(ss, func(i, j int) bool {
		if !ss[i].created.Equal(ss[j].created) {
			return ss[i].created.Before(ss[j].created)
		}
		return ss[i].id < ss[j].id
	})
}

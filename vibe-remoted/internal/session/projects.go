package session

import (
	"errors"
	"fmt"
	"os"
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
	livePaths := map[string]bool{} // worktree paths present in some project's list
	for id := range candidates {
		p := m.buildProject(id, inStore[id], lists[id], byProject[id], allow)
		for _, w := range p.Worktrees {
			livePaths[w.Path] = true
		}
		// A git project discovered only through its sessions joins the store so
		// it survives after those sessions end (design 5.4, H18).
		if m.projectStore != nil && p.Git && p.Error == "" && !inStore[id] {
			m.projectStore.AddProject(id)
		}
		projects = append(projects, p)
	}

	// Drop stale records: those in the snapshot whose path is no longer in its
	// project's list (someone else removed the worktree). RemoveWorktreeIfSame
	// leaves a record that was replaced since the snapshot alone.
	if m.projectStore != nil {
		for _, rec := range recSnapshot {
			if !livePaths[rec.Path] {
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

	p.Git = true
	wts := res.wts
	if len(wts) > 0 && !wts[0].Bare && !hasDotGit(wts[0].Path) {
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

// WorktreeStatus reports the state of the worktree at path (design 4.5).
func (m *Manager) WorktreeStatus(path string, allow AllowFunc) (protocol.WorktreeStatus, error) {
	return protocol.WorktreeStatus{}, errNotImplemented
}

// RemoveWorktree removes the worktree at req.Path (design 6.2).
func (m *Manager) RemoveWorktree(req protocol.WorktreeRemoveRequest, allow AllowFunc) (protocol.WorktreeRemoveResult, error) {
	return protocol.WorktreeRemoveResult{}, errNotImplemented
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

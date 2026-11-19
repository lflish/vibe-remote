package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/config"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/session"
)

func serverGitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func initRepoAt(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	serverGit(t, dir, "init", "-b", "main")
	serverGit(t, dir, "config", "user.email", "test@example.com")
	serverGit(t, dir, "config", "user.name", "Test User")
	if err := os.WriteFile(filepath.Join(dir, "README"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	serverGit(t, dir, "add", "README")
	serverGit(t, dir, "commit", "-m", "init")
}

func projMgr(t *testing.T) *session.Manager {
	t.Helper()
	m := session.NewManager(false, "/bin/cat", false, "")
	m.SetProjectStore(session.NewMemoryProjectStore())
	return m
}

func projServer(t *testing.T, mgr *session.Manager, roots ...string) *Server {
	t.Helper()
	return New(&config.Config{Token: "secret", AllowedRoots: roots}, mgr)
}

func getProjects(t *testing.T, s *Server) protocol.ProjectsResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	req.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("projects status = %d: %s", w.Code, w.Body.String())
	}
	var resp protocol.ProjectsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v; body=%s", err, w.Body.String())
	}
	return resp
}

func projectByName(resp protocol.ProjectsResponse, name string) *protocol.Project {
	for i := range resp.Projects {
		if resp.Projects[i].Name == name {
			return &resp.Projects[i]
		}
	}
	return nil
}

func worktreeByBranch(p *protocol.Project, branch string) *protocol.ProjectWorktree {
	for i := range p.Worktrees {
		if p.Worktrees[i].Branch == branch {
			return &p.Worktrees[i]
		}
	}
	return nil
}

func mustCreate(t *testing.T, mgr *session.Manager, opts session.CreateOptions) *session.Runner {
	t.Helper()
	opts.Cols, opts.Rows = 80, 24
	r, err := mgr.Create(opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Kill() })
	return r
}

func TestProjectsTree(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "devflow")
	initRepoAt(t, repo)
	base := serverGitOut(t, repo, "rev-parse", "HEAD")
	fix := filepath.Join(root, "devflow-fixwt")
	serverGit(t, repo, "worktree", "add", "-b", "fix-login", fix, base)

	mgr := projMgr(t)
	rMain := mustCreate(t, mgr, session.CreateOptions{Workdir: repo})
	rFix := mustCreate(t, mgr, session.CreateOptions{Workdir: fix})
	s := projServer(t, mgr, root)

	resp := getProjects(t, s)
	dev := projectByName(resp, "devflow")
	if dev == nil || !dev.Git {
		t.Fatalf("no devflow project: %+v", resp)
	}
	main := worktreeByBranch(dev, "main")
	wfix := worktreeByBranch(dev, "fix-login")
	if main == nil || wfix == nil {
		t.Fatalf("worktrees = %+v", dev.Worktrees)
	}
	if !contains(main.Sessions, rMain.ID) || !contains(wfix.Sessions, rFix.ID) {
		t.Fatalf("sessions misplaced: main=%v fix=%v", main.Sessions, wfix.Sessions)
	}
}

func TestProjectsNonGitProject(t *testing.T) {
	root := t.TempDir()
	notes := filepath.Join(root, "notes")
	if err := os.MkdirAll(notes, 0o755); err != nil {
		t.Fatal(err)
	}
	mgr := projMgr(t)
	r := mustCreate(t, mgr, session.CreateOptions{Workdir: notes})
	s := projServer(t, mgr, root)

	p := projectByName(getProjects(t, s), "notes")
	if p == nil || p.Git || p.Error != "" || len(p.Worktrees) != 0 {
		t.Fatalf("notes project = %+v", p)
	}
	if !contains(p.Sessions, r.ID) {
		t.Fatalf("session not at project level: %+v", p)
	}
}

func TestProjectsListsSessionlessAndExternal(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "devflow")
	initRepoAt(t, repo)
	base := serverGitOut(t, repo, "rev-parse", "HEAD")
	ext := filepath.Join(root, "general-skills")
	serverGit(t, repo, "worktree", "add", "-b", "change/general-skills", ext, base)

	mgr := projMgr(t)
	mustCreate(t, mgr, session.CreateOptions{Workdir: repo})
	s := projServer(t, mgr, root)

	dev := projectByName(getProjects(t, s), "devflow")
	w := worktreeByBranch(dev, "change/general-skills")
	if w == nil {
		t.Fatalf("external worktree missing: %+v", dev.Worktrees)
	}
	if len(w.Sessions) != 0 || w.Main || w.Managed {
		t.Fatalf("external worktree = %+v", w)
	}
}

func TestProjectsTwoSessionsOneWorktree(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "devflow")
	initRepoAt(t, repo)
	mgr := projMgr(t)
	a := mustCreate(t, mgr, session.CreateOptions{Workdir: repo})
	b := mustCreate(t, mgr, session.CreateOptions{Workdir: repo})
	s := projServer(t, mgr, root)

	dev := projectByName(getProjects(t, s), "devflow")
	main := worktreeByBranch(dev, "main")
	if main == nil || len(main.Sessions) != 2 || !contains(main.Sessions, a.ID) || !contains(main.Sessions, b.ID) {
		t.Fatalf("two sessions = %+v", main)
	}
}

func TestProjectsResponseShape(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "devflow")
	initRepoAt(t, repo)
	base := serverGitOut(t, repo, "rev-parse", "HEAD")
	det := filepath.Join(root, "devflow-worktrees", "tmp")
	serverGit(t, repo, "worktree", "add", "--detach", det, base)
	mgr := projMgr(t)
	rw := mustCreate(t, mgr, session.CreateOptions{Workdir: repo, Mode: protocol.SessionModeWorktree})
	_ = rw
	mustCreate(t, mgr, session.CreateOptions{Workdir: repo})
	s := projServer(t, mgr, root)

	resp := getProjects(t, s)
	if resp.Proto != 4 {
		t.Fatalf("proto = %d", resp.Proto)
	}
	dev := projectByName(resp, "devflow")
	var sawMain, sawDetached, sawManaged bool
	for _, w := range dev.Worktrees {
		if w.Main {
			sawMain = true
			if w.Head == "" || len(w.Head) > 7 {
				t.Fatalf("main head = %q", w.Head)
			}
		}
		if w.Detached {
			sawDetached = true
			if w.Branch != "" {
				t.Fatalf("detached has branch: %+v", w)
			}
		}
		if w.Managed {
			sawManaged = true
		}
	}
	if !sawMain || !sawDetached || !sawManaged {
		t.Fatalf("shape: main=%v detached=%v managed=%v: %+v", sawMain, sawDetached, sawManaged, dev.Worktrees)
	}
}

func TestProjectsOrderStable(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"Beta", "alpha", "gamma"} {
		repo := filepath.Join(root, name)
		initRepoAt(t, repo)
	}
	mgr := projMgr(t)
	for _, name := range []string{"gamma", "alpha", "Beta"} {
		mustCreate(t, mgr, session.CreateOptions{Workdir: filepath.Join(root, name)})
	}
	s := projServer(t, mgr, root)

	first := getProjectsRaw(t, s)
	for i := 0; i < 40; i++ {
		if got := getProjectsRaw(t, s); got != first {
			t.Fatalf("round %d differs", i)
		}
	}
	resp := getProjects(t, s)
	var names []string
	for _, p := range resp.Projects {
		names = append(names, p.Name)
	}
	if len(names) != 3 || names[0] != "alpha" || names[1] != "Beta" || names[2] != "gamma" {
		t.Fatalf("order = %v", names)
	}
}

func getProjectsRaw(t *testing.T, s *Server) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	req.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, req)
	return w.Body.String()
}

func TestProjectsRepoMissing(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "devflow")
	initRepoAt(t, repo)
	mgr := projMgr(t)
	r := mustCreate(t, mgr, session.CreateOptions{Workdir: repo})
	s := projServer(t, mgr, root)
	// Prime the store with the project, then delete the repo on disk.
	getProjects(t, s)
	if err := os.RemoveAll(repo); err != nil {
		t.Fatal(err)
	}

	p := projectByName(getProjects(t, s), "devflow")
	if p == nil || p.Error != "repo_missing" || len(p.Worktrees) != 0 || !contains(p.Sessions, r.ID) {
		t.Fatalf("repo_missing project = %+v", p)
	}
}

func TestProjectsGitFailed(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "devflow")
	initRepoAt(t, repo)
	mgr := projMgr(t)
	r := mustCreate(t, mgr, session.CreateOptions{Workdir: repo})
	s := projServer(t, mgr, root)
	getProjects(t, s) // record the project while git works

	// A git that fails fast (used only for the Projects() reads below).
	broken := t.TempDir()
	if err := os.WriteFile(filepath.Join(broken, "git"), []byte("#!/bin/sh\necho boom >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", broken+string(os.PathListSeparator)+os.Getenv("PATH"))

	p := projectByName(getProjects(t, s), "devflow")
	if p == nil || p.Error != "git_failed" || p.ErrorMessage == "" || len(p.Worktrees) != 0 || !contains(p.Sessions, r.ID) {
		t.Fatalf("git_failed project = %+v", p)
	}
}

func TestProjectsPrunedWorktreeSessionsMoveUp(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "devflow")
	initRepoAt(t, repo)
	base := serverGitOut(t, repo, "rev-parse", "HEAD")
	wt := filepath.Join(root, "devflow-worktrees", "x")
	serverGit(t, repo, "worktree", "add", "-b", "x", wt, base)
	mgr := projMgr(t)
	r := mustCreate(t, mgr, session.CreateOptions{Workdir: wt})
	s := projServer(t, mgr, root)
	// Remove the worktree out from under the session.
	serverGit(t, repo, "worktree", "remove", "--force", wt)

	dev := projectByName(getProjects(t, s), "devflow")
	if worktreeByBranch(dev, "x") != nil {
		t.Fatalf("pruned worktree still listed: %+v", dev.Worktrees)
	}
	if !contains(dev.Sessions, r.ID) {
		t.Fatalf("session did not move up: %+v", dev)
	}
}

func TestProjectsHidesWorktreesOutsideAllowedRoots(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "devflow")
	initRepoAt(t, repo)
	base := serverGitOut(t, repo, "rev-parse", "HEAD")
	outside := filepath.Join(t.TempDir(), "outside-wt")
	serverGit(t, repo, "worktree", "add", "-b", "out", outside, base)
	mgr := projMgr(t)
	mustCreate(t, mgr, session.CreateOptions{Workdir: repo})
	s := projServer(t, mgr, repo) // only the repo itself is allowed

	dev := projectByName(getProjects(t, s), "devflow")
	if worktreeByBranch(dev, "out") != nil {
		t.Fatalf("worktree outside allowed roots is listed: %+v", dev.Worktrees)
	}
}

func TestProjectsAllowedRootIsSymlink(t *testing.T) {
	realRoot := t.TempDir()
	repo := filepath.Join(realRoot, "devflow")
	initRepoAt(t, repo)
	base := serverGitOut(t, repo, "rev-parse", "HEAD")
	wt := filepath.Join(realRoot, "devflow-worktrees", "x")
	serverGit(t, repo, "worktree", "add", "-b", "x", wt, base)
	link := filepath.Join(t.TempDir(), "rootlink")
	if err := os.Symlink(realRoot, link); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	mgr := projMgr(t)
	mustCreate(t, mgr, session.CreateOptions{Workdir: repo})
	s := projServer(t, mgr, link) // allowed root is the symlink

	dev := projectByName(getProjects(t, s), "devflow")
	if dev == nil || worktreeByBranch(dev, "main") == nil || worktreeByBranch(dev, "x") == nil {
		t.Fatalf("symlink-root project = %+v", dev)
	}
}

func TestProjectsSurviveSessionDeletionAndRestart(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "devflow")
	initRepoAt(t, repo)
	state := t.TempDir()

	mgr := session.NewManager(false, "/bin/cat", false, "")
	ps, err := session.OpenProjectStore(state)
	if err != nil {
		t.Fatal(err)
	}
	mgr.SetProjectStore(ps)
	r := mustCreate(t, mgr, session.CreateOptions{Workdir: repo})
	s := projServer(t, mgr, root)
	getProjects(t, s) // ensure the project is recorded
	if err := mgr.Delete(r.ID); err != nil {
		t.Fatal(err)
	}

	// New manager + store on the same dir: a daemon restart.
	mgr2 := session.NewManager(false, "/bin/cat", false, "")
	ps2, err := session.OpenProjectStore(state)
	if err != nil {
		t.Fatal(err)
	}
	mgr2.SetProjectStore(ps2)
	s2 := projServer(t, mgr2, root)
	if projectByName(getProjects(t, s2), "devflow") == nil {
		t.Fatal("devflow project did not survive session deletion + restart")
	}
}

func TestRemoveProjectKeepsDisk(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "devflow")
	initRepoAt(t, repo)
	mgr := projMgr(t)
	r := mustCreate(t, mgr, session.CreateOptions{Workdir: repo})
	s := projServer(t, mgr, root)
	id := projectByName(getProjects(t, s), "devflow").ID
	if err := mgr.Delete(r.ID); err != nil {
		t.Fatal(err)
	}

	if code := postRemoveProject(t, s, id); code != http.StatusNoContent {
		t.Fatalf("remove status = %d", code)
	}
	if projectByName(getProjects(t, s), "devflow") != nil {
		t.Fatal("project still listed after remove")
	}
	if _, err := os.Stat(repo); err != nil {
		t.Fatalf("repo dir removed: %v", err)
	}
}

func TestProjectReappearsAfterNewSession(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "devflow")
	initRepoAt(t, repo)
	mgr := projMgr(t)
	r := mustCreate(t, mgr, session.CreateOptions{Workdir: repo})
	s := projServer(t, mgr, root)
	id := projectByName(getProjects(t, s), "devflow").ID
	if err := mgr.Delete(r.ID); err != nil {
		t.Fatal(err)
	}
	postRemoveProject(t, s, id)

	// A new session in a subdirectory brings the project back.
	sub := filepath.Join(repo, "src")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	mustCreate(t, mgr, session.CreateOptions{Workdir: sub})
	if projectByName(getProjects(t, s), "devflow") == nil {
		t.Fatal("project did not reappear")
	}
}

func TestRemoveProjectWithSessions409(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "devflow")
	initRepoAt(t, repo)
	mgr := projMgr(t)
	mustCreate(t, mgr, session.CreateOptions{Workdir: repo})
	s := projServer(t, mgr, root)
	id := projectByName(getProjects(t, s), "devflow").ID

	if code := postRemoveProject(t, s, id); code != http.StatusConflict {
		t.Fatalf("remove status = %d, want 409", code)
	}
	if projectByName(getProjects(t, s), "devflow") == nil {
		t.Fatal("project removed despite sessions")
	}
}

func TestRemoveProjectNotFound(t *testing.T) {
	mgr := projMgr(t)
	s := projServer(t, mgr, t.TempDir())
	if code := postRemoveProject(t, s, "/nope"); code != http.StatusNotFound {
		t.Fatalf("remove status = %d, want 404", code)
	}
}

func TestNonGitProjectDisappearsWithLastSession(t *testing.T) {
	root := t.TempDir()
	notes := filepath.Join(root, "notes")
	if err := os.MkdirAll(notes, 0o755); err != nil {
		t.Fatal(err)
	}
	mgr := projMgr(t)
	r := mustCreate(t, mgr, session.CreateOptions{Workdir: notes})
	s := projServer(t, mgr, root)
	if projectByName(getProjects(t, s), "notes") == nil {
		t.Fatal("notes project missing")
	}
	if err := mgr.Delete(r.ID); err != nil {
		t.Fatal(err)
	}
	if projectByName(getProjects(t, s), "notes") != nil {
		t.Fatal("non-git project outlived its last session")
	}
}

func TestProjectsDropsStaleWorktreeRecord(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "devflow")
	initRepoAt(t, repo)
	mgr := projMgr(t)
	rw := mustCreate(t, mgr, session.CreateOptions{Workdir: repo, Mode: protocol.SessionModeWorktree})
	s := projServer(t, mgr, root)
	// The managed worktree is recorded; end its session and remove it externally.
	wtRoot := rw.WorktreeRoot
	if err := mgr.Delete(rw.ID); err != nil {
		t.Fatal(err)
	}
	serverGit(t, repo, "worktree", "remove", "--force", wtRoot)
	// After a Projects() read, the stale record is dropped; a same-path manual
	// worktree is then not managed.
	getProjects(t, s)
	serverGit(t, repo, "worktree", "add", "-b", "manual", wtRoot, "HEAD")
	mustCreate(t, mgr, session.CreateOptions{Workdir: wtRoot})
	dev := projectByName(getProjects(t, s), "devflow")
	if w := worktreeByBranch(dev, "manual"); w == nil || w.Managed {
		t.Fatalf("manual worktree = %+v", w)
	}
}

func TestNewEndpointsRequireToken(t *testing.T) {
	mgr := projMgr(t)
	s := projServer(t, mgr, t.TempDir())
	cases := []struct {
		method, path string
	}{
		{http.MethodGet, "/api/v1/projects"},
		{http.MethodPost, "/api/v1/projects/remove"},
		{http.MethodGet, "/api/v1/worktrees/plan?workdir=/tmp&name=x"},
		{http.MethodGet, "/api/v1/worktrees/status?path=/tmp"},
		{http.MethodPost, "/api/v1/worktrees/remove"},
	}
	for _, c := range cases {
		for _, auth := range []string{"", "Bearer wrong"} {
			req := httptest.NewRequest(c.method, c.path, nil)
			if auth != "" {
				req.Header.Set("Authorization", auth)
			}
			w := httptest.NewRecorder()
			s.mux.ServeHTTP(w, req)
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("%s %s auth=%q status = %d, want 401", c.method, c.path, auth, w.Code)
			}
		}
	}
}

func postRemoveProject(t *testing.T, s *Server, id string) int {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"id": id})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/remove", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, req)
	return w.Code
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// --- T8: GET /api/v1/worktrees/plan ---

func getPlanRaw(t *testing.T, s *Server, workdir, name string) *httptest.ResponseRecorder {
	t.Helper()
	q := url.Values{}
	if workdir != "" {
		q.Set("workdir", workdir)
	}
	q.Set("name", name)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/worktrees/plan?"+q.Encode(), nil)
	req.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, req)
	return w
}

func getPlan(t *testing.T, s *Server, workdir, name string) protocol.WorktreePlan {
	t.Helper()
	w := getPlanRaw(t, s, workdir, name)
	if w.Code != http.StatusOK {
		t.Fatalf("plan(%q, %q) status = %d: %s", workdir, name, w.Code, w.Body.String())
	}
	var plan protocol.WorktreePlan
	if err := json.Unmarshal(w.Body.Bytes(), &plan); err != nil {
		t.Fatalf("decode: %v; body=%s", err, w.Body.String())
	}
	return plan
}

// repoState is everything a plan request must leave alone.
func repoState(t *testing.T, repo string) string {
	t.Helper()
	container := filepath.Join(filepath.Dir(repo), filepath.Base(repo)+"-worktrees")
	entries := "absent"
	if list, err := os.ReadDir(container); err == nil {
		names := []string{}
		for _, e := range list {
			names = append(names, e.Name())
		}
		entries = strings.Join(names, ",")
	}
	return serverGitOut(t, repo, "worktree", "list", "--porcelain") + "\n--\n" +
		serverGitOut(t, repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads") + "\n--\n" + entries
}

// planFixture is a repository <root>/devflow (canonical paths) with branches
// taken, fix and change/foo, an existing directory devflow-worktrees/occupied,
// and a server whose only allowed root is root.
type planFixture struct {
	root, repo string
	s          *Server
}

func newPlanFixture(t *testing.T) *planFixture {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo := filepath.Join(root, "devflow")
	initRepoAt(t, repo)
	for _, b := range []string{"taken", "fix", "change/foo"} {
		serverGit(t, repo, "branch", b)
	}
	if err := os.MkdirAll(filepath.Join(root, "devflow-worktrees", "occupied"), 0o755); err != nil {
		t.Fatal(err)
	}
	return &planFixture{root: root, repo: repo, s: projServer(t, projMgr(t), root)}
}

// plan asks for a plan and fails the test if the request changed the repository.
func (f *planFixture) plan(t *testing.T, workdir, name string) protocol.WorktreePlan {
	t.Helper()
	before := repoState(t, f.repo)
	plan := getPlan(t, f.s, workdir, name)
	if after := repoState(t, f.repo); after != before {
		t.Fatalf("plan(%q) changed the repository:\n%s\n→\n%s", name, before, after)
	}
	return plan
}

func TestPlanWorktree(t *testing.T) {
	f := newPlanFixture(t)
	container := filepath.Join(f.root, "devflow-worktrees")

	t.Run("ok", func(t *testing.T) {
		p := f.plan(t, f.repo, "fix-login")
		if !p.OK || p.Error != "" || p.Branch != "fix-login" || p.Path != filepath.Join(container, "fix-login") ||
			p.Project != f.repo || p.ProjectName != "devflow" || p.Base == nil {
			t.Fatalf("plan = %+v", p)
		}
		if !strings.HasSuffix(p.Path, "/devflow-worktrees/fix-login") {
			t.Fatalf("path = %q", p.Path)
		}
	})
	t.Run("slash", func(t *testing.T) {
		p := f.plan(t, f.repo, "change/new")
		if !p.OK || p.Branch != "change/new" || !strings.HasSuffix(p.Path, "/change-new") {
			t.Fatalf("plan = %+v", p)
		}
	})
	t.Run("invalid_name", func(t *testing.T) {
		for _, name := range []string{"", "a b", "@{-1}"} {
			p := f.plan(t, f.repo, name)
			if p.OK || p.Error != "invalid_worktree_name" || p.Message == "" {
				t.Fatalf("name %q: plan = %+v", name, p)
			}
			if p.Project != f.repo || p.ProjectName != "devflow" || p.Base == nil || p.Branch != "" || p.Path != "" {
				t.Fatalf("name %q: an invalid name still gets project and base, and no branch or path: %+v", name, p)
			}
		}
	})
	t.Run("branch_exists", func(t *testing.T) {
		p := f.plan(t, f.repo, "taken")
		if p.OK || p.Error != "worktree_branch_exists" || p.Branch != "taken" || p.Conflict != "taken" {
			t.Fatalf("plan = %+v", p)
		}
	})
	t.Run("branch_conflict", func(t *testing.T) {
		for name, conflict := range map[string]string{"fix/login": "fix", "change": "change/foo"} {
			p := f.plan(t, f.repo, name)
			if p.OK || p.Error != "worktree_branch_exists" || p.Branch != name || p.Conflict != conflict || !strings.Contains(p.Message, conflict) {
				t.Fatalf("name %q: plan = %+v, want blocked by %q", name, p, conflict)
			}
		}
	})
	t.Run("path_exists", func(t *testing.T) {
		p := f.plan(t, f.repo, "occupied")
		if p.OK || p.Error != "worktree_path_exists" || p.Path != filepath.Join(container, "occupied") {
			t.Fatalf("plan = %+v", p)
		}
	})
	t.Run("path_not_allowed", func(t *testing.T) {
		// The repository is the only allowed root: its worktrees directory, a
		// sibling, is outside.
		s := projServer(t, projMgr(t), f.repo)
		before := repoState(t, f.repo)
		p := getPlan(t, s, f.repo, "fix-login")
		if p.OK || p.Error != "worktree_path_not_allowed" || !strings.Contains(p.Message, filepath.Join(container, "fix-login")) {
			t.Fatalf("plan = %+v", p)
		}
		if repoState(t, f.repo) != before {
			t.Fatal("the plan changed the repository")
		}
	})
	t.Run("not_git", func(t *testing.T) {
		plain := filepath.Join(f.root, "notes")
		if err := os.Mkdir(plain, 0o755); err != nil {
			t.Fatal(err)
		}
		p := getPlan(t, f.s, plain, "fix-login")
		if p.OK || p.Error != "not_git" || p.Project != "" || p.ProjectName != "" || p.Base != nil || p.Branch != "" || p.Path != "" {
			t.Fatalf("plan = %+v", p)
		}
	})
	t.Run("unsupported_repo", func(t *testing.T) {
		outer := filepath.Join(f.root, "outer")
		lib := filepath.Join(f.root, "lib")
		initRepoAt(t, outer)
		initRepoAt(t, lib)
		serverGit(t, outer, "-c", "protocol.file.allow=always", "submodule", "add", lib, "sub")
		serverGit(t, outer, "commit", "-m", "add submodule")
		sub := filepath.Join(outer, "sub")
		before := dirList(t, filepath.Join(outer, ".git", "modules")) + "|" + dirList(t, outer)
		p := getPlan(t, f.s, sub, "fix-login")
		if p.OK || p.Error != "unsupported_repo" || p.Message == "" || p.Project != sub || p.Base == nil || p.Branch != "" || p.Path != "" {
			t.Fatalf("plan = %+v", p)
		}
		if after := dirList(t, filepath.Join(outer, ".git", "modules")) + "|" + dirList(t, outer); after != before {
			t.Fatalf("the plan created something: %s → %s", before, after)
		}
	})
}

func dirList(t *testing.T, dir string) string {
	t.Helper()
	list, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, e := range list {
		names = append(names, e.Name())
	}
	return strings.Join(names, ",")
}

func TestPlanWorktreeBase(t *testing.T) {
	f := newPlanFixture(t)
	head := serverGitOut(t, f.repo, "rev-parse", "HEAD")
	p := f.plan(t, f.repo, "fix-login")
	if p.Base == nil || p.Base.Branch != "main" || p.Base.Head != head[:7] || p.Base.Detached {
		t.Fatalf("base = %+v, want main @ %s", p.Base, head[:7])
	}
	// An empty name is how the dialog asks for the base alone.
	p = f.plan(t, f.repo, "")
	if p.Base == nil || p.Base.Branch != "main" || p.Base.Head != head[:7] {
		t.Fatalf("base for an empty name = %+v", p.Base)
	}
	// From a linked worktree the base is that worktree's branch and commit.
	linked := filepath.Join(f.root, "devflow-worktrees", "linked")
	serverGit(t, f.repo, "worktree", "add", "-b", "linked", linked)
	os.WriteFile(filepath.Join(linked, "more"), []byte("x\n"), 0o644)
	serverGit(t, linked, "add", "more")
	serverGit(t, linked, "commit", "-m", "more")
	linkedHead := serverGitOut(t, linked, "rev-parse", "HEAD")
	p = getPlan(t, f.s, linked, "from-linked")
	if !p.OK || p.Base == nil || p.Base.Branch != "linked" || p.Base.Head != linkedHead[:7] || p.Project != f.repo ||
		p.Path != filepath.Join(f.root, "devflow-worktrees", "from-linked") {
		t.Fatalf("plan from a linked worktree = %+v (base %+v)", p, p.Base)
	}
	// Detached: no branch, detached:true.
	serverGit(t, f.repo, "checkout", "--detach")
	p = f.plan(t, f.repo, "fix-login")
	if p.Base == nil || p.Base.Branch != "" || !p.Base.Detached || p.Base.Head != head[:7] {
		t.Fatalf("detached base = %+v", p.Base)
	}
	raw := getPlanRaw(t, f.s, f.repo, "fix-login").Body.String()
	if !strings.Contains(raw, `"detached":true`) || strings.Contains(raw, `"branch":""`) {
		t.Fatalf("detached base on the wire: %s", raw)
	}
}

func TestPlanWorktreeCreatesNothing(t *testing.T) {
	f := newPlanFixture(t)
	before := repoState(t, f.repo)
	for _, name := range []string{"fix-login", "change/new", "", "a b", "@{-1}", "-x", "taken", "fix/login", "change", "occupied", "$(touch${IFS}PWNED)"} {
		getPlan(t, f.s, f.repo, name)
		getPlan(t, f.s, filepath.Join(f.repo, ".git"), name)
	}
	if after := repoState(t, f.repo); after != before {
		t.Fatalf("plans changed the repository:\n%s\n→\n%s", before, after)
	}
	for _, dir := range []string{f.root, f.repo} {
		if _, err := os.Lstat(filepath.Join(dir, "PWNED")); err == nil {
			t.Fatalf("a name was executed in %s", dir)
		}
	}
}

func TestPlanWorktreeHTTPErrors(t *testing.T) {
	f := newPlanFixture(t)
	outside := t.TempDir()
	if w := getPlanRaw(t, f.s, outside, "fix-login"); w.Code != http.StatusForbidden {
		t.Fatalf("workdir outside the allowed roots: status %d, want 403: %s", w.Code, w.Body.String())
	}
	if w := getPlanRaw(t, f.s, "", "fix-login"); w.Code != http.StatusBadRequest {
		t.Fatalf("no workdir: status %d, want 400: %s", w.Code, w.Body.String())
	}

	// git fails inside a repository: the answer is a failure, not "this is not
	// a repository". (The timeout itself is covered in the session package,
	// where the limit can be lowered: TestPlanWorktreeGitTimeout.)
	broken := t.TempDir()
	if err := os.WriteFile(filepath.Join(broken, "git"), []byte("#!/bin/sh\necho boom >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", broken+string(os.PathListSeparator)+os.Getenv("PATH"))
	w := getPlanRaw(t, f.s, f.repo, "fix-login")
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if w.Code != http.StatusInternalServerError || body["error"] != "git_failed" || body["message"] == "" {
		t.Fatalf("failing git: status %d body %s, want 500 git_failed", w.Code, w.Body.String())
	}
}

// --- T13: GET /api/v1/worktrees/status, POST /api/v1/worktrees/remove ---

// wtEnv is a daemon (no tmux, /bin/cat as the CLI) over a throwaway directory
// that holds a repository named devflow with a worktree fix-login vibe-remote
// created, and `sessions` sessions running in that worktree.
type wtEnv struct {
	t    *testing.T
	mgr  *session.Manager
	s    *Server
	base string // parent of the repository, canonical
	repo string
	root string // the fix-login worktree
	ids  []string
}

func newWtEnv(t *testing.T, sessions int, roots ...string) *wtEnv {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	e := &wtEnv{t: t, mgr: projMgr(t), base: base, repo: filepath.Join(base, "devflow")}
	initRepoAt(t, e.repo)
	if err := os.WriteFile(filepath.Join(e.repo, ".gitignore"), []byte("node_modules/\n.env\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	serverGit(t, e.repo, "add", ".gitignore")
	serverGit(t, e.repo, "commit", "-m", "ignore")
	first := mustCreate(t, e.mgr, session.CreateOptions{Workdir: e.repo, Mode: protocol.SessionModeWorktree, WorktreeName: "fix-login"})
	e.root = first.WorktreeRoot
	if sessions == 0 {
		if err := e.mgr.Delete(first.ID); err != nil {
			t.Fatal(err)
		}
	} else {
		e.ids = []string{first.ID}
		for len(e.ids) < sessions {
			e.ids = append(e.ids, mustCreate(t, e.mgr, session.CreateOptions{Workdir: e.root}).ID)
		}
	}
	if len(roots) == 0 {
		roots = []string{base}
	}
	e.s = projServer(t, e.mgr, roots...)
	return e
}

func (e *wtEnv) do(method, target string, body any) *httptest.ResponseRecorder {
	e.t.Helper()
	var reader *bytes.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			e.t.Fatal(err)
		}
		reader = bytes.NewReader(data)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, target, reader)
	req.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()
	e.s.mux.ServeHTTP(w, req)
	return w
}

func (e *wtEnv) statusRaw(path string) *httptest.ResponseRecorder {
	e.t.Helper()
	return e.do(http.MethodGet, "/api/v1/worktrees/status?"+url.Values{"path": {path}}.Encode(), nil)
}

func (e *wtEnv) status(path string) protocol.WorktreeStatus {
	e.t.Helper()
	w := e.statusRaw(path)
	if w.Code != http.StatusOK {
		e.t.Fatalf("status(%s) = %d: %s", path, w.Code, w.Body.String())
	}
	var st protocol.WorktreeStatus
	if err := json.Unmarshal(w.Body.Bytes(), &st); err != nil {
		e.t.Fatal(err)
	}
	return st
}

func (e *wtEnv) remove(req protocol.WorktreeRemoveRequest) *httptest.ResponseRecorder {
	e.t.Helper()
	return e.do(http.MethodPost, "/api/v1/worktrees/remove", req)
}

// removeFailure is the body of a 4xx/5xx answer to a removal.
type removeFailure struct {
	Error         string                   `json:"error"`
	Message       string                   `json:"message"`
	Status        *protocol.WorktreeStatus `json:"status"`
	EndedSessions *[]string                `json:"endedSessions"`
}

func decodeFailure(t *testing.T, w *httptest.ResponseRecorder, status int, code string) removeFailure {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status = %d, want %d: %s", w.Code, status, w.Body.String())
	}
	var f removeFailure
	if err := json.Unmarshal(w.Body.Bytes(), &f); err != nil {
		t.Fatalf("decode %s: %v", w.Body.String(), err)
	}
	if f.Error != code {
		t.Fatalf("error = %q, want %q: %s", f.Error, code, w.Body.String())
	}
	return f
}

func removeRequest(st protocol.WorktreeStatus) protocol.WorktreeRemoveRequest {
	return protocol.WorktreeRemoveRequest{Path: st.Path, Head: st.Head, Sessions: st.Sessions}
}

func (e *wtEnv) sessionListed(id string) bool {
	for _, s := range e.mgr.List() {
		if s.ID == id {
			return true
		}
	}
	return false
}

// gitWrapper prepends a git that runs body (sh; "$@" are git's arguments, $REAL
// is the real git) and then, unless body exited, the real git.
func gitWrapper(t *testing.T, body string) {
	t.Helper()
	real, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not found")
	}
	dir := t.TempDir()
	script := "#!/bin/sh\nREAL='" + real + "'\n" + body + "\nexec \"$REAL\" \"$@\"\n"
	if err := os.WriteFile(filepath.Join(dir, "git"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestWorktreeStatusEndpoint(t *testing.T) {
	e := newWtEnv(t, 2)
	w := e.statusRaw(e.root)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"path", "project", "branch", "head", "main", "managed", "dirtyFiles", "unmergedCommits", "ignoredFiles", "sessions"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("status body has no %q: %s", key, w.Body.String())
		}
	}
	if _, ok := raw["detached"]; ok {
		t.Errorf("detached should be omitted on a branch: %s", w.Body.String())
	}
	st := e.status(e.root)
	want := protocol.WorktreeStatus{Path: e.root, Project: e.repo, Branch: "fix-login", Head: serverGitOut(t, e.root, "rev-parse", "HEAD"),
		Managed: true, Sessions: e.ids}
	if !reflect.DeepEqual(st, want) || len(st.Head) != 40 {
		t.Fatalf("status\n got %+v\nwant %+v", st, want)
	}

	t.Run("ignored", func(t *testing.T) {
		for _, name := range []string{"node_modules/a/1.js", "node_modules/a/b/2.js", "node_modules/c/3.js", ".env"} {
			path := filepath.Join(e.root, name)
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		if st := e.status(e.root); st.DirtyFiles != 0 || st.IgnoredFiles != 4 {
			t.Fatalf("status = %+v, want 0 dirty and 4 ignored", st)
		}
	})

	t.Run("errors", func(t *testing.T) {
		outside, _ := filepath.EvalSymlinks(t.TempDir())
		for name, path := range map[string]string{
			"plain directory":   e.base,
			"subdirectory":      filepath.Join(e.root, "node_modules"),
			"outside the roots": outside,
			"missing":           filepath.Join(e.base, "nope"),
		} {
			w := e.statusRaw(path)
			decodeFailure(t, w, http.StatusNotFound, "worktree_not_found")
			_ = name
		}
		if w := e.do(http.MethodGet, "/api/v1/worktrees/status", nil); w.Code != http.StatusBadRequest {
			t.Fatalf("no path: status = %d, want 400", w.Code)
		}
	})

	// allowed_roots written as a symlink (like /tmp on macOS) while git and the
	// client use the canonical path.
	t.Run("symlink_root", func(t *testing.T) {
		link := filepath.Join(t.TempDir(), "root-link")
		probe := newWtEnv(t, 0)
		if err := os.Symlink(probe.base, link); err != nil {
			t.Skipf("symlinks unsupported: %v", err)
		}
		probe.s = projServer(t, probe.mgr, link)
		st := probe.status(probe.root)
		if st.Path != probe.root || !st.Managed {
			t.Fatalf("status = %+v", st)
		}
		req := removeRequest(st)
		req.DeleteBranch = true
		if w := probe.remove(req); w.Code != http.StatusOK {
			t.Fatalf("remove = %d: %s", w.Code, w.Body.String())
		}
		if pathExists(probe.root) {
			t.Fatal("the directory is still there")
		}
	})
}

func TestWorktreeRemoveEndpoint(t *testing.T) {
	t.Run("clean", func(t *testing.T) {
		e := newWtEnv(t, 0)
		st := e.status(e.root)
		if st.DirtyFiles != 0 || st.UnmergedCommits != 0 || st.IgnoredFiles != 0 || !st.Managed {
			t.Fatalf("status = %+v", st)
		}
		req := removeRequest(st)
		req.DeleteBranch = true
		w := e.remove(req)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d: %s", w.Code, w.Body.String())
		}
		if got := strings.TrimSpace(w.Body.String()); got != `{"removed":true,"branchDeleted":true,"endedSessions":[]}` {
			t.Fatalf("body = %s", got)
		}
		if pathExists(e.root) || branchExists(t, e.repo, "fix-login") {
			t.Fatal("the directory or the branch is still there")
		}
		// Asking again: it is gone.
		decodeFailure(t, e.remove(req), http.StatusNotFound, "worktree_not_found")
	})

	t.Run("main", func(t *testing.T) {
		e := newWtEnv(t, 0)
		head := serverGitOut(t, e.repo, "rev-parse", "HEAD")
		w := e.remove(protocol.WorktreeRemoveRequest{Path: e.repo, Head: head, Sessions: []string{}, DiscardFiles: true, DeleteBranch: true, DropCommits: true})
		decodeFailure(t, w, http.StatusBadRequest, "worktree_is_main")
		if !pathExists(filepath.Join(e.repo, "README")) {
			t.Fatal("the main directory was touched")
		}
	})

	t.Run("not_found", func(t *testing.T) {
		e := newWtEnv(t, 0)
		head := serverGitOut(t, e.root, "rev-parse", "HEAD")
		for _, path := range []string{e.base, filepath.Join(e.repo, ".git"), e.root + "/", e.root + "/../fix-login"} {
			w := e.remove(protocol.WorktreeRemoveRequest{Path: path, Head: head, Sessions: []string{}, DiscardFiles: true})
			decodeFailure(t, w, http.StatusNotFound, "worktree_not_found")
		}
		if !pathExists(e.root) || !branchExists(t, e.repo, "fix-login") {
			t.Fatal("a refused request removed something")
		}
		for _, body := range []string{"", "{", `{"head":"x"}`} {
			req := httptest.NewRequest(http.MethodPost, "/api/v1/worktrees/remove", strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer secret")
			w := httptest.NewRecorder()
			e.s.mux.ServeHTTP(w, req)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("body %q: status = %d, want 400", body, w.Code)
			}
		}
	})

	t.Run("changed", func(t *testing.T) {
		e := newWtEnv(t, 1)
		req := removeRequest(e.status(e.root))
		req.DeleteBranch = true
		if err := os.WriteFile(filepath.Join(e.root, "late.txt"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		f := decodeFailure(t, e.remove(req), http.StatusConflict, "worktree_changed")
		if f.Status == nil || f.Status.DirtyFiles != 1 || f.Status.Path != e.root {
			t.Fatalf("status in the body = %+v", f.Status)
		}
		if f.EndedSessions == nil || len(*f.EndedSessions) != 0 {
			t.Fatalf("endedSessions = %v, want []", f.EndedSessions)
		}
		if !e.sessionListed(e.ids[0]) || !pathExists(filepath.Join(e.root, "late.txt")) {
			t.Fatal("the session or the file is gone")
		}
	})

	t.Run("changed_after_sessions_ended", func(t *testing.T) {
		e := newWtEnv(t, 1)
		req := removeRequest(e.status(e.root))
		req.DeleteBranch = true
		// A commit lands just before the daemon re-reads HEAD, as from a session
		// that was still working while it was being ended.
		flag := filepath.Join(t.TempDir(), "armed")
		gitWrapper(t, `if [ -e '`+flag+`' ] && [ "$3 $4" = "rev-parse HEAD" ]; then rm -f '`+flag+`'; "$REAL" -C "$2" -c user.email=t@example.com -c user.name=T commit -q --allow-empty -m late; fi`)
		if err := os.WriteFile(flag, nil, 0o644); err != nil {
			t.Fatal(err)
		}
		f := decodeFailure(t, e.remove(req), http.StatusConflict, "worktree_changed")
		tip := serverGitOut(t, e.root, "rev-parse", "HEAD")
		if tip == req.Head {
			t.Fatal("setup: the late commit was not made")
		}
		if f.Status == nil || f.Status.Head != tip {
			t.Fatalf("status in the body = %+v, want head %s", f.Status, tip)
		}
		if f.EndedSessions == nil || !reflect.DeepEqual(*f.EndedSessions, e.ids) {
			t.Fatalf("endedSessions = %v, want %v", f.EndedSessions, e.ids)
		}
		if !pathExists(e.root) || serverGitOut(t, e.repo, "rev-parse", "refs/heads/fix-login") != tip {
			t.Fatal("the directory is gone or the branch lost the commit")
		}
	})

	t.Run("git_failure", func(t *testing.T) {
		e := newWtEnv(t, 1)
		req := removeRequest(e.status(e.root))
		req.DeleteBranch = true
		gitWrapper(t, `case " $* " in *" worktree remove "*) echo 'fatal: simulated failure from the wrapper' >&2; exit 128;; esac`)
		f := decodeFailure(t, e.remove(req), http.StatusInternalServerError, "worktree_remove_failed")
		if !strings.Contains(f.Message, "simulated failure from the wrapper") {
			t.Fatalf("message = %q, want git's output", f.Message)
		}
		if f.EndedSessions == nil || !reflect.DeepEqual(*f.EndedSessions, e.ids) {
			t.Fatalf("endedSessions = %v, want %v", f.EndedSessions, e.ids)
		}
		if f.Status != nil {
			t.Fatalf("a 500 carries no status: %+v", f.Status)
		}
		if !pathExists(e.root) || !branchExists(t, e.repo, "fix-login") {
			t.Fatal("the directory or the branch is gone")
		}
	})

	t.Run("locked", func(t *testing.T) {
		e := newWtEnv(t, 2)
		serverGit(t, e.repo, "worktree", "lock", "--reason", "usb", e.root)
		req := removeRequest(e.status(e.root))
		req.DeleteBranch = true
		f := decodeFailure(t, e.remove(req), http.StatusInternalServerError, "worktree_remove_failed")
		if !strings.Contains(f.Message, "locked") {
			t.Fatalf("message = %q", f.Message)
		}
		if f.EndedSessions == nil || len(*f.EndedSessions) != 0 {
			t.Fatalf("endedSessions = %v, want []", f.EndedSessions)
		}
		w := e.do(http.MethodGet, "/api/v1/sessions", nil)
		var frame protocol.SessionsFrame
		if err := json.Unmarshal(w.Body.Bytes(), &frame); err != nil {
			t.Fatal(err)
		}
		listed := map[string]bool{}
		for _, s := range frame.List {
			listed[s.ID] = true
		}
		for _, id := range e.ids {
			if !listed[id] {
				t.Fatalf("session %s is gone from /api/v1/sessions", id)
			}
		}
	})
}

// waitForFile polls until path exists.
func waitForFile(t *testing.T, path, what string) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if pathExists(path) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", what)
}

// holdWorktreeRemove makes `git worktree remove` announce itself by creating
// the returned started file and then wait for the returned release function.
func holdWorktreeRemove(t *testing.T) (started string, release func()) {
	t.Helper()
	dir := t.TempDir()
	started, gate := filepath.Join(dir, "started"), filepath.Join(dir, "go")
	gitWrapper(t, `case " $* " in *" worktree remove "*) : > '`+started+`'; n=0; while [ ! -e '`+gate+`' ] && [ $n -lt 300 ]; do sleep 0.05; n=$((n+1)); done;; esac`)
	return started, func() {
		if err := os.WriteFile(gate, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// The desktop gives up waiting (timeout, lost connection): the daemon finishes
// the removal anyway; stopping half-way would be worse.
func TestRemoveCompletesAfterClientDisconnect(t *testing.T) {
	e := newWtEnv(t, 1)
	ts := httptest.NewServer(e.s.mux)
	defer ts.Close()
	st := e.status(e.root)
	body, _ := json.Marshal(protocol.WorktreeRemoveRequest{Path: st.Path, Head: st.Head, Sessions: st.Sessions, DeleteBranch: true})
	started, release := holdWorktreeRemove(t)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, ts.URL+"/api/v1/worktrees/remove", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer secret")
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			resp.Body.Close()
		}
		done <- err
	}()
	waitForFile(t, started, "git worktree remove to start")
	cancel()
	if err := <-done; err == nil {
		t.Fatal("the request was answered before the client went away")
	}
	if !pathExists(e.root) {
		t.Fatal("setup: the directory is already gone")
	}
	release()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) && (pathExists(e.root) || branchExists(t, e.repo, "fix-login")) {
		time.Sleep(20 * time.Millisecond)
	}
	if pathExists(e.root) || branchExists(t, e.repo, "fix-login") {
		t.Fatal("the removal stopped when the client disconnected")
	}
	if e.sessionListed(e.ids[0]) {
		t.Fatal("the session is still listed")
	}
}

// While a worktree is being removed, an attach that would start a session in
// it is refused for good.
func TestAttachRefusedWhileWorktreeRemoving(t *testing.T) {
	c := newChatServer(t, withClaudeCmd("/bin/cat"))
	c.mgr.SetProjectStore(session.NewMemoryProjectStore())
	repo := c.repo("devflow")
	ready := c.attachTerminal(c.connect(), protocol.AttachFrame{NewSessionID: newSID("wtr"), Workdir: repo,
		Mode: protocol.SessionModeWorktree, WorktreeName: "fix-login"})
	root := ready.WorktreeRoot
	st, err := c.mgr.WorktreeStatus(root, c.cfg.ResolveAllowedWorkdir)
	if err != nil {
		t.Fatal(err)
	}
	started, release := holdWorktreeRemove(t)
	removed := make(chan error, 1)
	go func() {
		_, err := c.mgr.RemoveWorktree(protocol.WorktreeRemoveRequest{Path: st.Path, Head: st.Head, Sessions: st.Sessions, DeleteBranch: true}, c.cfg.ResolveAllowedWorkdir)
		removed <- err
	}()
	waitForFile(t, started, "git worktree remove to start")
	e := expectAttachError(t, c.connect(), protocol.AttachFrame{NewSessionID: newSID("late"), Workdir: root})
	if e.Code != protocol.ErrCodeCreateFailed || !e.Fatal || !strings.Contains(e.Message, "being removed") {
		t.Fatalf("error %+v, want fatal create_failed saying the worktree is being removed", e)
	}
	release()
	if err := <-removed; err != nil {
		t.Fatalf("removal: %v", err)
	}
	if pathExists(root) {
		t.Fatal("the directory is still there")
	}
}

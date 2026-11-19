package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

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

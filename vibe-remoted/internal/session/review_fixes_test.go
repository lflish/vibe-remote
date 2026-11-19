package session

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// Regression tests for the findings of the code review of the project and
// worktree change (docs/changes/2026-11-16-project-worktrees, review of
// e278f87).

// A session whose directory is inside the worktree loses it with the worktree,
// whatever it is attributed to: here its workdir is a repository of its own in
// an ignored directory, so its project and home are that repository.
func TestRemoveEndsSessionsAttributedElsewhere(t *testing.T) {
	f := newRemoveFixture(t, 0)
	nested := repoAt(t, filepath.Join(f.root, "vendor", "lib"))
	id := f.addSession(nested)
	r, _ := f.m.Get(id)
	if _, home := r.Home(); home != nested {
		t.Fatalf("home = %q, want the nested repository %q (the case under test)", home, nested)
	}

	st := f.status()
	if !reflect.DeepEqual(st.Sessions, []string{id}) {
		t.Fatalf("status.sessions = %v, want the session whose workdir is inside the worktree (%s)", st.Sessions, id)
	}

	// Not confirmed: refused, and the session keeps running.
	unconfirmed := request(st)
	unconfirmed.Sessions = []string{}
	_, err := f.remove(unconfirmed)
	if changed := wantChanged(t, err); !reflect.DeepEqual(changed.Status.Sessions, []string{id}) || len(changed.EndedSessions) != 0 {
		t.Fatalf("changed = %+v", changed)
	}
	if !f.alive(id) {
		t.Fatal("the session was ended by a refused removal")
	}
	f.intact()

	req := request(st)
	req.DeleteBranch = true
	res := f.mustRemove(req)
	if !reflect.DeepEqual(res.EndedSessions, []string{id}) {
		t.Fatalf("endedSessions = %v, want [%s]", res.EndedSessions, id)
	}
	if _, ok := f.m.Get(id); ok {
		t.Fatal("the session is still registered after its directory was removed")
	}
}

// listedWorktreeOnBranch returns the path git lists for the worktree that has
// branch checked out, or "".
func listedWorktreeOnBranch(t *testing.T, repo, branch string) string {
	t.Helper()
	wts, err := ListWorktrees(repo)
	if err != nil {
		t.Fatal(err)
	}
	for _, wt := range wts {
		if wt.Branch == branch {
			return wt.Path
		}
	}
	return ""
}

// symlinkedContainerRepo is a repository devflow whose devflow-worktrees is a
// symlink to another directory (worktrees kept on another disk). It returns
// the repository and the directory the link points at.
func symlinkedContainerRepo(t *testing.T) (repo, target string) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo = repoAt(t, filepath.Join(base, "devflow"))
	target = filepath.Join(base, "bigdisk", "devflow-wts")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, containerOf(repo)); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	return repo, target
}

// The new worktree is recorded under the path and branch git registered, not
// the ones the daemon put together: with a symlinked container the two differ,
// and every later comparison with git's list would miss.
func TestCreateWorktreeUnderSymlinkedContainer(t *testing.T) {
	repo, target := symlinkedContainerRepo(t)
	m := NewManager(false, "/bin/cat", false, "")
	store := NewMemoryProjectStore()
	m.SetProjectStore(store)
	r, err := m.Create(CreateOptions{Workdir: repo, Mode: protocol.SessionModeWorktree, WorktreeName: "feat", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Kill() })

	listed := listedWorktreeOnBranch(t, repo, "feat")
	if listed != filepath.Join(target, "feat") {
		t.Fatalf("git lists the worktree at %q, want it under the link's target %q", listed, target)
	}
	if got := r.Metadata().WorktreeRoot; got != listed {
		t.Fatalf("session worktreeRoot = %q, want the path git lists %q", got, listed)
	}
	if _, home := r.Home(); home != listed {
		t.Fatalf("session home = %q, want %q", home, listed)
	}
	ps := m.Projects(allowAny)
	row := worktreeRow(ps, listed)
	if row == nil || !row.Managed || !reflect.DeepEqual(row.Sessions, []string{r.ID}) {
		t.Fatalf("worktree row = %+v, want managed with session %s (projects: %+v)", row, r.ID, ps)
	}
	if !store.Managed(repo, listed, "feat") {
		t.Fatalf("no creation record for %s: %+v", listed, store.Worktrees())
	}
	st, err := m.WorktreeStatus(listed, allowAny)
	if err != nil || !reflect.DeepEqual(st.Sessions, []string{r.ID}) || !st.Managed {
		t.Fatalf("status = %+v, %v; want managed with session %s", st, err, r.ID)
	}
	req := request(st)
	req.DeleteBranch = true
	res, err := m.RemoveWorktree(req, allowAny)
	if err != nil || !res.Removed || !res.BranchDeleted || !reflect.DeepEqual(res.EndedSessions, []string{r.ID}) {
		t.Fatalf("remove = %+v, %v", res, err)
	}
	if _, ok := m.Get(r.ID); ok || pathExists(listed) || branchOID(t, repo, "feat") != "" {
		t.Fatal("the session, the directory or the branch is left")
	}
}

// A create that fails after git worktree add takes the worktree back even when
// git registered it under another spelling of the path.
func TestUndoUnderSymlinkedContainer(t *testing.T) {
	check := func(t *testing.T, repo, target string) {
		t.Helper()
		if listed := listedWorktreeOnBranch(t, repo, "feat"); listed != "" {
			t.Fatalf("git still lists the worktree at %s", listed)
		}
		if got := strings.TrimSpace(runGit(t, repo, "worktree", "list", "--porcelain")); strings.Count(got, "worktree ") != 1 {
			t.Fatalf("worktree list is not back to the main directory alone:\n%s", got)
		}
		if branchOID(t, repo, "feat") != "" {
			t.Fatal("branch feat is left")
		}
		if names := dirNames(t, target); len(names) != 0 {
			t.Fatalf("left in the container: %v", names)
		}
	}
	t.Run("create_fails_after_add", func(t *testing.T) {
		repo, target := symlinkedContainerRepo(t)
		// $1 $2 are "-C <dir>".
		installGitWrapper(t, `if [ "$3" = symbolic-ref ]; then echo "fatal: simulated" >&2; exit 128; fi`)
		_, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "feat"})
		if err == nil || strings.Contains(err.Error(), "cleanup:") {
			t.Fatalf("err = %v, want the create to fail with a clean undo", err)
		}
		check(t, repo, target)
	})
	t.Run("undo_after_create", func(t *testing.T) {
		repo, target := symlinkedContainerRepo(t)
		created, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "feat"})
		if err != nil {
			t.Fatal(err)
		}
		if err := created.Undo(); err != nil {
			t.Fatalf("Undo = %v", err)
		}
		check(t, repo, target)
	})
}

// A name in decomposed Unicode (as copied from Finder): where git registers
// the precomposed spelling (macOS, core.precomposeunicode), that spelling is
// the one recorded.
func TestCreateWorktreeRecordsGitsSpellingOfTheName(t *testing.T) {
	repo := devflowRepo(t)
	m := NewManager(false, "/bin/cat", false, "")
	store := NewMemoryProjectStore()
	m.SetProjectStore(store)
	nfd := "cafe\u0301" // e + combining acute accent
	r, err := m.Create(CreateOptions{Workdir: repo, Mode: protocol.SessionModeWorktree, WorktreeName: nfd, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Kill() })
	wts, err := ListWorktrees(repo)
	if err != nil || len(wts) != 2 {
		t.Fatalf("worktrees = %+v, %v; want the main directory and the new one", wts, err)
	}
	git := wts[1]
	meta := r.Metadata()
	if meta.WorktreeRoot != git.Path || meta.Branch != git.Branch {
		t.Fatalf("session says %q on %q; git lists %q on %q", meta.WorktreeRoot, meta.Branch, git.Path, git.Branch)
	}
	row := worktreeRow(m.Projects(allowAny), git.Path)
	if row == nil || !row.Managed || !reflect.DeepEqual(row.Sessions, []string{r.ID}) {
		t.Fatalf("worktree row = %+v, want managed with session %s", row, r.ID)
	}
}

// A creation record is dropped only when its project's list was read this
// round and does not have the worktree. Three ways the record used to be lost
// while the worktree was still there, after which its branch could no longer
// be deleted from the desktop.
func TestProjectsKeepsRecordOfExistingWorktree(t *testing.T) {
	managedRow := func(t *testing.T, m *Manager, root string) {
		t.Helper()
		ps := m.Projects(allowAny)
		if row := worktreeRow(ps, root); row == nil || !row.Managed {
			t.Fatalf("worktree row = %+v, want it managed (projects: %+v)", row, ps)
		}
	}

	// The poll lands between `git worktree add` and the session being
	// registered, in a repository that has not hosted a session yet: the
	// project is not one of those read this round.
	t.Run("poll_during_create_in_unlisted_project", func(t *testing.T) {
		repo := devflowRepo(t)
		m := NewManager(false, "/bin/cat", false, "")
		store := NewMemoryProjectStore()
		m.SetProjectStore(store)
		polled := false
		m.testAfterBeginStart = func(string) {
			polled = true
			if len(store.Worktrees()) != 1 {
				t.Errorf("records at the time of the poll = %+v, want the new worktree's", store.Worktrees())
			}
			m.Projects(allowAny)
		}
		r, err := m.Create(CreateOptions{Workdir: repo, Mode: protocol.SessionModeWorktree, WorktreeName: "w1", Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { r.Kill() })
		if !polled {
			t.Fatal("the poll did not run during the create")
		}
		if !store.Managed(repo, r.WorktreeRoot, "w1") {
			t.Fatalf("the creation record was dropped by the poll: %+v", store.Worktrees())
		}
		managedRow(t, m, r.WorktreeRoot)
	})

	// One round in which the project's git fails.
	t.Run("git_fails_one_round", func(t *testing.T) {
		f := newRemoveFixture(t, 1)
		managedRow(t, f.m, f.root)
		origPATH := os.Getenv("PATH")
		installGitWrapper(t, `if [ "$3" = worktree ] && [ "$4" = list ]; then echo "fatal: simulated" >&2; exit 128; fi`)
		p := findProject(f.m.Projects(allowAny), f.repo)
		if p == nil || p.Error != "git_failed" {
			t.Fatalf("project while git fails = %+v, want git_failed", p)
		}
		t.Setenv("PATH", origPATH)
		if !f.store.Managed(f.repo, f.root, "fix-login") {
			t.Fatalf("the creation record was dropped in the failed round: %+v", f.store.Worktrees())
		}
		managedRow(t, f.m, f.root)
	})

	// R2.3: removing the project from the sidebar changes nothing on disk, and
	// it comes back as it was.
	t.Run("project_removed_and_back", func(t *testing.T) {
		f := newRemoveFixture(t, 0)
		managedRow(t, f.m, f.root)
		if err := f.m.RemoveProject(f.repo); err != nil {
			t.Fatal(err)
		}
		if p := findProject(f.m.Projects(allowAny), f.repo); p != nil {
			t.Fatalf("the removed project is still listed: %+v", p)
		}
		f.addSession(f.repo)
		managedRow(t, f.m, f.root)
	})

	// The allowed roots no longer cover the worktree (configuration changed):
	// git still lists it, so its record stays.
	t.Run("worktree_outside_allowed_roots", func(t *testing.T) {
		f := newRemoveFixture(t, 0)
		f.addSession(f.repo)
		onlyMain := func(path string) (string, error) {
			if !within(f.repo, path) {
				return "", errors.New("not allowed")
			}
			return path, nil
		}
		if row := worktreeRow(f.m.Projects(onlyMain), f.root); row != nil {
			t.Fatalf("a worktree outside the allowed roots is listed: %+v", row)
		}
		managedRow(t, f.m, f.root)
	})
}

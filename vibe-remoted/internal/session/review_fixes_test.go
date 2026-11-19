package session

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
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

// unbornWorktree adds a worktree on a branch that has no commit yet and
// returns its path; the test is skipped where git has no --orphan for it.
func unbornWorktree(t *testing.T, repo string) string {
	t.Helper()
	path := filepath.Join(filepath.Dir(repo), "unborn-wt")
	if out, err := exec.Command("git", "-C", repo, "worktree", "add", "--orphan", "-b", "unborn", path).CombinedOutput(); err != nil {
		t.Skipf("this git cannot add a worktree on an unborn branch: %v: %s", err, out)
	}
	return path
}

// A worktree whose branch has no commit yet can be looked at and removed like
// any other; there is no commit to lose.
func TestStatusAndRemoveUnbornWorktree(t *testing.T) {
	repo := devflowRepo(t)
	path := unbornWorktree(t, repo)
	m := NewManager(false, "/bin/cat", false, "")
	m.SetProjectStore(NewMemoryProjectStore())

	st, err := m.WorktreeStatus(path, allowAny)
	if err != nil {
		t.Fatalf("WorktreeStatus = %v, want the status of a worktree with no commits", err)
	}
	if st.Branch != "unborn" || st.UnmergedCommits != 0 || st.DirtyFiles != 0 || st.Managed || strings.Trim(st.Head, "0") != "" {
		t.Fatalf("status = %+v, want branch unborn, an all-zero head and nothing to lose", st)
	}

	t.Run("commit_after_confirmation_is_noticed", func(t *testing.T) {
		repo := devflowRepo(t)
		path := unbornWorktree(t, repo)
		m := NewManager(false, "/bin/cat", false, "")
		st, err := m.WorktreeStatus(path, allowAny)
		if err != nil {
			t.Fatal(err)
		}
		tip := emptyCommits(t, path, 1)
		_, err = m.RemoveWorktree(request(st), allowAny)
		if changed := wantChanged(t, err); changed.Status.Head != tip || changed.Status.UnmergedCommits != 1 {
			t.Fatalf("changed = %+v, want the new commit %s reported", changed.Status, tip)
		}
		if !pathExists(path) {
			t.Fatal("the worktree was removed")
		}
	})

	res, err := m.RemoveWorktree(request(st), allowAny)
	if err != nil || !res.Removed {
		t.Fatalf("RemoveWorktree = %+v, %v", res, err)
	}
	if pathExists(path) || worktreeListed(t, repo, path) {
		t.Fatal("the worktree is still there")
	}
}

// A worktree is created from a commit: where the source has none, the
// pre-check says so (and no name can work), and creating fails the same way
// without leaving anything.
func TestPlanRefusesSourceWithoutCommits(t *testing.T) {
	check := func(t *testing.T, repo, source string) {
		t.Helper()
		m := NewManager(false, "/bin/cat", false, "")
		for _, name := range []string{"q", ""} {
			plan, err := m.PlanWorktree(source, name, nil)
			if err != nil {
				t.Fatalf("PlanWorktree(%q) = %v", name, err)
			}
			if plan.OK || plan.Error != "no_commits" || plan.Message == "" || plan.Project != repo || plan.Base == nil {
				t.Fatalf("plan(%q) = %+v, want no_commits with the project and base filled in", name, plan)
			}
		}
		_, err := CreateWorktree(WorktreeSpec{Source: source, SessionID: "s1", Name: "q"})
		if !errors.Is(err, ErrSourceNoCommits) {
			t.Fatalf("create err = %v, want ErrSourceNoCommits", err)
		}
		if branchOID(t, repo, "q") != "" || pathExists(filepath.Join(containerOf(repo), "q")) {
			t.Fatal("the refused create left a branch or a directory")
		}
	}
	t.Run("unborn_worktree", func(t *testing.T) {
		repo := devflowRepo(t)
		check(t, repo, unbornWorktree(t, repo))
	})
	t.Run("fresh_repository", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "fresh")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		runGit(t, dir, "init", "-b", "main")
		repo := runGit(t, dir, "rev-parse", "--show-toplevel")
		check(t, repo, repo)
	})
}

// A session started in a plain directory keeps its non-git project when a
// directory above it becomes a repository later: the session's directory is
// not that repository's main directory, so it is not a git project, the real
// main directory is not listed under it as a removable worktree, and nothing
// is added to the project list.
func TestProjectsDirectoryInsideLaterRepositoryIsNotAProject(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	plain := filepath.Join(base, "plain")
	sub := filepath.Join(plain, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	m := NewManager(false, "/bin/cat", false, "")
	store := NewMemoryProjectStore()
	m.SetProjectStore(store)
	r, err := m.Create(CreateOptions{Workdir: sub, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Kill() })
	if p := findProject(m.Projects(allowAny), sub); p == nil || p.Git {
		t.Fatalf("before git init: project = %+v, want the non-git project %s", p, sub)
	}

	repoAt(t, plain)
	check := func(t *testing.T) {
		t.Helper()
		ps := m.Projects(allowAny)
		p := findProject(ps, sub)
		if p == nil {
			t.Fatalf("the session's project is gone: %+v", ps)
		}
		if p.Git || p.Error != "" || len(p.Worktrees) != 0 || !reflect.DeepEqual(p.Sessions, []string{r.ID}) {
			t.Fatalf("project = %+v, want non-git with the session at the project level and no worktrees", *p)
		}
		for _, id := range store.Projects() {
			if id == sub {
				t.Fatalf("%s was added to the project list: %v", sub, store.Projects())
			}
		}
	}
	check(t)
	check(t) // and it stays that way on the next round

	// An entry the list already has for such a directory (written before this
	// was checked) is not shown as a git project either, and is not shown at
	// all once its last session is gone.
	store.AddProject(sub)
	if p := findProject(m.Projects(allowAny), sub); p == nil || p.Git || len(p.Worktrees) != 0 {
		t.Fatalf("listed entry = %+v, want non-git and no worktrees", p)
	}
	if err := m.Delete(r.ID); err != nil {
		t.Fatal(err)
	}
	if p := findProject(m.Projects(allowAny), sub); p != nil {
		t.Fatalf("project outlived its last session: %+v", *p)
	}
}

// The user confirmed "directory and branch"; by the time the request arrives
// the worktree is on another branch, so it is no longer the worktree
// vibe-remote created and its branch cannot go with it. That is not what was
// confirmed: nothing is removed and the current state comes back, instead of
// the directory going and the branch silently staying.
func TestRemoveBranchSwitchedAfterConfirmation(t *testing.T) {
	setup := func(t *testing.T) (*removeFixture, protocol.WorktreeStatus) {
		t.Helper()
		f := newRemoveFixture(t, 1)
		st := f.status()
		if st.Branch != "fix-login" || !st.Managed {
			t.Fatalf("status = %+v, want managed on fix-login", st)
		}
		runGit(t, f.root, "switch", "-c", "other") // HEAD does not move
		return f, st
	}
	refused := func(t *testing.T, f *removeFixture, req protocol.WorktreeRemoveRequest) protocol.WorktreeStatus {
		t.Helper()
		_, err := f.remove(req)
		changed := wantChanged(t, err)
		if changed.Status.Branch != "other" || changed.Status.Managed || len(changed.EndedSessions) != 0 {
			t.Fatalf("changed = %+v, want the current state (unmanaged, on other) and nobody ended", changed)
		}
		if !f.alive(f.ids[0]) {
			t.Fatal("the session was ended by a refused removal")
		}
		if !pathExists(f.root) || branchOID(t, f.repo, "fix-login") == "" || branchOID(t, f.repo, "other") == "" {
			t.Fatal("the directory or a branch is gone")
		}
		return changed.Status
	}

	// A request without the branch (an older desktop): deleteBranch can only
	// have been confirmed for a worktree that was managed and on a branch.
	t.Run("delete_branch_no_longer_possible", func(t *testing.T) {
		f, st := setup(t)
		req := request(st)
		req.DeleteBranch = true
		cur := refused(t, f, req)
		// Confirmed again against the current state: the directory goes, both
		// branches stay.
		res := f.mustRemove(request(cur))
		if res.BranchDeleted || res.BranchError != "" {
			t.Fatalf("result = %+v", res)
		}
		if branchOID(t, f.repo, "fix-login") == "" || branchOID(t, f.repo, "other") == "" {
			t.Fatal("a branch was removed")
		}
	})

	// With the branch the confirmation showed, a switch is noticed whatever
	// was agreed to.
	t.Run("confirmed_branch_differs", func(t *testing.T) {
		f, st := setup(t)
		req := request(st)
		req.Branch = st.Branch
		refused(t, f, req)
	})

	// Unchanged, with the branch given: carried out as before.
	t.Run("confirmed_branch_matches", func(t *testing.T) {
		f := newRemoveFixture(t, 0)
		st := f.status()
		req := request(st)
		req.Branch, req.DeleteBranch = st.Branch, true
		if res := f.mustRemove(req); !res.BranchDeleted {
			t.Fatalf("result = %+v", res)
		}
	})
}

// A git repository of its own that sits untracked in the worktree shows up as
// one untracked "file", whatever is committed inside it. The confirmation's
// number says nothing of those commits, so the removal is refused before
// anything is touched, whatever was agreed to.
func TestRemoveUntrackedRepositoryRefused(t *testing.T) {
	f := newRemoveFixture(t, 1)
	scratch := filepath.Join(f.root, "tools", "scratch")
	repoAt(t, scratch)
	tip := emptyCommits(t, scratch, 3)
	st := f.status()
	if st.DirtyFiles != 1 {
		t.Fatalf("dirtyFiles = %d, want 1 (git reports the nested repository as one entry: the case under test)", st.DirtyFiles)
	}
	log := installArgLoggingGit(t)
	for _, discard := range []bool{true, false} {
		req := request(st)
		req.DiscardFiles, req.DeleteBranch = discard, true
		_, err := f.remove(req)
		failed := wantRemoveError(t, err)
		if !strings.Contains(failed.Message, scratch) || len(failed.EndedSessions) != 0 {
			t.Fatalf("discardFiles=%v: failed = %+v, want the nested repository %s named and nobody ended", discard, failed, scratch)
		}
		if !f.alive(f.ids[0]) {
			t.Fatalf("discardFiles=%v: the session was ended", discard)
		}
		f.intact()
		if !commitExists(scratch, tip) {
			t.Fatalf("discardFiles=%v: the nested repository lost its commits", discard)
		}
	}
	if hasGitCall(loggedGitCalls(t, log), "worktree", "remove") {
		t.Fatal("git worktree remove was run")
	}

	// Moved out of the way, the worktree can be removed.
	if err := os.Rename(scratch, filepath.Join(t.TempDir(), "scratch")); err != nil {
		t.Fatal(err)
	}
	req := request(f.status())
	req.DeleteBranch = true
	f.mustRemove(req)
}

func TestUntrackedRepositories(t *testing.T) {
	f := newRemoveFixture(t, 0)
	list := func() []string {
		t.Helper()
		got, err := UntrackedRepositories(f.root)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	// Plain untracked files and directories, and a repository in an ignored
	// directory (git does not report that one at all), are not it.
	writeFiles(t, f.root, "notes.txt", "docs/a.md", "docs/deep/b.md")
	repoAt(t, filepath.Join(f.root, "vendor", "lib"))
	if got := list(); len(got) != 0 {
		t.Fatalf("UntrackedRepositories = %v, want none", got)
	}
	one := filepath.Join(f.root, "scratch")
	two := filepath.Join(f.root, "docs", "deep", "with space")
	repoAt(t, one)
	repoAt(t, two)
	if got := list(); !reflect.DeepEqual(got, []string{two, one}) && !reflect.DeepEqual(got, []string{one, two}) {
		t.Fatalf("UntrackedRepositories = %v, want %s and %s", got, one, two)
	}
}

// fsmonitorProbe configures core.fsmonitor in repo to a program that records
// each run, and returns how to read and reset the record. The test is skipped
// where git does not run such a program on status at all.
func fsmonitorProbe(t *testing.T, repo, worktree string) (ran func() bool, reset func()) {
	t.Helper()
	marker := filepath.Join(t.TempDir(), "ran")
	hook := filepath.Join(t.TempDir(), "fsmonitor.sh")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\necho run >> '"+marker+"'\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "config", "core.fsmonitor", hook)
	ran = func() bool { return pathExists(marker) }
	reset = func() {
		if err := os.Remove(marker); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	}
	_ = exec.Command("git", "-C", worktree, "status", "--porcelain").Run()
	if !ran() {
		t.Skip("this git does not run a core.fsmonitor program on status")
	}
	reset()
	return ran, reset
}

// The git calls the daemon makes to look at a repository do not run a program
// the repository's configuration names (core.fsmonitor is the setting that
// makes index-reading commands do so). Looking includes the checks of a
// removal that ends up refused.
func TestReadOnlyGitRunsNoRepositoryProgram(t *testing.T) {
	f := newRemoveFixture(t, 1)
	writeFiles(t, f.root, "untracked.txt", "node_modules/x.js")
	ran, _ := fsmonitorProbe(t, f.repo, f.root)
	step := func(name string) {
		t.Helper()
		if ran() {
			t.Fatalf("%s ran the repository's core.fsmonitor program", name)
		}
	}

	if _, err := ResolveHome(f.root); err != nil {
		t.Fatal(err)
	}
	step("ResolveHome")
	if p := findProject(f.m.Projects(allowAny), f.repo); p == nil || p.Error != "" {
		t.Fatalf("project = %+v", p)
	}
	step("Projects")
	if plan, err := f.m.PlanWorktree(f.root, "another", nil); err != nil || !plan.OK {
		t.Fatalf("plan = %+v, %v", plan, err)
	}
	step("PlanWorktree")
	ChatTrust(f.root)
	step("ChatTrust")
	st := f.status()
	if st.DirtyFiles != 1 || st.IgnoredFiles != 1 {
		t.Fatalf("status = %+v, want 1 dirty and 1 ignored", st)
	}
	step("WorktreeStatus")
	if has, err := HasSubmoduleCheckouts(f.root); err != nil || has {
		t.Fatalf("HasSubmoduleCheckouts = %v, %v", has, err)
	}
	step("HasSubmoduleCheckouts")
	if _, err := UntrackedRepositories(f.root); err != nil {
		t.Fatal(err)
	}
	step("UntrackedRepositories")

	// Refused: the head is not the one confirmed. Nothing changes, and nothing
	// of the repository's is run on the way to finding that out.
	stale := request(st)
	stale.Head = strings.Repeat("0", len(st.Head)-1) + "1"
	stale.DiscardFiles = true
	_, err := f.remove(stale)
	wantChanged(t, err)
	step("a refused RemoveWorktree")
	f.intact()
}

// Creating and removing a worktree do not run it either: the setting is off
// for every git process the daemon starts, and for the ones those start.
func TestCreateAndRemoveWorktreeDoNotRunFsmonitor(t *testing.T) {
	f := newRemoveFixture(t, 0)
	writeFiles(t, f.root, "untracked.txt")
	ran, _ := fsmonitorProbe(t, f.repo, f.root)

	req := request(f.status())
	req.DiscardFiles, req.DeleteBranch = true, true
	f.mustRemove(req)
	if ran() {
		t.Fatal("removing a worktree ran the repository's core.fsmonitor program")
	}
	created, err := CreateWorktree(WorktreeSpec{Source: f.repo, SessionID: "s1", Name: "again"})
	if err != nil {
		t.Fatal(err)
	}
	if ran() {
		t.Fatal("creating a worktree ran the repository's core.fsmonitor program")
	}
	if err := created.Undo(); err != nil {
		t.Fatal(err)
	}
	if ran() {
		t.Fatal("undoing a created worktree ran the repository's core.fsmonitor program")
	}
}

// Configuration the daemon's own environment passes to git (a container that
// sets safe.directory this way) is kept; the daemon's setting is added to it.
func TestGitEnvKeepsInheritedConfig(t *testing.T) {
	repo := tempRepo(t)
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "vibe.inherited")
	t.Setenv("GIT_CONFIG_VALUE_0", "kept")
	for key, want := range map[string]string{"vibe.inherited": "kept", "core.fsmonitor": "false"} {
		out, err := gitAtTimeout(repo, "config", "--get", key)
		if err != nil || strings.TrimSpace(string(out)) != want {
			t.Fatalf("git config %s = %q, %v; want %q", key, out, err, want)
		}
	}
}

// reviewNameVectors are the names the two rules added after the review decide,
// in the form of testdata/worktree-names.json (local: the desktop reaches the
// same reason without asking the daemon).
var reviewNameVectors = []struct {
	label, name string
	ok          bool
}{
	// The name becomes one directory name (slashes turn into hyphens) and each
	// part of it a ref file with ".lock" appended while it is written: more
	// than 250 bytes cannot be created.
	{"250 bytes", strings.Repeat("x", 250), true},
	{"251 bytes", strings.Repeat("x", 251), false},
	{"252 bytes", strings.Repeat("x", 252), false},
	{"300 bytes", strings.Repeat("x", 300), false},
	{"251 bytes in two parts", strings.Repeat("a", 125) + "/" + strings.Repeat("b", 125), false},
	{"250 bytes in two parts", strings.Repeat("a", 125) + "/" + strings.Repeat("b", 124), true},
	{"84 CJK characters = 252 bytes", strings.Repeat("功", 84), false},
	{"83 CJK characters = 249 bytes", strings.Repeat("功", 83), true},
	// Characters that are not shown (Unicode Cf): a name that looks exactly
	// like another branch, or reads in another order.
	{"zero width space", "a\u200bb", false},
	{"zero width joiner", "a\u200db", false},
	{"right-to-left override", "a\u202eb", false},
	{"left-to-right mark", "a\u200eb", false},
	{"byte order mark", "a\ufeffb", false},
	{"soft hyphen", "a\u00adb", false},
	{"word joiner", "a\u2060b", false},
	{"tag character", "a\U000e0041b", false},
}

func TestWorktreeNameLengthAndInvisibleCharacters(t *testing.T) {
	repo := devflowRepo(t)
	m := NewManager(false, "/bin/cat", false, "")
	for _, v := range reviewNameVectors {
		t.Run(v.label, func(t *testing.T) {
			problem := worktreeNameProblem(v.name)
			plan, err := m.PlanWorktree(repo, v.name, nil)
			if err != nil {
				t.Fatalf("PlanWorktree: %v", err)
			}
			if !v.ok {
				if problem != "invalid" {
					t.Errorf("local rules report %q, want invalid", problem)
				}
				if plan.OK || plan.Error != "invalid_worktree_name" {
					t.Errorf("plan = {ok:%v error:%q}, want invalid_worktree_name", plan.OK, plan.Error)
				}
				return
			}
			if problem != "" || !plan.OK {
				t.Fatalf("local rules report %q, plan = {ok:%v error:%q %s}; want the name accepted", problem, plan.OK, plan.Error, plan.Message)
			}
			// What the pre-check accepts can be created.
			created, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: v.name})
			if err != nil {
				t.Fatalf("the pre-check accepted the name, creating it failed: %v", err)
			}
			if err := created.Undo(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// A path the file system refuses for its length is not "outside the allowed
// roots".
func TestTooLongPathIsNotReportedAsNotAllowed(t *testing.T) {
	spec := WorktreeSpec{AllowPath: func(path string) error {
		return &os.PathError{Op: "lstat", Path: path, Err: syscall.ENAMETOOLONG}
	}}
	err := allowWorktreePath(spec, "/somewhere/long")
	if err == nil || errors.Is(err, ErrWorktreePathNotAllowed) {
		t.Fatalf("err = %v, want an error that is not ErrWorktreePathNotAllowed", err)
	}
	spec.AllowPath = func(string) error { return errors.New("workdir not in allowed roots") }
	if err := allowWorktreePath(spec, "/elsewhere"); !errors.Is(err, ErrWorktreePathNotAllowed) {
		t.Fatalf("err = %v, want ErrWorktreePathNotAllowed", err)
	}
}

// Creating a worktree for a name the local rules refuse starts no git process
// at all: not for the name, and not to look at the repository first.
func TestCreateRefusesBadWorktreeNameBeforeAnyGit(t *testing.T) {
	repo := devflowRepo(t)
	m := NewManager(false, "/bin/cat", false, "")
	m.SetProjectStore(NewMemoryProjectStore())
	log := installArgLoggingGit(t)
	for _, name := range []string{"-x", "--force", "a b", "a..b", "@{-1}", "a\u200bb", strings.Repeat("x", 251)} {
		if _, err := m.Create(CreateOptions{Workdir: repo, Mode: protocol.SessionModeWorktree, WorktreeName: name, Cols: 80, Rows: 24}); !errors.Is(err, ErrInvalidWorktreeName) {
			t.Errorf("Create(%q) = %v, want ErrInvalidWorktreeName", name, err)
		}
		if _, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: name}); !errors.Is(err, ErrInvalidWorktreeName) {
			t.Errorf("CreateWorktree(%q) = %v, want ErrInvalidWorktreeName", name, err)
		}
	}
	if calls := loggedGitCalls(t, log); len(calls) != 0 {
		t.Fatalf("git ran for names the local rules refuse: %v", calls)
	}
	// In a directory that is not a repository the name is still what is wrong
	// first when a session is created; the pre-check, which reports on the
	// directory, says not_git.
	plain := t.TempDir()
	if _, err := m.Create(CreateOptions{Workdir: plain, Mode: protocol.SessionModeWorktree, WorktreeName: "-x", Cols: 80, Rows: 24}); !errors.Is(err, ErrInvalidWorktreeName) {
		t.Fatalf("Create in a plain directory = %v, want ErrInvalidWorktreeName", err)
	}
	if plan, err := m.PlanWorktree(plain, "-x", nil); err != nil || plan.Error != "not_git" {
		t.Fatalf("plan in a plain directory = %+v, %v; want not_git", plan, err)
	}
	// The pre-check looks at the repository first, so that it can say where the
	// worktree would go and what it would be based on even for such a name; the
	// name itself is in no git command line.
	log = installArgLoggingGit(t)
	plan, err := m.PlanWorktree(repo, "-zz9", nil)
	if err != nil || plan.Error != "invalid_worktree_name" || plan.Project != repo || plan.Base == nil {
		t.Fatalf("plan = %+v, %v; want invalid_worktree_name with project and base", plan, err)
	}
	calls := loggedGitCalls(t, log)
	if len(calls) == 0 {
		t.Fatal("the pre-check ran no git: the check below proves nothing")
	}
	for _, call := range calls {
		for _, arg := range call {
			if strings.Contains(arg, "zz9") {
				t.Fatalf("the refused name reached git: %v", call)
			}
		}
	}
}

// What is promised about the path of worktrees/status and worktrees/remove
// (docs/protocol.md): a path outside the allowed roots, or not written in its
// canonical form, is refused without git being run at all; one that passes is
// then looked at with read-only git commands only, and refused unless it is a
// worktree root the repository lists.
func TestWorktreePathChecksBeforeGit(t *testing.T) {
	f := newRemoveFixture(t, 0)
	outside := repoAt(t, filepath.Join(t.TempDir(), "elsewhere"))
	link := filepath.Join(filepath.Dir(f.repo), "link-to-worktree")
	if err := os.Symlink(f.root, link); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	base := filepath.Dir(f.repo)
	allow := func(path string) (string, error) {
		canonical, err := filepath.EvalSymlinks(path)
		if err != nil {
			return "", err
		}
		if !within(base, canonical) {
			return "", errors.New("not in allowed roots")
		}
		return canonical, nil
	}
	head := runGit(t, f.root, "rev-parse", "HEAD")
	refused := func(t *testing.T, path string) {
		t.Helper()
		if _, err := f.m.WorktreeStatus(path, allow); !errors.Is(err, ErrWorktreeNotFound) {
			t.Fatalf("WorktreeStatus(%s) = %v, want ErrWorktreeNotFound", path, err)
		}
		req := protocol.WorktreeRemoveRequest{Path: path, Head: head, Sessions: []string{}, DiscardFiles: true, DropCommits: true}
		if _, err := f.m.RemoveWorktree(req, allow); !errors.Is(err, ErrWorktreeNotFound) {
			t.Fatalf("RemoveWorktree(%s) = %v, want ErrWorktreeNotFound", path, err)
		}
	}

	log := installArgLoggingGit(t)
	for _, path := range []string{outside, link, f.root + "/", f.root + "/../fix-login", "fix-login", ""} {
		refused(t, path)
	}
	if calls := loggedGitCalls(t, log); len(calls) != 0 {
		t.Fatalf("git ran for a path that is outside the allowed roots or not canonical: %v", calls)
	}

	// Inside the roots and canonical, but not a worktree root: found out by
	// asking git, with commands that change nothing.
	sub := filepath.Join(f.root, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	refused(t, sub)
	refused(t, filepath.Join(f.repo, ".git"))
	calls := loggedGitCalls(t, log)
	if len(calls) == 0 {
		t.Fatal("no git ran for a path inside the roots: the check below proves nothing")
	}
	for _, call := range calls {
		readOnly := len(call) >= 2 && (call[0] == "rev-parse" || (call[0] == "worktree" && call[1] == "list"))
		if !readOnly {
			t.Fatalf("a git command that is not a read-only lookup ran for a refused path: %v", call)
		}
	}
	f.intact()
}

// A daemon that has just restarted knows its terminal sessions only once it
// has read them back from tmux. A removal must not go by an empty table when
// that reading did not happen: it would take the directory from under
// sessions it never looked for.
func TestRemoveWorktreeAfterRestartNeedsTheSessionsFromTmux(t *testing.T) {
	requireTmux(t)
	setup := func(t *testing.T) (m2 *Manager, id, root, repo string) {
		t.Helper()
		repo = devflowRepo(t)
		store := NewMemoryProjectStore()
		m1 := NewManager(true, "sleep 30", false, "")
		m1.SetProjectStore(store)
		r, err := m1.Create(CreateOptions{Workdir: repo, Mode: protocol.SessionModeWorktree, WorktreeName: "fix-login", Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		id, root = r.ID, r.WorktreeRoot
		t.Cleanup(func() { m1.Delete(id) })
		// The restarted daemon: an empty table.
		m2 = NewManager(true, "sleep 30", false, "")
		m2.SetProjectStore(store)
		return m2, id, root, repo
	}
	failFirst := func(m *Manager, n int) {
		real := m.liveTmuxSessions
		m.liveTmuxSessions = func() (map[string]tmuxSessionInfo, bool) {
			if n > 0 {
				n--
				return nil, false
			}
			return real()
		}
	}
	untouched := func(t *testing.T, id, root, repo string) {
		t.Helper()
		if !pathExists(root) || branchOID(t, repo, "fix-login") == "" {
			t.Fatal("the directory or the branch was removed")
		}
		if tmuxCmd("has-session", "-t", "vibe-remote-"+id).Run() != nil {
			t.Fatal("the tmux session is gone")
		}
	}

	// The first reading fails (a transient tmux error): it is tried again, the
	// session is found, and the request that did not name it is refused.
	t.Run("first_query_fails", func(t *testing.T) {
		m2, id, root, repo := setup(t)
		failFirst(m2, 1)
		head := runGit(t, root, "rev-parse", "HEAD")
		_, err := m2.RemoveWorktree(protocol.WorktreeRemoveRequest{Path: root, Head: head, Sessions: []string{}}, allowAny)
		if changed := wantChanged(t, err); !reflect.DeepEqual(changed.Status.Sessions, []string{id}) {
			t.Fatalf("changed = %+v, want the running session %s listed", changed, id)
		}
		untouched(t, id, root, repo)
	})

	// It keeps failing: nothing is removed.
	t.Run("query_keeps_failing", func(t *testing.T) {
		m2, id, root, repo := setup(t)
		failFirst(m2, 1000)
		head := runGit(t, root, "rev-parse", "HEAD")
		_, err := m2.RemoveWorktree(protocol.WorktreeRemoveRequest{Path: root, Head: head, Sessions: []string{}}, allowAny)
		if failed := wantRemoveError(t, err); len(failed.EndedSessions) != 0 || !strings.Contains(failed.Message, "tmux") {
			t.Fatalf("failed = %+v, want a refusal that names tmux and ends nobody", failed)
		}
		untouched(t, id, root, repo)
	})
}

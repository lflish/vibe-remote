package session

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// Regression tests for the findings of the second review of the project and
// worktree change (docs/changes/2026-11-16-project-worktrees, review of
// e278f87..c74e715).

// freshTmuxDir points tmux at a socket directory of this test's own, where no
// server has ever run, and returns it. The directory is short on purpose: a
// socket path has to fit in about a hundred bytes, which t.TempDir() on macOS
// does not leave room for.
func freshTmuxDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "vr-tmux-")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMUX_TMPDIR", dir)
	// Registered after Setenv, so it runs while TMUX_TMPDIR still names dir:
	// only a server this test started on its own socket is stopped.
	t.Cleanup(func() {
		_ = tmuxCmd("kill-server").Run()
		_ = os.RemoveAll(dir)
	})
	return dir
}

// externalWorktree adds a worktree on a new branch with git itself, as a user
// would in a shell: no session of the daemon was ever involved.
func externalWorktree(t *testing.T, repo, branch string) string {
	t.Helper()
	runGit(t, repo, "worktree", "add", "-b", branch, filepath.Join(containerOf(repo), branch))
	return listedWorktreeOnBranch(t, repo, branch)
}

// onlyGitOnPath leaves git as the only program PATH finds: the machine has no
// tmux installed.
func onlyGitOnPath(t *testing.T) {
	t.Helper()
	real := realGit(t)
	dir := t.TempDir()
	writeFakeGit(t, dir, "#!/bin/sh\nexec '"+real+"' \"$@\"\n")
	t.Setenv("PATH", dir)
}

// The socket path the daemon works out is the one tmux really uses: a server
// started through tmuxCmd has its socket there.
func TestTmuxSocketPathIsWhereTmuxPutsIt(t *testing.T) {
	requireTmux(t)
	dir := freshTmuxDir(t)
	want := filepath.Join(dir, fmt.Sprintf("tmux-%d", os.Getuid()), tmuxSocket)
	if got := tmuxSocketPath(); got != want {
		t.Fatalf("tmuxSocketPath() = %s, want %s", got, want)
	}
	if pathExists(want) {
		t.Fatalf("%s exists before any server was started", want)
	}
	startTmuxSession(t, "vibe-remote-socketprobe", "sleep", "30")
	info, err := os.Stat(want)
	if err != nil {
		t.Fatalf("no socket at %s after a server was started: %v", want, err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("%s is not a socket: %v", want, info.Mode())
	}

	// Without TMUX_TMPDIR tmux falls back to /tmp. Only the string is checked
	// here: the default directory is not this test's to look into.
	t.Setenv("TMUX_TMPDIR", "")
	if got, want := tmuxSocketPath(), fmt.Sprintf("/tmp/tmux-%d/%s", os.Getuid(), tmuxSocket); got != want {
		t.Fatalf("tmuxSocketPath() without TMUX_TMPDIR = %s, want %s", got, want)
	}
}

// `tmux list-sessions` fails in more than one way, and only some of them say
// "nothing is running": a socket that does not exist (no server was ever
// started), and no tmux program at all. Anything in the way at the socket path
// that cannot be asked is a failed query.
func TestLiveTmuxSessionsTellsNothingRunningFromAFailedQuery(t *testing.T) {
	requireTmux(t)

	t.Run("no_socket_yet", func(t *testing.T) {
		freshTmuxDir(t)
		live, ok := liveTmuxSessions()
		if !ok || len(live) != 0 {
			t.Fatalf("liveTmuxSessions() = %v, %v; want an empty set that counts as read (no server was ever started)", live, ok)
		}
	})

	t.Run("no_tmux_program", func(t *testing.T) {
		freshTmuxDir(t)
		onlyGitOnPath(t)
		live, ok := liveTmuxSessions()
		if !ok || len(live) != 0 {
			t.Fatalf("liveTmuxSessions() = %v, %v; want an empty set that counts as read (there is no tmux)", live, ok)
		}
	})

	t.Run("socket_path_does_not_answer", func(t *testing.T) {
		dir := freshTmuxDir(t)
		sockDir := filepath.Join(dir, fmt.Sprintf("tmux-%d", os.Getuid()))
		if err := os.Mkdir(sockDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(sockDir, tmuxSocket), nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if live, ok := liveTmuxSessions(); ok {
			t.Fatalf("liveTmuxSessions() = %v, true; want a failed query: something is at the socket path and did not answer", live)
		}
	})

	t.Run("server_with_a_session", func(t *testing.T) {
		freshTmuxDir(t)
		startTmuxSession(t, "vibe-remote-live1", "sleep", "30")
		live, ok := liveTmuxSessions()
		if _, found := live["live1"]; !ok || !found {
			t.Fatalf("liveTmuxSessions() = %v, %v; want the running session", live, ok)
		}
	})
}

// A daemon with use_tmux on which no terminal session was ever opened (after a
// reboot that cleared /tmp, or one only used for chat sessions) has no tmux
// socket. That is "no terminal sessions", not "could not tell": a worktree
// nobody is in can be looked at and removed.
func TestRemoveWorktreeWhenTmuxHasNoSocketYet(t *testing.T) {
	requireTmux(t)
	freshTmuxDir(t)
	repo := devflowRepo(t)
	root := externalWorktree(t, repo, "feat")
	m := NewManager(true, "sleep 30", false, "")
	m.SetProjectStore(NewMemoryProjectStore())

	st, err := m.WorktreeStatus(root, allowAny)
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Sessions) != 0 {
		t.Fatalf("sessions = %v, want none", st.Sessions)
	}
	res, err := m.RemoveWorktree(request(st), allowAny)
	if err != nil {
		t.Fatalf("RemoveWorktree with no tmux socket: %v", err)
	}
	if !res.Removed || pathExists(root) {
		t.Fatalf("result = %+v, directory still there = %v; want the worktree removed", res, pathExists(root))
	}
	if pathExists(tmuxSocketPath()) {
		t.Fatal("removing a worktree started a tmux server")
	}
}

// use_tmux on a machine without tmux: no terminal session can exist there
// either, and a worktree can still be removed.
func TestRemoveWorktreeWhenTmuxIsNotInstalled(t *testing.T) {
	requireTmux(t) // for the socket directory; the daemon below finds no tmux
	freshTmuxDir(t)
	repo := devflowRepo(t)
	root := externalWorktree(t, repo, "feat")
	onlyGitOnPath(t)
	m := NewManager(true, "sleep 30", false, "")
	m.SetProjectStore(NewMemoryProjectStore())

	st, err := m.WorktreeStatus(root, allowAny)
	if err != nil {
		t.Fatal(err)
	}
	res, err := m.RemoveWorktree(request(st), allowAny)
	if err != nil {
		t.Fatalf("RemoveWorktree with no tmux installed: %v", err)
	}
	if !res.Removed || pathExists(root) {
		t.Fatalf("result = %+v, directory still there = %v; want the worktree removed", res, pathExists(root))
	}
}

// The other side of the same line: a server is there and does not answer.
// Which sessions are in the worktree is then not known, and nothing is
// removed.
func TestRemoveWorktreeRefusedWhenTmuxSocketDoesNotAnswer(t *testing.T) {
	requireTmux(t)
	dir := freshTmuxDir(t)
	repo := devflowRepo(t)
	root := externalWorktree(t, repo, "feat")
	m := NewManager(true, "sleep 30", false, "")
	m.SetProjectStore(NewMemoryProjectStore())
	st, err := m.WorktreeStatus(root, allowAny)
	if err != nil {
		t.Fatal(err)
	}
	sockDir := filepath.Join(dir, fmt.Sprintf("tmux-%d", os.Getuid()))
	if err := os.MkdirAll(sockDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sockDir, tmuxSocket), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = m.RemoveWorktree(request(st), allowAny)
	if failed := wantRemoveError(t, err); len(failed.EndedSessions) != 0 {
		t.Fatalf("failed = %+v, want a refusal that ends nobody", failed)
	}
	if !pathExists(root) || branchOID(t, repo, "feat") == "" {
		t.Fatal("the directory or the branch was removed without the sessions being known")
	}
}

// gitWithoutConfigEnvironment makes the git on PATH behave like git before
// 2.31 in the one way that matters here: it does not read configuration from
// GIT_CONFIG_COUNT / GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> (Debian 11 ships
// 2.30, Ubuntu 20.04 ships 2.25).
func gitWithoutConfigEnvironment(t *testing.T) {
	t.Helper()
	installGitWrapper(t, `for v in $(env | sed -n 's/^\(GIT_CONFIG_COUNT\)=.*/\1/p; s/^\(GIT_CONFIG_KEY_[0-9]*\)=.*/\1/p; s/^\(GIT_CONFIG_VALUE_[0-9]*\)=.*/\1/p'); do unset "$v"; done`)
}

// core.fsmonitor is turned off in a way every git understands: on the command
// line (-c), which git has always had and hands on to the git processes it
// starts itself. The environment form (GIT_CONFIG_COUNT) is ignored by git
// before 2.31, where looking at a worktree then ran the repository's program.
func TestFsmonitorStaysOffOnGitWithoutConfigEnvironment(t *testing.T) {
	f := newRemoveFixture(t, 0)
	writeFiles(t, f.root, "untracked.txt", "node_modules/x.js")
	ran, _ := fsmonitorProbe(t, f.repo, f.root)
	gitWithoutConfigEnvironment(t)
	step := func(name string) {
		t.Helper()
		if ran() {
			t.Fatalf("%s ran the repository's core.fsmonitor program", name)
		}
	}

	st := f.status()
	if st.DirtyFiles != 1 || st.IgnoredFiles != 1 {
		t.Fatalf("status = %+v, want 1 dirty and 1 ignored", st)
	}
	step("WorktreeStatus")
	if plan, err := f.m.PlanWorktree(f.root, "another", nil); err != nil || !plan.OK {
		t.Fatalf("plan = %+v, %v", plan, err)
	}
	step("PlanWorktree")
	req := request(st)
	req.DiscardFiles, req.DeleteBranch = true, true
	f.mustRemove(req)
	step("RemoveWorktree") // git worktree remove runs a status of its own
	created, err := CreateWorktree(WorktreeSpec{Source: f.repo, SessionID: "s1", Name: "again"})
	if err != nil {
		t.Fatal(err)
	}
	step("CreateWorktree")
	if err := created.Undo(); err != nil {
		t.Fatal(err)
	}
	step("Undo")
}

// Every git command line of the daemon starts with the setting, before -C and
// the subcommand.
func TestEveryGitCallTurnsFsmonitorOff(t *testing.T) {
	f := newRemoveFixture(t, 0)
	log := installArgLoggingGit(t)
	st := f.status()
	if _, err := f.m.PlanWorktree(f.repo, "another", nil); err != nil {
		t.Fatal(err)
	}
	f.m.Projects(allowAny)
	ChatTrust(f.root)
	req := request(st)
	req.DeleteBranch = true
	f.mustRemove(req)
	created, err := CreateWorktree(WorktreeSpec{Source: f.repo, SessionID: "s1", Name: "again"})
	if err != nil {
		t.Fatal(err)
	}
	if err := created.Undo(); err != nil {
		t.Fatal(err)
	}

	raw := rawGitCalls(t, log)
	if len(raw) < 10 {
		t.Fatalf("only %d git calls were recorded: the check below proves little", len(raw))
	}
	for _, call := range raw {
		if len(call) < 4 || call[0] != "-c" || call[1] != "core.fsmonitor=false" || call[2] != "-C" {
			t.Fatalf("git was run as %q, want it to start with -c core.fsmonitor=false -C <dir>", call)
		}
	}
}

// readBackFailures makes git fail the worktree list calls that follow a
// create's symbolic-ref — the read-back and whatever the undo reads — `fails`
// times; with removeFails, `git worktree remove` fails as well. It returns the
// func that takes the wrapper off PATH again, for the test's own look at the
// repository.
func readBackFailures(t *testing.T, fails int, removeFails bool) (restore func()) {
	t.Helper()
	dir := t.TempDir()
	flag, count := filepath.Join(dir, "after-symbolic-ref"), filepath.Join(dir, "count")
	body := `if [ "$GIT_SUB" = symbolic-ref ]; then : > '` + flag + `'; fi
if [ -e '` + flag + `' ] && [ "$GIT_SUB $GIT_SUB2" = "worktree list" ]; then
  n=$(cat '` + count + `' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '` + count + `'
  if [ $n -le ` + fmt.Sprint(fails) + ` ]; then echo "fatal: simulated" >&2; exit 128; fi
fi`
	if removeFails {
		body += `
if [ "$GIT_SUB $GIT_SUB2" = "worktree remove" ]; then echo "fatal: simulated" >&2; exit 128; fi`
	}
	orig := os.Getenv("PATH")
	installGitWrapper(t, body)
	return func() { t.Setenv("PATH", orig) }
}

// Reading the new worktree back from git's list is one more thing that can
// fail after the worktree itself was created. One failed reading is tried
// again; and an undo that could not make sure the worktree is gone leaves its
// branch alone, because a worktree whose branch was deleted under it reads as
// "no commits yet" and the next commit in it would start a new history.
func TestCreateWorktreeReadBackFails(t *testing.T) {
	t.Run("once", func(t *testing.T) {
		repo := devflowRepo(t)
		restore := readBackFailures(t, 1, false)
		created, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "feat"})
		restore()
		if err != nil {
			t.Fatalf("CreateWorktree = %v, want the read-back tried again", err)
		}
		if listed := listedWorktreeOnBranch(t, repo, "feat"); listed != created.Meta.WorktreeRoot || created.Meta.Branch != "feat" {
			t.Fatalf("created %+v, git lists feat at %q", created.Meta, listed)
		}
	})

	// left checks what a failed create left behind when its undo could not
	// confirm the worktree removed: the worktree as it was created, on its
	// branch, and an error that says both are still there.
	left := func(t *testing.T, repo string, err error) {
		t.Helper()
		oid := runGit(t, repo, "rev-parse", "HEAD")
		root := listedWorktreeOnBranch(t, repo, "feat")
		if root == "" || !pathExists(root) {
			t.Fatalf("git lists no worktree on feat (create error: %v)", err)
		}
		if got := branchOID(t, repo, "feat"); got != oid {
			t.Fatalf("branch feat is at %q, want it kept at %s: its worktree is still there (create error: %v)", got, oid, err)
		}
		if got := runGit(t, root, "rev-parse", "HEAD"); got != oid {
			t.Fatalf("HEAD in the worktree that was left = %q, want %s", got, oid)
		}
		for _, want := range []string{root, "branch feat kept"} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("error %q does not say %q", err, want)
			}
		}
	}

	t.Run("list_keeps_failing", func(t *testing.T) {
		repo := devflowRepo(t)
		restore := readBackFailures(t, 1000, false)
		_, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "feat"})
		restore()
		if err == nil {
			t.Fatal("CreateWorktree succeeded without ever reading the worktree back")
		}
		left(t, repo, err)
	})

	t.Run("worktree_remove_fails_in_undo", func(t *testing.T) {
		repo := devflowRepo(t)
		restore := readBackFailures(t, 2, true) // the read-back and its retry
		_, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "feat"})
		restore()
		if err == nil {
			t.Fatal("CreateWorktree succeeded without reading the worktree back")
		}
		left(t, repo, err)
	})
}

// `git worktree add` that runs into its time limit is killed in the middle of
// the checkout. git has by then registered the worktree and locked it itself
// (reason "initializing"), which it only undoes when it finishes. All of that
// is this create's own, and its undo takes it back: nothing is left listed,
// locked or on disk, and the same name can be used again.
func TestWorktreeAddKilledDuringCheckoutIsUndone(t *testing.T) {
	f := newRemoveFixture(t, 0)
	// A smudge filter that does not return while the flag file is there: the
	// checkout of the new worktree stops at the first *.txt file.
	dir := t.TempDir()
	flag, smudge := filepath.Join(dir, "hang"), filepath.Join(dir, "smudge.sh")
	if err := os.WriteFile(smudge, []byte("#!/bin/sh\nif [ -e '"+flag+"' ]; then sleep 120; fi\nexec cat\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, f.repo, "config", "filter.slow.smudge", smudge)
	runGit(t, f.repo, "config", "filter.slow.clean", "cat")
	writeFiles(t, f.repo, ".gitattributes", "a.txt", "b.txt")
	if err := os.WriteFile(filepath.Join(f.repo, ".gitattributes"), []byte("*.txt filter=slow\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, f.repo, "add", ".gitattributes", "a.txt", "b.txt")
	runGit(t, f.repo, "commit", "-m", "filtered files")

	if err := os.WriteFile(flag, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	shortGitLimit(t, &gitTreeTimeout, 3*time.Second)
	_, err := f.m.Create(CreateOptions{Workdir: f.repo, Mode: protocol.SessionModeWorktree, WorktreeName: "slow", Cols: 80, Rows: 24})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("create = %v, want the timed-out git worktree add reported as a failure", err)
	}
	if strings.Contains(err.Error(), "cleanup:") || strings.Contains(err.Error(), "rollback") {
		t.Errorf("the undo left something behind: %v", err)
	}
	root := filepath.Join(containerOf(f.repo), "slow")
	if list := runGit(t, f.repo, "worktree", "list", "--porcelain"); strings.Contains(list, root) {
		t.Errorf("git still lists the worktree:\n%s", list)
	}
	if pathExists(root) {
		t.Errorf("%s is still there: %v", root, dirNames(t, root))
	}
	if admin := filepath.Join(f.repo, ".git", "worktrees", "slow"); pathExists(admin) {
		t.Errorf("%s is still there: %v", admin, dirNames(t, admin))
	}
	if branchOID(t, f.repo, "slow") != "" {
		t.Error("branch slow is left")
	}
	if f.store.Managed(f.repo, root, "slow") {
		t.Error("a creation record is left")
	}
	if t.Failed() {
		return
	}

	// The checkout works again: the same name is free.
	if err := os.Remove(flag); err != nil {
		t.Fatal(err)
	}
	r, err := f.m.Create(CreateOptions{Workdir: f.repo, Mode: protocol.SessionModeWorktree, WorktreeName: "slow", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("create with the same name after the undone one: %v", err)
	}
	t.Cleanup(func() { r.Kill() })
	if data, _ := os.ReadFile(filepath.Join(r.WorktreeRoot, "b.txt")); string(data) != "b.txt\n" {
		t.Fatalf("b.txt in the new worktree = %q", data)
	}
	f.intact()
}

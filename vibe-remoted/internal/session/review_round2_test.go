package session

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
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

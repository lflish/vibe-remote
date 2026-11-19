package session

import (
	"os"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Regression tests for the findings of the first round of gate C of the
// project and worktree change (docs/changes/2026-11-16-project-worktrees,
// X9–X15, verified at 91e0fab). Each one is a counter-example the verifier
// ran against that commit.

// restoreOwnTmuxSocket makes the tmux server of this test create its socket
// file again. pid and sock are the test's own: the pid was read from the
// server on the socket in the directory the test made (ownTmuxServerPID), and
// sock is checked to lie in that directory (ownTmuxSocket).
func restoreOwnTmuxSocket(t *testing.T, pid int, sock string) {
	t.Helper()
	if pathExists(sock) {
		return
	}
	if err := syscall.Kill(pid, syscall.SIGUSR1); err != nil {
		t.Fatalf("SIGUSR1 to the tmux server %d: %v", pid, err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !pathExists(sock) {
		if time.Now().After(deadline) {
			t.Fatalf("the tmux server did not create %s again after SIGUSR1", sock)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func tmuxSessionAlive(id string) bool {
	return tmuxCmd("has-session", "-t", "vibe-remote-"+id).Run() == nil
}

// X10. The socket file goes away after the removal has read tmux and before it
// ends the sessions: kill-session then fails. The session was not ended, so
// the directory stays and the session is not reported as ended.
func TestRemoveWorktreeStopsWhenASessionDidNotEnd(t *testing.T) {
	requireTmux(t)
	dir := freshTmuxDir(t)
	repo := devflowRepo(t)
	root := externalWorktree(t, repo, "feat")
	m := NewManager(true, "sleep 120", false, "")
	m.SetProjectStore(NewMemoryProjectStore())
	id := terminalSessionIn(t, m, root)
	st, err := m.WorktreeStatus(root, allowAny)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(st.Sessions, []string{id}) {
		t.Fatalf("sessions = %v, want [%s]", st.Sessions, id)
	}
	pid := ownTmuxServerPID(t)
	sock := ownTmuxSocket(t, dir)
	// Registered after freshTmuxDir's cleanup, so it runs before it: the server
	// can be reached again when that one stops it.
	t.Cleanup(func() { restoreOwnTmuxSocket(t, pid, sock) })
	m.testAfterRemovingMarked = func() {
		if err := os.Remove(sock); err != nil {
			t.Fatal(err)
		}
	}

	res, err := m.RemoveWorktree(request(st), allowAny)
	failed := wantRemoveError(t, err)
	if res.Removed || len(failed.EndedSessions) != 0 {
		t.Fatalf("result = %+v, failed = %+v; want nothing removed and no session reported as ended", res, failed)
	}
	if !strings.Contains(failed.Message, id) {
		t.Fatalf("message = %q, want it to name the session %s", failed.Message, id)
	}
	for _, word := range []string{"socket", "SIGUSR1"} {
		if !strings.Contains(failed.Message, word) {
			t.Fatalf("message = %q, want it to say %q", failed.Message, word)
		}
	}
	if !pathExists(root) || branchOID(t, repo, "feat") == "" {
		t.Fatal("the directory or the branch was removed although the session in it was not ended")
	}
	if _, ok := m.Get(id); !ok {
		t.Fatal("the session that could not be ended was dropped from the table")
	}

	restoreOwnTmuxSocket(t, pid, sock)
	if !tmuxSessionAlive(id) {
		t.Fatal("the tmux session is gone; the test did not reproduce a failed kill-session")
	}
	// With the socket back the same request goes through, and now the session
	// really is ended.
	m.testAfterRemovingMarked = nil
	res, err = m.RemoveWorktree(request(st), allowAny)
	if err != nil {
		t.Fatalf("RemoveWorktree after the socket came back: %v", err)
	}
	if !res.Removed || !reflect.DeepEqual(res.EndedSessions, []string{id}) || pathExists(root) {
		t.Fatalf("result = %+v, directory still there = %v; want the worktree removed and the session %s ended", res, pathExists(root), id)
	}
	if tmuxSessionAlive(id) {
		t.Fatal("the tmux session is still running after its worktree was removed")
	}
}

// X10. A session counts as ended only once tmux has been read again and no
// longer has it: a reading that fails, or one that still lists the session,
// stops the removal.
func TestRemoveWorktreeConfirmsSessionsAgainstTmux(t *testing.T) {
	requireTmux(t)
	setup := func(t *testing.T) (m *Manager, ids []string, root, repo string) {
		t.Helper()
		freshTmuxDir(t)
		repo = devflowRepo(t)
		root = externalWorktree(t, repo, "feat")
		m = NewManager(true, "sleep 120", false, "")
		m.SetProjectStore(NewMemoryProjectStore())
		ids = []string{terminalSessionIn(t, m, root)}
		time.Sleep(5 * time.Millisecond) // a later creation time: the order they are ended in
		ids = append(ids, terminalSessionIn(t, m, root))
		return m, ids, root, repo
	}

	// The reading after the first kill fails: the first session is not
	// confirmed, the second is never touched.
	t.Run("reading_fails_after_the_kill", func(t *testing.T) {
		m, ids, root, repo := setup(t)
		st, err := m.WorktreeStatus(root, allowAny)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(st.Sessions, ids) {
			t.Fatalf("sessions = %v, want %v", st.Sessions, ids)
		}
		real := m.liveTmuxSessions
		broken := false
		m.liveTmuxSessions = func() (map[string]tmuxSessionInfo, bool) {
			if broken {
				return nil, false
			}
			return real()
		}
		m.testAfterRemovingMarked = func() { broken = true }
		_, err = m.RemoveWorktree(request(st), allowAny)
		failed := wantRemoveError(t, err)
		if len(failed.EndedSessions) != 0 || !strings.Contains(failed.Message, ids[0]) {
			t.Fatalf("failed = %+v, want no session reported as ended and %s named", failed, ids[0])
		}
		if !pathExists(root) || branchOID(t, repo, "feat") == "" {
			t.Fatal("the directory or the branch was removed although no session was confirmed ended")
		}
		if !tmuxSessionAlive(ids[1]) {
			t.Fatalf("session %s was ended after the removal had already failed", ids[1])
		}
		if _, ok := m.Get(ids[0]); !ok {
			t.Fatalf("session %s was dropped from the table without being confirmed ended", ids[0])
		}
	})

	// tmux still lists the session after the kill (a stale answer here; a
	// kill-session that did nothing in real life).
	t.Run("session_still_listed", func(t *testing.T) {
		m, ids, root, repo := setup(t)
		st, err := m.WorktreeStatus(root, allowAny)
		if err != nil {
			t.Fatal(err)
		}
		real := m.liveTmuxSessions
		var stale map[string]tmuxSessionInfo
		m.liveTmuxSessions = func() (map[string]tmuxSessionInfo, bool) {
			if stale != nil {
				return stale, true
			}
			return real()
		}
		m.testAfterRemovingMarked = func() {
			live, ok := real()
			if !ok {
				t.Fatal("tmux could not be read")
			}
			stale = live
		}
		_, err = m.RemoveWorktree(request(st), allowAny)
		failed := wantRemoveError(t, err)
		if len(failed.EndedSessions) != 0 || !strings.Contains(failed.Message, ids[0]) || !strings.Contains(failed.Message, "still") {
			t.Fatalf("failed = %+v, want no session reported as ended and %s named as still running", failed, ids[0])
		}
		if !pathExists(root) || branchOID(t, repo, "feat") == "" {
			t.Fatal("the directory or the branch was removed although tmux still listed the session")
		}
		if _, ok := m.Get(ids[0]); !ok {
			t.Fatalf("session %s was dropped from the table while tmux still listed it", ids[0])
		}
	})
}

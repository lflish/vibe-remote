package session

import (
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Regression tests for the findings of the third review of the project and
// worktree change (docs/changes/2026-11-16-project-worktrees, review of
// c74e715..3b01cf3): when it is not certain that no tmux session exists, the
// reading of tmux counts as failed.

// ownTmuxSocket returns the socket path of the tmux server of this test, and
// fails the test unless that path lies in dir, the socket directory the test
// made for itself: the file is about to be removed, and no other socket may
// ever be.
func ownTmuxSocket(t *testing.T, dir string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	sock := tmuxSocketPath()
	if !strings.HasPrefix(sock, dir+string(os.PathSeparator)) && !strings.HasPrefix(sock, resolved+string(os.PathSeparator)) {
		t.Fatalf("the socket path %s is not in this test's own directory %s", sock, dir)
	}
	return sock
}

// ownTmuxServerPID asks the tmux server on this test's own socket for its
// process id. It is read while the socket is still there.
func ownTmuxServerPID(t *testing.T) int {
	t.Helper()
	out, err := tmuxCmd("display-message", "-p", "#{pid}").Output()
	if err != nil {
		t.Fatalf("tmux display-message: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || pid <= 1 {
		t.Fatalf("tmux server pid = %q", out)
	}
	return pid
}

// terminalSessionIn starts a terminal session of m in dir and ends it when the
// test is over.
func terminalSessionIn(t *testing.T, m *Manager, dir string) string {
	t.Helper()
	r, err := m.Create(CreateOptions{Workdir: dir, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Kill() })
	return r.ID
}

// A tmux server keeps running when its socket file is deleted (someone cleared
// /tmp); tmux then answers "error connecting … (No such file or directory)",
// the same as when no server was ever started. A daemon that remembers
// terminal sessions does not take that for "no sessions": the table is kept,
// and a worktree is not removed from under the sessions in it. SIGUSR1 makes
// the server create its socket again, and everything works as before.
func TestSocketFileGoneWhileTheTmuxServerRuns(t *testing.T) {
	requireTmux(t)
	dir := freshTmuxDir(t)
	repo := devflowRepo(t)
	root := externalWorktree(t, repo, "feat")
	m := NewManager(true, "sleep 30", false, "")
	m.SetProjectStore(NewMemoryProjectStore())
	id := terminalSessionIn(t, m, root)
	const conversation = "11111111-2222-4333-8444-555555555555"
	if err := m.claimClaude(conversation, id); err != nil {
		t.Fatal(err)
	}
	st, err := m.WorktreeStatus(root, allowAny)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(st.Sessions, []string{id}) {
		t.Fatalf("sessions = %v, want [%s]", st.Sessions, id)
	}

	pid := ownTmuxServerPID(t)
	sock := ownTmuxSocket(t, dir)
	if err := os.Remove(sock); err != nil {
		t.Fatal(err)
	}

	if live, ok := m.liveTmuxSessions(); ok {
		t.Fatalf("liveTmuxSessions() = %v, true; want a failed reading: the socket file is gone and the daemon remembers a terminal session", live)
	}
	if list := m.List(); len(list) != 1 || list[0].ID != id {
		t.Fatalf("List() = %+v, want the session %s kept", list, id)
	}
	if _, ok := m.Get(id); !ok {
		t.Fatal("the session was dropped from the table")
	}
	m.mu.RLock()
	owner := m.claudeOwners[conversation]
	m.mu.RUnlock()
	if owner != id {
		t.Fatalf("the claude conversation is held by %q, want it still held by the session %s", owner, id)
	}
	if again, err := m.WorktreeStatus(root, allowAny); err != nil || !reflect.DeepEqual(again.Sessions, []string{id}) {
		t.Fatalf("status = %+v, %v; want the session %s still counted", again, err, id)
	}

	_, err = m.RemoveWorktree(request(st), allowAny)
	failed := wantRemoveError(t, err)
	if len(failed.EndedSessions) != 0 {
		t.Fatalf("failed = %+v, want a refusal that ends nobody", failed)
	}
	for _, word := range []string{"socket", "SIGUSR1", "restart"} {
		if !strings.Contains(failed.Message, word) {
			t.Fatalf("message = %q, want it to say %q", failed.Message, word)
		}
	}
	if !pathExists(root) || branchOID(t, repo, "feat") == "" {
		t.Fatal("the directory or the branch was removed while the sessions in it could not be read")
	}

	// The server is this test's own: started above, on the socket in dir.
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
	if live, ok := m.liveTmuxSessions(); !ok || len(live) != 1 {
		t.Fatalf("liveTmuxSessions() = %v, %v after the socket came back; want the session", live, ok)
	}
	if tmuxCmd("has-session", "-t", "vibe-remote-"+id).Run() != nil {
		t.Fatal("the tmux session did not survive")
	}
	res, err := m.RemoveWorktree(request(st), allowAny)
	if err != nil {
		t.Fatalf("RemoveWorktree after the socket came back: %v", err)
	}
	if !res.Removed || !reflect.DeepEqual(res.EndedSessions, []string{id}) || pathExists(root) {
		t.Fatalf("result = %+v, directory still there = %v; want the worktree removed and the session %s ended", res, pathExists(root), id)
	}
	if tmuxCmd("has-session", "-t", "vibe-remote-"+id).Run() == nil {
		t.Fatal("the tmux session is still running after its worktree was removed")
	}
}

// The same line without a server at all: a table that still has a terminal
// session is reason enough not to read a missing socket as "no sessions".
func TestMissingSocketIsNotAnEmptySetWhileTheTableHasTerminalSessions(t *testing.T) {
	requireTmux(t)
	freshTmuxDir(t)
	m := NewManager(true, "sleep 30", false, "")
	if live, ok := m.liveTmuxSessions(); !ok || len(live) != 0 {
		t.Fatalf("liveTmuxSessions() = %v, %v with an empty table and no socket; want an empty set that counts as read", live, ok)
	}
	m.mu.Lock()
	m.sessions["remembered"] = &Runner{ID: "remembered", Workdir: t.TempDir(), useTmux: true}
	m.mu.Unlock()
	if live, ok := m.liveTmuxSessions(); ok {
		t.Fatalf("liveTmuxSessions() = %v, true; want a failed reading while the table has a terminal session", live)
	}
	if list := m.List(); len(list) != 1 || list[0].ID != "remembered" {
		t.Fatalf("List() = %+v, want the remembered session kept", list)
	}
}

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

// weirdDirNames are directory names with the characters a fixed separator in
// tmux's answer could be made of.
var weirdDirNames = map[string]string{
	"newline":         "line\nwrap",
	"tab":             "tab\twrap",
	"trailing_tab":    "tab\t",
	"tab_then_slash":  "a\t",
	"newline_and_tab": "x\n\ty",
}

// X11. A session whose process is in a directory with a newline or a tab in
// its name (the terminal ran cd) is still read from tmux, with every field
// where it belongs: it is counted in the worktree it was created in — by this
// daemon and by one that has restarted — and a removal ends it.
func TestSessionWhoseProcessIsInAnOddlyNamedDirectoryIsStillRead(t *testing.T) {
	requireTmux(t)
	for label, name := range weirdDirNames {
		for _, restarted := range []bool{false, true} {
			sub := label + "/same_daemon"
			if restarted {
				sub = label + "/restarted_daemon"
			}
			t.Run(sub, func(t *testing.T) {
				freshTmuxDir(t)
				repo := devflowRepo(t)
				root := externalWorktree(t, repo, "feat")
				store := NewMemoryProjectStore()
				m := NewManager(true, "sleep 120", false, "")
				m.SetProjectStore(store)
				id := terminalSessionIn(t, m, root)
				weird := filepath.Join(t.TempDir(), name)
				if label == "tab_then_slash" {
					// The part after the tab starts with a slash: it looks like a
					// path of its own.
					weird = filepath.Join(weird, "b")
				}
				if err := os.MkdirAll(weird, 0o700); err != nil {
					t.Fatal(err)
				}
				weird, err := filepath.EvalSymlinks(weird)
				if err != nil {
					t.Fatal(err)
				}
				// As if the process in the terminal had changed directory.
				if out, err := tmuxCmd("respawn-pane", "-k", "-t", "vibe-remote-"+id+":0.0", "-c", weird, "sleep", "120").CombinedOutput(); err != nil {
					t.Fatalf("respawn-pane: %v: %s", err, out)
				}
				deadline := time.Now().Add(5 * time.Second)
				for {
					out, _ := tmuxCmd("display-message", "-p", "-t", "vibe-remote-"+id, "#{pane_current_path}").Output()
					if strings.TrimSuffix(string(out), "\n") == weird {
						break
					}
					if time.Now().After(deadline) {
						t.Fatalf("the pane did not move to %q (tmux says %q)", weird, out)
					}
					time.Sleep(20 * time.Millisecond)
				}
				if restarted {
					m = NewManager(true, "sleep 120", false, "")
					m.SetProjectStore(store)
				}

				live, ok := m.liveTmuxSessions()
				if !ok || len(live) != 1 {
					t.Fatalf("liveTmuxSessions() = %v, %v; want the one session, read", live, ok)
				}
				if got := live[id]; got.workdir != weird || got.startDir != root || got.home != root || got.project != repo {
					t.Fatalf("session read as %+v; want workdir %q, start directory and home %q, project %q", got, weird, root, repo)
				}
				st, err := m.WorktreeStatus(root, allowAny)
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(st.Sessions, []string{id}) {
					t.Fatalf("status.sessions = %v, want [%s]: the session was created in this worktree", st.Sessions, id)
				}
				// A request that does not name the session is refused, and nothing
				// is touched.
				unaware := request(st)
				unaware.Sessions = []string{}
				_, err = m.RemoveWorktree(unaware, allowAny)
				if changed := wantChanged(t, err); !reflect.DeepEqual(changed.Status.Sessions, []string{id}) || len(changed.EndedSessions) != 0 {
					t.Fatalf("changed = %+v, want the session %s listed and nobody ended", changed, id)
				}
				if !pathExists(root) || !tmuxSessionAlive(id) {
					t.Fatal("the directory or the session is gone after a refused removal")
				}
				res, err := m.RemoveWorktree(request(st), allowAny)
				if err != nil {
					t.Fatalf("RemoveWorktree: %v", err)
				}
				if !res.Removed || !reflect.DeepEqual(res.EndedSessions, []string{id}) || pathExists(root) || tmuxSessionAlive(id) {
					t.Fatalf("result = %+v, directory there = %v, session alive = %v; want the worktree removed and its session ended",
						res, pathExists(root), tmuxSessionAlive(id))
				}
			})
		}
	}
}

// X11. The same for a session created in such a directory: its start
// directory, its attribution and — in a worktree whose own path has the
// character — the worktree root all carry it.
func TestSessionCreatedInAnOddlyNamedDirectoryIsStillRead(t *testing.T) {
	requireTmux(t)
	// A newline in a worktree's own path is X14's (the worktree list); see
	// TestListWorktreesPathWithNewline.
	for _, label := range []string{"tab"} {
		name := weirdDirNames[label]
		t.Run(label, func(t *testing.T) {
			freshTmuxDir(t)
			repo := devflowRepo(t)
			runGit(t, repo, "worktree", "add", "-b", "feat", filepath.Join(containerOf(repo), name))
			root := listedWorktreeOnBranch(t, repo, "feat")
			if !strings.Contains(root, "\t") {
				t.Fatalf("worktree root %q has no tab in it", root)
			}
			store := NewMemoryProjectStore()
			m1 := NewManager(true, "sleep 120", false, "")
			m1.SetProjectStore(store)
			inRoot := terminalSessionIn(t, m1, root)
			time.Sleep(5 * time.Millisecond)
			elsewhere := terminalSessionIn(t, m1, repo)

			// A daemon that has restarted knows the sessions from tmux alone.
			m2 := NewManager(true, "sleep 120", false, "")
			m2.SetProjectStore(store)
			live, ok := m2.liveTmuxSessions()
			if !ok || len(live) != 2 {
				t.Fatalf("liveTmuxSessions() = %v, %v; want both sessions, read", live, ok)
			}
			if got := live[inRoot]; got.startDir != root || got.home != root || got.project != repo || got.workdir != root {
				t.Fatalf("session in the worktree read as %+v; want start directory, home and workdir %q, project %q", got, root, repo)
			}
			if got := live[elsewhere]; got.startDir != repo || got.home != repo {
				t.Fatalf("session in the main directory read as %+v; want start directory and home %q", got, repo)
			}
			st, err := m2.WorktreeStatus(root, allowAny)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(st.Sessions, []string{inRoot}) {
				t.Fatalf("status.sessions = %v, want [%s]", st.Sessions, inRoot)
			}
			res, err := m2.RemoveWorktree(request(st), allowAny)
			if err != nil {
				t.Fatalf("RemoveWorktree: %v", err)
			}
			if !res.Removed || !reflect.DeepEqual(res.EndedSessions, []string{inRoot}) || pathExists(root) || tmuxSessionAlive(inRoot) {
				t.Fatalf("result = %+v; want the worktree removed and its session ended", res)
			}
			if !tmuxSessionAlive(elsewhere) {
				t.Fatal("the session in the main directory was ended too")
			}
		})
	}
}

// X11. An answer of tmux with something in it that cannot be read is not the
// set of the sessions that could be: the reading failed, the session table is
// kept as it is, and no worktree is removed on the strength of it.
func TestTmuxReadFailsWhenARecordDoesNotParse(t *testing.T) {
	real := requireTmux(t)
	freshTmuxDir(t)
	// A tmux that answers list-sessions with one more line than was asked for,
	// while the file garble exists; everything else is the real tmux.
	bin := t.TempDir()
	garble := filepath.Join(bin, "garble")
	script := "#!/bin/sh\nfor a in \"$@\"; do\n  if [ \"$a\" = list-sessions ] && [ -e '" + garble + "' ]; then\n" +
		"    '" + real + "' \"$@\" || exit $?\n    printf 'vibe-remote-ghost\\t/somewhere\\n'\n    exit 0\n  fi\ndone\nexec '" + real + "' \"$@\"\n"
	if err := os.WriteFile(filepath.Join(bin, "tmux"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

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

	if err := os.WriteFile(garble, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if live, ok := m.liveTmuxSessions(); ok {
		t.Fatalf("liveTmuxSessions() = %v, true; want a failed reading: part of the answer could not be read", live)
	}
	if why := m.tmuxFailure(); !strings.Contains(why, "could not be read as a list of sessions") {
		t.Fatalf("tmuxFailure() = %q, want it to say that the answer could not be read", why)
	}
	if list := m.List(); len(list) != 1 || list[0].ID != id {
		t.Fatalf("List() = %+v, want the session %s kept", list, id)
	}
	// The same for a daemon that has restarted: it does not take the readable
	// part of the answer for the sessions there are.
	restarted := NewManager(true, "sleep 120", false, "")
	restarted.SetProjectStore(NewMemoryProjectStore())
	for name, mgr := range map[string]*Manager{"same daemon": m, "restarted daemon": restarted} {
		req := request(st)
		_, err = mgr.RemoveWorktree(req, allowAny)
		failed := wantRemoveError(t, err)
		if len(failed.EndedSessions) != 0 || !strings.Contains(failed.Message, "could not be read as a list of sessions") || !strings.Contains(failed.Message, "nothing was removed") {
			t.Fatalf("%s: failed = %+v, want a refusal that says tmux's answer could not be read and ends nobody", name, failed)
		}
		if !pathExists(root) || branchOID(t, repo, "feat") == "" || !tmuxSessionAlive(id) {
			t.Fatalf("%s: the directory, the branch or the session is gone after a refused removal", name)
		}
	}

	if err := os.Remove(garble); err != nil {
		t.Fatal(err)
	}
	res, err := restarted.RemoveWorktree(request(st), allowAny)
	if err != nil {
		t.Fatalf("RemoveWorktree once tmux answers properly: %v", err)
	}
	if !res.Removed || !reflect.DeepEqual(res.EndedSessions, []string{id}) || tmuxSessionAlive(id) {
		t.Fatalf("result = %+v; want the worktree removed and the session %s ended", res, id)
	}
}

// noWorktreeRemove fails the test if git was asked to remove a worktree.
func noWorktreeRemove(t *testing.T, log string) {
	t.Helper()
	for _, c := range loggedGitCalls(t, log) {
		if len(c) >= 2 && c[0] == "worktree" && c[1] == "remove" {
			t.Fatalf("git %v ran against a worktree that is not this create's", c)
		}
	}
}

// X9. Between this create claiming the directory and the branch and its own
// `git worktree add`, another process adds a worktree of its own at the same
// path — on the very branch this create has just made, or detached at the very
// commit. This create's add then fails, and its undo leaves that worktree
// alone: their files, their registration, and the branch they are on.
func TestUndoLeavesAWorktreeSomeoneElseAddedAtTheSamePath(t *testing.T) {
	type check struct {
		theirs     []string // git worktree add …, the path appended
		theirHead  string   // what HEAD is in their worktree afterwards ("" = detached)
		branchKept bool     // this create's branch is in use by them, so it stays
	}
	for name, c := range map[string]check{
		"same_branch":                 {theirs: []string{"worktree", "add"}, theirHead: "refs/heads/fix-login", branchKept: true},
		"detached_at_the_same_commit": {theirs: []string{"worktree", "add", "--detach"}},
	} {
		t.Run(name, func(t *testing.T) {
			repo := devflowRepo(t)
			oid := runGit(t, repo, "rev-parse", "HEAD")
			root := filepath.Join(containerOf(repo), "fix-login")
			log := installArgLoggingGit(t)
			testBeforeWorktreeAdd = func() {
				args := append(append([]string{}, c.theirs...), root)
				if c.theirHead != "" {
					args = append(args, "fix-login")
				} else {
					args = append(args, "HEAD")
				}
				runGit(t, repo, args...)
				if err := os.WriteFile(filepath.Join(root, "precious.txt"), []byte("someone else's work"), 0o600); err != nil {
					t.Error(err)
				}
			}
			t.Cleanup(func() { testBeforeWorktreeAdd = nil })

			_, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "fix-login"})
			if err == nil {
				t.Fatal("the create succeeded although the directory had been taken")
			}
			if data, rerr := os.ReadFile(filepath.Join(root, "precious.txt")); rerr != nil || string(data) != "someone else's work" {
				t.Fatalf("their file: %q, %v; a failed create deleted someone else's work (create error: %v)", data, rerr, err)
			}
			if !worktreeListed(t, repo, root) {
				t.Fatal("their worktree is no longer registered")
			}
			if got := runGit(t, root, "rev-parse", "HEAD"); got != oid {
				t.Fatalf("HEAD in their worktree = %q, want %s", got, oid)
			}
			head, _ := exec.Command("git", "-C", root, "symbolic-ref", "-q", "HEAD").Output()
			if got := strings.TrimSpace(string(head)); got != c.theirHead {
				t.Fatalf("their worktree is on %q, want %q", got, c.theirHead)
			}
			if !strings.Contains(err.Error(), root) || !strings.Contains(err.Error(), "not removed") {
				t.Fatalf("message %q should say that the directory was not removed", err)
			}
			if c.branchKept {
				if got := branchOID(t, repo, "fix-login"); got != oid {
					t.Fatalf("branch fix-login is at %q, want it kept at %s: their worktree is on it", got, oid)
				}
				if !strings.Contains(err.Error(), "branch fix-login kept") {
					t.Fatalf("message %q should say that the branch was kept", err)
				}
			} else if branchOID(t, repo, "fix-login") != "" {
				t.Fatal("this create's branch was left behind although no worktree is on it")
			}
			noWorktreeRemove(t, log)
		})
	}

	// The same before this create has made its branch: they add the worktree
	// with a branch of that name of their own.
	t.Run("added_before_the_branch_was_claimed", func(t *testing.T) {
		repo := devflowRepo(t)
		commitFile(t, repo, "later") // their branch starts somewhere else
		root := filepath.Join(containerOf(repo), "fix-login")
		log := installArgLoggingGit(t)
		var theirs string
		testBeforeBranchClaim = func() {
			runGit(t, repo, "worktree", "add", "-b", "fix-login", root, "HEAD~1")
			theirs = runGit(t, root, "rev-parse", "HEAD")
			if err := os.WriteFile(filepath.Join(root, "precious.txt"), []byte("someone else's work"), 0o600); err != nil {
				t.Error(err)
			}
		}
		t.Cleanup(func() { testBeforeBranchClaim = nil })
		_, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "fix-login"})
		if !errors.Is(err, ErrWorktreeBranchExists) {
			t.Fatalf("err = %v, want ErrWorktreeBranchExists", err)
		}
		if data, rerr := os.ReadFile(filepath.Join(root, "precious.txt")); rerr != nil || string(data) != "someone else's work" {
			t.Fatalf("their file: %q, %v; a failed create deleted someone else's work (create error: %v)", data, rerr, err)
		}
		if !worktreeListed(t, repo, root) || branchOID(t, repo, "fix-login") != theirs {
			t.Fatalf("their worktree or their branch was disturbed (branch at %q, want %s)", branchOID(t, repo, "fix-login"), theirs)
		}
		noWorktreeRemove(t, log)
	})
}

// X9. `git worktree add` that gives up on its own has taken back what it had
// made, so whatever is in the directory afterwards is not removed with git;
// the directory goes only if it is empty, and the branch only if no worktree
// is on it.
func TestUndoAfterWorktreeAddFailedOnItsOwn(t *testing.T) {
	// Someone put a file into the claimed directory and checked the new branch
	// out in a worktree elsewhere.
	t.Run("file_in_the_directory_and_branch_checked_out_elsewhere", func(t *testing.T) {
		repo := devflowRepo(t)
		oid := runGit(t, repo, "rev-parse", "HEAD")
		root := filepath.Join(containerOf(repo), "fix-login")
		elsewhere := filepath.Join(t.TempDir(), "elsewhere")
		testBeforeWorktreeAdd = func() {
			if err := os.WriteFile(filepath.Join(root, "note.txt"), []byte("a note"), 0o600); err != nil {
				t.Error(err)
			}
			runGit(t, repo, "worktree", "add", elsewhere, "fix-login")
		}
		t.Cleanup(func() { testBeforeWorktreeAdd = nil })
		_, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "fix-login"})
		if err == nil {
			t.Fatal("the create succeeded into a directory that was not empty")
		}
		if data, _ := os.ReadFile(filepath.Join(root, "note.txt")); string(data) != "a note" {
			t.Fatalf("the file in the directory is gone (create error: %v)", err)
		}
		if got := branchOID(t, repo, "fix-login"); got != oid {
			t.Fatalf("branch fix-login is at %q, want it kept at %s: a worktree is on it", got, oid)
		}
		if got := runGit(t, elsewhere, "symbolic-ref", "HEAD"); got != "refs/heads/fix-login" {
			t.Fatalf("the worktree elsewhere is on %q", got)
		}
		for _, want := range []string{root, "not removed", "branch fix-login kept", elsewhere} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("message %q does not say %q", err, want)
			}
		}
	})

	// git reports a failing post-checkout hook as a failed `git worktree add`,
	// although the worktree is complete by then. This create cannot tell that
	// worktree from one someone else added in the meantime, so it is left where
	// it is (detached; the branch, which nothing is on, goes) and the error
	// says so.
	t.Run("post_checkout_hook_fails", func(t *testing.T) {
		repo := devflowRepo(t)
		oid := runGit(t, repo, "rev-parse", "HEAD")
		hook := filepath.Join(repo, ".git", "hooks", "post-checkout")
		if err := os.MkdirAll(filepath.Dir(hook), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(hook, []byte("#!/bin/sh\necho 'the hook says no' >&2\nexit 2\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		root := filepath.Join(containerOf(repo), "fix-login")
		log := installArgLoggingGit(t)
		_, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "fix-login"})
		if err == nil {
			t.Fatal("the create succeeded although git worktree add reported a failure")
		}
		noWorktreeRemove(t, log)
		if branchOID(t, repo, "fix-login") != "" {
			t.Fatal("the branch was left behind although no worktree is on it")
		}
		if !strings.Contains(err.Error(), "the hook says no") {
			t.Fatalf("message %q does not carry git's own words", err)
		}
		if !worktreeListed(t, repo, root) {
			// A git that takes the worktree back itself when the hook fails.
			if pathExists(root) {
				t.Fatalf("git lists no worktree at %s, but the directory is still there", root)
			}
			return
		}
		if got := runGit(t, root, "rev-parse", "HEAD"); got != oid {
			t.Fatalf("HEAD in the worktree that was left = %q, want %s", got, oid)
		}
		for _, want := range []string{root, "not removed"} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("message %q does not say %q", err, want)
			}
		}
	})
}

// X13. While the sessions are being ended, the worktree is switched to another
// branch that is at the very same commit, or detached at it. The commit is
// what was confirmed; the branch is not. Nothing more is removed: the request
// was to remove the worktree of fix-login and delete that branch.
func TestRemoveBranchSwitchedWhileEndingSessions(t *testing.T) {
	for _, target := range []string{"other_branch_at_the_same_commit", "detached_at_the_same_commit"} {
		t.Run(target, func(t *testing.T) {
			f := newRemoveFixture(t, 1)
			runGit(t, f.repo, "branch", "other", "fix-login")
			st := f.status()
			if st.Branch != "fix-login" || !st.Managed {
				t.Fatalf("status = %+v, want the managed worktree of fix-login", st)
			}
			req := request(st)
			req.Branch = st.Branch
			req.DeleteBranch = true
			f.m.testAfterSessionsEnded = func() {
				if target == "detached_at_the_same_commit" {
					runGit(t, f.root, "checkout", "--detach", st.Head)
				} else {
					runGit(t, f.root, "checkout", "other")
				}
				if got := runGit(t, f.root, "rev-parse", "HEAD"); got != st.Head {
					t.Errorf("HEAD after the switch = %s, want it unchanged at %s", got, st.Head)
				}
			}
			res, err := f.remove(req)
			changed := wantChanged(t, err)
			if res.Removed || res.BranchDeleted {
				t.Fatalf("result = %+v, want nothing removed", res)
			}
			if !reflect.DeepEqual(changed.EndedSessions, f.ids) {
				t.Fatalf("endedSessions = %v, want %v: the session was ended before the switch was noticed", changed.EndedSessions, f.ids)
			}
			cur := changed.Status
			if target == "detached_at_the_same_commit" {
				if cur.Branch != "" || !cur.Detached || cur.Head != st.Head {
					t.Fatalf("status in the answer = %+v, want detached at %s", cur, st.Head)
				}
			} else if cur.Branch != "other" || cur.Detached || cur.Head != st.Head || cur.Managed {
				t.Fatalf("status in the answer = %+v, want branch other at %s, not managed", cur, st.Head)
			}
			if len(cur.Sessions) != 0 {
				t.Fatalf("status in the answer lists sessions %v; they were ended", cur.Sessions)
			}
			if !pathExists(f.root) || !worktreeListed(t, f.repo, f.root) {
				t.Fatal("the worktree was removed although it is no longer on the confirmed branch")
			}
			if got := branchOID(t, f.repo, "fix-login"); got != st.Head {
				t.Fatalf("branch fix-login is at %q, want it kept at %s", got, st.Head)
			}
			if got := branchOID(t, f.repo, "other"); got != st.Head {
				t.Fatalf("branch other is at %q, want %s", got, st.Head)
			}
		})
	}
}

// X12. What tmux says when nothing is running is one of two sentences. The
// words of those sentences inside a socket path — in an error that is about
// something else — are not that.
func TestIsNoTmuxServerGoesByTheWholeLine(t *testing.T) {
	cases := []struct {
		name   string
		stderr string
		want   bool
	}{
		{"no server running", "no server running on /tmp/tmux-501/vibe-remote\n", true},
		{"no sessions", "no sessions\n", true},
		{"no sessions, without the newline", "no sessions", true},
		{"no sessions, after a warning line", "warning: something\n  no sessions  \n", true},
		{"no server running, on a path that says no sessions", "no server running on /tmp/vr-no sessions-1/tmux-501/vibe-remote\n", true},
		{"socket missing, on a path that says no sessions", "error connecting to /private/tmp/vr-no sessions-1/tmux-501/vibe-remote (No such file or directory)\n", false},
		{"socket missing, on a path that says no server running", "error connecting to /tmp/no server running on x/tmux-501/vibe-remote (No such file or directory)\n", false},
		{"permission denied, on a path that says no sessions", "error connecting to /tmp/no sessions/tmux-501/vibe-remote (Permission denied)\n", false},
		{"a line that only ends in no sessions", "lost server: no sessions\n", false},
		{"no sessions and more", "no sessions found in /tmp/x\n", false},
		{"empty", "", false},
	}
	for _, c := range cases {
		if got := isNoTmuxServer([]byte(c.stderr)); got != c.want {
			t.Errorf("%s: isNoTmuxServer(%q) = %v, want %v", c.name, c.stderr, got, c.want)
		}
	}
}

// X12. The socket directory has "no sessions" in its name, a session is
// running, and the socket file is deleted. tmux's error names the path; that
// is not tmux saying that there are no sessions, and the worktree of the
// session stays.
func TestSocketPathSayingNoSessionsIsNotAnEmptySet(t *testing.T) {
	requireTmux(t)
	dir, err := os.MkdirTemp("/tmp", "vr-no sessions-")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMUX_TMPDIR", dir)
	// As in freshTmuxDir: registered after Setenv, so only the server this
	// test started on its own socket is stopped.
	t.Cleanup(func() {
		_ = tmuxCmd("kill-server").Run()
		_ = os.RemoveAll(dir)
	})
	repo := devflowRepo(t)
	root := externalWorktree(t, repo, "feat")
	m := NewManager(true, "sleep 120", false, "")
	m.SetProjectStore(NewMemoryProjectStore())
	id := terminalSessionIn(t, m, root)
	st, err := m.WorktreeStatus(root, allowAny)
	if err != nil {
		t.Fatal(err)
	}
	pid := ownTmuxServerPID(t)
	sock := ownTmuxSocket(t, dir)
	if !strings.Contains(sock, "no sessions") {
		t.Fatalf("socket path %q does not have the words in it", sock)
	}
	t.Cleanup(func() { restoreOwnTmuxSocket(t, pid, sock) })
	if err := os.Remove(sock); err != nil {
		t.Fatal(err)
	}

	if live, ok := m.liveTmuxSessions(); ok {
		t.Fatalf("liveTmuxSessions() = %v, true; want a failed reading: the server runs and its socket file is gone", live)
	}
	res, err := m.RemoveWorktree(request(st), allowAny)
	failed := wantRemoveError(t, err)
	if res.Removed || len(failed.EndedSessions) != 0 || !strings.Contains(failed.Message, "socket") {
		t.Fatalf("result = %+v, failed = %+v; want a refusal that names the socket and ends nobody", res, failed)
	}
	if !pathExists(root) || branchOID(t, repo, "feat") == "" {
		t.Fatal("the directory or the branch was removed")
	}
	if _, ok := m.Get(id); !ok {
		t.Fatal("the session was dropped from the table")
	}
	restoreOwnTmuxSocket(t, pid, sock)
	if !tmuxSessionAlive(id) {
		t.Fatal("the tmux session did not survive")
	}
}

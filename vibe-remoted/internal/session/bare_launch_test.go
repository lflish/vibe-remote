package session

import (
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat"
)

// loginLauncher stands in for the user's login shell without reading any
// profile: `<launcher> -lic <command>` runs command with /bin/sh.
func loginLauncher(t *testing.T) string {
	t.Helper()
	launcher := filepath.Join(t.TempDir(), "launch-shell")
	if err := os.WriteFile(launcher, []byte("#!/bin/sh\nexec /bin/sh -c \"$2\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return launcher
}

// Without tmux and without a login shell the CLI is exec'd directly, so a
// command the daemon builds (handoff, continue rewrite) must reach it as an
// argv, not as one word naming the whole command line.
func TestHandoffWithoutTmux(t *testing.T) {
	for _, login := range []bool{false, true} {
		f := newChatFixture(t, false)
		if login {
			f.m.loginShell, f.m.shell = true, loginLauncher(t)
		}
		a := f.mustCreate(f.m, newID("handoff-bare"), f.workdir(), "--append-system-prompt 'two words'")
		f.waitArgv(1)
		tid := newID("handoff-term")
		r, err := f.m.Handoff(a.ID, tid, 80, 24)
		if err != nil {
			t.Fatalf("login_shell=%v: handoff: %v", login, err)
		}
		t.Cleanup(func() { _ = f.m.Delete(tid) })
		argv := f.waitArgv(2)
		u := a.Session.ClaudeSessionID()
		if !has(argv, "--session-id", u) && !has(argv, "--resume", u) {
			t.Fatalf("login_shell=%v: terminal argv %q does not open %s", login, argv, u)
		}
		if !has(argv, "--append-system-prompt", "two words") || has(argv, "-p", "") {
			t.Fatalf("login_shell=%v: terminal argv %q", login, argv)
		}
		if r.ClaudeU() != u {
			t.Fatalf("login_shell=%v: runner holds %q, want %q", login, r.ClaudeU(), u)
		}
	}
}

func TestContinueTerminalWithoutTmuxOrLoginShell(t *testing.T) {
	f := newChatFixture(t, false)
	w, u := f.workdir(), chat.NewUUID()
	f.transcript(w, u, time.Now())
	if _, err := f.createTerminal(f.m, newID("bare-continue"), w, f.exe+" -c"); err != nil {
		t.Fatal(err)
	}
	if argv := f.waitArgv(1); !has(argv, "--resume", u) {
		t.Fatalf("terminal argv %q, want --resume %s", argv, u)
	}
}

// A bare (no tmux) terminal's claude dies with its PTY: on a detach, or on
// its own. Its claim on the conversation must not outlive it, or a chat -c
// on that conversation is refused forever.
func TestBareTerminalReleasesClaimWhenGone(t *testing.T) {
	for _, how := range []string{"detach", "exit"} {
		f := newChatFixture(t, false)
		f.m.loginShell, f.m.shell = true, loginLauncher(t)
		w, u := f.workdir(), chat.NewUUID()
		f.transcript(w, u, time.Now())
		tid := newID("bare-claim")
		r, err := f.createTerminal(f.m, tid, w, f.exe+" -c")
		if err != nil {
			t.Fatal(err)
		}
		f.waitArgv(1)
		if owner := f.owner(f.m, u); owner != tid {
			t.Fatalf("%s: terminal does not hold %s (owner %q)", how, u, owner)
		}
		pid := r.cmd.Process.Pid
		switch how {
		case "detach": // the client went away: bare mode ends the CLI
			var wg sync.WaitGroup
			wg.Add(2)
			go func() { defer wg.Done(); r.DetachEpoch(r.CurrentEpoch()) }()
			go func() {
				defer wg.Done()
				for i := 0; i < 40; i++ {
					f.m.List()
					time.Sleep(time.Millisecond)
				}
			}()
			wg.Wait()
		case "exit": // claude ended by itself; the relay reaps it
			go func() { // drain the PTY as the relay does, or the exit blocks on it
				buf := make([]byte, 4096)
				for {
					if _, err := r.Read(buf); err != nil {
						return
					}
				}
			}()
			if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
				t.Fatalf("kill %d: %v", pid, err)
			}
			r.Wait()
		}
		waitUntil(t, "terminal gone", func() bool { return !processRunning(pid) })
		if _, err := f.create(f.m, newID("bare-claim-chat"), w, "-c"); err != nil {
			t.Fatalf("%s: terminal pid %d gone, owner %q; chat -c: %v", how, pid, f.owner(f.m, u), err)
		}
	}
}

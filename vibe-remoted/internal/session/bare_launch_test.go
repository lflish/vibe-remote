package session

import (
	"os"
	"path/filepath"
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

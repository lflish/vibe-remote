package session

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The daemon may get its main token from VIBE_REMOTED_TOKEN. Nothing it
// starts may inherit that variable: the main token grants full shell access
// via attach, while an agent should only ever see its hook token.
const envMainToken = "env-only-main-token-0123456789abcdef"

// envDumpScript writes the agent-visible tokens to out and then runs next
// (or sleeps when next is empty).
func envDumpScript(t *testing.T, out, next string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "claude")
	tail := "exec sleep 30"
	if next != "" {
		tail = "exec '" + next + "' \"$@\""
	}
	body := "#!/bin/sh\nprintf 'main=%s hook=%s' \"$VIBE_REMOTED_TOKEN\" \"$VIBE_REMOTE_TOKEN\" > '" + out + "'\n" + tail + "\n"
	if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestMainTokenEnvNotInheritedByChatProcess(t *testing.T) {
	t.Setenv("VIBE_REMOTED_TOKEN", envMainToken)
	f := newChatFixture(t, false)
	f.m.SetEventEnv("http://127.0.0.1:1/api/v1/events", envMainToken)
	dump := filepath.Join(t.TempDir(), "env.txt")
	wrapper := envDumpScript(t, dump, f.exe)
	id := newID("envleak")
	if _, err := f.m.CreateChat(ChatCreateOptions{ID: id, Workdir: f.workdir(), Parsed: parsed(t, wrapper)}); err != nil {
		t.Fatal(err)
	}
	got := waitForFile(t, dump)
	if want := "main= hook=" + HookToken(envMainToken, id); got != want {
		t.Fatalf("chat process env = %q, want %q", got, want)
	}
}

func TestMainTokenEnvNotInheritedByBareTerminal(t *testing.T) {
	t.Setenv("VIBE_REMOTED_TOKEN", envMainToken)
	dump := filepath.Join(t.TempDir(), "env.txt")
	m := NewManager(false, envDumpScript(t, dump, ""), false, "")
	m.SetEventEnv("http://127.0.0.1:1/api/v1/events", envMainToken)
	r, err := m.Create(CreateOptions{Workdir: t.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Kill)
	if got, want := waitForFile(t, dump), "main= hook="+HookToken(envMainToken, r.ID); got != want {
		t.Fatalf("terminal env = %q, want %q", got, want)
	}
}

// A tmux server an older daemon started still carries the variable in its
// global environment; a new Manager removes it from there.
func TestMainTokenEnvNotInheritedByTmuxTerminal(t *testing.T) {
	requireTmux(t)
	keep := newTmuxKeeper(t)
	defer keep()
	if out, err := tmuxCmd("set-environment", "-g", "VIBE_REMOTED_TOKEN", envMainToken).CombinedOutput(); err != nil {
		t.Fatalf("seed tmux global env: %v: %s", err, out)
	}
	t.Setenv("VIBE_REMOTED_TOKEN", envMainToken)
	dump := filepath.Join(t.TempDir(), "env.txt")
	m := NewManager(true, envDumpScript(t, dump, ""), false, "")
	m.SetEventEnv("http://127.0.0.1:1/api/v1/events", envMainToken)
	r, err := m.Create(CreateOptions{Workdir: t.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Kill)
	if got, want := waitForFile(t, dump), "main= hook="+HookToken(envMainToken, r.ID); got != want {
		t.Fatalf("tmux terminal env = %q, want %q", got, want)
	}
}

// newTmuxKeeper keeps the shared tmux server running (a placeholder session)
// so a global environment set on it is not lost when another session ends.
func newTmuxKeeper(t *testing.T) func() {
	t.Helper()
	name := newID("vrkeep") // not a vibe-remote- session: reconcile ignores it
	if out, err := tmuxCmd("new-session", "-d", "-s", name, "sleep 60").CombinedOutput(); err != nil {
		t.Fatalf("tmux keeper: %v: %s", err, out)
	}
	if !waitTmuxSession(name, 3*time.Second) {
		t.Fatal("tmux keeper session did not start")
	}
	return func() { _ = tmuxCmd("kill-session", "-t", name).Run() }
}

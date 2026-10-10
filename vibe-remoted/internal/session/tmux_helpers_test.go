package session

import (
	"os"
	"os/exec"
	"testing"
	"time"
)

// requireTmux returns the tmux binary path, skipping the test when tmux is not
// installed. CI sets VIBE_REMOTE_REQUIRE_TMUX=1 so a missing tmux fails the run
// instead of silently skipping every integration test.
func requireTmux(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("tmux")
	if err != nil {
		if os.Getenv("VIBE_REMOTE_REQUIRE_TMUX") == "1" {
			t.Fatal("tmux is not installed but VIBE_REMOTE_REQUIRE_TMUX=1")
		}
		t.Skip("tmux is not installed")
	}
	return path
}

// startTmuxSession creates a detached session on the vibe-remote socket through
// tmuxCmd (so it gets the same env treatment as production) and kills it on
// cleanup. Like newTmuxSession it retries while a previous test's teardown may
// still be shutting the shared server down.
func startTmuxSession(t *testing.T, sessionName string, command ...string) {
	t.Helper()
	args := append([]string{"new-session", "-d", "-s", sessionName, "--"}, command...)
	var lastOut []byte
	var lastErr error
	for attempt := 0; attempt < 5; attempt++ {
		out, err := tmuxCmd(args...).CombinedOutput()
		if err == nil {
			t.Cleanup(func() { tmuxCmd("kill-session", "-t", sessionName).Run() })
			return
		}
		lastOut, lastErr = out, err
		time.Sleep(150 * time.Millisecond)
	}
	t.Fatalf("create tmux session %s: %v: %s", sessionName, lastErr, lastOut)
}

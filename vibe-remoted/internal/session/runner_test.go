package session

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSetTmuxOptionPersistsUnambiguousAndEmptyValues(t *testing.T) {
	realTmux, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux is not installed")
	}

	binDir := t.TempDir()
	shim := filepath.Join(binDir, "tmux")
	shimSource := fmt.Sprintf(`#!/bin/sh
case " $* " in
  *" set-option "*" @vibe_remote_"*)
    case " $* " in
      *" -- @vibe_remote_"*) ;;
      *) exit 64 ;;
    esac
    ;;
esac
exec %q "$@"
`, realTmux)
	if err := os.WriteFile(shim, []byte(shimSource), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	sessionName := fmt.Sprintf("vibe-remote-metadata-test-%d", time.Now().UnixNano())
	cmd := exec.Command(realTmux, "-L", tmuxSocket, "new-session", "-d", "-s", sessionName, "--", "/bin/cat")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("create tmux session: %v: %s", err, out)
	}
	defer exec.Command(realTmux, "-L", tmuxSocket, "kill-session", "-t", sessionName).Run()

	options := []struct{ key, value string }{
		{"@vibe_remote_mode", "worktree"},
		{"@vibe_remote_source_workdir", "/private/tmp/source workdir"},
		{"@vibe_remote_source_repo", ""},
	}
	for _, option := range options {
		if err := setTmuxOption(sessionName, option.key, option.value); err != nil {
			t.Fatalf("set %s: %v", option.key, err)
		}
	}

	for _, option := range options {
		out, err := exec.Command(realTmux, "-L", tmuxSocket, "show-options", "-t", sessionName, "-qv", option.key).CombinedOutput()
		if err != nil {
			t.Fatalf("read %s: %v: %s", option.key, err, out)
		}
		if got := strings.TrimSuffix(string(out), "\n"); got != option.value {
			t.Fatalf("%s = %q, want %q", option.key, got, option.value)
		}
	}
}

func TestReloadRespawnsTmuxPaneInSameSession(t *testing.T) {
	realTmux, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux is not installed")
	}

	id := fmt.Sprintf("reload-test-%d", time.Now().UnixNano())
	sessionName := "vibe-remote-" + id
	workdir := t.TempDir()
	marker := filepath.Join(workdir, "reloaded")
	cmd := exec.Command(realTmux, "-L", tmuxSocket, "new-session", "-d", "-s", sessionName, "-c", workdir, "--", "/bin/sleep", "30")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("create tmux session: %v: %s", err, out)
	}
	defer exec.Command(realTmux, "-L", tmuxSocket, "kill-session", "-t", sessionName).Run()

	runner := &Runner{
		ID:         id,
		Workdir:    workdir,
		useTmux:    true,
		loginShell: true,
		shell:      "/bin/sh",
	}
	if err := runner.Reload("/bin/sh -c 'printf reloaded > reloaded; exec /bin/sleep 30'"); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for {
		data, err := os.ReadFile(marker)
		if err == nil {
			if string(data) != "reloaded" {
				t.Fatalf("marker = %q, want reloaded", data)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("reloaded command did not run: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := exec.Command(realTmux, "-L", tmuxSocket, "has-session", "-t", sessionName).Run(); err != nil {
		list, _ := exec.Command(realTmux, "-L", tmuxSocket, "list-sessions", "-F", "#{session_name}").CombinedOutput()
		t.Fatalf("tmux session was not preserved: %v; sessions=%q", err, list)
	}
}

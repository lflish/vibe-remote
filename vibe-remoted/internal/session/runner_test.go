package session

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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

// newTmuxSession starts a detached tmux session, retrying while the shared
// `tmux -L vibe-remote` server is mid-shutdown. Tests share one socket, so when
// a previous test's cleanup removes the last session the server exits — and a
// new-session racing that teardown fails with "server exited unexpectedly".
// Retrying lets tmux spawn a fresh server instead of making the suite flaky.
func newTmuxSession(t *testing.T, realTmux, sessionName, workdir string) {
	t.Helper()
	var lastOut []byte
	var lastErr error
	for attempt := 0; attempt < 5; attempt++ {
		out, err := exec.Command(realTmux, "-L", tmuxSocket, "new-session", "-d",
			"-s", sessionName, "-c", workdir, "--", "/bin/sleep", "120").CombinedOutput()
		if err == nil {
			return
		}
		lastOut, lastErr = out, err
		time.Sleep(150 * time.Millisecond)
	}
	t.Fatalf("create tmux session after retries: %v: %s", lastErr, lastOut)
}

// TestReadEpochRejectsSupersededEpoch pins the guard that keeps a stale relay
// from reading the PTY a newer reconnect installed. Without it, ptmxSnapshot
// hands the old reader the *new* master and the two relays split the byte
// stream, so both clients render a partial screen.
func TestReadEpochRejectsSupersededEpoch(t *testing.T) {
	realTmux, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux is not installed")
	}

	id := fmt.Sprintf("epoch-guard-%d", time.Now().UnixNano())
	sessionName := "vibe-remote-" + id
	workdir := t.TempDir()
	newTmuxSession(t, realTmux, sessionName, workdir)
	defer exec.Command(realTmux, "-L", tmuxSocket, "kill-session", "-t", sessionName).Run()

	r := &Runner{ID: id, Workdir: workdir, useTmux: true, loginShell: false, shell: "/bin/sh"}
	if err := r.AttachExisting(80, 24); err != nil {
		t.Fatalf("first attach: %v", err)
	}
	stale := r.CurrentEpoch()

	if err := r.AttachExisting(80, 24); err != nil {
		t.Fatalf("reconnect attach: %v", err)
	}
	if current := r.CurrentEpoch(); current == stale {
		t.Fatalf("epoch did not advance on reconnect: still %d", current)
	}

	if _, err := r.ReadEpoch(stale, make([]byte, 64)); !errors.Is(err, ErrEpochSuperseded) {
		t.Errorf("ReadEpoch(stale) = %v, want ErrEpochSuperseded", err)
	}
	if _, err := r.WriteEpoch(stale, []byte("x")); !errors.Is(err, ErrEpochSuperseded) {
		t.Errorf("WriteEpoch(stale) = %v, want ErrEpochSuperseded", err)
	}
}

// TestReconnectReapsRetiredAttachProcesses covers two leaks that only show up
// after repeated reconnects: the retired tmux attach process must be waited for
// (or it lingers as a zombie), and killing it must unblock the old relay's Read
// (closing a PTY master does not wake a blocked reader, so that goroutine would
// hang forever). The tmux session itself must survive all of it.
func TestReconnectReapsRetiredAttachProcesses(t *testing.T) {
	realTmux, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux is not installed")
	}

	id := fmt.Sprintf("reap-%d", time.Now().UnixNano())
	sessionName := "vibe-remote-" + id
	workdir := t.TempDir()
	newTmuxSession(t, realTmux, sessionName, workdir)
	defer exec.Command(realTmux, "-L", tmuxSocket, "kill-session", "-t", sessionName).Run()

	goroutinesBefore := runtime.NumGoroutine()
	r := &Runner{ID: id, Workdir: workdir, useTmux: true, loginShell: false, shell: "/bin/sh"}

	var pids []int
	const reconnects = 4
	for i := 0; i < reconnects; i++ {
		if err := r.AttachExisting(80, 24); err != nil {
			t.Fatalf("attach %d: %v", i, err)
		}
		if r.cmd != nil && r.cmd.Process != nil {
			pids = append(pids, r.cmd.Process.Pid)
		}
		// Mimic a relay: block in ReadEpoch on the epoch it owns.
		go func(epoch uint64) {
			buf := make([]byte, 256)
			for {
				if _, err := r.ReadEpoch(epoch, buf); err != nil {
					return
				}
			}
		}(r.CurrentEpoch())
		time.Sleep(300 * time.Millisecond)
	}

	// Reaping detaches tmux *clients*; the session and its process live on.
	if err := exec.Command(realTmux, "-L", tmuxSocket, "has-session", "-t", sessionName).Run(); err != nil {
		t.Fatalf("tmux session did not survive reconnects: %v", err)
	}

	r.DetachEpoch(r.CurrentEpoch())
	time.Sleep(time.Second)

	for _, pid := range pids {
		out, _ := exec.Command("ps", "-o", "stat=", "-p", fmt.Sprint(pid)).Output()
		if state := strings.TrimSpace(string(out)); strings.HasPrefix(state, "Z") {
			t.Errorf("pid %d left as a zombie (state %q): retired cmd was never waited for", pid, state)
		}
	}

	runtime.GC()
	if leaked := runtime.NumGoroutine() - goroutinesBefore; leaked >= reconnects {
		t.Errorf("leaked %d goroutines after %d reconnects: readers blocked on closed PTYs never exited",
			leaked, reconnects)
	}
}

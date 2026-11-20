package chat

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat/chattest"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// startOrphan starts a fake claude for conversation u the way a previous
// daemon would have, and reaps it when it exits (a real orphan is reaped by
// init; an unreaped child would stay a zombie and look alive).
func startOrphan(t *testing.T, env *chattest.Env, u string) (int, chan struct{}) {
	t.Helper()
	exe := filepath.Join(chattest.FakeClaude(t), "claude")
	cmd := exec.Command(exe, ChatArgv(Parsed{Exe: exe}, u, false)[1:]...)
	cmd.Dir = t.TempDir()
	cmd.Env = env.Environ()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	gone := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(gone)
	}()
	t.Cleanup(func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		stdin.Close()
	})
	deadline := time.Now().Add(waitTimeout)
	for len(env.LivePids(u)) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("orphan did not start")
		}
		time.Sleep(5 * time.Millisecond)
	}
	return cmd.Process.Pid, gone
}

// goneTimeout bounds the waits for a fake claude this test expects to be
// dead. Normally that takes about a second (SIGTERM, 1 s grace, SIGKILL; the
// stubborn case itself asserts ≤ 4 s), so 15 s only passes when the process
// was never signalled — and then the test fails with the reason instead of
// hanging until go test's global timeout.
const goneTimeout = 15 * time.Second

func waitExit(t *testing.T, gone <-chan struct{}, pid int, why string) {
	t.Helper()
	select {
	case <-gone:
	case <-time.After(goneTimeout):
		t.Fatalf("fake claude (pid %d) still running %v %s", pid, goneTimeout, why)
	}
}

func TestOrphanCleanup(t *testing.T) {
	t.Parallel()
	t.Run("ended and confirmed gone", func(t *testing.T) {
		t.Parallel()
		env := chattest.NewEnv(t)
		u := NewUUID()
		pid, gone := startOrphan(t, env, u)
		recs := []Record{{ID: "a", Name: "keep me", ClaudeSessionID: u, Status: StatusRunning, Pid: pid}}
		out, orphans := CleanupOrphans(recs)
		select {
		case <-gone:
		case <-time.After(time.Second):
			t.Fatal("orphan still running after cleanup")
		}
		if len(orphans) != 0 {
			t.Fatalf("orphans %v", orphans)
		}
		if out[0].Status != StatusEnded || out[0].EndReason != protocol.EndReasonDaemonRestart || out[0].Name != "keep me" || out[0].Pid != 0 {
			t.Fatalf("record %+v", out[0])
		}
	})
	t.Run("stubborn needs SIGKILL", func(t *testing.T) {
		t.Parallel()
		env := chattest.NewEnv(t)
		env.Extra = append(env.Extra, "FAKE_CLAUDE_STUBBORN=1")
		u := NewUUID()
		pid, gone := startOrphan(t, env, u)
		start := time.Now()
		out, orphans := CleanupOrphans([]Record{{ID: "b", ClaudeSessionID: u, Status: StatusRunning, Pid: pid}})
		if len(orphans) != 0 || out[0].EndReason != protocol.EndReasonDaemonRestart {
			t.Fatalf("orphans %v record %+v", orphans, out[0])
		}
		waitExit(t, gone, pid, "after CleanupOrphans: it only signals a pid whose command line (read with ps) names the conversation, so where ps is not permitted the process is never signalled")
		if d := time.Since(start); d > 4*time.Second {
			t.Fatalf("cleanup took %v", d)
		}
		log, _ := os.ReadFile(env.SignalLog)
		if !strings.Contains(string(log), "SIGTERM ignored") {
			t.Fatalf("signal log %q", log)
		}
	})
	t.Run("survivor keeps the claim", func(t *testing.T) {
		t.Parallel()
		env := chattest.NewEnv(t)
		u := NewUUID()
		pid, gone := startOrphan(t, env, u)
		noop := func(int, syscall.Signal) {}
		out, orphans := cleanupOrphans([]Record{{ID: "c", ClaudeSessionID: u, Status: StatusRunning, Pid: pid}}, noop)
		if len(orphans) != 1 || orphans[0].ClaudeSessionID != u || orphans[0].Pid != pid || orphans[0].Owner() != "orphan:"+strconv.Itoa(pid) {
			t.Fatalf("orphans %+v", orphans)
		}
		if out[0].Status != StatusEnded || out[0].EndReason != protocol.EndReasonDaemonRestart {
			t.Fatalf("record %+v", out[0])
		}
		if !processAlive(pid) || orphans[0].Gone() {
			t.Fatal("survivor reported gone")
		}
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		waitExit(t, gone, pid, "after this test's own SIGKILL (is signalling permitted here?)")
		if !orphans[0].Gone() {
			t.Fatal("dead orphan still reported alive")
		}
	})
	t.Run("unrelated process untouched", func(t *testing.T) {
		t.Parallel()
		env := chattest.NewEnv(t)
		u := NewUUID()
		pid, gone := startOrphan(t, env, u)
		// The pid was reused by a process that does not run this conversation.
		other := NewUUID()
		out, orphans := CleanupOrphans([]Record{{ID: "d", ClaudeSessionID: other, Status: StatusRunning, Pid: pid}})
		select {
		case <-gone:
			t.Fatal("cleanup killed a process that is not the orphan")
		case <-time.After(200 * time.Millisecond):
		}
		if len(orphans) != 0 || out[0].EndReason != protocol.EndReasonDaemonRestart {
			t.Fatalf("orphans %v record %+v", orphans, out[0])
		}
	})
	t.Run("ended records unchanged", func(t *testing.T) {
		t.Parallel()
		in := []Record{{ID: "e", ClaudeSessionID: NewUUID(), Status: StatusEnded, EndReason: protocol.EndReasonExited, ExitCode: 3}}
		out, orphans := CleanupOrphans(in)
		if len(orphans) != 0 || !reflect.DeepEqual(out[0], in[0]) {
			t.Fatalf("%+v", out[0])
		}
	})
}

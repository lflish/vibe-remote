package chat

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// A process in claude's group that ignores SIGTERM and still holds stdout
// keeps the pipe open after claude itself exited. Stop must not wait for that
// pipe forever: it escalates to SIGKILL for the group and settles.
func TestStopKillsTermIgnoringDescendantHoldingStdout(t *testing.T) {
	dir := t.TempDir()
	childFile := filepath.Join(dir, "child.pid")
	exe := filepath.Join(dir, "claude")
	script := "#!/bin/sh\n" +
		"trap 'exit 0' TERM\n" +
		"sh -c 'trap \"\" TERM; echo $$ > \"$0.tmp\" && mv \"$0.tmp\" \"$0\"; exec sleep 60' '" + childFile + "' &\n" +
		"while :; do sleep 1; done\n"
	if err := os.WriteFile(exe, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	s, err := Start(Spec{ID: "stop-descendant", Workdir: dir, Exe: exe, ClaudeSessionID: NewUUID(), ProjectsDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	var child int
	deadline := time.Now().Add(waitTimeout)
	for child == 0 && time.Now().Before(deadline) {
		data, _ := os.ReadFile(childFile)
		child, _ = strconv.Atoi(strings.TrimSpace(string(data)))
		time.Sleep(5 * time.Millisecond)
	}
	if child == 0 {
		s.WithOp(func(o OpHandle) { _ = o.StopLocked(protocol.EndReasonStopped) })
		t.Fatal("descendant did not start")
	}
	t.Cleanup(func() { _ = syscall.Kill(child, syscall.SIGKILL) })

	done := make(chan struct{})
	started := time.Now()
	go func() {
		s.WithOp(func(o OpHandle) { _ = o.StopLocked(protocol.EndReasonStopped) })
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = syscall.Kill(child, syscall.SIGKILL) // unblock the stop before failing
		<-done
		t.Fatalf("StopLocked blocked %v on a descendant holding stdout", time.Since(started))
	}
	if !waitGone(child, 2*time.Second) {
		t.Fatalf("stop returned with descendant %d alive", child)
	}
	if info := s.Snapshot(); info.Status != protocol.ChatStatusEnded || info.Pid != 0 {
		t.Fatalf("after stop: %+v", info)
	}
}

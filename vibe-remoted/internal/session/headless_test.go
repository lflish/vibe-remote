package session

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestHeadlessRunnerRunTurn(t *testing.T) {
	// Stub "claude": echo two NDJSON lines, and echo back stdin so we can
	// assert the prompt was delivered via stdin (never via the command line).
	// login shell wrapping is exercised (loginShell=true).
	// The stub is wrapped in its own `sh -c '...'` so that, like a real
	// flag-consuming binary, it absorbs the appended headlessFlags as its own
	// (ignored) positional args instead of letting them bind to `cat`; the inner
	// shell also runs the full `printf; cat` sequence even though the outer
	// login-shell wrapper `exec`s into it.
	stub := `sh -c 'printf "{\"type\":\"stream_event\"}\n{\"type\":\"result\"}\n"; cat'`
	h := NewHeadlessRunner("/tmp", stub, true, "/bin/sh", nil)

	var lines []string
	code, err := h.RunTurn(context.Background(), "hello-prompt\n", func(line []byte) {
		lines = append(lines, string(line))
	})
	if err != nil {
		t.Fatalf("RunTurn: %v", err)
	}
	if code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	// Two NDJSON lines + the echoed stdin line.
	if len(lines) < 2 {
		t.Fatalf("got %d lines, want >=2: %v", len(lines), lines)
	}
	if lines[0] != `{"type":"stream_event"}` || lines[1] != `{"type":"result"}` {
		t.Fatalf("unexpected first lines: %v", lines)
	}
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "hello-prompt") {
		t.Fatalf("prompt not delivered via stdin; lines: %v", lines)
	}
}

func TestHeadlessRunnerCancel(t *testing.T) {
	// A command that would block forever must be killed by ctx cancel.
	h := NewHeadlessRunner("/tmp", "cat", true, "/bin/sh", nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		// prompt without EOF-triggering exit; cat blocks reading stdin after echo.
		h.RunTurn(ctx, "x", func(line []byte) {})
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-timeoutCh(t):
		t.Fatal("RunTurn did not return after cancel")
	}
}

func timeoutCh(t *testing.T) <-chan struct{} {
	t.Helper()
	ch := make(chan struct{})
	go func() {
		time.Sleep(3 * time.Second)
		close(ch)
	}()
	return ch
}

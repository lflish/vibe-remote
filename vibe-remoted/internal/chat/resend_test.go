package chat

import (
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// A message settled as dropped_on_stop never ran; the client may send it
// again with the same clientMsgId and it must reach the new process.
func TestDroppedMessageResendWithSameIDIsDelivered(t *testing.T) {
	h := newHarness(t).start()
	c := h.attach("", nil)
	// Hold stdin so the message is accepted by Send but never reaches claude.
	resume := holdWriter(t, h.s, 3)
	h.send("lost-message", "echo must reach new process")
	stopped := make(chan struct{})
	go func() {
		h.s.WithOp(func(op OpHandle) { _ = op.StopLocked(protocol.EndReasonStopped) })
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("stop blocked")
	}
	resume()
	c.waitFor("dropped", func(fs []frame) bool { return len(notices(fs, NoticeDroppedOnStop)) == 1 })
	if n := len(h.stdin.control("user", "")); n != 0 {
		t.Fatalf("setup: %d user messages reached claude before the stop", n)
	}
	var err error
	h.s.WithOp(func(op OpHandle) { err = op.RestartLocked() })
	if err != nil {
		t.Fatal(err)
	}
	ack := h.s.Send("lost-message", "echo must reach new process")
	if !ack.OK {
		t.Fatalf("resend ack = %+v", ack)
	}
	deadline := time.Now().Add(waitTimeout)
	for len(h.stdin.control("user", "")) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("resent message never reached the new process")
		}
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond)
	if n := len(h.stdin.control("user", "")); n != 1 {
		t.Fatalf("resent message written %d times, want 1", n)
	}
	// Once it ran, the id is a duplicate again.
	h.waitIdle()
	if ack := h.s.Send("lost-message", "echo must reach new process"); !ack.OK {
		t.Fatalf("replay ack = %+v", ack)
	}
	time.Sleep(100 * time.Millisecond)
	if n := len(h.stdin.control("user", "")); n != 1 {
		t.Fatalf("a replay of a delivered message was written again (%d writes)", n)
	}
}

// A resent clientMsgId that was already accepted is acked as a duplicate,
// with completed telling whether its result came back. The record outlives
// the replay buffer.
func TestResendDuplicateReportsCompleted(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	h.waitIdle()
	if ack := h.s.Send("first", "echo one"); !ack.OK || ack.Duplicate {
		t.Fatalf("first send: %+v", ack)
	}
	h.waitIdle()
	// Push the original message and its result out of the ring.
	for i := 0; i < RingMax+10; i++ {
		h.s.injectLine([]byte(`{"type":"assistant","message":{"id":"filler","content":[]}}`))
	}
	if ack := h.s.Send("first", "echo one"); !ack.OK || !ack.Duplicate || !ack.Completed {
		t.Fatalf("resend of a completed message: %+v", ack)
	}
	resume := holdWriter(t, h.s, 3)
	defer resume()
	if ack := h.s.Send("second", "echo two"); !ack.OK || ack.Duplicate {
		t.Fatalf("second send: %+v", ack)
	}
	if ack := h.s.Send("second", "echo two"); !ack.OK || !ack.Duplicate || ack.Completed {
		t.Fatalf("resend of a message still running: %+v", ack)
	}
}

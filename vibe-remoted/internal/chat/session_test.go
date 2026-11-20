package chat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

func TestSendEchoAndStream(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c := h.attach("", nil)
	h.send("m1", "echo hello world")
	fs := c.waitFor("idle after result", func(fs []frame) bool {
		return resultCount(fs) == 1 && hasState(func(s *protocol.ChatStateFrame) bool { return s.Status == protocol.ChatStatusIdle })(fs)
	})
	all := msgs(fs, "")
	idx := func(pred func(frame) bool) int {
		for i, f := range all {
			if pred(f) {
				return i
			}
		}
		return -1
	}
	echo := idx(func(f frame) bool { return f.Msg["type"] == "user" && f.Msg["vr_client_msg_id"] == "m1" })
	stream := idx(func(f frame) bool { return f.Msg["type"] == "stream_event" })
	asst := idx(func(f frame) bool { return f.Msg["type"] == "assistant" })
	res := idx(func(f frame) bool { return f.Msg["type"] == "result" })
	if !(echo >= 0 && echo < stream && stream < asst && asst < res) {
		t.Fatalf("order echo=%d stream=%d assistant=%d result=%d", echo, stream, asst, res)
	}
	if !strings.Contains(assistantText(fs), "hello world") {
		t.Fatalf("reply text: %q", assistantText(fs))
	}
	var sawRunning bool
	for _, st := range states(fs) {
		if st.Status == protocol.ChatStatusRunning {
			sawRunning = true
		}
	}
	if !sawRunning {
		t.Fatal("status never was running")
	}
	// seq strictly increasing over live frames.
	var last uint64
	for _, f := range all {
		if f.Seq <= last {
			t.Fatalf("seq not increasing: %d after %d", f.Seq, last)
		}
		last = f.Seq
	}
}

func TestSendRejectsEmpty(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	before := len(h.stdin.control("user", ""))
	for _, text := range []string{"", "   ", "\n\t "} {
		if ack := h.s.Send("e", text); ack.OK || ack.Code != protocol.AckEmpty {
			t.Fatalf("Send(%q) = %+v, want empty", text, ack)
		}
	}
	if ack := h.s.Send("big", strings.Repeat("x", MaxSendBytes+1)); ack.OK || ack.Code != protocol.AckTooLarge {
		t.Fatalf("oversized send = %+v", ack)
	}
	time.Sleep(100 * time.Millisecond)
	if got := len(h.stdin.control("user", "")); got != before {
		t.Fatalf("stdin got %d user lines", got-before)
	}
}

func TestSendUTF8(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c := h.attach("", nil)
	text := "echo 你好 🌏 ─┼─ café"
	h.send("u1", text)
	fs := c.waitFor("result", func(fs []frame) bool { return resultCount(fs) == 1 })
	users := h.stdin.control("user", "")
	if len(users) != 1 || users[0]["message"].(map[string]any)["content"] != text {
		t.Fatalf("stdin user lines: %v", users)
	}
	echo := msgs(fs, "user")[0]
	content := echo.Msg["message"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"]
	if content != text {
		t.Fatalf("echo text %q", content)
	}
	if !strings.Contains(assistantText(fs), "你好 🌏 ─┼─ café") {
		t.Fatalf("reply %q", assistantText(fs))
	}
}

func TestSendDedupClientMsgID(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c := h.attach("", nil)
	h.send("same", "echo once")
	if ack := h.s.Send("same", "echo once"); !ack.OK {
		t.Fatalf("replayed send ack %+v", ack)
	}
	c.waitFor("result", func(fs []frame) bool { return resultCount(fs) == 1 })
	time.Sleep(200 * time.Millisecond)
	if n := len(h.stdin.control("user", "")); n != 1 {
		t.Fatalf("stdin has %d user lines", n)
	}
	if n := len(msgs(c.snapshot(), "user")); n != 1 {
		t.Fatalf("%d echoes", n)
	}
}

func TestSendWhenNotRunning(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	h.s.WithOp(func(ops OpHandle) { _ = ops.StopLocked(protocol.EndReasonStopped) })
	if ack := h.s.Send("x", "echo hi"); ack.OK || ack.Code != protocol.AckChatNotRunning {
		t.Fatalf("ack %+v", ack)
	}
}

func TestInterruptStopsTurn(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c := h.attach("", nil)
	h.send("s", "slow 100 50")
	c.waitFor("streaming", func(fs []frame) bool { return len(msgs(fs, "stream_event")) > 3 })
	if ack := h.s.Interrupt(); !ack.OK {
		t.Fatalf("interrupt ack %+v", ack)
	}
	fs := c.waitFor("result", func(fs []frame) bool { return resultCount(fs) == 1 })
	r := msgs(fs, "result")[0].Msg
	if r["subtype"] != "error_during_execution" || r["terminal_reason"] != "aborted_streaming" {
		t.Fatalf("result %v", r)
	}
	h.waitIdle()
	h.send("e", "echo again")
	c.waitFor("second result", func(fs []frame) bool { return resultCount(fs) == 2 })
}

func TestInterruptIdleNoop(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	h.waitIdle()
	if ack := h.s.Interrupt(); !ack.OK {
		t.Fatalf("ack %+v", ack)
	}
	time.Sleep(100 * time.Millisecond)
	if n := len(h.stdin.control("control_request", "interrupt")); n != 0 {
		t.Fatalf("idle interrupt wrote %d interrupts", n)
	}
}

func TestInterruptResolvesPending(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c := h.attach("", nil)
	h.send("p", "perm touch x")
	id, _ := pendingRequest(t, h.waitPending(1))
	if ack := h.s.Interrupt(); !ack.OK {
		t.Fatalf("ack %+v", ack)
	}
	fs := c.waitFor("aborted result", func(fs []frame) bool { return resultCount(fs) == 1 })
	if r := msgs(fs, "result")[0].Msg; r["terminal_reason"] != "aborted_tools" {
		t.Fatalf("result %v", r)
	}
	res := resolved(fs, id)
	if len(res) != 1 || res[0].Msg["outcome"] != outcomeInterrupted {
		t.Fatalf("vr_resolved: %s", lastRaw(res, 3))
	}
	if n := len(h.stdin.control("control_request", "interrupt")); n != 1 {
		t.Fatalf("%d interrupts on stdin", n)
	}
	if n := len(h.stdin.control("control_response", "")); n != 0 {
		t.Fatalf("daemon answered the request itself: %v", h.stdin.control("control_response", ""))
	}
	if strings.Contains(assistantText(fs), "done Bash") {
		t.Fatal("tool ran")
	}
	info := h.waitIdle()
	if len(info.Pending) != 0 || !pidAlive(info.Pid) {
		t.Fatalf("after interrupt: %+v", info)
	}
}

// holdWriter pauses the stdin writer and fills its queue so exactly free
// slots stay open. The returned func resumes the writer.
func holdWriter(t *testing.T, s *Session, free int) func() {
	t.Helper()
	s.test.writeHold.Lock()
	s.mu.Lock()
	q := s.proc.stdinQ
	s.mu.Unlock()
	time.Sleep(50 * time.Millisecond) // let the writer park on the hold
	for {
		select {
		case q <- []byte("\n"):
			continue
		default:
		}
		break
	}
	for i := 0; i < free; i++ {
		<-q
	}
	return s.test.writeHold.Unlock
}

func TestInterruptQueueFullKeepsPending(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c := h.attach("", nil)
	h.send("m", "multi")
	h.waitPending(2)
	release := holdWriter(t, h.s, 0)
	if ack := h.s.Interrupt(); ack.OK || ack.Code != protocol.AckChatBusy {
		release()
		t.Fatalf("interrupt with full queue: %+v", ack)
	}
	if info := h.s.Snapshot(); len(info.Pending) != 2 {
		release()
		t.Fatalf("pending changed: %d", len(info.Pending))
	}
	// One free slot is enough for the single interrupt.
	h.s.mu.Lock()
	<-h.s.proc.stdinQ
	h.s.mu.Unlock()
	ack := h.s.Interrupt()
	release()
	if !ack.OK {
		t.Fatalf("interrupt with one free slot: %+v", ack)
	}
	fs := c.waitFor("two interrupted", func(fs []frame) bool { return len(resolved(fs, "")) == 2 && resultCount(fs) == 1 })
	for _, r := range resolved(fs, "") {
		if r.Msg["outcome"] != outcomeInterrupted {
			t.Fatalf("outcome %v", r.Msg)
		}
	}
	if n := len(h.stdin.control("control_request", "interrupt")); n != 1 {
		t.Fatalf("%d interrupts", n)
	}
	if n := len(h.stdin.control("control_response", "")); n != 0 {
		t.Fatalf("daemon wrote %d control_responses (deny)", n)
	}
}

func TestRingOverflowReset(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	h.waitIdle()
	epoch := h.s.Snapshot().Epoch
	h.send("b", "burst 1200")
	h.waitSnap("idle after burst", func(i Info) bool { return i.Status == protocol.ChatStatusIdle && i.Seq > 1200 })
	c := h.attach(epoch, ptr(uint64(0)))
	fs := c.waitFor("sync end", func(fs []frame) bool { return lastState(fs) != nil })
	sync := fs[0].Sync
	if sync == nil || !sync.Reset {
		t.Fatalf("first frame %s, want reset sync", fs[0].Raw)
	}
	// echo + init + status + 1200 assistants + result = 1204 complete messages.
	if sync.Omitted != 204 || sync.Backlog != RingMax {
		t.Fatalf("sync %+v, want omitted 204 backlog %d", sync, RingMax)
	}
	backlog := msgs(fs, "")
	if len(backlog) != RingMax {
		t.Fatalf("backlog %d frames", len(backlog))
	}
	for i := 1; i < len(backlog); i++ {
		if backlog[i].Seq != backlog[i-1].Seq+1 {
			t.Fatalf("backlog seq gap at %d: %d → %d", i, backlog[i-1].Seq, backlog[i].Seq)
		}
	}
}

func TestResyncMidStreamTail(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c1 := h.attach("", nil)
	h.send("s", "slow 60 40")
	fs1 := c1.waitFor("some deltas", func(fs []frame) bool { return len(msgs(fs, "stream_event")) >= 6 })
	c1.cancel()
	<-c1.done
	fs1 = c1.snapshot()
	last := msgs(fs1, "")[len(msgs(fs1, ""))-1].Seq
	time.Sleep(300 * time.Millisecond)
	c2 := h.attach(h.s.Snapshot().Epoch, ptr(last))
	fs2 := c2.waitFor("result", func(fs []frame) bool { return resultCount(fs) == 1 })
	if fs2[0].Sync == nil || fs2[0].Sync.Reset {
		t.Fatalf("want incremental sync, got %s", fs2[0].Raw)
	}
	got := msgs(fs2, "")
	if got[0].Seq != last+1 {
		t.Fatalf("first resent seq %d, want %d", got[0].Seq, last+1)
	}
	for i := 1; i < len(got); i++ {
		if got[i].Seq != got[i-1].Seq+1 {
			t.Fatalf("seq gap %d → %d", got[i-1].Seq, got[i].Seq)
		}
	}
	if len(msgs(fs2, "assistant")) != 1 {
		t.Fatalf("%d complete assistant messages", len(msgs(fs2, "assistant")))
	}
	var deltas int
	for _, f := range msgs(fs2, "stream_event") {
		if ev, _ := f.Msg["event"].(map[string]any); ev["type"] == "content_block_delta" {
			deltas++
		}
	}
	if deltas == 0 {
		t.Fatal("no stream tail deltas resent")
	}
}

// X3 (R12.4): a reply long enough to overflow the stream tail. A client that
// joins mid-reply with a reset sync must still get the reply's message_start
// — its id is what the complete message is merged by. Without it the client
// shows the tail as a second, id-less message next to the complete reply.
func TestTailOverflowKeepsMessageStart(t *testing.T) {
	t.Parallel()
	type streamEvent struct {
		Seq uint64
		Msg struct {
			Type  string `json:"type"`
			Event struct {
				Type    string `json:"type"`
				Message struct {
					ID string `json:"id"`
				} `json:"message"`
				Delta struct {
					Text string `json:"text"`
				} `json:"delta"`
			} `json:"event"`
		} `json:"msg"`
	}
	decode := func(t *testing.T, backlog [][]byte) []streamEvent {
		t.Helper()
		var out []streamEvent
		for _, f := range backlog {
			var e streamEvent
			if err := json.Unmarshal(f, &e); err != nil {
				t.Fatalf("backlog frame %s: %v", f, err)
			}
			if e.Msg.Type == "stream_event" {
				out = append(out, e)
			}
		}
		return out
	}
	// check: the replayed tail starts with the reply's message_start, followed
	// by the newest deltas in order, ending with the last one generated.
	check := func(t *testing.T, evs []streamEvent, lastText string, maxDeltas int) {
		t.Helper()
		if len(evs) == 0 || evs[0].Msg.Event.Type != "message_start" || evs[0].Msg.Event.Message.ID != "long-reply" {
			first := "nothing"
			if len(evs) > 0 {
				first = evs[0].Msg.Event.Type
			}
			t.Fatalf("replayed tail starts with %s, want the message_start of long-reply", first)
		}
		starts, deltas := 0, 0
		for i, e := range evs {
			if i > 0 && e.Seq <= evs[i-1].Seq {
				t.Fatalf("seq not ascending at %d: %d after %d", i, e.Seq, evs[i-1].Seq)
			}
			switch e.Msg.Event.Type {
			case "message_start":
				starts++
			case "content_block_delta":
				deltas++
			}
		}
		if starts != 1 {
			t.Fatalf("%d message_start events in the tail, want 1", starts)
		}
		if deltas == 0 || deltas > maxDeltas {
			t.Fatalf("%d deltas replayed, want 1..%d", deltas, maxDeltas)
		}
		if got := evs[len(evs)-1].Msg.Event.Delta.Text; got != lastText {
			t.Fatalf("last replayed delta %q, want the newest %q", got, lastText)
		}
	}
	const start = `{"type":"stream_event","event":{"type":"message_start","message":{"id":"long-reply"}}}`
	const blockStart = `{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}`
	delta := func(text string) []byte {
		return []byte(`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"` + text + `"}}}`)
	}

	t.Run("count limit", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t).start()
		h.waitIdle()
		h.s.injectLine([]byte(start))
		h.s.injectLine([]byte(blockStart))
		total := TailMax + 50
		for i := 1; i <= total; i++ {
			h.s.injectLine(delta(fmt.Sprintf("d%d ", i)))
		}
		plan, sub := h.s.Subscribe("", nil)
		defer sub.Cancel()
		if !plan.Sync.Reset {
			t.Fatalf("want a reset sync, got %+v", plan.Sync)
		}
		evs := decode(t, plan.Backlog)
		check(t, evs, fmt.Sprintf("d%d ", total), TailMax)

		// A client that saw the start and the first deltas and comes back with
		// its position gets the deltas it can still get, in order.
		since := evs[0].Seq + 10
		inc, sub2 := h.s.Subscribe(h.s.Snapshot().Epoch, &since)
		defer sub2.Cancel()
		if inc.Sync.Reset {
			t.Fatalf("want an incremental sync, got %+v", inc.Sync)
		}
		ievs := decode(t, inc.Backlog)
		if len(ievs) == 0 || ievs[0].Seq <= since || ievs[len(ievs)-1].Msg.Event.Delta.Text != fmt.Sprintf("d%d ", total) {
			t.Fatalf("incremental tail: %d events, first seq %d (since %d)", len(ievs), ievs[0].Seq, since)
		}

		// The reply ends: the tail (start included) is gone, the complete
		// message is what a later sync replays.
		h.s.injectLine([]byte(`{"type":"assistant","message":{"id":"long-reply","content":[{"type":"text","text":"complete"}]}}`))
		h.s.injectLine([]byte(`{"type":"stream_event","event":{"type":"message_stop"}}`))
		after, sub3 := h.s.Subscribe("", nil)
		defer sub3.Cancel()
		if left := decode(t, after.Backlog); len(left) != 0 {
			t.Fatalf("%d stream events replayed after message_stop", len(left))
		}
	})

	t.Run("byte limit", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t).start()
		h.waitIdle()
		h.s.injectLine([]byte(start))
		big := strings.Repeat("x", 1<<20)
		n := TailBytesMax/(1<<20) + 3
		for i := 1; i <= n; i++ {
			h.s.injectLine(delta(big))
		}
		h.s.injectLine(delta("the end"))
		plan, sub := h.s.Subscribe("", nil)
		defer sub.Cancel()
		check(t, decode(t, plan.Backlog), "the end", n)
	})
}

func TestStaleEpochResets(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	h.send("e", "echo x")
	h.waitSnap("result", func(i Info) bool { return i.Status == protocol.ChatStatusIdle && i.Seq > 2 })
	c := h.attach("deadbeef", ptr(uint64(2)))
	fs := c.waitFor("sync", func(fs []frame) bool { return lastState(fs) != nil })
	if !fs[0].Sync.Reset || fs[0].Sync.Epoch != h.s.Snapshot().Epoch {
		t.Fatalf("sync %+v", fs[0].Sync)
	}
	// A position beyond what exists is also not trusted.
	c2 := h.attach(h.s.Snapshot().Epoch, ptr(uint64(1<<40)))
	fs2 := c2.waitFor("sync", func(fs []frame) bool { return lastState(fs) != nil })
	if !fs2[0].Sync.Reset {
		t.Fatalf("future since: %+v", fs2[0].Sync)
	}
}

func TestSubscribeAtomicBacklog(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	h.waitIdle()
	epoch := h.s.Snapshot().Epoch
	h.send("b", "burst 900")
	var cs []*collector
	for i := 0; i < 6; i++ {
		time.Sleep(time.Duration(i) * 7 * time.Millisecond)
		cs = append(cs, h.attach(epoch, ptr(uint64(0))))
	}
	h.waitSnap("idle", func(i Info) bool { return i.Status == protocol.ChatStatusIdle && i.Seq > 900 })
	final := h.s.Snapshot().Seq
	for n, c := range cs {
		fs := c.waitFor("all frames", func(fs []frame) bool {
			m := msgs(fs, "")
			return len(m) > 0 && m[len(m)-1].Seq == final
		})
		m := msgs(fs, "")
		if m[0].Seq != 1 {
			t.Fatalf("subscriber %d starts at %d", n, m[0].Seq)
		}
		for i := 1; i < len(m); i++ {
			if m[i].Seq != m[i-1].Seq+1 {
				t.Fatalf("subscriber %d: seq %d → %d", n, m[i-1].Seq, m[i].Seq)
			}
		}
	}
}

func TestSlowSubscriberDisconnected(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	h.waitIdle()
	epoch := h.s.Snapshot().Epoch
	plan, sub := h.s.Subscribe(epoch, ptr(uint64(0)))
	_ = plan
	h.send("b", "burst 1500")
	h.waitSnap("idle", func(i Info) bool { return i.Status == protocol.ChatStatusIdle && i.Seq > 1500 })
	var got []frame
	for ev := range sub.C { // closed once its buffer overflowed
		if ev.Frame != nil {
			got = append(got, decodeFrame(ev.Frame))
		}
	}
	if len(got) > SubBuffer {
		t.Fatalf("received %d > buffer", len(got))
	}
	m := msgs(got, "")
	last := m[len(m)-1].Seq
	c := h.attach(epoch, ptr(last))
	fs := c.waitFor("sync end", func(fs []frame) bool { return lastState(fs) != nil })
	seen := map[uint64]bool{}
	for _, f := range append(m, msgs(fs, "")...) {
		seen[f.Seq] = true
	}
	final := h.s.Snapshot().Seq
	start := uint64(1)
	if fs[0].Sync.Reset {
		start = msgs(fs, "")[0].Seq
	}
	for s := start; s <= final; s++ {
		if !seen[s] {
			t.Fatalf("seq %d lost (reset=%v)", s, fs[0].Sync.Reset)
		}
	}
}

func TestPendingSurvivesRingEviction(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	h.send("p", "perm touch x")
	id, _ := pendingRequest(t, h.waitPending(1))
	for i := 0; i < 1200; i++ {
		h.s.injectLine([]byte(fmt.Sprintf(`{"type":"assistant","message":{"id":"msg_inj_%d","role":"assistant","content":[{"type":"text","text":"x"}]}}`, i)))
	}
	if info := h.s.Snapshot(); len(info.Pending) != 1 || info.Pending[0].RequestID != id {
		t.Fatalf("pending after eviction: %+v", info.Pending)
	}
	c := h.attach("", nil)
	fs := c.waitFor("sync end", func(fs []frame) bool { return lastState(fs) != nil })
	st := lastState(fs)
	if len(st.Pending) != 1 || st.Pending[0].RequestID != id {
		t.Fatalf("reset sync chat_state pending: %+v", st.Pending)
	}
	if fs[0].Sync.Omitted == 0 {
		t.Fatal("expected evictions")
	}
}

func TestCrashEmitsExitAndEnded(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c := h.attach("", nil)
	h.waitIdle()
	h.s.injectLine([]byte(`{"type":"control_request","request_id":"req-crash","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"x"}}}`))
	h.send("c", "crash 1")
	fs := c.waitFor("ended", hasState(func(s *protocol.ChatStateFrame) bool { return s.Ended != nil }))
	st := lastState(fs)
	if st.Status != protocol.ChatStatusEnded || st.Ended.Reason != protocol.EndReasonExited || st.Ended.Code == nil || *st.Ended.Code != 1 {
		t.Fatalf("ended %+v", st.Ended)
	}
	if !strings.Contains(st.Ended.StderrTail, "fake claude crash line 3") {
		t.Fatalf("stderr tail %q", st.Ended.StderrTail)
	}
	ex := msgs(fs, "vr_exit")
	if len(ex) != 1 || ex[0].Msg["code"] != float64(1) || !strings.Contains(fmt.Sprint(ex[0].Msg["stderrTail"]), "crash line") {
		t.Fatalf("vr_exit %s", lastRaw(ex, 1))
	}
	if r := resolved(fs, "req-crash"); len(r) != 1 || r[0].Msg["outcome"] != outcomeExited {
		t.Fatalf("pending not resolved as exited: %s", lastRaw(r, 2))
	}
	c.waitFor("exit event", func([]frame) bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return len(c.exits) == 1 && c.exits[0] == 1
	})
	if len(st.Pending) != 0 {
		t.Fatalf("pending left: %v", st.Pending)
	}
	ev := waitExitEvents(t, h, 1)
	if ev[0].Reason != protocol.EndReasonExited || !ev[0].Release {
		t.Fatalf("exit event %+v", ev[0])
	}
}

func waitExitEvents(t *testing.T, h *harness, n int) []ExitEvent {
	t.Helper()
	deadline := time.Now().Add(waitTimeout)
	for {
		if ev := h.exitEvents(); len(ev) >= n {
			return ev
		}
		if time.Now().After(deadline) {
			t.Fatalf("timeout waiting for %d exit events", n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestInitVersionTooOldEnds(t *testing.T) {
	t.Parallel()
	for _, v := range []string{"1.0.0", "none"} {
		v := v
		t.Run(v, func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, withEnv("FAKE_CLAUDE_INIT_VERSION="+v)).start()
			c := h.attach("", nil)
			h.send("m", "echo hi")
			fs := c.waitFor("ended", hasState(func(s *protocol.ChatStateFrame) bool { return s.Ended != nil }))
			st := lastState(fs)
			if st.Ended.Reason != protocol.EndReasonVersionUnsupported || st.Ended.MinClaudeVersion != MinClaudeVersion {
				t.Fatalf("ended %+v", st.Ended)
			}
			want := v
			if v == "none" {
				want = ""
			}
			if st.Ended.ClaudeVersion != want {
				t.Fatalf("ended claudeVersion %q want %q", st.Ended.ClaudeVersion, want)
			}
			if len(msgs(fs, "vr_exit")) != 1 {
				t.Fatal("no vr_exit")
			}
		})
	}
}

func TestInitCapabilitiesMissingDegrades(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		env  []string
		want []string
	}{
		{"absent", []string{"FAKE_CLAUDE_CAPS="}, []string{"interrupt_receipt"}},
		{"lifecycle-only", []string{"FAKE_CLAUDE_CAPS=msg_lifecycle_v1"}, []string{"interrupt_receipt"}},
		{"full", nil, nil},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, withEnv(tc.env...)).start()
			c := h.attach("", nil)
			h.send("s", "slow 80 40")
			c.waitFor("streaming", func(fs []frame) bool { return len(msgs(fs, "stream_event")) > 2 })
			st := lastState(c.snapshot())
			if fmt.Sprint(st.Degraded) != fmt.Sprint(tc.want) {
				t.Fatalf("degraded %v want %v", st.Degraded, tc.want)
			}
			if ack := h.s.Interrupt(); !ack.OK {
				t.Fatalf("interrupt %+v", ack)
			}
			c.waitFor("result", func(fs []frame) bool { return resultCount(fs) == 1 })
			info := h.waitIdle()
			if info.Ended != nil || !pidAlive(info.Pid) {
				t.Fatalf("session ended: %+v", info)
			}
			if tc.want == nil {
				for _, f := range c.snapshot() {
					if f.State != nil && bytes.Contains(f.Raw, []byte("degraded")) {
						t.Fatalf("degraded present with full capabilities: %s", f.Raw)
					}
				}
			}
		})
	}
}

func TestSlashCommandsPrecedence(t *testing.T) {
	t.Parallel()
	t.Run("initialize wins", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t).start()
		h.waitSnap("initialize commands", func(i Info) bool { return len(i.SlashCommands) == 3 })
		h.send("e", "echo hi")
		h.waitIdle()
		cmds := h.s.Snapshot().SlashCommands
		if len(cmds) != 3 || cmds[0].Description == "" {
			t.Fatalf("commands %+v, want initialize list with descriptions", cmds)
		}
	})
	t.Run("timeout falls back to init", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, withEnv("FAKE_CLAUDE_NO_INIT_REPLY=1"),
			withSpec(func(s *Spec) { s.Tuning.InitializeWait = 200 * time.Millisecond })).start()
		h.send("e", "echo hi")
		h.waitIdle()
		time.Sleep(300 * time.Millisecond)
		cmds := h.s.Snapshot().SlashCommands
		if len(cmds) != 3 || cmds[0].Description != "" || cmds[0].Name != "compact" {
			t.Fatalf("commands %+v, want init names", cmds)
		}
		// initialize answers late: its list replaces init's.
		h.s.injectLine([]byte(fmt.Sprintf(`{"type":"control_response","response":{"subtype":"success","request_id":%q,"response":{"commands":[{"name":"late","description":"from initialize","argumentHint":""}]}}}`, h.s.initializeID())))
		cmds = h.s.Snapshot().SlashCommands
		if len(cmds) != 1 || cmds[0].Name != "late" {
			t.Fatalf("late initialize not applied: %+v", cmds)
		}
		h.send("e2", "echo again")
		h.waitSnap("second turn", func(i Info) bool { return i.Status == protocol.ChatStatusIdle && len(i.SlashCommands) == 1 })
	})
	t.Run("initialize error uses init", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, withEnv("FAKE_CLAUDE_NO_INIT_REPLY=1")).start()
		if cmds := h.s.Snapshot().SlashCommands; len(cmds) != 0 {
			t.Fatalf("before any source: %+v", cmds)
		}
		h.s.injectLine([]byte(fmt.Sprintf(`{"type":"control_response","response":{"subtype":"error","request_id":%q,"error":"nope"}}`, h.s.initializeID())))
		h.send("e", "echo hi")
		info := h.waitSnap("init commands", func(i Info) bool { return len(i.SlashCommands) == 3 })
		if info.SlashCommands[0].Description != "" {
			t.Fatalf("commands %+v", info.SlashCommands)
		}
	})
}

func TestInitResentEachTurnUpdatesMeta(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c := h.attach("", nil)
	epoch := h.s.Snapshot().Epoch
	h.send("a", "echo one")
	c.waitFor("r1", func(fs []frame) bool { return resultCount(fs) == 1 })
	h.send("b", "echo two")
	fs := c.waitFor("r2", func(fs []frame) bool { return resultCount(fs) == 2 })
	var inits int
	for _, f := range msgs(fs, "system") {
		if f.Msg["subtype"] == "init" {
			inits++
		}
	}
	if inits != 2 {
		t.Fatalf("%d init messages forwarded", inits)
	}
	info := h.s.Snapshot()
	if info.Epoch != epoch || info.ClaudeVersion != "2.1.210" {
		t.Fatalf("epoch/version changed: %+v", info)
	}
	c2 := h.attach(epoch, ptr(uint64(0)))
	fs2 := c2.waitFor("sync", func(fs []frame) bool { return lastState(fs) != nil })
	complete := func(fs []frame) int { return len(msgs(fs, "")) - len(msgs(fs, "stream_event")) }
	if fs2[0].Sync.Reset || complete(fs2) != complete(fs) {
		t.Fatalf("buffer changed by init: reset=%v %d vs %d", fs2[0].Sync.Reset, complete(fs2), complete(fs))
	}
}

func TestHookLinesPassThrough(t *testing.T) {
	t.Parallel()
	h := newHarness(t, withEnv("FAKE_CLAUDE_HOOK_LINES=1")).start()
	c := h.attach("", nil)
	h.send("e", "echo hi")
	fs := c.waitFor("result", func(fs []frame) bool { return resultCount(fs) == 1 })
	var hooks int
	for _, f := range msgs(fs, "system") {
		if strings.HasPrefix(fmt.Sprint(f.Msg["subtype"]), "hook_") {
			hooks++
		}
	}
	if hooks != 2 {
		t.Fatalf("%d hook lines", hooks)
	}
	if info := h.waitIdle(); info.Ended != nil {
		t.Fatalf("%+v", info)
	}
}

func TestNonJSONLinesSkipped(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	withPrelude("echo 'Welcome to the login shell'; echo '[motd]'")(h)
	h.start()
	c := h.attach("", nil)
	h.send("e", "echo hi")
	c.waitFor("result", func(fs []frame) bool { return resultCount(fs) == 1 })
	if n := h.s.Snapshot().NonJSONLines; n != 2 {
		t.Fatalf("non-JSON lines counted %d", n)
	}
}

func TestOversizeLineDropped(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	withPrelude(fmt.Sprintf("head -c %d /dev/zero | tr '\\000' a; echo", MaxLine+1024))(h)
	h.start()
	c := h.attach("", nil)
	fs := c.waitFor("line_dropped", func(fs []frame) bool { return len(notices(fs, NoticeLineDropped)) == 1 })
	_ = fs
	h.send("e", "echo after")
	fs = c.waitFor("result", func(fs []frame) bool { return resultCount(fs) == 1 })
	if !strings.Contains(assistantText(fs), "after") {
		t.Fatal("no reply after dropped line")
	}
}

func TestUnknownControlRequestAnswered(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	withPrelude(`echo '{"type":"control_request","request_id":"hook-1","request":{"subtype":"hook_callback","callback_id":"x"}}'`)(h)
	h.start()
	deadline := time.Now().Add(waitTimeout)
	for {
		var found map[string]any
		for _, m := range h.stdin.control("control_response", "") {
			if r, _ := m["response"].(map[string]any); r["request_id"] == "hook-1" {
				found = r
			}
		}
		if found != nil {
			if found["subtype"] != "error" {
				t.Fatalf("response %v", found)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("unknown control_request not answered")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if info := h.s.Snapshot(); len(info.Pending) != 0 {
		t.Fatalf("pending %+v", info.Pending)
	}
}

func TestDrainWithoutSubscribers(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	h.send("b", "burst 1000 10240") // ~10 MiB with nobody subscribed
	start := time.Now()
	h.waitSnap("idle", func(i Info) bool { return i.Status == protocol.ChatStatusIdle && i.Seq > 1000 })
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("draining took %v", d)
	}
}

func TestOutstandingRecoversAfterStaleTurn(t *testing.T) {
	t.Parallel()
	stale := withSpec(func(s *Spec) { s.Tuning.StaleTurn = 200 * time.Millisecond })
	t.Run("no result", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, stale).start()
		c := h.attach("", nil)
		h.send("w", "swallow")
		fs := c.waitFor("stale_turn", func(fs []frame) bool { return len(notices(fs, NoticeStaleTurn)) == 1 })
		if n := notices(fs, NoticeStaleTurn)[0]; n.Msg["clientMsgId"] != "w" {
			t.Fatalf("notice %v", n.Msg)
		}
		h.waitIdle()
		// Sending works again; this fake turn only ends when interrupted, and
		// its late result must not be paired with the new message.
		h.send("e", "echo still works")
		if ack := h.s.Interrupt(); !ack.OK {
			t.Fatalf("interrupt %+v", ack)
		}
		fs = c.waitFor("reply", func(fs []frame) bool {
			return strings.Contains(assistantText(fs), "still works") && resultCount(fs) == 2
		})
		if r := msgs(fs, "result")[0].Msg; r["vr_stale"] != true {
			t.Fatalf("swallowed turn's result not marked stale: %v", r)
		}
		info := h.waitIdle()
		if info.Outstanding != 0 || info.IgnoreResults != 0 {
			t.Fatalf("%+v", info)
		}
	})
	t.Run("pending does not time out", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, stale).start()
		c := h.attach("", nil)
		h.send("p", "perm touch x")
		h.waitPending(1)
		time.Sleep(700 * time.Millisecond)
		if n := len(notices(c.snapshot(), NoticeStaleTurn)); n != 0 {
			t.Fatalf("stale_turn while waiting for an answer")
		}
		if st := h.s.Snapshot(); st.Status != protocol.ChatStatusWaiting {
			t.Fatalf("status %s", st.Status)
		}
	})
}

func TestLateResultAfterStaleTurn(t *testing.T) {
	t.Parallel()
	h := newHarness(t, withSpec(func(s *Spec) { s.Tuning.StaleTurn = 200 * time.Millisecond })).start()
	c := h.attach("", nil)
	h.send("w", "swallow 900")
	sent := time.Now()
	stop := make(chan struct{})
	go func() { // keep_alive lines are not activity
		for {
			select {
			case <-stop:
				return
			case <-time.After(30 * time.Millisecond):
				h.s.injectLine([]byte(`{"type":"keep_alive"}`))
			}
		}
	}()
	c.waitFor("stale_turn", func(fs []frame) bool { return len(notices(fs, NoticeStaleTurn)) == 1 })
	close(stop)
	if d := time.Since(sent); d > 700*time.Millisecond {
		t.Fatalf("stale_turn after %v despite keep_alive", d)
	}
	fs := c.waitFor("late result", func(fs []frame) bool { return resultCount(fs) == 1 })
	if r := msgs(fs, "result")[0].Msg; r["vr_stale"] != true {
		t.Fatalf("late result not marked: %v", r)
	}
	info := h.waitIdle()
	if info.Outstanding != 0 || info.IgnoreResults != 0 {
		t.Fatalf("outstanding %d ignore %d", info.Outstanding, info.IgnoreResults)
	}
	for _, f := range msgs(fs, "keep_alive") {
		t.Fatalf("keep_alive forwarded: %s", f.Raw)
	}
}

func TestStillQueuedIgnored(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var seen []int
	h := newHarness(t)
	h.spec.test.afterResult = func(outstanding int) {
		mu.Lock()
		seen = append(seen, outstanding)
		mu.Unlock()
	}
	h.start()
	c := h.attach("", nil)
	h.send("1", "slow 60 60")
	c.waitFor("streaming", func(fs []frame) bool { return len(msgs(fs, "stream_event")) > 3 })
	h.send("2", "echo two")
	h.send("3", "echo three")
	if got := h.s.Snapshot().Outstanding; got != 3 {
		t.Fatalf("outstanding %d", got)
	}
	if ack := h.s.Interrupt(); !ack.OK {
		t.Fatalf("%+v", ack)
	}
	fs := c.waitFor("three results", func(fs []frame) bool { return resultCount(fs) == 3 })
	h.waitIdle()
	mu.Lock()
	defer mu.Unlock()
	if fmt.Sprint(seen) != "[2 1 0]" {
		t.Fatalf("outstanding after each result: %v", seen)
	}
	text := assistantText(fs)
	if !strings.Contains(text, "two") || !strings.Contains(text, "three") {
		t.Fatalf("queued messages did not run after the interrupt: %q", text)
	}
}

// --- stopping, restarting, single process ---

func TestStopIsIdempotent(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	h.send("s", "slow 50 100")
	h.waitSnap("running", func(i Info) bool { return i.Status == protocol.ChatStatusRunning })
	var wg sync.WaitGroup
	errs := make(chan error, 3)
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			h.s.WithOp(func(ops OpHandle) { errs <- ops.StopLocked(protocol.EndReasonStopped) })
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(100 * time.Millisecond)
	if ev := h.exitEvents(); len(ev) != 1 || ev[0].Reason != protocol.EndReasonStopped {
		t.Fatalf("exit events %+v", ev)
	}
	if info := h.s.Snapshot(); info.Status != protocol.ChatStatusEnded || info.Ended.Reason != protocol.EndReasonStopped {
		t.Fatalf("%+v", info)
	}
	if p := h.env.LivePids(h.u); len(p) != 0 {
		t.Fatalf("pid files left: %v", p)
	}
}

func TestStopTimings(t *testing.T) {
	t.Parallel()
	h := newHarness(t, withEnv("FAKE_CLAUDE_STUBBORN=1")).start()
	h.send("s", "slow 100 100")
	pid := h.waitSnap("running", func(i Info) bool { return i.Status == protocol.ChatStatusRunning }).Pid
	start := time.Now()
	h.s.WithOp(func(ops OpHandle) { _ = ops.StopLocked(protocol.EndReasonStopped) })
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("stop took %v", d)
	}
	log, _ := os.ReadFile(h.env.SignalLog)
	if !strings.Contains(string(log), "SIGTERM ignored") {
		t.Fatalf("signal log %q: SIGTERM stage not reached", log)
	}
	if pidAlive(pid) {
		t.Fatal("stubborn process still alive")
	}
}

// stopAccounting checks "every written message gets exactly one of result or
// dropped_on_stop" over the frames a subscriber saw.
func stopAccounting(t *testing.T, fs []frame, ids []string) map[string]string {
	t.Helper()
	got := map[string]string{}
	// Results pair FIFO with echoes, like the client does.
	var queue []string
	for _, f := range msgs(fs, "") {
		switch f.Msg["type"] {
		case "user":
			if id, ok := f.Msg["vr_client_msg_id"].(string); ok {
				queue = append(queue, id)
			}
		case "result":
			if f.Msg["vr_stale"] == true || len(queue) == 0 {
				continue
			}
			got[queue[0]] += "result,"
			queue = queue[1:]
		case "vr_notice":
			if f.Msg["code"] == NoticeDroppedOnStop {
				id := fmt.Sprint(f.Msg["clientMsgId"])
				got[id] += "dropped,"
				for i, q := range queue {
					if q == id {
						queue = append(queue[:i], queue[i+1:]...)
						break
					}
				}
			}
		}
	}
	for _, id := range ids {
		if v := got[id]; v != "result," && v != "dropped," {
			t.Fatalf("message %s got %q (all: %v)", id, v, got)
		}
	}
	return got
}

func TestStopAccountsForEveryQueuedMessage(t *testing.T) {
	t.Parallel()
	for _, variant := range []string{"stop", "restart"} {
		variant := variant
		t.Run(variant, func(t *testing.T) {
			t.Parallel()
			h := newHarness(t, withEnv("FAKE_CLAUDE_EXIT_AFTER_RESULT=2"))
			var results atomic.Int32
			var sess atomic.Pointer[Session]
			h.spec.test.beforeLine = func(line []byte) {
				// Hold the first result until the process has written m2's
				// result and exited: everything left is already in the pipe.
				if bytes.Contains(line, []byte(`"type":"result"`)) && results.Add(1) == 1 {
					<-sess.Load().procWaitDone()
				}
			}
			h.start()
			sess.Store(h.s)
			oldEpoch := h.s.Snapshot().Epoch
			c := h.attach("", nil)
			h.send("m1", "slow 50 200")
			c.waitFor("streaming", func(fs []frame) bool { return len(msgs(fs, "stream_event")) > 3 })
			h.send("m2", "echo q2")
			h.send("m3", "echo q3")
			start := time.Now()
			var opErr error
			h.s.WithOp(func(ops OpHandle) {
				if variant == "stop" {
					opErr = ops.StopLocked(protocol.EndReasonStopped)
				} else {
					opErr = ops.RestartLocked()
				}
			})
			if opErr != nil {
				t.Fatal(opErr)
			}
			if d := time.Since(start); d > 4*time.Second {
				t.Fatalf("%s took %v", variant, d)
			}
			var fs []frame
			if variant == "stop" {
				fs = c.waitFor("dropped", func(fs []frame) bool { return len(notices(fs, NoticeDroppedOnStop)) == 1 })
			} else {
				fs = c.waitFor("new epoch idle", func(fs []frame) bool {
					st := lastState(fs)
					return st != nil && st.Status == protocol.ChatStatusIdle && len(notices(fs, NoticeDroppedOnStop)) == 1
				})
			}
			got := stopAccounting(t, fs, []string{"m1", "m2", "m3"})
			if got["m1"] != "result," || got["m2"] != "result," || got["m3"] != "dropped," {
				t.Fatalf("accounting %v", got)
			}
			if variant == "restart" {
				info := h.s.Snapshot()
				if info.Epoch == oldEpoch || info.Status != protocol.ChatStatusIdle {
					t.Fatalf("after restart %+v", info)
				}
				// The new epoch's buffer holds nothing from the old process.
				c2 := h.attach(info.Epoch, ptr(uint64(0)))
				fs2 := c2.waitFor("sync", func(fs []frame) bool { return lastState(fs) != nil })
				if n := len(msgs(fs2, "")); n != 0 {
					t.Fatalf("new epoch buffer has %d old frames: %s", n, lastRaw(msgs(fs2, ""), 3))
				}
				if st := lastState(fs2); len(st.Pending) != 0 || st.Ended != nil {
					t.Fatalf("new epoch state %+v", st)
				}
			}
		})
	}
	t.Run("stubborn", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t, withEnv("FAKE_CLAUDE_STUBBORN=1")).start()
		c := h.attach("", nil)
		h.send("m1", "slow 50 200")
		c.waitFor("streaming", func(fs []frame) bool { return len(msgs(fs, "stream_event")) > 3 })
		h.send("m2", "echo q2")
		h.send("m3", "echo q3")
		pid := h.s.Snapshot().Pid
		h.s.WithOp(func(ops OpHandle) { _ = ops.StopLocked(protocol.EndReasonStopped) })
		fs := c.waitFor("dropped", func(fs []frame) bool { return len(notices(fs, NoticeDroppedOnStop)) == 3 })
		stopAccounting(t, fs, []string{"m1", "m2", "m3"})
		log, _ := os.ReadFile(h.env.SignalLog)
		if !strings.Contains(string(log), "SIGTERM ignored") || pidAlive(pid) {
			t.Fatalf("stubborn not killed: log %q alive %v", log, pidAlive(pid))
		}
	})
}

func TestReaderJoinBeforeSettle(t *testing.T) {
	t.Parallel()
	var orderMu sync.Mutex
	var order []string
	note := func(s string) {
		orderMu.Lock()
		order = append(order, s)
		orderMu.Unlock()
	}
	h := newHarness(t, withEnv("FAKE_CLAUDE_EXIT_AFTER_RESULT=1"))
	h.spec.test.beforeLine = func(line []byte) { time.Sleep(200 * time.Microsecond) }
	h.spec.test.readerExit = func() { note("reader-exit") }
	h.spec.test.settle = func() { note("settle") }
	h.start()
	c := h.attach("", nil)
	h.send("b", "burst 2000")
	h.send("x", "echo never")
	time.Sleep(50 * time.Millisecond)
	h.s.WithOp(func(ops OpHandle) { _ = ops.StopLocked(protocol.EndReasonStopped) })
	fs := c.waitFor("dropped", func(fs []frame) bool { return len(notices(fs, NoticeDroppedOnStop)) == 1 })
	var bursts, droppedAt int
	for i, f := range msgs(fs, "") {
		if f.Msg["type"] == "assistant" {
			bursts++
		}
		if f.Msg["type"] == "vr_notice" {
			droppedAt = i
			if bursts != 2000 {
				t.Fatalf("dropped_on_stop after only %d of 2000 lines", bursts)
			}
		}
	}
	if droppedAt == 0 {
		t.Fatal("no dropped notice")
	}
	orderMu.Lock()
	defer orderMu.Unlock()
	if fmt.Sprint(order) != "[reader-exit settle]" {
		t.Fatalf("order %v", order)
	}
}

func TestExitCallbackNoSessionLock(t *testing.T) {
	t.Parallel()
	var cbGoroutine, stopGoroutine string
	var lockFree atomic.Bool
	var calls atomic.Int32
	h := newHarness(t)
	h.spec.Hooks.OnExit = func(ev ExitEvent) {
		calls.Add(1)
		cbGoroutine = goid()
		if ev.Session.mu.TryLock() {
			lockFree.Store(true)
			ev.Session.mu.Unlock()
		}
	}
	h.start()
	h.s.WithOp(func(ops OpHandle) {
		stopGoroutine = goid()
		_ = ops.StopLocked(protocol.EndReasonStopped)
	})
	if calls.Load() != 1 {
		t.Fatalf("callback ran %d times before StopLocked returned", calls.Load())
	}
	if !lockFree.Load() {
		t.Fatal("Session.mu was held during the exit callback")
	}
	if cbGoroutine == stopGoroutine {
		t.Fatal("exit callback ran on the stopping goroutine")
	}
	// A real exit runs the callback on its own goroutine too.
	h2 := newHarness(t)
	done := make(chan bool, 1)
	h2.spec.Hooks.OnExit = func(ev ExitEvent) {
		ok := ev.Session.mu.TryLock()
		if ok {
			ev.Session.mu.Unlock()
		}
		done <- ok
	}
	h2.start()
	h2.send("c", "crash 2")
	select {
	case ok := <-done:
		if !ok {
			t.Fatal("Session.mu held during real-exit callback")
		}
	case <-time.After(waitTimeout):
		t.Fatal("no exit callback")
	}
}

// owners is a test stand-in for the Manager's claudeOwners table.
type owners struct {
	mu sync.Mutex
	m  map[string]string
}

func (o *owners) claim(u, owner string) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if cur, ok := o.m[u]; ok && cur != owner {
		return fmt.Errorf("busy: %s", cur)
	}
	o.m[u] = owner
	return nil
}

func (o *owners) get(u string) string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.m[u]
}

func TestSingleProcessRestart(t *testing.T) {
	t.Parallel()
	own := &owners{m: map[string]string{}}
	h := newHarness(t)
	h.spec.Hooks.Claim = func(u string) error { return own.claim(u, "C") }
	h.spec.Hooks.OnExit = func(ev ExitEvent) {
		if ev.Release {
			own.mu.Lock()
			if own.m[ev.ClaudeSessionID] == "C" {
				delete(own.m, ev.ClaudeSessionID)
			}
			own.mu.Unlock()
		}
	}
	if err := own.claim(h.u, "C"); err != nil {
		t.Fatal(err)
	}
	h.start()
	h.send("e", "echo first") // write a transcript so restarts --resume
	h.waitIdle()
	stop := make(chan struct{})
	var wrongOwner atomic.Value
	var contenders sync.WaitGroup
	contenders.Add(1)
	go func() { // a concurrent "-c" create for the same conversation
		defer contenders.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			if err := own.claim(h.u, "X"); err == nil {
				wrongOwner.Store("X claimed U during a restart")
			}
			if o := own.get(h.u); o != "C" {
				wrongOwner.Store("owner was " + o)
			}
			time.Sleep(time.Millisecond)
		}
	}()
	epochs := map[string]bool{h.s.Snapshot().Epoch: true}
	for i := 0; i < 5; i++ {
		var err error
		h.s.WithOp(func(ops OpHandle) { err = ops.RestartLocked() })
		if err != nil {
			t.Fatalf("restart %d: %v", i, err)
		}
		info := h.waitIdle()
		if epochs[info.Epoch] {
			t.Fatalf("epoch %s reused", info.Epoch)
		}
		epochs[info.Epoch] = true
		if n := len(h.env.LivePids(h.u)); n != 1 {
			t.Fatalf("restart %d: %d live pid files", i, n)
		}
	}
	close(stop)
	contenders.Wait()
	if v := wrongOwner.Load(); v != nil {
		t.Fatal(v)
	}
	if v := h.env.Violation(); v != "" {
		t.Fatal(v)
	}
}

// nthArgv returns the argv of the n-th fake claude launch (1-based).
func nthArgv(t *testing.T, h *harness, n int) []string {
	t.Helper()
	deadline := time.Now().Add(waitTimeout)
	var lines []string
	for {
		data, _ := os.ReadFile(h.env.ArgvLog)
		lines = strings.Split(strings.TrimSpace(string(data)), "\n")
		if len(data) > 0 && len(lines) >= n {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("fake claude launched %d times, want %d", len(lines), n)
		}
		time.Sleep(5 * time.Millisecond)
	}
	var argv []string
	if err := json.Unmarshal([]byte(lines[n-1]), &argv); err != nil {
		t.Fatal(err)
	}
	return argv
}

func argvHas(argv []string, flag, value string) bool {
	for i := 0; i+1 < len(argv); i++ {
		if argv[i] == flag && argv[i+1] == value {
			return true
		}
	}
	return false
}

func TestRestartWithoutTranscriptUsesSessionID(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	h.waitIdle()
	if a := nthArgv(t, h, 1); !argvHas(a, "--session-id", h.u) {
		t.Fatalf("first start argv %v", a)
	}
	var err error
	h.s.WithOp(func(ops OpHandle) { err = ops.RestartLocked() })
	if err != nil {
		t.Fatal(err)
	}
	if a := nthArgv(t, h, 2); !argvHas(a, "--session-id", h.u) || argvHas(a, "--resume", h.u) {
		t.Fatalf("restart without transcript argv %v", a)
	}
	h.send("e", "echo write transcript")
	h.waitSnap("idle", func(i Info) bool { return i.Status == protocol.ChatStatusIdle && i.Seq > 3 })
	h.s.WithOp(func(ops OpHandle) { err = ops.RestartLocked() })
	if err != nil {
		t.Fatal(err)
	}
	if a := nthArgv(t, h, 3); !argvHas(a, "--resume", h.u) {
		t.Fatalf("restart with transcript argv %v", a)
	}
}

func TestResumeMissingTranscriptFails(t *testing.T) {
	t.Parallel()
	t.Run("restart", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t)
		var armed atomic.Bool
		h.spec.test.afterFind = func(path string) {
			if armed.Load() && path != "" {
				os.Remove(path)
			}
		}
		h.start()
		c := h.attach("", nil)
		h.send("e", "echo hi")
		h.waitIdle()
		armed.Store(true)
		var err error
		h.s.WithOp(func(ops OpHandle) { err = ops.RestartLocked() })
		if err == nil {
			t.Fatal("restart succeeded without a transcript")
		}
		want := "No conversation found with session ID: " + h.u
		info := h.s.Snapshot()
		if info.Ended == nil || info.Ended.Reason != protocol.EndReasonRestartFailed || info.Ended.Message != want {
			t.Fatalf("ended %+v", info.Ended)
		}
		c.waitFor("restart_failed state", hasState(func(s *protocol.ChatStateFrame) bool {
			return s.Ended != nil && s.Ended.Reason == protocol.EndReasonRestartFailed
		}))
		if ev := waitExitEvents(t, h, 2); !ev[len(ev)-1].Release {
			t.Fatalf("failed restart keeps the claim: %+v", ev)
		}
	})
	t.Run("create", func(t *testing.T) {
		t.Parallel()
		h := newHarness(t)
		// A transcript exists when the session is set up …
		first := h.start()
		first.send("e", "echo hi")
		first.waitIdle()
		first.s.WithOp(func(ops OpHandle) { _ = ops.StopLocked(protocol.EndReasonStopped) })
		// … and is gone right after the daemon looked for it.
		spec := h.spec
		spec.test = &testHooks{afterFind: func(path string) {
			if path != "" {
				os.Remove(path)
			}
		}}
		_, err := Start(spec)
		if err == nil || !strings.Contains(err.Error(), "No conversation found with session ID: "+h.u) {
			t.Fatalf("Start err = %v", err)
		}
	})
}

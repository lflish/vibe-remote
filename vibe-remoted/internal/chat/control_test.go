package chat

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

func allow(input any) json.RawMessage {
	return raw(map[string]any{"behavior": "allow", "updatedInput": input})
}

func deny(msg string) json.RawMessage {
	return raw(map[string]any{"behavior": "deny", "message": msg})
}

func (h *harness) respond(id string, resp json.RawMessage, setMode string) {
	h.t.Helper()
	if ack := h.s.Respond(id, resp, setMode); !ack.OK {
		h.t.Fatalf("Respond: %+v", ack)
	}
}

func (h *harness) toolName(info Info) string {
	_, req := pendingRequest(h.t, info)
	return req["tool_name"].(string)
}

func TestBypassLocksMode(t *testing.T) {
	t.Parallel()
	h := newHarness(t, withArgs("--dangerously-skip-permissions"),
		withSpec(func(s *Spec) { s.Lock = true; s.PermissionMode = "bypassPermissions" })).start()
	c := h.attach("", nil)
	st := lastState(c.snapshot())
	if !st.PermissionLocked || st.PermissionMode != "bypassPermissions" {
		t.Fatalf("state %+v", st)
	}
	if ack := h.s.SetMode("plan"); ack.OK || ack.Code != protocol.AckModeLocked {
		t.Fatalf("set_mode ack %+v", ack)
	}
	for i, tool := range []string{"Bash", "Edit", "Write"} {
		h.send(tool, "tool "+tool)
		fs := c.waitFor("result", func(fs []frame) bool { return resultCount(fs) == i+1 })
		if n := len(msgs(fs, "control_request")); n != 0 {
			t.Fatalf("%s asked for permission under bypass", tool)
		}
	}
	if !strings.Contains(assistantText(c.snapshot()), "done Write") {
		t.Fatal("tools did not run")
	}
	if n := len(h.stdin.control("control_request", "set_permission_mode")); n != 0 {
		t.Fatal("locked mode was sent to claude")
	}
}

func TestBypassStillAsksQuestions(t *testing.T) {
	t.Parallel()
	h := newHarness(t, withArgs("--dangerously-skip-permissions"),
		withSpec(func(s *Spec) { s.Lock = true; s.PermissionMode = "bypassPermissions" })).start()
	c := h.attach("", nil)
	h.send("a", "ask")
	info := h.waitPending(1)
	if h.toolName(info) != "AskUserQuestion" {
		t.Fatalf("pending %v", info.Pending)
	}
	id, req := pendingRequest(t, info)
	in := req["input"].(map[string]any)
	in["answers"] = map[string]any{"Pick a fruit": "Apple", "Pick colors": "Red"}
	h.respond(id, allow(in), "")
	c.waitFor("ask result", func(fs []frame) bool { return resultCount(fs) == 1 })
	h.send("p", "plan")
	info = h.waitPending(1)
	if h.toolName(info) != "ExitPlanMode" {
		t.Fatalf("pending %v", info.Pending)
	}
	id, req = pendingRequest(t, info)
	h.respond(id, allow(req["input"]), "")
	c.waitFor("plan result", func(fs []frame) bool { return resultCount(fs) == 2 })
	h.send("x", "perm touch x")
	fs := c.waitFor("perm result", func(fs []frame) bool { return resultCount(fs) == 3 })
	if n := len(msgs(fs, "control_request")); n != 2 {
		t.Fatalf("%d permission requests, want 2 (ask, plan)", n)
	}
}

func TestRespondAllowOnce(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c := h.attach("", nil)
	h.send("1", "perm touch x")
	id, req := pendingRequest(t, h.waitPending(1))
	h.respond(id, allow(req["input"]), "")
	fs := c.waitFor("result", func(fs []frame) bool { return resultCount(fs) == 1 })
	if !strings.Contains(assistantText(fs), "done Bash") {
		t.Fatal("tool did not run")
	}
	if r := resolved(fs, id); len(r) != 1 || r[0].Msg["outcome"] != outcomeAllowed {
		t.Fatalf("resolved %s", lastRaw(r, 2))
	}
	h.send("2", "perm touch x")
	h.waitPending(1) // asked again: allow once is not a rule
}

func TestRespondAlwaysWithSuggestion(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c := h.attach("", nil)
	h.send("1", "perm npm test suggest")
	id, req := pendingRequest(t, h.waitPending(1))
	var keep []any
	for _, s := range req["permission_suggestions"].([]any) {
		if typ := s.(map[string]any)["type"]; typ == "addRules" || typ == "addDirectories" {
			keep = append(keep, s)
		}
	}
	resp := raw(map[string]any{"behavior": "allow", "updatedInput": req["input"], "updatedPermissions": keep})
	h.respond(id, resp, "")
	c.waitFor("result", func(fs []frame) bool { return resultCount(fs) == 1 })
	h.send("2", "perm npm test suggest")
	fs := c.waitFor("second result", func(fs []frame) bool { return resultCount(fs) == 2 })
	if n := len(msgs(fs, "control_request")); n != 1 {
		t.Fatalf("asked %d times; the rule should stop the second ask", n)
	}
	if _, err := os.Stat(filepath.Join(h.dir, ".claude")); !os.IsNotExist(err) {
		t.Fatalf("daemon wrote settings into the workdir: %v", err)
	}
	if mode := h.s.Snapshot().PermissionMode; mode != "default" {
		t.Fatalf("mode changed to %s", mode)
	}
}

func TestRespondDenyWithMessage(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c := h.attach("", nil)
	h.send("1", "perm rm a.txt")
	id, _ := pendingRequest(t, h.waitPending(1))
	h.respond(id, deny("先别改这个文件"), "")
	fs := c.waitFor("result", func(fs []frame) bool { return resultCount(fs) == 1 })
	if !strings.Contains(assistantText(fs), "denied: 先别改这个文件") {
		t.Fatalf("reply %q", assistantText(fs))
	}
	if r := resolved(fs, id); len(r) != 1 || r[0].Msg["outcome"] != outcomeDenied {
		t.Fatalf("resolved %s", lastRaw(r, 2))
	}
}

func TestPendingWaitsWithoutClient(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	h.send("1", "perm touch x")
	id, _ := pendingRequest(t, h.waitPending(1))
	time.Sleep(2 * time.Second)
	info := h.s.Snapshot()
	if len(info.Pending) != 1 || info.Pending[0].RequestID != id || info.Status != protocol.ChatStatusWaiting || !pidAlive(info.Pid) {
		t.Fatalf("after 2s: %+v", info)
	}
	if n := len(h.stdin.control("control_response", "")); n != 0 {
		t.Fatal("request was answered automatically")
	}
}

func TestRespondFirstWins(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	h.send("1", "perm touch x")
	id, req := pendingRequest(t, h.waitPending(1))
	h.respond(id, allow(req["input"]), "")
	if ack := h.s.Respond(id, deny("late"), ""); ack.OK || ack.Code != protocol.AckRequestNotPending {
		t.Fatalf("second answer %+v", ack)
	}
	h.waitIdle()
	var n int
	for _, m := range h.stdin.control("control_response", "") {
		if m["response"].(map[string]any)["request_id"] == id {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("%d control_responses for %s", n, id)
	}
}

func TestCancelRequestResolves(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c := h.attach("", nil)
	h.send("1", "cancel")
	id, req := pendingRequest(t, h.waitPending(1))
	fs := c.waitFor("cancelled", func(fs []frame) bool { return len(resolved(fs, id)) == 1 })
	if r := resolved(fs, id)[0]; r.Msg["outcome"] != outcomeCancelled {
		t.Fatalf("outcome %v", r.Msg)
	}
	if info := h.s.Snapshot(); len(info.Pending) != 0 {
		t.Fatalf("pending %+v", info.Pending)
	}
	if ack := h.s.Respond(id, allow(req["input"]), ""); ack.OK || ack.Code != protocol.AckRequestNotPending {
		t.Fatalf("answer after cancel %+v", ack)
	}
}

// stdinAfter returns the stdin message right after the control_response for
// id, waiting for the writer to get that far.
func stdinAfter(t *testing.T, h *harness, id string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(waitTimeout)
	for {
		ms := h.stdin.messages()
		for i, m := range ms {
			if m["type"] == "control_response" && m["response"].(map[string]any)["request_id"] == id && i+1 < len(ms) {
				return ms[i+1]
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("nothing written after the control_response for %s", id)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func modeOf(m map[string]any) string {
	if m == nil || m["type"] != "control_request" {
		return ""
	}
	req := m["request"].(map[string]any)
	if req["subtype"] != "set_permission_mode" {
		return ""
	}
	return req["mode"].(string)
}

func TestPlanApproveSetsMode(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	h.send("1", "plan")
	id, req := pendingRequest(t, h.waitPending(1))
	h.respond(id, allow(req["input"]), "acceptEdits")
	if next := stdinAfter(t, h, id); modeOf(next) != "acceptEdits" {
		t.Fatalf("after control_response: %v", next)
	}
	h.waitSnap("acceptEdits", func(i Info) bool { return i.Status == protocol.ChatStatusIdle && i.PermissionMode == "acceptEdits" })
	h.send("2", "tool Write")
	h.waitSnap("write done", func(i Info) bool { return i.Status == protocol.ChatStatusIdle && i.Seq > 30 })
	if n := len(h.stdin.control("control_response", "")); n != 1 {
		t.Fatalf("Write asked for permission under acceptEdits (%d responses)", n)
	}
	if mode := h.s.Snapshot().PermissionMode; mode != "acceptEdits" {
		t.Fatalf("final mode %s", mode)
	}
	if ack := h.s.Respond("nope", allow(map[string]any{}), "plan"); ack.OK || ack.Code != protocol.AckRequestNotPending {
		t.Fatalf("%+v", ack)
	}
}

func TestPlanApproveManual(t *testing.T) {
	t.Parallel()
	for _, from := range []string{"acceptEdits", "default"} {
		from := from
		t.Run("from "+from, func(t *testing.T) {
			t.Parallel()
			h := newHarness(t).start()
			if from != "default" {
				if ack := h.s.SetMode(from); !ack.OK {
					t.Fatalf("%+v", ack)
				}
				h.waitSnap(from, func(i Info) bool { return i.PermissionMode == from })
			}
			h.send("1", "plan")
			id, req := pendingRequest(t, h.waitPending(1))
			h.respond(id, allow(req["input"]), "default")
			if next := stdinAfter(t, h, id); modeOf(next) != "default" {
				t.Fatalf("after control_response: %v", next)
			}
			h.waitSnap("default", func(i Info) bool { return i.Status == protocol.ChatStatusIdle && i.PermissionMode == "default" })
			h.send("2", "tool Write")
			info := h.waitPending(1)
			if h.toolName(info) != "Write" {
				t.Fatalf("pending %v", info.Pending)
			}
		})
	}
}

func TestPlanReviseStaysPlan(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c := h.attach("", nil)
	if ack := h.s.SetMode("plan"); !ack.OK {
		t.Fatalf("%+v", ack)
	}
	h.waitSnap("plan", func(i Info) bool { return i.PermissionMode == "plan" })
	h.send("1", "plan")
	id, _ := pendingRequest(t, h.waitPending(1))
	modesBefore := len(h.stdin.control("control_request", "set_permission_mode"))
	h.respond(id, deny("more detail please"), "")
	fs := c.waitFor("second plan", func(fs []frame) bool {
		st := lastState(fs)
		return st != nil && len(st.Pending) == 1 && st.Pending[0].RequestID != id
	})
	if !strings.Contains(assistantText(fs), "revising: more detail please") {
		t.Fatalf("reply %q", assistantText(fs))
	}
	if n := len(h.stdin.control("control_request", "set_permission_mode")); n != modesBefore {
		t.Fatal("revising sent a mode switch")
	}
	if mode := h.s.Snapshot().PermissionMode; mode != "plan" {
		t.Fatalf("mode %s", mode)
	}
}

func TestAskAnswersRoundTrip(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c := h.attach("", nil)
	h.send("1", "ask")
	id, req := pendingRequest(t, h.waitPending(1))
	in := req["input"].(map[string]any)
	in["answers"] = map[string]any{"Pick a fruit": "Apple", "Pick colors": "Red, Blue", "x": "Purple with green stripes"}
	h.respond(id, allow(in), "")
	fs := c.waitFor("result", func(fs []frame) bool { return resultCount(fs) == 1 })
	text := assistantText(fs)
	for _, want := range []string{`"Pick a fruit"="Apple"`, `"Pick colors"="Red, Blue"`, `"x"="Purple with green stripes"`} {
		if !strings.Contains(text, want) {
			t.Fatalf("reply %q lacks %s", text, want)
		}
	}
}

func TestSetModeUpdatesState(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c := h.attach("", nil)
	if ack := h.s.SetMode("bypassPermissions"); ack.OK || ack.Code != protocol.AckInvalidMode {
		t.Fatalf("%+v", ack)
	}
	if ack := h.s.SetMode("acceptEdits"); !ack.OK {
		t.Fatalf("%+v", ack)
	}
	c.waitFor("acceptEdits broadcast", hasState(func(s *protocol.ChatStateFrame) bool { return s.PermissionMode == "acceptEdits" }))
}

func TestRespondQueueFullKeepsPending(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c := h.attach("", nil)
	h.send("1", "perm touch x")
	id, req := pendingRequest(t, h.waitPending(1))
	release := holdWriter(t, h.s, 0)
	ack := h.s.Respond(id, allow(req["input"]), "")
	info := h.s.Snapshot()
	release()
	if ack.OK || ack.Code != protocol.AckChatBusy {
		t.Fatalf("ack %+v", ack)
	}
	if len(info.Pending) != 1 {
		t.Fatalf("pending dropped while not sent: %+v", info.Pending)
	}
	if n := len(resolved(c.snapshot(), id)); n != 0 {
		t.Fatal("vr_resolved without the answer being queued")
	}
	h.waitSnap("queue drained", func(Info) bool {
		h.s.mu.Lock()
		defer h.s.mu.Unlock()
		return h.s.proc != nil && len(h.s.proc.stdinQ) == 0
	})
	h.respond(id, allow(req["input"]), "")
	c.waitFor("result", func(fs []frame) bool { return resultCount(fs) == 1 && len(resolved(fs, id)) == 1 })
}

func TestPlanSetModeQueueFull(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c := h.attach("", nil)
	h.send("1", "plan")
	id, req := pendingRequest(t, h.waitPending(1))
	release := holdWriter(t, h.s, 1)
	ack := h.s.Respond(id, allow(req["input"]), "acceptEdits")
	release()
	if !ack.OK {
		t.Fatalf("ack %+v", ack)
	}
	fs := c.waitFor("set_mode_failed", func(fs []frame) bool { return len(notices(fs, NoticeSetModeFailed)) == 1 })
	if len(resolved(fs, id)) != 1 {
		t.Fatal("answer not resolved")
	}
	h.waitSnap("done", func(i Info) bool { return i.Status == protocol.ChatStatusIdle && i.PermissionMode == "default" })
	if n := len(h.stdin.control("control_request", "set_permission_mode")); n != 0 {
		t.Fatal("set_permission_mode reached claude")
	}
}

func TestRespondVsCancelRace(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c := h.attach("", nil)
	for i := 0; i < 8; i++ {
		h.send(string(rune('a'+i)), "cancel")
		id, req := pendingRequest(t, h.waitPending(1))
		time.Sleep(time.Duration(185+i*4) * time.Millisecond)
		ack := h.s.Respond(id, allow(req["input"]), "")
		fs := c.waitFor("turn end", func(fs []frame) bool { return resultCount(fs) == i+1 })
		r := resolved(fs, id)
		if len(r) != 1 {
			t.Fatalf("round %d: %d vr_resolved", i, len(r))
		}
		switch r[0].Msg["outcome"] {
		case outcomeAllowed:
			if !ack.OK {
				t.Fatalf("round %d: allowed but ack %+v", i, ack)
			}
		case outcomeCancelled:
			if ack.OK || ack.Code != protocol.AckRequestNotPending {
				t.Fatalf("round %d: cancelled but ack %+v", i, ack)
			}
		default:
			t.Fatalf("outcome %v", r[0].Msg)
		}
		h.waitIdle()
	}
}

func TestMultiplePending(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c := h.attach("", nil)
	h.send("1", "multi")
	info := h.waitPending(2)
	var ids []string
	var reqs []map[string]any
	for _, p := range info.Pending {
		var req map[string]any
		_ = json.Unmarshal(p.Request, &req)
		ids = append(ids, p.RequestID)
		reqs = append(reqs, req)
	}
	h.respond(ids[1], allow(reqs[1]["input"]), "")
	if got := h.s.Snapshot().Pending; len(got) != 1 || got[0].RequestID != ids[0] {
		t.Fatalf("after first answer: %+v", got)
	}
	h.respond(ids[0], deny("no"), "")
	fs := c.waitFor("result", func(fs []frame) bool { return resultCount(fs) == 1 })
	if !strings.Contains(assistantText(fs), "multi done") {
		t.Fatalf("reply %q", assistantText(fs))
	}
}

func TestRespondRejectsForeignRule(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	h.send("1", "perm npm test suggest")
	id, req := pendingRequest(t, h.waitPending(1))
	foreign := []any{map[string]any{"type": "addRules", "rules": []any{map[string]any{"toolName": "Bash", "ruleContent": "rm -rf /"}},
		"behavior": "allow", "destination": "localSettings"}}
	resp := raw(map[string]any{"behavior": "allow", "updatedInput": req["input"], "updatedPermissions": foreign})
	if ack := h.s.Respond(id, resp, ""); ack.OK || ack.Code != protocol.AckForeignRule {
		t.Fatalf("ack %+v", ack)
	}
	time.Sleep(100 * time.Millisecond)
	if n := len(h.stdin.control("control_response", "")); n != 0 {
		t.Fatal("foreign rule written to stdin")
	}
	if len(h.s.Snapshot().Pending) != 1 {
		t.Fatal("pending dropped")
	}
}

func TestRespondFillsUpdatedInput(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	c := h.attach("", nil)
	h.send("1", "perm touch x")
	id, req := pendingRequest(t, h.waitPending(1))
	h.respond(id, raw(map[string]any{"behavior": "allow"}), "")
	fs := c.waitFor("result", func(fs []frame) bool { return resultCount(fs) == 1 })
	if !strings.Contains(assistantText(fs), "done Bash") {
		t.Fatalf("reply %q", assistantText(fs))
	}
	var sent map[string]any
	for _, m := range h.stdin.control("control_response", "") {
		sent = m["response"].(map[string]any)["response"].(map[string]any)
	}
	if got, _ := json.Marshal(sent["updatedInput"]); string(got) != string(raw(req["input"])) {
		t.Fatalf("updatedInput %s, want %s", got, raw(req["input"]))
	}
	if info := h.s.Snapshot(); info.Ended != nil {
		t.Fatalf("ended %+v", info.Ended)
	}
}

func TestRespondRejectsBadInput(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	h.send("1", "plan")
	id, req := pendingRequest(t, h.waitPending(1))
	if ack := h.s.Respond(id, allow(req["input"]), "plan"); ack.OK || ack.Code != protocol.AckInvalidMode {
		t.Fatalf("setMode plan: %+v", ack)
	}
	if ack := h.s.Respond(id, raw(map[string]any{"behavior": "maybe"}), ""); ack.OK {
		t.Fatalf("unknown behavior accepted: %+v", ack)
	}
	if len(h.s.Snapshot().Pending) != 1 {
		t.Fatal("pending dropped by a rejected answer")
	}
}

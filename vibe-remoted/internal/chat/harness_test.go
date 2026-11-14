package chat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat/chattest"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// waitTimeout bounds every wait in these tests; generous for -race -count=3.
const waitTimeout = 15 * time.Second

// harness runs one chat Session against the fake claude.
type harness struct {
	t     *testing.T
	env   *chattest.Env
	dir   string // workdir
	exe   string
	u     string // claude session id
	spec  Spec
	s     *Session
	stdin *lineLog

	exitMu sync.Mutex
	exits  []ExitEvent
}

type harnessOpt func(*harness)

func withEnv(kv ...string) harnessOpt {
	return func(h *harness) { h.env.Extra = append(h.env.Extra, kv...) }
}

func withArgs(args ...string) harnessOpt {
	return func(h *harness) { h.spec.Args = append(h.spec.Args, args...) }
}

func withSpec(fn func(*Spec)) harnessOpt { return func(h *harness) { fn(&h.spec) } }

// withPrelude replaces the executable with a shell wrapper named claude that
// runs script first and then execs the fake claude (login-shell noise, odd
// stdout lines before claude starts).
func withPrelude(script string) harnessOpt {
	return func(h *harness) {
		dir := filepath.Join(h.t.TempDir(), "wrap")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			h.t.Fatal(err)
		}
		wrapper := filepath.Join(dir, "claude")
		body := "#!/bin/sh\n" + script + "\nexec '" + h.exe + "' \"$@\"\n"
		if err := os.WriteFile(wrapper, []byte(body), 0o755); err != nil {
			h.t.Fatal(err)
		}
		h.spec.Exe = wrapper
	}
}

// lineLog records what the daemon wrote to claude's stdin.
type lineLog struct {
	mu    sync.Mutex
	lines [][]byte
}

func (l *lineLog) add(b []byte) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, append([]byte(nil), b...))
}

// messages returns the non-blank lines parsed as JSON objects.
func (l *lineLog) messages() []map[string]any {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []map[string]any
	for _, b := range l.lines {
		if len(bytes.TrimSpace(b)) == 0 {
			continue
		}
		var m map[string]any
		if json.Unmarshal(b, &m) == nil {
			out = append(out, m)
		}
	}
	return out
}

// control returns stdin control messages of the given type with the given
// request subtype ("" = any).
func (l *lineLog) control(typ, subtype string) []map[string]any {
	var out []map[string]any
	for _, m := range l.messages() {
		if m["type"] != typ {
			continue
		}
		if subtype != "" {
			if req, _ := m["request"].(map[string]any); req == nil || req["subtype"] != subtype {
				continue
			}
		}
		out = append(out, m)
	}
	return out
}

func newHarness(t *testing.T, opts ...harnessOpt) *harness {
	t.Helper()
	dir := t.TempDir()
	if canon, err := filepath.EvalSymlinks(dir); err == nil {
		dir = canon
	}
	h := &harness{
		t:     t,
		env:   chattest.NewEnv(t),
		dir:   dir,
		exe:   filepath.Join(chattest.FakeClaude(t), "claude"),
		u:     NewUUID(),
		stdin: &lineLog{},
	}
	h.spec = Spec{
		ID:      "sess-" + h.u[:8],
		Workdir: dir,
		Exe:     h.exe,
		test:    &testHooks{onStdin: h.stdin.add},
	}
	for _, o := range opts {
		o(h)
	}
	h.spec.ClaudeSessionID = h.u
	h.spec.ProjectsDir = filepath.Join(h.env.ConfigDir, "projects")
	h.spec.Env = h.env.Environ()
	if h.spec.Hooks.OnExit == nil {
		h.spec.Hooks.OnExit = func(ev ExitEvent) {
			h.exitMu.Lock()
			h.exits = append(h.exits, ev)
			h.exitMu.Unlock()
		}
	}
	return h
}

func (h *harness) start() *harness {
	h.t.Helper()
	s, err := Start(h.spec)
	if err != nil {
		h.t.Fatalf("Start: %v", err)
	}
	h.s = s
	h.t.Cleanup(func() {
		s.WithOp(func(ops OpHandle) { _ = ops.StopLocked(protocol.EndReasonStopped) })
		if v := h.env.Violation(); v != "" {
			h.t.Errorf("VIOLATION: %s", v)
		}
	})
	return h
}

func (h *harness) exitEvents() []ExitEvent {
	h.exitMu.Lock()
	defer h.exitMu.Unlock()
	return append([]ExitEvent(nil), h.exits...)
}

func (h *harness) send(id, text string) {
	h.t.Helper()
	if ack := h.s.Send(id, text); !ack.OK {
		h.t.Fatalf("Send(%q): ack %+v", text, ack)
	}
}

// waitSnap polls Snapshot until pred holds.
func (h *harness) waitSnap(desc string, pred func(Info) bool) Info {
	h.t.Helper()
	deadline := time.Now().Add(waitTimeout)
	for {
		info := h.s.Snapshot()
		if pred(info) {
			return info
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("timeout waiting for %s; last snapshot %+v", desc, info)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (h *harness) waitIdle() Info {
	h.t.Helper()
	return h.waitSnap("idle", func(i Info) bool { return i.Status == protocol.ChatStatusIdle })
}

func (h *harness) waitPending(n int) Info {
	h.t.Helper()
	return h.waitSnap(fmt.Sprintf("%d pending", n), func(i Info) bool { return len(i.Pending) == n })
}

// frame is one frame a subscriber received, decoded.
type frame struct {
	Type  string
	Seq   uint64
	H     bool
	Msg   map[string]any
	Raw   []byte
	State *protocol.ChatStateFrame
	Sync  *protocol.ChatSyncFrame
}

func decodeFrame(raw []byte) frame {
	var head struct {
		Type string          `json:"type"`
		Seq  uint64          `json:"seq"`
		H    bool            `json:"h"`
		Msg  json.RawMessage `json:"msg"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		panic(fmt.Sprintf("frame is not JSON: %q", raw))
	}
	f := frame{Type: head.Type, Seq: head.Seq, H: head.H, Raw: raw}
	switch head.Type {
	case protocol.TypeChat:
		_ = json.Unmarshal(head.Msg, &f.Msg)
	case protocol.TypeChatState:
		f.State = &protocol.ChatStateFrame{}
		_ = json.Unmarshal(raw, f.State)
	case protocol.TypeChatSync:
		f.Sync = &protocol.ChatSyncFrame{}
		_ = json.Unmarshal(raw, f.Sync)
	}
	return f
}

// collector is a subscriber that records everything it is sent.
type collector struct {
	t      *testing.T
	sub    *Subscription
	mu     sync.Mutex
	frames []frame
	exits  []int
	closed bool
	done   chan struct{}
}

// attach subscribes like a relay: the sync plan first, then live events.
func (h *harness) attach(epoch string, since *uint64) *collector {
	h.t.Helper()
	plan, sub := h.s.Subscribe(epoch, since)
	c := &collector{t: h.t, sub: sub, done: make(chan struct{})}
	if err := plan.WriteTo(c.write); err != nil {
		h.t.Fatalf("sync plan: %v", err)
	}
	go func() {
		defer close(c.done)
		for ev := range sub.C {
			switch {
			case ev.Resync != nil:
				_ = ev.Resync.WriteTo(c.write)
			case ev.Exit != nil:
				c.mu.Lock()
				c.exits = append(c.exits, *ev.Exit)
				c.mu.Unlock()
			default:
				_ = c.write(ev.Frame)
			}
		}
		c.mu.Lock()
		c.closed = true
		c.mu.Unlock()
	}()
	h.t.Cleanup(c.cancel)
	return c
}

func (c *collector) cancel() { c.sub.Cancel() }

func (c *collector) write(raw []byte) error {
	f := decodeFrame(append([]byte(nil), raw...))
	c.mu.Lock()
	c.frames = append(c.frames, f)
	c.mu.Unlock()
	return nil
}

func (c *collector) snapshot() []frame {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]frame(nil), c.frames...)
}

// waitFor polls the received frames until pred holds and returns them.
func (c *collector) waitFor(desc string, pred func([]frame) bool) []frame {
	c.t.Helper()
	deadline := time.Now().Add(waitTimeout)
	for {
		fs := c.snapshot()
		if pred(fs) {
			return fs
		}
		if time.Now().After(deadline) {
			c.t.Fatalf("timeout waiting for %s; got %d frames, last: %s", desc, len(fs), lastRaw(fs, 5))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func lastRaw(fs []frame, n int) string {
	if len(fs) > n {
		fs = fs[len(fs)-n:]
	}
	var parts []string
	for _, f := range fs {
		s := string(f.Raw)
		if len(s) > 300 {
			s = s[:300] + "…"
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, "\n")
}

// msgs returns the chat messages (not history) whose msg.type is typ ("" = all).
func msgs(fs []frame, typ string) []frame {
	var out []frame
	for _, f := range fs {
		if f.Type == protocol.TypeChat && !f.H && (typ == "" || f.Msg["type"] == typ) {
			out = append(out, f)
		}
	}
	return out
}

func states(fs []frame) []*protocol.ChatStateFrame {
	var out []*protocol.ChatStateFrame
	for _, f := range fs {
		if f.State != nil {
			out = append(out, f.State)
		}
	}
	return out
}

func lastState(fs []frame) *protocol.ChatStateFrame {
	st := states(fs)
	if len(st) == 0 {
		return nil
	}
	return st[len(st)-1]
}

func hasState(pred func(*protocol.ChatStateFrame) bool) func([]frame) bool {
	return func(fs []frame) bool {
		st := lastState(fs)
		return st != nil && pred(st)
	}
}

// resultCount counts result messages.
func resultCount(fs []frame) int { return len(msgs(fs, "result")) }

// notices returns vr_notice messages with the given code.
func notices(fs []frame, code string) []frame {
	var out []frame
	for _, f := range msgs(fs, "vr_notice") {
		if f.Msg["code"] == code {
			out = append(out, f)
		}
	}
	return out
}

func resolved(fs []frame, requestID string) []frame {
	var out []frame
	for _, f := range msgs(fs, "vr_resolved") {
		if requestID == "" || f.Msg["request_id"] == requestID {
			out = append(out, f)
		}
	}
	return out
}

// assistantText joins the text blocks of complete assistant messages.
func assistantText(fs []frame) string {
	var b strings.Builder
	for _, f := range msgs(fs, "assistant") {
		m, _ := f.Msg["message"].(map[string]any)
		blocks, _ := m["content"].([]any)
		for _, bl := range blocks {
			if bm, _ := bl.(map[string]any); bm != nil && bm["type"] == "text" {
				b.WriteString(fmt.Sprint(bm["text"]))
				b.WriteString("\n")
			}
		}
	}
	return b.String()
}

// pendingRequest returns the first pending request's id and request object.
func pendingRequest(t *testing.T, info Info) (string, map[string]any) {
	t.Helper()
	if len(info.Pending) == 0 {
		t.Fatal("no pending request")
	}
	var req map[string]any
	if err := json.Unmarshal(info.Pending[0].Request, &req); err != nil {
		t.Fatal(err)
	}
	return info.Pending[0].RequestID, req
}

func raw(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func ptr[T any](v T) *T { return &v }

// goid returns the current goroutine's id (for "runs on its own goroutine").
func goid() string {
	buf := make([]byte, 64)
	buf = buf[:runtime.Stack(buf, false)]
	return strings.Fields(string(buf))[1]
}

// pidAlive reports whether pid still exists.
func pidAlive(pid int) bool { return processAlive(pid) }

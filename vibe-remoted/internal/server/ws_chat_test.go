package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat/chattest"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/config"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/session"
)

const chatTimeout = 15 * time.Second

// chatServer is a daemon whose claude is the fake claude.
type chatServer struct {
	t        *testing.T
	env      *chattest.Env
	exe      string
	root     string // allowed root, trusted for chat
	projects string
	cfg      *config.Config
	mgr      *session.Manager
	s        *Server
	ts       *httptest.Server
	wsURL    string
}

type chatServerOpt func(*chatServer)

func withClaudeCmd(cmd string) chatServerOpt {
	return func(c *chatServer) { c.cfg.ClaudeCmd = cmd }
}

func withTmux() chatServerOpt {
	return func(c *chatServer) {
		requireTmuxServer(c.t)
		c.cfg.UseTmux = true
	}
}

func withFlags(flags ...config.ClaudeFlag) chatServerOpt {
	return func(c *chatServer) { c.cfg.ClaudeFlags = flags }
}

func requireTmuxServer(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		if os.Getenv("VIBE_REMOTE_REQUIRE_TMUX") == "1" {
			t.Fatal("tmux is not installed but VIBE_REMOTE_REQUIRE_TMUX=1")
		}
		t.Skip("tmux is not installed")
	}
}

// newChatServer starts a daemon against the fake claude. claude's config dir
// (trust file, transcripts) is private to the test; the root is trusted.
func newChatServer(t *testing.T, opts ...chatServerOpt) *chatServer {
	t.Helper()
	root := t.TempDir()
	if canon, err := filepath.EvalSymlinks(root); err == nil {
		root = canon
	}
	c := &chatServer{t: t, env: chattest.NewEnv(t), exe: filepath.Join(chattest.FakeClaude(t), "claude"), root: root}
	c.projects = filepath.Join(c.env.ConfigDir, "projects")
	// The daemon reads claude's trust file from its own environment.
	t.Setenv("CLAUDE_CONFIG_DIR", c.env.ConfigDir)
	chattest.TrustDir(t, c.env.ConfigDir, root)
	no := false
	c.cfg = &config.Config{Token: strings.Repeat("k", 32), BindAddr: "127.0.0.1", Port: 8765, AllowedRoots: []string{root},
		DefaultWorkdir: root, ClaudeCmd: c.exe, LoginShell: &no, StateDir: filepath.Join(t.TempDir(), "state")}
	for _, o := range opts {
		o(c)
	}
	c.mgr = session.NewManager(c.cfg.UseTmux, c.cfg.ClaudeCmd, false, "")
	c.mgr.SetEventEnv("http://127.0.0.1:8765/api/v1/events", c.cfg.Token)
	c.mgr.SetChatConfig(session.ChatConfig{ProjectsDir: c.projects,
		Env: append(c.env.Vars(), "CLAUDECODE=", "CLAUDE_CODE_ENTRYPOINT=")})
	store, err := chat.NewStore(c.cfg.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.mgr.LoadChats(store); err != nil {
		t.Fatal(err)
	}
	c.s = New(c.cfg, c.mgr)
	c.ts = httptest.NewServer(c.s.mux)
	c.wsURL = "ws" + strings.TrimPrefix(c.ts.URL, "http") + "/ws"
	t.Cleanup(func() {
		c.ts.Close()
		c.mgr.Shutdown(6 * time.Second)
		if v := c.env.Violation(); v != "" {
			t.Errorf("VIOLATION: %s", v)
		}
		if c.cfg.UseTmux {
			waitTmuxIdle()
		}
	})
	return c
}

// waitTmuxIdle waits until a shared tmux server that lost its last session
// has finished exiting (the next test's new-session would race it).
func waitTmuxIdle() {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		out, _ := exec.Command("tmux", "-L", "vibe-remote", "list-sessions").CombinedOutput()
		if !strings.Contains(string(out), "server exited unexpectedly") {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (c *chatServer) dir(name string) string {
	c.t.Helper()
	d := filepath.Join(c.root, name)
	if err := os.MkdirAll(d, 0o755); err != nil {
		c.t.Fatal(err)
	}
	chattest.TrustDir(c.t, c.env.ConfigDir, d)
	return d
}

func (c *chatServer) rest(method, path string) (int, map[string]any) {
	c.t.Helper()
	req, _ := http.NewRequest(method, c.ts.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+c.cfg.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	var body map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&body)
	return resp.StatusCode, body
}

// wsFrame is a received frame, decoded enough for the assertions.
type wsFrame struct {
	Type  string
	Raw   []byte
	Seq   uint64
	H     bool
	Msg   map[string]any
	State *protocol.ChatStateFrame
	Sync  *protocol.ChatSyncFrame
	Ready *protocol.ReadyFrame
	Err   *protocol.ErrorFrame
	Ack   *protocol.ChatAckFrame
}

func decodeWS(raw []byte) wsFrame {
	var head struct {
		Type string          `json:"type"`
		Seq  uint64          `json:"seq"`
		H    bool            `json:"h"`
		Msg  json.RawMessage `json:"msg"`
	}
	_ = json.Unmarshal(raw, &head)
	f := wsFrame{Type: head.Type, Raw: raw, Seq: head.Seq, H: head.H}
	switch head.Type {
	case protocol.TypeChat:
		_ = json.Unmarshal(head.Msg, &f.Msg)
	case protocol.TypeChatState:
		f.State = &protocol.ChatStateFrame{}
		_ = json.Unmarshal(raw, f.State)
	case protocol.TypeChatSync:
		f.Sync = &protocol.ChatSyncFrame{}
		_ = json.Unmarshal(raw, f.Sync)
	case protocol.TypeReady:
		f.Ready = &protocol.ReadyFrame{}
		_ = json.Unmarshal(raw, f.Ready)
	case protocol.TypeError:
		f.Err = &protocol.ErrorFrame{}
		_ = json.Unmarshal(raw, f.Err)
	case protocol.TypeChatAck:
		f.Ack = &protocol.ChatAckFrame{}
		_ = json.Unmarshal(raw, f.Ack)
	}
	return f
}

// wsClient is a connection whose frames are collected in the background.
type wsClient struct {
	t      *testing.T
	conn   *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc
	mu     sync.Mutex
	frames []wsFrame
	closed error
	done   chan struct{}
}

func (c *chatServer) connect() *wsClient {
	c.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	conn, _, err := websocket.Dial(ctx, c.wsURL, nil)
	if err != nil {
		cancel()
		c.t.Fatalf("dial: %v", err)
	}
	conn.SetReadLimit(64 << 20)
	w := &wsClient{t: c.t, conn: conn, ctx: ctx, cancel: cancel, done: make(chan struct{})}
	c.t.Cleanup(w.close)
	if err := wsjson.Write(ctx, conn, protocol.AuthFrame{Type: protocol.TypeAuth, Token: c.cfg.Token}); err != nil {
		c.t.Fatal(err)
	}
	go func() {
		defer close(w.done)
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				w.mu.Lock()
				w.closed = err
				w.mu.Unlock()
				return
			}
			f := decodeWS(data)
			w.mu.Lock()
			w.frames = append(w.frames, f)
			w.mu.Unlock()
		}
	}()
	w.waitFor("initial sessions", func(fs []wsFrame) bool { return len(fs) > 0 && fs[0].Type == protocol.TypeSessions })
	return w
}

func (w *wsClient) close() {
	w.conn.Close(websocket.StatusNormalClosure, "")
	w.cancel()
	<-w.done
}

func (w *wsClient) send(v any) {
	w.t.Helper()
	if err := wsjson.Write(w.ctx, w.conn, v); err != nil {
		w.t.Fatalf("write %T: %v", v, err)
	}
}

func (w *wsClient) snapshot() []wsFrame {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]wsFrame(nil), w.frames...)
}

func (w *wsClient) isClosed() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.closed != nil
}

func (w *wsClient) waitFor(desc string, pred func([]wsFrame) bool) []wsFrame {
	w.t.Helper()
	deadline := time.Now().Add(chatTimeout)
	for {
		fs := w.snapshot()
		if pred(fs) {
			return fs
		}
		if time.Now().After(deadline) {
			var tail []string
			for i := len(fs) - 4; i < len(fs); i++ {
				if i >= 0 {
					s := string(fs[i].Raw)
					if len(s) > 300 {
						s = s[:300] + "…"
					}
					tail = append(tail, s)
				}
			}
			w.t.Fatalf("timeout waiting for %s (%d frames; closed=%v)\n%s", desc, len(fs), w.isClosed(), strings.Join(tail, "\n"))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func ofType(fs []wsFrame, typ string) []wsFrame {
	var out []wsFrame
	for _, f := range fs {
		if f.Type == typ {
			out = append(out, f)
		}
	}
	return out
}

// chatMsgs returns live chat messages with msg.type typ ("" = all).
func chatMsgs(fs []wsFrame, typ string) []wsFrame {
	var out []wsFrame
	for _, f := range fs {
		if f.Type == protocol.TypeChat && !f.H && (typ == "" || f.Msg["type"] == typ) {
			out = append(out, f)
		}
	}
	return out
}

func lastChatState(fs []wsFrame) *protocol.ChatStateFrame {
	for i := len(fs) - 1; i >= 0; i-- {
		if fs[i].State != nil {
			return fs[i].State
		}
	}
	return nil
}

func firstOf(fs []wsFrame, typ string) *wsFrame {
	for i := range fs {
		if fs[i].Type == typ {
			return &fs[i]
		}
	}
	return nil
}

func texts(fs []wsFrame) string {
	var b strings.Builder
	for _, f := range chatMsgs(fs, "assistant") {
		m, _ := f.Msg["message"].(map[string]any)
		blocks, _ := m["content"].([]any)
		for _, bl := range blocks {
			if bm, _ := bl.(map[string]any); bm != nil && bm["type"] == "text" {
				b.WriteString(fmt.Sprint(bm["text"]) + "\n")
			}
		}
	}
	return b.String()
}

// attachChat creates (sessionID "") or resumes a chat session and waits for
// the end of the sync sequence.
func (c *chatServer) attachChat(w *wsClient, frame protocol.AttachFrame) *protocol.ReadyFrame {
	c.t.Helper()
	frame.Type = protocol.TypeAttach
	frame.UI = protocol.UIChat
	if frame.Cols == 0 {
		frame.Cols, frame.Rows = 80, 24
	}
	before := len(w.snapshot())
	w.send(frame)
	fs := w.waitFor("ready and sync", func(fs []wsFrame) bool {
		fs = fs[before:]
		if f := firstOf(fs, protocol.TypeError); f != nil {
			return true
		}
		return firstOf(fs, protocol.TypeReady) != nil && firstOf(fs, protocol.TypeChatState) != nil
	})[before:]
	if f := firstOf(fs, protocol.TypeError); f != nil {
		c.t.Fatalf("attach failed: %s", f.Raw)
	}
	return firstOf(fs, protocol.TypeReady).Ready
}

func (c *chatServer) newChat(w *wsClient, workdir string) *protocol.ReadyFrame {
	c.t.Helper()
	return c.attachChat(w, protocol.AttachFrame{NewSessionID: newSID("chat"), Workdir: workdir})
}

var sidSeq atomic.Int64

func newSID(prefix string) string {
	return fmt.Sprintf("%s-%d-%d", prefix, time.Now().UnixNano()%1e9, sidSeq.Add(1))
}

func (c *chatServer) chatSession(id string) *chat.Session {
	c.t.Helper()
	s, ok := c.mgr.ChatGet(id)
	if !ok {
		c.t.Fatalf("no chat session %s", id)
	}
	return s
}

func waitCond(t *testing.T, desc string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(chatTimeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timeout waiting for %s", desc)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func sendChat(w *wsClient, id, text string) {
	w.send(protocol.ChatSendFrame{Type: protocol.TypeChatSend, ClientMsgID: id, Text: text})
}

func acks(fs []wsFrame) []*protocol.ChatAckFrame {
	var out []*protocol.ChatAckFrame
	for _, f := range fs {
		if f.Ack != nil {
			out = append(out, f.Ack)
		}
	}
	return out
}

func results(fs []wsFrame) int { return len(chatMsgs(fs, "result")) }

func pidRunning(pid int) bool {
	return pid > 0 && exec.Command("kill", "-0", fmt.Sprint(pid)).Run() == nil
}

// expectAttachError attaches and returns the error frame.
func expectAttachError(t *testing.T, w *wsClient, frame protocol.AttachFrame) *protocol.ErrorFrame {
	t.Helper()
	frame.Type = protocol.TypeAttach
	if frame.Cols == 0 {
		frame.Cols, frame.Rows = 80, 24
	}
	before := len(w.snapshot())
	w.send(frame)
	fs := w.waitFor("error", func(fs []wsFrame) bool {
		return firstOf(fs[before:], protocol.TypeError) != nil || firstOf(fs[before:], protocol.TypeReady) != nil
	})[before:]
	f := firstOf(fs, protocol.TypeError)
	if f == nil {
		t.Fatalf("attach succeeded: %s", firstOf(fs, protocol.TypeReady).Raw)
	}
	return f.Err
}

// --- tests ---

func TestAttachWithoutUIStaysTerminal(t *testing.T) {
	c := newChatServer(t, withTmux(), withClaudeCmd("/bin/bash"))
	w := c.connect()
	id := newSID("term")
	t.Cleanup(func() { c.mgr.Delete(id) })
	w.send(protocol.AttachFrame{Type: protocol.TypeAttach, NewSessionID: id, Workdir: c.root, Cols: 80, Rows: 24})
	fs := w.waitFor("ready", func(fs []wsFrame) bool { return firstOf(fs, protocol.TypeReady) != nil })
	ready := firstOf(fs, protocol.TypeReady)
	if strings.Contains(string(ready.Raw), `"ui"`) {
		t.Fatalf("terminal ready carries ui: %s", ready.Raw)
	}
	if _, ok := c.mgr.ChatGet(id); ok {
		t.Fatal("a chat session was created")
	}
	if _, ok := c.mgr.Get(id); !ok {
		t.Fatal("no terminal session")
	}
}

func TestWSChatCreateReady(t *testing.T) {
	c := newChatServer(t)
	w := c.connect()
	ready := c.newChat(w, c.dir("p"))
	if ready.UI != protocol.UIChat || ready.ClaudeSessionID == "" || ready.Proto != protocol.Version || ready.Existing {
		t.Fatalf("ready %+v", ready)
	}
	fs := w.snapshot()
	sync := firstOf(fs, protocol.TypeChatSync)
	if sync == nil || !sync.Sync.Reset || sync.Sync.Epoch == "" {
		t.Fatalf("sync %+v", sync)
	}
	if st := lastChatState(fs); st.Status != protocol.ChatStatusIdle || st.ClaudeSessionID != ready.ClaudeSessionID {
		t.Fatalf("state %+v", st)
	}
	sendChat(w, "m1", "echo hello")
	fs = w.waitFor("reply", func(fs []wsFrame) bool { return results(fs) == 1 })
	if !strings.Contains(texts(fs), "hello") {
		t.Fatalf("reply %q", texts(fs))
	}
	if a := acks(fs); len(a) != 1 || !a[0].OK || a[0].Op != protocol.AckOpSend || a[0].Ref != "m1" {
		t.Fatalf("acks %+v", a)
	}
	// A replay of the same message is acked as a delivered duplicate.
	sendChat(w, "m1", "echo hello")
	fs = w.waitFor("duplicate ack", func(fs []wsFrame) bool { return len(acks(fs)) == 2 })
	if a := acks(fs)[1]; !a.OK || !a.Duplicate || a.Completed == nil || !*a.Completed || a.Ref != "m1" {
		t.Fatalf("duplicate ack %+v", a)
	}
	if results(fs) != 1 {
		t.Fatalf("replay ran again: %d results", results(fs))
	}
	// The sessions list marks it as a chat session.
	code, body := c.rest("GET", "/api/v1/sessions")
	if code != 200 || !strings.Contains(fmt.Sprint(body), "ui:chat") {
		t.Fatalf("list %d %v", code, body)
	}
}

func TestInfoChatNotClaude(t *testing.T) {
	c := newChatServer(t, withClaudeCmd("/bin/bash"))
	code, body := c.rest("GET", "/api/v1/info")
	ch, _ := body["chat"].(map[string]any)
	if code != 200 || ch["supported"] != false || ch["reason"] != protocol.ChatReasonNotClaude || ch["minClaudeVersion"] != chat.MinClaudeVersion {
		t.Fatalf("info %d %v", code, body)
	}
	w := c.connect()
	e := expectAttachError(t, w, protocol.AttachFrame{UI: protocol.UIChat, NewSessionID: newSID("nc"), Workdir: c.root})
	if e.Code != protocol.ErrCodeChatUnsupported || !e.Fatal || !strings.Contains(e.Message, protocol.ChatReasonNotClaude) {
		t.Fatalf("error %+v", e)
	}
}

func TestInfoChatTooOld(t *testing.T) {
	t.Setenv("FAKE_CLAUDE_VERSION", "1.0.51")
	c := newChatServer(t)
	_, body := c.rest("GET", "/api/v1/info")
	ch, _ := body["chat"].(map[string]any)
	if ch["supported"] != false || ch["reason"] != protocol.ChatReasonTooOld || ch["claudeVersion"] != "1.0.51" || ch["minClaudeVersion"] != chat.MinClaudeVersion {
		t.Fatalf("info chat %v", ch)
	}
	w := c.connect()
	e := expectAttachError(t, w, protocol.AttachFrame{UI: protocol.UIChat, NewSessionID: newSID("old"), Workdir: c.root})
	if e.Code != protocol.ErrCodeChatUnsupported || !strings.Contains(e.Message, protocol.ChatReasonTooOld) {
		t.Fatalf("error %+v", e)
	}
	// "I upgraded": recheck picks up the new version.
	t.Setenv("FAKE_CLAUDE_VERSION", "2.1.300")
	_, body = c.rest("GET", "/api/v1/info?recheck=1")
	ch, _ = body["chat"].(map[string]any)
	if ch["supported"] != true || ch["claudeVersion"] != "2.1.300" {
		t.Fatalf("after recheck %v", ch)
	}
}

func TestCreateChatUntrustedWorkdir(t *testing.T) {
	c := newChatServer(t)
	untrusted := filepath.Join(c.root, "untrusted")
	if err := os.MkdirAll(untrusted, 0o755); err != nil {
		t.Fatal(err)
	}
	w := c.connect()
	e := expectAttachError(t, w, protocol.AttachFrame{UI: protocol.UIChat, NewSessionID: newSID("ut"), Workdir: untrusted})
	if e.Code != protocol.ErrCodeChatUnsupported || !e.Fatal || !strings.Contains(e.Message, protocol.ChatReasonWorkdirUntrusted) {
		t.Fatalf("untrusted: %+v", e)
	}
	// A terminal there is unaffected.
	_, body := c.rest("GET", "/api/v1/fs?path="+untrusted)
	if body["chatTrust"] != protocol.TrustUntrusted {
		t.Fatalf("fs chatTrust %v", body["chatTrust"])
	}
	_, body = c.rest("GET", "/api/v1/fs?path="+c.root)
	if body["chatTrust"] != protocol.TrustTrusted {
		t.Fatalf("fs chatTrust for trusted %v", body["chatTrust"])
	}
	// Worktree mode checks the source directory.
	repo := filepath.Join(c.root, "repo")
	gitInit(t, repo)
	w2 := c.connect()
	e = expectAttachError(t, w2, protocol.AttachFrame{UI: protocol.UIChat, NewSessionID: newSID("ut"), Workdir: repo, Mode: protocol.SessionModeWorktree})
	if e.Code != protocol.ErrCodeChatUnsupported || !strings.Contains(e.Message, protocol.ChatReasonWorkdirUntrusted) {
		t.Fatalf("untrusted worktree source: %+v", e)
	}
	chattest.TrustDir(t, c.env.ConfigDir, repo)
	w3 := c.connect()
	ready := c.attachChat(w3, protocol.AttachFrame{NewSessionID: newSID("wt"), Workdir: repo, Mode: protocol.SessionModeWorktree})
	if ready.Mode != protocol.SessionModeWorktree || ready.WorktreeRoot == "" {
		t.Fatalf("worktree ready %+v", ready)
	}
	t.Cleanup(func() { c.mgr.Delete(ready.SessionID) })
	// No trust file at all: unknown, also refused.
	os.Remove(filepath.Join(c.env.ConfigDir, ".claude.json"))
	_, body = c.rest("GET", "/api/v1/fs?path="+c.root)
	if body["chatTrust"] != protocol.TrustUnknown {
		t.Fatalf("fs chatTrust without file %v", body["chatTrust"])
	}
	w4 := c.connect()
	e = expectAttachError(t, w4, protocol.AttachFrame{UI: protocol.UIChat, NewSessionID: newSID("ut"), Workdir: c.root})
	if e.Code != protocol.ErrCodeChatUnsupported || !strings.Contains(e.Message, protocol.ChatReasonWorkdirUntrusted) {
		t.Fatalf("unknown trust: %+v", e)
	}
}

func gitInit(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	serverGit(t, dir, "init")
	serverGit(t, dir, "config", "user.email", "test@example.com")
	serverGit(t, dir, "config", "user.name", "Test User")
	os.WriteFile(filepath.Join(dir, "README"), []byte("x\n"), 0o644)
	serverGit(t, dir, "add", "README")
	serverGit(t, dir, "commit", "-m", "initial")
}

func TestAttachIgnoresCommandFields(t *testing.T) {
	c := newChatServer(t, withFlags(config.ClaudeFlag{ID: "model", Label: "Model", Arg: "--model fable"}))
	w := c.connect()
	id := newSID("cmd")
	raw := fmt.Sprintf(`{"type":"attach","ui":"chat","newSessionId":%q,"workdir":%q,"cols":80,"rows":24,"flags":["model","--evil"],"command":"/bin/rm -rf /","args":["--dangerously-skip-permissions"],"exe":"/bin/sh"}`, id, c.root)
	if err := w.conn.Write(w.ctx, websocket.MessageText, []byte(raw)); err != nil {
		t.Fatal(err)
	}
	w.waitFor("ready", func(fs []wsFrame) bool { return firstOf(fs, protocol.TypeChatState) != nil })
	waitCond(t, "launch", func() bool { _, err := os.Stat(c.env.ArgvLog); return err == nil })
	data, _ := os.ReadFile(c.env.ArgvLog)
	var argv []string
	json.Unmarshal([]byte(strings.Split(strings.TrimSpace(string(data)), "\n")[0]), &argv)
	if argv[0] != c.exe || strings.Contains(string(data), "rm -rf") || strings.Contains(string(data), "dangerously") || strings.Contains(string(data), "evil") {
		t.Fatalf("argv %v", argv)
	}
	if !strings.Contains(string(data), `"--model","fable"`) {
		t.Fatalf("whitelisted flag missing: %v", argv)
	}
}

func TestTerminalAttachToChatIsUIMismatch(t *testing.T) {
	c := newChatServer(t)
	w := c.connect()
	ready := c.newChat(w, c.root)
	w2 := c.connect()
	e := expectAttachError(t, w2, protocol.AttachFrame{SessionID: ready.SessionID})
	if e.Code != protocol.ErrCodeUIMismatch || !e.Fatal {
		t.Fatalf("old client into chat: %+v", e)
	}
	w3 := c.connect()
	e = expectAttachError(t, w3, protocol.AttachFrame{UI: protocol.UIChat, SessionID: "no-such-session"})
	if e.Code != protocol.ErrCodeSessionNotFound || !e.Fatal {
		t.Fatalf("missing chat: %+v", e)
	}
}

func TestChatDisconnectKeepsProcess(t *testing.T) {
	c := newChatServer(t)
	w := c.connect()
	ready := c.newChat(w, c.root)
	sendChat(w, "s", "slow 50 40")
	w.waitFor("streaming", func(fs []wsFrame) bool { return len(chatMsgs(fs, "stream_event")) > 3 })
	sess := c.chatSession(ready.SessionID)
	pid := sess.Snapshot().Pid
	w.close()
	if n := len(ofType(w.snapshot(), protocol.TypeExit)); n != 0 {
		t.Fatal("exit frame on disconnect")
	}
	time.Sleep(300 * time.Millisecond)
	if !pidRunning(pid) {
		t.Fatal("claude stopped with the connection")
	}
	_, body := c.rest("GET", "/api/v1/sessions")
	for _, it := range body["list"].([]any) {
		e := it.(map[string]any)
		if e["id"] == ready.SessionID && (e["state"] == protocol.ChatStatusEnded || e["state"] == nil) {
			t.Fatalf("listed as %v", e)
		}
	}
	waitCond(t, "turn finished unattended", func() bool { return sess.Snapshot().Status == protocol.ChatStatusIdle })
}

func TestTwoClientsShareProcess(t *testing.T) {
	c := newChatServer(t)
	a := c.connect()
	ready := c.newChat(a, c.root)
	b := c.connect()
	c.attachChat(b, protocol.AttachFrame{SessionID: ready.SessionID})
	sendChat(a, "from-a", "echo alpha")
	sendChat(b, "from-b", "echo beta")
	order := func(w *wsClient) []string {
		fs := w.waitFor("both replies", func(fs []wsFrame) bool { return results(fs) == 2 })
		var ids []string
		for _, f := range chatMsgs(fs, "user") {
			if id, ok := f.Msg["vr_client_msg_id"].(string); ok {
				ids = append(ids, id)
			}
		}
		return ids
	}
	oa, ob := order(a), order(b)
	if len(oa) != 2 || fmt.Sprint(oa) != fmt.Sprint(ob) {
		t.Fatalf("echo order a=%v b=%v", oa, ob)
	}
	if n := len(c.env.LivePids(ready.ClaudeSessionID)); n != 1 {
		t.Fatalf("%d processes", n)
	}
}

func TestTwoClientsRespondRace(t *testing.T) {
	c := newChatServer(t)
	a := c.connect()
	ready := c.newChat(a, c.root)
	b := c.connect()
	c.attachChat(b, protocol.AttachFrame{SessionID: ready.SessionID})
	sendChat(a, "p", "perm touch x")
	fs := a.waitFor("pending", func(fs []wsFrame) bool { st := lastChatState(fs); return st != nil && len(st.Pending) == 1 })
	p := lastChatState(fs).Pending[0]
	var req map[string]any
	json.Unmarshal(p.Request, &req)
	resp, _ := json.Marshal(map[string]any{"behavior": "allow", "updatedInput": req["input"]})
	var wg sync.WaitGroup
	for _, w := range []*wsClient{a, b} {
		wg.Add(1)
		go func(w *wsClient) {
			defer wg.Done()
			w.send(protocol.ChatRespondFrame{Type: protocol.TypeChatRespond, RequestID: p.RequestID, Response: resp})
		}(w)
	}
	wg.Wait()
	okCount := 0
	for _, w := range []*wsClient{a, b} {
		fs := w.waitFor("ack", func(fs []wsFrame) bool {
			for _, ack := range acks(fs) {
				if ack.Op == protocol.AckOpRespond {
					return true
				}
			}
			return false
		})
		for _, ack := range acks(fs) {
			if ack.Op != protocol.AckOpRespond {
				continue
			}
			if ack.OK {
				okCount++
			} else if ack.Code != protocol.AckRequestNotPending {
				t.Fatalf("ack %+v", ack)
			}
		}
	}
	if okCount != 1 {
		t.Fatalf("%d answers accepted", okCount)
	}
}

func TestResyncRestoresPending(t *testing.T) {
	t.Run("tool", func(t *testing.T) {
		c := newChatServer(t)
		w := c.connect()
		ready := c.newChat(w, c.root)
		w.close()
		sess := c.chatSession(ready.SessionID)
		sess.Send("p", "perm touch x") // arrives while nobody is connected
		waitCond(t, "pending", func() bool { return len(sess.Snapshot().Pending) == 1 })
		w2 := c.connect()
		c.attachChat(w2, protocol.AttachFrame{SessionID: ready.SessionID})
		st := lastChatState(w2.snapshot())
		if len(st.Pending) != 1 {
			t.Fatalf("pending after reconnect %+v", st.Pending)
		}
		var req map[string]any
		json.Unmarshal(st.Pending[0].Request, &req)
		resp, _ := json.Marshal(map[string]any{"behavior": "allow", "updatedInput": req["input"]})
		w2.send(protocol.ChatRespondFrame{Type: protocol.TypeChatRespond, RequestID: st.Pending[0].RequestID, Response: resp})
		fs := w2.waitFor("continued", func(fs []wsFrame) bool { return results(fs) == 1 })
		if !strings.Contains(texts(fs), "done Bash") {
			t.Fatalf("reply %q", texts(fs))
		}
	})
	for _, opt := range []struct {
		name     string
		behavior string
		setMode  string
		wantText string
	}{
		{"approve auto", "allow", "acceptEdits", "plan approved"},
		{"approve manual", "allow", "default", "plan approved"},
		{"keep planning", "deny", "", "revising: more"},
	} {
		opt := opt
		t.Run("plan "+opt.name, func(t *testing.T) {
			c := newChatServer(t)
			w := c.connect()
			ready := c.newChat(w, c.root)
			w.close()
			sess := c.chatSession(ready.SessionID)
			sess.Send("p", "plan")
			waitCond(t, "pending plan", func() bool { return len(sess.Snapshot().Pending) == 1 })
			original := sess.Snapshot().Pending[0].Request
			w2 := c.connect()
			c.attachChat(w2, protocol.AttachFrame{SessionID: ready.SessionID})
			st := lastChatState(w2.snapshot())
			var got, want struct {
				Input struct {
					Plan string `json:"plan"`
				} `json:"input"`
			}
			json.Unmarshal(st.Pending[0].Request, &got)
			json.Unmarshal(original, &want)
			if got.Input.Plan == "" || got.Input.Plan != want.Input.Plan {
				t.Fatalf("plan after reconnect %q, want %q", got.Input.Plan, want.Input.Plan)
			}
			var req map[string]any
			json.Unmarshal(st.Pending[0].Request, &req)
			body := map[string]any{"behavior": opt.behavior}
			if opt.behavior == "allow" {
				body["updatedInput"] = req["input"]
			} else {
				body["message"] = "more"
			}
			resp, _ := json.Marshal(body)
			w2.send(protocol.ChatRespondFrame{Type: protocol.TypeChatRespond, RequestID: st.Pending[0].RequestID, Response: resp, SetMode: opt.setMode})
			fs := w2.waitFor("answer took effect", func(fs []wsFrame) bool { return strings.Contains(texts(fs), opt.wantText) })
			for _, ack := range acks(fs) {
				if !ack.OK {
					t.Fatalf("ack %+v", ack)
				}
			}
		})
	}
}

func TestResyncIncremental50(t *testing.T) {
	c := newChatServer(t)
	w := c.connect()
	ready := c.newChat(w, c.root)
	sendChat(w, "1", "echo before")
	fs := w.waitFor("first reply", func(fs []wsFrame) bool {
		st := lastChatState(fs)
		return results(fs) == 1 && st != nil && st.Status == protocol.ChatStatusIdle
	})
	var last uint64
	for _, f := range chatMsgs(fs, "") {
		last = f.Seq
	}
	epoch := firstOf(fs, protocol.TypeChatSync).Sync.Epoch
	w.close()
	sess := c.chatSession(ready.SessionID)
	sess.Send("2", "burst 50")
	waitCond(t, "burst done", func() bool { i := sess.Snapshot(); return i.Status == protocol.ChatStatusIdle && i.Seq > last+50 })
	w2 := c.connect()
	c.attachChat(w2, protocol.AttachFrame{SessionID: ready.SessionID, Epoch: epoch, Since: &last})
	fs2 := w2.snapshot()
	sync := firstOf(fs2, protocol.TypeChatSync).Sync
	if sync.Reset || sync.HistoryCount != 0 {
		t.Fatalf("sync %+v", sync)
	}
	got := chatMsgs(fs2, "")
	if len(got) != sync.Backlog || got[0].Seq != last+1 {
		t.Fatalf("backlog %d frames (sync says %d), first seq %d want %d", len(got), sync.Backlog, got[0].Seq, last+1)
	}
	seen := map[uint64]bool{}
	for i, f := range got {
		if seen[f.Seq] || (i > 0 && f.Seq != got[i-1].Seq+1) {
			t.Fatalf("seq %d duplicated or out of order", f.Seq)
		}
		seen[f.Seq] = true
	}
	if n := len(chatMsgs(fs2, "assistant")); n != 50 {
		t.Fatalf("%d burst messages resent, want 50", n)
	}
}

func TestReloadPushesResetSync(t *testing.T) {
	c := newChatServer(t)
	w := c.connect()
	ready := c.newChat(w, c.root)
	sendChat(w, "1", "echo kept")
	w.waitFor("reply", func(fs []wsFrame) bool { return results(fs) == 1 })
	before := len(w.snapshot())
	oldEpoch := firstOf(w.snapshot(), protocol.TypeChatSync).Sync.Epoch
	if code, _ := c.rest("POST", "/api/v1/sessions/"+ready.SessionID+"/reload"); code != http.StatusAccepted {
		t.Fatalf("reload status %d", code)
	}
	fs := w.waitFor("new epoch", func(fs []wsFrame) bool {
		for _, f := range fs[before:] {
			if f.Sync != nil && f.Sync.Epoch != oldEpoch {
				st := lastChatState(fs)
				return st != nil && st.Status == protocol.ChatStatusIdle
			}
		}
		return false
	})[before:]
	if w.isClosed() {
		t.Fatal("connection dropped by the reload")
	}
	var sawStopped bool
	for _, f := range fs {
		if f.State != nil && f.State.Ended != nil && f.State.Ended.Reason == protocol.EndReasonStopped {
			sawStopped = true
		}
		if f.Sync != nil && !f.Sync.Reset {
			t.Fatalf("reload sync not reset: %s", f.Raw)
		}
	}
	if !sawStopped {
		t.Fatal("no stopped state during the reload")
	}
}

func TestReloadChatReturns202(t *testing.T) {
	c := newChatServer(t)
	w := c.connect()
	ready := c.newChat(w, c.root)
	sendChat(w, "1", "echo one")
	w.waitFor("r1", func(fs []wsFrame) bool { return results(fs) == 1 })
	sendChat(w, "2", "echo two")
	w.waitFor("r2", func(fs []wsFrame) bool { return results(fs) == 2 })
	path, _ := chat.FindTranscript(c.projects, ready.ClaudeSessionID)
	wantHistory, _ := chat.CountHistory(path, -1)
	sendChat(w, "3", "slow 100 100")
	w.waitFor("slow running", func(fs []wsFrame) bool { return len(chatMsgs(fs, "stream_event")) > 3 })
	launches := func() int {
		data, _ := os.ReadFile(c.env.ArgvLog)
		return strings.Count(string(data), "\n")
	}
	before := launches()
	start := time.Now()
	code, _ := c.rest("POST", "/api/v1/sessions/"+ready.SessionID+"/reload")
	if d := time.Since(start); code != http.StatusAccepted || d > 500*time.Millisecond {
		t.Fatalf("reload %d after %v", code, d)
	}
	if code, _ := c.rest("POST", "/api/v1/sessions/"+ready.SessionID+"/reload"); code != http.StatusAccepted {
		t.Fatalf("second reload %d", code)
	}
	sess := c.chatSession(ready.SessionID)
	waitCond(t, "reloaded", func() bool {
		i := sess.Snapshot()
		return !i.Reloading && i.Status == protocol.ChatStatusIdle
	})
	time.Sleep(300 * time.Millisecond)
	if n := launches() - before; n != 1 {
		t.Fatalf("%d new processes for two reload requests", n)
	}
	// A new connection gets the whole history, then can go on.
	w2 := c.connect()
	c.attachChat(w2, protocol.AttachFrame{SessionID: ready.SessionID})
	fs := w2.snapshot()
	if sync := firstOf(fs, protocol.TypeChatSync).Sync; sync.HistoryCount < wantHistory {
		t.Fatalf("historyCount %d, want ≥ %d", sync.HistoryCount, wantHistory)
	}
	sendChat(w2, "4", "echo after reload")
	w2.waitFor("reply", func(fs []wsFrame) bool { return strings.Contains(texts(fs), "after reload") })
}

func TestReloadChatStartFailure(t *testing.T) {
	// claude is a wrapper that disappears after the first start.
	wrapDir := t.TempDir()
	wrapper := filepath.Join(wrapDir, "claude")
	fake := filepath.Join(chattest.FakeClaude(t), "claude")
	if err := os.WriteFile(wrapper, []byte("#!/bin/sh\nexec '"+fake+"' \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	c := newChatServer(t, withClaudeCmd(wrapper))
	w := c.connect()
	ready := c.newChat(w, c.root)
	sess := c.chatSession(ready.SessionID)
	sess.WithOp(func(ops chat.OpHandle) { _ = ops.StopLocked(protocol.EndReasonStopped) })
	if err := os.Remove(wrapper); err != nil {
		t.Fatal(err)
	}
	if code, _ := c.rest("POST", "/api/v1/sessions/"+ready.SessionID+"/reload"); code != http.StatusAccepted {
		t.Fatalf("reload %d", code)
	}
	fs := w.waitFor("restart_failed", func(fs []wsFrame) bool {
		st := lastChatState(fs)
		return st != nil && st.Ended != nil && st.Ended.Reason == protocol.EndReasonRestartFailed
	})
	if st := lastChatState(fs); st.Ended.Message == "" {
		t.Fatalf("no message: %+v", st.Ended)
	}
}

func TestCrashEmitsExitAndEndedWS(t *testing.T) {
	c := newChatServer(t)
	w := c.connect()
	c.newChat(w, c.root)
	sendChat(w, "c", "crash 1")
	fs := w.waitFor("exit", func(fs []wsFrame) bool { return len(ofType(fs, protocol.TypeExit)) == 1 })
	st := lastChatState(fs)
	if st.Ended == nil || st.Ended.Reason != protocol.EndReasonExited || len(chatMsgs(fs, "vr_exit")) != 1 {
		t.Fatalf("state %+v", st)
	}
	var exit protocol.ExitFrame
	json.Unmarshal(ofType(fs, protocol.TypeExit)[0].Raw, &exit)
	if exit.Code != 1 {
		t.Fatalf("exit %+v", exit)
	}
	time.Sleep(100 * time.Millisecond)
	if w.isClosed() {
		t.Fatal("connection closed after a crash")
	}
}

func TestChatRenameDeleteREST(t *testing.T) {
	c := newChatServer(t)
	w := c.connect()
	ready := c.newChat(w, c.root)
	req, _ := http.NewRequest("POST", c.ts.URL+"/api/v1/sessions/"+ready.SessionID+"/rename", strings.NewReader(`{"name":"renamed chat"}`))
	req.Header.Set("Authorization", "Bearer "+c.cfg.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusNoContent {
		t.Fatalf("rename %v %v", resp.StatusCode, err)
	}
	// Another connection's sessions frame shows the name.
	w2 := c.connect()
	if !strings.Contains(string(w2.snapshot()[0].Raw), "renamed chat") {
		t.Fatalf("sessions frame %s", w2.snapshot()[0].Raw)
	}
	if code, _ := c.rest("DELETE", "/api/v1/sessions/"+ready.SessionID); code != http.StatusNoContent {
		t.Fatalf("delete %d", code)
	}
	w.waitFor("connection dropped", func([]wsFrame) bool { return w.isClosed() })
	if code, _ := c.rest("DELETE", "/api/v1/sessions/"+ready.SessionID); code != http.StatusNotFound {
		t.Fatalf("second delete %d", code)
	}
	// Without tmux an unknown id answers 409 "requires tmux", as before.
	if code, _ := c.rest("POST", "/api/v1/sessions/"+ready.SessionID+"/reload"); code != http.StatusNotFound && code != http.StatusConflict {
		t.Fatalf("reload deleted %d", code)
	}
}

// --- handoff ---

func (c *chatServer) handoff(w *wsClient, from, newID string) *protocol.ReadyFrame {
	c.t.Helper()
	before := len(w.snapshot())
	w.send(protocol.AttachFrame{Type: protocol.TypeAttach, NewSessionID: newID, HandoffFrom: from, Cols: 80, Rows: 24})
	fs := w.waitFor("handoff ready", func(fs []wsFrame) bool {
		return firstOf(fs[before:], protocol.TypeReady) != nil || firstOf(fs[before:], protocol.TypeError) != nil
	})[before:]
	if e := firstOf(fs, protocol.TypeError); e != nil {
		c.t.Fatalf("handoff: %s", e.Raw)
	}
	c.t.Cleanup(func() { c.mgr.Delete(newID) })
	return firstOf(fs, protocol.TypeReady).Ready
}

func argvLaunches(t *testing.T, path string) [][]string {
	t.Helper()
	data, _ := os.ReadFile(path)
	var out [][]string
	for _, l := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var a []string
		if json.Unmarshal([]byte(l), &a) == nil {
			out = append(out, a)
		}
	}
	return out
}

func argHas(argv []string, flag, value string) bool {
	for i := range argv {
		if argv[i] == flag && (value == "" || (i+1 < len(argv) && argv[i+1] == value)) {
			return true
		}
	}
	return false
}

func TestHandoffCreatesTerminalWithResume(t *testing.T) {
	c := newChatServer(t, withTmux(), withClaudeCmd(filepath.Join(chattest.FakeClaude(t), "claude")+" -c --model fable"))
	w := c.connect()
	ready := c.newChat(w, c.dir("h"))
	sendChat(w, "1", "echo hi")
	w.waitFor("reply", func(fs []wsFrame) bool { return results(fs) == 1 })
	sess := c.chatSession(ready.SessionID)
	chatPid := sess.Snapshot().Pid
	tw := c.connect()
	newID := newSID("ho")
	tr := c.handoff(tw, ready.SessionID, newID)
	if tr.UI != "" || tr.SessionID != newID || tr.HandoffFrom != ready.SessionID || tr.Workdir != c.dir("h") {
		t.Fatalf("terminal ready %+v", tr)
	}
	if pidRunning(chatPid) {
		t.Fatal("chat process still running after handoff")
	}
	launches := argvLaunches(t, c.env.ArgvLog)
	waitCond(t, "terminal launch", func() bool { launches = argvLaunches(t, c.env.ArgvLog); return len(launches) == 2 })
	term := launches[1]
	if !argHas(term, "--resume", ready.ClaudeSessionID) || argHas(term, "-c", "") || argHas(term, "-p", "") || !argHas(term, "--model", "fable") {
		t.Fatalf("terminal argv %v", term)
	}
	fs := w.waitFor("handed_off", func(fs []wsFrame) bool {
		st := lastChatState(fs)
		return st != nil && st.Ended != nil && st.Ended.Reason == protocol.EndReasonHandedOff
	})
	if st := lastChatState(fs); st.Ended.HandedOffTo != newID {
		t.Fatalf("ended %+v", st.Ended)
	}
	// The PTY shows claude resuming the conversation.
	tw.waitFor("resume banner", func(fs []wsFrame) bool {
		for _, f := range ofType(fs, protocol.TypeData) {
			var d protocol.DataFrame
			json.Unmarshal(f.Raw, &d)
			if strings.Contains(decodeB64(d.Payload), "resume="+ready.ClaudeSessionID) {
				return true
			}
		}
		return false
	})
}

func TestHandoffStopsChatFirst(t *testing.T) {
	c := newChatServer(t, withTmux())
	w := c.connect()
	ready := c.newChat(w, c.root)
	sess := c.chatSession(ready.SessionID)
	pid := sess.Snapshot().Pid
	var overlap atomic.Bool
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			if len(c.env.LivePids(ready.ClaudeSessionID)) > 1 {
				overlap.Store(true)
			}
			time.Sleep(time.Millisecond)
		}
	}()
	tw := c.connect()
	c.handoff(tw, ready.SessionID, newSID("hs"))
	waitCond(t, "terminal claude", func() bool { return len(argvLaunches(t, c.env.ArgvLog)) == 2 })
	waitCond(t, "terminal pid file", func() bool { return len(c.env.LivePids(ready.ClaudeSessionID)) == 1 })
	close(stop)
	if overlap.Load() || pidRunning(pid) {
		t.Fatalf("overlap %v, chat alive %v", overlap.Load(), pidRunning(pid))
	}
}

func TestHandoffInterruptsRunningTurn(t *testing.T) {
	c := newChatServer(t, withTmux())
	w := c.connect()
	ready := c.newChat(w, c.root)
	sendChat(w, "s", "slow 100 100")
	w.waitFor("streaming", func(fs []wsFrame) bool { return len(chatMsgs(fs, "stream_event")) > 3 })
	tw := c.connect()
	c.handoff(tw, ready.SessionID, newSID("hi"))
	fs := w.waitFor("ended", func(fs []wsFrame) bool {
		st := lastChatState(fs)
		return st != nil && st.Ended != nil && st.Ended.Reason == protocol.EndReasonHandedOff
	})
	r := chatMsgs(fs, "result")
	if len(r) != 1 || r[0].Msg["terminal_reason"] != "aborted_streaming" {
		t.Fatalf("the running turn was not interrupted first: %d results", len(r))
	}
}

func TestHandoffReplayIdempotent(t *testing.T) {
	c := newChatServer(t, withTmux())
	w := c.connect()
	ready := c.newChat(w, c.root)
	newID := newSID("hr")
	first := c.handoff(c.connect(), ready.SessionID, newID)
	second := c.handoff(c.connect(), ready.SessionID, newID)
	if first.SessionID != newID || second.SessionID != newID {
		t.Fatalf("ids %s %s", first.SessionID, second.SessionID)
	}
	// A new handoff request (another id) lands on the existing terminal too.
	third := c.handoff(c.connect(), ready.SessionID, newSID("hr"))
	if third.SessionID != newID {
		t.Fatalf("third handoff opened %s", third.SessionID)
	}
	time.Sleep(200 * time.Millisecond)
	if n := len(argvLaunches(t, c.env.ArgvLog)); n != 2 {
		t.Fatalf("%d claude launches", n)
	}
	var terms int
	for _, s := range c.mgr.List() {
		if s.UI == "" && strings.HasPrefix(s.ID, "hr-") {
			terms++
		}
	}
	if terms != 1 {
		t.Fatalf("%d terminal sessions", terms)
	}
}

func TestHandoffReplayNoSelfWait(t *testing.T) {
	c := newChatServer(t, withTmux())
	w := c.connect()
	ready := c.newChat(w, c.root)
	newID := newSID("ns")
	var wg sync.WaitGroup
	readies := make([]*protocol.ReadyFrame, 2)
	start := time.Now()
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			readies[i] = c.handoff(c.connect(), ready.SessionID, newID)
		}(i)
	}
	wg.Wait()
	if d := time.Since(start); d > 6*time.Second {
		t.Fatalf("handoff and its replay took %v", d)
	}
	if readies[0].SessionID != newID || readies[1].SessionID != newID {
		t.Fatalf("readies %+v %+v", readies[0], readies[1])
	}
}

func TestWithOpSerializesHandoffDelete(t *testing.T) {
	c := newChatServer(t, withTmux())
	for i := 0; i < 4; i++ {
		w := c.connect()
		ready := c.newChat(w, c.root)
		newID := newSID("hd")
		t.Cleanup(func() { c.mgr.Delete(newID) })
		var wg sync.WaitGroup
		var handoffErr *protocol.ErrorFrame
		var handoffReady *protocol.ReadyFrame
		done := make(chan struct{})
		wg.Add(2)
		go func() {
			defer wg.Done()
			hw := c.connect()
			hw.send(protocol.AttachFrame{Type: protocol.TypeAttach, NewSessionID: newID, HandoffFrom: ready.SessionID, Cols: 80, Rows: 24})
			fs := hw.waitFor("result", func(fs []wsFrame) bool {
				return firstOf(fs, protocol.TypeReady) != nil || firstOf(fs, protocol.TypeError) != nil
			})
			if e := firstOf(fs, protocol.TypeError); e != nil {
				handoffErr = e.Err
			} else {
				handoffReady = firstOf(fs, protocol.TypeReady).Ready
			}
		}()
		go func() {
			defer wg.Done()
			_ = c.mgr.Delete(ready.SessionID)
		}()
		go func() { wg.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("handoff and delete deadlocked")
		}
		if _, ok := c.mgr.ChatGet(ready.SessionID); ok {
			t.Fatal("chat survived delete")
		}
		switch {
		case handoffErr != nil:
			if handoffErr.Code != protocol.ErrCodeSessionNotFound {
				t.Fatalf("handoff error %+v", handoffErr)
			}
		case handoffReady != nil:
			if _, ok := c.mgr.Get(newID); !ok {
				t.Fatal("deleting the chat removed the handed-off terminal")
			}
		}
	}
}

func TestHandoffVsReloadOneWins(t *testing.T) {
	c := newChatServer(t, withTmux())
	for i := 0; i < 20; i++ {
		w := c.connect()
		ready := c.newChat(w, c.root)
		u := ready.ClaudeSessionID
		newID := newSID("hv")
		t.Cleanup(func() { c.mgr.Delete(newID) })
		var overlap atomic.Bool
		stop := make(chan struct{})
		go func() {
			for {
				select {
				case <-stop:
					return
				default:
				}
				if len(c.env.LivePids(u)) > 1 {
					overlap.Store(true)
				}
				time.Sleep(time.Millisecond)
			}
		}()
		var wg sync.WaitGroup
		var handoffErr *protocol.ErrorFrame
		var reloadCodes []int
		var mu sync.Mutex
		wg.Add(3)
		go func() {
			defer wg.Done()
			hw := c.connect()
			hw.send(protocol.AttachFrame{Type: protocol.TypeAttach, NewSessionID: newID, HandoffFrom: ready.SessionID, Cols: 80, Rows: 24})
			fs := hw.waitFor("result", func(fs []wsFrame) bool {
				return firstOf(fs, protocol.TypeReady) != nil || firstOf(fs, protocol.TypeError) != nil
			})
			if e := firstOf(fs, protocol.TypeError); e != nil {
				handoffErr = e.Err
			}
		}()
		for k := 0; k < 2; k++ {
			go func() {
				defer wg.Done()
				code, _ := c.rest("POST", "/api/v1/sessions/"+ready.SessionID+"/reload")
				mu.Lock()
				reloadCodes = append(reloadCodes, code)
				mu.Unlock()
			}()
		}
		wg.Wait()
		sess := c.chatSession(ready.SessionID)
		waitCond(t, "settled", func() bool { return !sess.Snapshot().Reloading })
		time.Sleep(100 * time.Millisecond)
		close(stop)
		if overlap.Load() {
			t.Fatalf("round %d: two processes for one conversation", i)
		}
		for _, code := range reloadCodes {
			if code != http.StatusAccepted && code != http.StatusConflict {
				t.Fatalf("round %d: reload %d", i, code)
			}
		}
		info := sess.Snapshot()
		_, termOK := c.mgr.Get(newID)
		switch {
		case handoffErr == nil && termOK:
			if info.Ended == nil || info.Ended.Reason != protocol.EndReasonHandedOff {
				t.Fatalf("round %d: handed off but chat %+v", i, info)
			}
		case handoffErr != nil:
			if handoffErr.Code != protocol.ErrCodeClaudeSessionBusy || info.Status == protocol.ChatStatusEnded {
				t.Fatalf("round %d: handoff %+v, chat %+v", i, handoffErr, info)
			}
		default:
			t.Fatalf("round %d: handoff ok but no terminal session", i)
		}
		w.close()
	}
}

func TestHandedOffTerminalReloadUsesResume(t *testing.T) {
	c := newChatServer(t, withTmux())
	w := c.connect()
	ready := c.newChat(w, c.root)
	u := ready.ClaudeSessionID
	newID := newSID("hz")
	c.handoff(c.connect(), ready.SessionID, newID)
	waitCond(t, "terminal claude", func() bool { return len(c.env.LivePids(u)) == 1 && len(argvLaunches(t, c.env.ArgvLog)) == 2 })
	// Its first start wrote the transcript, so the reload resumes it.
	waitCond(t, "transcript", func() bool { _, ok := chat.FindTranscript(c.projects, u); return ok })
	var overlap, lost atomic.Bool
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			if len(c.env.LivePids(u)) > 1 {
				overlap.Store(true)
			}
			if _, err := c.mgr.CreateChat(session.ChatCreateOptions{ID: "", Workdir: c.root,
				Parsed: chat.Parsed{Exe: c.exe, Continue: true}}); err == nil {
				lost.Store(true)
			}
			time.Sleep(2 * time.Millisecond)
		}
	}()
	if code, _ := c.rest("POST", "/api/v1/sessions/"+newID+"/reload"); code != http.StatusNoContent {
		t.Fatalf("terminal reload %d", code)
	}
	waitCond(t, "relaunch", func() bool { return len(argvLaunches(t, c.env.ArgvLog)) >= 3 })
	close(stop)
	launch := argvLaunches(t, c.env.ArgvLog)[2]
	if !argHas(launch, "--resume", u) || argHas(launch, "-c", "") {
		t.Fatalf("reload argv %v", launch)
	}
	if overlap.Load() || lost.Load() {
		t.Fatalf("overlap %v, claim lost %v", overlap.Load(), lost.Load())
	}
	// The chat cannot restart while the terminal holds the conversation …
	if code, body := c.rest("POST", "/api/v1/sessions/"+ready.SessionID+"/reload"); code != http.StatusConflict ||
		body["error"] != protocol.ErrCodeClaudeSessionBusy || body["owner"] != newID {
		t.Fatalf("chat reload %d %v", code, body)
	}
	// … and can once the terminal session is gone.
	if code, _ := c.rest("DELETE", "/api/v1/sessions/"+newID); code != http.StatusNoContent {
		t.Fatalf("delete terminal %d", code)
	}
	if code, _ := c.rest("POST", "/api/v1/sessions/"+ready.SessionID+"/reload"); code != http.StatusAccepted {
		t.Fatalf("chat reload after the terminal left %d", code)
	}
	sess := c.chatSession(ready.SessionID)
	waitCond(t, "chat restarted", func() bool { return sess.Snapshot().Status == protocol.ChatStatusIdle })
}

func TestTerminalContinueBusyWhenChatOwnsWS(t *testing.T) {
	c := newChatServer(t, withTmux())
	w := c.connect()
	ready := c.newChat(w, c.root)
	sendChat(w, "1", "echo hi")
	w.waitFor("reply", func(fs []wsFrame) bool { return results(fs) == 1 })
	// A terminal that continues the directory's latest conversation.
	c.cfg.ClaudeCmd = c.exe + " -c"
	tw := c.connect()
	e := expectAttachError(t, tw, protocol.AttachFrame{NewSessionID: newSID("tc"), Workdir: c.root})
	if e.Code != protocol.ErrCodeClaudeSessionBusy || !e.Fatal || !strings.Contains(e.Message, filepath.Base(c.root)) {
		t.Fatalf("attach %+v", e)
	}
	// A terminal running something else holds nothing; reloading it with -c
	// targets the chat's conversation, which is busy.
	c.cfg.ClaudeCmd = "sleep 30"
	plainID := newSID("tp")
	pw := c.connect()
	pw.send(protocol.AttachFrame{Type: protocol.TypeAttach, NewSessionID: plainID, Workdir: c.root, Cols: 80, Rows: 24})
	pw.waitFor("ready", func(fs []wsFrame) bool { return firstOf(fs, protocol.TypeReady) != nil })
	t.Cleanup(func() { c.mgr.Delete(plainID) })
	c.cfg.ClaudeReloadCmd = c.exe + " -c"
	code, body := c.rest("POST", "/api/v1/sessions/"+plainID+"/reload")
	if code != http.StatusConflict || body["error"] != protocol.ErrCodeClaudeSessionBusy || body["owner"] != ready.SessionID {
		t.Fatalf("terminal reload %d %v", code, body)
	}
}

func decodeB64(s string) string {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return ""
	}
	return string(b)
}

// A chat create while the daemon is shutting down is a transient failure:
// error shutting_down with fatal:false, so the client keeps its create (same
// newSessionId) and retries against the restarted daemon (G3).
func TestCreateChatDuringShutdownIsRetryable(t *testing.T) {
	c := newChatServer(t)
	c.mgr.Shutdown(time.Second)
	w := c.connect()
	f := expectAttachError(t, w, protocol.AttachFrame{UI: protocol.UIChat, NewSessionID: newSID("chat"), Workdir: c.dir("p")})
	if f.Code != protocol.ErrCodeShuttingDown || f.Fatal {
		t.Fatalf("error during shutdown: %+v", f)
	}
}

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/config"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/session"
)

// Every route except /healthz is behind the main token. A hook token is only
// good for /api/v1/events (covered separately) — anywhere else it must be
// treated like any other wrong token.
func TestRESTAuthMatrix(t *testing.T) {
	s := newTestServer()
	hookToken := session.HookToken(s.cfg.Token, "s1")
	routes := []struct{ method, path, body string }{
		{http.MethodGet, "/api/v1/info", ""},
		{http.MethodGet, "/api/v1/sessions", ""},
		{http.MethodDelete, "/api/v1/sessions/s1", ""},
		{http.MethodPost, "/api/v1/sessions/s1/rename", `{"name":"x"}`},
		{http.MethodPost, "/api/v1/sessions/s1/reload", ""},
		{http.MethodGet, "/api/v1/fs?path=/tmp", ""},
		{http.MethodPost, "/api/v1/events", `{"sessionId":"s1","kind":"idle"}`},
	}
	auths := []struct{ name, header string }{
		{"no token", ""},
		{"wrong token", "Bearer wrong"},
		{"bare token without Bearer", s.cfg.Token},
	}
	for _, rt := range routes {
		for _, a := range auths {
			t.Run(rt.method+" "+rt.path+" "+a.name, func(t *testing.T) {
				if code := serve(s, rt.method, rt.path, rt.body, a.header).Code; code != http.StatusUnauthorized {
					t.Fatalf("code = %d, want 401", code)
				}
			})
		}
		if rt.path == "/api/v1/events" {
			continue
		}
		t.Run(rt.method+" "+rt.path+" hook token", func(t *testing.T) {
			if code := serve(s, rt.method, rt.path, rt.body, "Bearer "+hookToken).Code; code != http.StatusUnauthorized {
				t.Fatalf("code = %d, want 401", code)
			}
		})
	}

	if code := serve(s, http.MethodGet, "/healthz", "", "").Code; code != http.StatusOK {
		t.Fatalf("/healthz code = %d, want 200 without a token", code)
	}
}

func serve(s *Server, method, path, body, auth string) *httptest.ResponseRecorder {
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	if auth != "" {
		r.Header.Set("Authorization", auth)
	}
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, r)
	return w
}

func TestEventsAcceptsHookTokenForItsOwnSession(t *testing.T) {
	s := newTestServer()
	ch, unsub := s.mgr.Subscribe("s1")
	defer unsub()

	w := serve(s, http.MethodPost, "/api/v1/events", `{"sessionId":"s1","kind":"idle"}`,
		"Bearer "+session.HookToken(s.cfg.Token, "s1"))
	if w.Code != http.StatusNoContent {
		t.Fatalf("code = %d, want 204; body=%s", w.Code, w.Body.String())
	}
	select {
	case f := <-ch:
		if f.SessionID != "s1" || f.Kind != "idle" {
			t.Fatalf("frame = %+v", f)
		}
	case <-time.After(time.Second):
		t.Fatal("event not delivered")
	}
}

// A leaked hook token must not let its holder spoof events for other sessions.
func TestEventsRejectsHookTokenForAnotherSession(t *testing.T) {
	s := newTestServer()
	ch, unsub := s.mgr.Subscribe("s2")
	defer unsub()

	w := serve(s, http.MethodPost, "/api/v1/events", `{"sessionId":"s2","kind":"idle"}`,
		"Bearer "+session.HookToken(s.cfg.Token, "s1"))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d, want 401", w.Code)
	}
	select {
	case f := <-ch:
		t.Fatalf("event leaked to s2: %+v", f)
	default:
	}
}

func TestEventsInputLimits(t *testing.T) {
	s := newTestServer()
	main := "Bearer " + s.cfg.Token
	tests := []struct {
		name, body, auth string
		want             int
	}{
		{"kind too long", `{"sessionId":"s1","kind":"` + strings.Repeat("k", maxEventKind+1) + `"}`, main, http.StatusBadRequest},
		{"kind at limit", `{"sessionId":"s1","kind":"` + strings.Repeat("k", maxEventKind) + `"}`, main, http.StatusNoContent},
		{"message too long", `{"sessionId":"s1","kind":"idle","message":"` + strings.Repeat("m", maxEventMessage+1) + `"}`, main, http.StatusBadRequest},
		{"message at limit", `{"sessionId":"s1","kind":"idle","message":"` + strings.Repeat("m", maxEventMessage) + `"}`, main, http.StatusNoContent},
		{"body over 64KiB", `{"sessionId":"s1","kind":"idle","message":"` + strings.Repeat("m", maxRESTBody) + `"}`, main, http.StatusRequestEntityTooLarge},
		{"malformed body, authorized", `{`, main, http.StatusBadRequest},
		// Decoding happens before auth, but an unauthorized caller must still
		// see 401 rather than learn anything from a 400.
		{"malformed body, unauthorized", `{`, "Bearer wrong", http.StatusUnauthorized},
		{"oversized body, unauthorized", strings.Repeat("x", maxRESTBody+1), "", http.StatusUnauthorized},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if code := serve(s, http.MethodPost, "/api/v1/events", tt.body, tt.auth).Code; code != tt.want {
				t.Fatalf("code = %d, want %d", code, tt.want)
			}
		})
	}
}

func TestRenameStatusCodes(t *testing.T) {
	s := newTestServer()
	auth := "Bearer " + s.cfg.Token
	if code := serve(s, http.MethodPost, "/api/v1/sessions/missing/rename", `{"name":"x"}`, auth).Code; code != http.StatusNotFound {
		t.Fatalf("unknown session: code = %d, want 404", code)
	}

	// An existing session whose rename fails (no tmux here) is a server-side
	// error, not "not found" — a 404 made the client drop a live session.
	r, err := s.mgr.Create(session.CreateOptions{Workdir: t.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.mgr.Delete(r.ID) })
	if code := serve(s, http.MethodPost, "/api/v1/sessions/"+r.ID+"/rename", `{"name":"x"}`, auth).Code; code != http.StatusInternalServerError {
		t.Fatalf("rename failure: code = %d, want 500", code)
	}

	big := `{"name":"` + strings.Repeat("n", maxRESTBody) + `"}`
	if code := serve(s, http.MethodPost, "/api/v1/sessions/"+r.ID+"/rename", big, auth).Code; code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body: code = %d, want 413", code)
	}
}

func TestInfoReportsVersion(t *testing.T) {
	cfg := &config.Config{Token: "secret"}
	for _, tt := range []struct {
		name string
		opts []Option
		want string
	}{
		{"default", nil, "dev"},
		{"injected", []Option{WithVersion("v1.2.3")}, "v1.2.3"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s := New(cfg, nil, tt.opts...)
			w := serve(s, http.MethodGet, "/api/v1/info", "", "Bearer secret")
			var body map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body["version"] != tt.want {
				t.Fatalf("version = %v, want %q", body["version"], tt.want)
			}
		})
	}
}

// A symlink inside an allowed root that points outside it must not be
// listable — ResolveAllowedWorkdir resolves it before the containment check.
func TestFSRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "alias")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	s := New(&config.Config{Token: "secret", AllowedRoots: []string{root}}, nil)

	code, body := fsListing(t, s, link)
	if code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body=%v", code, body)
	}
}

// --- WebSocket handshake ---

func newWSTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	root := t.TempDir()
	cfg := &config.Config{Token: "secret", AllowedRoots: []string{root}, DefaultWorkdir: root}
	s := New(cfg, session.NewManager(false, "/bin/cat", false, ""))
	ts := httptest.NewServer(s.mux)
	t.Cleanup(ts.Close)
	return s, "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
}

func dialWS(t *testing.T, url string) (*websocket.Conn, context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return conn, ctx
}

// expectErrorThenClose reads an error frame containing wantMsg, then expects
// the server to close with wantStatus.
func expectErrorThenClose(t *testing.T, ctx context.Context, conn *websocket.Conn, wantMsg string, wantStatus websocket.StatusCode) {
	t.Helper()
	var frame protocol.ErrorFrame
	if err := wsjson.Read(ctx, conn, &frame); err != nil {
		t.Fatalf("read error frame: %v", err)
	}
	if frame.Type != protocol.TypeError || !strings.Contains(frame.Message, wantMsg) {
		t.Fatalf("frame = %+v, want error containing %q", frame, wantMsg)
	}
	_, _, err := conn.Read(ctx)
	if got := websocket.CloseStatus(err); got != wantStatus {
		t.Fatalf("close status = %v (err %v), want %v", got, err, wantStatus)
	}
}

func TestWSRejectsWrongToken(t *testing.T) {
	_, url := newWSTestServer(t)
	conn, ctx := dialWS(t, url)
	if err := wsjson.Write(ctx, conn, protocol.AuthFrame{Type: protocol.TypeAuth, Token: "wrong"}); err != nil {
		t.Fatal(err)
	}
	expectErrorThenClose(t, ctx, conn, "invalid token", websocket.StatusPolicyViolation)
}

// The hook token is for the events endpoint only; it must not open a terminal.
func TestWSRejectsHookToken(t *testing.T) {
	s, url := newWSTestServer(t)
	conn, ctx := dialWS(t, url)
	if err := wsjson.Write(ctx, conn, protocol.AuthFrame{Type: protocol.TypeAuth, Token: session.HookToken(s.cfg.Token, "s1")}); err != nil {
		t.Fatal(err)
	}
	expectErrorThenClose(t, ctx, conn, "invalid token", websocket.StatusPolicyViolation)
}

func TestWSRejectsFirstFrameThatIsNotAuth(t *testing.T) {
	_, url := newWSTestServer(t)
	conn, ctx := dialWS(t, url)
	if err := wsjson.Write(ctx, conn, protocol.AttachFrame{Type: protocol.TypeAttach, Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	expectErrorThenClose(t, ctx, conn, "invalid token", websocket.StatusPolicyViolation)
}

// Before auth the read limit is 64 KiB, so an unauthenticated peer can't make
// the daemon buffer a multi-megabyte frame.
func TestWSRejectsOversizedPreAuthFrame(t *testing.T) {
	_, url := newWSTestServer(t)
	conn, ctx := dialWS(t, url)
	big := bytes.Repeat([]byte("x"), 65<<10)
	_ = conn.Write(ctx, websocket.MessageText, big)
	_, _, err := conn.Read(ctx)
	if got := websocket.CloseStatus(err); got != websocket.StatusMessageTooBig {
		t.Fatalf("close status = %v (err %v), want %v", got, err, websocket.StatusMessageTooBig)
	}
}

func TestWSRejectsWorkdirOutsideAllowedRoots(t *testing.T) {
	s, url := newWSTestServer(t)
	conn, ctx := dialWS(t, url)
	if err := wsjson.Write(ctx, conn, protocol.AuthFrame{Type: protocol.TypeAuth, Token: s.cfg.Token}); err != nil {
		t.Fatal(err)
	}
	var sessions protocol.SessionsFrame
	if err := wsjson.Read(ctx, conn, &sessions); err != nil || sessions.Type != protocol.TypeSessions {
		t.Fatalf("expected initial sessions frame, got %+v (err %v)", sessions, err)
	}
	if err := wsjson.Write(ctx, conn, protocol.AttachFrame{Type: protocol.TypeAttach, Workdir: t.TempDir(), Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	expectErrorThenClose(t, ctx, conn, "workdir not in allowed roots", websocket.StatusPolicyViolation)
}

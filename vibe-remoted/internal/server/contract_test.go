package server

import (
	"context"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/config"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/session"
)

// authed dials, authenticates and consumes the initial sessions frame.
func authed(t *testing.T, s *Server, url string) (*websocket.Conn, context.Context) {
	t.Helper()
	conn, ctx := dialWS(t, url)
	if err := wsjson.Write(ctx, conn, protocol.AuthFrame{Type: protocol.TypeAuth, Token: s.cfg.Token}); err != nil {
		t.Fatal(err)
	}
	var sessions protocol.SessionsFrame
	if err := wsjson.Read(ctx, conn, &sessions); err != nil || sessions.Type != protocol.TypeSessions {
		t.Fatalf("expected initial sessions frame, got %+v (err %v)", sessions, err)
	}
	return conn, ctx
}

func readError(t *testing.T, ctx context.Context, conn *websocket.Conn) protocol.ErrorFrame {
	t.Helper()
	var frame protocol.ErrorFrame
	if err := wsjson.Read(ctx, conn, &frame); err != nil {
		t.Fatalf("read error frame: %v", err)
	}
	if frame.Type != protocol.TypeError {
		t.Fatalf("frame = %+v, want an error frame", frame)
	}
	return frame
}

// The client stops reconnecting on fatal errors and keeps retrying the rest,
// so every rejection has to carry the right code and fatal flag.
func TestWSErrorsCarryCodeAndFatal(t *testing.T) {
	t.Run("wrong token", func(t *testing.T) {
		_, url := newWSTestServer(t)
		conn, ctx := dialWS(t, url)
		wsjson.Write(ctx, conn, protocol.AuthFrame{Type: protocol.TypeAuth, Token: "wrong"})
		if f := readError(t, ctx, conn); f.Code != protocol.ErrCodeAuthFailed || !f.Fatal {
			t.Fatalf("got %+v, want fatal %s", f, protocol.ErrCodeAuthFailed)
		}
	})
	t.Run("workdir outside roots", func(t *testing.T) {
		s, url := newWSTestServer(t)
		conn, ctx := authed(t, s, url)
		wsjson.Write(ctx, conn, protocol.AttachFrame{Type: protocol.TypeAttach, Workdir: t.TempDir(), Cols: 80, Rows: 24})
		if f := readError(t, ctx, conn); f.Code != protocol.ErrCodeInvalidWorkdir || !f.Fatal {
			t.Fatalf("got %+v, want fatal %s", f, protocol.ErrCodeInvalidWorkdir)
		}
	})
	t.Run("malformed newSessionId", func(t *testing.T) {
		s, url := newWSTestServer(t)
		conn, ctx := authed(t, s, url)
		wsjson.Write(ctx, conn, protocol.AttachFrame{Type: protocol.TypeAttach, NewSessionID: "../escape", Cols: 80, Rows: 24})
		if f := readError(t, ctx, conn); f.Code != protocol.ErrCodeInvalidID || !f.Fatal {
			t.Fatalf("got %+v, want fatal %s", f, protocol.ErrCodeInvalidID)
		}
	})
	t.Run("unknown session", func(t *testing.T) {
		s, url := newWSTestServer(t)
		conn, ctx := authed(t, s, url)
		wsjson.Write(ctx, conn, protocol.AttachFrame{Type: protocol.TypeAttach, SessionID: "gone", Cols: 80, Rows: 24})
		if f := readError(t, ctx, conn); f.Code != protocol.ErrCodeSessionNotFound || !f.Fatal {
			t.Fatalf("got %+v, want fatal %s", f, protocol.ErrCodeSessionNotFound)
		}
	})
}

func TestReadyReportsProtocolVersion(t *testing.T) {
	s, url := newWSTestServer(t)
	conn, ctx := authed(t, s, url)
	if err := wsjson.Write(ctx, conn, protocol.AttachFrame{Type: protocol.TypeAttach, Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	var ready protocol.ReadyFrame
	if err := wsjson.Read(ctx, conn, &ready); err != nil || ready.Type != protocol.TypeReady {
		t.Fatalf("expected ready, got %+v (err %v)", ready, err)
	}
	if ready.Proto != protocol.Version {
		t.Fatalf("ready.proto = %d, want %d", ready.Proto, protocol.Version)
	}
}

// End to end over the socket: an attach replayed with the same newSessionId
// after the first connection died must resume that session, not create one.
func TestWSReplayedCreateResumesSameSession(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		if os.Getenv("VIBE_REMOTE_REQUIRE_TMUX") == "1" {
			t.Fatal("tmux is not installed but VIBE_REMOTE_REQUIRE_TMUX=1")
		}
		t.Skip("tmux is not installed")
	}
	root := t.TempDir()
	cfg := &config.Config{Token: "secret", AllowedRoots: []string{root}, DefaultWorkdir: root}
	s := New(cfg, session.NewManager(true, "sleep 30", false, ""))
	ts := httptest.NewServer(s.mux)
	t.Cleanup(ts.Close)
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"

	id := fmt.Sprintf("ws-idem-%d", time.Now().UnixNano())
	t.Cleanup(func() { s.mgr.Delete(id) })
	attach := protocol.AttachFrame{Type: protocol.TypeAttach, NewSessionID: id, Workdir: root, Cols: 80, Rows: 24}

	for attempt := 0; attempt < 2; attempt++ {
		conn, ctx := authed(t, s, url)
		if err := wsjson.Write(ctx, conn, attach); err != nil {
			t.Fatal(err)
		}
		var ready protocol.ReadyFrame
		if err := wsjson.Read(ctx, conn, &ready); err != nil || ready.Type != protocol.TypeReady {
			t.Fatalf("attempt %d: expected ready, got %+v (err %v)", attempt, ready, err)
		}
		if ready.SessionID != id {
			t.Fatalf("attempt %d: sessionId = %q, want %q", attempt, ready.SessionID, id)
		}
		conn.CloseNow()
	}
	if n := len(s.mgr.List()); n != 1 {
		t.Fatalf("sessions after replay = %d, want 1", n)
	}
}

// A client that stops answering pings (half-open TCP: lid closed, network
// changed) must be dropped so its relay and tmux attach don't linger forever.
func TestRelayDropsClientThatStopsAnsweringPings(t *testing.T) {
	s, url := newWSTestServer(t)
	s.pingInterval = 50 * time.Millisecond
	s.pongTimeout = 100 * time.Millisecond

	conn, ctx := authed(t, s, url)
	if err := wsjson.Write(ctx, conn, protocol.AttachFrame{Type: protocol.TypeAttach, Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	var ready protocol.ReadyFrame
	if err := wsjson.Read(ctx, conn, &ready); err != nil || ready.Type != protocol.TypeReady {
		t.Fatalf("expected ready, got %+v (err %v)", ready, err)
	}
	// Stop reading: coder/websocket only answers pings from inside Read, so
	// this client now looks exactly like a dead peer to the server.
	time.Sleep(600 * time.Millisecond)

	// By now the server must have given up and closed the connection. A live
	// relay would instead leave this Read blocked until the context expires.
	readCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	for {
		_, _, err := conn.Read(readCtx)
		if err == nil {
			continue // buffered output from before the drop
		}
		if readCtx.Err() != nil {
			t.Fatal("relay still attached to a client that never answered a ping")
		}
		return
	}
}

// A connection that authenticates and then goes silent before attaching is
// dropped after the idle timeout instead of holding a goroutine forever.
func TestIdleConnectionBeforeAttachIsDropped(t *testing.T) {
	s, url := newWSTestServer(t)
	s.idleReadTimeout = 100 * time.Millisecond
	conn, ctx := authed(t, s, url)
	readCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if _, _, err := conn.Read(readCtx); err == nil || readCtx.Err() != nil {
		t.Fatalf("server kept a silent pre-attach connection open (err %v)", err)
	}
}

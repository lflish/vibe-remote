package server

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/config"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/session"
)

func newTestServer() *Server {
	cfg := &config.Config{Token: "secret", BindAddr: "100.64.0.1", Port: 8765}
	mgr := session.NewManager(false, "/bin/bash", false, "")
	return New(cfg, mgr)
}

func TestEventsRejectsBadToken(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("POST", "/api/v1/events",
		bytes.NewBufferString(`{"sessionId":"s1","kind":"idle"}`))
	req.Header.Set("Authorization", "Bearer wrong")
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("code = %d, want 401", w.Code)
	}
}

func TestEventsRoutesToSubscriber(t *testing.T) {
	s := newTestServer()
	ch, unsub := s.mgr.Subscribe("s1")
	defer unsub()

	req := httptest.NewRequest("POST", "/api/v1/events",
		bytes.NewBufferString(`{"sessionId":"s1","kind":"waiting","message":"hi"}`))
	req.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("code = %d, want 204", w.Code)
	}

	select {
	case f := <-ch:
		if f.Kind != "waiting" || f.SessionID != "s1" {
			t.Errorf("frame = %+v, want kind=waiting sessionId=s1", f)
		}
		if f.Type != protocol.TypeNotify {
			t.Errorf("type = %q, want notify", f.Type)
		}
	case <-time.After(time.Second):
		t.Fatal("event not delivered to subscriber")
	}
}

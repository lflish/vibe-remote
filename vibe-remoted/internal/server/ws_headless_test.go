package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/config"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/session"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func TestWSHeadlessRelay(t *testing.T) {
	tmp := t.TempDir()
	// Stub claude: emit two NDJSON lines regardless of flags/stdin.
	cfg := &config.Config{
		BindAddr: "127.0.0.1", Port: 0, Token: "tok",
		DefaultWorkdir: tmp, AllowedRoots: []string{tmp},
		UseTmux:   false,
		ClaudeCmd: `printf '{"type":"stream_event"}\n{"type":"result"}\n'; true #`,
	}
	lf := false
	cfg.LoginShell = &lf
	mgr := session.NewManager(cfg.UseTmux, cfg.ClaudeCmd, cfg.UseLoginShell(), cfg.LoginShellPath())
	srv := New(cfg, mgr)

	ts := httptest.NewServer(withCORS(srv.mux))
	defer ts.Close()
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	// auth
	wsjson.Write(ctx, conn, protocol.AuthFrame{Type: protocol.TypeAuth, Token: "tok"})

	// The server pushes a sessions frame first; read and ignore until we can attach.
	// attach headless
	wsjson.Write(ctx, conn, protocol.AttachFrame{
		Type: protocol.TypeAttach, Workdir: tmp, Mode: protocol.ModeHeadless,
	})

	// Expect a ready frame, then send a prompt, then receive NDJSON data frames.
	sawReady := false
	var gotLines []string
	deadline := time.Now().Add(8 * time.Second)
	sentPrompt := false
	for time.Now().Before(deadline) {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			break
		}
		var f protocol.Frame
		json.Unmarshal(raw, &f)
		switch f.Type {
		case protocol.TypeReady:
			sawReady = true
			// send a user prompt as a base64 data frame
			wsjson.Write(ctx, conn, protocol.DataFrame{
				Type:    protocol.TypeData,
				Payload: base64.StdEncoding.EncodeToString([]byte("hi")),
			})
			sentPrompt = true
		case protocol.TypeData:
			var df protocol.DataFrame
			json.Unmarshal(raw, &df)
			dec, _ := base64.StdEncoding.DecodeString(df.Payload)
			gotLines = append(gotLines, string(dec))
		}
		if sentPrompt && len(gotLines) >= 2 {
			break
		}
	}

	if !sawReady {
		t.Fatal("never received ready frame")
	}
	// The server must re-add the trailing '\n' that bufio.Scanner strips, so the
	// client's NDJSON line-splitter can find line boundaries across frames.
	if len(gotLines) < 2 || gotLines[0] != "{\"type\":\"stream_event\"}\n" {
		t.Fatalf("unexpected NDJSON data frames: %q", gotLines)
	}
	_ = os.Stdout
}

func TestWSHeadlessWorkdirRejected(t *testing.T) {
	tmp := t.TempDir()
	cfg := &config.Config{
		BindAddr: "127.0.0.1", Port: 0, Token: "tok",
		DefaultWorkdir: tmp, AllowedRoots: []string{tmp},
		UseTmux: false, ClaudeCmd: "true",
	}
	lf := false
	cfg.LoginShell = &lf
	mgr := session.NewManager(cfg.UseTmux, cfg.ClaudeCmd, cfg.UseLoginShell(), cfg.LoginShellPath())
	srv := New(cfg, mgr)
	ts := httptest.NewServer(withCORS(srv.mux))
	defer ts.Close()
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	wsjson.Write(ctx, conn, protocol.AuthFrame{Type: protocol.TypeAuth, Token: "tok"})
	wsjson.Write(ctx, conn, protocol.AttachFrame{
		Type: protocol.TypeAttach, Workdir: "/etc", Mode: protocol.ModeHeadless,
	})

	// Expect an error frame (workdir not allowed).
	sawError := false
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			break
		}
		var f protocol.Frame
		json.Unmarshal(raw, &f)
		if f.Type == protocol.TypeError {
			sawError = true
			break
		}
	}
	if !sawError {
		t.Fatal("expected error frame for disallowed workdir")
	}
	_ = http.StatusOK
}

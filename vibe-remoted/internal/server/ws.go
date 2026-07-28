package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// handleWS upgrades to WebSocket and drives the headless chat loop.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Origin check is skipped: the Electron client connects from a different
		// origin (file:// or the Vite dev server), and the daemon binds a
		// private-network address, not the public internet. The static token is
		// the primary guard (plus WireGuard when bound to a tailscale IP).
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Printf("ws accept: %v", err)
		return
	}
	defer conn.CloseNow()

	// Raise the read limit well above the 32 KiB default: a large paste arrives
	// as one base64 `data` frame and would otherwise trip the limit and drop
	// the connection mid-paste. 4 MiB covers realistic pastes.
	conn.SetReadLimit(4 << 20)

	ctx := r.Context()

	// Phase 1: Auth
	if !s.wsAuth(ctx, conn) {
		return
	}

	// Phase 2: Read attach (answer pings while idle)
	frame, ok := s.wsReadAttach(ctx, conn)
	if !ok {
		return
	}

	// Phase 3: Headless chat loop (the only line).
	s.wsHeadless(ctx, conn, frame)
}

// wsAuth waits for the auth frame and validates the token.
func (s *Server) wsAuth(ctx context.Context, conn *websocket.Conn) bool {
	// Set a deadline for auth
	authCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	var frame protocol.AuthFrame
	if err := wsjson.Read(authCtx, conn, &frame); err != nil {
		sendError(ctx, conn, "auth timeout or invalid frame")
		conn.Close(websocket.StatusPolicyViolation, "auth failed")
		return false
	}

	if frame.Type != protocol.TypeAuth || !tokenEqual(frame.Token, s.cfg.Token) {
		sendError(ctx, conn, "invalid token")
		conn.Close(websocket.StatusPolicyViolation, "auth failed")
		return false
	}

	return true
}

// wsReadAttach reads frames until an attach arrives (answering pings during the
// idle window). Returns the attach frame, or ok=false if the client
// disconnected first.
func (s *Server) wsReadAttach(ctx context.Context, conn *websocket.Conn) (protocol.AttachFrame, bool) {
	var frame protocol.AttachFrame
	for {
		if err := wsjson.Read(ctx, conn, &frame); err != nil {
			// Client disconnected while idle — expected, not an error.
			return protocol.AttachFrame{}, false
		}
		if frame.Type == protocol.TypePing {
			wsjson.Write(ctx, conn, protocol.Frame{Type: protocol.TypePong})
			continue
		}
		if frame.Type == protocol.TypeAttach {
			return frame, true
		}
		// Ignore other frames while waiting for attach.
	}
}

// wsHeadless drives the headless chat line. Each data frame from the client is
// a user prompt (base64 text); the server runs one `claude -c -p` turn in the
// workdir and forwards claude's NDJSON stdout line-by-line as data frames. The
// turn runs in a goroutine so the read loop keeps answering pings and can
// cancel the turn if the client disconnects. Stateless by design: continuity
// is claude's own -c over the shared jsonl ("refresh = -c").
func (s *Server) wsHeadless(ctx context.Context, conn *websocket.Conn, frame protocol.AttachFrame) {
	workdir := frame.Workdir
	if workdir == "" {
		workdir = s.cfg.DefaultWorkdir
	}
	if !s.cfg.IsAllowedWorkdir(workdir) {
		sendError(ctx, conn, "workdir not in allowed roots")
		conn.Close(websocket.StatusPolicyViolation, "bad workdir")
		return
	}

	// Identity for headless is just the workdir; echo it back so the client
	// shows the chat for this directory.
	wsjson.Write(ctx, conn, protocol.ReadyFrame{
		Type:    protocol.TypeReady,
		Workdir: workdir,
	})

	runner := s.mgr.NewHeadless(workdir)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var busy atomic.Bool

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			// Client disconnected — cancel any in-flight turn and return.
			return
		}
		var f protocol.Frame
		if err := json.Unmarshal(data, &f); err != nil {
			continue
		}
		switch f.Type {
		case protocol.TypeData:
			if busy.Load() {
				// One turn at a time; ignore input while a turn is streaming.
				continue
			}
			var df protocol.DataFrame
			if err := json.Unmarshal(data, &df); err != nil {
				continue
			}
			prompt, err := base64.StdEncoding.DecodeString(df.Payload)
			if err != nil {
				continue
			}
			busy.Store(true)
			go func() {
				defer busy.Store(false)
				_, runErr := runner.RunTurn(ctx, string(prompt), func(line []byte) {
					// bufio.Scanner (ScanLines) strips the trailing '\n'; restore it
					// so the client's NDJSON line-splitter can find line boundaries
					// across frames. `line` is a per-line copy (see RunTurn's onLine),
					// so appending here does not touch the scanner's buffer. Pure
					// transport: we re-add the delimiter, never parse the content.
					wsjson.Write(ctx, conn, protocol.DataFrame{
						Type:    protocol.TypeData,
						Payload: base64.StdEncoding.EncodeToString(append(line, '\n')),
					})
				})
				if runErr != nil {
					sendError(ctx, conn, "headless turn: "+runErr.Error())
				}
			}()

		case protocol.TypePing:
			wsjson.Write(ctx, conn, protocol.Frame{Type: protocol.TypePong})

		default:
			// ignore
		}
	}
}

// sendError writes an error frame to the WebSocket.
func sendError(ctx context.Context, conn *websocket.Conn, msg string) {
	wsjson.Write(ctx, conn, protocol.ErrorFrame{
		Type:    protocol.TypeError,
		Message: msg,
	})
}

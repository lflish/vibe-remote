package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/anthropic/vibe-remote/vibe-remoted/internal/protocol"
	"github.com/anthropic/vibe-remote/vibe-remoted/internal/session"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// handleWS upgrades to WebSocket and manages the session lifecycle.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Origin check is skipped: vibe-remoted is tailnet-only (not public) and
		// the Electron client connects from a different origin (file:// or the
		// Vite dev server). WireGuard + the static token are the real guards.
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Printf("ws accept: %v", err)
		return
	}
	defer conn.CloseNow()

	// Raise the read limit well above the 32 KiB default: a large terminal
	// paste arrives as one base64 `data` frame and would otherwise trip the
	// limit and drop the connection mid-paste. 4 MiB covers realistic pastes.
	conn.SetReadLimit(4 << 20)

	ctx := r.Context()

	// Phase 1: Auth
	if !s.wsAuth(ctx, conn) {
		return
	}

	// Phase 2: Attach
	runner, sessionID := s.wsAttach(ctx, conn)
	if runner == nil {
		return
	}

	// Phase 3: Bidirectional data relay
	s.wsRelay(ctx, conn, runner, sessionID)
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

	if frame.Type != protocol.TypeAuth || frame.Token != s.cfg.Token {
		sendError(ctx, conn, "invalid token")
		conn.Close(websocket.StatusPolicyViolation, "auth failed")
		return false
	}

	return true
}

// wsAttach waits for an attach frame and creates or resumes a session.
// After auth the client may stay idle (browsing sessions) before attaching,
// so there is no short timeout here — the connection lives until the client
// sends attach or disconnects. ping/pong frames received while waiting are
// answered so keepalive works during the idle window.
func (s *Server) wsAttach(ctx context.Context, conn *websocket.Conn) (*session.Runner, string) {
	// Push the current session list so the client can populate its sidebar
	// and let the user pick a session (or create a new one) before attaching.
	wsjson.Write(ctx, conn, protocol.SessionsFrame{
		Type: protocol.TypeSessions,
		List: s.mgr.List(),
	})

	var frame protocol.AttachFrame
	for {
		if err := wsjson.Read(ctx, conn, &frame); err != nil {
			// Client disconnected while idle — expected, not an error.
			return nil, ""
		}
		if frame.Type == protocol.TypePing {
			wsjson.Write(ctx, conn, protocol.Frame{Type: protocol.TypePong})
			continue
		}
		if frame.Type == protocol.TypeAttach {
			break
		}
		// Ignore other frames while waiting for attach.
	}

	var runner *session.Runner
	var err error

	if frame.SessionID == "" {
		// New session — resolve workdir
		workdir := frame.Workdir
		log.Printf("attach new session: requested workdir=%q", frame.Workdir)
		if workdir == "" {
			workdir = s.cfg.DefaultWorkdir
		}
		if !s.cfg.IsAllowedWorkdir(workdir) {
			sendError(ctx, conn, "workdir not in allowed roots")
			conn.Close(websocket.StatusPolicyViolation, "bad workdir")
			return nil, ""
		}

		runner, err = s.mgr.Create(workdir, frame.Cols, frame.Rows)
		if err != nil {
			sendError(ctx, conn, "create session: "+err.Error())
			conn.Close(websocket.StatusInternalError, "create failed")
			return nil, ""
		}
	} else {
		// Resume existing session
		runner, err = s.mgr.Attach(frame.SessionID, frame.Cols, frame.Rows)
		if err != nil {
			sendError(ctx, conn, "attach session: "+err.Error())
			conn.Close(websocket.StatusInternalError, "attach failed")
			return nil, ""
		}
	}

	// Send ready
	ready := protocol.ReadyFrame{
		Type:      protocol.TypeReady,
		SessionID: runner.ID,
		Workdir:   runner.Workdir,
	}
	if err := wsjson.Write(ctx, conn, ready); err != nil {
		log.Printf("ws write ready: %v", err)
		return nil, ""
	}

	// Push the current session list so the client's sidebar stays in sync
	// without needing a separate REST poll after each attach.
	wsjson.Write(ctx, conn, protocol.SessionsFrame{
		Type: protocol.TypeSessions,
		List: s.mgr.List(),
	})

	return runner, runner.ID
}

// wsRelay relays data bidirectionally between WebSocket and PTY.
func (s *Server) wsRelay(ctx context.Context, conn *websocket.Conn, runner *session.Runner, sessionID string) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Capture the PTY epoch we own. On teardown we only detach if we still own
	// it, so a reconnect that already installed a newer PTY isn't clobbered.
	epoch := runner.CurrentEpoch()

	// Subscribe to out-of-band notify events for this session and forward them
	// to the client as notify frames. Unsubscribe on teardown so we don't leak.
	// coder/websocket serializes concurrent writes internally (only one writer
	// at a time), so this forwarder writing alongside the PTY→WS goroutine on
	// the same conn is safe without extra locking. The forwarder exits when
	// unsub closes notifyCh (close happens under Manager's write lock).
	notifyCh, unsub := s.mgr.Subscribe(sessionID)
	defer unsub()
	go func() {
		for f := range notifyCh {
			if err := wsjson.Write(ctx, conn, f); err != nil {
				return
			}
		}
	}()

	// detaching signals the PTY→WS goroutine that an error it sees is caused by
	// our own detach (client going away), not a real process exit — so it must
	// not send a spurious exit frame for a session that's still alive in tmux.
	var detaching atomic.Bool
	defer func() {
		detaching.Store(true)
		runner.DetachEpoch(epoch)
	}()

	// PTY → WebSocket (read from PTY, send to client)
	go func() {
		defer cancel()
		buf := make([]byte, 4096)
		for {
			n, err := runner.Read(buf)
			if err != nil {
				if detaching.Load() || ctx.Err() != nil {
					// PTY closed by our own teardown — session lives on in tmux,
					// this is not a process exit.
					return
				}
				if err != io.EOF {
					log.Printf("pty read [%s]: %v", sessionID, err)
				}
				// Genuine process exit: report it.
				wsjson.Write(ctx, conn, protocol.ExitFrame{
					Type: protocol.TypeExit,
					Code: runner.Wait(),
				})
				return
			}
			if n > 0 {
				dataFrame := protocol.DataFrame{
					Type:    protocol.TypeData,
					Payload: base64.StdEncoding.EncodeToString(buf[:n]),
				}
				if err := wsjson.Write(ctx, conn, dataFrame); err != nil {
					// Write failure means the client went away — expected on
					// disconnect. Stop the pump quietly; ctx cancel handles the rest.
					return
				}
			}
		}
	}()

	// WebSocket → PTY (read from client, write to PTY)
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			// Normal client disconnect (close frame, context cancel, or closed
			// conn) is expected — the tmux session stays alive for reconnect.
			// Only log genuinely unexpected errors.
			status := websocket.CloseStatus(err)
			if status == websocket.StatusNormalClosure ||
				status == websocket.StatusGoingAway ||
				status == websocket.StatusNoStatusRcvd ||
				ctx.Err() != nil {
				log.Printf("ws closed [%s] (client disconnect)", sessionID)
			} else {
				log.Printf("ws read [%s]: %v", sessionID, err)
			}
			return
		}

		// Parse the frame type
		var frame protocol.Frame
		if err := json.Unmarshal(data, &frame); err != nil {
			continue
		}

		switch frame.Type {
		case protocol.TypeData:
			var df protocol.DataFrame
			if err := json.Unmarshal(data, &df); err != nil {
				continue
			}
			decoded, err := base64.StdEncoding.DecodeString(df.Payload)
			if err != nil {
				continue
			}
			runner.Write(decoded)

		case protocol.TypeResize:
			var rf protocol.ResizeFrame
			if err := json.Unmarshal(data, &rf); err != nil {
				continue
			}
			runner.Resize(rf.Cols, rf.Rows)

		case protocol.TypePing:
			wsjson.Write(ctx, conn, protocol.Frame{Type: protocol.TypePong})

		default:
			log.Printf("ws unknown frame type [%s]: %s", sessionID, frame.Type)
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

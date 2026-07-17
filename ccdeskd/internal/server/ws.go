package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/anthropic/ccdesk/ccdeskd/internal/protocol"
	"github.com/anthropic/ccdesk/ccdeskd/internal/session"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// handleWS upgrades to WebSocket and manages the session lifecycle.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Allow all origins for now (tailnet-only, not public)
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Printf("ws accept: %v", err)
		return
	}
	defer conn.CloseNow()

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

// wsAttach handles the attach frame: creates or resumes a session.
func (s *Server) wsAttach(ctx context.Context, conn *websocket.Conn) (*session.Runner, string) {
	attachCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	var frame protocol.AttachFrame
	if err := wsjson.Read(attachCtx, conn, &frame); err != nil {
		sendError(ctx, conn, "attach timeout or invalid frame")
		conn.Close(websocket.StatusInvalidFramePayloadData, "bad attach")
		return nil, ""
	}

	if frame.Type != protocol.TypeAttach {
		sendError(ctx, conn, "expected attach frame")
		conn.Close(websocket.StatusInvalidFramePayloadData, "expected attach")
		return nil, ""
	}

	var runner *session.Runner
	var err error

	if frame.SessionID == "" {
		// New session — resolve workdir
		workdir := frame.Workdir
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

	return runner, runner.ID
}

// wsRelay relays data bidirectionally between WebSocket and PTY.
func (s *Server) wsRelay(ctx context.Context, conn *websocket.Conn, runner *session.Runner, sessionID string) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer runner.Detach()

	// PTY → WebSocket (read from PTY, send to client)
	go func() {
		defer cancel()
		buf := make([]byte, 4096)
		for {
			n, err := runner.Read(buf)
			if err != nil {
				if err != io.EOF {
					log.Printf("pty read [%s]: %v", sessionID, err)
				}
				// Send exit frame
				exitCode := runner.Wait()
				wsjson.Write(ctx, conn, protocol.ExitFrame{
					Type: protocol.TypeExit,
					Code: exitCode,
				})
				return
			}
			if n > 0 {
				dataFrame := protocol.DataFrame{
					Type:    protocol.TypeData,
					Payload: base64.StdEncoding.EncodeToString(buf[:n]),
				}
				if err := wsjson.Write(ctx, conn, dataFrame); err != nil {
					log.Printf("ws write data [%s]: %v", sessionID, err)
					return
				}
			}
		}
	}()

	// WebSocket → PTY (read from client, write to PTY)
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			log.Printf("ws read [%s]: %v", sessionID, err)
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

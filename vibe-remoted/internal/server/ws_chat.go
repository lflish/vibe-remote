package server

import (
	"context"
	"encoding/json"
	"errors"
	"log"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/session"
)

// fail sends a fatal error frame and closes the connection.
func fail(ctx context.Context, conn *websocket.Conn, code, msg string) *attachment {
	sendError(ctx, conn, code, true, msg)
	conn.Close(websocket.StatusPolicyViolation, code)
	return nil
}

// failSession reports a Manager error: shutting_down is transient (the
// client keeps its attach and retries against the restarted daemon), every
// other code is fatal.
func failSession(ctx context.Context, conn *websocket.Conn, err error, msg string) *attachment {
	if errors.Is(err, session.ErrShuttingDown) {
		sendError(ctx, conn, protocol.ErrCodeShuttingDown, false, msg+err.Error())
		conn.Close(websocket.StatusGoingAway, protocol.ErrCodeShuttingDown)
		return nil
	}
	return fail(ctx, conn, sessionErrorCode(err), msg+err.Error())
}

// sessionErrorCode maps a Manager error to its fatal attach error code.
func sessionErrorCode(err error) string {
	switch {
	case errors.Is(err, session.ErrSessionNotFound):
		return protocol.ErrCodeSessionNotFound
	case errors.Is(err, session.ErrUIMismatch):
		return protocol.ErrCodeUIMismatch
	case errors.Is(err, session.ErrClaudeSessionBusy):
		return protocol.ErrCodeClaudeSessionBusy
	case errors.Is(err, session.ErrInvalidSessionID):
		return protocol.ErrCodeInvalidID
	}
	if code := worktreeErrorCode(err); code != "" {
		return code
	}
	return protocol.ErrCodeCreateFailed
}

// wsCreateChat creates a chat session (design 6.2). Only the server builds
// the command: claude_cmd plus whitelisted flags; the attach frame names flag
// ids only, and any other field is ignored.
func (s *Server) wsCreateChat(ctx context.Context, conn *websocket.Conn, frame protocol.AttachFrame) *attachment {
	workdir := frame.Workdir
	if workdir == "" {
		workdir = s.cfg.DefaultWorkdir
	}
	workdir, err := s.cfg.ResolveAllowedWorkdir(workdir)
	if err != nil {
		sendError(ctx, conn, protocol.ErrCodeInvalidWorkdir, true, "workdir not in allowed roots")
		conn.Close(websocket.StatusPolicyViolation, "bad workdir")
		return nil
	}
	mode := frame.Mode
	if mode == "" {
		mode = protocol.SessionModeNormal
	}
	if mode != protocol.SessionModeNormal && mode != protocol.SessionModeWorktree {
		return fail(ctx, conn, protocol.ErrCodeInvalidMode, "unknown session mode")
	}
	if frame.NewSessionID != "" && !session.ValidSessionID(frame.NewSessionID) {
		return fail(ctx, conn, protocol.ErrCodeInvalidID, "invalid newSessionId")
	}
	if err := checkWorktreeName(frame, mode); err != nil {
		return fail(ctx, conn, protocol.ErrCodeInvalidWorktreeName, "create session: "+err.Error())
	}
	parsed, reason := chat.ParseClaudeCmd(s.cfg.ResolveClaudeCmd(frame.Flags))
	if reason == "" {
		reason = s.chatAvailability(ctx, false).Reason
	}
	// claude -p does not ask about workspace trust and runs a project's hooks
	// regardless (probe V23): only directories the user already trusted in
	// claude itself (c3), or worktree roots of a repository whose main
	// directory is (session.ChatTrust). Worktree mode checks the directory it
	// comes from.
	if reason == "" && session.ChatTrust(workdir) != chat.TrustTrusted {
		reason = protocol.ChatReasonWorkdirUntrusted
	}
	if reason != "" {
		return fail(ctx, conn, protocol.ErrCodeChatUnsupported, "chat unavailable: "+reason)
	}
	att, err := s.mgr.CreateChat(session.ChatCreateOptions{
		ID: frame.NewSessionID, Workdir: workdir, Mode: mode, Flags: frame.Flags, Parsed: parsed,
		ValidateWorkdir: s.cfg.ResolveAllowedNewPath, WorktreeName: worktreeName(frame, mode),
	})
	if err != nil {
		return failSession(ctx, conn, err, "create session: ")
	}
	return s.chatReady(ctx, conn, &attachment{id: att.ID, chat: att.Session}, att.Existing)
}

// wsHandoff hands a chat session over to a new terminal session (design 6.5).
func (s *Server) wsHandoff(ctx context.Context, conn *websocket.Conn, frame protocol.AttachFrame) *attachment {
	if frame.UI == protocol.UIChat {
		return fail(ctx, conn, protocol.ErrCodeUIMismatch, "a handoff creates a terminal session")
	}
	if frame.NewSessionID != "" && !session.ValidSessionID(frame.NewSessionID) {
		return fail(ctx, conn, protocol.ErrCodeInvalidID, "invalid newSessionId")
	}
	runner, err := s.mgr.Handoff(frame.HandoffFrom, frame.NewSessionID, frame.Cols, frame.Rows)
	if err != nil {
		return failSession(ctx, conn, err, "handoff: ")
	}
	return s.terminalReady(ctx, conn, runner, frame.HandoffFrom)
}

// chatReady confirms a chat attach.
func (s *Server) chatReady(ctx context.Context, conn *websocket.Conn, att *attachment, existing bool) *attachment {
	workdir, meta, ok := s.mgr.ChatMetadata(att.id)
	if !ok {
		return fail(ctx, conn, protocol.ErrCodeSessionNotFound, "attach session: session "+att.id+" not found")
	}
	ready := protocol.ReadyFrame{
		Type: protocol.TypeReady, SessionID: att.id, Workdir: workdir, Proto: protocol.Version,
		SessionMetadata: meta, UI: protocol.UIChat, ClaudeSessionID: att.chat.ClaudeSessionID(), Existing: existing,
	}
	if err := wsjson.Write(ctx, conn, ready); err != nil {
		log.Printf("ws write ready: %v", err)
		return nil
	}
	return att
}

// wsChatRelay serves a chat session: the sync sequence, then live frames
// one way and chat_* requests the other. Closing the connection never stops
// the claude process and never sends exit (R12.1, R13.3); only a real exit
// does.
func (s *Server) wsChatRelay(ctx context.Context, conn *websocket.Conn, att *attachment) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	sess, id := att.chat, att.id

	write := func(b []byte) error { return conn.Write(ctx, websocket.MessageText, b) }
	plan, sub := sess.Subscribe(att.epoch, att.since)
	defer sub.Cancel()
	if err := plan.WriteTo(write); err != nil {
		return
	}
	wsjson.Write(ctx, conn, protocol.SessionsFrame{Type: protocol.TypeSessions, List: s.mgr.List()})

	notifyCh, unsub := s.mgr.Subscribe(id)
	defer unsub()
	go func() {
		for f := range notifyCh {
			if err := wsjson.Write(ctx, conn, f); err != nil {
				return
			}
		}
	}()
	go s.pingLoop(ctx, cancel, conn, id)
	go func() {
		defer cancel()
		for {
			var ev chat.Event
			var ok bool
			select {
			case <-ctx.Done():
				return
			case ev, ok = <-sub.C:
			}
			if !ok {
				// Fell SubBuffer frames behind, or the session was deleted:
				// close instead of silently dropping frames; the client
				// reconnects and resyncs from its position.
				if ctx.Err() == nil {
					conn.Close(websocket.StatusTryAgainLater, "chat stream interrupted")
				}
				return
			}
			var err error
			switch {
			case ev.Resync != nil:
				err = ev.Resync.WriteTo(write)
			case ev.Exit != nil:
				err = wsjson.Write(ctx, conn, protocol.ExitFrame{Type: protocol.TypeExit, Code: *ev.Exit})
			default:
				err = write(ev.Frame)
			}
			if err != nil {
				return
			}
		}
	}()

	ack := func(op, ref string, a chat.Ack) {
		f := protocol.ChatAckFrame{Type: protocol.TypeChatAck, Op: op, Ref: ref,
			OK: a.OK, Code: a.Code, Message: a.Message}
		if a.Duplicate {
			completed := a.Completed
			f.Duplicate, f.Completed = true, &completed
		}
		wsjson.Write(ctx, conn, f)
	}
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			status := websocket.CloseStatus(err)
			if status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway ||
				status == websocket.StatusNoStatusRcvd || ctx.Err() != nil {
				log.Printf("ws closed [%s] (client disconnect)", id)
			} else {
				log.Printf("ws read [%s]: %v", id, err)
			}
			return
		}
		var head protocol.Frame
		if json.Unmarshal(data, &head) != nil {
			continue
		}
		switch head.Type {
		case protocol.TypeChatSend:
			var f protocol.ChatSendFrame
			if json.Unmarshal(data, &f) == nil {
				ack(protocol.AckOpSend, f.ClientMsgID, sess.Send(f.ClientMsgID, f.Text))
			}
		case protocol.TypeChatRespond:
			var f protocol.ChatRespondFrame
			if json.Unmarshal(data, &f) == nil {
				ack(protocol.AckOpRespond, f.RequestID, sess.Respond(f.RequestID, f.Response, f.SetMode))
			}
		case protocol.TypeChatInterrupt:
			ack(protocol.AckOpInterrupt, "", sess.Interrupt())
		case protocol.TypeChatSetMode:
			var f protocol.ChatSetModeFrame
			if json.Unmarshal(data, &f) == nil {
				ack(protocol.AckOpSetMode, f.Mode, sess.SetMode(f.Mode))
			}
		case protocol.TypePing:
			wsjson.Write(ctx, conn, protocol.Frame{Type: protocol.TypePong})
		default:
			log.Printf("ws unknown frame type [%s]: %s", id, head.Type)
		}
	}
}

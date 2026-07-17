// Package protocol defines the JSON frame types for the ccdesk WebSocket protocol.
package protocol

// Frame types exchanged between client and server.
const (
	TypeAuth     = "auth"
	TypeAttach   = "attach"
	TypeReady    = "ready"
	TypeData     = "data"
	TypeResize   = "resize"
	TypeSessions = "sessions"
	TypePing     = "ping"
	TypePong     = "pong"
	TypeExit     = "exit"
	TypeError    = "error"
)

// Frame is the envelope for all WebSocket messages.
type Frame struct {
	Type string `json:"type"`
}

// AuthFrame is sent by the client as the first message.
type AuthFrame struct {
	Type  string `json:"type"`
	Token string `json:"token"`
}

// AttachFrame requests opening or resuming a session.
type AttachFrame struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId,omitempty"` // empty = create new
	Cols      uint16 `json:"cols"`
	Rows      uint16 `json:"rows"`
	Workdir   string `json:"workdir,omitempty"` // working directory for new sessions
}

// ReadyFrame confirms attach success.
type ReadyFrame struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Workdir   string `json:"workdir"`
}

// DataFrame carries PTY bytes (base64-encoded).
type DataFrame struct {
	Type    string `json:"type"`
	Payload string `json:"payload"` // base64
}

// ResizeFrame updates remote PTY dimensions.
type ResizeFrame struct {
	Type string `json:"type"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

// SessionInfo describes a single session in the list.
type SessionInfo struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Workdir string `json:"workdir"`
	Created string `json:"created"`
}

// SessionsFrame lists all sessions on this machine.
type SessionsFrame struct {
	Type string        `json:"type"`
	List []SessionInfo `json:"list"`
}

// ExitFrame signals that the session process exited.
type ExitFrame struct {
	Type string `json:"type"`
	Code int    `json:"code"`
}

// ErrorFrame reports an error to the client.
type ErrorFrame struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

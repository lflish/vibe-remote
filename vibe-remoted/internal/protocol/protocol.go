// Package protocol defines the JSON frame types for the vibe-remote WebSocket protocol.
// 与 packages/core/src/protocol.ts 手工逐字对齐（headless 唯一线）。
package protocol

// Frame types exchanged between client and server.
const (
	TypeAuth   = "auth"
	TypeAttach = "attach"
	TypeReady  = "ready"
	TypeData   = "data"
	TypePing   = "ping"
	TypePong   = "pong"
	TypeExit   = "exit"
	TypeError  = "error"
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

// AttachFrame requests opening a headless session.
type AttachFrame struct {
	Type    string   `json:"type"`
	Workdir string   `json:"workdir,omitempty"` // working directory for the session
	Flags   []string `json:"flags,omitempty"`   // selected claude_flags ids
}

// DataFrame carries bytes (base64-encoded).
type DataFrame struct {
	Type    string `json:"type"`
	Payload string `json:"payload"` // base64
}

// ReadyFrame confirms attach success.
type ReadyFrame struct {
	Type    string `json:"type"`
	Workdir string `json:"workdir"`
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

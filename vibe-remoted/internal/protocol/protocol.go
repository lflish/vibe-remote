// Package protocol defines the JSON frame types for the vibe-remote WebSocket protocol.
package protocol

import "encoding/json"

// Version is the protocol revision this daemon speaks, reported in ready and
// /api/v1/info. Peers are expected to tolerate a newer peer (new fields are
// optional, unknown frames and kinds are ignored); the number exists so a
// client can tell an old daemon apart instead of silently losing features.
// Bump it whenever a frame or endpoint gains behavior a peer may depend on.
//
//	1: implicit — daemons that predate the field and report nothing
//	2: attach.newSessionId (idempotent create), error.code/fatal, proto itself
//	3: chat UI (attach.ui/epoch/since/handoffFrom, chat* frames, ready.ui,
//	   sessions[].ui/state/activitySeq/epoch/endReason, /api/v1/info.chat,
//	   errors ui_mismatch/chat_unsupported/claude_session_busy)
const Version = 3

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
	TypeNotify   = "notify"

	// Chat UI (v3). Server → client.
	TypeChat      = "chat"
	TypeChatSync  = "chat_sync"
	TypeChatState = "chat_state"
	TypeChatAck   = "chat_ack"
	// Chat UI (v3). Client → server, valid only after a ui:"chat" ready.
	TypeChatSend      = "chat_send"
	TypeChatRespond   = "chat_respond"
	TypeChatInterrupt = "chat_interrupt"
	TypeChatSetMode   = "chat_set_mode"
)

// Session UI kinds (attach.ui, ready.ui, sessions[].ui). An omitted ui means
// terminal, which is what every pre-v3 peer sends and expects.
const (
	UITerminal = "terminal"
	UIChat     = "chat"
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

// SessionMode identifies how a session working directory is provisioned.
type SessionMode string

const (
	SessionModeNormal   SessionMode = "normal"
	SessionModeWorktree SessionMode = "worktree"
)

// SessionMetadata describes the authoritative working-directory mode and any
// Git worktree resources associated with a session.
type SessionMetadata struct {
	Mode          SessionMode `json:"mode"`
	SourceWorkdir string      `json:"sourceWorkdir,omitempty"`
	SourceRepo    string      `json:"sourceRepo,omitempty"`
	WorktreeRoot  string      `json:"worktreeRoot,omitempty"`
	Branch        string      `json:"branch,omitempty"`
}

// AttachFrame requests opening or resuming a session.
type AttachFrame struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId,omitempty"` // empty = create new
	// NewSessionID is the client-chosen id for a session being created
	// (SessionID empty). It makes create idempotent: a client that loses the
	// connection before `ready` replays the same attach, and the daemon attaches
	// to the session the first attempt created instead of starting a second
	// one. Empty = the daemon picks an id (pre-v2 clients).
	NewSessionID string      `json:"newSessionId,omitempty"`
	Cols         uint16      `json:"cols"`
	Rows         uint16      `json:"rows"`
	Workdir      string      `json:"workdir,omitempty"` // working directory for new sessions
	Flags        []string    `json:"flags,omitempty"`   // selected claude_flags ids (new session only)
	Mode         SessionMode `json:"mode,omitempty"`    // empty defaults to normal

	// UI picks the session kind on create and must match it on resume
	// (otherwise ui_mismatch). Empty = terminal (pre-v3 clients).
	UI string `json:"ui,omitempty"`
	// Epoch and Since are the chat client's last seen position, read at the
	// moment the attach is sent. Both present and still valid = incremental
	// resync; otherwise the daemon sends a reset sync. Since is a pointer so
	// "seen nothing yet in this epoch" (0) differs from "no position".
	Epoch string  `json:"epoch,omitempty"`
	Since *uint64 `json:"since,omitempty"`
	// HandoffFrom (create only, ui terminal) names the chat session to hand
	// over to a new terminal session; workdir/flags/mode are then ignored.
	HandoffFrom string `json:"handoffFrom,omitempty"`
}

// ReadyFrame confirms attach success.
type ReadyFrame struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Workdir   string `json:"workdir"`
	Proto     int    `json:"proto"` // daemon's protocol Version
	SessionMetadata

	// Chat sessions only; a terminal ready omits all of these so its bytes
	// stay identical to protocol 2 apart from proto.
	UI              string `json:"ui,omitempty"`
	ClaudeSessionID string `json:"claudeSessionId,omitempty"`
	// Existing: a create was turned into an attach of another session that
	// already runs the same claude conversation (-c); SessionID is that one.
	Existing bool `json:"existing,omitempty"`
	// HandoffFrom echoes the chat session a terminal session was handed off from.
	HandoffFrom string `json:"handoffFrom,omitempty"`
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
	SessionMetadata

	// Chat sessions only (terminal entries omit them).
	UI          string `json:"ui,omitempty"`
	State       string `json:"state,omitempty"`       // ChatStatus*
	ActivitySeq uint64 `json:"activitySeq,omitempty"` // highest seq of Epoch
	Epoch       string `json:"epoch,omitempty"`
	EndReason   string `json:"endReason,omitempty"` // EndReason* when ended
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

// ErrorFrame reports an error to the client. Message is for humans; Code is
// the stable machine-readable reason. Fatal means retrying the same request
// cannot succeed (bad token, unknown session, rejected workdir), so a client
// must stop reconnecting instead of replaying the attach forever.
type ErrorFrame struct {
	Type    string `json:"type"`
	Message string `json:"message"`
	Code    string `json:"code,omitempty"`
	Fatal   bool   `json:"fatal,omitempty"`
}

// Error codes carried in ErrorFrame.Code. Open set: clients treat an unknown
// code by its Fatal flag alone.
const (
	ErrCodeAuthFailed      = "auth_failed"        // fatal: wrong token or first frame not auth
	ErrCodeAuthTimeout     = "auth_timeout"       // no auth frame in time
	ErrCodeInvalidWorkdir  = "invalid_workdir"    // fatal: outside allowed_roots
	ErrCodeInvalidMode     = "invalid_mode"       // fatal: unknown session mode
	ErrCodeInvalidID       = "invalid_session_id" // fatal: malformed newSessionId
	ErrCodeCreateFailed    = "create_failed"      // fatal: e.g. worktree in a non-git dir
	ErrCodeSessionNotFound = "session_not_found"  // fatal: the session is gone
	ErrCodeAttachFailed    = "attach_failed"      // transient: PTY/tmux trouble, retry

	// v3
	ErrCodeUIMismatch        = "ui_mismatch"         // fatal: attach ui differs from the session's kind
	ErrCodeChatUnsupported   = "chat_unsupported"    // fatal: chat cannot run here (message carries the ChatReason*)
	ErrCodeClaudeSessionBusy = "claude_session_busy" // fatal: that claude conversation runs in another session
)

// NotifyFrame carries an out-of-band session event to the client (e.g. from a
// claude hook via the events endpoint). Kind is an open string ("idle",
// "waiting", or future kinds); clients ignore kinds they don't recognize.
type NotifyFrame struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Kind      string `json:"kind"`
	Message   string `json:"message,omitempty"`
}

// EventRequest is the JSON body posted to POST /api/v1/events by hooks (or any
// tailnet-local reporter). Transport reuses the existing HTTP server + Bearer
// auth + tailscale binding. Kind is an open enum for forward-compatibility.
type EventRequest struct {
	SessionID string `json:"sessionId"`
	Kind      string `json:"kind"`
	Message   string `json:"message,omitempty"`
}

// --- Chat UI (v3) ---

// ChatFrame carries one message of a chat session: a claude stdout line as is,
// or a daemon-synthesized message (user echo, vr_resolved, vr_notice, vr_exit).
// Seq increases within an epoch; history replayed from the transcript has
// Seq 0 and H true. Seq is never omitted.
type ChatFrame struct {
	Type string          `json:"type"`
	Seq  uint64          `json:"seq"`
	H    bool            `json:"h,omitempty"`
	Msg  json.RawMessage `json:"msg"`
}

// ChatSyncFrame opens a sync sequence: HistoryCount history frames (reset
// only), then Backlog buffered frames, then one ChatStateFrame as the end mark.
type ChatSyncFrame struct {
	Type         string `json:"type"`
	Epoch        string `json:"epoch"`
	Reset        bool   `json:"reset"`
	Omitted      int    `json:"omitted"`
	HistoryCount int    `json:"historyCount"`
	Backlog      int    `json:"backlog"`
}

// Chat session status (chat_state.status, sessions[].state).
const (
	ChatStatusIdle    = "idle"
	ChatStatusRunning = "running"
	ChatStatusWaiting = "waiting"
	ChatStatusEnded   = "ended"
)

// Why a chat session ended (chat_state.ended.reason, sessions[].endReason).
const (
	EndReasonExited             = "exited"
	EndReasonDaemonRestart      = "daemon_restart"
	EndReasonHandedOff          = "handed_off"
	EndReasonVersionUnsupported = "version_unsupported"
	EndReasonStopped            = "stopped"
	EndReasonRestartFailed      = "restart_failed"
)

// ChatStateFrame is the full chat session state, broadcast on every change
// and sent as the last frame of a sync sequence. Pending is authoritative for
// which permission prompts are open; producers send [] rather than null.
type ChatStateFrame struct {
	Type             string           `json:"type"`
	Status           string           `json:"status"`
	PermissionMode   string           `json:"permissionMode"`
	PermissionLocked bool             `json:"permissionLocked"`
	Pending          []PendingRequest `json:"pending"`
	Degraded         []string         `json:"degraded,omitempty"`
	SlashCommands    []SlashCommand   `json:"slashCommands"`
	ClaudeVersion    string           `json:"claudeVersion"`
	ClaudeSessionID  string           `json:"claudeSessionId"`
	Ended            *ChatEnded       `json:"ended"`
}

// PendingRequest is an unanswered can_use_tool control request; Request is
// claude's request object verbatim.
type PendingRequest struct {
	RequestID string          `json:"requestId"`
	Seq       uint64          `json:"seq"`
	Request   json.RawMessage `json:"request"`
}

// SlashCommand is one entry of chat_state.slashCommands.
type SlashCommand struct {
	Name         string `json:"name"`
	Description  string `json:"description,omitempty"`
	ArgumentHint string `json:"argumentHint,omitempty"`
}

// ChatEnded describes why a chat session's process is gone.
type ChatEnded struct {
	Reason           string `json:"reason"`
	Code             *int   `json:"code,omitempty"`
	Message          string `json:"message,omitempty"`
	HandedOffTo      string `json:"handedOffTo,omitempty"`
	StderrTail       string `json:"stderrTail,omitempty"`
	ClaudeVersion    string `json:"claudeVersion,omitempty"`
	MinClaudeVersion string `json:"minClaudeVersion,omitempty"`
}

// ChatAckFrame answers one chat C→S frame, to its sender only. It is not an
// error frame: the connection stays up whatever the outcome.
type ChatAckFrame struct {
	Type    string `json:"type"`
	Op      string `json:"op"`            // AckOp*
	Ref     string `json:"ref,omitempty"` // clientMsgId or requestId
	OK      bool   `json:"ok"`
	Code    string `json:"code,omitempty"` // Ack* when !OK
	Message string `json:"message,omitempty"`
}

// chat_ack ops.
const (
	AckOpSend      = "send"
	AckOpRespond   = "respond"
	AckOpInterrupt = "interrupt"
	AckOpSetMode   = "set_mode"
)

// chat_ack codes (open set).
const (
	AckEmpty             = "empty"
	AckTooLarge          = "too_large"
	AckChatNotRunning    = "chat_not_running"
	AckRequestNotPending = "request_not_pending"
	AckForeignRule       = "foreign_rule"
	AckChatBusy          = "chat_busy"
	AckInvalidMode       = "invalid_mode"
	AckModeLocked        = "mode_locked"
)

// ChatSendFrame sends one user message. ClientMsgID (≤64 chars) deduplicates
// replays.
type ChatSendFrame struct {
	Type        string `json:"type"`
	ClientMsgID string `json:"clientMsgId"`
	Text        string `json:"text"`
}

// ChatRespondFrame answers a pending request. Response is
// {behavior:"allow"|"deny", updatedInput?, updatedPermissions?, message?,
// interrupt?}; SetMode ("acceptEdits"|"default") is queued right after it.
type ChatRespondFrame struct {
	Type      string          `json:"type"`
	RequestID string          `json:"requestId"`
	Response  json.RawMessage `json:"response"`
	SetMode   string          `json:"setMode,omitempty"`
}

// ChatInterruptFrame interrupts the running turn.
type ChatInterruptFrame struct {
	Type string `json:"type"`
}

// ChatSetModeFrame switches the permission mode (default|acceptEdits|plan).
type ChatSetModeFrame struct {
	Type string `json:"type"`
	Mode string `json:"mode"`
}

// ChatInfo is the chat object of GET /api/v1/info. ClaudeVersion is empty
// while the version is still unknown.
type ChatInfo struct {
	Supported        bool   `json:"supported"`
	Reason           string `json:"reason,omitempty"` // ChatReason*
	ClaudeVersion    string `json:"claudeVersion"`
	MinClaudeVersion string `json:"minClaudeVersion"`
}

// Why chat is unavailable (info.chat.reason; chat_unsupported messages).
const (
	ChatReasonNotClaude          = "not_claude"
	ChatReasonShellSyntax        = "shell_syntax"
	ChatReasonConflictingArgs    = "conflicting_args"
	ChatReasonClaudeNotFound     = "claude_not_found"
	ChatReasonTooOld             = "claude_too_old"
	ChatReasonStateDirUnwritable = "state_dir_unwritable"
	ChatReasonWorkdirUntrusted   = "workdir_untrusted"
)

// Workdir trust as seen by claude (GET /api/v1/fs chatTrust).
const (
	TrustTrusted   = "trusted"
	TrustUntrusted = "untrusted"
	TrustUnknown   = "unknown"
)

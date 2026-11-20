package chat

import (
	"encoding/json"
	"reflect"
)

// envelope holds the few fields the daemon reads from a stream-json line; the
// message body itself is passed on untouched (design 1.2 A).
type envelope struct {
	Type      string          `json:"type"`
	Subtype   string          `json:"subtype"`
	RequestID string          `json:"request_id"`
	Request   json.RawMessage `json:"request"`
	Response  *struct {
		Subtype   string          `json:"subtype"`
		RequestID string          `json:"request_id"`
		Response  json.RawMessage `json:"response"`
		Error     string          `json:"error"`
	} `json:"response"`
	Event *struct {
		Type string `json:"type"`
	} `json:"event"`
	PermissionMode    *string          `json:"permissionMode"`
	SlashCommands     []string         `json:"slash_commands"`
	ClaudeCodeVersion *string          `json:"claude_code_version"`
	Capabilities      *[]string        `json:"capabilities"`
	Errors            []string         `json:"errors"`
	NumTurns          *int             `json:"num_turns"`
	Message           *json.RawMessage `json:"message"`
}

// requestSubtype reads request.subtype of a control_request.
func requestSubtype(raw json.RawMessage) string {
	var r struct {
		Subtype string `json:"subtype"`
	}
	_ = json.Unmarshal(raw, &r)
	return r.Subtype
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err) // only daemon-built values of known shape reach here
	}
	return b
}

func line(v any) []byte { return append(mustJSON(v), '\n') }

// userMessageLine is one user turn for claude's stream-json stdin.
func userMessageLine(text string) []byte {
	return line(map[string]any{
		"type":    "user",
		"message": map[string]any{"role": "user", "content": text},
	})
}

// controlRequestLine is a control request the daemon itself sends.
func controlRequestLine(id string, request map[string]any) []byte {
	return line(map[string]any{"type": "control_request", "request_id": id, "request": request})
}

// controlResponseLine answers one of claude's control requests.
func controlResponseLine(id string, response json.RawMessage) []byte {
	return line(map[string]any{"type": "control_response", "response": map[string]any{
		"subtype": "success", "request_id": id, "response": response}})
}

// controlErrorLine refuses one of claude's control requests.
func controlErrorLine(id, msg string) []byte {
	return line(map[string]any{"type": "control_response", "response": map[string]any{
		"subtype": "error", "request_id": id, "error": msg}})
}

// userEcho is the daemon's copy of a user message it wrote to stdin: claude
// does not echo what it reads (probe V8), and every desktop must see it.
func userEcho(text, clientMsgID string) []byte {
	return mustJSON(map[string]any{
		"type":             "user",
		"message":          map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": text}}},
		"vr_client_msg_id": clientMsgID,
	})
}

// Outcomes of vr_resolved.
const (
	outcomeAllowed     = "allowed"
	outcomeDenied      = "denied"
	outcomeCancelled   = "cancelled"
	outcomeInterrupted = "interrupted"
	outcomeExited      = "exited"
)

func vrResolved(requestID, outcome string) []byte {
	return mustJSON(map[string]any{"type": "vr_resolved", "request_id": requestID, "outcome": outcome})
}

// Codes of vr_notice.
const (
	NoticeLineDropped   = "line_dropped"
	NoticeStaleTurn     = "stale_turn"
	NoticeSetModeFailed = "set_mode_failed"
	NoticeDroppedOnStop = "dropped_on_stop"
)

func vrNotice(code, text, clientMsgID string) []byte {
	m := map[string]any{"type": "vr_notice", "code": code, "text": text}
	if clientMsgID != "" {
		m["clientMsgId"] = clientMsgID
	}
	return mustJSON(m)
}

func vrExit(code int, reason, stderrTail string) []byte {
	return mustJSON(map[string]any{"type": "vr_exit", "code": code, "reason": reason, "stderrTail": stderrTail})
}

// markStale adds "vr_stale":true to a JSON object line: a result that arrives
// after the turn watchdog gave up on it, which clients must not pair.
func markStale(msg []byte) []byte {
	if len(msg) < 2 || msg[0] != '{' {
		return msg
	}
	out := make([]byte, 0, len(msg)+16)
	out = append(out, `{"vr_stale":true`...)
	if rest := msg[1:]; len(rest) > 0 && rest[0] != '}' {
		out = append(out, ',')
	}
	return append(out, msg[1:]...)
}

// jsonEqual compares two JSON values structurally.
func jsonEqual(a, b json.RawMessage) bool {
	var va, vb any
	if json.Unmarshal(a, &va) != nil || json.Unmarshal(b, &vb) != nil {
		return false
	}
	return reflect.DeepEqual(va, vb)
}

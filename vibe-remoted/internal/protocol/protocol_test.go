package protocol

import (
	"encoding/json"
	"sort"
	"strings"
	"testing"
)

// keysOf marshals v and returns its top-level JSON keys, sorted.
func keysOf(t *testing.T, v any) []string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal %T: %v", v, err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal %T: %v (%s)", v, err, raw)
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func wantKeys(t *testing.T, name string, v any, want ...string) {
	t.Helper()
	sort.Strings(want)
	got := keysOf(t, v)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("%s keys = %v, want %v", name, got, want)
	}
}

// The JSON names of every v3 frame are the wire contract with the TS client
// and docs/protocol.md (design 4.2–4.10); a renamed tag would break silently.
func TestProtocolChatFramesJSON(t *testing.T) {
	if Version != 3 {
		t.Fatalf("Version = %d, want 3", Version)
	}
	since := uint64(41)
	code := 1

	wantKeys(t, "attach(chat)", AttachFrame{
		Type: TypeAttach, SessionID: "s", Cols: 1, Rows: 1,
		UI: UIChat, Epoch: "a1b2c3d4", Since: &since, HandoffFrom: "c",
	}, "type", "sessionId", "cols", "rows", "ui", "epoch", "since", "handoffFrom")

	// A terminal ready keeps exactly the v2 key set: no ui, no chat fields.
	wantKeys(t, "ready(terminal)", ReadyFrame{
		Type: TypeReady, SessionID: "s", Workdir: "/w", Proto: Version,
		SessionMetadata: SessionMetadata{Mode: SessionModeNormal},
	}, "type", "sessionId", "workdir", "proto", "mode")
	wantKeys(t, "ready(chat)", ReadyFrame{
		Type: TypeReady, SessionID: "s", Workdir: "/w", Proto: Version,
		SessionMetadata: SessionMetadata{Mode: SessionModeNormal},
		UI:              UIChat, ClaudeSessionID: "u", Existing: true, HandoffFrom: "c",
	}, "type", "sessionId", "workdir", "proto", "mode", "ui", "claudeSessionId", "existing", "handoffFrom")

	wantKeys(t, "sessions entry(terminal)", SessionInfo{
		ID: "s", Title: "t", Workdir: "/w", Created: "now", SessionMetadata: SessionMetadata{Mode: SessionModeNormal},
	}, "id", "title", "workdir", "created", "mode")
	wantKeys(t, "sessions entry(chat)", SessionInfo{
		ID: "s", Title: "t", Workdir: "/w", Created: "now", SessionMetadata: SessionMetadata{Mode: SessionModeNormal},
		UI: UIChat, State: ChatStatusIdle, ActivitySeq: 7, Epoch: "e", EndReason: EndReasonExited,
	}, "id", "title", "workdir", "created", "mode", "ui", "state", "activitySeq", "epoch", "endReason")

	// History frames carry seq 0, so seq must never be omitted.
	wantKeys(t, "chat(history)", ChatFrame{Type: TypeChat, Seq: 0, H: true, Msg: json.RawMessage(`{"type":"user"}`)},
		"type", "seq", "h", "msg")
	wantKeys(t, "chat(live)", ChatFrame{Type: TypeChat, Seq: 3, Msg: json.RawMessage(`{"type":"assistant"}`)},
		"type", "seq", "msg")

	wantKeys(t, "chat_sync", ChatSyncFrame{Type: TypeChatSync, Epoch: "e", Reset: false},
		"type", "epoch", "reset", "omitted", "historyCount", "backlog")

	wantKeys(t, "chat_state", ChatStateFrame{
		Type: TypeChatState, Status: ChatStatusWaiting, PermissionMode: "default",
		Pending:       []PendingRequest{{RequestID: "r", Seq: 1, Request: json.RawMessage(`{"subtype":"can_use_tool"}`)}},
		SlashCommands: []SlashCommand{{Name: "compact"}},
		ClaudeVersion: "2.1.210", ClaudeSessionID: "u",
	}, "type", "status", "permissionMode", "permissionLocked", "pending", "slashCommands", "claudeVersion", "claudeSessionId", "ended")
	wantKeys(t, "chat_state(degraded, ended)", ChatStateFrame{
		Type: TypeChatState, Status: ChatStatusEnded, Degraded: []string{"interrupt_receipt"},
		Ended: &ChatEnded{Reason: EndReasonExited, Code: &code, Message: "m", HandedOffTo: "t", StderrTail: "e",
			ClaudeVersion: "1.0.0", MinClaudeVersion: "2.1.210"},
	}, "type", "status", "permissionMode", "permissionLocked", "pending", "degraded", "slashCommands", "claudeVersion", "claudeSessionId", "ended")
	wantKeys(t, "chat_state.ended", ChatEnded{Reason: EndReasonExited, Code: &code, Message: "m", HandedOffTo: "t",
		StderrTail: "e", ClaudeVersion: "1.0.0", MinClaudeVersion: "2.1.210"},
		"reason", "code", "message", "handedOffTo", "stderrTail", "claudeVersion", "minClaudeVersion")
	wantKeys(t, "chat_state.ended(min)", ChatEnded{Reason: EndReasonDaemonRestart}, "reason")
	wantKeys(t, "pending", PendingRequest{RequestID: "r", Seq: 1, Request: json.RawMessage(`{}`)},
		"requestId", "seq", "request")
	wantKeys(t, "slash command", SlashCommand{Name: "c", Description: "d", ArgumentHint: "a"},
		"name", "description", "argumentHint")

	wantKeys(t, "chat_ack", ChatAckFrame{Type: TypeChatAck, Op: AckOpRespond, Ref: "r", OK: false, Code: AckRequestNotPending, Message: "m"},
		"type", "op", "ref", "ok", "code", "message")
	wantKeys(t, "chat_ack(ok)", ChatAckFrame{Type: TypeChatAck, Op: AckOpInterrupt, OK: true}, "type", "op", "ok")

	wantKeys(t, "chat_send", ChatSendFrame{Type: TypeChatSend, ClientMsgID: "m1", Text: "hi"},
		"type", "clientMsgId", "text")
	wantKeys(t, "chat_respond", ChatRespondFrame{Type: TypeChatRespond, RequestID: "r",
		Response: json.RawMessage(`{"behavior":"allow"}`), SetMode: "acceptEdits"},
		"type", "requestId", "response", "setMode")
	wantKeys(t, "chat_respond(no setMode)", ChatRespondFrame{Type: TypeChatRespond, RequestID: "r",
		Response: json.RawMessage(`{"behavior":"deny"}`)}, "type", "requestId", "response")
	wantKeys(t, "chat_interrupt", ChatInterruptFrame{Type: TypeChatInterrupt}, "type")
	wantKeys(t, "chat_set_mode", ChatSetModeFrame{Type: TypeChatSetMode, Mode: "plan"}, "type", "mode")

	wantKeys(t, "info.chat", ChatInfo{Supported: false, Reason: ChatReasonTooOld, ClaudeVersion: "1.0.51", MinClaudeVersion: "2.1.210"},
		"supported", "reason", "claudeVersion", "minClaudeVersion")
	// Version still unknown: supported with an empty (but present) version.
	wantKeys(t, "info.chat(unknown version)", ChatInfo{Supported: true, MinClaudeVersion: "2.1.210"},
		"supported", "claudeVersion", "minClaudeVersion")

	// Wire strings (design 4.1–4.10).
	pairs := []string{
		TypeChat, "chat", TypeChatSync, "chat_sync", TypeChatState, "chat_state", TypeChatAck, "chat_ack",
		TypeChatSend, "chat_send", TypeChatRespond, "chat_respond", TypeChatInterrupt, "chat_interrupt",
		TypeChatSetMode, "chat_set_mode", UITerminal, "terminal", UIChat, "chat",
		ErrCodeUIMismatch, "ui_mismatch", ErrCodeChatUnsupported, "chat_unsupported",
		ErrCodeClaudeSessionBusy, "claude_session_busy",
	}
	for i := 0; i < len(pairs); i += 2 {
		if pairs[i] != pairs[i+1] {
			t.Errorf("constant = %q, want %q", pairs[i], pairs[i+1])
		}
	}
}

// An attach from a v3 client decodes the new fields; since is a pointer so
// "since 0" (an empty epoch) is distinguishable from "no position".
func TestAttachFrameDecodesChatFields(t *testing.T) {
	var f AttachFrame
	if err := json.Unmarshal([]byte(`{"type":"attach","sessionId":"s","cols":80,"rows":24,"ui":"chat","epoch":"e1","since":0}`), &f); err != nil {
		t.Fatal(err)
	}
	if f.UI != UIChat || f.Epoch != "e1" || f.Since == nil || *f.Since != 0 {
		t.Fatalf("decoded %+v", f)
	}
	var old AttachFrame
	if err := json.Unmarshal([]byte(`{"type":"attach","sessionId":"s","cols":80,"rows":24}`), &old); err != nil {
		t.Fatal(err)
	}
	if old.UI != "" || old.Since != nil || old.HandoffFrom != "" {
		t.Fatalf("v2 attach decoded with chat fields: %+v", old)
	}
}

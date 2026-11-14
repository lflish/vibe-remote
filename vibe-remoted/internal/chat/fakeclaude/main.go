// Command fakeclaude imitates claude 2.1.210 for tests: the stream-json
// headless mode (-p) that chat sessions drive, `--version`, and a minimal
// interactive mode for terminal sessions. Every message shape is copied from
// the probe logs of real claude (docs/changes/2026-11-13-dual-mode/evidence/
// probe-stream-json.md); TestFakeClaudeMatchesProbe keeps them in step.
//
// A user message's text is a command: echo, md, tool, perm, plan, ask,
// multi, /compact, burst, slow, fail, crash, cancel, swallow (anything else =
// echo).
// Environment knobs: FAKE_CLAUDE_VERSION, FAKE_CLAUDE_INIT_VERSION,
// FAKE_CLAUDE_CAPS, FAKE_CLAUDE_HOOK_LINES, FAKE_CLAUDE_NO_INIT_REPLY,
// FAKE_CLAUDE_STUBBORN, FAKE_CLAUDE_EXIT_AFTER_RESULT, FAKE_CLAUDE_ARGV_LOG,
// FAKE_CLAUDE_PIDDIR, FAKE_CLAUDE_SIGNAL_LOG, FAKE_CLAUDE_RULES. See design 9.2.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const model = "claude-fable-5-1"

type options struct {
	print     bool
	sessionID string
	resume    string
	continue_ bool
	permMode  string
	bypass    bool
}

// valueFlags take the next word as their value.
var valueFlags = map[string]bool{
	"--session-id": true, "--resume": true, "-r": true, "--permission-mode": true,
	"--input-format": true, "--output-format": true, "--permission-prompt-tool": true,
	"--model": true, "--append-system-prompt": true, "--system-prompt": true, "--add-dir": true,
	"--allowedTools": true, "--disallowedTools": true, "--mcp-config": true, "--settings": true,
	"--fallback-model": true, "--agents": true, "--max-turns": true,
}

func parseArgs(args []string) options {
	var o options
	for i := 0; i < len(args); i++ {
		name, value, hasValue := strings.Cut(args[i], "=")
		if !strings.HasPrefix(args[i], "--") {
			name, hasValue = args[i], false
		}
		if valueFlags[name] && !hasValue && i+1 < len(args) {
			i++
			value = args[i]
		}
		switch name {
		case "-p", "--print":
			o.print = true
		case "--session-id":
			o.sessionID = value
		case "--resume", "-r":
			o.resume = value
		case "-c", "--continue":
			o.continue_ = true
		case "--permission-mode":
			o.permMode = value
		case "--dangerously-skip-permissions":
			o.bypass = true
		}
	}
	return o
}

func newUUID() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func now() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

func appendLine(path, line string) {
	if path == "" {
		return
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	f.WriteString(line + "\n")
	f.Close()
}

func projectsDir() string {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return filepath.Join(d, "projects")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "projects")
}

func encodeDir(p string) string { return strings.NewReplacer("/", "-", ".", "-").Replace(p) }

func transcriptExists(id string) bool {
	m, _ := filepath.Glob(filepath.Join(projectsDir(), "*", id+".jsonl"))
	return len(m) > 0
}

func latestTranscript(cwd string) string {
	entries, err := os.ReadDir(filepath.Join(projectsDir(), encodeDir(cwd)))
	if err != nil {
		return ""
	}
	var best string
	var bestT time.Time
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		if info, err := e.Info(); err == nil && info.ModTime().After(bestT) {
			best, bestT = strings.TrimSuffix(e.Name(), ".jsonl"), info.ModTime()
		}
	}
	return best
}

func alive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

// --- process-wide state ---

type fake struct {
	sid, cwd string
	stubborn bool
	exitAt   int

	outMu   sync.Mutex
	results int

	mu       sync.Mutex
	cond     *sync.Cond
	mode     string
	prePlan  string
	rules    map[string]bool
	queue    []string
	eof      bool
	cur      *turn
	pending  map[string]*pendingReq
	lastUUID string
	eofCh    chan struct{}

	pidFile string
}

var f = &fake{rules: map[string]bool{}, pending: map[string]*pendingReq{}, eofCh: make(chan struct{})}

type turn struct {
	ctx         context.Context
	cancel      context.CancelFunc
	interrupted bool
	pending     []*pendingReq
}

type pendingReq struct {
	id, tool, toolUseID string
	input               map[string]any
	ch                  chan map[string]any
	t                   *turn
}

func (f *fake) exit(code int) {
	if f.pidFile != "" {
		os.Remove(f.pidFile)
	}
	os.Exit(code)
}

func (f *fake) registerPid() {
	dir := os.Getenv("FAKE_CLAUDE_PIDDIR")
	if dir == "" {
		return
	}
	me := os.Getpid()
	f.pidFile = filepath.Join(dir, fmt.Sprintf("%s.%d", f.sid, me))
	os.WriteFile(f.pidFile, []byte(strconv.Itoa(me)), 0o600)
	others, _ := filepath.Glob(filepath.Join(dir, f.sid+".*"))
	for _, o := range others {
		if o == f.pidFile {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimPrefix(filepath.Ext(o), "."))
		if err == nil && alive(pid) {
			appendLine(filepath.Join(dir, "VIOLATION"),
				fmt.Sprintf("claude session %s: pid %d started while pid %d is alive", f.sid, me, pid))
		}
	}
}

func (f *fake) emit(m map[string]any) {
	data, _ := json.Marshal(m)
	f.outMu.Lock()
	defer f.outMu.Unlock()
	os.Stdout.Write(append(data, '\n'))
	if m["type"] == "result" {
		f.results++
		if f.exitAt > 0 && f.results >= f.exitAt {
			f.exit(143)
		}
	}
}

func (f *fake) transcript(m map[string]any) {
	dir := filepath.Join(projectsDir(), encodeDir(f.cwd))
	os.MkdirAll(dir, 0o700)
	data, _ := json.Marshal(m)
	appendLine(filepath.Join(dir, f.sid+".jsonl"), string(data))
}

func (f *fake) recordMessage(typ string, message any) {
	f.mu.Lock()
	parent := any(nil)
	if f.lastUUID != "" {
		parent = f.lastUUID
	}
	u := newUUID()
	f.lastUUID = u
	f.mu.Unlock()
	f.transcript(map[string]any{
		"parentUuid": parent, "isSidechain": false, "userType": "external", "cwd": f.cwd,
		"sessionId": f.sid, "version": "2.1.210", "type": typ, "message": message,
		"uuid": u, "timestamp": now(),
	})
}

// --- message builders (shapes from the probe logs) ---

func messageUsage() map[string]any {
	return map[string]any{
		"input_tokens": 10, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
		"cache_creation": map[string]any{"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0},
		"output_tokens":  5, "service_tier": "standard", "inference_geo": "global", "speed": "standard",
	}
}

func resultUsage() map[string]any {
	return map[string]any{
		"input_tokens": 10, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 5,
		"server_tool_use": map[string]any{"web_search_requests": 0, "web_fetch_requests": 0},
		"service_tier":    "standard",
		"cache_creation":  map[string]any{"ephemeral_1h_input_tokens": 0, "ephemeral_5m_input_tokens": 0},
		"inference_geo":   "global", "iterations": []any{}, "speed": "standard",
	}
}

func modelUsage() map[string]any {
	return map[string]any{model + "[1m]": map[string]any{
		"inputTokens": 10, "outputTokens": 5, "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0,
		"webSearchRequests": 0, "costUSD": 0.01, "contextWindow": 1000000, "maxOutputTokens": 64000,
	}}
}

func message(id string, content []any) map[string]any {
	return map[string]any{
		"model": model, "id": id, "type": "message", "role": "assistant", "content": content,
		"container": nil, "stop_reason": nil, "stop_sequence": nil, "stop_details": nil,
		"usage": messageUsage(), "diagnostics": nil, "context_management": nil,
	}
}

func (f *fake) streamEvent(event map[string]any) map[string]any {
	m := map[string]any{"type": "stream_event", "event": event, "session_id": f.sid,
		"parent_tool_use_id": nil, "uuid": newUUID()}
	if event["type"] == "message_start" {
		m["ttft_ms"] = 400
	}
	return m
}

func (f *fake) assistant(msg map[string]any) map[string]any {
	return map[string]any{"type": "assistant", "message": msg, "parent_tool_use_id": nil,
		"session_id": f.sid, "uuid": newUUID()}
}

func (f *fake) system(subtype string, extra map[string]any) map[string]any {
	m := map[string]any{"type": "system", "subtype": subtype, "uuid": newUUID(), "session_id": f.sid}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func (f *fake) userBlocks(blocks []any, extra map[string]any) map[string]any {
	m := map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": blocks},
		"parent_tool_use_id": nil, "session_id": f.sid, "uuid": newUUID(), "timestamp": now()}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func (f *fake) resultSuccess(text string, isError bool) map[string]any {
	var apiErr any
	if isError {
		apiErr = 529
	}
	return map[string]any{
		"type": "result", "subtype": "success", "is_error": isError, "api_error_status": apiErr,
		"duration_ms": 120, "duration_api_ms": 100, "ttft_ms": 40, "ttft_stream_ms": 40, "time_to_request_ms": 5,
		"num_turns": 1, "result": text, "stop_reason": "end_turn", "session_id": f.sid, "total_cost_usd": 0.01,
		"usage": resultUsage(), "modelUsage": modelUsage(), "permission_denials": []any{},
		"terminal_reason": "completed", "fast_mode_state": "off", "uuid": newUUID(),
	}
}

func (f *fake) resultAborted(reason string, denials []any) map[string]any {
	var stop any
	if reason == "aborted_tools" {
		stop = "tool_use"
	}
	if denials == nil {
		denials = []any{}
	}
	return map[string]any{
		"type": "result", "subtype": "error_during_execution", "duration_ms": 120, "duration_api_ms": 0,
		"is_error": true, "num_turns": 1, "stop_reason": stop, "session_id": f.sid, "total_cost_usd": 0,
		"usage": resultUsage(), "modelUsage": map[string]any{}, "permission_denials": denials,
		"terminal_reason": reason, "fast_mode_state": "off", "uuid": newUUID(),
		"errors": []any{"[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"},
	}
}

func (f *fake) init() map[string]any {
	f.mu.Lock()
	mode := f.mode
	f.mu.Unlock()
	m := f.system("init", map[string]any{
		"cwd": f.cwd, "tools": []any{"Task", "AskUserQuestion", "Bash", "Edit", "ExitPlanMode", "Grep", "Read", "Write"},
		"mcp_servers": []any{}, "model": model + "[1m]", "permissionMode": mode,
		"slash_commands": []any{"compact", "review", "fake-skill"}, "apiKeySource": "none",
		"output_style": "default", "agents": []any{"claude", "Explore"}, "skills": []any{"fake-skill"},
		"plugins":            []any{map[string]any{"name": "fake-plugin", "path": "/opt/fake-plugin", "source": "fake-plugin@fake"}},
		"analytics_disabled": true, "product_feedback_disabled": true,
		"memory_paths":    map[string]any{"auto": filepath.Join(projectsDir(), encodeDir(f.cwd), "memory") + "/"},
		"fast_mode_state": "off",
	})
	if v := os.Getenv("FAKE_CLAUDE_INIT_VERSION"); v != "none" {
		if v == "" {
			v = "2.1.210"
		}
		m["claude_code_version"] = v
	}
	if caps, set := os.LookupEnv("FAKE_CLAUDE_CAPS"); !set {
		m["capabilities"] = []any{"interrupt_receipt_v1", "msg_lifecycle_v1"}
	} else if caps != "" {
		var list []any
		for _, c := range strings.Split(caps, ",") {
			list = append(list, c)
		}
		m["capabilities"] = list
	}
	return m
}

func (f *fake) controlResponse(id string, resp map[string]any) map[string]any {
	return map[string]any{"type": "control_response", "response": map[string]any{
		"subtype": "success", "request_id": id, "response": resp}}
}

func (f *fake) statusMode(mode string) map[string]any {
	return f.system("status", map[string]any{"status": nil, "permissionMode": mode})
}

// --- stdin ---

func (f *fake) readStdin() {
	r := bufio.NewReaderSize(os.Stdin, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if len(strings.TrimSpace(string(line))) > 0 {
			var m map[string]any
			if json.Unmarshal(line, &m) == nil {
				f.handleInput(m)
			}
		}
		if err != nil {
			break
		}
	}
	if f.stubborn {
		select {} // ignore EOF; only SIGKILL ends a stubborn fake
	}
	f.mu.Lock()
	f.eof = true
	close(f.eofCh)
	f.cond.Broadcast()
	f.mu.Unlock()
}

func textOf(content any) string {
	switch c := content.(type) {
	case string:
		return c
	case []any:
		var parts []string
		for _, b := range c {
			if bm, ok := b.(map[string]any); ok && bm["type"] == "text" {
				s, _ := bm["text"].(string)
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

func (f *fake) handleInput(m map[string]any) {
	switch m["type"] {
	case "user":
		msg, _ := m["message"].(map[string]any)
		text := textOf(msg["content"])
		f.transcript(map[string]any{"type": "queue-operation", "operation": "enqueue",
			"timestamp": now(), "sessionId": f.sid, "content": text})
		f.mu.Lock()
		f.queue = append(f.queue, text)
		f.cond.Broadcast()
		f.mu.Unlock()
	case "control_request":
		id, _ := m["request_id"].(string)
		req, _ := m["request"].(map[string]any)
		f.handleControl(id, req)
	case "control_response":
		resp, _ := m["response"].(map[string]any)
		f.handleResponse(resp)
	}
}

func (f *fake) handleControl(id string, req map[string]any) {
	switch req["subtype"] {
	case "initialize":
		if os.Getenv("FAKE_CLAUDE_NO_INIT_REPLY") == "1" {
			return
		}
		f.emit(f.controlResponse(id, map[string]any{
			"commands": []any{
				map[string]any{"name": "compact", "description": "Clear conversation history but keep a summary in context", "argumentHint": "<optional custom summarization instructions>"},
				map[string]any{"name": "review", "description": "Review a pull request", "argumentHint": ""},
				map[string]any{"name": "fake-skill", "description": "A skill of the fake claude", "argumentHint": ""},
			},
			"agents":                  []any{map[string]any{"name": "claude", "description": "General-purpose agent"}},
			"output_style":            "default",
			"available_output_styles": []any{"default"},
			"models": []any{map[string]any{
				"value": "default", "resolvedModel": model + "[1m]", "displayName": "Default (recommended)",
				"description": "Fake model", "supportsEffort": true, "supportedEffortLevels": []any{"low", "high"},
				"supportsAdaptiveThinking": true, "supportsFastMode": false, "supportsAutoMode": false,
			}},
			"account": map[string]any{"tokenSource": "none", "apiProvider": "firstParty"},
			"pid":     os.Getpid(), "remote_control_auto_enable": false,
			"remote_control_auto_on_by_default": false, "ide_rc_auto_enable_gate": false,
		}))
	case "interrupt":
		if f.stubborn {
			return
		}
		f.mu.Lock()
		t := f.cur
		if t != nil && !t.interrupted {
			t.interrupted = true
			// claude cancels its own open permission requests first (V12).
			for _, p := range t.pending {
				if f.pending[p.id] != nil {
					delete(f.pending, p.id)
					f.emit(map[string]any{"type": "control_cancel_request", "request_id": p.id})
				}
			}
		}
		// still_queued never lists stdin-queued messages (V14).
		f.emit(f.controlResponse(id, map[string]any{"still_queued": []any{}}))
		if t != nil {
			t.cancel()
		}
		f.mu.Unlock()
	case "set_permission_mode":
		mode, _ := req["mode"].(string)
		f.mu.Lock()
		if mode == "plan" && f.mode != "plan" {
			f.prePlan = f.mode
		}
		f.mode = mode
		f.emit(f.controlResponse(id, map[string]any{"mode": mode}))
		f.emit(f.statusMode(mode))
		f.mu.Unlock()
	default:
		f.emit(map[string]any{"type": "control_response", "response": map[string]any{
			"subtype": "error", "request_id": id, "error": "unsupported control request"}})
	}
}

func (f *fake) handleResponse(resp map[string]any) {
	id, _ := resp["request_id"].(string)
	answer, _ := resp["response"].(map[string]any)
	f.mu.Lock()
	defer f.mu.Unlock()
	p := f.pending[id]
	if p == nil {
		return // cancelled, interrupted, or answered already
	}
	delete(f.pending, id)
	if answer["behavior"] == "allow" {
		if _, ok := answer["updatedInput"].(map[string]any); !ok {
			fmt.Fprintln(os.Stderr, "fake claude: allow response without updatedInput")
			f.exit(2)
		}
		if perms, ok := answer["updatedPermissions"].([]any); ok {
			for _, item := range perms {
				s, _ := item.(map[string]any)
				switch s["type"] {
				case "addRules":
					rules, _ := s["rules"].([]any)
					for _, r := range rules {
						rm, _ := r.(map[string]any)
						rule := fmt.Sprintf("%v(%v)", rm["toolName"], rm["ruleContent"])
						f.rules[rule] = true
						appendLine(os.Getenv("FAKE_CLAUDE_RULES"), rule)
					}
				case "setMode":
					mode, _ := s["mode"].(string)
					f.mode = mode
					f.emit(f.statusMode(mode))
				}
			}
		}
		// Approving a plan restores the mode from before plan mode, announced
		// before the tool result (V22). Done here, before the next stdin line,
		// so an immediately following set_permission_mode wins.
		if p.tool == "ExitPlanMode" {
			if f.mode == "plan" {
				f.mode = f.prePlan
			}
			f.emit(f.statusMode(f.mode))
		}
	}
	p.ch <- answer
}

// --- turns ---

func (f *fake) runTurns() {
	for {
		f.mu.Lock()
		for len(f.queue) == 0 && !f.eof {
			f.cond.Wait()
		}
		if len(f.queue) == 0 {
			f.mu.Unlock()
			f.exit(0) // stdin closed and every queued message ran (V5)
		}
		text := f.queue[0]
		f.queue = f.queue[1:]
		ctx, cancel := context.WithCancel(context.Background())
		t := &turn{ctx: ctx, cancel: cancel}
		f.cur = t
		f.mu.Unlock()

		f.runTurn(t, text)

		f.mu.Lock()
		f.cur = nil
		f.mu.Unlock()
		cancel()
	}
}

func split3(s string) []string {
	r := []rune(s)
	n := len(r)
	return []string{string(r[:n/3]), string(r[n/3 : 2*n/3]), string(r[2*n/3:])}
}

func (f *fake) sleep(t *turn, d time.Duration) bool {
	select {
	case <-time.After(d):
		return true
	case <-t.ctx.Done():
		return false
	}
}

// streamText streams one text message. It returns false (after emitting the
// interrupted ending) when the turn was interrupted mid-stream (V3).
func (f *fake) streamText(t *turn, chunks []string, delay time.Duration) bool {
	id := "msg_fake_" + randHex(8)
	f.emit(f.streamEvent(map[string]any{"type": "message_start", "message": message(id, []any{})}))
	f.emit(f.streamEvent(map[string]any{"type": "content_block_start", "index": 0,
		"content_block": map[string]any{"type": "text", "text": ""}}))
	var sent strings.Builder
	for _, c := range chunks {
		if delay > 0 && !f.sleep(t, delay) {
			break
		}
		if t.ctx.Err() != nil {
			break
		}
		f.emit(f.streamEvent(map[string]any{"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "text_delta", "text": c}}))
		sent.WriteString(c)
	}
	full := message(id, []any{map[string]any{"type": "text", "text": sent.String()}})
	f.emit(f.assistant(full))
	f.recordMessage("assistant", full)
	if t.ctx.Err() != nil {
		f.emit(f.userBlocks([]any{map[string]any{"type": "text", "text": "[Request interrupted by user]"}}, nil))
		f.emit(f.resultAborted("aborted_streaming", nil))
		return false
	}
	f.emit(f.streamEvent(map[string]any{"type": "content_block_stop", "index": 0}))
	f.emitMessageEnd("end_turn")
	return true
}

func (f *fake) emitMessageEnd(stop string) {
	f.emit(f.streamEvent(map[string]any{"type": "message_delta",
		"delta": map[string]any{"stop_reason": stop, "stop_sequence": nil, "stop_details": nil, "container": nil},
		"usage": map[string]any{"input_tokens": 10, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
			"output_tokens": 5, "output_tokens_details": map[string]any{"thinking_tokens": 0},
			"cache_creation": map[string]any{"ephemeral_5m_input_tokens": 0}},
		"context_management": map[string]any{"applied_edits": []any{}}}))
	f.emit(f.streamEvent(map[string]any{"type": "message_stop"}))
}

// say streams a short reply and ends the turn with a success result.
func (f *fake) say(t *turn, text string) {
	if f.streamText(t, split3(text), 0) {
		f.emit(f.resultSuccess(text, false))
	}
}

func (f *fake) toolUse(name string, input map[string]any) string {
	id := "msg_fake_" + randHex(8)
	toolID := "toolu_fake_" + randHex(8)
	f.emit(f.streamEvent(map[string]any{"type": "message_start", "message": message(id, []any{})}))
	f.emit(f.streamEvent(map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{
		"type": "tool_use", "id": toolID, "name": name, "input": map[string]any{}, "caller": map[string]any{"type": "direct"}}}))
	raw, _ := json.Marshal(input)
	f.emit(f.streamEvent(map[string]any{"type": "content_block_delta", "index": 0,
		"delta": map[string]any{"type": "input_json_delta", "partial_json": string(raw)}}))
	full := message(id, []any{map[string]any{"type": "tool_use", "id": toolID, "name": name, "input": input,
		"caller": map[string]any{"type": "direct"}}})
	f.emit(f.assistant(full))
	f.recordMessage("assistant", full)
	f.emit(f.streamEvent(map[string]any{"type": "content_block_stop", "index": 0}))
	f.emitMessageEnd("tool_use")
	return toolID
}

func (f *fake) toolResult(toolID string, content string, isErr bool, useResult any) {
	block := map[string]any{"tool_use_id": toolID, "type": "tool_result", "content": content, "is_error": isErr}
	m := f.userBlocks([]any{block}, map[string]any{"tool_use_result": useResult})
	f.emit(m)
	f.recordMessage("user", m["message"])
}

const rejectedText = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."

// ask sends a can_use_tool request and waits. outcome is "allow", "deny",
// "interrupted" (the interrupted ending is already emitted) or "cancelled".
func (f *fake) ask(t *turn, tool, toolID string, input map[string]any, extra map[string]any, cancelAfter time.Duration) (map[string]any, string) {
	p := &pendingReq{id: newUUID(), tool: tool, toolUseID: toolID, input: input, ch: make(chan map[string]any, 1), t: t}
	req := map[string]any{"subtype": "can_use_tool", "tool_name": tool, "display_name": tool, "input": input, "tool_use_id": toolID}
	for k, v := range extra {
		req[k] = v
	}
	f.mu.Lock()
	f.pending[p.id] = p
	t.pending = append(t.pending, p)
	f.emit(map[string]any{"type": "control_request", "request_id": p.id, "request": req})
	f.mu.Unlock()

	var cancelC <-chan time.Time
	if cancelAfter > 0 {
		cancelC = time.After(cancelAfter)
	}
	select {
	case ans := <-p.ch:
		if ans["behavior"] == "allow" {
			return ans, "allow"
		}
		return ans, "deny"
	case <-cancelC:
		f.mu.Lock()
		if f.pending[p.id] == nil {
			f.mu.Unlock()
			ans := <-p.ch // answered just before the cancel fired
			if ans["behavior"] == "allow" {
				return ans, "allow"
			}
			return ans, "deny"
		}
		delete(f.pending, p.id)
		f.emit(map[string]any{"type": "control_cancel_request", "request_id": p.id})
		f.mu.Unlock()
		return nil, "cancelled"
	case <-t.ctx.Done():
	case <-f.eofCh:
	}
	f.mu.Lock()
	delete(f.pending, p.id)
	f.mu.Unlock()
	f.toolResult(toolID, rejectedText, true, "Error: "+rejectedText)
	f.emit(f.userBlocks([]any{map[string]any{"type": "text", "text": "[Request interrupted by user for tool use]"}}, nil))
	f.emit(f.resultAborted("aborted_tools", []any{map[string]any{"tool_name": tool, "tool_use_id": toolID, "tool_input": input}}))
	return nil, "interrupted"
}

func (f *fake) currentMode() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.mode
}

func (f *fake) needsPermission(tool string, input map[string]any) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.mode == "bypassPermissions" {
		return false
	}
	switch tool {
	case "Edit", "Write":
		return f.mode != "acceptEdits"
	case "Bash":
		return !f.rules[fmt.Sprintf("Bash(%v)", input["command"])]
	}
	return false
}

func bashSuggestions(command, cwd string) []any {
	return []any{
		map[string]any{"type": "addRules", "rules": []any{map[string]any{"toolName": "Bash", "ruleContent": command}},
			"behavior": "allow", "destination": "localSettings"},
		map[string]any{"type": "addDirectories", "directories": []any{cwd}, "destination": "session"},
		setModeSuggestion(),
	}
}

func setModeSuggestion() map[string]any {
	return map[string]any{"type": "setMode", "mode": "acceptEdits", "destination": "session"}
}

// runTool: tool_use → permission (if needed) → tool_result → reply → result.
func (f *fake) runTool(t *turn, tool string, input map[string]any, suggestions []any, fail bool) {
	toolID := f.toolUse(tool, input)
	if f.needsPermission(tool, input) {
		extra := map[string]any{"description": fmt.Sprintf("Run %s", tool)}
		if tool == "Bash" {
			extra["blocked_path"] = filepath.Join(f.cwd, "x")
		}
		if suggestions != nil {
			extra["permission_suggestions"] = suggestions
		}
		ans, outcome := f.ask(t, tool, toolID, input, extra, 0)
		switch outcome {
		case "interrupted":
			return
		case "deny":
			msg, _ := ans["message"].(string)
			f.toolResult(toolID, msg, true, "Error: "+msg)
			f.say(t, "denied: "+msg)
			return
		}
		input, _ = ans["updatedInput"].(map[string]any)
	}
	if fail {
		f.toolResult(toolID, "Error: "+tool+" failed", true, "Error: "+tool+" failed")
		f.say(t, tool+" failed")
		return
	}
	out := map[string]string{
		"Read": "1\thello", "Grep": "README.md", "Bash": "fake output",
		"Edit": "The file has been updated.", "Write": "File created successfully",
	}[tool]
	var use any = map[string]any{"type": "text", "text": out}
	if tool == "Bash" {
		use = map[string]any{"stdout": out, "stderr": "", "interrupted": false, "isImage": false, "noOutputExpected": false}
	}
	f.toolResult(toolID, out, false, use)
	f.say(t, "done "+tool)
}

func (f *fake) toolInput(tool string) map[string]any {
	switch tool {
	case "Read":
		return map[string]any{"file_path": filepath.Join(f.cwd, "README.md")}
	case "Grep":
		return map[string]any{"pattern": "TODO", "path": f.cwd}
	case "Bash":
		return map[string]any{"command": "echo fake", "description": "Print fake"}
	case "Edit":
		return map[string]any{"file_path": filepath.Join(f.cwd, "a.txt"), "old_string": "old line\n", "new_string": "new line\n", "replace_all": false}
	case "Write":
		return map[string]any{"file_path": filepath.Join(f.cwd, "note.txt"), "content": "hello\n"}
	}
	return map[string]any{}
}

const planText = "# Plan: fake change\n\n1. Step one\n2. Step two\n"

func (f *fake) runPlan(t *turn) {
	f.mu.Lock()
	if f.mode != "plan" {
		f.prePlan = f.mode
		f.mode = "plan"
	}
	f.mu.Unlock()
	planFile := filepath.Join(filepath.Dir(projectsDir()), "plans", "fake-plan.md")
	for {
		input := map[string]any{"plan": planText, "planFilePath": planFile}
		toolID := f.toolUse("ExitPlanMode", input)
		ans, outcome := f.ask(t, "ExitPlanMode", toolID, input, map[string]any{"requires_user_interaction": true}, 0)
		switch outcome {
		case "interrupted":
			return
		case "deny":
			// Stay in plan mode, revise, and present the plan again (V11).
			msg, _ := ans["message"].(string)
			f.toolResult(toolID, msg, true, "Error: "+msg)
			if !f.streamText(t, split3("revising: "+msg), 0) {
				return
			}
			continue
		}
		f.toolResult(toolID, "User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\n## Approved Plan:\n"+planText, false,
			map[string]any{"plan": planText, "isAgent": false, "filePath": planFile})
		f.say(t, "plan approved")
		return
	}
}

var askQuestions = []any{
	map[string]any{"question": "Pick a fruit", "header": "Fruit", "multiSelect": false, "options": []any{
		map[string]any{"label": "Apple", "description": "A red fruit."},
		map[string]any{"label": "Banana", "description": "A yellow fruit."},
	}},
	map[string]any{"question": "Pick colors", "header": "Colors", "multiSelect": true, "options": []any{
		map[string]any{"label": "Red", "description": "Warm."},
		map[string]any{"label": "Blue", "description": "Cool."},
		map[string]any{"label": "Green", "description": "Fresh."},
	}},
}

func (f *fake) runAsk(t *turn) {
	input := map[string]any{"questions": askQuestions}
	toolID := f.toolUse("AskUserQuestion", input)
	ans, outcome := f.ask(t, "AskUserQuestion", toolID, input, map[string]any{"requires_user_interaction": true}, 0)
	switch outcome {
	case "interrupted":
		return
	case "deny":
		msg, _ := ans["message"].(string)
		f.toolResult(toolID, msg, true, "Error: "+msg)
		f.say(t, "denied: "+msg)
		return
	}
	updated, _ := ans["updatedInput"].(map[string]any)
	answers, _ := updated["answers"].(map[string]any)
	keys := make([]string, 0, len(answers))
	for k := range answers {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var pairs []string
	for _, k := range keys {
		pairs = append(pairs, fmt.Sprintf("%q=%q", k, fmt.Sprint(answers[k])))
	}
	f.toolResult(toolID, "Your questions have been answered: "+strings.Join(pairs, ", ")+". You can now continue with these answers in mind.",
		false, map[string]any{"questions": askQuestions, "answers": answers})
	f.say(t, "answers: "+strings.Join(pairs, ", "))
}

// runMulti asks for two Bash permissions at once, so two requests are open at
// the same time (tests for several pending requests).
func (f *fake) runMulti(t *turn) {
	inputs := []map[string]any{
		{"command": "echo one", "description": "Run echo one"},
		{"command": "echo two", "description": "Run echo two"},
	}
	ps := make([]*pendingReq, len(inputs))
	for i, in := range inputs {
		ps[i] = &pendingReq{id: newUUID(), tool: "Bash", toolUseID: f.toolUse("Bash", in), input: in,
			ch: make(chan map[string]any, 1), t: t}
	}
	f.mu.Lock()
	for _, p := range ps {
		f.pending[p.id] = p
		t.pending = append(t.pending, p)
		f.emit(map[string]any{"type": "control_request", "request_id": p.id, "request": map[string]any{
			"subtype": "can_use_tool", "tool_name": "Bash", "display_name": "Bash", "input": p.input,
			"tool_use_id": p.toolUseID, "description": "Run Bash"}})
	}
	f.mu.Unlock()
	answers := make([]map[string]any, len(ps))
	waitAll := func() bool {
		for i, p := range ps {
			select {
			case answers[i] = <-p.ch:
			case <-t.ctx.Done():
				return false
			case <-f.eofCh:
				return false
			}
		}
		return true
	}
	if !waitAll() {
		var denials []any
		f.mu.Lock()
		for _, p := range ps {
			delete(f.pending, p.id)
		}
		f.mu.Unlock()
		for _, p := range ps {
			f.toolResult(p.toolUseID, rejectedText, true, "Error: "+rejectedText)
			denials = append(denials, map[string]any{"tool_name": "Bash", "tool_use_id": p.toolUseID, "tool_input": p.input})
		}
		f.emit(f.userBlocks([]any{map[string]any{"type": "text", "text": "[Request interrupted by user for tool use]"}}, nil))
		f.emit(f.resultAborted("aborted_tools", denials))
		return
	}
	for i, p := range ps {
		if answers[i]["behavior"] == "allow" {
			f.toolResult(p.toolUseID, "fake output", false, map[string]any{"stdout": "fake output", "stderr": "",
				"interrupted": false, "isImage": false, "noOutputExpected": false})
		} else {
			msg, _ := answers[i]["message"].(string)
			f.toolResult(p.toolUseID, msg, true, "Error: "+msg)
		}
	}
	f.say(t, "multi done")
}

func (f *fake) runCompact() {
	f.emit(f.system("status", map[string]any{"status": "compacting"}))
	f.emit(f.system("status", map[string]any{"status": nil, "compact_result": "success"}))
	f.emit(f.init())
	a, b, c := newUUID(), newUUID(), newUUID()
	f.emit(f.system("compact_boundary", map[string]any{"compact_metadata": map[string]any{
		"trigger": "manual", "pre_tokens": 5000, "post_tokens": 500, "cumulative_dropped_tokens": 4500, "duration_ms": 50,
		"preserved_segment":  map[string]any{"head_uuid": a, "anchor_uuid": b, "tail_uuid": c},
		"preserved_messages": map[string]any{"anchor_uuid": b, "uuids": []any{a, c}, "all_uuids": []any{a, b, c}},
	}}))
	summary := f.userBlocks(nil, map[string]any{"isReplay": false, "isSynthetic": true})
	summary["message"] = map[string]any{"role": "user", "content": "This session is being continued from a previous conversation that ran out of context. Summary: the user ran fake commands."}
	f.emit(summary)
	local := f.userBlocks(nil, map[string]any{"isReplay": false})
	local["message"] = map[string]any{"role": "user", "content": "<local-command-stdout>Compacted </local-command-stdout>"}
	f.emit(local)
	f.emit(map[string]any{
		"type": "result", "subtype": "success", "is_error": false, "duration_ms": 50, "duration_api_ms": 0,
		"num_turns": 0, "result": "", "stop_reason": nil, "session_id": f.sid, "total_cost_usd": 0.01,
		"usage": resultUsage(), "modelUsage": modelUsage(), "permission_denials": []any{},
		"fast_mode_state": "off", "uuid": newUUID(),
	})
}

const mdText = "# Heading\n\n- item one\n- item two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n`inline`\n\n```go\nfmt.Println(\"hi\")\n```\n\n" +
	"<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) [ok](https://example.com)\n"

func atoi(s string, def int) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return def
}

func (f *fake) runTurn(t *turn, text string) {
	words := strings.Fields(text)
	cmd := ""
	if len(words) > 0 {
		cmd = words[0]
	}
	switch cmd {
	case "/compact":
		f.recordMessage("user", map[string]any{"role": "user", "content": text})
		f.runCompact()
		return
	case "swallow":
		// No output at all; with a delay, a late result after it.
		if len(words) < 2 {
			<-t.ctx.Done()
			f.emit(f.resultAborted("aborted_streaming", nil))
			return
		}
		if f.sleep(t, time.Duration(atoi(words[1], 0))*time.Millisecond) {
			f.emit(f.resultSuccess("", false))
		} else {
			f.emit(f.resultAborted("aborted_streaming", nil))
		}
		return
	case "crash":
		for i := 1; i <= 3; i++ {
			fmt.Fprintf(os.Stderr, "fake claude crash line %d\n", i)
		}
		code := 1
		if len(words) > 1 {
			code = atoi(words[1], 1)
		}
		f.exit(code)
	}

	f.recordMessage("user", map[string]any{"role": "user", "content": text})
	f.emit(f.init())
	f.emit(f.system("status", map[string]any{"status": "requesting"}))
	arg := strings.TrimSpace(strings.TrimPrefix(text, cmd))

	switch cmd {
	case "echo":
		f.say(t, arg)
	case "md":
		f.say(t, mdText)
	case "tool":
		tool := "Read"
		if len(words) > 1 {
			tool = words[1]
		}
		var sugg []any
		switch tool {
		case "Bash":
			sugg = bashSuggestions("echo fake", f.cwd)
		case "Edit", "Write":
			sugg = []any{setModeSuggestion()}
		}
		f.runTool(t, tool, f.toolInput(tool), sugg, len(words) > 2 && words[2] == "fail")
	case "perm":
		command := arg
		var sugg []any
		switch {
		case strings.HasSuffix(arg, " suggest"):
			command = strings.TrimSuffix(arg, " suggest")
			sugg = bashSuggestions(command, f.cwd)
		case strings.HasSuffix(arg, " mode"):
			command = strings.TrimSuffix(arg, " mode")
			sugg = []any{setModeSuggestion()}
		}
		f.runTool(t, "Bash", map[string]any{"command": command, "description": "Run " + command}, sugg, false)
	case "plan":
		f.runPlan(t)
	case "ask":
		f.runAsk(t)
	case "multi":
		f.runMulti(t)
	case "burst":
		n := 1
		if len(words) > 1 {
			n = atoi(words[1], 1)
		}
		size := 0
		if len(words) > 2 {
			size = atoi(words[2], 0)
		}
		for i := 1; i <= n; i++ {
			body := fmt.Sprintf("burst %d", i)
			if size > len(body) {
				body += strings.Repeat("x", size-len(body))
			}
			f.emit(f.assistant(message("msg_fake_"+randHex(8), []any{map[string]any{"type": "text", "text": body}})))
		}
		f.emit(f.resultSuccess(fmt.Sprintf("burst %d", n), false))
	case "slow":
		ms, n := 100, 10
		if len(words) > 1 {
			ms = atoi(words[1], 100)
		}
		if len(words) > 2 {
			n = atoi(words[2], 10)
		}
		chunks := make([]string, n)
		for i := range chunks {
			chunks[i] = fmt.Sprintf("%d\n", i+1)
		}
		if f.streamText(t, chunks, time.Duration(ms)*time.Millisecond) {
			f.emit(f.resultSuccess(strings.Join(chunks, ""), false))
		}
	case "fail":
		f.emit(f.resultSuccess("API Error: 529 Overloaded", true))
	case "cancel":
		input := map[string]any{"command": "echo cancel", "description": "Run echo cancel"}
		toolID := f.toolUse("Bash", input)
		_, outcome := f.ask(t, "Bash", toolID, input, map[string]any{"description": "Run echo cancel"}, 200*time.Millisecond)
		switch outcome {
		case "interrupted":
			return
		case "cancelled":
			f.toolResult(toolID, "Permission request was cancelled", true, "Error: Permission request was cancelled")
			f.say(t, "cancelled")
		default:
			f.toolResult(toolID, "cancel", false, map[string]any{"stdout": "cancel", "stderr": "", "interrupted": false, "isImage": false, "noOutputExpected": false})
			f.say(t, "done Bash")
		}
	default:
		f.say(t, text)
	}
}

// --- modes ---

func (f *fake) interactive(o options) {
	// Transcript first, so it exists by the time the banner is seen.
	f.recordMessage("user", map[string]any{"role": "user", "content": "(interactive session)"})
	switch {
	case o.resume != "":
		fmt.Printf("fake-claude interactive resume=%s\n", f.sid)
	case o.sessionID != "":
		fmt.Printf("fake-claude interactive session=%s\n", f.sid)
	default:
		fmt.Printf("fake-claude interactive new=%s\n", f.sid)
	}
	io.Copy(os.Stdout, os.Stdin)
	f.exit(0)
}

func main() {
	args := os.Args[1:]
	for _, a := range args {
		if a == "--version" || a == "-v" {
			v := os.Getenv("FAKE_CLAUDE_VERSION")
			if v == "" {
				v = "2.1.210"
			}
			fmt.Printf("%s (Claude Code)\n", v)
			return
		}
	}
	if data, err := json.Marshal(os.Args); err == nil {
		appendLine(os.Getenv("FAKE_CLAUDE_ARGV_LOG"), string(data))
	}
	if os.Getenv("CLAUDECODE") != "" {
		if dir := os.Getenv("FAKE_CLAUDE_PIDDIR"); dir != "" {
			appendLine(filepath.Join(dir, "NESTED"), fmt.Sprintf("pid %d started with CLAUDECODE set", os.Getpid()))
		}
		fmt.Fprintln(os.Stderr, "Error: Claude Code cannot be launched inside another Claude Code session.")
		os.Exit(1)
	}

	o := parseArgs(args)
	cwd, _ := os.Getwd()
	if canon, err := filepath.EvalSymlinks(cwd); err == nil {
		cwd = canon
	}
	f.cwd = cwd
	f.cond = sync.NewCond(&f.mu)
	f.stubborn = os.Getenv("FAKE_CLAUDE_STUBBORN") == "1"
	f.exitAt = atoi(os.Getenv("FAKE_CLAUDE_EXIT_AFTER_RESULT"), 0)
	switch {
	case o.resume != "":
		f.sid = o.resume
	case o.sessionID != "":
		f.sid = o.sessionID
	case o.continue_:
		f.sid = latestTranscript(cwd)
	}
	if f.sid == "" {
		f.sid = newUUID()
	}
	f.mode = "default"
	if o.permMode != "" {
		f.mode = o.permMode
	}
	if o.bypass {
		f.mode = "bypassPermissions"
	}
	f.prePlan = "default"

	if o.resume != "" && !transcriptExists(o.resume) {
		msg := "No conversation found with session ID: " + o.resume
		fmt.Fprintln(os.Stderr, msg)
		if o.print {
			f.emit(map[string]any{
				"type": "result", "subtype": "error_during_execution", "duration_ms": 0, "duration_api_ms": 0,
				"is_error": true, "num_turns": 0, "stop_reason": nil, "session_id": o.resume, "total_cost_usd": 0,
				"usage": resultUsage(), "modelUsage": map[string]any{}, "permission_denials": []any{},
				"uuid": newUUID(), "errors": []any{msg},
			})
		}
		os.Exit(1)
	}

	f.registerPid()
	sigs := make(chan os.Signal, 4)
	signal.Notify(sigs, syscall.SIGTERM)
	go func() {
		for range sigs {
			if f.stubborn {
				appendLine(os.Getenv("FAKE_CLAUDE_SIGNAL_LOG"), "SIGTERM ignored")
				continue
			}
			f.exit(143)
		}
	}()

	if !o.print {
		f.interactive(o)
		return
	}
	if os.Getenv("FAKE_CLAUDE_HOOK_LINES") == "1" {
		hook := map[string]any{"hook_id": newUUID(), "hook_name": "SessionStart:startup", "hook_event": "SessionStart"}
		f.emit(f.system("hook_started", hook))
		resp := map[string]any{"output": "", "stdout": "", "stderr": "", "exit_code": 0, "outcome": "success"}
		for k, v := range hook {
			resp[k] = v
		}
		f.emit(f.system("hook_response", resp))
	}
	go f.readStdin()
	f.runTurns()
}

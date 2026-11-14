package chat

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat/chattest"
)

// --- harness: drive the fake claude over its stdio, as the daemon will ---

type fakeMsg struct {
	raw []byte
	m   map[string]any
}

func (f fakeMsg) kind() string { return messageKind(f.m) }

type fakeProc struct {
	t      *testing.T
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	lines  chan fakeMsg
	stderr *bytes.Buffer
	done   chan struct{}
	all    []fakeMsg // every stdout message read so far, in order
}

func streamArgs(u string, extra ...string) []string {
	args := []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json",
		"--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio", "--session-id", u}
	return append(args, extra...)
}

func newUUID(n int) string { return fmt.Sprintf("0b6c1f7e-2a3d-4c5e-8f90-%012d", n) }

func startFake(t *testing.T, env *chattest.Env, workdir string, args ...string) *fakeProc {
	t.Helper()
	cmd := exec.Command(filepath.Join(chattest.FakeClaude(t), "claude"), args...)
	cmd.Env = env.Environ()
	cmd.Dir = workdir
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	// Our own pipe, not StdoutPipe: Wait closes a StdoutPipe as soon as the
	// process exits, losing lines not read yet (design 6.4).
	stdout, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stdout = w
	p := &fakeProc{t: t, cmd: cmd, stdin: stdin, lines: make(chan fakeMsg, 4096), stderr: &bytes.Buffer{}, done: make(chan struct{})}
	cmd.Stderr = p.stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	w.Close()
	go func() {
		defer stdout.Close()
		defer close(p.lines)
		r := bufio.NewReader(stdout)
		for {
			line, err := r.ReadBytes('\n')
			if len(bytes.TrimSpace(line)) > 0 {
				var m map[string]any
				if jerr := json.Unmarshal(line, &m); jerr != nil {
					m = map[string]any{"type": "<non-json>", "text": string(line)}
				}
				p.lines <- fakeMsg{raw: bytes.TrimSpace(line), m: m}
			}
			if err != nil {
				return
			}
		}
	}()
	go func() { cmd.Wait(); close(p.done) }()
	t.Cleanup(func() {
		select {
		case <-p.done:
		default:
			cmd.Process.Kill()
			<-p.done
		}
	})
	return p
}

func (p *fakeProc) send(v any) {
	p.t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		p.t.Fatal(err)
	}
	if _, err := p.stdin.Write(append(data, '\n')); err != nil {
		p.t.Fatalf("write stdin: %v", err)
	}
}

func (p *fakeProc) user(text string) {
	p.t.Helper()
	p.send(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": text}})
}

func (p *fakeProc) control(id string, req map[string]any) {
	p.t.Helper()
	p.send(map[string]any{"type": "control_request", "request_id": id, "request": req})
}

func (p *fakeProc) respond(requestID string, resp map[string]any) {
	p.t.Helper()
	p.send(map[string]any{"type": "control_response", "response": map[string]any{
		"subtype": "success", "request_id": requestID, "response": resp}})
}

// next returns the next stdout message, failing after timeout.
func (p *fakeProc) next(timeout time.Duration) fakeMsg {
	p.t.Helper()
	select {
	case m, ok := <-p.lines:
		if !ok {
			p.t.Fatalf("fake claude stdout closed (stderr: %s)", p.stderr.String())
		}
		p.all = append(p.all, m)
		return m
	case <-time.After(timeout):
		p.t.Fatalf("no output within %v; so far: %v", timeout, kinds(p.all))
	}
	return fakeMsg{}
}

// until reads messages until one has a kind starting with prefix.
func (p *fakeProc) until(prefix string) fakeMsg {
	p.t.Helper()
	for {
		m := p.next(10 * time.Second)
		if strings.HasPrefix(m.kind(), prefix) {
			return m
		}
	}
}

// quiet asserts no stdout message arrives within d.
func (p *fakeProc) quiet(d time.Duration) {
	p.t.Helper()
	select {
	case m, ok := <-p.lines:
		if ok {
			p.t.Fatalf("unexpected output %s", m.raw)
		}
	case <-time.After(d):
	}
}

func (p *fakeProc) exitCode(timeout time.Duration) int {
	p.t.Helper()
	select {
	case <-p.done:
	case <-time.After(timeout):
		p.t.Fatalf("fake claude still running after %v", timeout)
	}
	return p.cmd.ProcessState.ExitCode()
}

// drain reads the rest of stdout after the process exited.
func (p *fakeProc) drain() []fakeMsg {
	var rest []fakeMsg
	for m := range p.lines {
		p.all = append(p.all, m)
		rest = append(rest, m)
	}
	return rest
}

func kinds(ms []fakeMsg) []string {
	out := make([]string, len(ms))
	for i, m := range ms {
		out[i] = m.kind()
	}
	return out
}

func str(v any, path ...string) string {
	for _, k := range path {
		m, ok := v.(map[string]any)
		if !ok {
			return ""
		}
		v = m[k]
	}
	s, _ := v.(string)
	return s
}

func get(v any, path ...string) any {
	for _, k := range path {
		m, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = m[k]
	}
	return v
}

// --- message kinds and shapes (must match testdata/gen-probe-stream.py) ---

func messageKind(m map[string]any) string {
	t := str(m, "type")
	switch t {
	case "system":
		st := str(m, "subtype")
		k := "system/" + st
		if st == "status" {
			if s := str(m, "status"); s != "" {
				k += ":" + s
			}
			for _, f := range []string{"permissionMode", "compact_result"} {
				if _, ok := m[f]; ok {
					k += "+" + f
				}
			}
		}
		return k
	case "stream_event":
		e := get(m, "event")
		k := "stream_event/" + str(e, "type")
		switch str(e, "type") {
		case "content_block_delta":
			k += "/" + str(e, "delta", "type")
		case "content_block_start":
			k += "/" + str(e, "content_block", "type")
		}
		return k
	case "assistant":
		var types []string
		for _, b := range get(m, "message", "content").([]any) {
			types = append(types, str(b, "type"))
		}
		return "assistant/" + strings.Join(types, ",")
	case "user":
		c := get(m, "message", "content")
		blocks, ok := c.([]any)
		if !ok {
			return "user/str"
		}
		var types []string
		isErr := false
		for _, b := range blocks {
			types = append(types, str(b, "type"))
			if e, _ := get(b, "is_error").(bool); e {
				isErr = true
			}
		}
		k := "user/" + strings.Join(types, ",")
		if isErr {
			k += "+error"
		}
		return k
	case "result":
		return "result/" + str(m, "subtype") + "/" + str(m, "terminal_reason")
	case "control_request":
		k := "control_request/" + str(m, "request", "subtype")
		if str(m, "request", "subtype") == "can_use_tool" {
			k += "/" + str(m, "request", "tool_name")
		}
		return k
	case "control_response":
		r, _ := get(m, "response", "response").(map[string]any)
		switch {
		case r["commands"] != nil:
			return "control_response/initialize"
		case r["still_queued"] != nil:
			return "control_response/interrupt"
		case r["mode"] != nil:
			return "control_response/set_permission_mode"
		}
		return "control_response/other"
	}
	return t
}

// shapeSkip are value-dependent objects (tool inputs, per-model maps).
var shapeSkip = map[string]bool{"input": true, "tool_use_result": true, "modelUsage": true, "tool_input": true, "updatedInput": true}

// shapeOf renders the nested key structure of v; arrays are represented by
// their first element.
func shapeOf(v any, key string) string {
	if shapeSkip[key] {
		return "*"
	}
	switch x := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, len(keys))
		for i, k := range keys {
			parts[i] = k
			if s := shapeOf(x[k], k); s != "" && s != "[]" && s != "{}" {
				parts[i] += ":" + s
			}
		}
		return "{" + strings.Join(parts, ",") + "}"
	case []any:
		if len(x) > 0 {
			switch x[0].(type) {
			case map[string]any, []any:
				return "[" + shapeOf(x[0], key) + "]"
			}
		}
		return "[]"
	}
	return ""
}

func loadProbeFixture(t *testing.T) []fakeMsg {
	t.Helper()
	data, err := os.ReadFile("testdata/probe-stream.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	var out []fakeMsg
	for _, line := range bytes.Split(bytes.TrimSpace(data), []byte("\n")) {
		var m map[string]any
		if err := json.Unmarshal(line, &m); err != nil {
			t.Fatalf("fixture line %q: %v", line, err)
		}
		out = append(out, fakeMsg{raw: line, m: m})
	}
	return out
}

// --- tests ---

// One echo turn needs no initialize and follows the probe's order: system/init
// first (every turn), then the stream events, the complete assistant message
// with the same message.id, and a result.
func TestFakeClaudeEcho(t *testing.T) {
	env := chattest.NewEnv(t)
	u := newUUID(1)
	p := startFake(t, env, t.TempDir(), streamArgs(u)...)
	for turn := 0; turn < 2; turn++ {
		p.user("echo hello world")
		var got []fakeMsg
		for {
			m := p.next(10 * time.Second)
			got = append(got, m)
			if strings.HasPrefix(m.kind(), "result/") {
				break
			}
		}
		want := []string{
			"system/init", "system/status:requesting",
			"stream_event/message_start", "stream_event/content_block_start/text",
			"stream_event/content_block_delta/text_delta", "stream_event/content_block_delta/text_delta",
			"stream_event/content_block_delta/text_delta",
			"assistant/text", "stream_event/content_block_stop", "stream_event/message_delta",
			"stream_event/message_stop", "result/success/completed",
		}
		if strings.Join(kinds(got), " ") != strings.Join(want, " ") {
			t.Fatalf("turn %d sequence:\n got %v\nwant %v", turn, kinds(got), want)
		}
		startID := str(got[2].m, "event", "message", "id")
		if startID == "" || startID != str(got[7].m, "message", "id") {
			t.Fatalf("message.id differs: start %q assistant %q", startID, str(got[7].m, "message", "id"))
		}
		var text string
		for _, m := range got[4:7] {
			text += str(m.m, "event", "delta", "text")
		}
		if text != "hello world" {
			t.Fatalf("deltas = %q", text)
		}
		blocks := get(got[7].m, "message", "content").([]any)
		if str(blocks[0], "text") != "hello world" || str(got[11].m, "result") != "hello world" {
			t.Fatalf("assistant/result text wrong: %s / %s", got[7].raw, got[11].raw)
		}
		if str(got[0].m, "session_id") != u || str(got[0].m, "claude_code_version") != "2.1.210" {
			t.Fatalf("init = %s", got[0].raw)
		}
	}
	p.stdin.Close()
	if code := p.exitCode(5 * time.Second); code != 0 {
		t.Fatalf("exit after EOF = %d", code)
	}
}

// Every message kind the probe recorded from real claude 2.1.210 (that the
// fake is meant to produce) must come out of the fake with the same nested
// key structure, so tests on the fake keep matching real claude.
func TestFakeClaudeMatchesProbe(t *testing.T) {
	fixture := loadProbeFixture(t)
	// Real claude kinds the fake deliberately does not produce: extended
	// thinking, hook progress lines. The client must still parse them; that
	// is covered by the fixture itself (T8).
	notProduced := map[string]bool{
		"assistant/thinking": true, "stream_event/content_block_start/thinking": true,
		"stream_event/content_block_delta/thinking_delta": true, "stream_event/content_block_delta/signature_delta": true,
		"system/thinking_tokens": true, "system/hook_progress": true,
	}

	env := chattest.NewEnv(t)
	env.Extra = append(env.Extra, "FAKE_CLAUDE_HOOK_LINES=1")
	p := startFake(t, env, t.TempDir(), streamArgs(newUUID(2))...)

	p.control("init-1", map[string]any{"subtype": "initialize"})
	p.until("control_response/initialize")
	p.user("echo hi")
	p.until("result/")

	p.user("perm touch a.txt suggest")
	req := p.until("control_request/can_use_tool/Bash")
	p.respond(str(req.m, "request_id"), map[string]any{"behavior": "allow", "updatedInput": get(req.m, "request", "input")})
	p.until("result/")

	p.user("perm touch b.txt suggest")
	req = p.until("control_request/can_use_tool/Bash")
	p.respond(str(req.m, "request_id"), map[string]any{"behavior": "deny", "message": "no"})
	p.until("result/")

	p.user("tool Read")
	p.until("result/")

	p.user("slow 50 200")
	p.until("stream_event/content_block_delta/text_delta")
	p.control("int-1", map[string]any{"subtype": "interrupt"})
	p.until("result/error_during_execution/aborted_streaming")

	p.user("perm touch c.txt suggest")
	p.until("control_request/can_use_tool/Bash")
	p.control("int-2", map[string]any{"subtype": "interrupt"})
	p.until("result/error_during_execution/aborted_tools")

	p.control("mode-1", map[string]any{"subtype": "set_permission_mode", "mode": "plan"})
	p.until("system/status+permissionMode")
	p.user("plan")
	req = p.until("control_request/can_use_tool/ExitPlanMode")
	p.respond(str(req.m, "request_id"), map[string]any{"behavior": "deny", "message": "make it shorter"})
	req = p.until("control_request/can_use_tool/ExitPlanMode")
	p.respond(str(req.m, "request_id"), map[string]any{"behavior": "allow", "updatedInput": get(req.m, "request", "input")})
	p.until("result/")

	p.user("ask")
	req = p.until("control_request/can_use_tool/AskUserQuestion")
	in := get(req.m, "request", "input").(map[string]any)
	in["answers"] = map[string]any{"Pick a fruit": "Apple"}
	p.respond(str(req.m, "request_id"), map[string]any{"behavior": "allow", "updatedInput": in})
	p.until("result/")

	p.user("/compact")
	p.until("result/success/")
	p.user("fail")
	p.until("result/")
	p.stdin.Close()
	if code := p.exitCode(5 * time.Second); code != 0 {
		t.Fatalf("exit = %d (stderr %s)", code, p.stderr)
	}
	produced := append(p.all, p.drain()...)

	// --resume of a conversation that has no transcript (V21).
	r := startFake(t, env, t.TempDir(), "-p", "--input-format", "stream-json", "--output-format", "stream-json",
		"--verbose", "--resume", newUUID(3))
	if code := r.exitCode(5 * time.Second); code != 1 {
		t.Fatalf("resume missing: exit %d", code)
	}
	produced = append(produced, r.drain()...)

	fakeShapes := map[string]map[string]bool{}
	for _, m := range produced {
		k := m.kind()
		if fakeShapes[k] == nil {
			fakeShapes[k] = map[string]bool{}
		}
		fakeShapes[k][shapeOf(m.m, "")] = true
	}
	realShapes := map[string]map[string]bool{}
	for _, m := range fixture {
		k := m.kind()
		if realShapes[k] == nil {
			realShapes[k] = map[string]bool{}
		}
		realShapes[k][shapeOf(m.m, "")] = true
	}
	checked := 0
	for k, real := range realShapes {
		if notProduced[k] {
			continue
		}
		fake, ok := fakeShapes[k]
		if !ok {
			t.Errorf("fake never produced %s", k)
			continue
		}
		checked++
		for s := range fake {
			if !real[s] {
				t.Errorf("%s: fake shape not seen in real claude\n fake %s\n real %v", k, s, keysOfSet(real))
			}
		}
		for s := range real {
			if !fake[s] {
				t.Errorf("%s: real shape never produced by fake\n real %s\n fake %v", k, s, keysOfSet(fake))
			}
		}
	}
	for k := range fakeShapes {
		if _, ok := realShapes[k]; !ok {
			t.Errorf("fake produced %s, which the probe never saw", k)
		}
	}
	if checked < 30 {
		t.Fatalf("only %d kinds compared", checked)
	}
}

func keysOfSet(m map[string]bool) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

func readLines(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return strings.Split(strings.TrimSpace(string(data)), "\n")
}

// The behaviours later tasks rely on (design 9.2).
func TestFakeClaudeBehaviours(t *testing.T) {
	t.Run("sigterm exits 143 and removes the pid file", func(t *testing.T) {
		env := chattest.NewEnv(t)
		u := newUUID(10)
		p := startFake(t, env, t.TempDir(), streamArgs(u)...)
		p.user("slow 100 100")
		p.until("stream_event/content_block_delta")
		if len(env.LivePids(u)) != 1 {
			t.Fatalf("pid files = %v", env.LivePids(u))
		}
		p.cmd.Process.Signal(syscall.SIGTERM)
		if code := p.exitCode(3 * time.Second); code != 143 {
			t.Fatalf("exit = %d", code)
		}
		if len(env.LivePids(u)) != 0 {
			t.Fatalf("pid file left: %v", env.LivePids(u))
		}
	})

	t.Run("stubborn ignores SIGTERM, interrupt and EOF", func(t *testing.T) {
		env := chattest.NewEnv(t)
		env.Extra = append(env.Extra, "FAKE_CLAUDE_STUBBORN=1")
		p := startFake(t, env, t.TempDir(), streamArgs(newUUID(11))...)
		p.user("echo x")
		p.until("result/")
		p.user("slow 100 100")
		p.until("stream_event/content_block_delta")
		p.control("int", map[string]any{"subtype": "interrupt"})
		p.cmd.Process.Signal(syscall.SIGTERM)
		p.stdin.Close()
		deadline := time.Now().Add(3 * time.Second)
		for !strings.Contains(strings.Join(readLines(t, env.SignalLog), "\n"), "SIGTERM ignored") {
			if time.Now().After(deadline) {
				t.Fatal("no SIGTERM ignored in signal log")
			}
			time.Sleep(20 * time.Millisecond)
		}
		select {
		case <-p.done:
			t.Fatal("stubborn fake exited")
		case <-time.After(300 * time.Millisecond):
		}
		p.cmd.Process.Kill()
		p.exitCode(3 * time.Second)
		for _, m := range p.drain() {
			if m.kind() == "control_response/interrupt" {
				t.Fatal("stubborn fake answered the interrupt")
			}
		}
	})

	t.Run("exit after the nth result", func(t *testing.T) {
		env := chattest.NewEnv(t)
		env.Extra = append(env.Extra, "FAKE_CLAUDE_EXIT_AFTER_RESULT=2")
		p := startFake(t, env, t.TempDir(), streamArgs(newUUID(12))...)
		p.user("echo a")
		p.user("echo b")
		p.user("echo c")
		if code := p.exitCode(5 * time.Second); code != 143 {
			t.Fatalf("exit = %d", code)
		}
		results := 0
		for _, m := range p.drain() {
			if strings.HasPrefix(m.kind(), "result/") {
				results++
			}
		}
		if results != 2 {
			t.Fatalf("results = %d, want 2", results)
		}
	})

	t.Run("two live processes on one session id write VIOLATION", func(t *testing.T) {
		env := chattest.NewEnv(t)
		u := newUUID(13)
		first := startFake(t, env, t.TempDir(), streamArgs(u)...)
		first.stdin.Close()
		first.exitCode(5 * time.Second)
		second := startFake(t, env, t.TempDir(), streamArgs(u)...)
		second.user("echo x")
		second.until("result/")
		if v := env.Violation(); v != "" {
			t.Fatalf("sequential processes flagged: %s", v)
		}
		third := startFake(t, env, t.TempDir(), streamArgs(u)...)
		third.user("echo y")
		third.until("result/")
		if env.Violation() == "" {
			t.Fatal("no VIOLATION for two live processes")
		}
	})

	t.Run("nested claude environment refused", func(t *testing.T) {
		env := chattest.NewEnv(t)
		env.Extra = append(env.Extra, "CLAUDECODE=1")
		p := startFake(t, env, t.TempDir(), streamArgs(newUUID(14))...)
		if code := p.exitCode(5 * time.Second); code != 1 {
			t.Fatalf("exit = %d", code)
		}
		if _, err := os.Stat(filepath.Join(env.PidDir, "NESTED")); err != nil {
			t.Fatal("no NESTED marker")
		}
	})

	t.Run("queued message runs after interrupt; still_queued empty", func(t *testing.T) {
		env := chattest.NewEnv(t)
		p := startFake(t, env, t.TempDir(), streamArgs(newUUID(15))...)
		p.user("slow 50 200")
		p.until("stream_event/content_block_delta")
		p.user("echo queued")
		p.control("int", map[string]any{"subtype": "interrupt"})
		ack := p.until("control_response/interrupt")
		if q, ok := get(ack.m, "response", "response", "still_queued").([]any); !ok || len(q) != 0 {
			t.Fatalf("still_queued = %s", ack.raw)
		}
		p.until("user/text")
		p.until("result/error_during_execution/aborted_streaming")
		p.until("system/init")
		r := p.until("result/")
		if str(r.m, "result") != "queued" {
			t.Fatalf("queued turn result = %s", r.raw)
		}
	})

	t.Run("interrupt with pending request cancels it first", func(t *testing.T) {
		env := chattest.NewEnv(t)
		p := startFake(t, env, t.TempDir(), streamArgs(newUUID(16))...)
		p.user("perm touch x")
		req := p.until("control_request/can_use_tool/Bash")
		p.control("int", map[string]any{"subtype": "interrupt"})
		c := p.next(5 * time.Second)
		if c.kind() != "control_cancel_request" || str(c.m, "request_id") != str(req.m, "request_id") {
			t.Fatalf("first after interrupt = %s", c.raw)
		}
		want := []string{"control_response/interrupt", "user/tool_result+error", "user/text", "result/error_during_execution/aborted_tools"}
		for _, k := range want {
			if m := p.next(5 * time.Second); m.kind() != k {
				t.Fatalf("got %s, want %s", m.kind(), k)
			}
		}
	})

	t.Run("plan approval restores pre-plan mode, then honours set_permission_mode", func(t *testing.T) {
		for _, tc := range []struct {
			setMode, final string
			writeAsks      bool
		}{
			{"default", "default", true},
			{"acceptEdits", "acceptEdits", false},
		} {
			env := chattest.NewEnv(t)
			p := startFake(t, env, t.TempDir(), streamArgs(newUUID(17))...)
			p.control("m1", map[string]any{"subtype": "set_permission_mode", "mode": "acceptEdits"})
			p.until("system/status+permissionMode")
			p.control("m2", map[string]any{"subtype": "set_permission_mode", "mode": "plan"})
			p.until("system/status+permissionMode")
			p.user("plan")
			req := p.until("control_request/can_use_tool/ExitPlanMode")
			p.respond(str(req.m, "request_id"), map[string]any{"behavior": "allow", "updatedInput": get(req.m, "request", "input")})
			p.control("m3", map[string]any{"subtype": "set_permission_mode", "mode": tc.setMode})
			restored := p.until("system/status+permissionMode")
			if str(restored.m, "permissionMode") != "acceptEdits" {
				t.Fatalf("restored = %s, want pre-plan acceptEdits", restored.raw)
			}
			p.until("result/")
			p.user("tool Write")
			var asked bool
			for {
				m := p.next(5 * time.Second)
				if m.kind() == "control_request/can_use_tool/Write" {
					asked = true
					p.respond(str(m.m, "request_id"), map[string]any{"behavior": "allow", "updatedInput": get(m.m, "request", "input")})
				}
				if m.kind() == "system/init" && str(m.m, "permissionMode") != tc.final {
					t.Fatalf("%s: init mode = %s", tc.setMode, str(m.m, "permissionMode"))
				}
				if strings.HasPrefix(m.kind(), "result/") {
					break
				}
			}
			if asked != tc.writeAsks {
				t.Fatalf("setMode %s: Write asked = %v", tc.setMode, asked)
			}
		}
	})

	t.Run("bypass skips tool prompts but still asks questions and plans", func(t *testing.T) {
		env := chattest.NewEnv(t)
		p := startFake(t, env, t.TempDir(), streamArgs(newUUID(18), "--dangerously-skip-permissions")...)
		p.user("tool Bash")
		for {
			m := p.next(5 * time.Second)
			if strings.HasPrefix(m.kind(), "control_request") {
				t.Fatalf("bypass asked: %s", m.raw)
			}
			if m.kind() == "system/init" && str(m.m, "permissionMode") != "bypassPermissions" {
				t.Fatalf("init = %s", m.raw)
			}
			if strings.HasPrefix(m.kind(), "result/") {
				break
			}
		}
		p.user("ask")
		p.until("control_request/can_use_tool/AskUserQuestion")
		p.control("int", map[string]any{"subtype": "interrupt"})
		p.until("result/")
		p.user("plan")
		p.until("control_request/can_use_tool/ExitPlanMode")
	})

	t.Run("always-allow rule stops later prompts", func(t *testing.T) {
		env := chattest.NewEnv(t)
		p := startFake(t, env, t.TempDir(), streamArgs(newUUID(19))...)
		p.user("perm touch x suggest")
		req := p.until("control_request/can_use_tool/Bash")
		sugg := get(req.m, "request", "permission_suggestions").([]any)
		if len(sugg) != 3 {
			t.Fatalf("suggestions = %v", sugg)
		}
		p.respond(str(req.m, "request_id"), map[string]any{"behavior": "allow",
			"updatedInput": get(req.m, "request", "input"), "updatedPermissions": sugg[:2]})
		p.until("result/")
		if lines := readLines(t, env.RulesFile); len(lines) != 1 || lines[0] != "Bash(touch x)" {
			t.Fatalf("rules = %q", lines)
		}
		p.user("perm touch x")
		for {
			m := p.next(5 * time.Second)
			if strings.HasPrefix(m.kind(), "control_request") {
				t.Fatal("asked again despite the rule")
			}
			if strings.HasPrefix(m.kind(), "result/") {
				break
			}
		}
		// A setMode suggestion switches to acceptEdits.
		p.user("perm touch y mode")
		req = p.until("control_request/can_use_tool/Bash")
		sugg = get(req.m, "request", "permission_suggestions").([]any)
		p.respond(str(req.m, "request_id"), map[string]any{"behavior": "allow",
			"updatedInput": get(req.m, "request", "input"), "updatedPermissions": sugg})
		if m := p.until("system/status+permissionMode"); str(m.m, "permissionMode") != "acceptEdits" {
			t.Fatalf("status = %s", m.raw)
		}
	})

	t.Run("allow without updatedInput is fatal", func(t *testing.T) {
		env := chattest.NewEnv(t)
		p := startFake(t, env, t.TempDir(), streamArgs(newUUID(20))...)
		p.user("perm touch x")
		req := p.until("control_request/can_use_tool/Bash")
		p.respond(str(req.m, "request_id"), map[string]any{"behavior": "allow"})
		if code := p.exitCode(5 * time.Second); code == 0 {
			t.Fatal("fake accepted allow without updatedInput")
		}
	})

	t.Run("cancel withdraws its own request", func(t *testing.T) {
		env := chattest.NewEnv(t)
		p := startFake(t, env, t.TempDir(), streamArgs(newUUID(21))...)
		p.user("cancel")
		req := p.until("control_request/can_use_tool")
		c := p.until("control_cancel_request")
		if str(c.m, "request_id") != str(req.m, "request_id") {
			t.Fatalf("cancel %s for request %s", c.raw, req.raw)
		}
		p.until("result/success")
	})

	t.Run("swallow delays its result", func(t *testing.T) {
		env := chattest.NewEnv(t)
		p := startFake(t, env, t.TempDir(), streamArgs(newUUID(22))...)
		p.user("swallow 300")
		p.quiet(150 * time.Millisecond)
		p.until("result/success")
	})

	t.Run("transcript is written and resumable", func(t *testing.T) {
		env := chattest.NewEnv(t)
		u := newUUID(23)
		dir := t.TempDir()
		p := startFake(t, env, dir, streamArgs(u)...)
		p.user("echo remember")
		p.until("result/")
		p.stdin.Close()
		p.exitCode(5 * time.Second)
		canon, _ := filepath.EvalSymlinks(dir)
		path := filepath.Join(env.ConfigDir, "projects", EncodeProjectDir(canon), u+".jsonl")
		lines := readLines(t, path)
		var types []string
		for _, l := range lines {
			var m map[string]any
			if err := json.Unmarshal([]byte(l), &m); err != nil {
				t.Fatal(err)
			}
			types = append(types, str(m, "type"))
			if str(m, "type") == "user" && (str(m, "cwd") != canon || str(m, "sessionId") != u) {
				t.Fatalf("user line %s", l)
			}
		}
		if strings.Join(types, ",") != "queue-operation,user,assistant" {
			t.Fatalf("transcript types = %v", types)
		}
		r := startFake(t, env, dir, "-p", "--input-format", "stream-json", "--output-format", "stream-json",
			"--verbose", "--resume", u)
		r.user("echo again")
		if init := r.until("system/init"); str(init.m, "session_id") != u {
			t.Fatalf("resumed init = %s", init.raw)
		}
		r.until("result/")
	})

	t.Run("interactive branch", func(t *testing.T) {
		env := chattest.NewEnv(t)
		u := newUUID(24)
		dir := t.TempDir()
		p := startFake(t, env, dir, "--session-id", u)
		if m := p.next(5 * time.Second); str(m.m, "text") != "fake-claude interactive session="+u+"\n" {
			t.Fatalf("banner = %q", m.raw)
		}
		if len(env.LivePids(u)) != 1 {
			t.Fatal("interactive fake did not register a pid file")
		}
		canon, _ := filepath.EvalSymlinks(dir)
		lines := readLines(t, filepath.Join(env.ConfigDir, "projects", EncodeProjectDir(canon), u+".jsonl"))
		if len(lines) != 1 || !strings.Contains(lines[0], `"cwd":"`+canon+`"`) || !strings.Contains(lines[0], `"sessionId":"`+u+`"`) {
			t.Fatalf("interactive transcript = %q", lines)
		}
		io.WriteString(p.stdin, "ping\n")
		if m := p.next(5 * time.Second); str(m.m, "text") != "ping\n" {
			t.Fatalf("echo = %q", m.raw)
		}
		p.stdin.Close()
		p.exitCode(5 * time.Second)
		if len(env.LivePids(u)) != 0 {
			t.Fatal("pid file left after interactive exit")
		}
		// --resume prints its own banner.
		r := startFake(t, env, dir, "--resume", u)
		if m := r.next(5 * time.Second); str(m.m, "text") != "fake-claude interactive resume="+u+"\n" {
			t.Fatalf("resume banner = %q", m.raw)
		}
	})

	t.Run("init knobs", func(t *testing.T) {
		env := chattest.NewEnv(t)
		env.Extra = append(env.Extra, "FAKE_CLAUDE_CAPS=", "FAKE_CLAUDE_INIT_VERSION=none", "FAKE_CLAUDE_NO_INIT_REPLY=1")
		p := startFake(t, env, t.TempDir(), streamArgs(newUUID(25))...)
		p.control("init-1", map[string]any{"subtype": "initialize"})
		p.user("echo x")
		init := p.next(5 * time.Second)
		if init.kind() != "system/init" {
			t.Fatalf("initialize was answered: %s", init.raw)
		}
		if _, ok := init.m["capabilities"]; ok {
			t.Fatal("capabilities present with FAKE_CLAUDE_CAPS empty")
		}
		if _, ok := init.m["claude_code_version"]; ok {
			t.Fatal("version present with FAKE_CLAUDE_INIT_VERSION=none")
		}
		p.until("result/")

		env2 := chattest.NewEnv(t)
		env2.Extra = append(env2.Extra, "FAKE_CLAUDE_CAPS=msg_lifecycle_v1", "FAKE_CLAUDE_INIT_VERSION=1.0.0")
		q := startFake(t, env2, t.TempDir(), streamArgs(newUUID(26))...)
		q.user("echo x")
		init = q.until("system/init")
		if fmt.Sprint(init.m["capabilities"]) != "[msg_lifecycle_v1]" || str(init.m, "claude_code_version") != "1.0.0" {
			t.Fatalf("init = %s", init.raw)
		}
	})

	t.Run("crash writes stderr and exits with the code", func(t *testing.T) {
		env := chattest.NewEnv(t)
		u := newUUID(27)
		p := startFake(t, env, t.TempDir(), streamArgs(u)...)
		p.user("crash 3")
		if code := p.exitCode(5 * time.Second); code != 3 {
			t.Fatalf("exit = %d", code)
		}
		if strings.Count(p.stderr.String(), "\n") != 3 {
			t.Fatalf("stderr = %q", p.stderr)
		}
		if len(env.LivePids(u)) != 0 {
			t.Fatal("pid file left after crash")
		}
	})

	t.Run("version flag", func(t *testing.T) {
		out, err := exec.Command(filepath.Join(chattest.FakeClaude(t), "claude"), "--version").Output()
		if err != nil || string(out) != "2.1.210 (Claude Code)\n" {
			t.Fatalf("--version = %q, %v", out, err)
		}
	})
}

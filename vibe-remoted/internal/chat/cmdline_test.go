package chat

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat/chattest"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// The CLAUDE.md example claude_cmd: -c is lifted out (the daemon picks the
// conversation), bypass is detected and kept as an argument.
func TestParseClaudeMdExample(t *testing.T) {
	p, reason := ParseClaudeCmd("claude --dangerously-skip-permissions -c")
	if reason != "" {
		t.Fatalf("reason = %q", reason)
	}
	want := Parsed{Exe: "claude", Args: []string{"--dangerously-skip-permissions"}, Continue: true, Bypass: true}
	if !reflect.DeepEqual(p, want) {
		t.Fatalf("parsed = %+v, want %+v", p, want)
	}
	p, _ = ParseClaudeCmd("claude --continue --permission-mode bypassPermissions")
	if !p.Continue || !p.Bypass || p.PermissionMode != "bypassPermissions" ||
		!reflect.DeepEqual(p.Args, []string{"--permission-mode", "bypassPermissions"}) {
		t.Fatalf("parsed = %+v", p)
	}
	p, _ = ParseClaudeCmd("claude --permission-mode=plan")
	if p.Bypass || p.PermissionMode != "plan" {
		t.Fatalf("parsed = %+v", p)
	}
}

func TestParseNotClaude(t *testing.T) {
	for _, cmd := range []string{"/bin/bash", "codex", "", "claude-code", "FOO=1 claude"} {
		if _, reason := ParseClaudeCmd(cmd); reason != protocol.ChatReasonNotClaude {
			t.Errorf("%q: reason = %q, want not_claude", cmd, reason)
		}
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	for cmd, exe := range map[string]string{
		"claude":                    "claude",
		"/usr/local/bin/claude":     "/usr/local/bin/claude",
		"~/.local/bin/claude":       home + "/.local/bin/claude",
		"'/opt/my tools/claude' -c": "/opt/my tools/claude",
	} {
		p, reason := ParseClaudeCmd(cmd)
		if reason != "" || p.Exe != exe {
			t.Errorf("%q: parsed %+v reason %q, want exe %q", cmd, p, reason, exe)
		}
	}
	// A quoted ~ is literal, as in the shell.
	if p, _ := ParseClaudeCmd("'~/claude'"); p.Exe != "~/claude" {
		t.Errorf("quoted tilde expanded: %q", p.Exe)
	}
}

func TestParseRejectsShellSyntax(t *testing.T) {
	for _, cmd := range []string{
		"claude | tee log", "claude; rm -rf x", "claude $(whoami)", "claude `id`",
		"claude && echo", "claude > out", "claude \"$HOME\"", "claude 'open", "claude *",
		"claude # comment", "claude\nrm x",
	} {
		if _, reason := ParseClaudeCmd(cmd); reason != protocol.ChatReasonShellSyntax {
			t.Errorf("%q: reason = %q, want shell_syntax", cmd, reason)
		}
	}
	// Quoting makes the same characters plain arguments.
	p, reason := ParseClaudeCmd(`claude --append-system-prompt 'a | b; $(c)' "d \"e\""`)
	if reason != "" || !reflect.DeepEqual(p.Args, []string{"--append-system-prompt", "a | b; $(c)", `d "e"`}) {
		t.Fatalf("parsed %+v reason %q", p, reason)
	}
}

func TestParseRejectsConflictingArgs(t *testing.T) {
	for _, cmd := range []string{
		"claude -p", "claude --print", "claude --resume x", "claude -r x", "claude --session-id x",
		"claude --output-format json", "claude --input-format=stream-json", "claude --fork-session",
		"claude --permission-prompt-tool stdio", "claude --resume=x",
	} {
		if _, reason := ParseClaudeCmd(cmd); reason != protocol.ChatReasonConflictingArgs {
			t.Errorf("%q: reason = %q, want conflicting_args", cmd, reason)
		}
	}
}

// restoreArgv lets a real shell word-split cmd and returns the words.
func restoreArgv(t *testing.T, cmd string) []string {
	t.Helper()
	out, err := exec.Command("/bin/sh", "-c", `set -- `+cmd+`; for a do printf '%s\000' "$a"; done`).Output()
	if err != nil {
		t.Fatalf("sh: %v", err)
	}
	parts := strings.Split(string(out), "\x00")
	return parts[:len(parts)-1]
}

func TestHandoffCommandQuoting(t *testing.T) {
	p, reason := ParseClaudeCmd(`claude --append-system-prompt "it's a b" --model 'x y' -c`)
	if reason != "" {
		t.Fatal(reason)
	}
	u := "0b6c1f7e-2a3d-4c5e-8f90-123456789abc"
	got := restoreArgv(t, HandoffCommand(p.Exe, p.Args, u, true))
	want := []string{"claude", "--append-system-prompt", "it's a b", "--model", "x y", "--resume", u}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("resume: %q, want %q", got, want)
	}
	got = restoreArgv(t, HandoffCommand(p.Exe, append(p.Args, "-c"), u, false))
	want[len(want)-2] = "--session-id"
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("session-id: %q, want %q", got, want)
	}
	if strings.Contains(HandoffCommand(p.Exe, p.Args, u, true), " -c") {
		t.Fatal("handoff command kept -c")
	}
	// ShellJoin round-trips awkward words.
	words := []string{"a", "", "b c", "'", `\`, "$x", "!", "~", "*"}
	if got := restoreArgv(t, ShellJoin(words)); !reflect.DeepEqual(got, words) {
		t.Fatalf("ShellJoin round trip: %q", got)
	}
}

// The chat argv is a pure function of the parsed configuration and daemon
// constants (design 7.1: the client can never contribute command words).
func TestCommandFromConfigOnly(t *testing.T) {
	p, reason := ParseClaudeCmd("/usr/local/bin/claude --dangerously-skip-permissions --model sonnet -c")
	if reason != "" {
		t.Fatal(reason)
	}
	u := "11111111-2222-4333-8444-555555555555"
	want := []string{
		"/usr/local/bin/claude", "--dangerously-skip-permissions", "--model", "sonnet",
		"-p", "--input-format", "stream-json", "--output-format", "stream-json",
		"--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio",
		"--session-id", u,
	}
	if got := ChatArgv(p, u, false); !reflect.DeepEqual(got, want) {
		t.Fatalf("new:\n got %q\nwant %q", got, want)
	}
	want[len(want)-2] = "--resume"
	if got := ChatArgv(p, u, true); !reflect.DeepEqual(got, want) {
		t.Fatalf("resume:\n got %q\nwant %q", got, want)
	}
}

// claude_cmd "~/.local/bin/claude" must really start claude both through a
// login shell (single quotes stop the shell from expanding ~) and as argv.
func TestAssembledCommandRuns(t *testing.T) {
	fake := filepath.Join(chattest.FakeClaude(t), "claude")
	home := t.TempDir()
	t.Setenv("HOME", home)
	bin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(fake)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "claude"), data, 0o755); err != nil {
		t.Fatal(err)
	}
	env := chattest.NewEnv(t)

	p, reason := ParseClaudeCmd("~/.local/bin/claude --append-system-prompt \"it's\"")
	if reason != "" {
		t.Fatal(reason)
	}
	u := "11111111-2222-4333-8444-555555555555"
	argv := ChatArgv(p, u, false)

	for name, cmd := range map[string]*exec.Cmd{
		"argv":        exec.Command(argv[0], argv[1:]...),
		"login shell": exec.Command("/bin/sh", "-lc", "exec "+ShellJoin(argv)),
	} {
		os.Remove(env.ArgvLog)
		cmd.Env = env.Environ()
		cmd.Stdin = bytes.NewReader(nil) // EOF: the fake exits once idle
		cmd.Dir = t.TempDir()
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%s: %v\n%s", name, err, out)
		}
		logged, err := os.ReadFile(env.ArgvLog)
		if err != nil {
			t.Fatalf("%s: no argv logged: %v", name, err)
		}
		var got []string
		if err := json.Unmarshal(bytes.TrimSpace(logged), &got); err != nil {
			t.Fatalf("%s: argv log %q: %v", name, logged, err)
		}
		if !reflect.DeepEqual(got[1:], argv[1:]) || filepath.Base(got[0]) != "claude" {
			t.Fatalf("%s: argv = %q, want %q", name, got, argv)
		}
	}
}

// Only words in option position are flags: an option's value that looks
// like -c, a bypass flag or a session-control flag is just a value.
func TestParseOptionValuesAreNotFlags(t *testing.T) {
	for _, tc := range []struct {
		cmd            string
		args           []string
		cont, bypass   bool
		permissionMode string
	}{
		{cmd: "claude --append-system-prompt -c", args: []string{"--append-system-prompt", "-c"}},
		{cmd: "claude --append-system-prompt --dangerously-skip-permissions",
			args: []string{"--append-system-prompt", "--dangerously-skip-permissions"}},
		{cmd: "claude --system-prompt --resume", args: []string{"--system-prompt", "--resume"}},
		{cmd: "claude --model -p", args: []string{"--model", "-p"}},
		{cmd: "claude --append-system-prompt=-c -c", args: []string{"--append-system-prompt=-c"}, cont: true},
		{cmd: "claude --model=opus --permission-mode=bypassPermissions",
			args: []string{"--model=opus", "--permission-mode=bypassPermissions"}, bypass: true, permissionMode: "bypassPermissions"},
		{cmd: "claude --add-dir /a /b -c --dangerously-skip-permissions",
			args: []string{"--add-dir", "/a", "/b", "--dangerously-skip-permissions"}, cont: true, bypass: true},
		{cmd: "claude -- -c --dangerously-skip-permissions", args: []string{"--", "-c", "--dangerously-skip-permissions"}},
		{cmd: "claude --permission-mode plan -c", args: []string{"--permission-mode", "plan"}, cont: true, permissionMode: "plan"},
		// claude 2.1.210 options that take a value (G6).
		{cmd: "claude -n -c", args: []string{"-n", "-c"}},
		{cmd: "claude --name -c", args: []string{"--name", "-c"}},
		{cmd: "claude --effort -c", args: []string{"--effort", "-c"}},
		{cmd: "claude --debug-file --dangerously-skip-permissions", args: []string{"--debug-file", "--dangerously-skip-permissions"}},
		{cmd: "claude --plugin-url -c", args: []string{"--plugin-url", "-c"}},
		{cmd: "claude --remote-control-session-name-prefix -c", args: []string{"--remote-control-session-name-prefix", "-c"}},
		{cmd: "claude --file a:x.txt b:y.txt -c", args: []string{"--file", "a:x.txt", "b:y.txt"}, cont: true},
		// --plugin-dir takes one value per occurrence (repeatable, not variadic).
		{cmd: "claude --plugin-dir /p hello -c", args: []string{"--plugin-dir", "/p", "hello"}, cont: true},
	} {
		p, reason := ParseClaudeCmd(tc.cmd)
		if reason != "" {
			t.Errorf("%q: reason %q", tc.cmd, reason)
			continue
		}
		if !reflect.DeepEqual(p.Args, tc.args) || p.Continue != tc.cont || p.Bypass != tc.bypass || p.PermissionMode != tc.permissionMode {
			t.Errorf("%q: parsed %+v, want args %q continue=%v bypass=%v mode=%q",
				tc.cmd, p, tc.args, tc.cont, tc.bypass, tc.permissionMode)
		}
	}
}

// A handoff keeps a -c that is an option's value; it only drops -c/--continue
// in option position.
func TestHandoffKeepsContinueLikeOptionValues(t *testing.T) {
	u := "11111111-2222-4333-8444-555555555555"
	for _, tc := range []struct{ args, want []string }{
		{[]string{"--append-system-prompt", "-c"}, []string{"claude", "--append-system-prompt", "-c", "--session-id", u}},
		{[]string{"--append-system-prompt=x", "-c"}, []string{"claude", "--append-system-prompt=x", "--session-id", u}},
		{[]string{"--", "-c"}, []string{"claude", "--session-id", u, "--", "-c"}},
	} {
		if got := restoreArgv(t, HandoffCommand("claude", tc.args, u, false)); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("handoff %q = %q, want %q", tc.args, got, tc.want)
		}
	}
}

// End to end: the prompt value "-c" stays a value, so the chat process
// still runs headless (the fake claude reports interactive mode otherwise).
func TestChatArgvKeepsPromptValueContinue(t *testing.T) {
	exe := filepath.Join(chattest.FakeClaude(t), "claude")
	p, reason := ParseClaudeCmd(ShellJoin([]string{exe, "--append-system-prompt", "-c"}))
	if reason != "" {
		t.Fatal(reason)
	}
	argv := ChatArgv(p, "11111111-2222-4333-8444-555555555555", false)
	cmd := exec.Command(argv[0], argv[1:]...)
	env := chattest.NewEnv(t)
	cmd.Env, cmd.Dir, cmd.Stdin = env.Environ(), t.TempDir(), bytes.NewBufferString("")
	out, _ := cmd.CombinedOutput()
	if p.Continue || strings.Contains(string(out), "interactive") {
		t.Fatalf("prompt value -c taken as continue: continue=%v argv=%q out=%s", p.Continue, argv, out)
	}
}

// Words after "--" are positional, so the daemon's own options go before it.
func TestDaemonArgsGoBeforeDashDash(t *testing.T) {
	u := "11111111-2222-4333-8444-555555555555"
	p, reason := ParseClaudeCmd("claude --model opus -- -c")
	if reason != "" {
		t.Fatal(reason)
	}
	argv := ChatArgv(p, u, true)
	want := append(append([]string{"claude", "--model", "opus"}, streamJSONArgs...), "--resume", u, "--", "-c")
	if !reflect.DeepEqual(argv, want) {
		t.Fatalf("chat argv = %q, want %q", argv, want)
	}
	if got, want := HandoffArgv(p.Exe, p.Args, u, false), []string{"claude", "--model", "opus", "--session-id", u, "--", "-c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("handoff argv = %q, want %q", got, want)
	}
}

// Every claude option that takes a value (`<…>` in `claude --help`) is in
// valueOptions, variadic exactly when its value is `<…...>`. The help text is
// a committed snapshot: regenerate it on a claude upgrade
// (claude --help > testdata/claude-help-<version>.txt) to surface new options.
func TestValueOptionsCoverClaudeHelp(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "claude-help-2.1.210.txt"))
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, line := range strings.Split(string(raw), "\n") {
		// Option lines are indented by exactly two spaces; continuation
		// lines of descriptions are indented much deeper.
		if !strings.HasPrefix(line, "  -") {
			continue
		}
		spec := strings.TrimSpace(line)
		if i := strings.Index(spec, "  "); i >= 0 {
			spec = spec[:i]
		}
		lt := strings.Index(spec, "<")
		if lt < 0 {
			continue // no value, or an optional [value]
		}
		variadic := strings.Contains(spec[lt:], "...>")
		for _, name := range strings.Fields(spec[:lt]) {
			name = strings.TrimSuffix(name, ",")
			vo, ok := valueOptions[name]
			if !ok {
				t.Errorf("%s (%q) takes a value but is not in valueOptions", name, spec)
				continue
			}
			if vo.variadic != variadic {
				t.Errorf("%s: variadic=%v, claude --help says %q", name, vo.variadic, spec)
			}
			checked++
		}
	}
	if checked < 25 {
		t.Fatalf("only %d options checked: help snapshot not parsed", checked)
	}
}

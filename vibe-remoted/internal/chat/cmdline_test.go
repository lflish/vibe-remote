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

// Package chattest holds test helpers for chat sessions: building the fake
// claude, an isolated environment for it, and claude's workdir trust file.
package chattest

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const fakeClaudePkg = "github.com/lflish/vibe-remote/vibe-remoted/internal/chat/fakeclaude"

var (
	buildOnce sync.Once
	buildDir  string
	buildErr  error
)

// FakeClaude builds internal/chat/fakeclaude once per test binary and returns
// the directory holding the executable, which is named "claude" (so it passes
// the "is this claude" check).
func FakeClaude(t testing.TB) string {
	t.Helper()
	buildOnce.Do(func() {
		dir, err := os.MkdirTemp("", "vibe-remote-fakeclaude-")
		if err != nil {
			buildErr = err
			return
		}
		out, err := exec.Command("go", "build", "-o", filepath.Join(dir, "claude"), fakeClaudePkg).CombinedOutput()
		if err != nil {
			buildErr = fmt.Errorf("go build fakeclaude: %v\n%s", err, out)
			return
		}
		buildDir = dir
	})
	if buildErr != nil {
		t.Fatal(buildErr)
	}
	return buildDir
}

// Env is an isolated environment for one fake claude run: its own claude
// config dir (transcripts, trust file) and the fake's log/marker files.
type Env struct {
	ConfigDir string // CLAUDE_CONFIG_DIR; transcripts under ConfigDir/projects
	PidDir    string // FAKE_CLAUDE_PIDDIR: <session>.<pid> files, VIOLATION, NESTED
	ArgvLog   string // FAKE_CLAUDE_ARGV_LOG: one JSON argv array per launch
	SignalLog string // FAKE_CLAUDE_SIGNAL_LOG
	RulesFile string // FAKE_CLAUDE_RULES
	// Extra holds further KEY=VALUE pairs (FAKE_CLAUDE_STUBBORN=1, …).
	Extra []string
}

// NewEnv creates the directories under t.TempDir().
func NewEnv(t testing.TB) *Env {
	t.Helper()
	root := t.TempDir()
	e := &Env{
		ConfigDir: filepath.Join(root, "claude-config"),
		PidDir:    filepath.Join(root, "pids"),
		ArgvLog:   filepath.Join(root, "argv.log"),
		SignalLog: filepath.Join(root, "signal.log"),
		RulesFile: filepath.Join(root, "rules"),
	}
	for _, d := range []string{e.ConfigDir, e.PidDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return e
}

// Vars returns the KEY=VALUE pairs for this environment.
func (e *Env) Vars() []string {
	return append([]string{
		"CLAUDE_CONFIG_DIR=" + e.ConfigDir,
		"FAKE_CLAUDE_PIDDIR=" + e.PidDir,
		"FAKE_CLAUDE_ARGV_LOG=" + e.ArgvLog,
		"FAKE_CLAUDE_SIGNAL_LOG=" + e.SignalLog,
		"FAKE_CLAUDE_RULES=" + e.RulesFile,
	}, e.Extra...)
}

// Environ is the current process environment without the nested-claude
// guards, plus Vars.
func (e *Env) Environ() []string {
	var env []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "CLAUDECODE=") || strings.HasPrefix(kv, "CLAUDE_CODE_ENTRYPOINT=") ||
			strings.HasPrefix(kv, "CLAUDE_CONFIG_DIR=") || strings.HasPrefix(kv, "FAKE_CLAUDE_") {
			continue
		}
		env = append(env, kv)
	}
	return append(env, e.Vars()...)
}

// Violation returns the content of the fake's VIOLATION marker ("" if none):
// two live fake claude processes held the same claude session id.
func (e *Env) Violation() string {
	data, err := os.ReadFile(filepath.Join(e.PidDir, "VIOLATION"))
	if err != nil {
		return ""
	}
	return string(data)
}

// LivePids lists pid files currently present for claude session u.
func (e *Env) LivePids(u string) []string {
	matches, _ := filepath.Glob(filepath.Join(e.PidDir, u+".*"))
	return matches
}

// TrustDir marks dir as trusted in configDir/.claude.json, the file claude
// keeps its workspace-trust answers in (projects[<dir>].hasTrustDialogAccepted).
// Other entries already in the file are kept.
func TrustDir(t testing.TB, configDir, dir string) {
	t.Helper()
	path := filepath.Join(configDir, ".claude.json")
	doc := map[string]any{}
	if data, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(data, &doc); err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
	}
	projects, _ := doc["projects"].(map[string]any)
	if projects == nil {
		projects = map[string]any{}
	}
	canon := dir
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		canon = resolved
	}
	projects[canon] = map[string]any{"hasTrustDialogAccepted": true}
	doc["projects"] = projects
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

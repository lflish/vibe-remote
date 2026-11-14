package chat

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat/chattest"
)

// c3: chat sessions only start in directories claude itself trusts, judged by
// the directory's own hasTrustDialogAccepted (parents do not count).
func TestWorkdirTrusted(t *testing.T) {
	cfg := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", cfg)
	base := t.TempDir()
	mk := func(name string) string {
		d := filepath.Join(base, name)
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		d, _ = filepath.EvalSymlinks(d)
		return d
	}
	trusted, refused, parent, none := mk("trusted"), mk("refused"), mk("parent"), mk("none")
	child := mk("parent/child")

	// No file at all: unknown.
	if got := WorkdirTrusted(trusted); got != TrustUnknown {
		t.Fatalf("missing file: %q, want unknown", got)
	}

	write := func(body string) {
		if err := os.WriteFile(filepath.Join(cfg, ".claude.json"), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"oauthAccount":{"emailAddress":"x"},"projects":{` +
		`"` + trusted + `":{"hasTrustDialogAccepted":true,"allowedTools":[]},` +
		`"` + refused + `":{"hasTrustDialogAccepted":false},` +
		`"` + parent + `":{"hasTrustDialogAccepted":true}}}`)
	for dir, want := range map[string]TrustState{
		trusted: TrustTrusted,
		refused: TrustUntrusted,
		none:    TrustUntrusted,
		child:   TrustUntrusted, // only the parent is trusted
		parent:  TrustTrusted,
	} {
		if got := WorkdirTrusted(dir); got != want {
			t.Errorf("WorkdirTrusted(%s) = %q, want %q", filepath.Base(dir), got, want)
		}
	}
	// A non-canonical spelling of a trusted directory is the same directory.
	if got := WorkdirTrusted(trusted + "/./"); got != TrustTrusted {
		t.Errorf("non-canonical path = %q", got)
	}

	write(`{not json`)
	if got := WorkdirTrusted(trusted); got != TrustUnknown {
		t.Fatalf("corrupt file: %q, want unknown", got)
	}

	// Without CLAUDE_CONFIG_DIR the file is ~/.claude.json.
	home := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("HOME", home)
	if got := WorkdirTrusted(trusted); got != TrustUnknown {
		t.Fatalf("no ~/.claude.json: %q", got)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude.json"),
		[]byte(`{"projects":{"`+none+`":{"hasTrustDialogAccepted":true}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := WorkdirTrusted(none); got != TrustTrusted {
		t.Fatalf("~/.claude.json: %q, want trusted", got)
	}

	// The test helper writes the same format.
	cfg2 := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", cfg2)
	chattest.TrustDir(t, cfg2, child)
	if got := WorkdirTrusted(child); got != TrustTrusted {
		t.Fatalf("chattest.TrustDir: %q", got)
	}
}

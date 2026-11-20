package chat

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat/chattest"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

func TestParseVersion(t *testing.T) {
	for in, want := range map[string][3]int{
		"2.1.210 (Claude Code)":  {2, 1, 210},
		"2.1.210":                {2, 1, 210},
		"v10.0.3\n":              {10, 0, 3},
		"  1.0.51 (Claude Code)": {1, 0, 51},
	} {
		got, ok := ParseVersion(in)
		if !ok || got != want {
			t.Errorf("ParseVersion(%q) = %v, %v; want %v", in, got, ok, want)
		}
	}
	for _, in := range []string{"garbage", "", "2.1", "claude 2.1.x"} {
		if _, ok := ParseVersion(in); ok {
			t.Errorf("ParseVersion(%q) ok, want !ok", in)
		}
	}
	min, ok := ParseVersion(MinClaudeVersion)
	if !ok || min != [3]int{2, 1, 210} {
		t.Fatalf("MinClaudeVersion = %q", MinClaudeVersion)
	}
	older, _ := ParseVersion("2.1.209")
	newer, _ := ParseVersion("2.2.0")
	if VersionAtLeast(older, min) || !VersionAtLeast(min, min) || !VersionAtLeast(newer, min) {
		t.Fatal("VersionAtLeast ordering wrong")
	}
	if v, _ := ParseVersion("3.0.0"); !VersionAtLeast(v, min) {
		t.Fatal("major bump not newer")
	}
}

func TestProbeCachesAndRecheck(t *testing.T) {
	exe := filepath.Join(chattest.FakeClaude(t), "claude")
	ctx := context.Background()

	t.Setenv("FAKE_CLAUDE_VERSION", "2.1.210")
	p := NewProber(ProbeConfig{Exe: exe})
	got, known := p.Get(ctx, 10*time.Second)
	if !known || got.Version != "2.1.210" || got.Reason != "" {
		t.Fatalf("first probe = %+v known=%v", got, known)
	}

	// The cached value survives a version change until Recheck.
	t.Setenv("FAKE_CLAUDE_VERSION", "1.0.51")
	if got, _ := p.Get(ctx, 10*time.Second); got.Version != "2.1.210" {
		t.Fatalf("cache not used: %+v", got)
	}
	p.Recheck()
	got, known = p.Get(ctx, 10*time.Second)
	if !known || got.Version != "1.0.51" || got.Reason != protocol.ChatReasonTooOld {
		t.Fatalf("after recheck = %+v known=%v", got, known)
	}

	// Expired cache re-probes on its own.
	t.Setenv("FAKE_CLAUDE_VERSION", "2.2.0")
	p.ttl = time.Nanosecond
	time.Sleep(time.Millisecond)
	if got, _ := p.Get(ctx, 10*time.Second); got.Version != "2.2.0" || got.Reason != "" {
		t.Fatalf("expired cache = %+v", got)
	}

	// Through a login shell, as the daemon does with login_shell: true.
	t.Setenv("FAKE_CLAUDE_VERSION", "2.1.300")
	ls := NewProber(ProbeConfig{Exe: exe, LoginShell: true, Shell: "/bin/sh"})
	if got, known := ls.Get(ctx, 10*time.Second); !known || got.Version != "2.1.300" {
		t.Fatalf("login shell probe = %+v known=%v", got, known)
	}

	missing := filepath.Join(t.TempDir(), "claude")
	for _, cfg := range []ProbeConfig{{Exe: missing}, {Exe: missing, LoginShell: true, Shell: "/bin/sh"}} {
		got, known := NewProber(cfg).Get(ctx, 10*time.Second)
		if !known || got.Reason != protocol.ChatReasonClaudeNotFound {
			t.Fatalf("%+v: probe = %+v known=%v, want claude_not_found", cfg, got, known)
		}
	}

	// A version it cannot parse is "unknown", not an error: system/init decides later.
	script := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho not a version\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got, known := NewProber(ProbeConfig{Exe: script}).Get(ctx, 10*time.Second); !known || got.Version != "" || got.Reason != "" {
		t.Fatalf("unparseable = %+v known=%v", got, known)
	}

	// Get with a short wait returns "not known yet" while a slow probe runs.
	slow := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(slow, []byte("#!/bin/sh\nsleep 1\necho 2.1.210\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	sp := NewProber(ProbeConfig{Exe: slow})
	if _, known := sp.Get(ctx, 10*time.Millisecond); known {
		t.Fatal("slow probe reported known immediately")
	}
	if got, known := sp.Get(ctx, 10*time.Second); !known || got.Version != "2.1.210" {
		t.Fatalf("slow probe = %+v known=%v", got, known)
	}
}

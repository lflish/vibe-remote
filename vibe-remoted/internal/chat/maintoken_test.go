package chat

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The daemon may get its main token from VIBE_REMOTED_TOKEN; the version
// probe and a chat process started with the daemon's own environment must
// not inherit it.
const envMainToken = "env-only-main-token-0123456789abcdef"

func TestMainTokenEnvNotInheritedByProbe(t *testing.T) {
	t.Setenv("VIBE_REMOTED_TOKEN", envMainToken)
	dump := filepath.Join(t.TempDir(), "env.txt")
	exe := filepath.Join(t.TempDir(), "claude")
	body := "#!/bin/sh\nprintf 'main=%s' \"$VIBE_REMOTED_TOKEN\" > '" + dump + "'\necho 2.1.210\n"
	if err := os.WriteFile(exe, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, login := range []bool{false, true} {
		if got := Probe(context.Background(), exe, login, "/bin/sh"); got.Version != "2.1.210" {
			t.Fatalf("login=%v probe = %+v", login, got)
		}
		data, err := os.ReadFile(dump)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "main=" {
			t.Fatalf("login=%v: probe saw %q", login, data)
		}
	}
}

// Defense in depth: even an environment handed in with the variable set
// (the daemon's own, inherited) is filtered before claude starts.
func TestMainTokenEnvFilteredFromChatProcess(t *testing.T) {
	dump := filepath.Join(t.TempDir(), "env.txt")
	h := newHarness(t, withPrelude("printf 'main=%s' \"$VIBE_REMOTED_TOKEN\" > '"+dump+"'"))
	h.spec.Env = append(h.spec.Env, "VIBE_REMOTED_TOKEN="+envMainToken)
	h.start()
	deadline := time.Now().Add(waitTimeout)
	for {
		data, err := os.ReadFile(dump)
		if err == nil && len(data) > 0 {
			if strings.Contains(string(data), envMainToken) {
				t.Fatalf("chat process saw %q", data)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("env dump not written: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

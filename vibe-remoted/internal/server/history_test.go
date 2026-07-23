package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/config"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/session"
)

func TestHandleHistory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	workdir := filepath.Join(home, "proj")
	os.MkdirAll(workdir, 0o755)

	// seed a jsonl in the encoded project dir
	enc := home + "/.claude/projects/" + encodeForTest(workdir)
	os.MkdirAll(enc, 0o755)
	os.WriteFile(filepath.Join(enc, "s.jsonl"), []byte(
		`{"type":"user","message":{"role":"user","content":"hi"}}`+"\n"+
			`{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}`+"\n"), 0o644)

	cfg := &config.Config{
		BindAddr: "127.0.0.1", Port: 0, Token: "tok",
		DefaultWorkdir: workdir, AllowedRoots: []string{home},
		UseTmux: false, ClaudeCmd: "true",
	}
	mgr := session.NewManager(false, "true", false, "/bin/sh")
	srv := New(cfg, mgr)
	ts := httptest.NewServer(withCORS(srv.mux))
	defer ts.Close()

	// authorized request
	req, _ := http.NewRequest("GET", ts.URL+"/api/v1/history?path="+workdir+"&limit=10", nil)
	req.Header.Set("Authorization", "Bearer tok")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("status = %d", res.StatusCode)
	}
	var body struct {
		Turns []session.HistoryTurn `json:"turns"`
	}
	json.NewDecoder(res.Body).Decode(&body)
	res.Body.Close()
	if len(body.Turns) != 2 || body.Turns[0].Text != "hi" || body.Turns[1].Text != "hello" {
		t.Fatalf("turns = %+v", body.Turns)
	}

	// disallowed workdir → 403
	req2, _ := http.NewRequest("GET", ts.URL+"/api/v1/history?path=/etc&limit=10", nil)
	req2.Header.Set("Authorization", "Bearer tok")
	res2, _ := http.DefaultClient.Do(req2)
	if res2.StatusCode != http.StatusForbidden {
		t.Fatalf("disallowed workdir status = %d, want 403", res2.StatusCode)
	}
	res2.Body.Close()

	// missing token → 401
	req3, _ := http.NewRequest("GET", ts.URL+"/api/v1/history?path="+workdir, nil)
	res3, _ := http.DefaultClient.Do(req3)
	if res3.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no-token status = %d, want 401", res3.StatusCode)
	}
	res3.Body.Close()
}

// encodeForTest mirrors session.encodeProjectDir (unexported); duplicated here
// only to seed the fixture path.
func encodeForTest(workdir string) string {
	out := make([]rune, 0, len(workdir))
	for _, r := range workdir {
		if r == '/' || r == '.' {
			out = append(out, '-')
		} else {
			out = append(out, r)
		}
	}
	return string(out)
}

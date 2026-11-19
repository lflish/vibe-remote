package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/config"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/session"
)

// What a protocol 3 desktop knows of a `sessions` entry (docs/protocol.md,
// version table rows 1–3). Anything else in a terminal entry would be a field
// that client was never told about.
var v3SessionKeys = map[string]bool{
	"id": true, "title": true, "workdir": true, "created": true,
	"mode": true, "sourceWorkdir": true, "sourceRepo": true, "worktreeRoot": true, "branch": true,
	"ui": true, "state": true, "activitySeq": true, "epoch": true, "endReason": true,
}

func jsonKeys(t *testing.T, raw []byte) []string {
	t.Helper()
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		t.Fatalf("not a JSON object: %s", raw)
	}
	keys := make([]string, 0, len(obj))
	for k := range obj {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// v3Client is a protocol 3 desktop as far as the wire goes: it writes the
// frames that client writes, as literal JSON, and reads raw frames back. None
// of the protocol 4 Go types are used to build what it sends.
type v3Client struct {
	t    *testing.T
	conn *websocket.Conn
	ctx  context.Context
}

func dialV3(t *testing.T, url, token string) *v3Client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	c := &v3Client{t: t, conn: conn, ctx: ctx}
	c.write(map[string]any{"type": "auth", "token": token})
	if raw, typ := c.read(); typ != "sessions" {
		t.Fatalf("after auth: expected the sessions list, got %s", raw)
	}
	return c
}

func (c *v3Client) write(frame map[string]any) {
	c.t.Helper()
	data, err := json.Marshal(frame)
	if err != nil {
		c.t.Fatal(err)
	}
	if err := c.conn.Write(c.ctx, websocket.MessageText, data); err != nil {
		c.t.Fatalf("write %s: %v", data, err)
	}
}

// read returns the next frame and its type, skipping the types in skip.
func (c *v3Client) read(skip ...string) ([]byte, string) {
	c.t.Helper()
	for {
		_, data, err := c.conn.Read(c.ctx)
		if err != nil {
			c.t.Fatalf("read frame: %v", err)
		}
		var f struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(data, &f); err != nil {
			c.t.Fatalf("frame is not JSON: %q", data)
		}
		skipped := false
		for _, s := range skip {
			skipped = skipped || f.Type == s
		}
		if !skipped {
			return data, f.Type
		}
	}
}

// waitOutput reads data frames until the PTY output contains want.
func (c *v3Client) waitOutput(want string) {
	c.t.Helper()
	var seen strings.Builder
	for !strings.Contains(seen.String(), want) {
		raw, typ := c.read("sessions", "pong", "notify")
		if typ != "data" {
			c.t.Fatalf("waiting for %q in the output: got %s", want, raw)
		}
		var f struct {
			Payload string `json:"payload"`
		}
		if err := json.Unmarshal(raw, &f); err != nil {
			c.t.Fatal(err)
		}
		chunk, err := base64.StdEncoding.DecodeString(f.Payload)
		if err != nil {
			c.t.Fatalf("data payload is not base64: %s", raw)
		}
		seen.Write(chunk)
	}
}

// R9.2: a protocol 3 desktop against this daemon. It creates a session in
// Worktree mode, uses it, reconnects to it, renames it and deletes it, with
// the frames and endpoints of protocol 3 only — everything succeeds, the
// branch is named the old way, and nothing it reads has a shape it does not
// know. Deleting leaves the worktree and its branch alone (R5.10).
func TestV3ClientFlowAgainstV4Daemon(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		if os.Getenv("VIBE_REMOTE_REQUIRE_TMUX") == "1" {
			t.Fatal("tmux is not installed but VIBE_REMOTE_REQUIRE_TMUX=1")
		}
		t.Skip("tmux is not installed")
	}
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo := filepath.Join(base, "repo")
	initRepoAt(t, repo)
	head := serverGitOut(t, repo, "rev-parse", "HEAD")

	// Renaming stores the name in a tmux user option, so this needs tmux.
	cfg := &config.Config{Token: "secret", AllowedRoots: []string{base}, DefaultWorkdir: repo}
	mgr := session.NewManager(true, "/bin/bash", false, "")
	s := New(cfg, mgr)
	ts := httptest.NewServer(s.mux)
	t.Cleanup(ts.Close)
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	rest := func(method, path, body string) *httptest.ResponseRecorder {
		return serve(s, method, path, body, "Bearer secret")
	}

	// The id a desktop generates: <ms>-<8 hex>.
	now := time.Now()
	id := fmt.Sprintf("%d-%08x", now.UnixMilli(), uint32(now.UnixNano()))
	t.Cleanup(func() { mgr.Delete(id) })
	wantRoot := filepath.Join(base, "repo-worktrees", id)
	wantBranch := "vibe/" + id

	// Create: Worktree mode, no ui, no worktreeName.
	c := dialV3(t, url, "secret")
	c.write(map[string]any{
		"type": "attach", "newSessionId": id, "cols": 80, "rows": 24,
		"workdir": repo, "flags": []string{}, "mode": "worktree",
	})
	raw, typ := c.read()
	if typ != "ready" {
		t.Fatalf("create: expected ready, got %s", raw)
	}
	golden, err := os.ReadFile(filepath.Join(goldenDir, "ready-worktree.json"))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := jsonKeys(t, raw), jsonKeys(t, golden); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("ready keys = %v, want the protocol 2 set %v", got, want)
	}
	var ready struct {
		SessionID     string `json:"sessionId"`
		Workdir       string `json:"workdir"`
		Mode          string `json:"mode"`
		SourceWorkdir string `json:"sourceWorkdir"`
		SourceRepo    string `json:"sourceRepo"`
		WorktreeRoot  string `json:"worktreeRoot"`
		Branch        string `json:"branch"`
	}
	if err := json.Unmarshal(raw, &ready); err != nil {
		t.Fatal(err)
	}
	if ready.SessionID != id || ready.Mode != "worktree" || ready.Branch != wantBranch ||
		ready.WorktreeRoot != wantRoot || ready.Workdir != wantRoot || ready.SourceRepo != repo || ready.SourceWorkdir != repo {
		t.Fatalf("ready = %s; want session %s on branch %s in %s", raw, id, wantBranch, wantRoot)
	}
	if got := serverGitOut(t, repo, "rev-parse", "refs/heads/"+wantBranch); got != head {
		t.Fatalf("branch %s at %q, want the source HEAD %q", wantBranch, got, head)
	}
	if !pathExists(wantRoot) {
		t.Fatalf("worktree directory %s was not created", wantRoot)
	}

	// The session works: input reaches the shell, output comes back, a resize is accepted.
	c.write(map[string]any{"type": "data", "payload": base64.StdEncoding.EncodeToString([]byte("echo V3_$((40+2))_FLOW\n"))})
	c.waitOutput("V3_42_FLOW")
	c.write(map[string]any{"type": "resize", "cols": 100, "rows": 30})
	c.write(map[string]any{"type": "ping"})
	if raw, typ := c.read("data", "sessions", "notify"); typ != "pong" {
		t.Fatalf("expected pong, got %s", raw)
	}
	c.conn.CloseNow()

	// The session list: every entry has only fields protocol 3 defines.
	listed := func() map[string]map[string]json.RawMessage {
		t.Helper()
		w := rest(http.MethodGet, "/api/v1/sessions", "")
		if w.Code != http.StatusOK {
			t.Fatalf("GET sessions = %d: %s", w.Code, w.Body.String())
		}
		// The same envelope as the `sessions` frame, as it has always been.
		if got := jsonKeys(t, w.Body.Bytes()); strings.Join(got, ",") != "list,type" {
			t.Fatalf("sessions response keys = %v, want [list type]", got)
		}
		var resp struct {
			List []map[string]json.RawMessage `json:"list"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		out := map[string]map[string]json.RawMessage{}
		for _, entry := range resp.List {
			for k := range entry {
				if !v3SessionKeys[k] {
					t.Fatalf("session entry %s has a field protocol 3 does not define: %q", entry["id"], k)
				}
			}
			var sid string
			if err := json.Unmarshal(entry["id"], &sid); err != nil {
				t.Fatal(err)
			}
			out[sid] = entry
		}
		return out
	}
	entry, ok := listed()[id]
	if !ok {
		t.Fatalf("session %s is not listed after the client disconnected", id)
	}
	if string(entry["branch"]) != fmt.Sprintf("%q", wantBranch) || string(entry["mode"]) != `"worktree"` {
		t.Fatalf("listed entry: branch %s, mode %s", entry["branch"], entry["mode"])
	}
	if ui, has := entry["ui"]; has {
		t.Fatalf("a terminal entry carries ui: %s", ui)
	}

	// Attach again, the way the desktop reopens a listed session.
	c2 := dialV3(t, url, "secret")
	c2.write(map[string]any{"type": "attach", "sessionId": id, "cols": 80, "rows": 24})
	raw, typ = c2.read("data")
	if typ != "ready" {
		t.Fatalf("resume: expected ready, got %s", raw)
	}
	if got, want := jsonKeys(t, raw), jsonKeys(t, golden); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("resume ready keys = %v, want %v", got, want)
	}
	c2.write(map[string]any{"type": "data", "payload": base64.StdEncoding.EncodeToString([]byte("echo V3_$((6*7))_AGAIN\n"))})
	c2.waitOutput("V3_42_AGAIN")
	c2.conn.CloseNow()

	// Rename: 204 without a body, then the list shows the new title.
	w := rest(http.MethodPost, "/api/v1/sessions/"+id+"/rename", `{"name":"登录修复"}`)
	if w.Code != http.StatusNoContent || w.Body.Len() != 0 {
		t.Fatalf("rename = %d %q, want 204 with an empty body", w.Code, w.Body.String())
	}
	if got := string(listed()[id]["title"]); got != `"登录修复"` {
		t.Fatalf("title after rename = %s", got)
	}

	// Delete: 204, the session is gone; the worktree and the branch stay.
	if err := os.WriteFile(filepath.Join(wantRoot, "notes.txt"), []byte("kept\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	w = rest(http.MethodDelete, "/api/v1/sessions/"+id, "")
	if w.Code != http.StatusNoContent || w.Body.Len() != 0 {
		t.Fatalf("delete = %d %q, want 204 with an empty body", w.Code, w.Body.String())
	}
	if _, still := listed()[id]; still {
		t.Fatal("the session is still listed after DELETE")
	}
	if !pathExists(filepath.Join(wantRoot, "notes.txt")) {
		t.Fatal("deleting the session removed the worktree directory")
	}
	if got := serverGitOut(t, repo, "rev-parse", "refs/heads/"+wantBranch); got != head {
		t.Fatalf("branch %s after delete: %q, want %q", wantBranch, got, head)
	}
	if out := serverGitOut(t, repo, "worktree", "list", "--porcelain"); !strings.Contains(out, "worktree "+wantRoot) {
		t.Fatalf("git no longer lists the worktree:\n%s", out)
	}

	// Attaching to it now is the fatal session_not_found a v3 client stops on.
	c3 := dialV3(t, url, "secret")
	c3.write(map[string]any{"type": "attach", "sessionId": id, "cols": 80, "rows": 24})
	raw, typ = c3.read()
	var gone struct {
		Code  string `json:"code"`
		Fatal bool   `json:"fatal"`
	}
	if err := json.Unmarshal(raw, &gone); err != nil {
		t.Fatal(err)
	}
	if typ != "error" || gone.Code != "session_not_found" || !gone.Fatal {
		t.Fatalf("attach after delete = %s, want a fatal session_not_found", raw)
	}
}

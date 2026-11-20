package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/config"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/session"
)

// goldenDir holds the protocol-v2 terminal frames captured before protocol v3
// existed. Terminal sessions must keep producing these bytes exactly (apart
// from the proto number) — the dual-mode change may only add fields that
// terminal frames omit.
const goldenDir = "testdata/v2-golden"

var (
	goldenCreatedRe = regexp.MustCompile(`"created":"[^"]*"`)
	goldenProtoRe   = regexp.MustCompile(`"proto":[0-9]+`)
)

// goldenNormalizer replaces values that differ between runs (temp paths,
// session ids, timestamps, the protocol number) with fixed placeholders.
type goldenNormalizer struct {
	pairs []string // old, new, old, new … applied in order
}

func (n *goldenNormalizer) add(old, placeholder string) {
	n.pairs = append(n.pairs, old, placeholder)
}

func (n *goldenNormalizer) apply(raw []byte) []byte {
	s := string(bytes.TrimSpace(raw))
	s = strings.NewReplacer(n.pairs...).Replace(s)
	s = goldenCreatedRe.ReplaceAllString(s, `"created":"<TS>"`)
	s = goldenProtoRe.ReplaceAllString(s, `"proto":"<PROTO>"`)
	return []byte(s)
}

// checkGolden compares got with testdata/v2-golden/<name>.json, or rewrites
// that file when VR_WRITE_GOLDEN=1.
func checkGolden(t *testing.T, name string, got []byte) {
	t.Helper()
	path := filepath.Join(goldenDir, name+".json")
	if os.Getenv("VR_WRITE_GOLDEN") == "1" {
		if err := os.MkdirAll(goldenDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(got, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden %s: %v (generate with VR_WRITE_GOLDEN=1)", path, err)
	}
	if !bytes.Equal(bytes.TrimSpace(want), got) {
		t.Errorf("%s changed\n got: %s\nwant: %s", name, got, bytes.TrimSpace(want))
	}
}

// readRawFrame returns the next frame's raw bytes and its type, skipping
// frame types listed in skip (PTY data, pongs).
func readRawFrame(t *testing.T, ctx context.Context, conn *websocket.Conn, skip ...string) ([]byte, string) {
	t.Helper()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read frame: %v", err)
		}
		var f protocol.Frame
		if err := json.Unmarshal(data, &f); err != nil {
			t.Fatalf("frame is not JSON: %q", data)
		}
		skipped := false
		for _, s := range skip {
			if f.Type == s {
				skipped = true
			}
		}
		if !skipped {
			return data, f.Type
		}
	}
}

// filterSessionsFrame keeps only list entries whose workdir lies under root
// (the tmux socket is shared with sessions from other tests), sorted by id.
// The envelope bytes are checked verbatim so a new top-level field would show.
func filterSessionsFrame(t *testing.T, raw []byte, root string) []byte {
	t.Helper()
	raw = bytes.TrimSpace(raw)
	const prefix = `{"type":"sessions","list":[`
	if !bytes.HasPrefix(raw, []byte(prefix)) || !bytes.HasSuffix(raw, []byte("]}")) {
		t.Fatalf("sessions envelope changed: %s", raw)
	}
	var frame struct {
		List []json.RawMessage `json:"list"`
	}
	if err := json.Unmarshal(raw, &frame); err != nil {
		t.Fatal(err)
	}
	type entry struct {
		id  string
		raw json.RawMessage
	}
	var ours []entry
	for _, item := range frame.List {
		var info struct {
			ID      string `json:"id"`
			Workdir string `json:"workdir"`
		}
		if err := json.Unmarshal(item, &info); err != nil {
			t.Fatal(err)
		}
		if strings.HasPrefix(info.Workdir, root+string(filepath.Separator)) {
			ours = append(ours, entry{info.ID, item})
		}
	}
	sort.Slice(ours, func(i, j int) bool { return ours[i].id < ours[j].id })
	parts := make([]string, len(ours))
	for i, e := range ours {
		parts[i] = string(e.raw)
	}
	return []byte(prefix + strings.Join(parts, ",") + "]}")
}

// TestTerminalFramesUnchangedV3 pins the bytes of every terminal-session frame
// a v2 client parses: ready (normal and worktree), sessions, exit and the
// session_not_found error. Only the proto value may differ from the v2 capture.
func TestTerminalFramesUnchangedV3(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		if os.Getenv("VIBE_REMOTE_REQUIRE_TMUX") == "1" {
			t.Fatal("tmux is not installed but VIBE_REMOTE_REQUIRE_TMUX=1")
		}
		t.Skip("tmux is not installed")
	}
	base := t.TempDir()
	canonBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		t.Fatal(err)
	}
	plain := filepath.Join(canonBase, "plain")
	if err := os.Mkdir(plain, 0o755); err != nil {
		t.Fatal(err)
	}
	repo := filepath.Join(canonBase, "repo")
	if err := os.Mkdir(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	serverGit(t, repo, "init")
	serverGit(t, repo, "config", "user.email", "test@example.com")
	serverGit(t, repo, "config", "user.name", "Test User")
	if err := os.WriteFile(filepath.Join(repo, "README"), []byte("initial\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	serverGit(t, repo, "add", "README")
	serverGit(t, repo, "commit", "-m", "initial")

	cfg := &config.Config{Token: "secret", AllowedRoots: []string{canonBase}, DefaultWorkdir: plain}
	mgr := session.NewManager(true, "/bin/bash", false, "")
	s := New(cfg, mgr)
	ts := httptest.NewServer(s.mux)
	t.Cleanup(ts.Close)
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"

	stamp := time.Now().UnixNano()
	idNormal := fmt.Sprintf("golden-%d-n", stamp)
	idWorktree := fmt.Sprintf("golden-%d-w", stamp)
	idMissing := fmt.Sprintf("golden-%d-x", stamp)
	t.Cleanup(func() {
		mgr.Delete(idNormal)
		mgr.Delete(idWorktree)
	})

	norm := &goldenNormalizer{}
	// Ids before paths: worktree paths and branches embed the session id.
	norm.add(idNormal, "<ID1>")
	norm.add(idWorktree, "<ID2>")
	norm.add(idMissing, "<ID3>")
	norm.add(canonBase, "<TMP>")
	norm.add(base, "<TMP>")

	// Normal session.
	conn1, ctx1 := authed(t, s, url)
	if err := wsjson.Write(ctx1, conn1, protocol.AttachFrame{
		Type: protocol.TypeAttach, NewSessionID: idNormal, Workdir: plain, Cols: 80, Rows: 24,
	}); err != nil {
		t.Fatal(err)
	}
	raw, typ := readRawFrame(t, ctx1, conn1)
	if typ != protocol.TypeReady {
		t.Fatalf("expected ready, got %s", raw)
	}
	checkGolden(t, "ready-normal", norm.apply(raw))
	if _, typ = readRawFrame(t, ctx1, conn1, protocol.TypeData); typ != protocol.TypeSessions {
		t.Fatalf("expected sessions after ready, got %s", typ)
	}

	// Worktree session; the sessions frame after its ready lists both.
	conn2, ctx2 := authed(t, s, url)
	if err := wsjson.Write(ctx2, conn2, protocol.AttachFrame{
		Type: protocol.TypeAttach, NewSessionID: idWorktree, Workdir: repo, Cols: 80, Rows: 24,
		Mode: protocol.SessionModeWorktree,
	}); err != nil {
		t.Fatal(err)
	}
	raw, typ = readRawFrame(t, ctx2, conn2)
	if typ != protocol.TypeReady {
		t.Fatalf("expected ready, got %s", raw)
	}
	checkGolden(t, "ready-worktree", norm.apply(raw))
	raw, typ = readRawFrame(t, ctx2, conn2, protocol.TypeData)
	if typ != protocol.TypeSessions {
		t.Fatalf("expected sessions after ready, got %s", raw)
	}
	checkGolden(t, "sessions", norm.apply(filterSessionsFrame(t, raw, canonBase)))

	// The shell exiting ends the session: exit frame.
	if err := wsjson.Write(ctx1, conn1, protocol.DataFrame{
		Type: protocol.TypeData, Payload: base64.StdEncoding.EncodeToString([]byte("exit 7\n")),
	}); err != nil {
		t.Fatal(err)
	}
	raw, typ = readRawFrame(t, ctx1, conn1, protocol.TypeData, protocol.TypeSessions)
	if typ != protocol.TypeExit {
		t.Fatalf("expected exit, got %s", raw)
	}
	checkGolden(t, "exit", norm.apply(raw))

	// Resuming a session that does not exist.
	conn3, ctx3 := authed(t, s, url)
	if err := wsjson.Write(ctx3, conn3, protocol.AttachFrame{
		Type: protocol.TypeAttach, SessionID: idMissing, Cols: 80, Rows: 24,
	}); err != nil {
		t.Fatal(err)
	}
	raw, typ = readRawFrame(t, ctx3, conn3)
	if typ != protocol.TypeError {
		t.Fatalf("expected error, got %s", raw)
	}
	checkGolden(t, "error-session-not-found", norm.apply(raw))
}

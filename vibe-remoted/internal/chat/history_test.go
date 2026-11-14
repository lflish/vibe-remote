package chat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

func writeLines(t *testing.T, path string, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestHistoryFiltersSidechainAndMeta(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "u.jsonl")
	writeLines(t, path,
		`{"type":"queue-operation","operation":"enqueue","content":"hi"}`,
		`{"type":"user","message":{"role":"user","content":"hi"},"uuid":"1"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]},"uuid":"2"}`,
		`{"type":"user","isSidechain":true,"message":{"role":"user","content":"side"},"uuid":"3"}`,
		`{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[]},"uuid":"4"}`,
		`{"type":"user","isMeta":true,"message":{"role":"user","content":"meta"},"uuid":"5"}`,
		`{"type":"summary","summary":"x","leafUuid":"2"}`,
		`{"type":"file-history-snapshot","messageId":"m","snapshot":{}}`,
		`not json at all`,
		`{"type":"attachment","attachment":{}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"ok"}]},"uuid":"6"}`,
	)
	var got []string
	n, err := StreamHistory(path, -1, 2, func(lines [][]byte) error {
		if len(lines) > 2 {
			t.Fatalf("batch of %d", len(lines))
		}
		for _, l := range lines {
			var m struct {
				UUID string `json:"uuid"`
			}
			_ = json.Unmarshal(l, &m)
			got = append(got, m.UUID)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if n != 3 || fmt.Sprint(got) != "[1 2 6]" {
		t.Fatalf("count %d uuids %v", n, got)
	}
	if c, err := CountHistory(path, -1); err != nil || c != 3 {
		t.Fatalf("CountHistory = %d, %v", c, err)
	}
	// A missing file is an empty history.
	if c, err := CountHistory(filepath.Join(t.TempDir(), "none.jsonl"), -1); err != nil || c != 0 {
		t.Fatalf("missing file: %d %v", c, err)
	}
}

// countingReader counts bytes read through it.
type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

func TestHistoryFullStream(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "big.jsonl")
	var lines []string
	for i := 0; i < 3000; i++ {
		typ := "user"
		if i%2 == 1 {
			typ = "assistant"
		}
		lines = append(lines, fmt.Sprintf(`{"type":%q,"message":{"role":%q,"content":"%04d %s"},"n":%d}`, typ, typ, i, strings.Repeat("p", 300), i))
	}
	writeLines(t, path, lines...)
	info, _ := os.Stat(path)

	// Streaming: the first batch is emitted long before the file is read.
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	cr := &countingReader{r: f}
	var batches []int
	var readAtFirst int64 = -1
	next := 0
	n, err := streamHistory(cr, 200, func(b [][]byte) error {
		if readAtFirst < 0 {
			readAtFirst = cr.n
		}
		batches = append(batches, len(b))
		for _, l := range b {
			var m struct {
				N int `json:"n"`
			}
			_ = json.Unmarshal(l, &m)
			if m.N != next {
				t.Fatalf("line %d out of order (want %d)", m.N, next)
			}
			next++
		}
		return nil
	})
	if err != nil || n != 3000 || next != 3000 {
		t.Fatalf("n=%d next=%d err=%v", n, next, err)
	}
	if len(batches) != 15 || batches[0] != 200 {
		t.Fatalf("batches %v", batches)
	}
	if readAtFirst > info.Size()/4 {
		t.Fatalf("read %d of %d bytes before the first batch: not streaming", readAtFirst, info.Size())
	}

	// Through a session's sync: historyCount 3000 and every frame, h:true.
	h := newHarness(t)
	u := h.u
	tpath := filepath.Join(h.env.ConfigDir, "projects", EncodeProjectDir(h.dir), u+".jsonl")
	writeLines(t, tpath, lines...)
	h.start()
	c := h.attach("", nil)
	fs := c.waitFor("sync end", func(fs []frame) bool { return lastState(fs) != nil })
	if fs[0].Sync.HistoryCount != 3000 {
		t.Fatalf("historyCount %d", fs[0].Sync.HistoryCount)
	}
	var hist int
	for _, fr := range fs {
		if fr.Type == protocol.TypeChat && fr.H {
			if fr.Seq != 0 {
				t.Fatalf("history frame seq %d", fr.Seq)
			}
			hist++
		}
	}
	if hist != 3000 {
		t.Fatalf("%d history frames", hist)
	}
}

func TestSyncHistoryBeforeCutoff(t *testing.T) {
	t.Parallel()
	h := newHarness(t).start()
	h.send("1", "echo first turn")
	h.waitSnap("idle", func(i Info) bool { return i.Status == protocol.ChatStatusIdle && i.Seq > 3 })
	var err error
	h.s.WithOp(func(ops OpHandle) { err = ops.RestartLocked() })
	if err != nil {
		t.Fatal(err)
	}
	h.send("2", "echo second turn")
	h.waitSnap("idle", func(i Info) bool { return i.Status == protocol.ChatStatusIdle && i.Seq > 3 })
	c := h.attach("", nil)
	fs := c.waitFor("sync end", func(fs []frame) bool { return lastState(fs) != nil })
	var hist, live []frame
	for _, f := range fs {
		if f.Type != protocol.TypeChat {
			continue
		}
		if f.H {
			if len(live) > 0 {
				t.Fatal("history after backlog")
			}
			hist = append(hist, f)
		} else {
			live = append(live, f)
		}
	}
	if fs[0].Sync.HistoryCount != len(hist) || len(hist) != 2 {
		t.Fatalf("historyCount %d, %d history frames", fs[0].Sync.HistoryCount, len(hist))
	}
	for _, f := range hist {
		if bytes.Contains(f.Raw, []byte("second turn")) {
			t.Fatalf("history overlaps the buffer: %s", f.Raw)
		}
	}
	if !bytes.Contains(hist[0].Raw, []byte("echo first turn")) || !bytes.Contains(hist[1].Raw, []byte("first turn")) {
		t.Fatalf("history %s", lastRaw(hist, 2))
	}
	if !strings.Contains(assistantText(live), "second turn") {
		t.Fatal("buffer lacks the new turn")
	}
	// An incremental resync sends no history.
	c2 := h.attach(h.s.Snapshot().Epoch, ptr(h.s.Snapshot().Seq))
	fs2 := c2.waitFor("sync end", func(fs []frame) bool { return lastState(fs) != nil })
	if fs2[0].Sync.Reset || fs2[0].Sync.HistoryCount != 0 {
		t.Fatalf("incremental sync %+v", fs2[0].Sync)
	}
}

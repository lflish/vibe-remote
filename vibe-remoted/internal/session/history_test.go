package session

import (
	"os"
	"path/filepath"
	"testing"
)

// writeFakeProject writes a jsonl file into a temp fake ~/.claude/projects dir
// and returns (homeDir, workdir) so ReadHistory can be pointed at it.
func writeFakeProject(t *testing.T, workdir string, lines []string) string {
	t.Helper()
	home := t.TempDir()
	// claude encodes the workdir path as the project dir name: / and . → -
	enc := encodeProjectDir(workdir)
	projDir := filepath.Join(home, ".claude", "projects", enc)
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}
	content := ""
	for _, l := range lines {
		content += l + "\n"
	}
	if err := os.WriteFile(filepath.Join(projDir, "sess.jsonl"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return home
}

func TestReadHistoryExtractsTurns(t *testing.T) {
	workdir := "/Users/x/proj"
	lines := []string{
		`{"type":"mode","mode":"normal"}`,
		`{"type":"user","message":{"role":"user","content":"你好"}}`,
		`{"type":"assistant","message":{"content":[{"type":"thinking","text":"..."},{"type":"text","text":"你好，有什么可以帮忙"}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ok"}]}}`,
		`{"type":"attachment","attachment":{}}`,
		`{"type":"user","message":{"role":"user","content":"第二问"}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"回答二"}]}}`,
	}
	home := writeFakeProject(t, workdir, lines)
	t.Setenv("HOME", home)

	turns, err := ReadHistory(workdir, 100)
	if err != nil {
		t.Fatalf("ReadHistory: %v", err)
	}
	// tool_result user line and non-conversation lines are dropped.
	want := []HistoryTurn{
		{Role: "user", Text: "你好"},
		{Role: "assistant", Text: "你好，有什么可以帮忙"},
		{Role: "user", Text: "第二问"},
		{Role: "assistant", Text: "回答二"},
	}
	if len(turns) != len(want) {
		t.Fatalf("got %d turns, want %d: %+v", len(turns), len(want), turns)
	}
	for i := range want {
		if turns[i] != want[i] {
			t.Fatalf("turn %d = %+v, want %+v", i, turns[i], want[i])
		}
	}
}

func TestReadHistoryLimit(t *testing.T) {
	workdir := "/Users/x/proj"
	lines := []string{
		`{"type":"user","message":{"role":"user","content":"a"}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"A"}]}}`,
		`{"type":"user","message":{"role":"user","content":"b"}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"B"}]}}`,
	}
	home := writeFakeProject(t, workdir, lines)
	t.Setenv("HOME", home)

	turns, err := ReadHistory(workdir, 2)
	if err != nil {
		t.Fatal(err)
	}
	// last 2 turns only, oldest-first
	if len(turns) != 2 || turns[0].Text != "b" || turns[1].Text != "B" {
		t.Fatalf("limit not applied: %+v", turns)
	}
}

func TestReadHistoryNoSession(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	turns, err := ReadHistory("/no/such/dir", 100)
	if err != nil {
		t.Fatalf("expected nil error for missing session, got %v", err)
	}
	if len(turns) != 0 {
		t.Fatalf("expected empty, got %+v", turns)
	}
}

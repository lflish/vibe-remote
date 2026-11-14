package chat

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeJSONL(t *testing.T, path string, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func setMtime(t *testing.T, path string, ago time.Duration) {
	t.Helper()
	when := time.Now().Add(-ago)
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatal(err)
	}
}

func TestFindTranscriptAndLatest(t *testing.T) {
	projects := filepath.Join(t.TempDir(), "projects")
	work := filepath.Join(t.TempDir(), "my.repo")
	if err := os.Mkdir(work, 0o755); err != nil {
		t.Fatal(err)
	}
	work, _ = filepath.EvalSymlinks(work)
	other := filepath.Join(t.TempDir(), "other")
	if err := os.Mkdir(other, 0o755); err != nil {
		t.Fatal(err)
	}
	other, _ = filepath.EvalSymlinks(other)

	// claude's directory name: the path with / and . replaced by -.
	enc := EncodeProjectDir(work)
	if strings.ContainsAny(enc, "/.") || !strings.HasSuffix(enc, "-my-repo") {
		t.Fatalf("EncodeProjectDir(%q) = %q", work, enc)
	}
	older := "aaaaaaaa-0000-4000-8000-000000000001"
	newer := "aaaaaaaa-0000-4000-8000-000000000002"
	elsewhere := "bbbbbbbb-0000-4000-8000-000000000003"
	writeJSONL(t, filepath.Join(projects, enc, older+".jsonl"), `{"type":"user","cwd":"`+work+`"}`)
	writeJSONL(t, filepath.Join(projects, enc, newer+".jsonl"), `{"type":"user","cwd":"`+work+`"}`)
	writeJSONL(t, filepath.Join(projects, EncodeProjectDir(other), elsewhere+".jsonl"), `{"type":"user","cwd":"`+other+`"}`)
	setMtime(t, filepath.Join(projects, enc, older+".jsonl"), time.Hour)
	setMtime(t, filepath.Join(projects, enc, newer+".jsonl"), time.Minute)
	setMtime(t, filepath.Join(projects, EncodeProjectDir(other), elsewhere+".jsonl"), time.Second)

	for _, u := range []string{older, newer, elsewhere} {
		path, ok := FindTranscript(projects, u)
		if !ok || filepath.Base(path) != u+".jsonl" {
			t.Errorf("FindTranscript(%s) = %q, %v", u, path, ok)
		}
	}
	if _, ok := FindTranscript(projects, "cccccccc-0000-4000-8000-000000000009"); ok {
		t.Error("found a transcript that does not exist")
	}
	for _, bad := range []string{"*", "../x", "", "a/b"} {
		if _, ok := FindTranscript(projects, bad); ok {
			t.Errorf("FindTranscript accepted %q", bad)
		}
	}

	if u, ok := LatestSessionForWorkdir(projects, work); !ok || u != newer {
		t.Fatalf("latest = %q, %v; want %q (newest mtime in the workdir's own dir)", u, ok, newer)
	}
	if _, ok := LatestSessionForWorkdir(projects, filepath.Join(t.TempDir(), "never-used")); ok {
		t.Fatal("found a session for a workdir with no transcripts")
	}

	// The directory name does not follow the encoding (characters whose
	// encoding was never measured): fall back to the transcripts' cwd.
	odd := filepath.Join(t.TempDir(), "weird dir+chars")
	if err := os.Mkdir(odd, 0o755); err != nil {
		t.Fatal(err)
	}
	odd, _ = filepath.EvalSymlinks(odd)
	oddU := "dddddddd-0000-4000-8000-000000000004"
	writeJSONL(t, filepath.Join(projects, "-some-other-encoding", oddU+".jsonl"),
		`{"type":"queue-operation","operation":"enqueue"}`,
		`{"type":"user","cwd":"`+odd+`","sessionId":"`+oddU+`"}`)
	if u, ok := LatestSessionForWorkdir(projects, odd); !ok || u != oddU {
		t.Fatalf("cwd fallback = %q, %v; want %q", u, ok, oddU)
	}
}

func TestProjectsDir(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", "/cfg")
	if got := ProjectsDir(); got != "/cfg/projects" {
		t.Fatalf("ProjectsDir = %q", got)
	}
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("HOME", "/home/u")
	if got := ProjectsDir(); got != "/home/u/.claude/projects" {
		t.Fatalf("ProjectsDir = %q", got)
	}
}

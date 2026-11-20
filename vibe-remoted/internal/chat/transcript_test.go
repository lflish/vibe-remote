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

// X4: claude names a project directory by replacing "/" and "." in the path
// with "-", so …/a-b, …/a.b and …/a/b share one directory. "The latest
// conversation of this workdir" (-c) must be one that was recorded in this
// workdir, not the newest file of the shared directory.
func TestLatestSessionChecksTranscriptCwd(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	projects := filepath.Join(root, "projects")
	a := filepath.Join(root, "a-b")
	b := filepath.Join(root, "a", "b")
	dotted := filepath.Join(root, "a.b")
	for _, d := range []string{a, b, dotted} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if EncodeProjectDir(a) != EncodeProjectDir(b) || EncodeProjectDir(a) != EncodeProjectDir(dotted) {
		t.Fatalf("fixture: %q, %q and %q should share a project dir", a, b, dotted)
	}
	shared := filepath.Join(projects, EncodeProjectDir(a))
	user := func(cwd string) string {
		return `{"type":"user","cwd":"` + cwd + `","message":{"role":"user","content":"hi"}}`
	}
	latest := func(workdir string) string {
		t.Helper()
		u, ok := LatestSessionForWorkdir(projects, workdir)
		if !ok {
			return ""
		}
		return u
	}

	// Only b has a conversation: a (and a.b) have nothing to continue.
	ub := "bbbbbbbb-0000-4000-8000-00000000000b"
	writeJSONL(t, filepath.Join(shared, ub+".jsonl"), user(b))
	setMtime(t, filepath.Join(shared, ub+".jsonl"), time.Minute)
	if got := latest(a); got != "" {
		t.Fatalf("workdir a-b with no conversation got %s — the conversation of a/b", got)
	}
	if got := latest(dotted); got != "" {
		t.Fatalf("workdir a.b with no conversation got %s", got)
	}
	if got := latest(b); got != ub {
		t.Fatalf("workdir a/b: latest %q, want its own %s", got, ub)
	}

	// a has an older one: each directory continues its own.
	ua := "aaaaaaaa-0000-4000-8000-00000000000a"
	writeJSONL(t, filepath.Join(shared, ua+".jsonl"), user(a))
	setMtime(t, filepath.Join(shared, ua+".jsonl"), time.Hour)
	if got := latest(a); got != ua {
		t.Fatalf("workdir a-b: latest %q, want %s (the newer file belongs to a/b)", got, ua)
	}
	if got := latest(b); got != ub {
		t.Fatalf("workdir a/b: latest %q, want %s", got, ub)
	}

	// A transcript that records no cwd is nobody's to continue, however new.
	un := "cccccccc-0000-4000-8000-00000000000c"
	writeJSONL(t, filepath.Join(shared, un+".jsonl"), `{"type":"summary","summary":"no cwd anywhere"}`, `{"type":"user","message":{"role":"user","content":"hi"}}`)
	setMtime(t, filepath.Join(shared, un+".jsonl"), time.Second)
	if got := latest(a); got != ua {
		t.Fatalf("workdir a-b: latest %q, want %s (the newest file has no cwd)", got, ua)
	}
	if got := latest(b); got != ub {
		t.Fatalf("workdir a/b: latest %q, want %s (the newest file has no cwd)", got, ub)
	}

	// The cwd is on a later line (claude's files can start with other
	// records), followed by a long tail that is not needed to decide.
	uq := "dddddddd-0000-4000-8000-00000000000d"
	lines := []string{`{"type":"queue-operation","operation":"enqueue"}`, user(a)}
	for i := 0; i < 2000; i++ {
		lines = append(lines, `{"type":"assistant","cwd":"`+b+`","message":{"role":"assistant","content":[{"type":"text","text":"`+strings.Repeat("x", 500)+`"}]}}`)
	}
	writeJSONL(t, filepath.Join(shared, uq+".jsonl"), lines...)
	if got := latest(a); got != uq {
		t.Fatalf("workdir a-b: latest %q, want the newest of its own %s", got, uq)
	}
	if got := latest(b); got != ub {
		t.Fatalf("workdir a/b: latest %q, want %s", got, ub)
	}
}

// lateCwdLines is a transcript whose first "cwd" is on line n: n-1 records
// without one (claude's files can open with many queue-operation records),
// each padded to about pad bytes, then a user record of cwd.
func lateCwdLines(n, pad int, cwd string) []string {
	lines := make([]string, 0, n)
	for i := 1; i < n; i++ {
		lines = append(lines, `{"type":"queue-operation","operation":"enqueue","metadata":"`+strings.Repeat("x", pad)+`"}`)
	}
	return append(lines, `{"type":"user","cwd":"`+cwd+`","message":{"role":"user","content":"hi"}}`)
}

// X9 (R1.5, H6): which directory a transcript belongs to is decided by its
// first "cwd", wherever in the file that is — a directory that has a
// conversation to continue must not get a new one because the record sits
// past some scan limit.
func TestLatestSessionReadsUntilFirstCwd(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	projects := filepath.Join(root, "projects")
	const u = "eeeeeeee-0000-4000-8000-00000000000e"
	cases := []struct {
		name  string
		lines func(cwd string) []string
		want  bool
	}{
		{"cwd on line 101", func(cwd string) []string { return lateCwdLines(101, 20, cwd) }, true},
		{"cwd on line 1001 of 2 MiB", func(cwd string) []string { return lateCwdLines(1001, 2000, cwd) }, true},
		{"cwd after a line over MaxLine", func(cwd string) []string {
			return []string{
				`{"type":"queue-operation","metadata":"` + strings.Repeat("x", MaxLine+1) + `"}`,
				`{"type":"user","cwd":"` + cwd + `","message":{"role":"user","content":"hi"}}`,
			}
		}, true},
		{"a cwd nested in an earlier record is not the transcript's", func(cwd string) []string {
			return []string{
				`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"cwd":"/somewhere/else"}}]}}`,
				`{"type":"user","cwd":"` + cwd + `","message":{"role":"user","content":"hi"}}`,
			}
		}, true},
		{"cwd key written with escapes", func(cwd string) []string {
			return []string{`{"type":"user","c\u0077d":"` + cwd + `","message":{"role":"user","content":"hi"}}`}
		}, true},
		{"no cwd in 3000 lines", func(string) []string {
			lines := lateCwdLines(3000, 20, "")
			return lines[:len(lines)-1]
		}, false},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			work := filepath.Join(root, "work"+string(rune('a'+i)))
			if err := os.Mkdir(work, 0o755); err != nil {
				t.Fatal(err)
			}
			writeJSONL(t, filepath.Join(projects, EncodeProjectDir(work), u+".jsonl"), c.lines(work)...)
			got, ok := LatestSessionForWorkdir(projects, work)
			if ok != c.want || (ok && got != u) {
				t.Fatalf("LatestSessionForWorkdir = %q, %v; want found=%v (%s)", got, ok, c.want, u)
			}
		})
	}
}

// X9: the recorded cwd and the requested directory are compared as the same
// directory, not as the same spelling — a transcript recorded under a
// symlinked path belongs to the directory the link points at, and the other
// way round.
func TestLatestSessionComparesCanonicalCwd(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	user := func(cwd string) string {
		return `{"type":"user","cwd":"` + cwd + `","message":{"role":"user","content":"hi"}}`
	}
	const u = "ffffffff-0000-4000-8000-00000000000f"
	// fixture returns a real directory, a symlink to it and an empty
	// projects directory, all of their own.
	fixture := func(t *testing.T) (projects, realDir, alias string) {
		t.Helper()
		base := filepath.Join(root, strings.NewReplacer(" ", "_", "/", "_").Replace(t.Name()))
		realDir, alias = filepath.Join(base, "real-dir"), filepath.Join(base, "alias-dir")
		if err := os.MkdirAll(realDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(realDir, alias); err != nil {
			t.Fatal(err)
		}
		return filepath.Join(base, "projects"), realDir, alias
	}
	want := func(t *testing.T, projects, workdir string) {
		t.Helper()
		if got, ok := LatestSessionForWorkdir(projects, workdir); !ok || got != u {
			t.Fatalf("LatestSessionForWorkdir(%s) = %q, %v; want %s", workdir, got, ok, u)
		}
	}

	t.Run("recorded under the alias, in the alias's project dir", func(t *testing.T) {
		projects, realDir, alias := fixture(t)
		writeJSONL(t, filepath.Join(projects, EncodeProjectDir(alias), u+".jsonl"), user(alias))
		want(t, projects, realDir)
		want(t, projects, alias)
	})
	t.Run("recorded under the alias, in the directory's own project dir", func(t *testing.T) {
		projects, realDir, alias := fixture(t)
		writeJSONL(t, filepath.Join(projects, EncodeProjectDir(realDir), u+".jsonl"), user(alias))
		want(t, projects, realDir)
		want(t, projects, alias)
	})
	t.Run("recorded under the real path, asked by the alias", func(t *testing.T) {
		projects, realDir, alias := fixture(t)
		writeJSONL(t, filepath.Join(projects, EncodeProjectDir(realDir), u+".jsonl"), user(realDir))
		want(t, projects, alias)
		want(t, projects, realDir)
	})
	t.Run("an unclean spelling of the same path", func(t *testing.T) {
		projects, realDir, _ := fixture(t)
		writeJSONL(t, filepath.Join(projects, EncodeProjectDir(realDir), u+".jsonl"), user(realDir+"/./"))
		want(t, projects, realDir)
	})
	t.Run("a link to another directory is not this one", func(t *testing.T) {
		projects, realDir, _ := fixture(t)
		other := filepath.Join(filepath.Dir(realDir), "other-dir")
		link := filepath.Join(filepath.Dir(realDir), "other-link")
		if err := os.Mkdir(other, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(other, link); err != nil {
			t.Fatal(err)
		}
		writeJSONL(t, filepath.Join(projects, EncodeProjectDir(realDir), u+".jsonl"), user(link))
		if got, ok := LatestSessionForWorkdir(projects, realDir); ok {
			t.Fatalf("took %s, recorded in %s", got, other)
		}
		want(t, projects, other)
	})
	t.Run("a recorded directory that no longer exists is compared as written", func(t *testing.T) {
		projects, realDir, _ := fixture(t)
		gone := filepath.Join(filepath.Dir(realDir), "gone")
		writeJSONL(t, filepath.Join(projects, EncodeProjectDir(realDir), u+".jsonl"), user(gone+"/"))
		if got, ok := LatestSessionForWorkdir(projects, realDir); ok {
			t.Fatalf("took %s, recorded in a directory that is gone", got)
		}
		want(t, projects, gone)
	})
}

package chat

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// ProjectsDir is where claude keeps per-project transcripts:
// $CLAUDE_CONFIG_DIR/projects, or ~/.claude/projects.
func ProjectsDir() string {
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, "projects")
	}
	return filepath.Join(ExpandHome("~"), ".claude", "projects")
}

// EncodeProjectDir is claude's directory name for a workdir: the absolute
// path with "/" and "." replaced by "-" (measured, probe V4). Different paths
// can share a name, and other special characters were not measured:
// LatestSessionForWorkdir decides by the transcripts' own cwd.
func EncodeProjectDir(workdir string) string {
	return strings.NewReplacer("/", "-", ".", "-").Replace(workdir)
}

// transcriptID restricts ids to what claude uses (UUIDs) so an id can never
// act as a glob pattern or path.
var transcriptID = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// FindTranscript locates <projectsDir>/*/<u>.jsonl without relying on the
// directory encoding.
func FindTranscript(projectsDir, u string) (string, bool) {
	if !transcriptID.MatchString(u) {
		return "", false
	}
	matches, err := filepath.Glob(filepath.Join(projectsDir, "*", u+".jsonl"))
	if err != nil || len(matches) == 0 {
		return "", false
	}
	return matches[0], true
}

type transcriptFile struct {
	path  string
	id    string
	mtime time.Time
}

func listTranscripts(dir string) []transcriptFile {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []transcriptFile
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		id := strings.TrimSuffix(name, ".jsonl")
		if !transcriptID.MatchString(id) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, transcriptFile{path: filepath.Join(dir, name), id: id, mtime: info.ModTime()})
	}
	return out
}

func newest(files []transcriptFile) []transcriptFile {
	sort.Slice(files, func(i, j int) bool { return files[i].mtime.After(files[j].mtime) })
	return files
}

// cwdFallbackScan bounds how many recent transcripts are opened when the
// workdir's own directory holds no conversation of it.
const cwdFallbackScan = 10

// LatestSessionForWorkdir returns the claude conversation of workdir that
// `-c` continues: the most recently modified transcript in the workdir's
// project directory that was recorded in this workdir. The directory name
// alone does not say so — "/" and "." both become "-", so …/a-b, …/a.b and
// …/a/b share one directory — so each candidate's own "cwd" is checked, and a
// transcript that records none is not taken. When the directory holds no
// conversation of workdir (or does not exist: characters whose encoding was
// never measured), the most recent transcripts across all projects are
// checked the same way.
func LatestSessionForWorkdir(projectsDir, workdir string) (string, bool) {
	if canon, err := filepath.EvalSymlinks(workdir); err == nil {
		workdir = canon
	}
	workdir = filepath.Clean(workdir)
	for _, f := range newest(listTranscripts(filepath.Join(projectsDir, EncodeProjectDir(workdir)))) {
		if transcriptCwd(f.path) == workdir {
			return f.id, true
		}
	}
	dirs, err := os.ReadDir(projectsDir)
	if err != nil {
		return "", false
	}
	var all []transcriptFile
	for _, d := range dirs {
		if d.IsDir() {
			all = append(all, listTranscripts(filepath.Join(projectsDir, d.Name()))...)
		}
	}
	all = newest(all)
	if len(all) > cwdFallbackScan {
		all = all[:cwdFallbackScan]
	}
	for _, f := range all {
		if transcriptCwd(f.path) == workdir {
			return f.id, true
		}
	}
	return "", false
}

// transcriptCwd returns the first "cwd" recorded in a transcript — the
// directory the conversation was started in. Only the head of the file is
// read (the first 100 lines at most), never the whole transcript.
func transcriptCwd(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), MaxLine)
	for i := 0; i < 100 && sc.Scan(); i++ {
		var line struct {
			Cwd string `json:"cwd"`
		}
		if json.Unmarshal(sc.Bytes(), &line) == nil && line.Cwd != "" {
			return filepath.Clean(line.Cwd)
		}
	}
	return ""
}

// MaxLine is the longest stream-json or transcript line handled (16 MiB).
const MaxLine = 16 << 20

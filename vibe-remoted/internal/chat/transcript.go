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
// path with "/" and "." replaced by "-" (measured, probe V4). Other special
// characters were not measured; LatestSessionForWorkdir falls back to the
// transcripts' own cwd for those.
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
// workdir's own directory is missing.
const cwdFallbackScan = 10

// LatestSessionForWorkdir returns the claude conversation `claude -c` would
// continue in workdir: the most recently modified transcript in the
// workdir's project directory. When that directory does not exist (or holds
// no transcript), the most recent transcripts across all projects are
// checked for a first "cwd" equal to workdir.
func LatestSessionForWorkdir(projectsDir, workdir string) (string, bool) {
	if canon, err := filepath.EvalSymlinks(workdir); err == nil {
		workdir = canon
	}
	workdir = filepath.Clean(workdir)
	if files := newest(listTranscripts(filepath.Join(projectsDir, EncodeProjectDir(workdir)))); len(files) > 0 {
		return files[0].id, true
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

// transcriptCwd returns the first "cwd" recorded in a transcript.
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

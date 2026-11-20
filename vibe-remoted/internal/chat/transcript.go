package chat

import (
	"bufio"
	"bytes"
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
// never measured, or a transcript filed under a symlinked path), the most
// recent transcripts across all projects are checked the same way.
func LatestSessionForWorkdir(projectsDir, workdir string) (string, bool) {
	workdir = canonicalDir(workdir)
	own := EncodeProjectDir(workdir)
	for _, f := range newest(listTranscripts(filepath.Join(projectsDir, own))) {
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
		if d.IsDir() && d.Name() != own { // own: every file was just checked
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

// canonicalDir is the form two spellings of one directory are compared in:
// symlinks resolved, or — when the path cannot be resolved (the directory is
// gone) — the cleaned path as written.
func canonicalDir(dir string) string {
	if canon, err := filepath.EvalSymlinks(dir); err == nil {
		return canon
	}
	return filepath.Clean(dir)
}

// transcriptCwd returns the directory a transcript was recorded in — its
// first "cwd", in canonical form — or "" when no record has one. The file is
// read line by line up to that record and no further: claude's files can open
// with any number of records that carry no cwd (queue operations, summaries),
// so there is no line limit, and the whole transcript is never held in
// memory. A line over MaxLine is skipped.
func transcriptCwd(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	br := bufio.NewReaderSize(f, 64<<10)
	for {
		line, tooLong, err := readLine(br)
		if !tooLong && mayHaveCwdKey(line) {
			var rec struct {
				Cwd string `json:"cwd"`
			}
			if json.Unmarshal(line, &rec) == nil && rec.Cwd != "" {
				return canonicalDir(rec.Cwd)
			}
		}
		if err != nil {
			return ""
		}
	}
}

// mayHaveCwdKey reports whether a JSON line can have a "cwd" key at all, so
// the many records without one are not parsed: the key is either spelled
// out, or written with \u escapes (which claude does not do, but is the same
// key).
func mayHaveCwdKey(line []byte) bool {
	return bytes.Contains(line, []byte(`"cwd"`)) || bytes.Contains(line, []byte(`\u`))
}

// MaxLine is the longest stream-json or transcript line handled (16 MiB).
const MaxLine = 16 << 20

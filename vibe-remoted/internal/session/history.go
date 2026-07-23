package session

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// HistoryTurn is one conversation turn extracted from a claude session jsonl.
type HistoryTurn struct {
	Role string `json:"role"` // "user" | "assistant"
	Text string `json:"text"`
}

// encodeProjectDir mirrors claude's project-dir naming: the absolute workdir
// path with every '/' and '.' replaced by '-'. e.g. /Users/x/proj →
// -Users-x-proj. This is how ~/.claude/projects/<dir>/ is named.
func encodeProjectDir(workdir string) string {
	r := strings.NewReplacer("/", "-", ".", "-")
	return r.Replace(workdir)
}

// jsonlLine is the minimal shape we read from each jsonl line. content is
// json.RawMessage because a user line's content is either a plain string (real
// prompt) or an array of parts (tool_result — skipped).
type jsonlLine struct {
	Type    string `json:"type"`
	Message struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

// contentPart is one element of an assistant message's content array.
type contentPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// ReadHistory reads the most recently modified jsonl in the workdir's claude
// project dir and returns the last `limit` conversation turns (user prompts +
// assistant text), oldest-first. Missing project/session → empty slice, nil err
// (a not-yet-started session is not an error). We parse claude's own official
// jsonl records, not TUI output — extraction is limited to conversation text.
func ReadHistory(workdir string, limit int) ([]HistoryTurn, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	projDir := filepath.Join(home, ".claude", "projects", encodeProjectDir(workdir))
	entries, err := os.ReadDir(projDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []HistoryTurn{}, nil
		}
		return nil, err
	}

	// Pick the most recently modified .jsonl (the active session).
	type jf struct {
		path string
		mod  int64
	}
	var files []jf
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, jf{filepath.Join(projDir, e.Name()), info.ModTime().UnixNano()})
	}
	if len(files) == 0 {
		return []HistoryTurn{}, nil
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod > files[j].mod })

	f, err := os.Open(files[0].path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var turns []HistoryTurn
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		var ln jsonlLine
		if err := json.Unmarshal(scanner.Bytes(), &ln); err != nil {
			continue // skip malformed / non-object lines
		}
		switch ln.Type {
		case "user":
			// content is a plain string only for real user prompts; an array
			// means tool_result feedback, which we skip.
			var s string
			if err := json.Unmarshal(ln.Message.Content, &s); err == nil && s != "" {
				turns = append(turns, HistoryTurn{Role: "user", Text: s})
			}
		case "assistant":
			var parts []contentPart
			if err := json.Unmarshal(ln.Message.Content, &parts); err != nil {
				continue
			}
			var b strings.Builder
			for _, p := range parts {
				if p.Type == "text" && p.Text != "" {
					b.WriteString(p.Text)
				}
			}
			if b.Len() > 0 {
				turns = append(turns, HistoryTurn{Role: "assistant", Text: b.String()})
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	if limit > 0 && len(turns) > limit {
		turns = turns[len(turns)-limit:]
	}
	return turns, nil
}

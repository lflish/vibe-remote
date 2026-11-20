package chat

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// TrustState is whether claude's own workspace-trust dialog was accepted for
// a directory.
type TrustState string

const (
	TrustTrusted   TrustState = "trusted"
	TrustUntrusted TrustState = "untrusted"
	TrustUnknown   TrustState = "unknown" // config file missing or unreadable
)

// trustFile is claude's global config: $CLAUDE_CONFIG_DIR/.claude.json, or
// ~/.claude.json.
func trustFile() string {
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, ".claude.json")
	}
	return filepath.Join(ExpandHome("~"), ".claude.json")
}

// WorkdirTrusted reports projects[<workdir>].hasTrustDialogAccepted from
// claude's config. claude -p does not ask about trust and runs a project's
// hooks regardless (probe V23), so the daemon only starts chat sessions where
// the user already accepted trust interactively. Only the directory itself
// counts, not its parents. No other field of the file is read or kept: it
// also holds account details.
func WorkdirTrusted(workdir string) TrustState {
	data, err := os.ReadFile(trustFile())
	if err != nil {
		return TrustUnknown
	}
	var cfg struct {
		Projects map[string]struct {
			HasTrustDialogAccepted bool `json:"hasTrustDialogAccepted"`
		} `json:"projects"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return TrustUnknown
	}
	clean := filepath.Clean(workdir)
	keys := []string{clean}
	if canon, err := filepath.EvalSymlinks(clean); err == nil && canon != clean {
		keys = []string{canon, clean}
	}
	for _, k := range keys {
		if p, ok := cfg.Projects[k]; ok {
			if p.HasTrustDialogAccepted {
				return TrustTrusted
			}
			return TrustUntrusted
		}
	}
	return TrustUntrusted
}

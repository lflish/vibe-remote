package server

import (
	"encoding/json"
	"testing"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/session"
)

func TestReadyFrameUsesRunnerMetadataAndSerializesFlat(t *testing.T) {
	runner := &session.Runner{
		ID:            "s1",
		Workdir:       "/repo-worktrees/s1/subdir",
		Mode:          string(protocol.SessionModeWorktree),
		SourceWorkdir: "/repo/subdir",
		SourceRepo:    "/repo",
		WorktreeRoot:  "/repo-worktrees/s1",
		Branch:        "vibe/s1",
	}

	encoded, err := json.Marshal(readyFrame(runner))
	if err != nil {
		t.Fatalf("marshal ready frame: %v", err)
	}

	var got map[string]any
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatalf("unmarshal ready frame: %v", err)
	}
	want := map[string]string{
		"type":          protocol.TypeReady,
		"sessionId":     runner.ID,
		"workdir":       runner.Workdir,
		"mode":          string(protocol.SessionModeWorktree),
		"sourceWorkdir": runner.SourceWorkdir,
		"sourceRepo":    runner.SourceRepo,
		"worktreeRoot":  runner.WorktreeRoot,
		"branch":        runner.Branch,
	}
	for key, value := range want {
		if got[key] != value {
			t.Errorf("ready[%q] = %#v, want %q (JSON: %s)", key, got[key], value, encoded)
		}
	}
	if _, nested := got["SessionMetadata"]; nested {
		t.Fatalf("metadata serialized nested instead of flat: %s", encoded)
	}
}

func TestReadyFrameNormalizesEmptyRunnerMode(t *testing.T) {
	got := readyFrame(&session.Runner{ID: "s2", Workdir: "/repo"})
	if got.Mode != protocol.SessionModeNormal {
		t.Fatalf("mode = %q, want %q", got.Mode, protocol.SessionModeNormal)
	}
}

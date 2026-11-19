package session

import (
	"bytes"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProjectStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenProjectStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.AddProject("/r/devflow")
	s.AddProject("/r/devflow") // duplicate: no second entry
	s.AddWorktree("/r/devflow", "/r/devflow-worktrees/fix-login", "fix-login")

	info, err := os.Stat(filepath.Join(dir, "projects.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("file mode = %v, want 0600", info.Mode().Perm())
	}

	s2, err := OpenProjectStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := s2.Projects(); len(got) != 1 || got[0] != "/r/devflow" {
		t.Fatalf("projects = %v", got)
	}
	if !s2.Managed("/r/devflow", "/r/devflow-worktrees/fix-login", "fix-login") {
		t.Fatal("managed should be true after reopen")
	}
}

func TestProjectStoreRemove(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenProjectStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.AddProject("/r/a")
	s.AddWorktree("/r/a", "/r/a-worktrees/x", "x")
	if !s.RemoveProject("/r/a") {
		t.Fatal("RemoveProject existing should be true")
	}
	if s.RemoveProject("/r/a") {
		t.Fatal("RemoveProject missing should be false")
	}
	s.RemoveWorktree("/r/a-worktrees/x")
	if s.Managed("/r/a", "/r/a-worktrees/x", "x") {
		t.Fatal("managed should be false after RemoveWorktree")
	}
	// The removals persisted.
	s2, err := OpenProjectStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(s2.Projects()) != 0 || len(s2.Worktrees()) != 0 {
		t.Fatalf("reopened store not empty: %v %v", s2.Projects(), s2.Worktrees())
	}
}

func TestManagedRequiresPathAndBranch(t *testing.T) {
	s := NewMemoryProjectStore()
	s.AddWorktree("/r/devflow", "/r/devflow-worktrees/x", "fix-login")
	if s.Managed("/r/devflow", "/r/devflow-worktrees/x", "other") {
		t.Fatal("different branch should not be managed")
	}
	if s.Managed("/r/devflow", "/r/devflow-worktrees/x", "") {
		t.Fatal("empty branch (detached) should not be managed")
	}
	if s.Managed("/r/devflow", "/r/devflow-worktrees/y", "fix-login") {
		t.Fatal("different path should not be managed")
	}
	if !s.Managed("/r/devflow", "/r/devflow-worktrees/x", "fix-login") {
		t.Fatal("matching path and branch should be managed")
	}
}

func TestManagedLegacyVibeBranch(t *testing.T) {
	s := NewMemoryProjectStore()
	cases := []struct {
		path, branch string
		want         bool
	}{
		{"/r/devflow-worktrees/1794824025040-12b763ac", "vibe/1794824025040-12b763ac", true},
		{"/r/devflow-worktrees/1794824025040123456", "vibe/1794824025040123456", true},
		{"/r/devflow-worktrees/1794824025040-12b763ac", "vibe/other", false},
		{"/r/devflow-worktrees/foo", "vibe/foo", false},
		{"/r/devflow-worktrees/1794824025040-12B763AC", "vibe/1794824025040-12B763AC", false},
		{"/r/devflow-worktrees/abc123", "vibe/abc123", false},
		{"/r/devflow-trees/1794824025040-12b763ac", "vibe/1794824025040-12b763ac", false},
	}
	for _, c := range cases {
		if got := s.Managed("/r/devflow", c.path, c.branch); got != c.want {
			t.Errorf("Managed(%q,%q) = %v, want %v", c.path, c.branch, got, c.want)
		}
	}
}

func TestProjectStoreRemoveWorktreeIfSame(t *testing.T) {
	s := NewMemoryProjectStore()
	s.AddWorktree("/r/a", "/r/a-worktrees/x", "x")
	snap := s.Worktrees()
	if len(snap) != 1 {
		t.Fatalf("snapshot = %v", snap)
	}
	old := snap[0]

	// The record is replaced (new CreatedAt), so the stale record no longer matches.
	s.RemoveWorktree("/r/a-worktrees/x")
	s.AddWorktree("/r/a", "/r/a-worktrees/x", "x")
	if s.RemoveWorktreeIfSame(old) {
		t.Fatal("should not remove a replaced record")
	}
	if len(s.Worktrees()) != 1 {
		t.Fatal("replacement record was wrongly removed")
	}

	// An unchanged record is removed.
	cur := s.Worktrees()[0]
	if !s.RemoveWorktreeIfSame(cur) {
		t.Fatal("should remove an unchanged record")
	}
	if len(s.Worktrees()) != 0 {
		t.Fatal("record not removed")
	}
}

func TestProjectStoreWriteFailureLogsAndKeepsMemory(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenProjectStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	log.SetOutput(&logs)
	defer log.SetOutput(os.Stderr)

	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	s.AddProject("/r/a")
	s.AddWorktree("/r/a", "/r/a-worktrees/x", "x")
	if got := s.Projects(); len(got) != 1 || got[0] != "/r/a" {
		t.Fatalf("memory not updated: %v", got)
	}
	if !s.Managed("/r/a", "/r/a-worktrees/x", "x") {
		t.Fatal("memory worktree not updated")
	}
	if !strings.Contains(logs.String(), "projects store: write failed") {
		t.Fatalf("missing log line:\n%s", logs.String())
	}

	// Recover write access and record a second project; reopening sees all three.
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	s.AddProject("/r/b")
	s2, err := OpenProjectStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := s2.Projects(); len(got) != 2 {
		t.Fatalf("reopened projects = %v, want 2", got)
	}
	if !s2.Managed("/r/a", "/r/a-worktrees/x", "x") {
		t.Fatal("worktree not persisted after recovery")
	}
}

func TestProjectStoreCorruptFileRenamed(t *testing.T) {
	for _, content := range []string{"not json at all", `{"version":2,"projects":[]}`} {
		dir := t.TempDir()
		path := filepath.Join(dir, "projects.json")
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		s, err := OpenProjectStore(dir)
		if err != nil {
			t.Fatal(err)
		}
		if len(s.Projects()) != 0 {
			t.Fatalf("corrupt store should start empty, got %v", s.Projects())
		}
		entries, _ := os.ReadDir(dir)
		var quarantined bool
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), "projects.json.corrupt-") {
				quarantined = true
			}
		}
		if !quarantined {
			t.Fatalf("no quarantine file for %q: %v", content, entries)
		}
		s.AddProject("/r/a")
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("new projects.json not written: %v", err)
		}
	}
}

func TestOpenProjectStoreUnwritableDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "ro")
	if err := os.Mkdir(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenProjectStore(dir); err == nil {
		t.Fatal("expected error for a read-only directory")
	}
}

func TestMemoryProjectStore(t *testing.T) {
	s := NewMemoryProjectStore()
	s.AddProject("/r/a")
	s.AddWorktree("/r/a", "/r/a-worktrees/x", "x")
	if got := s.Projects(); len(got) != 1 {
		t.Fatalf("projects = %v", got)
	}
	if !s.Managed("/r/a", "/r/a-worktrees/x", "x") {
		t.Fatal("managed should be true")
	}
	s.RemoveProject("/r/a")
	s.RemoveWorktree("/r/a-worktrees/x")
	if len(s.Projects()) != 0 || len(s.Worktrees()) != 0 {
		t.Fatal("not cleared")
	}
	// No files were created anywhere we can observe: a memory store has no dir.
	if s.dir != "" {
		t.Fatalf("memory store has a dir: %q", s.dir)
	}
}

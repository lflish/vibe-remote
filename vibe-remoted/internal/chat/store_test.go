package chat

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sampleRecords() []Record {
	return []Record{
		{ID: "1763000000000-9f3a1c2e", Name: "mine", Workdir: "/home/u/p", Mode: "normal", Exe: "claude",
			Args: []string{"--dangerously-skip-permissions"}, Flags: []string{"skip-perms"},
			ClaudeSessionID: "0b6c0000-0000-4000-8000-000000000000", PermissionLocked: true,
			CreatedAt: "2026-11-13T10:00:00Z", Status: StatusRunning, Pid: 48211},
		{ID: "1763000000001-00000001", Workdir: "/home/u/q", Mode: "worktree", SourceWorkdir: "/home/u/q",
			SourceRepo: "/home/u/q", WorktreeRoot: "/home/u/q-worktrees/x", Branch: "vibe/x", Exe: "claude",
			ClaudeSessionID: "0b6c0000-0000-4000-8000-000000000001", Status: StatusEnded,
			EndReason: "handed_off", HandedOffTo: "1763000000002-00000002", WorktreeHandedOff: true},
	}
}

func TestStoreRoundTrip(t *testing.T) {
	t.Parallel()
	st, err := NewStore(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	if recs, err := st.Load(); err != nil || len(recs) != 0 {
		t.Fatalf("empty store: %v %v", recs, err)
	}
	want := sampleRecords()
	if err := st.Save(want); err != nil {
		t.Fatal(err)
	}
	got, err := st.Load()
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprintf("%+v", got) != fmt.Sprintf("%+v", want) {
		t.Fatalf("round trip\n got %+v\nwant %+v", got, want)
	}
	data, _ := os.ReadFile(st.Path())
	for _, key := range []string{`"version":1`, `"claudeSessionId"`, `"permissionLocked"`, `"worktreeHandedOff"`, `"handedOffTo"`, `"createdAt"`} {
		if !strings.Contains(string(data), key) {
			t.Fatalf("file lacks %s: %s", key, data)
		}
	}
}

func TestStorePermissions(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "state")
	st, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Save(sampleRecords()); err != nil {
		t.Fatal(err)
	}
	di, _ := os.Stat(dir)
	fi, _ := os.Stat(st.Path())
	if di.Mode().Perm() != 0o700 || fi.Mode().Perm() != 0o600 {
		t.Fatalf("dir %v file %v", di.Mode().Perm(), fi.Mode().Perm())
	}
	// An existing, too-open directory is tightened.
	loose := filepath.Join(t.TempDir(), "loose")
	if err := os.MkdirAll(loose, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := NewStore(loose); err != nil {
		t.Fatal(err)
	}
	if di, _ := os.Stat(loose); di.Mode().Perm() != 0o700 {
		t.Fatalf("loose dir %v", di.Mode().Perm())
	}
}

func TestStoreCorruptQuarantined(t *testing.T) {
	t.Parallel()
	st, err := NewStore(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(st.Path(), []byte(`{"version":1,"sessions":[{"id":`), 0o600); err != nil {
		t.Fatal(err)
	}
	recs, err := st.Load()
	if err != nil || len(recs) != 0 {
		t.Fatalf("corrupt load: %v %v", recs, err)
	}
	if _, err := os.Stat(st.Path()); !os.IsNotExist(err) {
		t.Fatal("corrupt file still in place")
	}
	moved, _ := filepath.Glob(st.Path() + ".corrupt-*")
	if len(moved) != 1 {
		t.Fatalf("quarantined files: %v", moved)
	}
	// The store works again afterwards.
	if err := st.Save(sampleRecords()); err != nil {
		t.Fatal(err)
	}
	if recs, _ := st.Load(); len(recs) != 2 {
		t.Fatalf("after quarantine: %d records", len(recs))
	}
}

func TestStoreAtomicWrite(t *testing.T) {
	t.Parallel()
	st, err := NewStore(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	old := sampleRecords()[:1]
	if err := st.Save(old); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(st.Path())
	// Crash after the temporary file is written, before the rename.
	st.beforeRename = func() error { return errors.New("crash") }
	if err := st.Save(sampleRecords()); err == nil {
		t.Fatal("save did not report the crash")
	}
	after, _ := os.ReadFile(st.Path())
	if string(after) != string(before) {
		t.Fatalf("old file damaged:\n%s", after)
	}
	if recs, err := st.Load(); err != nil || len(recs) != 1 {
		t.Fatalf("load after crash: %v %v", recs, err)
	}
	entries, _ := os.ReadDir(filepath.Dir(st.Path()))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".chat-sessions") {
			t.Fatalf("temporary file left behind: %s", e.Name())
		}
	}
}

package session

import (
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// The continue lookup (chat.LatestSessionForWorkdir) on the directories named
// worktrees get. Branch fix/login is checked out in …-worktrees/fix-login (the
// "/" becomes "-"), branch fix.login in …-worktrees/fix.login, and claude
// files the conversations of both under one project directory. A session
// started with -c in one of them — terminal or chat; its directory is the
// worktree — continues that worktree's conversation only. A session that
// creates a new worktree with -c runs in a directory that has no conversation
// yet: it starts a new one, whatever the directory it was created from has.
func TestContinueInWorktreesSharingProjectDir(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	f := newChatFixture(t, true)
	repo := tempRepo(t)
	if canon, err := filepath.EvalSymlinks(repo); err == nil {
		repo = canon
	}
	cont := f.exe + " -c"

	// The main directory has a conversation of its own.
	um := chat.NewUUID()
	f.transcript(repo, um, time.Now().Add(-time.Hour))

	// A new worktree, created with -c from the main directory.
	ta := newID("wt-new")
	ra, err := f.m.Create(CreateOptions{ID: ta, Workdir: repo, Mode: protocol.SessionModeWorktree, WorktreeName: "fix/login",
		Cols: 80, Rows: 24, ClaudeCmdOverride: cont})
	if err != nil {
		t.Fatal(err)
	}
	a := ra.CurrentWorkdir()
	if want := filepath.Join(filepath.Dir(repo), filepath.Base(repo)+"-worktrees", "fix-login"); a != want {
		f.m.Delete(ta)
		t.Fatalf("the session of the new worktree runs in %q, want %q", a, want)
	}
	argv := f.waitArgv(1)
	f.m.Delete(ta)
	if has(argv, "--resume", "") || !has(argv, "--session-id", "") || has(argv, "-c", "") {
		t.Fatalf("-c while creating a worktree: argv %v, want a new --session-id (the new directory has no conversation)", argv)
	}
	if o := f.owner(f.m, um); o != "" {
		t.Fatalf("the conversation of the main directory is claimed by %q", o)
	}

	// A second worktree whose directory claude files under the same name.
	b := filepath.Join(filepath.Dir(a), "fix.login")
	runGit(t, repo, "worktree", "add", "-q", "-b", "fix.login", b)
	if chat.EncodeProjectDir(a) != chat.EncodeProjectDir(b) {
		t.Fatal("fixture: the two worktree directories should share a project dir")
	}
	ub := chat.NewUUID()
	f.transcript(b, ub, time.Now().Add(-time.Minute))

	// -c in the existing worktree fix-login: not the conversation of fix.login.
	t2 := newID("wt-a-term")
	if _, err := f.createTerminal(f.m, t2, a, cont); err != nil {
		t.Fatal(err)
	}
	if argv := f.waitArgv(2); has(argv, "--resume", ub) || has(argv, "--resume", um) || has(argv, "-c", "") {
		t.Fatalf("terminal -c in %s: argv %v, must not resume the conversation of %s or of the main directory", a, argv, b)
	}
	f.m.Delete(t2)
	c2 := newID("wt-a-chat")
	if _, err := f.create(f.m, c2, a, "-c"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.m.Delete(c2) })
	if argv := f.waitArgv(3); has(argv, "--resume", ub) || has(argv, "--resume", um) {
		t.Fatalf("chat -c in %s: argv %v, must not resume the conversation of %s or of the main directory", a, argv, b)
	}
	if o := f.owner(f.m, ub); o != "" {
		t.Fatalf("the conversation of %s is claimed by %q", b, o)
	}

	// -c in fix.login continues its own conversation.
	t3 := newID("wt-b-term")
	if _, err := f.createTerminal(f.m, t3, b, cont); err != nil {
		t.Fatal(err)
	}
	if argv := f.waitArgv(4); !has(argv, "--resume", ub) {
		t.Fatalf("terminal -c in %s: argv %v, want --resume %s", b, argv, ub)
	}
	if o := f.owner(f.m, ub); o != t3 {
		t.Fatalf("the conversation of %s is owned by %q, want the session started there (%s)", b, o, t3)
	}
}

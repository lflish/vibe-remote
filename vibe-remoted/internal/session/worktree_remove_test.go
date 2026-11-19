package session

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/config"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// --- T13: worktree status and removal ---

// allowAny stands in for cfg.ResolveAllowedWorkdir with every root allowed: it
// resolves symlinks and returns the canonical path, as the real one does.
func allowAny(path string) (string, error) { return filepath.EvalSymlinks(path) }

// removeFixture is a repository named devflow (branch main, with a .gitignore)
// and a worktree fix-login that vibe-remote created, on a Manager without tmux.
type removeFixture struct {
	t     *testing.T
	m     *Manager
	store *ProjectStore
	repo  string   // the main directory
	root  string   // the fix-login worktree
	ids   []string // sessions in root, oldest first
}

func newRemoveFixture(t *testing.T, sessions int) *removeFixture {
	t.Helper()
	repo := devflowRepo(t)
	if err := os.WriteFile(filepath.Join(repo, ".gitignore"), []byte("node_modules/\n.env\nvendor/\n.devflow-tmp/\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", ".gitignore")
	runGit(t, repo, "commit", "-m", "ignore")
	f := &removeFixture{t: t, m: NewManager(false, "/bin/cat", false, ""), store: NewMemoryProjectStore(), repo: repo}
	f.m.SetProjectStore(f.store)
	first, err := f.m.Create(CreateOptions{Workdir: repo, Mode: protocol.SessionModeWorktree, WorktreeName: "fix-login", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { first.Kill() })
	f.root = first.WorktreeRoot
	if sessions == 0 {
		if err := f.m.Delete(first.ID); err != nil {
			t.Fatal(err)
		}
		return f
	}
	f.ids = []string{first.ID}
	for len(f.ids) < sessions {
		f.ids = append(f.ids, f.addSession(f.root))
	}
	return f
}

// addSession starts one more session in dir and returns its id.
func (f *removeFixture) addSession(dir string) string {
	f.t.Helper()
	r, err := f.m.Create(CreateOptions{Workdir: dir, Cols: 80, Rows: 24})
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() { r.Kill() })
	return r.ID
}

func (f *removeFixture) statusOf(path string) protocol.WorktreeStatus {
	f.t.Helper()
	st, err := f.m.WorktreeStatus(path, allowAny)
	if err != nil {
		f.t.Fatalf("WorktreeStatus(%s): %v", path, err)
	}
	return st
}

func (f *removeFixture) status() protocol.WorktreeStatus {
	f.t.Helper()
	return f.statusOf(f.root)
}

func (f *removeFixture) remove(req protocol.WorktreeRemoveRequest) (protocol.WorktreeRemoveResult, error) {
	return f.m.RemoveWorktree(req, allowAny)
}

func (f *removeFixture) mustRemove(req protocol.WorktreeRemoveRequest) protocol.WorktreeRemoveResult {
	f.t.Helper()
	res, err := f.remove(req)
	if err != nil {
		f.t.Fatalf("RemoveWorktree(%+v): %v", req, err)
	}
	if !res.Removed || res.EndedSessions == nil {
		f.t.Fatalf("result %+v, want removed with a non-nil endedSessions", res)
	}
	if pathExists(req.Path) {
		f.t.Fatalf("%s is still there after a successful removal", req.Path)
	}
	return res
}

func (f *removeFixture) alive(id string) bool {
	r, ok := f.m.Get(id)
	return ok && !r.bareProcessGone()
}

// intact fails unless the fix-login worktree, its branch and its record are
// all still there.
func (f *removeFixture) intact() {
	f.t.Helper()
	if !pathExists(f.root) || !worktreeListed(f.t, f.repo, f.root) {
		f.t.Fatalf("worktree %s is gone", f.root)
	}
	if branchOID(f.t, f.repo, "fix-login") == "" {
		f.t.Fatal("branch fix-login is gone")
	}
	if !f.store.Managed(f.repo, f.root, "fix-login") {
		f.t.Fatal("the creation record is gone")
	}
}

// request is what the desktop sends back for a status it showed, before any
// consent is added.
func request(st protocol.WorktreeStatus) protocol.WorktreeRemoveRequest {
	return protocol.WorktreeRemoveRequest{Path: st.Path, Head: st.Head, Sessions: st.Sessions}
}

func wantChanged(t *testing.T, err error) *WorktreeChangedError {
	t.Helper()
	var changed *WorktreeChangedError
	if !errors.As(err, &changed) {
		t.Fatalf("err = %T %v, want *WorktreeChangedError", err, err)
	}
	return changed
}

func wantRemoveError(t *testing.T, err error) *WorktreeRemoveError {
	t.Helper()
	var failed *WorktreeRemoveError
	if !errors.As(err, &failed) {
		t.Fatalf("err = %T %v, want *WorktreeRemoveError", err, err)
	}
	return failed
}

// installGitWrapper prepends a git to PATH that runs body (sh; "$@" are git's
// arguments, $REAL is the real git) and then, unless body exited, the real git.
func installGitWrapper(t *testing.T, body string) {
	t.Helper()
	real := realGit(t)
	dir := t.TempDir()
	writeFakeGit(t, dir, "#!/bin/sh\nREAL='"+real+"'\n"+body+"\nexec \"$REAL\" \"$@\"\n")
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func hasGitCall(calls [][]string, prefix ...string) bool {
	for _, c := range calls {
		if len(c) >= len(prefix) && reflect.DeepEqual(c[:len(prefix)], prefix) {
			return true
		}
	}
	return false
}

func writeFiles(t *testing.T, dir string, names ...string) {
	t.Helper()
	for _, name := range names {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(name+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func emptyCommits(t *testing.T, dir string, n int) string {
	t.Helper()
	for i := 0; i < n; i++ {
		runGit(t, dir, "-c", "user.email=test@example.com", "-c", "user.name=Test User", "commit", "--allow-empty", "-m", fmt.Sprintf("c%d", i+1))
	}
	return runGit(t, dir, "rev-parse", "HEAD")
}

func commitExists(dir, oid string) bool {
	return exec.Command("git", "-C", dir, "cat-file", "-e", oid+"^{commit}").Run() == nil
}

func TestDirtyFiles(t *testing.T) {
	f := newRemoveFixture(t, 0)
	count := func() int {
		t.Helper()
		n, err := DirtyFiles(f.root)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	t.Run("clean", func(t *testing.T) {
		if n := count(); n != 0 {
			t.Fatalf("DirtyFiles = %d, want 0", n)
		}
	})
	t.Run("ignored_only", func(t *testing.T) {
		writeFiles(t, f.root, "node_modules/a/1.js", "node_modules/a/b/2.js", ".env")
		if n := count(); n != 0 {
			t.Fatalf("DirtyFiles = %d, want 0 with only ignored files", n)
		}
	})
	// One modified, one staged, one untracked.
	if err := os.WriteFile(filepath.Join(f.root, "README"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	writeFiles(t, f.root, "staged.txt", "untracked.txt")
	runGit(t, f.root, "add", "staged.txt")
	if n := count(); n != 3 {
		t.Fatalf("DirtyFiles = %d, want 3", n)
	}
}

func TestDirtyFilesDoesNotRunFsmonitor(t *testing.T) {
	f := newRemoveFixture(t, 0)
	marker := filepath.Join(t.TempDir(), "ran")
	hook := filepath.Join(t.TempDir(), "fsmonitor.sh")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\ntouch '"+marker+"'\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, f.repo, "config", "core.fsmonitor", hook)
	_ = exec.Command("git", "-C", f.root, "status", "--porcelain").Run()
	if !pathExists(marker) {
		t.Skip("this git does not run a core.fsmonitor hook on status")
	}
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	writeFiles(t, f.root, "untracked.txt", "node_modules/x.js")
	if n, err := DirtyFiles(f.root); err != nil || n != 1 {
		t.Fatalf("DirtyFiles = %d, %v; want 1, nil", n, err)
	}
	if n, err := IgnoredFiles(f.root); err != nil || n != 1 {
		t.Fatalf("IgnoredFiles = %d, %v; want 1, nil", n, err)
	}
	if pathExists(marker) {
		t.Fatal("the repository's core.fsmonitor program was run")
	}
}

func TestIgnoredFiles(t *testing.T) {
	f := newRemoveFixture(t, 0)
	count := func() int {
		t.Helper()
		n, err := IgnoredFiles(f.root)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := count(); n != 0 {
		t.Fatalf("IgnoredFiles = %d, want 0 in a fresh worktree", n)
	}
	// Counted file by file: a directory is not folded into one entry.
	writeFiles(t, f.root, "node_modules/a/1.js", "node_modules/a/b/2.js", "node_modules/c/3.js", ".env")
	if n := count(); n != 4 {
		t.Fatalf("IgnoredFiles = %d, want 4", n)
	}
	// Another repository inside an ignored directory counts once.
	nested := filepath.Join(f.root, "vendor", "lib")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, nested, "init")
	writeFiles(t, nested, "lib.go", "more.go")
	runGit(t, nested, "add", "-A")
	emptyCommits(t, nested, 1)
	if n := count(); n != 5 {
		t.Fatalf("IgnoredFiles = %d, want 5 (the nested repository counts as one)", n)
	}
	// An untracked file that is not ignored is the other count's business.
	writeFiles(t, f.root, "notes.txt")
	if n := count(); n != 5 {
		t.Fatalf("IgnoredFiles = %d, want 5", n)
	}
	if n, err := DirtyFiles(f.root); err != nil || n != 1 {
		t.Fatalf("DirtyFiles = %d, %v; want 1, nil", n, err)
	}
}

func TestWorktreeStatus(t *testing.T) {
	f := newRemoveFixture(t, 2)
	st := f.status()
	want := protocol.WorktreeStatus{Path: f.root, Project: f.repo, Branch: "fix-login", Head: runGit(t, f.root, "rev-parse", "HEAD"),
		Managed: true, Sessions: f.ids}
	if !reflect.DeepEqual(st, want) {
		t.Fatalf("status\n got %+v\nwant %+v", st, want)
	}
	if len(st.Head) != 40 {
		t.Fatalf("head %q is not a full hash", st.Head)
	}

	if main := f.statusOf(f.repo); !main.Main || main.Managed || main.Branch != "main" || len(main.Sessions) != 0 {
		t.Fatalf("main directory status = %+v", main)
	}

	t.Run("counts", func(t *testing.T) {
		writeFiles(t, f.root, "node_modules/a/1.js", "node_modules/a/b/2.js", "node_modules/c/3.js", ".env", "untracked.txt")
		emptyCommits(t, f.root, 2)
		st := f.status()
		ignored, err := IgnoredFiles(f.root)
		if err != nil {
			t.Fatal(err)
		}
		if st.DirtyFiles != 1 || st.UnmergedCommits != 2 || st.IgnoredFiles != 4 || st.IgnoredFiles != ignored {
			t.Fatalf("status = %+v, want 1 dirty, 2 unmerged, 4 ignored", st)
		}
		if st.Head != runGit(t, f.root, "rev-parse", "HEAD") {
			t.Fatalf("head = %q after two commits", st.Head)
		}
	})

	t.Run("detached", func(t *testing.T) {
		det := filepath.Join(filepath.Dir(f.repo), "bisect")
		runGit(t, f.repo, "worktree", "add", "--detach", det, "HEAD")
		st := f.statusOf(det)
		if !st.Detached || st.Branch != "" || st.Managed || st.Main || len(st.Head) != 40 || st.Sessions == nil {
			t.Fatalf("detached status = %+v", st)
		}
	})

	t.Run("ended_chat_session", func(t *testing.T) {
		c := newChatFixture(t, false)
		c.m.SetProjectStore(NewMemoryProjectStore())
		repo := devflowRepo(t)
		id := newID("ended")
		a, err := c.m.CreateChat(ChatCreateOptions{ID: id, Workdir: repo, Mode: protocol.SessionModeWorktree,
			WorktreeName: "fix-login", Parsed: parsed(t, c.exe)})
		if err != nil {
			t.Fatal(err)
		}
		a.Session.WithOp(func(ops chat.OpHandle) { _ = ops.StopLocked(protocol.EndReasonStopped) })
		waitUntil(t, "chat session ended", func() bool { return a.Session.Snapshot().Status == protocol.ChatStatusEnded })
		root := filepath.Join(containerOf(repo), "fix-login")
		st, err := c.m.WorktreeStatus(root, allowAny)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(st.Sessions, []string{id}) {
			t.Fatalf("sessions = %v, want the ended chat session %s", st.Sessions, id)
		}
		req := request(st)
		req.DeleteBranch = true
		res, err := c.m.RemoveWorktree(req, allowAny)
		if err != nil || !reflect.DeepEqual(res.EndedSessions, []string{id}) {
			t.Fatalf("remove = %+v, %v", res, err)
		}
		if _, ok := c.m.ChatGet(id); ok || pathExists(root) {
			t.Fatal("the ended chat session or the directory is still there")
		}
	})

	// Counting ignored files can take long (it walks everything git ignores);
	// when it does, the status is still answered, without that number.
	t.Run("ignored_timeout", func(t *testing.T) {
		f := newRemoveFixture(t, 0)
		writeFiles(t, f.root, "node_modules/a/1.js")
		emptyCommits(t, f.root, 1)
		installGitWrapper(t, `case " $* " in *" --ignored "*) sleep 20;; esac`)
		old := gitTimeout
		gitTimeout = time.Second
		defer func() { gitTimeout = old }()
		st := f.status()
		if st.IgnoredFiles != -1 {
			t.Fatalf("ignoredFiles = %d, want -1 when it could not be counted", st.IgnoredFiles)
		}
		if st.DirtyFiles != 0 || st.UnmergedCommits != 1 || st.Head != runGit(t, f.root, "rev-parse", "HEAD") {
			t.Fatalf("the other fields suffered: %+v", st)
		}
		f.mustRemove(request(st))
	})
}

func TestRemoveCleanMergedWorktree(t *testing.T) {
	f := newRemoveFixture(t, 0)
	commitFile(t, f.root, "feature.txt")
	runGit(t, f.repo, "merge", "--ff-only", "fix-login")
	st := f.status()
	if st.DirtyFiles != 0 || st.UnmergedCommits != 0 || !st.Managed {
		t.Fatalf("status = %+v, want clean, merged and managed", st)
	}
	req := request(st)
	req.DeleteBranch = true
	res := f.mustRemove(req)
	if !res.BranchDeleted || res.BranchError != "" || len(res.EndedSessions) != 0 {
		t.Fatalf("result = %+v", res)
	}
	if branchOID(t, f.repo, "fix-login") != "" {
		t.Fatal("the branch is still there")
	}
	if worktreeListed(t, f.repo, f.root) {
		t.Fatal("git still lists the worktree")
	}
	if f.store.Managed(f.repo, f.root, "fix-login") || len(f.store.Worktrees()) != 0 {
		t.Fatalf("the creation record is still there: %v", f.store.Worktrees())
	}
	if _, err := os.Stat(filepath.Join(f.repo, "feature.txt")); err != nil {
		t.Fatalf("main lost the merged work: %v", err)
	}
}

func TestRemoveDirtyNeedsConsent(t *testing.T) {
	f := newRemoveFixture(t, 0)
	if err := os.WriteFile(filepath.Join(f.root, "README"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	writeFiles(t, f.root, "staged.txt", "untracked.txt")
	runGit(t, f.root, "add", "staged.txt")
	st := f.status()
	if st.DirtyFiles != 3 {
		t.Fatalf("dirtyFiles = %d, want 3", st.DirtyFiles)
	}
	req := request(st)
	req.DeleteBranch = true
	_, err := f.remove(req)
	changed := wantChanged(t, err)
	if changed.Status.DirtyFiles != 3 || len(changed.EndedSessions) != 0 {
		t.Fatalf("changed = %+v", changed)
	}
	f.intact()
	for _, name := range []string{"README", "staged.txt", "untracked.txt"} {
		if !pathExists(filepath.Join(f.root, name)) {
			t.Fatalf("%s was removed without consent", name)
		}
	}
	if data, _ := os.ReadFile(filepath.Join(f.root, "README")); string(data) != "changed\n" {
		t.Fatalf("README = %q", data)
	}

	req.DiscardFiles = true
	if res := f.mustRemove(req); !res.BranchDeleted {
		t.Fatalf("result = %+v", res)
	}
}

func TestRemoveIgnoredOnlyIsClean(t *testing.T) {
	f := newRemoveFixture(t, 0)
	writeFiles(t, f.root, "node_modules/a/1.js", "node_modules/a/b/2.js", "node_modules/c/3.js", ".env")
	st := f.status()
	if st.DirtyFiles != 0 || st.IgnoredFiles != 4 {
		t.Fatalf("status = %+v, want 0 dirty and 4 ignored", st)
	}
	// More ignored files after the dialog opened do not matter: the count is
	// only a note, never compared.
	writeFiles(t, f.root, "node_modules/d/4.js", "node_modules/d/5.js")
	req := request(st)
	req.DeleteBranch = true
	if res := f.mustRemove(req); !res.BranchDeleted {
		t.Fatalf("result = %+v", res)
	}
}

func TestRemoveUnmergedNeedsConsent(t *testing.T) {
	setup := func(t *testing.T) (*removeFixture, protocol.WorktreeStatus, string) {
		f := newRemoveFixture(t, 0)
		tip := emptyCommits(t, f.root, 2)
		st := f.status()
		if st.UnmergedCommits != 2 || st.DirtyFiles != 0 {
			t.Fatalf("status = %+v, want 2 unmerged commits", st)
		}
		return f, st, tip
	}
	t.Run("keep_branch", func(t *testing.T) {
		f, st, tip := setup(t)
		res := f.mustRemove(request(st))
		if res.BranchDeleted || res.BranchError != "" {
			t.Fatalf("result = %+v, want the branch kept", res)
		}
		if got := branchOID(t, f.repo, "fix-login"); got != tip {
			t.Fatalf("fix-login at %q, want %q", got, tip)
		}
		if got := runGit(t, f.repo, "rev-list", "--count", "refs/heads/main..refs/heads/fix-login"); got != "2" {
			t.Fatalf("commits on fix-login = %s, want 2", got)
		}
	})
	t.Run("delete_branch_without_drop", func(t *testing.T) {
		f, st, tip := setup(t)
		req := request(st)
		req.DeleteBranch = true
		_, err := f.remove(req)
		if changed := wantChanged(t, err); changed.Status.UnmergedCommits != 2 || len(changed.EndedSessions) != 0 {
			t.Fatalf("changed = %+v", changed)
		}
		f.intact()
		if got := branchOID(t, f.repo, "fix-login"); got != tip {
			t.Fatalf("fix-login moved to %q", got)
		}
	})
	t.Run("delete_branch_and_drop", func(t *testing.T) {
		f, st, tip := setup(t)
		req := request(st)
		req.DeleteBranch, req.DropCommits = true, true
		if res := f.mustRemove(req); !res.BranchDeleted {
			t.Fatalf("result = %+v", res)
		}
		if branchOID(t, f.repo, "fix-login") != "" {
			t.Fatal("the branch is still there")
		}
		_ = tip
	})
}

func TestRemoveEndsSessionsFirst(t *testing.T) {
	f := newRemoveFixture(t, 2)
	st := f.status()
	if !reflect.DeepEqual(st.Sessions, f.ids) {
		t.Fatalf("sessions = %v, want %v", st.Sessions, f.ids)
	}

	// The user was told about one session only.
	partial := request(st)
	partial.Sessions = f.ids[:1]
	partial.DeleteBranch = true
	_, err := f.remove(partial)
	changed := wantChanged(t, err)
	if !reflect.DeepEqual(changed.Status.Sessions, f.ids) || len(changed.EndedSessions) != 0 {
		t.Fatalf("changed = %+v, want both sessions listed and none ended", changed)
	}
	for _, id := range f.ids {
		if !f.alive(id) {
			t.Fatalf("session %s was ended by a refused removal", id)
		}
	}
	f.intact()

	req := request(st)
	req.DeleteBranch = true
	res := f.mustRemove(req)
	if !reflect.DeepEqual(res.EndedSessions, f.ids) {
		t.Fatalf("endedSessions = %v, want %v", res.EndedSessions, f.ids)
	}
	for _, id := range f.ids {
		if _, ok := f.m.Get(id); ok {
			t.Fatalf("session %s is still registered", id)
		}
	}
}

func TestRemoveMainRefused(t *testing.T) {
	f := newRemoveFixture(t, 0)
	head := runGit(t, f.repo, "rev-parse", "HEAD")
	_, err := f.remove(protocol.WorktreeRemoveRequest{Path: f.repo, Head: head, Sessions: []string{},
		DiscardFiles: true, DeleteBranch: true, DropCommits: true})
	if !errors.Is(err, ErrWorktreeIsMain) {
		t.Fatalf("err = %v, want ErrWorktreeIsMain", err)
	}
	if !pathExists(filepath.Join(f.repo, "README")) || branchOID(t, f.repo, "main") != head {
		t.Fatal("the main directory was touched")
	}
	f.intact()
}

func TestRemoveSingleRepoRefused(t *testing.T) {
	main := tempRepo(t)
	sub := tempRepo(t)
	runGit(t, main, "-c", "protocol.file.allow=always", "submodule", "add", sub, "sub")
	runGit(t, main, "commit", "-m", "add submodule")
	subWT := runGit(t, filepath.Join(main, "sub"), "rev-parse", "--show-toplevel")
	head := runGit(t, subWT, "rev-parse", "HEAD")
	m := NewManager(false, "/bin/cat", false, "")
	_, err := m.RemoveWorktree(protocol.WorktreeRemoveRequest{Path: subWT, Head: head, Sessions: []string{}, DiscardFiles: true}, allowAny)
	if !errors.Is(err, ErrWorktreeIsMain) {
		t.Fatalf("err = %v, want ErrWorktreeIsMain", err)
	}
	if !pathExists(filepath.Join(subWT, "README")) || !pathExists(filepath.Join(subWT, ".git")) {
		t.Fatal("the submodule's work tree was touched")
	}
	if _, err := m.WorktreeStatus(subWT, allowAny); !errors.Is(err, ErrWorktreeNotFound) {
		t.Fatalf("status err = %v, want ErrWorktreeNotFound", err)
	}
}

func TestRemoveExternalNeverDeletesBranch(t *testing.T) {
	f := newRemoveFixture(t, 0)
	ext := filepath.Join(f.repo, ".devflow-tmp", "worktrees", "general-skills")
	runGit(t, f.repo, "worktree", "add", "-b", "change/general-skills", ext, "HEAD")
	tip := emptyCommits(t, ext, 1)
	writeFiles(t, ext, "a.txt", "b.txt", "c.txt")
	st := f.statusOf(ext)
	if st.Managed || st.Branch != "change/general-skills" || st.DirtyFiles != 3 || st.UnmergedCommits != 1 {
		t.Fatalf("status = %+v, want an external worktree with 3 files and 1 commit", st)
	}
	req := request(st)
	req.DeleteBranch, req.DropCommits = true, true
	_, err := f.remove(req)
	if changed := wantChanged(t, err); changed.Status.DirtyFiles != 3 {
		t.Fatalf("changed = %+v, want the files to need consent", changed)
	}
	if !pathExists(filepath.Join(ext, "a.txt")) {
		t.Fatal("files were removed without consent")
	}
	req.DiscardFiles = true
	res := f.mustRemove(req)
	if res.BranchDeleted || res.BranchError != "" {
		t.Fatalf("result = %+v, want the branch untouched", res)
	}
	if got := branchOID(t, f.repo, "change/general-skills"); got != tip {
		t.Fatalf("change/general-skills at %q, want %q", got, tip)
	}
	f.intact()

	// A worktree vibe-remote created stops being its own once the user checks
	// out another branch in it.
	t.Run("switched_branch", func(t *testing.T) {
		f := newRemoveFixture(t, 0)
		runGit(t, f.root, "checkout", "-b", "other")
		otherTip := emptyCommits(t, f.root, 1)
		fixTip := branchOID(t, f.repo, "fix-login")
		st := f.status()
		if st.Managed || st.Branch != "other" {
			t.Fatalf("status = %+v, want unmanaged on other", st)
		}
		req := request(st)
		req.DeleteBranch, req.DropCommits = true, true
		res := f.mustRemove(req)
		if res.BranchDeleted {
			t.Fatalf("result = %+v", res)
		}
		if branchOID(t, f.repo, "other") != otherTip || branchOID(t, f.repo, "fix-login") != fixTip {
			t.Fatal("a branch was removed or moved")
		}
	})
}

func TestRemoveDetachedNeedsConsent(t *testing.T) {
	f := newRemoveFixture(t, 0)
	det := filepath.Join(filepath.Dir(f.repo), "bisect")
	runGit(t, f.repo, "worktree", "add", "--detach", det, "HEAD")
	tip := emptyCommits(t, det, 2)
	st := f.statusOf(det)
	if !st.Detached || st.UnmergedCommits != 2 {
		t.Fatalf("status = %+v, want detached with 2 commits of its own", st)
	}
	_, err := f.remove(request(st))
	if changed := wantChanged(t, err); changed.Status.UnmergedCommits != 2 || !changed.Status.Detached {
		t.Fatalf("changed = %+v", changed)
	}
	if !pathExists(det) || runGit(t, det, "rev-parse", "HEAD") != tip {
		t.Fatal("the detached worktree was touched")
	}
	req := request(st)
	req.DropCommits = true
	f.mustRemove(req)

	// Nothing of its own: no consent needed.
	clean := filepath.Join(filepath.Dir(f.repo), "clean")
	runGit(t, f.repo, "worktree", "add", "--detach", clean, "HEAD")
	st = f.statusOf(clean)
	if !st.Detached || st.UnmergedCommits != 0 || st.DirtyFiles != 0 {
		t.Fatalf("status = %+v", st)
	}
	f.mustRemove(request(st))
}

func TestRemoveGitFailureKeepsState(t *testing.T) {
	f := newRemoveFixture(t, 2)
	st := f.status()
	installGitWrapper(t, `case " $* " in *" worktree remove "*) echo 'fatal: simulated failure from the wrapper' >&2; exit 128;; esac`)
	req := request(st)
	req.DeleteBranch = true
	_, err := f.remove(req)
	failed := wantRemoveError(t, err)
	if !strings.Contains(failed.Message, "simulated failure from the wrapper") {
		t.Fatalf("message %q should carry git's output", failed.Message)
	}
	if !reflect.DeepEqual(failed.EndedSessions, f.ids) {
		t.Fatalf("endedSessions = %v, want %v", failed.EndedSessions, f.ids)
	}
	for _, id := range f.ids {
		if _, ok := f.m.Get(id); ok {
			t.Fatalf("session %s is still registered", id)
		}
	}
	f.intact()
}

func TestRemoveLockedRefusedBeforeEndingSessions(t *testing.T) {
	f := newRemoveFixture(t, 2)
	runGit(t, f.repo, "worktree", "lock", "--reason", "usb", f.root)
	st := f.status()
	for _, discard := range []bool{false, true} {
		req := request(st)
		req.DeleteBranch, req.DiscardFiles = true, discard
		_, err := f.remove(req)
		failed := wantRemoveError(t, err)
		if !strings.Contains(failed.Message, "locked") || !strings.Contains(failed.Message, "usb") {
			t.Fatalf("message %q should say it is locked and why", failed.Message)
		}
		if len(failed.EndedSessions) != 0 {
			t.Fatalf("endedSessions = %v, want none", failed.EndedSessions)
		}
		for _, id := range f.ids {
			if !f.alive(id) {
				t.Fatalf("session %s was ended", id)
			}
		}
		f.intact()
	}
	// Once unlocked it goes.
	runGit(t, f.repo, "worktree", "unlock", f.root)
	req := request(f.status())
	req.DeleteBranch = true
	f.mustRemove(req)
}

func TestRemoveChangedSinceStatus(t *testing.T) {
	t.Run("new_file", func(t *testing.T) {
		f := newRemoveFixture(t, 1)
		req := request(f.status())
		req.DeleteBranch = true
		writeFiles(t, f.root, "late.txt")
		_, err := f.remove(req)
		changed := wantChanged(t, err)
		if changed.Status.DirtyFiles != 1 || len(changed.EndedSessions) != 0 {
			t.Fatalf("changed = %+v, want 1 dirty file and nobody ended", changed)
		}
		if !pathExists(filepath.Join(f.root, "late.txt")) || !f.alive(f.ids[0]) {
			t.Fatal("the file or the session is gone")
		}
		f.intact()
	})
	t.Run("head_moved", func(t *testing.T) {
		f := newRemoveFixture(t, 1)
		req := request(f.status())
		req.DeleteBranch = true
		tip := emptyCommits(t, f.root, 1)
		_, err := f.remove(req)
		changed := wantChanged(t, err)
		if changed.Status.Head != tip || changed.Status.UnmergedCommits != 1 || len(changed.EndedSessions) != 0 {
			t.Fatalf("changed = %+v, want the new head %s", changed, tip)
		}
		if branchOID(t, f.repo, "fix-login") != tip || !f.alive(f.ids[0]) {
			t.Fatal("the branch moved or the session is gone")
		}
		f.intact()
	})
	// Only the head differs: keeping the branch needs no consent, so nothing
	// but the head comparison stands between this request and the sessions.
	t.Run("head_moved_keep_branch", func(t *testing.T) {
		f := newRemoveFixture(t, 1)
		req := request(f.status())
		tip := emptyCommits(t, f.root, 1)
		_, err := f.remove(req)
		changed := wantChanged(t, err)
		if changed.Status.Head != tip || len(changed.EndedSessions) != 0 {
			t.Fatalf("changed = %+v, want the new head %s and nobody ended", changed, tip)
		}
		if !f.alive(f.ids[0]) {
			t.Fatal("the session was ended before the head was compared")
		}
		f.intact()
	})
	t.Run("new_session", func(t *testing.T) {
		f := newRemoveFixture(t, 1)
		req := request(f.status())
		req.DeleteBranch = true
		late := f.addSession(f.root)
		_, err := f.remove(req)
		changed := wantChanged(t, err)
		if !reflect.DeepEqual(changed.Status.Sessions, []string{f.ids[0], late}) || len(changed.EndedSessions) != 0 {
			t.Fatalf("changed = %+v, want both sessions and nobody ended", changed)
		}
		if !f.alive(f.ids[0]) || !f.alive(late) {
			t.Fatal("a session was ended")
		}
		f.intact()
	})
	t.Run("missing_head", func(t *testing.T) {
		f := newRemoveFixture(t, 0)
		req := request(f.status())
		req.Head = ""
		_, err := f.remove(req)
		wantChanged(t, err)
		f.intact()
	})
}

// A file appears after the re-check and git refuses: that is "changed", found
// by looking again, not by reading git's message.
func TestRemoveGitRefusesNewFiles(t *testing.T) {
	f := newRemoveFixture(t, 0)
	req := request(f.status())
	req.DeleteBranch = true
	f.m.testBeforeWorktreeRemove = func() { writeFiles(t, f.root, "late.txt") }
	_, err := f.remove(req)
	changed := wantChanged(t, err)
	if changed.Status.DirtyFiles != 1 {
		t.Fatalf("changed = %+v, want 1 dirty file", changed)
	}
	if !pathExists(filepath.Join(f.root, "late.txt")) {
		t.Fatal("the late file was removed")
	}
	f.intact()
}

func TestRemoveClassifiesFailureWithoutMessage(t *testing.T) {
	const refusal = "致命错误：工作区包含已修改或未跟踪的文件，请使用 --force 删除"
	installGitWrapper(t, `case " $* " in *" worktree remove "*) echo '`+refusal+`' >&2; exit 128;; esac`)

	f := newRemoveFixture(t, 0)
	req := request(f.status())
	f.m.testBeforeWorktreeRemove = func() { writeFiles(t, f.root, "late.txt") }
	_, err := f.remove(req)
	if changed := wantChanged(t, err); changed.Status.DirtyFiles != 1 {
		t.Fatalf("changed = %+v, want 1 dirty file", changed)
	}
	f.intact()

	// Nothing changed and git still fails: a plain failure carrying its words.
	g := newRemoveFixture(t, 0)
	_, err = g.remove(request(g.status()))
	if failed := wantRemoveError(t, err); !strings.Contains(failed.Message, refusal) {
		t.Fatalf("message %q should carry git's output", failed.Message)
	}
	g.intact()
}

func TestRemoveSubmoduleCheckoutRefused(t *testing.T) {
	f := newRemoveFixture(t, 1)
	subSrc := tempRepo(t)
	runGit(t, f.root, "-c", "protocol.file.allow=always", "submodule", "add", subSrc, "sub")
	runGit(t, f.root, "commit", "-m", "add submodule")
	sub := filepath.Join(f.root, "sub")
	local := emptyCommits(t, sub, 1) // exists nowhere but in this checkout
	runGit(t, f.root, "add", "sub")
	runGit(t, f.root, "commit", "-m", "bump submodule")
	if has, err := HasSubmoduleCheckouts(f.root); err != nil || !has {
		t.Fatalf("HasSubmoduleCheckouts = %v, %v; want true", has, err)
	}
	st := f.status()
	if st.DirtyFiles != 0 {
		t.Fatalf("status = %+v, want a clean worktree", st)
	}
	for _, discard := range []bool{false, true} {
		req := request(st)
		req.DiscardFiles = discard
		_, err := f.remove(req)
		failed := wantRemoveError(t, err)
		if !strings.Contains(failed.Message, "submodule") || !strings.Contains(failed.Message, "git worktree remove --force") {
			t.Fatalf("message %q should name the reason and the manual command", failed.Message)
		}
		if len(failed.EndedSessions) != 0 || !f.alive(f.ids[0]) {
			t.Fatalf("a session was ended: %v", failed.EndedSessions)
		}
		f.intact()
		if !commitExists(sub, local) {
			t.Fatal("the submodule's local commit is gone")
		}
	}

	// A repository created inside the worktree and committed as a gitlink: no
	// modules/ directory, a clean status, and git would take it along.
	t.Run("embedded_repo", func(t *testing.T) {
		f := newRemoveFixture(t, 0)
		emb := filepath.Join(f.root, "sub")
		if err := os.Mkdir(emb, 0o755); err != nil {
			t.Fatal(err)
		}
		runGit(t, emb, "init")
		local := emptyCommits(t, emb, 1)
		runGit(t, f.root, "add", "sub")
		runGit(t, f.root, "commit", "-m", "embed a repository")
		gitDir := runGit(t, f.root, "rev-parse", "--absolute-git-dir")
		if pathExists(filepath.Join(gitDir, "modules")) {
			t.Fatal("setup: this is not the embedded-repository case")
		}
		if n, err := DirtyFiles(f.root); err != nil || n != 0 {
			t.Fatalf("DirtyFiles = %d, %v; want 0", n, err)
		}
		writeFiles(t, f.root, "untracked.txt")
		if has, err := HasSubmoduleCheckouts(f.root); err != nil || !has {
			t.Fatalf("HasSubmoduleCheckouts = %v, %v; want true", has, err)
		}
		st := f.status()
		for _, discard := range []bool{false, true} {
			req := request(st)
			req.DiscardFiles = discard
			_, err := f.remove(req)
			if failed := wantRemoveError(t, err); !strings.Contains(failed.Message, "submodule") {
				t.Fatalf("message %q", failed.Message)
			}
			f.intact()
			if !commitExists(emb, local) || !pathExists(filepath.Join(f.root, "untracked.txt")) {
				t.Fatal("the embedded repository or the untracked file is gone")
			}
		}
	})

	// A gitlink with nothing checked out in it holds no work: removable.
	t.Run("gitlink_only", func(t *testing.T) {
		f := newRemoveFixture(t, 0)
		oid := runGit(t, f.repo, "rev-parse", "HEAD")
		runGit(t, f.root, "update-index", "--add", "--cacheinfo", "160000,"+oid+",sub")
		runGit(t, f.root, "commit", "-m", "a gitlink")
		if err := os.Mkdir(filepath.Join(f.root, "sub"), 0o755); err != nil {
			t.Fatal(err)
		}
		if has, err := HasSubmoduleCheckouts(f.root); err != nil || has {
			t.Fatalf("HasSubmoduleCheckouts = %v, %v; want false", has, err)
		}
		st := f.status()
		if st.DirtyFiles != 0 {
			t.Fatalf("status = %+v, want clean", st)
		}
		f.mustRemove(request(st))
	})
}

func TestRemoveRefusedWhenNestedWorktree(t *testing.T) {
	f := newRemoveFixture(t, 0)
	inner := filepath.Join(f.root, ".devflow-tmp", "worktrees", "inner")
	runGit(t, f.repo, "worktree", "add", "-b", "inner", inner, "HEAD")
	writeFiles(t, inner, "untracked.txt")
	innerSession := f.addSession(inner)
	log := installArgLoggingGit(t)

	st := f.status()
	if st.DirtyFiles != 0 || st.UnmergedCommits != 0 {
		t.Fatalf("outer status = %+v: git sees nothing of the nested worktree", st)
	}
	// The session's directory is inside the outer worktree, so it is one of
	// those that would lose it (sessions are found by directory).
	if !reflect.DeepEqual(st.Sessions, []string{innerSession}) {
		t.Fatalf("outer status sessions = %v, want the nested worktree's session %s", st.Sessions, innerSession)
	}
	req := request(st)
	req.DeleteBranch = true
	_, err := f.remove(req)
	failed := wantRemoveError(t, err)
	if !strings.Contains(failed.Message, inner) || len(failed.EndedSessions) != 0 {
		t.Fatalf("failed = %+v, want the nested worktree %s named and nobody ended", failed, inner)
	}
	f.intact()
	if !pathExists(filepath.Join(inner, "untracked.txt")) || !worktreeListed(t, f.repo, inner) || branchOID(t, f.repo, "inner") == "" {
		t.Fatal("the nested worktree, its file or its branch is gone")
	}
	if !f.alive(innerSession) {
		t.Fatal("the nested worktree's session was ended")
	}
	if hasGitCall(loggedGitCalls(t, log), "worktree", "remove") {
		t.Fatal("git worktree remove was run")
	}

	// Inner first, then outer.
	ist := f.statusOf(inner)
	if !reflect.DeepEqual(ist.Sessions, []string{innerSession}) || ist.DirtyFiles != 1 {
		t.Fatalf("inner status = %+v", ist)
	}
	ireq := request(ist)
	ireq.DiscardFiles = true
	if res := f.mustRemove(ireq); !reflect.DeepEqual(res.EndedSessions, []string{innerSession}) {
		t.Fatalf("inner result = %+v", res)
	}
	req = request(f.status())
	req.DeleteBranch = true
	f.mustRemove(req)

	// A nested worktree whose directory is already gone is no obstacle.
	t.Run("prunable", func(t *testing.T) {
		f := newRemoveFixture(t, 0)
		inner := filepath.Join(f.root, ".devflow-tmp", "worktrees", "inner")
		runGit(t, f.repo, "worktree", "add", "-b", "inner", inner, "HEAD")
		if err := os.RemoveAll(inner); err != nil {
			t.Fatal(err)
		}
		req := request(f.status())
		req.DeleteBranch = true
		f.mustRemove(req)
	})
}

// The sessions being ended are the likeliest thing to commit in those seconds.
func TestRemoveHeadMovedWhileEndingSessions(t *testing.T) {
	t.Run("detached", func(t *testing.T) {
		f := newRemoveFixture(t, 0)
		det := filepath.Join(filepath.Dir(f.repo), "bisect")
		runGit(t, f.repo, "worktree", "add", "--detach", det, "HEAD")
		id := f.addSession(det)
		log := installArgLoggingGit(t)
		st := f.statusOf(det)
		if st.UnmergedCommits != 0 || !reflect.DeepEqual(st.Sessions, []string{id}) {
			t.Fatalf("status = %+v", st)
		}
		var tip string
		f.m.testAfterSessionsEnded = func() { tip = emptyCommits(t, det, 1) }
		_, err := f.remove(request(st))
		changed := wantChanged(t, err)
		if changed.Status.Head != tip || changed.Status.UnmergedCommits != 1 {
			t.Fatalf("changed status = %+v, want head %s with 1 commit of its own", changed.Status, tip)
		}
		if !reflect.DeepEqual(changed.EndedSessions, []string{id}) {
			t.Fatalf("endedSessions = %v, want [%s]", changed.EndedSessions, id)
		}
		if !pathExists(det) || !commitExists(f.repo, tip) || runGit(t, det, "rev-parse", "HEAD") != tip {
			t.Fatal("the directory or the new commit is gone")
		}
		if hasGitCall(loggedGitCalls(t, log), "worktree", "remove") {
			t.Fatal("git worktree remove was run")
		}
	})
	t.Run("on_a_branch", func(t *testing.T) {
		f := newRemoveFixture(t, 1)
		st := f.status()
		var tip string
		f.m.testAfterSessionsEnded = func() { tip = emptyCommits(t, f.root, 1) }
		req := request(st)
		req.DeleteBranch = true
		_, err := f.remove(req)
		changed := wantChanged(t, err)
		if changed.Status.Head != tip || !reflect.DeepEqual(changed.EndedSessions, f.ids) {
			t.Fatalf("changed = %+v, want head %s and the session ended", changed, tip)
		}
		if branchOID(t, f.repo, "fix-login") != tip {
			t.Fatal("the branch does not point at the new commit")
		}
		f.intact()
	})
}

func TestRemoveSessionAlreadyGoneContinues(t *testing.T) {
	f := newRemoveFixture(t, 2)
	st := f.status()
	f.m.testEndSession = func(id string) error {
		if id == f.ids[0] {
			return sessionNotFound(id) // it exited on its own just now
		}
		return f.m.Delete(id)
	}
	req := request(st)
	req.DeleteBranch = true
	res := f.mustRemove(req)
	if !reflect.DeepEqual(res.EndedSessions, f.ids) {
		t.Fatalf("endedSessions = %v, want %v", res.EndedSessions, f.ids)
	}
}

func TestRemoveSessionEndFailureStops(t *testing.T) {
	f := newRemoveFixture(t, 2)
	st := f.status()
	log := installArgLoggingGit(t)
	f.m.testEndSession = func(id string) error {
		if id == f.ids[1] {
			return errors.New("the process would not die")
		}
		return f.m.Delete(id)
	}
	req := request(st)
	req.DeleteBranch = true
	_, err := f.remove(req)
	failed := wantRemoveError(t, err)
	if !strings.Contains(failed.Message, f.ids[1]) {
		t.Fatalf("message %q should name session %s", failed.Message, f.ids[1])
	}
	if !reflect.DeepEqual(failed.EndedSessions, f.ids[:1]) {
		t.Fatalf("endedSessions = %v, want only %s", failed.EndedSessions, f.ids[0])
	}
	f.intact()
	if hasGitCall(loggedGitCalls(t, log), "worktree", "remove") {
		t.Fatal("git worktree remove was run")
	}
}

func TestWorktreeStatusSeesTmuxSessionsAfterRestart(t *testing.T) {
	requireTmux(t)
	repo := devflowRepo(t)
	store := NewMemoryProjectStore()
	m1 := NewManager(true, "sleep 30", false, "")
	m1.SetProjectStore(store)
	r, err := m1.Create(CreateOptions{Workdir: repo, Mode: protocol.SessionModeWorktree, WorktreeName: "fix-login", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	id, root := r.ID, r.WorktreeRoot
	t.Cleanup(func() { m1.Delete(id) })

	// A restarted daemon: nothing in its table yet, and nobody called List.
	m2 := NewManager(true, "sleep 30", false, "")
	m2.SetProjectStore(store)
	st, err := m2.WorktreeStatus(root, allowAny)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(st.Sessions, []string{id}) {
		t.Fatalf("sessions = %v, want the running terminal session %s", st.Sessions, id)
	}
	m3 := NewManager(true, "sleep 30", false, "")
	m3.SetProjectStore(store)
	req := request(st)
	req.DeleteBranch = true
	res, err := m3.RemoveWorktree(req, allowAny)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(res.EndedSessions, []string{id}) || !res.Removed {
		t.Fatalf("result = %+v, want session %s ended", res, id)
	}
	if tmuxCmd("has-session", "-t", "vibe-remote-"+id).Run() == nil {
		t.Fatal("the tmux session is still there")
	}
	if pathExists(root) {
		t.Fatal("the directory is still there")
	}
}

// git has already forgotten the worktree when deleting its directory fails
// half-way (V13): say so, with what is left.
func TestRemovePartialFailureReported(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("needs a non-writable directory")
	}
	f := newRemoveFixture(t, 1)
	locked := filepath.Join(f.root, "locked")
	writeFiles(t, f.root, "locked/file.txt")
	runGit(t, f.root, "add", "locked/file.txt")
	runGit(t, f.root, "commit", "-m", "a file git will not be able to delete")
	if err := os.Chmod(locked, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(locked, 0o755) })
	tip := branchOID(t, f.repo, "fix-login")

	_, err := f.remove(request(f.status()))
	failed := wantRemoveError(t, err)
	if !reflect.DeepEqual(failed.EndedSessions, f.ids) {
		t.Fatalf("endedSessions = %v, want %v", failed.EndedSessions, f.ids)
	}
	if worktreeListed(t, f.repo, f.root) {
		t.Skip("this git keeps the worktree registered when deleting fails")
	}
	if !strings.Contains(failed.Message, "failed to delete") {
		t.Fatalf("message %q should carry git's output", failed.Message)
	}
	if !strings.Contains(failed.Message, "left at "+f.root) {
		t.Fatalf("message %q should say part of the directory is left and where", failed.Message)
	}
	if !pathExists(filepath.Join(locked, "file.txt")) {
		t.Fatal("setup: the undeletable file is gone")
	}
	if branchOID(t, f.repo, "fix-login") != tip {
		t.Fatal("the branch was removed or moved")
	}
	// What is left is a directory whose .git points at nothing: asking about
	// it again says "no such worktree" (the desktop then explains what is
	// left), not "git failed".
	if _, err := f.m.WorktreeStatus(f.root, allowAny); !errors.Is(err, ErrWorktreeNotFound) {
		t.Fatalf("status of the leftover directory: %v, want ErrWorktreeNotFound", err)
	}
	if _, err := f.remove(protocol.WorktreeRemoveRequest{Path: f.root, Head: tip, Sessions: []string{}, DiscardFiles: true}); !errors.Is(err, ErrWorktreeNotFound) {
		t.Fatalf("removing the leftover directory: %v, want ErrWorktreeNotFound", err)
	}
	if !pathExists(filepath.Join(locked, "file.txt")) {
		t.Fatal("the leftover directory was touched")
	}
	if row := worktreeRow(f.m.Projects(nil), f.root); row != nil {
		t.Fatalf("the row is still listed: %+v", row)
	}
	if f.store.Managed(f.repo, f.root, "fix-login") {
		t.Fatal("the creation record outlived the worktree")
	}
}

// A directory that merely contains a broken .git is not mistaken for the
// leftover of a removed worktree: that stays a git failure.
func TestWorktreeStatusBrokenRepositoryIsAFailure(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	m := NewManager(false, "/bin/cat", false, "")
	_, err = m.WorktreeStatus(dir, allowAny)
	if err == nil || errors.Is(err, ErrWorktreeNotFound) {
		t.Fatalf("err = %v, want a git failure", err)
	}
}

func TestRemoveRefusedWhileSessionStarting(t *testing.T) {
	f := newRemoveFixture(t, 0)
	// stuck starts create in the background and returns once it is between
	// registering its workdir as starting and registering the session.
	stuck := func(opts CreateOptions, workdir string) (release func() *Runner) {
		entered, proceed, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
		var once sync.Once
		f.m.testAfterBeginStart = func(dir string) {
			if dir == workdir {
				once.Do(func() { close(entered); <-proceed })
			}
		}
		var r *Runner
		var err error
		go func() {
			defer close(done)
			r, err = f.m.Create(opts)
		}()
		select {
		case <-entered:
		case <-done:
			t.Fatalf("create finished before it could be held: %v", err)
		case <-time.After(15 * time.Second):
			t.Fatal("create never reached the hook")
		}
		return func() *Runner {
			close(proceed)
			<-done
			if err != nil {
				t.Fatalf("the held create failed: %v", err)
			}
			t.Cleanup(func() { r.Kill() })
			return r
		}
	}
	sessionsOf := func(path string) []string {
		row := worktreeRow(f.m.Projects(nil), path)
		if row == nil {
			t.Fatalf("no row for %s", path)
		}
		return row.Sessions
	}

	// A plain session starting in the worktree.
	st := f.status()
	release := stuck(CreateOptions{Workdir: f.root, Cols: 80, Rows: 24}, f.root)
	req := request(st)
	req.DeleteBranch = true
	_, err := f.remove(req)
	if changed := wantChanged(t, err); len(changed.EndedSessions) != 0 {
		t.Fatalf("changed = %+v, want nobody ended", changed)
	}
	f.intact()
	r := release()
	if got := sessionsOf(f.root); !reflect.DeepEqual(got, []string{r.ID}) {
		t.Fatalf("fix-login sessions = %v, want [%s]", got, r.ID)
	}

	// A worktree-mode create: its worktree exists, its session does not yet.
	other := filepath.Join(containerOf(f.repo), "other")
	release = stuck(CreateOptions{Workdir: f.repo, Mode: protocol.SessionModeWorktree, WorktreeName: "other", Cols: 80, Rows: 24}, other)
	ost := f.statusOf(other)
	if len(ost.Sessions) != 0 {
		t.Fatalf("status = %+v: the session is not registered yet", ost)
	}
	oreq := request(ost)
	oreq.DeleteBranch = true
	_, err = f.remove(oreq)
	wantChanged(t, err)
	if !pathExists(other) || branchOID(t, f.repo, "other") == "" {
		t.Fatal("the new worktree was removed from under its session")
	}
	r2 := release()
	if got := sessionsOf(other); !reflect.DeepEqual(got, []string{r2.ID}) {
		t.Fatalf("other sessions = %v, want [%s]", got, r2.ID)
	}
}

func TestCreateRefusedWhileWorktreeRemoving(t *testing.T) {
	c := newChatFixture(t, false)
	c.m.SetProjectStore(NewMemoryProjectStore())
	repo := devflowRepo(t)
	chatID := newID("busy")
	a, err := c.m.CreateChat(ChatCreateOptions{ID: chatID, Workdir: repo, Mode: protocol.SessionModeWorktree,
		WorktreeName: "fix-login", Parsed: parsed(t, c.exe)})
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(containerOf(repo), "fix-login")
	sub := filepath.Join(root, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "chat running", idle(a.Session))
	st, err := c.m.WorktreeStatus(root, allowAny)
	if err != nil {
		t.Fatal(err)
	}

	errs := map[string]error{}
	var chatStatus string
	var chatAlive bool
	c.m.testAfterRemovingMarked = func() {
		_, errs["terminal"] = c.m.Create(CreateOptions{Workdir: root, Cols: 80, Rows: 24})
		_, errs["terminal in a subdirectory"] = c.m.Create(CreateOptions{Workdir: sub, Cols: 80, Rows: 24})
		_, errs["chat"] = c.m.CreateChat(ChatCreateOptions{ID: newID("late"), Workdir: root, Mode: protocol.SessionModeNormal, Parsed: parsed(t, c.exe)})
		_, errs["handoff"] = c.m.Handoff(chatID, newID("ho"), 80, 24)
		snap := a.Session.Snapshot()
		chatStatus, chatAlive = snap.Status, processRunning(snap.Pid)
	}
	c.m.testBeforeWorktreeRemove = func() {
		_, errs["terminal after the sessions ended"] = c.m.Create(CreateOptions{Workdir: root, Cols: 80, Rows: 24})
	}
	req := request(st)
	req.DiscardFiles, req.DeleteBranch = true, true
	res, err := c.m.RemoveWorktree(req, allowAny)
	if err != nil {
		t.Fatal(err)
	}
	if len(errs) != 5 {
		t.Fatalf("hooks ran %d creates, want 5", len(errs))
	}
	for what, err := range errs {
		if !errors.Is(err, ErrWorktreeBusy) {
			t.Errorf("%s: err = %v, want ErrWorktreeBusy", what, err)
		}
	}
	if chatStatus == protocol.ChatStatusEnded || !chatAlive {
		t.Fatalf("the refused handoff stopped the chat session: status %q, process alive %v", chatStatus, chatAlive)
	}
	if !reflect.DeepEqual(res.EndedSessions, []string{chatID}) || pathExists(root) {
		t.Fatalf("result = %+v", res)
	}
	c.m.mu.RLock()
	sessions, marks, starting := len(c.m.sessions), len(c.m.removingRoots), len(c.m.startingDirs)
	c.m.mu.RUnlock()
	if sessions != 0 || marks != 0 || starting != 0 {
		t.Fatalf("left behind: %d sessions, %d removal marks, %d starting dirs", sessions, marks, starting)
	}
}

func TestRemovingMarkClearedAfterFailure(t *testing.T) {
	f := newRemoveFixture(t, 0)
	createAndDelete := func(when string) {
		t.Helper()
		r, err := f.m.Create(CreateOptions{Workdir: f.root, Cols: 80, Rows: 24})
		if err != nil {
			t.Fatalf("create after %s: %v", when, err)
		}
		if err := f.m.Delete(r.ID); err != nil {
			t.Fatal(err)
		}
		f.m.mu.RLock()
		marks := len(f.m.removingRoots)
		f.m.mu.RUnlock()
		if marks != 0 {
			t.Fatalf("%d removal marks left after %s", marks, when)
		}
	}
	// 409
	writeFiles(t, f.root, "late.txt")
	_, err := f.remove(request(f.status()))
	wantChanged(t, err)
	createAndDelete("a 409")
	// 500 before anything is touched
	runGit(t, f.repo, "worktree", "lock", f.root)
	req := request(f.status())
	req.DiscardFiles = true
	_, err = f.remove(req)
	wantRemoveError(t, err)
	createAndDelete("a refused removal")
	runGit(t, f.repo, "worktree", "unlock", f.root)
	// 500 after git failed
	installGitWrapper(t, `case " $* " in *" worktree remove "*) echo 'fatal: no' >&2; exit 128;; esac`)
	_, err = f.remove(req)
	wantRemoveError(t, err)
	createAndDelete("a failed removal")
	f.intact()
}

func TestRemoveDeletesBranchByFullRef(t *testing.T) {
	t.Run("tag_with_same_name", func(t *testing.T) {
		f := newRemoveFixture(t, 0)
		main := branchOID(t, f.repo, "main")
		runGit(t, f.repo, "tag", "fix-login", main)
		runGit(t, f.repo, "update-ref", "refs/heads/keep", main)
		tip := emptyCommits(t, f.root, 1)
		st := f.status()
		if st.UnmergedCommits != 1 {
			t.Fatalf("unmergedCommits = %d, want 1 (the tag must not be mistaken for the branch)", st.UnmergedCommits)
		}
		req := request(st)
		req.DeleteBranch, req.DropCommits = true, true
		if res := f.mustRemove(req); !res.BranchDeleted {
			t.Fatalf("result = %+v", res)
		}
		if branchOID(t, f.repo, "fix-login") != "" {
			t.Fatal("refs/heads/fix-login is still there")
		}
		if got := runGit(t, f.repo, "rev-parse", "refs/tags/fix-login"); got != main {
			t.Fatalf("the tag is at %q, want %q", got, main)
		}
		if branchOID(t, f.repo, "main") != main || branchOID(t, f.repo, "keep") != main {
			t.Fatal("another branch was touched")
		}
		_ = tip
	})
	t.Run("checked_out_elsewhere", func(t *testing.T) {
		f := newRemoveFixture(t, 0)
		elsewhere := filepath.Join(filepath.Dir(f.repo), "hotfix")
		runGit(t, f.repo, "worktree", "add", "--detach", elsewhere, "HEAD")
		runGit(t, elsewhere, "checkout", "--ignore-other-worktrees", "fix-login")
		tip := branchOID(t, f.repo, "fix-login")
		req := request(f.status())
		req.DeleteBranch = true
		res := f.mustRemove(req)
		if res.BranchDeleted || !strings.Contains(res.BranchError, elsewhere) {
			t.Fatalf("result = %+v, want the branch kept because %s has it checked out", res, elsewhere)
		}
		if branchOID(t, f.repo, "fix-login") != tip {
			t.Fatal("the branch is gone")
		}
	})
	t.Run("branch_config_removed", func(t *testing.T) {
		f := newRemoveFixture(t, 0)
		runGit(t, f.repo, "config", "branch.fix-login.remote", "origin")
		runGit(t, f.repo, "config", "branch.fix-login.merge", "refs/heads/main")
		req := request(f.status())
		req.DeleteBranch = true
		if res := f.mustRemove(req); !res.BranchDeleted {
			t.Fatalf("result = %+v", res)
		}
		out, _ := exec.Command("git", "-C", f.repo, "config", "--get-regexp", `^branch\.fix-login\.`).CombinedOutput()
		if strings.TrimSpace(string(out)) != "" {
			t.Fatalf("branch configuration left behind: %s", out)
		}
	})
	// The branch is moved after the directory is gone and before it is deleted:
	// it no longer points at the commit that was confirmed, so it stays.
	t.Run("moved_before_delete", func(t *testing.T) {
		f := newRemoveFixture(t, 0)
		runGit(t, f.repo, "checkout", "-q", "--detach")
		later := emptyCommits(t, f.repo, 1)
		runGit(t, f.repo, "checkout", "-q", "main")
		req := request(f.status())
		req.DeleteBranch = true
		origPATH := os.Getenv("PATH")
		installGitWrapper(t, `case " $* " in *" worktree remove "*) "$REAL" "$@" || exit $?; "$REAL" -C "$2" update-ref refs/heads/fix-login `+later+`; exit 0;; esac`)
		res, err := f.remove(req)
		t.Setenv("PATH", origPATH)
		if err != nil {
			t.Fatal(err)
		}
		if !res.Removed || res.BranchDeleted || res.BranchError == "" {
			t.Fatalf("result = %+v, want the directory removed and the moved branch kept", res)
		}
		if got := branchOID(t, f.repo, "fix-login"); got != later {
			t.Fatalf("fix-login at %q, want it kept at %q", got, later)
		}
	})
	// The name check would not let this one be created here, but another tool
	// can make it, and it must never reach git as an option.
	t.Run("leading_dash", func(t *testing.T) {
		f := newRemoveFixture(t, 0)
		oid := branchOID(t, f.repo, "main")
		dir := filepath.Join(containerOf(f.repo), "dash")
		runGit(t, f.repo, "update-ref", "refs/heads/-x", oid, "")
		runGit(t, f.repo, "worktree", "add", "--detach", dir, oid)
		runGit(t, dir, "symbolic-ref", "HEAD", "refs/heads/-x")
		f.store.AddWorktree(f.repo, dir, "-x")
		emptyCommits(t, dir, 1)
		fix := branchOID(t, f.repo, "fix-login")
		log := installArgLoggingGit(t)
		st := f.statusOf(dir)
		if !st.Managed || st.Branch != "-x" || st.UnmergedCommits != 1 {
			t.Fatalf("status = %+v, want managed on -x with 1 commit", st)
		}
		req := request(st)
		req.DeleteBranch, req.DropCommits = true, true
		if res := f.mustRemove(req); !res.BranchDeleted {
			t.Fatalf("result = %+v", res)
		}
		if branchOID(t, f.repo, "-x") != "" {
			t.Fatal("refs/heads/-x is still there")
		}
		if branchOID(t, f.repo, "main") != oid || branchOID(t, f.repo, "fix-login") != fix {
			t.Fatal("another branch was touched")
		}
		for _, c := range loggedGitCalls(t, log) {
			for _, a := range c {
				if !strings.Contains(a, "-x") || filepath.IsAbs(a) {
					continue
				}
				switch a {
				case "refs/heads/-x", "--exclude=-x", "branch.-x":
				default:
					t.Errorf("the branch reached git as %q in %v", a, c)
				}
			}
		}
	})
}

func TestRemoveOnlyListedWorktrees(t *testing.T) {
	f := newRemoveFixture(t, 0)
	head := runGit(t, f.root, "rev-parse", "HEAD")
	// attempt asks for the status and the removal of path, with every consent
	// given, and expects both to be refused as "not a worktree".
	attempt := func(t *testing.T, path string, allow AllowFunc) {
		t.Helper()
		req := protocol.WorktreeRemoveRequest{Path: path, Head: head, Sessions: []string{}, DiscardFiles: true, DeleteBranch: true, DropCommits: true}
		if _, err := f.m.RemoveWorktree(req, allow); !errors.Is(err, ErrWorktreeNotFound) {
			t.Fatalf("RemoveWorktree(%s) = %v, want ErrWorktreeNotFound", path, err)
		}
		if _, err := f.m.WorktreeStatus(path, allow); !errors.Is(err, ErrWorktreeNotFound) {
			t.Fatalf("WorktreeStatus(%s) = %v, want ErrWorktreeNotFound", path, err)
		}
	}
	refused := func(t *testing.T, path string, allow AllowFunc) {
		t.Helper()
		attempt(t, path, allow)
		f.intact()
	}

	plain, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	writeFiles(t, plain, "keep.txt")
	writeFiles(t, f.repo, "docs/guide.md")
	writeFiles(t, f.root, "src/main.go")
	gone := filepath.Join(filepath.Dir(f.repo), "gone")
	runGit(t, f.repo, "worktree", "add", "-b", "gone", gone, "HEAD")
	if err := os.RemoveAll(gone); err != nil {
		t.Fatal(err)
	}
	for name, path := range map[string]string{
		"arbitrary_dir":      plain,
		"subdir_of_main":     filepath.Join(f.repo, "docs"),
		"subdir_of_worktree": filepath.Join(f.root, "src"),
		"not_normalized":     f.root + "/../fix-login",
		"trailing_slash":     f.root + "/",
		"missing_directory":  gone,
		"empty":              "",
	} {
		t.Run(name, func(t *testing.T) { refused(t, path, allowAny) })
	}
	if !pathExists(filepath.Join(plain, "keep.txt")) || !pathExists(filepath.Join(f.repo, "docs", "guide.md")) || !pathExists(filepath.Join(f.root, "src", "main.go")) {
		t.Fatal("a refused request removed something")
	}
	t.Run("no_allow_func", func(t *testing.T) { refused(t, f.root, nil) })

	// A real worktree the daemon may not touch: refused before git is asked
	// anything about the path.
	t.Run("outside_allowed_roots", func(t *testing.T) {
		cfg := &config.Config{AllowedRoots: []string{f.repo}}
		log := installArgLoggingGit(t)
		attempt(t, f.root, cfg.ResolveAllowedWorkdir)
		if calls := loggedGitCalls(t, log); len(calls) != 0 {
			t.Fatalf("git was run %d times for a path outside the allowed roots: %v", len(calls), calls)
		}
		f.intact()
	})
	t.Run("symlink_escape", func(t *testing.T) {
		allowed, err := filepath.EvalSymlinks(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(allowed, "link")
		if err := os.Symlink(f.root, link); err != nil {
			t.Skipf("symlinks unsupported: %v", err)
		}
		cfg := &config.Config{AllowedRoots: []string{allowed}}
		log := installArgLoggingGit(t)
		attempt(t, link, cfg.ResolveAllowedWorkdir)
		// Even with the target allowed too, the path given is not the canonical one.
		both := &config.Config{AllowedRoots: []string{allowed, filepath.Dir(f.root)}}
		attempt(t, link, both.ResolveAllowedWorkdir)
		if calls := loggedGitCalls(t, log); len(calls) != 0 {
			t.Fatalf("git was run %d times for a link out of the allowed roots: %v", len(calls), calls)
		}
		f.intact()
	})
}

func TestRemoveFailsClosedWhenRecheckFails(t *testing.T) {
	t.Run("git_times_out", func(t *testing.T) {
		f := newRemoveFixture(t, 1)
		req := request(f.status())
		req.DeleteBranch = true
		origPATH := os.Getenv("PATH")
		slow := t.TempDir()
		writeFakeGit(t, slow, "#!/bin/sh\nexec sleep 5\n")
		t.Setenv("PATH", slow+string(os.PathListSeparator)+origPATH)
		old := gitTimeout
		gitTimeout = 50 * time.Millisecond
		_, err := f.remove(req)
		gitTimeout = old
		t.Setenv("PATH", origPATH)
		if err == nil {
			t.Fatal("expected an error when git does not answer")
		}
		if !f.alive(f.ids[0]) {
			t.Fatal("the session was ended")
		}
		f.intact()
	})
	t.Run("status_fails", func(t *testing.T) {
		f := newRemoveFixture(t, 1)
		req := request(f.status())
		req.DeleteBranch, req.DiscardFiles, req.DropCommits = true, true, true
		origPATH := os.Getenv("PATH")
		installGitWrapper(t, `case " $* " in *" status "*) echo 'fatal: index file corrupt' >&2; exit 128;; esac`)
		_, err := f.remove(req)
		t.Setenv("PATH", origPATH)
		if err == nil {
			t.Fatal("expected an error when the working tree cannot be checked")
		}
		var changed *WorktreeChangedError
		if errors.As(err, &changed) {
			t.Fatalf("err = %v, want a failure, not a re-confirmation", err)
		}
		if !f.alive(f.ids[0]) {
			t.Fatal("the session was ended")
		}
		f.intact()
	})
}

func TestRemoveBranchDeleteFailureReported(t *testing.T) {
	f := newRemoveFixture(t, 0)
	tip := branchOID(t, f.repo, "fix-login")
	req := request(f.status())
	req.DeleteBranch = true
	origPATH := os.Getenv("PATH")
	installGitWrapper(t, `case " $* " in *" update-ref -d "*) echo 'fatal: cannot lock ref' >&2; exit 128;; esac`)
	res, err := f.remove(req)
	t.Setenv("PATH", origPATH)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Removed || res.BranchDeleted || !strings.Contains(res.BranchError, "cannot lock ref") {
		t.Fatalf("result = %+v, want removed with the branch error reported", res)
	}
	if pathExists(f.root) {
		t.Fatal("the directory is still there")
	}
	if branchOID(t, f.repo, "fix-login") != tip {
		t.Fatal("the branch is gone although deleting it failed")
	}
}

func TestRemoveCleansRecordAndEmptyContainer(t *testing.T) {
	t.Run("last_worktree", func(t *testing.T) {
		f := newRemoveFixture(t, 0)
		req := request(f.status())
		req.DeleteBranch = true
		f.mustRemove(req)
		if f.store.Managed(f.repo, f.root, "fix-login") {
			t.Fatal("the creation record is still there")
		}
		if pathExists(containerOf(f.repo)) {
			t.Fatal("the empty container directory is still there")
		}
	})
	t.Run("container_still_in_use", func(t *testing.T) {
		f := newRemoveFixture(t, 0)
		r, err := f.m.Create(CreateOptions{Workdir: f.repo, Mode: protocol.SessionModeWorktree, WorktreeName: "other", Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { r.Kill() })
		req := request(f.status())
		req.DeleteBranch = true
		f.mustRemove(req)
		if !pathExists(r.WorktreeRoot) || !f.store.Managed(f.repo, r.WorktreeRoot, "other") {
			t.Fatal("the other worktree or its record is gone")
		}
	})
	// The parent of an external worktree is not ours to tidy, empty or not.
	t.Run("foreign_parent", func(t *testing.T) {
		f := newRemoveFixture(t, 0)
		parent := filepath.Join(filepath.Dir(f.repo), "elsewhere")
		ext := filepath.Join(parent, "ext")
		runGit(t, f.repo, "worktree", "add", "-b", "ext", ext, "HEAD")
		f.mustRemove(request(f.statusOf(ext)))
		if !pathExists(parent) {
			t.Fatal("the external worktree's parent directory was removed")
		}
		if branchOID(t, f.repo, "ext") == "" {
			t.Fatal("the external branch was removed")
		}
	})
}

// A session starting in a worktree and the worktree being removed, at the same
// moment: exactly one of them wins, and a session never ends up registered in
// a directory that is gone.
func TestConcurrentRemoveAndCreateOneWins(t *testing.T) {
	const rounds = 12
	for round := 0; round < rounds; round++ {
		f := newRemoveFixture(t, 0)
		req := request(f.status())
		req.DeleteBranch = true
		var wg sync.WaitGroup
		var removeErr, createErr error
		var created *Runner
		start := make(chan struct{})
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			_, removeErr = f.remove(req)
		}()
		go func() {
			defer wg.Done()
			<-start
			created, createErr = f.m.Create(CreateOptions{Workdir: f.root, Cols: 80, Rows: 24})
		}()
		close(start)
		wg.Wait()
		if created != nil {
			t.Cleanup(func() { created.Kill() })
		}
		switch {
		case removeErr == nil && createErr == nil:
			t.Fatalf("round %d: the worktree was removed and a session was started in it", round)
		case removeErr != nil && createErr != nil:
			t.Fatalf("round %d: both failed: remove %v; create %v", round, removeErr, createErr)
		case removeErr == nil:
			if pathExists(f.root) {
				t.Fatalf("round %d: removed, but the directory is there", round)
			}
			if !errors.Is(createErr, ErrWorktreeBusy) && !strings.Contains(createErr.Error(), f.root) {
				t.Fatalf("round %d: create failed with %v", round, createErr)
			}
		default:
			wantChanged(t, removeErr)
			f.intact()
			if !f.alive(created.ID) {
				t.Fatalf("round %d: the session that won is not running", round)
			}
		}
		f.m.mu.RLock()
		registered, marks, starting := len(f.m.sessions), len(f.m.removingRoots), len(f.m.startingDirs)
		f.m.mu.RUnlock()
		want := 0
		if createErr == nil {
			want = 1
		}
		if registered != want || marks != 0 || starting != 0 {
			t.Fatalf("round %d: %d sessions registered (want %d), %d removal marks, %d starting dirs", round, registered, want, marks, starting)
		}
	}
}

// Two removals of the same worktree: the second finds it gone.
func TestConcurrentRemoveSameWorktree(t *testing.T) {
	const rounds = 6
	for round := 0; round < rounds; round++ {
		f := newRemoveFixture(t, 1)
		req := request(f.status())
		req.DeleteBranch = true
		errs := make([]error, 2)
		results := make([]protocol.WorktreeRemoveResult, 2)
		var wg sync.WaitGroup
		for i := range errs {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				results[i], errs[i] = f.remove(req)
			}(i)
		}
		wg.Wait()
		won := 0
		for i, err := range errs {
			switch {
			case err == nil:
				won++
				if !results[i].Removed || !reflect.DeepEqual(results[i].EndedSessions, f.ids) {
					t.Fatalf("round %d: result %+v", round, results[i])
				}
			case !errors.Is(err, ErrWorktreeNotFound):
				t.Fatalf("round %d: the losing removal failed with %v, want ErrWorktreeNotFound", round, err)
			}
		}
		if won != 1 {
			t.Fatalf("round %d: %d removals succeeded, want 1", round, won)
		}
		if pathExists(f.root) || branchOID(t, f.repo, "fix-login") != "" {
			t.Fatalf("round %d: the directory or the branch is left", round)
		}
	}
}

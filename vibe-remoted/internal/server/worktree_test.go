package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/config"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/session"
)

// R5.10: DELETE /api/v1/sessions/{id} — all an older desktop sends — never
// touches the worktree or its branch, whatever state they are in.
func TestDeleteSessionNeverReturnsPreserved(t *testing.T) {
	for _, tc := range []struct {
		name    string
		prepare func(t *testing.T, root string)
	}{
		{"clean_with_unmerged_commits", func(t *testing.T, root string) {
			serverGit(t, root, "commit", "--allow-empty", "-m", "c1")
			serverGit(t, root, "commit", "--allow-empty", "-m", "c2")
		}},
		{"uncommitted_file", func(t *testing.T, root string) {
			if err := os.WriteFile(filepath.Join(root, "changed"), []byte("keep"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		{"ignored_only", func(t *testing.T, root string) {
			if err := os.WriteFile(filepath.Join(root, "ignored.txt"), []byte("keep"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := serverTempRepo(t)
			if err := os.WriteFile(filepath.Join(repo, ".gitignore"), []byte("ignored.txt\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			serverGit(t, repo, "add", ".gitignore")
			serverGit(t, repo, "commit", "-m", "ignore")
			base := serverGitOut(t, repo, "rev-parse", "HEAD")
			mgr := session.NewManager(false, "/bin/cat", false, "")
			runner, err := mgr.Create(session.CreateOptions{Workdir: repo, Mode: protocol.SessionModeWorktree, Cols: 80, Rows: 24})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { runner.Kill() })
			tc.prepare(t, runner.WorktreeRoot)
			tip := serverGitOut(t, runner.WorktreeRoot, "rev-parse", "HEAD")
			entries, err := os.ReadDir(runner.WorktreeRoot)
			if err != nil {
				t.Fatal(err)
			}

			s := New(&config.Config{Token: "secret"}, mgr)
			req := httptest.NewRequest(http.MethodDelete, "/api/v1/sessions/"+runner.ID, nil)
			req.Header.Set("Authorization", "Bearer secret")
			w := httptest.NewRecorder()
			s.mux.ServeHTTP(w, req)

			if w.Code != http.StatusNoContent || w.Body.Len() != 0 {
				t.Fatalf("status = %d, body = %q; want 204 with an empty body", w.Code, w.Body.String())
			}
			if _, ok := mgr.Get(runner.ID); ok {
				t.Fatal("the session is still registered")
			}
			after, err := os.ReadDir(runner.WorktreeRoot)
			if err != nil {
				t.Fatalf("worktree dir was removed: %v", err)
			}
			if len(after) != len(entries) {
				t.Fatalf("worktree content changed: %v → %v", entries, after)
			}
			if got := serverGitOut(t, repo, "rev-parse", "refs/heads/"+runner.Branch); got != tip {
				t.Fatalf("branch at %q, want %q", got, tip)
			}
			want := "0"
			if tc.name == "clean_with_unmerged_commits" {
				want = "2"
			}
			if got := serverGitOut(t, repo, "rev-list", "--count", base+"..refs/heads/"+runner.Branch); got != want {
				t.Fatalf("commits on the branch = %s, want %s", got, want)
			}
		})
	}
}

func serverTempRepo(t *testing.T) string {
	t.Helper()
	d := t.TempDir()
	serverGit(t, d, "init")
	serverGit(t, d, "config", "user.email", "test@example.com")
	serverGit(t, d, "config", "user.name", "Test User")
	if err := os.WriteFile(filepath.Join(d, "README"), []byte("initial\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	serverGit(t, d, "add", "README")
	serverGit(t, d, "commit", "-m", "initial")
	return d
}

func serverGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// --- T7: attach with worktreeName ---

// attachTerminal sends a create-attach for a terminal session and returns the
// ready frame.
func (c *chatServer) attachTerminal(w *wsClient, frame protocol.AttachFrame) *protocol.ReadyFrame {
	c.t.Helper()
	frame.Type = protocol.TypeAttach
	if frame.Cols == 0 {
		frame.Cols, frame.Rows = 80, 24
	}
	before := len(w.snapshot())
	w.send(frame)
	fs := w.waitFor("terminal ready", func(fs []wsFrame) bool {
		return firstOf(fs[before:], protocol.TypeReady) != nil || firstOf(fs[before:], protocol.TypeError) != nil
	})[before:]
	if e := firstOf(fs, protocol.TypeError); e != nil {
		c.t.Fatalf("attach failed: %s", e.Raw)
	}
	ready := firstOf(fs, protocol.TypeReady).Ready
	c.t.Cleanup(func() { c.mgr.Delete(ready.SessionID) })
	return ready
}

func (c *chatServer) projectTree() protocol.ProjectsResponse {
	c.t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	req.Header.Set("Authorization", "Bearer "+c.cfg.Token)
	w := httptest.NewRecorder()
	c.s.mux.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		c.t.Fatalf("projects status = %d: %s", w.Code, w.Body.String())
	}
	var resp protocol.ProjectsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		c.t.Fatal(err)
	}
	return resp
}

// repo makes <root>/<name> a git repository on branch main that claude trusts.
func (c *chatServer) repo(name string) string {
	c.t.Helper()
	dir := c.dir(name)
	initRepoAt(c.t, dir)
	return dir
}

func branchExists(t *testing.T, repo, name string) bool {
	t.Helper()
	return exec.Command("git", "-C", repo, "show-ref", "--verify", "--quiet", "refs/heads/"+name).Run() == nil
}

func TestWSAttachWorktreeName(t *testing.T) {
	c := newChatServer(t)
	c.mgr.SetProjectStore(session.NewMemoryProjectStore())
	repo := c.repo("devflow")
	head := serverGitOut(t, repo, "rev-parse", "HEAD")
	w := c.connect()
	ready := c.attachChat(w, protocol.AttachFrame{NewSessionID: newSID("wtn"), Workdir: repo,
		Mode: protocol.SessionModeWorktree, WorktreeName: "fix-login"})
	t.Cleanup(func() { c.mgr.Delete(ready.SessionID) })
	root := filepath.Join(c.root, "devflow-worktrees", "fix-login")
	if ready.UI != protocol.UIChat || ready.Branch != "fix-login" || ready.Mode != protocol.SessionModeWorktree || ready.WorktreeRoot != root || ready.Workdir != root {
		t.Fatalf("ready %+v, want a chat session on fix-login in %q", ready, root)
	}
	if got := serverGitOut(t, repo, "rev-parse", "refs/heads/fix-login"); got != head {
		t.Fatalf("fix-login at %q, want main's %q", got, head)
	}
	p := projectByName(c.projectTree(), "devflow")
	if p == nil {
		t.Fatalf("no devflow project: %+v", c.projectTree())
	}
	wt := worktreeByBranch(p, "fix-login")
	if wt == nil || !wt.Managed || wt.Path != root {
		t.Fatalf("fix-login row %+v, want managed at %q", wt, root)
	}
	if len(wt.Sessions) != 1 || wt.Sessions[0] != ready.SessionID {
		t.Fatalf("fix-login sessions %v, want [%s]", wt.Sessions, ready.SessionID)
	}
}

func TestWSAttachWorktreeCreateFailed(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("needs a non-writable directory")
	}
	c := newChatServer(t, withClaudeCmd("/bin/cat"))
	c.mgr.SetProjectStore(session.NewMemoryProjectStore())
	repo := c.repo("devflow")
	admin := filepath.Join(repo, ".git", "worktrees")
	if err := os.Mkdir(admin, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(admin, 0o755) })
	e := expectAttachError(t, c.connect(), protocol.AttachFrame{NewSessionID: newSID("wtf"), Workdir: repo,
		Mode: protocol.SessionModeWorktree, WorktreeName: "fix-login"})
	if e.Code != protocol.ErrCodeCreateFailed || !e.Fatal || !strings.Contains(e.Message, "fatal:") {
		t.Fatalf("error %+v, want fatal create_failed carrying git's output", e)
	}
	if p := projectByName(c.projectTree(), "devflow"); p != nil && worktreeByBranch(p, "fix-login") != nil {
		t.Fatalf("a fix-login row appeared: %+v", p)
	}
	if got := serverGitOut(t, repo, "for-each-ref", "--format=%(refname)", "refs/heads"); got != "refs/heads/main" {
		t.Fatalf("the failed create left a branch: %q", got)
	}
	if pathExists(filepath.Join(c.root, "devflow-worktrees")) {
		t.Fatal("the failed create left a directory")
	}
}

func pathExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func TestAttachWorktreeWithoutNameKeepsLegacyNaming(t *testing.T) {
	c := newChatServer(t, withClaudeCmd("/bin/cat"))
	repo := c.repo("devflow")
	id := newSID("legacy")
	ready := c.attachTerminal(c.connect(), protocol.AttachFrame{NewSessionID: id, Workdir: repo, Mode: protocol.SessionModeWorktree})
	root := filepath.Join(c.root, "devflow-worktrees", id)
	want := protocol.ReadyFrame{Type: protocol.TypeReady, SessionID: id, Workdir: root, Proto: protocol.Version,
		SessionMetadata: protocol.SessionMetadata{Mode: protocol.SessionModeWorktree, SourceWorkdir: repo, SourceRepo: repo, WorktreeRoot: root, Branch: "vibe/" + id}}
	if !reflect.DeepEqual(*ready, want) {
		t.Fatalf("ready\n got %+v\nwant %+v", *ready, want)
	}
	if got := serverGitOut(t, root, "symbolic-ref", "HEAD"); got != "refs/heads/vibe/"+id {
		t.Fatalf("worktree HEAD = %q", got)
	}
}

func TestWSWorktreeErrorsAreFatal(t *testing.T) {
	c := newChatServer(t, withClaudeCmd("/bin/cat"))
	repo := c.repo("devflow")
	serverGit(t, repo, "branch", "taken")
	serverGit(t, repo, "branch", "fix")
	existing := filepath.Join(c.root, "devflow-worktrees", "occupied")
	if err := os.MkdirAll(existing, 0o755); err != nil {
		t.Fatal(err)
	}
	attach := func(c *chatServer, workdir, name string) *protocol.ErrorFrame {
		return expectAttachError(t, c.connect(), protocol.AttachFrame{NewSessionID: newSID("wte"), Workdir: workdir,
			Mode: protocol.SessionModeWorktree, WorktreeName: name})
	}
	for _, tc := range []struct{ name, code, inMessage string }{
		{"a b", protocol.ErrCodeInvalidWorktreeName, ""},
		{"@{-1}", protocol.ErrCodeInvalidWorktreeName, ""},
		{"taken", protocol.ErrCodeWorktreeBranchExists, "taken"},
		{"fix/login", protocol.ErrCodeWorktreeBranchExists, `"fix"`},
		{"occupied", protocol.ErrCodeWorktreePathExists, existing},
	} {
		e := attach(c, repo, tc.name)
		if e.Code != tc.code || !e.Fatal || !strings.Contains(e.Message, tc.inMessage) {
			t.Errorf("worktreeName %q: %+v, want fatal %s mentioning %q", tc.name, e, tc.code, tc.inMessage)
		}
	}
	if branchExists(t, repo, "a b") || branchExists(t, repo, "fix/login") || branchExists(t, repo, "occupied") {
		t.Error("a rejected create left a branch")
	}

	// The repository is the allowed root itself, so its worktrees directory
	// (a sibling) is outside: refused before anything is created, named or not.
	t.Run("path_not_allowed", func(t *testing.T) {
		c := newChatServer(t, withClaudeCmd("/bin/cat"))
		initRepoAt(t, c.root)
		container := filepath.Join(filepath.Dir(c.root), filepath.Base(c.root)+"-worktrees")
		e := attach(c, c.root, "fix-login")
		if e.Code != protocol.ErrCodeWorktreePathNotAllowed || !e.Fatal || !strings.Contains(e.Message, filepath.Join(container, "fix-login")) {
			t.Fatalf("named: %+v, want fatal worktree_path_not_allowed with the full path", e)
		}
		id := newSID("wte")
		e = expectAttachError(t, c.connect(), protocol.AttachFrame{NewSessionID: id, Workdir: c.root, Mode: protocol.SessionModeWorktree})
		if e.Code != protocol.ErrCodeWorktreePathNotAllowed || !e.Fatal || !strings.Contains(e.Message, filepath.Join(container, id)) {
			t.Fatalf("unnamed: %+v, want fatal worktree_path_not_allowed with the full path", e)
		}
		if pathExists(container) || branchExists(t, c.root, "fix-login") || branchExists(t, c.root, "vibe/"+id) {
			t.Fatal("a refused create left a directory or a branch")
		}
	})

	t.Run("mapped_workdir_escape", func(t *testing.T) {
		c := newChatServer(t, withClaudeCmd("/bin/cat"))
		outside, _ := filepath.EvalSymlinks(t.TempDir())
		repo := c.repo("devflow")
		if err := os.Symlink(outside, filepath.Join(repo, "linkdir")); err != nil {
			t.Skipf("symlinks unsupported: %v", err)
		}
		serverGit(t, repo, "add", "linkdir")
		serverGit(t, repo, "commit", "-m", "linkdir is a symlink")
		os.Remove(filepath.Join(repo, "linkdir"))
		if err := os.Mkdir(filepath.Join(repo, "linkdir"), 0o755); err != nil {
			t.Fatal(err)
		}
		e := attach(c, filepath.Join(repo, "linkdir"), "fix-login")
		if e.Code != protocol.ErrCodeWorktreePathNotAllowed || !e.Fatal {
			t.Fatalf("%+v, want fatal worktree_path_not_allowed", e)
		}
		if pathExists(filepath.Join(c.root, "devflow-worktrees")) || branchExists(t, repo, "fix-login") {
			t.Fatal("the worktree or its branch was left next to the repository")
		}
		if entries, _ := os.ReadDir(outside); len(entries) != 0 {
			t.Fatalf("the link target gained %v", entries)
		}
	})
}

func TestHandoffIgnoresWorktreeName(t *testing.T) {
	c := newChatServer(t, withTmux())
	repo := c.repo("devflow")
	w := c.connect()
	ready := c.newChat(w, repo)
	tw := c.connect()
	newID := newSID("ho")
	before := len(tw.snapshot())
	tw.send(protocol.AttachFrame{Type: protocol.TypeAttach, NewSessionID: newID, HandoffFrom: ready.SessionID,
		Mode: protocol.SessionModeWorktree, WorktreeName: "fix-login", Cols: 80, Rows: 24})
	fs := tw.waitFor("handoff ready", func(fs []wsFrame) bool {
		return firstOf(fs[before:], protocol.TypeReady) != nil || firstOf(fs[before:], protocol.TypeError) != nil
	})[before:]
	if e := firstOf(fs, protocol.TypeError); e != nil {
		t.Fatalf("handoff failed: %s", e.Raw)
	}
	t.Cleanup(func() { c.mgr.Delete(newID) })
	tr := firstOf(fs, protocol.TypeReady).Ready
	if tr.SessionID != newID || tr.HandoffFrom != ready.SessionID || tr.Workdir != repo || tr.Branch != "" {
		t.Fatalf("handoff ready %+v, want the chat session's directory and no worktree", tr)
	}
	if branchExists(t, repo, "fix-login") || pathExists(filepath.Join(c.root, "devflow-worktrees")) {
		t.Fatal("the handoff created a worktree")
	}
}

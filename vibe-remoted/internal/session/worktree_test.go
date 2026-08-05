package session

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func tempRepo(t *testing.T) string {
	t.Helper()
	d := t.TempDir()
	runGit(t, d, "init")
	runGit(t, d, "config", "user.email", "test@example.com")
	runGit(t, d, "config", "user.name", "Test User")
	if err := os.WriteFile(filepath.Join(d, "README"), []byte("initial\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, d, "add", "README")
	runGit(t, d, "commit", "-m", "initial")
	return d
}

func TestWorktreeRepositoryRootSelection(t *testing.T) {
	repo := tempRepo(t)
	sub := filepath.Join(repo, "nested")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	meta, mapped, err := CreateWorktree(sub, "abc123")
	if err != nil {
		t.Fatal(err)
	}
	defer CleanupWorktree(meta)
	canonicalRepo := runGit(t, sub, "rev-parse", "--show-toplevel")
	if meta.SourceRepo != canonicalRepo {
		t.Fatalf("meta=%+v mapped=%q", meta, mapped)
	}
	if mapped != filepath.Join(meta.WorktreeRoot, "nested") {
		t.Fatalf("mapped=%q", mapped)
	}
}

func TestWorktreeRejectsUnsafeSessionIDBeforeFilesystemAccess(t *testing.T) {
	repo := tempRepo(t)
	container := filepath.Join(filepath.Dir(repo), filepath.Base(repo)+"-worktrees")
	outside := filepath.Join(filepath.Dir(container), "escape")

	for _, sessionID := range []string{"", ".", "..", "../escape", "../../tmp", "/absolute", `back\\slash`} {
		t.Run(sessionID, func(t *testing.T) {
			_, _, err := CreateWorktree(repo, sessionID)
			if err == nil || !strings.Contains(err.Error(), "invalid session ID") {
				t.Fatalf("err=%v", err)
			}
		})
	}
	if _, err := os.Stat(container); !os.IsNotExist(err) {
		t.Fatalf("worktree container was touched: %v", err)
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatalf("outside path was touched: %v", err)
	}
	if got := runGit(t, repo, "worktree", "list", "--porcelain"); strings.Count(got, "worktree ") != 1 {
		t.Fatalf("unexpected worktree created:\n%s", got)
	}
}

func TestWorktreeUsesCanonicalRepoRootForSymlinkAlias(t *testing.T) {
	repo := tempRepo(t)
	alias := filepath.Join(filepath.Dir(repo), "repo-alias")
	if err := os.Symlink(repo, alias); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	canonicalRoot := runGit(t, alias, "rev-parse", "--show-toplevel")

	meta, mapped, err := CreateWorktree(alias, "symlinked")
	if err != nil {
		t.Fatal(err)
	}
	defer CleanupWorktree(meta)
	if meta.SourceRepo != canonicalRoot {
		t.Fatalf("SourceRepo=%q want canonical git root %q", meta.SourceRepo, canonicalRoot)
	}
	wantRoot := filepath.Join(filepath.Dir(canonicalRoot), filepath.Base(canonicalRoot)+"-worktrees", "symlinked")
	if meta.WorktreeRoot != wantRoot {
		t.Fatalf("WorktreeRoot=%q want %q", meta.WorktreeRoot, wantRoot)
	}
	if mapped != wantRoot {
		t.Fatalf("mapped=%q want %q", mapped, wantRoot)
	}
}

func TestWorktreeNestedSubdirectoryMapping(t *testing.T) {
	repo := tempRepo(t)
	sub := filepath.Join(repo, "a", "b")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	meta, mapped, err := CreateWorktree(sub, "nested")
	if err != nil {
		t.Fatal(err)
	}
	defer CleanupWorktree(meta)
	expected := filepath.Join(meta.WorktreeRoot, "a", "b")
	if mapped != expected {
		t.Fatalf("mapped=%q want %q", mapped, expected)
	}
	if info, err := os.Stat(mapped); err != nil || !info.IsDir() {
		t.Fatalf("mapped workdir was not preserved as a directory: info=%v err=%v", info, err)
	}
}

func TestWorktreeRejectsNonGitDirectory(t *testing.T) {
	_, _, err := CreateWorktree(t.TempDir(), "nope")
	if err == nil || !strings.Contains(err.Error(), "discover repository") {
		t.Fatalf("err=%v", err)
	}
}

func TestWorktreeGeneratedBranchAndPath(t *testing.T) {
	repo := tempRepo(t)
	meta, _, err := CreateWorktree(repo, "session-1")
	if err != nil {
		t.Fatal(err)
	}
	defer CleanupWorktree(meta)
	if meta.Branch != "vibe/session-1" {
		t.Fatal(meta.Branch)
	}
	canonicalRepo := runGit(t, repo, "rev-parse", "--show-toplevel")
	if want := filepath.Join(filepath.Dir(canonicalRepo), filepath.Base(canonicalRepo)+"-worktrees", "session-1"); meta.WorktreeRoot != want {
		t.Fatalf("root=%q want %q", meta.WorktreeRoot, want)
	}
	if got := runGit(t, repo, "branch", "--list", meta.Branch); !strings.Contains(got, meta.Branch) {
		t.Fatalf("branch missing: %q", got)
	}
}

func TestWorktreeCleanCleanupRemovesWorktreeAndBranch(t *testing.T) {
	repo := tempRepo(t)
	meta, _, err := CreateWorktree(repo, "clean")
	if err != nil {
		t.Fatal(err)
	}
	if err := CleanupWorktree(meta); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(meta.WorktreeRoot); !os.IsNotExist(err) {
		t.Fatalf("worktree still exists: %v", err)
	}
	if got := runGit(t, repo, "branch", "--list", meta.Branch); got != "" {
		t.Fatalf("branch still exists: %q", got)
	}
}

func TestWorktreeDirtyCleanupPreservesBoth(t *testing.T) {
	repo := tempRepo(t)
	meta, _, err := CreateWorktree(repo, "dirty")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(meta.WorktreeRoot, "changed"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	err = CleanupWorktree(meta)
	var preserved *WorktreePreservedError
	if !asPreserved(err, &preserved) {
		t.Fatalf("err=%T %v", err, err)
	}
	if preserved.WorktreeRoot != meta.WorktreeRoot || preserved.Branch != meta.Branch {
		t.Fatalf("preserved=%+v", preserved)
	}
	if _, err := os.Stat(meta.WorktreeRoot); err != nil {
		t.Fatal(err)
	}
	if got := runGit(t, repo, "branch", "--list", meta.Branch); !strings.Contains(got, meta.Branch) {
		t.Fatal(got)
	}
}

func TestWorktreeIgnoredFileIsPreserved(t *testing.T) {
	repo := tempRepo(t)
	if err := os.WriteFile(filepath.Join(repo, ".gitignore"), []byte("ignored.txt\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", ".gitignore")
	runGit(t, repo, "commit", "-m", "ignore")
	meta, _, err := CreateWorktree(repo, "ignored")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(meta.WorktreeRoot, "ignored.txt"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	err = CleanupWorktree(meta)
	if err == nil {
		t.Fatal("ignored file cleanup unexpectedly succeeded")
	}
	var preserved *WorktreePreservedError
	if !asPreserved(err, &preserved) {
		t.Fatalf("err=%T %v", err, err)
	}
}
func TestWorktreeRollbackToleratesMissingWorktreeOrBranch(t *testing.T) {
	repo := tempRepo(t)
	meta, _, err := CreateWorktree(repo, "rollback")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(meta.WorktreeRoot); err != nil {
		t.Fatal(err)
	}
	if err := RollbackWorktree(meta); err != nil {
		t.Fatal(err)
	}
	if err := RollbackWorktree(meta); err != nil {
		t.Fatal(err)
	}
}

func asPreserved(err error, target **WorktreePreservedError) bool {
	if err == nil {
		return false
	}
	p, ok := err.(*WorktreePreservedError)
	if ok {
		*target = p
	}
	return ok
}

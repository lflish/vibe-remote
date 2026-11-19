package session

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type WorktreeMetadata struct {
	SourceWorkdir string
	SourceRepo    string
	WorktreeRoot  string
	Branch        string
}

type WorktreePreservedError struct{ WorktreeRoot, Branch string }

func (e *WorktreePreservedError) Error() string {
	return fmt.Sprintf("worktree %q is dirty; preserved branch %q", e.WorktreeRoot, e.Branch)
}

// gitTimeout bounds the git calls used for read-only discovery (ListWorktrees,
// ResolveHome, worktree pre-checks). Tests may lower it. gitAt (the creation
// and cleanup path) is not time-bounded.
var gitTimeout = 5 * time.Second

// gitStrippedEnv are environment variables that would redirect git at another
// repository or index; a daemon started under one of them must not leak it into
// the worktree queries (design 4.9, V12).
var gitStrippedEnv = map[string]bool{
	"GIT_DIR": true, "GIT_WORK_TREE": true, "GIT_INDEX_FILE": true,
	"GIT_COMMON_DIR": true, "GIT_OBJECT_DIRECTORY": true, "GIT_NAMESPACE": true,
	"LC_ALL": true,
}

// gitEnv returns the process environment with the repository-redirecting
// variables removed and LC_ALL pinned to C, so git's output is stable and
// always describes the directory passed with -C.
func gitEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		key, _, _ := strings.Cut(kv, "=")
		if gitStrippedEnv[key] {
			continue
		}
		env = append(env, kv)
	}
	return append(env, "LC_ALL=C")
}

func gitAt(dir string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = gitEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return out, fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return out, nil
}

// gitAtTimeout runs git under gitTimeout. A deadline hit wraps
// context.DeadlineExceeded so callers can tell a timeout apart from a non-zero
// exit without matching git's message text. The child runs in its own process
// group, which is killed on timeout so a slow git (or its children) cannot
// linger.
func gitAtTimeout(dir string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = gitEnv()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
	cmd.WaitDelay = time.Second
	out, err := cmd.CombinedOutput()
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return out, fmt.Errorf("git %s: %w", strings.Join(args, " "), context.DeadlineExceeded)
		}
		return out, fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return out, nil
}

// Worktree is one entry of `git worktree list --porcelain`. Head is the 40-hex
// commit; Branch is the short name (empty when detached or bare).
type Worktree struct {
	Path, Branch, Head               string
	Detached, Bare, Prunable, Locked bool
	LockReason                       string
}

// ListWorktrees returns the worktrees of the repository that contains dir. The
// first entry is the main worktree (or, for a bare repo, the bare entry); paths
// are git's canonical paths.
func ListWorktrees(dir string) ([]Worktree, error) {
	out, err := gitAtTimeout(dir, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}
	var list []Worktree
	var cur *Worktree
	flush := func() {
		if cur != nil {
			list = append(list, *cur)
			cur = nil
		}
	}
	for _, line := range strings.Split(string(out), "\n") {
		if line == "" {
			flush()
			continue
		}
		key, val, _ := strings.Cut(line, " ")
		switch key {
		case "worktree":
			flush()
			cur = &Worktree{Path: val}
		case "HEAD":
			if cur != nil {
				cur.Head = val
			}
		case "branch":
			if cur != nil {
				cur.Branch = strings.TrimPrefix(val, "refs/heads/")
			}
		case "detached":
			if cur != nil {
				cur.Detached = true
			}
		case "bare":
			if cur != nil {
				cur.Bare = true
			}
		case "locked":
			if cur != nil {
				cur.Locked = true
				cur.LockReason = val
			}
		case "prunable":
			if cur != nil {
				cur.Prunable = true
			}
		}
	}
	flush()
	return list, nil
}

// Home is a session's project attribution (design 4.9, 5.1). For a non-git
// directory Project and Path are the directory itself and Repo is empty.
type Home struct {
	Project string // project id
	Path    string // root of the worktree the session sits in
	Repo    string // the directory git -C is run against = the first list entry
	Git     bool
	Single  bool // no recognizable main worktree (submodule, --separate-git-dir)
}

// ResolveHome computes the project attribution of dir. A directory that is not
// a git repository returns Home{Git:false} and a nil error; a git failure or
// timeout returns an error (the caller then records no attribution and retries
// later).
func ResolveHome(dir string) (Home, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return Home{}, err
	}
	out, err := gitAtTimeout(abs, "rev-parse", "--show-toplevel")
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return Home{}, err
		}
		// Not a repo vs. a real failure is decided by git exit codes and the
		// filesystem, never by matching message text (design 4.9).
		if inside, ierr := gitAtTimeout(abs, "rev-parse", "--is-inside-git-dir"); ierr == nil && strings.TrimSpace(string(inside)) == "true" {
			return Home{Project: abs, Path: abs, Git: false}, nil
		}
		if !hasGitAncestor(abs) {
			return Home{Project: abs, Path: abs, Git: false}, nil
		}
		return Home{}, err
	}
	top := filepath.Clean(strings.TrimSpace(string(out)))
	wts, err := ListWorktrees(top)
	if err != nil {
		return Home{}, err
	}
	if len(wts) == 0 {
		return Home{Project: top, Path: top, Repo: top, Git: true}, nil
	}
	first := wts[0]
	if first.Bare || hasDotGit(first.Path) {
		// Normal repository: the first entry is the main worktree.
		return Home{Project: first.Path, Path: top, Repo: first.Path, Git: true}, nil
	}
	// The first entry is a git directory (submodule, --separate-git-dir): there
	// is no main worktree to group under, so the project is this toplevel alone.
	return Home{Project: top, Path: top, Repo: first.Path, Git: true, Single: true}, nil
}

func hasDotGit(path string) bool {
	_, err := os.Stat(filepath.Join(path, ".git"))
	return err == nil
}

func hasGitAncestor(dir string) bool {
	for {
		if _, err := os.Lstat(filepath.Join(dir, ".git")); err == nil {
			return true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return false
		}
		dir = parent
	}
}

var safeSessionID = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func CreateWorktree(sourceWorkdir, sessionID string) (WorktreeMetadata, string, error) {
	if !safeSessionID.MatchString(sessionID) {
		return WorktreeMetadata{}, "", fmt.Errorf("invalid session ID")
	}
	sourceAbs, err := filepath.Abs(sourceWorkdir)
	if err != nil {
		return WorktreeMetadata{}, "", fmt.Errorf("resolve source workdir: %w", err)
	}
	out, err := gitAt(sourceAbs, "rev-parse", "--show-toplevel")
	if err != nil {
		return WorktreeMetadata{}, "", fmt.Errorf("discover repository: %w", err)
	}
	repoRoot := filepath.Clean(strings.TrimSpace(string(out)))
	// Git returns the canonical repository root. Use that discovered path for
	// worktree placement; never derive sibling paths from the caller's spelling.
	canonicalAbs, err := filepath.EvalSymlinks(sourceAbs)
	if err != nil {
		return WorktreeMetadata{}, "", fmt.Errorf("resolve source workdir links: %w", err)
	}
	canonicalRepo, err := filepath.EvalSymlinks(repoRoot)
	if err != nil {
		return WorktreeMetadata{}, "", fmt.Errorf("resolve repository links: %w", err)
	}
	rel, err := filepath.Rel(canonicalRepo, canonicalAbs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return WorktreeMetadata{}, "", fmt.Errorf("source workdir escapes repository")
	}
	sourceRepo := repoRoot
	container := filepath.Join(filepath.Dir(sourceRepo), filepath.Base(sourceRepo)+"-worktrees")
	root := filepath.Join(container, sessionID)
	meta := WorktreeMetadata{SourceWorkdir: sourceAbs, SourceRepo: sourceRepo, WorktreeRoot: root, Branch: "vibe/" + sessionID}
	if err := os.MkdirAll(container, 0o755); err != nil {
		return WorktreeMetadata{}, "", fmt.Errorf("create worktree container: %w", err)
	}
	if _, err := gitAt(sourceRepo, "worktree", "add", "-b", meta.Branch, root, "HEAD"); err != nil {
		_ = os.Remove(container)
		return WorktreeMetadata{}, "", fmt.Errorf("create worktree: %w", err)
	}
	mapped := root
	if rel != "." {
		mapped = filepath.Join(root, rel)
		// Git does not materialize empty/untracked directories. Preserve the
		// caller's selected directory so Runner always receives a valid cwd.
		if err := os.MkdirAll(mapped, 0o755); err != nil {
			if rollbackErr := RollbackWorktree(meta); rollbackErr != nil {
				return WorktreeMetadata{}, "", fmt.Errorf("create mapped workdir: %v; rollback worktree: %w", err, rollbackErr)
			}
			return WorktreeMetadata{}, "", fmt.Errorf("create mapped workdir: %w", err)
		}
	}
	return meta, mapped, nil
}

func isMissingBranchError(err error) bool {
	message := err.Error()
	return strings.Contains(message, "branch '") && strings.Contains(message, "not found")
}

func isMissingWorktreeError(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "is not a working tree") || strings.Contains(message, "does not exist") || strings.Contains(message, "not found")
}

func RollbackWorktree(meta WorktreeMetadata) error {
	if _, err := gitAt(meta.SourceRepo, "worktree", "remove", "--force", meta.WorktreeRoot); err != nil {
		if !isMissingWorktreeError(err) {
			// A missing path is already rolled back, but Git may retain stale metadata
			// after an external filesystem removal. Prune that metadata before deleting
			// the branch.
			if _, pruneErr := gitAt(meta.SourceRepo, "worktree", "prune"); pruneErr != nil {
				return fmt.Errorf("rollback worktree: %w", err)
			}
		}
	}
	if _, err := gitAt(meta.SourceRepo, "branch", "-D", meta.Branch); err != nil {
		if isMissingBranchError(err) {
			return nil
		}
		return fmt.Errorf("rollback branch: %w", err)
	}
	_ = os.Remove(filepath.Dir(meta.WorktreeRoot))
	return nil
}

// UnmergedCommits counts commits on branch that no other local branch or
// remote-tracking ref contains (H9, design 3). An empty branch counts the
// commits reachable from dir's detached HEAD instead. The branch is always
// named by its full ref form (refs/heads/<branch>): a short name that
// collides with a same-named tag would resolve to the tag and report 0 (V10).
func UnmergedCommits(dir, branch string) (int, error) {
	var args []string
	if branch == "" {
		args = []string{"rev-list", "--count", "HEAD", "--not", "--branches", "--remotes"}
	} else {
		args = []string{"rev-list", "--count", "refs/heads/" + branch, "--not", "--exclude=" + branch, "--branches", "--remotes"}
	}
	out, err := gitAt(dir, args...)
	if err != nil {
		return 0, fmt.Errorf("count unmerged commits: %w", err)
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		return 0, fmt.Errorf("parse unmerged commit count: %w", err)
	}
	return n, nil
}

func CleanupWorktree(meta WorktreeMetadata) error {
	if _, statErr := os.Stat(meta.WorktreeRoot); os.IsNotExist(statErr) {
		// The directory is gone but the branch may still hold unpushed work.
		n, err := UnmergedCommits(meta.SourceRepo, meta.Branch)
		if err != nil {
			return err
		}
		if n > 0 {
			return &WorktreePreservedError{WorktreeRoot: meta.WorktreeRoot, Branch: meta.Branch}
		}
		return RollbackWorktree(meta)
	}
	out, err := gitAt(meta.WorktreeRoot, "status", "--ignored", "--untracked-files=all", "--porcelain")
	if err != nil {
		return fmt.Errorf("check worktree status: %w", err)
	}
	if strings.TrimSpace(string(out)) != "" {
		return &WorktreePreservedError{WorktreeRoot: meta.WorktreeRoot, Branch: meta.Branch}
	}
	// A clean worktree can still carry commits that live nowhere else; preserve
	// both the directory and the branch so the work is not lost.
	n, err := UnmergedCommits(meta.SourceRepo, meta.Branch)
	if err != nil {
		return err
	}
	if n > 0 {
		return &WorktreePreservedError{WorktreeRoot: meta.WorktreeRoot, Branch: meta.Branch}
	}
	if _, err := gitAt(meta.SourceRepo, "worktree", "remove", meta.WorktreeRoot); err != nil && !isMissingWorktreeError(err) {
		return fmt.Errorf("remove worktree: %w", err)
	}
	if _, err := gitAt(meta.SourceRepo, "branch", "-D", meta.Branch); err != nil && !isMissingBranchError(err) {
		return fmt.Errorf("remove branch: %w", err)
	}
	_ = os.Remove(filepath.Dir(meta.WorktreeRoot))
	return nil
}

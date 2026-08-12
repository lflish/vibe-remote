package session

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
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

func gitAt(dir string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return out, fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return out, nil
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

func CleanupWorktree(meta WorktreeMetadata) error {
	if _, statErr := os.Stat(meta.WorktreeRoot); os.IsNotExist(statErr) {
		return RollbackWorktree(meta)
	}
	out, err := gitAt(meta.WorktreeRoot, "status", "--ignored", "--untracked-files=all", "--porcelain")
	if err != nil {
		return fmt.Errorf("check worktree status: %w", err)
	}
	if strings.TrimSpace(string(out)) != "" {
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

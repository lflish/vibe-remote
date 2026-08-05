package session

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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

func CreateWorktree(sourceWorkdir, sessionID string) (WorktreeMetadata, string, error) {
	sourceAbs, err := filepath.Abs(sourceWorkdir)
	if err != nil {
		return WorktreeMetadata{}, "", fmt.Errorf("resolve source workdir: %w", err)
	}
	out, err := gitAt(sourceAbs, "rev-parse", "--show-toplevel")
	if err != nil {
		return WorktreeMetadata{}, "", fmt.Errorf("discover repository: %w", err)
	}
	repoRoot, err := filepath.Abs(strings.TrimSpace(string(out)))
	if err != nil {
		return WorktreeMetadata{}, "", fmt.Errorf("resolve repository root: %w", err)
	}
	// Git may canonicalize a symlinked system path (for example /var to
	// /private/var on macOS), while filepath.Abs preserves the caller's spelling.
	// Compare canonical paths, but retain the caller-visible source path in metadata.
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
	// Use the caller's path spelling for metadata and generated sibling paths.
	// Walking up by the canonical relative depth avoids mixing /private/var and
	// /var on macOS while preserving SourceWorkdir exactly as resolved by Abs.
	sourceRepo := sourceAbs
	if rel != "." {
		for range strings.Split(rel, string(filepath.Separator)) {
			sourceRepo = filepath.Dir(sourceRepo)
		}
	}
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
	}
	return meta, mapped, nil
}

func RollbackWorktree(meta WorktreeMetadata) error {
	if _, err := gitAt(meta.SourceRepo, "worktree", "remove", "--force", meta.WorktreeRoot); err != nil {
		// A missing path is already rolled back, but Git may retain stale metadata
		// after an external filesystem removal. Prune that metadata before deleting
		// the branch.
		if _, pruneErr := gitAt(meta.SourceRepo, "worktree", "prune"); pruneErr != nil {
			return fmt.Errorf("rollback worktree: %w", err)
		}
	}
	if _, err := gitAt(meta.SourceRepo, "branch", "-D", meta.Branch); err != nil {
		// Missing branch means rollback was already completed. Do not broadly
		// swallow other "error: branch" failures (for example a branch still in use).
		message := err.Error()
		if strings.Contains(message, "branch '") && strings.Contains(message, "not found") {
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
	out, err := gitAt(meta.WorktreeRoot, "status", "--porcelain")
	if err != nil {
		return fmt.Errorf("check worktree status: %w", err)
	}
	if strings.TrimSpace(string(out)) != "" {
		return &WorktreePreservedError{WorktreeRoot: meta.WorktreeRoot, Branch: meta.Branch}
	}
	if _, err := gitAt(meta.SourceRepo, "worktree", "remove", meta.WorktreeRoot); err != nil {
		return fmt.Errorf("remove worktree: %w", err)
	}
	if _, err := gitAt(meta.SourceRepo, "branch", "-D", meta.Branch); err != nil {
		return fmt.Errorf("remove branch: %w", err)
	}
	_ = os.Remove(filepath.Dir(meta.WorktreeRoot))
	return nil
}

package session

import "github.com/lflish/vibe-remote/vibe-remoted/internal/chat"

// ChatTrust reports whether a chat session may start in dir, a canonical path
// (design 7.3, spec H7). `claude -p` does not ask about workspace trust and
// runs the hooks in the directory's .claude/settings.json, so this is a
// security boundary: anything not positively established is untrusted.
//
// A directory passes in exactly two ways:
//
//  1. claude trusts the directory itself (chat.WorkdirTrusted).
//  2. It is the root of a linked worktree of a repository whose main directory
//     — that one path, not a parent, a child or another worktree — claude
//     trusts.
//
// Whether dir is such a root is decided only by the repository's own worktree
// list, which git builds from the back-pointers under the main directory's
// .git/worktrees. Nothing inside dir is believed: a .git file that names a
// trusted repository makes `git rev-parse --git-common-dir` answer with that
// repository (design V4), but it does not put dir on that repository's list.
// The list is read twice: from dir, to find the candidate main directory, and,
// once that directory is known to be trusted, again from the main directory
// itself. dir has to be on both.
//
// Not covered by rule 2, so only rule 1 applies: the main directory, any
// directory inside a worktree, worktrees of a bare repository, and worktrees of
// a submodule or a --separate-git-dir repository (their list starts with the
// git directory, not a main directory, V11).
//
// A missing or unreadable trust file is TrustUnknown, as before, and git is
// not run. Only hasTrustDialogAccepted is read; nothing is written.
func ChatTrust(dir string) chat.TrustState {
	if self := chat.WorkdirTrusted(dir); self != chat.TrustUntrusted {
		return self
	}
	main, ok := mainOfListedWorktree(dir, dir)
	if !ok || chat.WorkdirTrusted(main) != chat.TrustTrusted {
		return chat.TrustUntrusted
	}
	if again, ok := mainOfListedWorktree(main, dir); !ok || again != main {
		return chat.TrustUntrusted
	}
	return chat.TrustTrusted
}

// mainOfListedWorktree runs `git worktree list` in from and returns the main
// directory of that repository if dir is listed there as a linked worktree:
// an entry after the first, not prunable, whose path is exactly dir. It reports
// false when git fails, when the first entry is a bare repository or is not a
// main directory (no .git under it), and when dir is the main directory.
func mainOfListedWorktree(from, dir string) (string, bool) {
	wts, err := ListWorktrees(from)
	if err != nil || len(wts) == 0 {
		return "", false
	}
	main := wts[0]
	if main.Bare || !hasDotGit(main.Path) || dir == main.Path {
		return "", false
	}
	for _, wt := range wts[1:] {
		if wt.Path == dir && !wt.Prunable {
			return main.Path, true
		}
	}
	return "", false
}

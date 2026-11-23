package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/session"
)

// Regression tests for the findings of the code review of the project and
// worktree change (docs/changes/2026-11-16-project-worktrees, review of
// e278f87).

func (e *wtEnv) removeBody(body string) *httptest.ResponseRecorder {
	e.t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/worktrees/remove", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()
	e.s.mux.ServeHTTP(w, req)
	return w
}

// A removal request says what the user saw: path, head and sessions are
// required. Leaving one out is a malformed request (400), not "the user saw no
// sessions" — which, for a worktree without sessions, used to go through.
func TestWorktreeRemoveRequiresConfirmedFields(t *testing.T) {
	e := newWtEnv(t, 0)
	head := serverGitOut(t, e.root, "rev-parse", "HEAD")
	q := func(s string) string { return `"` + s + `"` }
	for label, body := range map[string]string{
		"no sessions":   `{"path":` + q(e.root) + `,"head":` + q(head) + `}`,
		"null sessions": `{"path":` + q(e.root) + `,"head":` + q(head) + `,"sessions":null}`,
		"no head":       `{"path":` + q(e.root) + `,"sessions":[]}`,
		"empty head":    `{"path":` + q(e.root) + `,"head":"","sessions":[]}`,
		"no path":       `{"head":` + q(head) + `,"sessions":[]}`,
	} {
		f := decodeFailure(t, e.removeBody(body), http.StatusBadRequest, "invalid_request")
		if f.Message == "" {
			t.Fatalf("%s: no message saying which field is missing", label)
		}
		if !pathExists(e.root) || !branchExists(t, e.repo, "fix-login") {
			t.Fatalf("%s: the malformed request removed something", label)
		}
	}
	// The same request with every required field is carried out.
	w := e.removeBody(`{"path":` + q(e.root) + `,"head":` + q(head) + `,"sessions":[]}`)
	if w.Code != http.StatusOK || pathExists(e.root) {
		t.Fatalf("complete request: status = %d: %s", w.Code, w.Body.String())
	}
}

// The body limit holds for the whole body, and the body is one JSON object:
// a valid request followed by anything else is not acted on.
func TestWorktreeRemoveBodyLimitAndTrailingData(t *testing.T) {
	e := newWtEnv(t, 0)
	head := serverGitOut(t, e.root, "rev-parse", "HEAD")
	valid := `{"path":"` + e.root + `","head":"` + head + `","sessions":[]}`
	untouched := func(label string) {
		t.Helper()
		if !pathExists(e.root) || !branchExists(t, e.repo, "fix-login") {
			t.Fatalf("%s: the worktree was removed", label)
		}
	}

	w := e.removeBody(valid + strings.Repeat(" ", maxRESTBody))
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("valid object + %d bytes of padding: status = %d, want 413: %s", maxRESTBody, w.Code, w.Body.String())
	}
	untouched("oversized body")

	w = e.removeBody(valid + valid)
	decodeFailure(t, w, http.StatusBadRequest, "invalid_request")
	untouched("two objects")

	w = e.removeBody(valid + " trailing")
	decodeFailure(t, w, http.StatusBadRequest, "invalid_request")
	untouched("trailing text")

	// Trailing whitespace within the limit is still one object.
	w = e.removeBody(valid + "\n  \n")
	if w.Code != http.StatusOK || pathExists(e.root) {
		t.Fatalf("valid object + newline: status = %d: %s", w.Code, w.Body.String())
	}
}

// A worktreeName the local rules refuse (it starts with "-", is too long, …)
// is refused before any git process is started, on both ways of creating a
// session; so a git that fails or hangs cannot turn the refusal into another
// error.
func TestAttachRefusesBadWorktreeNameBeforeAnyGit(t *testing.T) {
	names := []string{"-x", "--upload-pack=x", "a b", "@{-1}", "a\u200bb", strings.Repeat("x", 251)}
	for _, tc := range []struct {
		label string
		ui    string
		opts  []chatServerOpt
	}{
		{"terminal", "", []chatServerOpt{withClaudeCmd("/bin/cat")}},
		{"chat", protocol.UIChat, nil},
	} {
		t.Run(tc.label, func(t *testing.T) {
			c := newChatServer(t, tc.opts...)
			c.mgr.SetProjectStore(session.NewMemoryProjectStore())
			// A worktree of a repository claude trusts: the chat trust check has
			// to ask git about it, so git would run before the name is looked at.
			repo := c.repo("devflow")
			source := filepath.Join(c.root, "devflow-src")
			serverGit(t, repo, "worktree", "add", "-b", "src", source, "HEAD")
			log := filepath.Join(t.TempDir(), "git-calls.log")
			gitWrapper(t, `echo "$*" >> '`+log+`'`)
			for _, name := range names {
				e := expectAttachError(t, c.connect(), protocol.AttachFrame{NewSessionID: newSID("wtn"), UI: tc.ui, Workdir: source,
					Mode: protocol.SessionModeWorktree, WorktreeName: name})
				if e.Code != protocol.ErrCodeInvalidWorktreeName || !e.Fatal {
					t.Errorf("worktreeName %q: %+v, want fatal invalid_worktree_name", name, e)
				}
			}
			if data, err := os.ReadFile(log); err == nil {
				t.Fatalf("git was run for names the local rules refuse:\n%s", data)
			}
			// The same attach with a usable name does run git and succeeds: the
			// log above was empty because of the names, not the setup.
			ok := protocol.AttachFrame{NewSessionID: newSID("wtn"), UI: tc.ui, Workdir: source, Mode: protocol.SessionModeWorktree, WorktreeName: "fine"}
			if tc.ui == protocol.UIChat {
				c.attachChat(c.connect(), ok)
			} else {
				c.attachTerminal(c.connect(), ok)
			}
			if _, err := os.ReadFile(log); err != nil {
				t.Fatal("the control attach ran no git: the check above proves nothing")
			}
		})
	}

	t.Run("git_failure_does_not_mask_it", func(t *testing.T) {
		c := newChatServer(t, withClaudeCmd("/bin/cat"))
		repo := c.repo("devflow")
		gitWrapper(t, `echo "fatal: simulated" >&2; exit 128`)
		e := expectAttachError(t, c.connect(), protocol.AttachFrame{NewSessionID: newSID("wtn"), Workdir: repo,
			Mode: protocol.SessionModeWorktree, WorktreeName: "-x"})
		if e.Code != protocol.ErrCodeInvalidWorktreeName || !e.Fatal {
			t.Fatalf("%+v, want fatal invalid_worktree_name although git fails", e)
		}
	})
}

// workdir has to be a directory: a file is a malformed request, not a git
// failure.
func TestPlanWorktreeWorkdirIsAFile(t *testing.T) {
	f := newPlanFixture(t)
	w := getPlanRaw(t, f.s, filepath.Join(f.repo, "README"), "fix-login")
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"invalid_request"`) {
		t.Fatalf("status = %d: %s; want 400 invalid_request", w.Code, w.Body.String())
	}
}

// What the desktop relies on in the answers it gets (the two ends were changed
// separately after the review; these hold them together over HTTP).

// A removal whose branch is no longer the one the confirmation showed is a
// 409 that carries the current status: the desktop reopens its confirmation
// from that object, and without it only reports a failure.
func TestWorktreeRemoveBranchMismatchCarriesStatus(t *testing.T) {
	e := newWtEnv(t, 1)
	st := e.status(e.root)
	if st.Branch != "fix-login" || !st.Managed {
		t.Fatalf("status = %+v, want managed on fix-login", st)
	}
	serverGit(t, e.root, "switch", "-c", "other") // HEAD does not move

	// Exactly what the desktop sends for the confirmation it showed.
	body := `{"path":"` + st.Path + `","head":"` + st.Head + `","sessions":["` + e.ids[0] + `"],"branch":"fix-login","deleteBranch":true}`
	w := e.removeBody(body)
	f := decodeFailure(t, w, http.StatusConflict, "worktree_changed")
	if f.Status == nil || f.Status.Path != e.root || f.Status.Branch != "other" || f.Status.Head != st.Head || f.Status.Managed {
		t.Fatalf("status in the body = %+v, want the current state: on other, not managed", f.Status)
	}
	if len(f.Status.Sessions) != 1 || f.Status.Sessions[0] != e.ids[0] {
		t.Fatalf("status.sessions = %v, want the session that is still running", f.Status.Sessions)
	}
	if f.EndedSessions == nil || len(*f.EndedSessions) != 0 {
		t.Fatalf("endedSessions = %v, want []", f.EndedSessions)
	}
	if !e.sessionListed(e.ids[0]) || !pathExists(e.root) || !branchExists(t, e.repo, "fix-login") || !branchExists(t, e.repo, "other") {
		t.Fatal("the refused removal ended the session or removed something")
	}

	// Without deleteBranch the named branch alone is enough to refuse.
	w = e.removeBody(`{"path":"` + st.Path + `","head":"` + st.Head + `","sessions":["` + e.ids[0] + `"],"branch":"fix-login"}`)
	if f := decodeFailure(t, w, http.StatusConflict, "worktree_changed"); f.Status == nil || f.Status.Branch != "other" {
		t.Fatalf("status in the body = %+v", f.Status)
	}
	// A status with no sessions lists them as [], never null.
	if err := e.mgr.Delete(e.ids[0]); err != nil {
		t.Fatal(err)
	}
	w = e.removeBody(`{"path":"` + st.Path + `","head":"` + st.Head + `","sessions":[],"branch":"fix-login"}`)
	decodeFailure(t, w, http.StatusConflict, "worktree_changed")
	if !strings.Contains(w.Body.String(), `"sessions":[]`) || !strings.Contains(w.Body.String(), `"endedSessions":[]`) {
		t.Fatalf("the 409 body does not spell the empty lists as []: %s", w.Body.String())
	}
	// Confirmed again with what the 409 reported, as the desktop does: the
	// directory goes, both branches stay.
	w = e.removeBody(`{"path":"` + st.Path + `","head":"` + st.Head + `","sessions":[],"branch":"other"}`)
	if w.Code != http.StatusOK || pathExists(e.root) || !branchExists(t, e.repo, "fix-login") || !branchExists(t, e.repo, "other") {
		t.Fatalf("re-confirmed removal: status = %d: %s", w.Code, w.Body.String())
	}
}

// The project list is always an array: a daemon with nothing to show answers
// "projects":[] (the desktop treats anything else as a failed request).
func TestProjectsEmptyListIsAnArray(t *testing.T) {
	s := projServer(t, projMgr(t), t.TempDir())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	req.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, req)
	if got := strings.TrimSpace(w.Body.String()); w.Code != http.StatusOK || got != `{"proto":4,"projects":[]}` {
		t.Fatalf("status = %d, body = %s; want {\"proto\":4,\"projects\":[]}", w.Code, got)
	}
}

// A worktree whose branch has no commit yet: the status carries an all-zero
// head, and the request the desktop makes of it (that head, and the branch
// shown) is carried out.
func TestWorktreeRemoveUnbornBranchAsTheDesktopSendsIt(t *testing.T) {
	e := newWtEnv(t, 0)
	path := filepath.Join(e.base, "unborn-wt")
	if out, err := exec.Command("git", "-C", e.repo, "worktree", "add", "--orphan", "-b", "unborn", path).CombinedOutput(); err != nil {
		t.Skipf("this git cannot add a worktree on an unborn branch: %v: %s", err, out)
	}
	st := e.status(path)
	if st.Branch != "unborn" || strings.Trim(st.Head, "0") != "" || len(st.Head) < 40 || st.Managed || st.UnmergedCommits != 0 || st.DirtyFiles != 0 {
		t.Fatalf("status = %+v, want branch unborn with an all-zero head and nothing to lose", st)
	}
	w := e.removeBody(`{"path":"` + st.Path + `","head":"` + st.Head + `","sessions":[],"branch":"unborn"}`)
	if w.Code != http.StatusOK || pathExists(path) {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	if got := strings.TrimSpace(w.Body.String()); got != `{"removed":true,"branchDeleted":false,"endedSessions":[]}` {
		t.Fatalf("body = %s", got)
	}
}

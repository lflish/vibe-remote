package server

import (
	"net/http"
	"net/http/httptest"
	"os"
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

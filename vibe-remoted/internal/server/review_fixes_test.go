package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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

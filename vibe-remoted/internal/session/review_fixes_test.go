package session

import (
	"path/filepath"
	"reflect"
	"testing"
)

// Regression tests for the findings of the code review of the project and
// worktree change (docs/changes/2026-11-16-project-worktrees, review of
// e278f87).

// A session whose directory is inside the worktree loses it with the worktree,
// whatever it is attributed to: here its workdir is a repository of its own in
// an ignored directory, so its project and home are that repository.
func TestRemoveEndsSessionsAttributedElsewhere(t *testing.T) {
	f := newRemoveFixture(t, 0)
	nested := repoAt(t, filepath.Join(f.root, "vendor", "lib"))
	id := f.addSession(nested)
	r, _ := f.m.Get(id)
	if _, home := r.Home(); home != nested {
		t.Fatalf("home = %q, want the nested repository %q (the case under test)", home, nested)
	}

	st := f.status()
	if !reflect.DeepEqual(st.Sessions, []string{id}) {
		t.Fatalf("status.sessions = %v, want the session whose workdir is inside the worktree (%s)", st.Sessions, id)
	}

	// Not confirmed: refused, and the session keeps running.
	unconfirmed := request(st)
	unconfirmed.Sessions = []string{}
	_, err := f.remove(unconfirmed)
	if changed := wantChanged(t, err); !reflect.DeepEqual(changed.Status.Sessions, []string{id}) || len(changed.EndedSessions) != 0 {
		t.Fatalf("changed = %+v", changed)
	}
	if !f.alive(id) {
		t.Fatal("the session was ended by a refused removal")
	}
	f.intact()

	req := request(st)
	req.DeleteBranch = true
	res := f.mustRemove(req)
	if !reflect.DeepEqual(res.EndedSessions, []string{id}) {
		t.Fatalf("endedSessions = %v, want [%s]", res.EndedSessions, id)
	}
	if _, ok := f.m.Get(id); ok {
		t.Fatal("the session is still registered after its directory was removed")
	}
}

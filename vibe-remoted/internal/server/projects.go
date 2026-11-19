package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/session"
)

// handleProjects serves GET /api/v1/projects (design 4.2).
func (s *Server) handleProjects(w http.ResponseWriter, r *http.Request) {
	if !s.checkToken(r, w) {
		return
	}
	projects := s.mgr.Projects(session.AllowFunc(s.cfg.ResolveAllowedWorkdir))
	writeJSON(w, http.StatusOK, protocol.ProjectsResponse{Proto: protocol.Version, Projects: projects})
}

// handleRemoveProject serves POST /api/v1/projects/remove (design 4.3).
func (s *Server) handleRemoveProject(w http.ResponseWriter, r *http.Request) {
	if !s.checkToken(r, w) {
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, maxRESTBody))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	if err := json.Unmarshal(data, &body); err != nil || body.ID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	switch err := s.mgr.RemoveProject(body.ID); {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, session.ErrProjectNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "project_not_found"})
	case errors.Is(err, session.ErrProjectHasSessions):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "project_has_sessions"})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
}

// handleWorktreePlan serves GET /api/v1/worktrees/plan (design 4.4): the
// read-only pre-check the new-worktree dialog runs while the user types.
func (s *Server) handleWorktreePlan(w http.ResponseWriter, r *http.Request) {
	if !s.checkToken(r, w) {
		return
	}
	workdir := r.URL.Query().Get("workdir")
	if workdir == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request", "message": "workdir is required"})
		return
	}
	canonical, err := s.cfg.ResolveAllowedWorkdir(workdir)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "path not in allowed roots"})
		return
	}
	plan, err := s.mgr.PlanWorktree(canonical, r.URL.Query().Get("name"), func(path string) error {
		_, err := s.cfg.ResolveAllowedNewPath(path)
		return err
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "git_failed", "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, plan)
}

// handleWorktreeStatus serves GET /api/v1/worktrees/status (design 4.5): the
// numbers the delete confirmation shows.
func (s *Server) handleWorktreeStatus(w http.ResponseWriter, r *http.Request) {
	if !s.checkToken(r, w) {
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request", "message": "path is required"})
		return
	}
	status, err := s.mgr.WorktreeStatus(path, session.AllowFunc(s.cfg.ResolveAllowedWorkdir))
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, status)
	case errors.Is(err, session.ErrWorktreeNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "worktree_not_found", "message": "not a worktree this daemon can see"})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "git_failed", "message": err.Error()})
	}
}

// handleWorktreeRemove serves POST /api/v1/worktrees/remove (design 4.6). The
// removal is not tied to the request: when the client gives up waiting, it is
// still carried through, since stopping half-way would be worse.
func (s *Server) handleWorktreeRemove(w http.ResponseWriter, r *http.Request) {
	if !s.checkToken(r, w) {
		return
	}
	var req protocol.WorktreeRemoveRequest
	if status, err := decodeJSONBody(w, r, &req); err != nil {
		writeJSON(w, status, map[string]string{"error": "invalid_request", "message": err.Error()})
		return
	}
	// What the user saw is not optional. A missing or null sessions is not an
	// empty list: it would read as "saw no sessions" without anyone having said
	// so.
	missing := ""
	switch {
	case req.Path == "":
		missing = "path"
	case req.Head == "":
		missing = "head"
	case req.Sessions == nil:
		missing = "sessions"
	}
	if missing != "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request", "message": missing + " is required"})
		return
	}
	result, err := s.mgr.RemoveWorktree(req, session.AllowFunc(s.cfg.ResolveAllowedWorkdir))
	var changed *session.WorktreeChangedError
	var failed *session.WorktreeRemoveError
	switch {
	case err == nil:
		result.EndedSessions = orEmpty(result.EndedSessions)
		writeJSON(w, http.StatusOK, result)
	case errors.Is(err, session.ErrWorktreeIsMain):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "worktree_is_main", "message": err.Error()})
	case errors.Is(err, session.ErrWorktreeNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "worktree_not_found", "message": "not a worktree this daemon can see"})
	case errors.As(err, &changed):
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "worktree_changed", "message": "the worktree is no longer in the state that was confirmed",
			"status": changed.Status, "endedSessions": orEmpty(changed.EndedSessions),
		})
	case errors.As(err, &failed):
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": "worktree_remove_failed", "message": failed.Message, "endedSessions": orEmpty(failed.EndedSessions),
		})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "git_failed", "message": err.Error(), "endedSessions": []string{}})
	}
}

// orEmpty makes a nil list serialize as [] rather than null.
func orEmpty(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}

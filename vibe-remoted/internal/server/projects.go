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

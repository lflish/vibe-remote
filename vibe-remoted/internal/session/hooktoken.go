package session

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
)

// HookToken derives the per-session credential injected into a session's
// environment as VIBE_REMOTE_TOKEN.
//
// Everything the CLI spawns (hooks, but also any tool or dependency the model
// runs) can read that variable, so it must not be the main token, which grants
// full shell access through attach. The server accepts the derived token only on
// POST /api/v1/events and only for its own sessionId, so a leak lets the holder
// post notifications for one session and nothing more. Keying the HMAC with the
// main token means rotating the main token revokes every hook token, and the
// daemon can verify one without storing anything per session.
func HookToken(mainToken, sessionID string) string {
	mac := hmac.New(sha256.New, []byte(mainToken))
	mac.Write([]byte("events:" + sessionID))
	return hex.EncodeToString(mac.Sum(nil))
}

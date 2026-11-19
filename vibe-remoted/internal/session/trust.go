package session

import "github.com/lflish/vibe-remote/vibe-remoted/internal/chat"

// ChatTrust reports whether a chat session may start in dir (design 7.3).
func ChatTrust(dir string) chat.TrustState {
	return chat.WorkdirTrusted(dir)
}

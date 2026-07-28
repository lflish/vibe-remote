package session

// Manager 只持有配置字段，供 NewHeadless 构造 HeadlessRunner。
// TUI 线（tmux/PTY sessions map/pub-sub）已删除。
type Manager struct {
	claudeCmd  string
	loginShell bool
	shell      string
	eventsURL  string
	token      string
}

// NewManager creates a session manager.
func NewManager(claudeCmd string, loginShell bool, shell string) *Manager {
	return &Manager{
		claudeCmd:  claudeCmd,
		loginShell: loginShell,
		shell:      shell,
	}
}

// SetEventEnv configures the events endpoint URL and token injected into new
// headless sessions' environment (for hook-based out-of-band reporting). Called
// once at startup after the bind address/port/token are known.
func (m *Manager) SetEventEnv(eventsURL, token string) {
	m.eventsURL = eventsURL
	m.token = token
}

// NewHeadless builds a HeadlessRunner for the given workdir using the manager's
// configured claude command, login-shell settings, and events environment. It
// does not register anything — headless turns are stateless (continuity is
// claude's own -c over the shared jsonl), so there is nothing to track between
// turns.
func (m *Manager) NewHeadless(workdir string) *HeadlessRunner {
	var env []string
	if m.eventsURL != "" {
		env = append(env, "VIBE_REMOTE_EVENTS_URL="+m.eventsURL)
	}
	if m.token != "" {
		env = append(env, "VIBE_REMOTE_TOKEN="+m.token)
	}
	return NewHeadlessRunner(workdir, m.claudeCmd, m.loginShell, m.shell, env)
}

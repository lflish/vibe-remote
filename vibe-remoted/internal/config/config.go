// Package config handles loading and validating vibe-remoted configuration.
package config

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
)

// Config holds the daemon configuration.
type Config struct {
	// Bind address — must be a tailscale interface IP, never 0.0.0.0.
	BindAddr string `json:"bind_addr"`
	// Port to listen on.
	Port int `json:"port"`
	// Static auth token.
	Token string `json:"token"`
	// Default working directory for new sessions.
	DefaultWorkdir string `json:"default_workdir"`
	// Allowed root directories (workdir whitelist).
	AllowedRoots []string `json:"allowed_roots"`
	// Whether to use tmux for session persistence.
	UseTmux bool `json:"use_tmux"`
	// Claude command (default: "claude").
	ClaudeCmd string `json:"claude_cmd"`
	// Optional whitelist of selectable launch flags. When set, clients can
	// pick flags per-session (by id); the server appends each selected flag's
	// Arg to ClaudeCmd. Empty = feature off (ClaudeCmd used as-is).
	ClaudeFlags []ClaudeFlag `json:"claude_flags,omitempty"`
	// Launch claude through a login shell so the user's shell environment
	// (PATH, node version managers like fnm/nvm, etc.) is loaded — matching
	// what the user gets when running claude interactively. Default true.
	LoginShell *bool `json:"login_shell,omitempty"`
	// Shell to use for login-shell launch (default: $SHELL, else /bin/bash).
	Shell string `json:"shell,omitempty"`
	// Escape hatch: allow binding to a public (non-private) address. Off by
	// default so a misconfig can't silently expose the daemon to the internet.
	// Private-network addresses (RFC1918 / loopback / link-local / tailscale
	// CGNAT) are allowed without this. Wildcard addresses (0.0.0.0 / ::) are
	// always rejected, even with this set.
	AllowInsecureBind bool `json:"allow_insecure_bind,omitempty"`
}

// UseLoginShell reports whether claude should be launched via a login shell.
// Defaults to true when unset.
func (c *Config) UseLoginShell() bool {
	return c.LoginShell == nil || *c.LoginShell
}

// LoginShellPath returns the shell to use for login-shell launch.
func (c *Config) LoginShellPath() string {
	if c.Shell != "" {
		return c.Shell
	}
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh
	}
	return "/bin/bash"
}

// DefaultConfig returns a config with sensible defaults.
func DefaultConfig() *Config {
	home, _ := os.UserHomeDir()
	return &Config{
		BindAddr:       "100.64.0.1", // placeholder tailscale IP
		Port:           8765,
		Token:          "",
		DefaultWorkdir: home,
		AllowedRoots:   []string{home},
		UseTmux:        true,
		ClaudeCmd:      "claude",
	}
}

// Load reads a config file from the given path. Falls back to defaults for missing fields.
func Load(path string) (*Config, error) {
	cfg := DefaultConfig()

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil // use defaults if no config file
		}
		return nil, fmt.Errorf("read config: %w", err)
	}

	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	return cfg, nil
}

// Validate checks that the config is usable.
func (c *Config) Validate() error {
	if err := validateBindAddr(c.BindAddr, c.AllowInsecureBind); err != nil {
		return err
	}
	if c.Port <= 0 || c.Port > 65535 {
		return fmt.Errorf("port must be between 1 and 65535")
	}
	if c.Token == "" {
		return fmt.Errorf("token must not be empty")
	}
	if c.DefaultWorkdir == "" {
		return fmt.Errorf("default_workdir must not be empty")
	}
	// Verify default workdir exists
	if info, err := os.Stat(c.DefaultWorkdir); err != nil || !info.IsDir() {
		return fmt.Errorf("default_workdir %q is not an existing directory", c.DefaultWorkdir)
	}
	return nil
}

// validateBindAddr keeps token the primary access boundary while preventing an
// accidental public exposure. The security model still relies on the daemon not
// being reachable from the open internet (skipped WS Origin check, permissive
// CORS, plaintext ws://), so it allows any private-network address by default,
// rejects public addresses unless allowInsecure is set as an explicit escape
// hatch, and rejects empty and wildcard addresses outright.
func validateBindAddr(addr string, allowInsecure bool) error {
	if addr == "" {
		return fmt.Errorf("bind_addr must be set (to a private-network IP)")
	}
	ip := net.ParseIP(addr)
	if ip == nil {
		return fmt.Errorf("bind_addr %q is not a valid IP address", addr)
	}
	// Wildcards bind every interface — never allowed, even with the escape hatch.
	if ip.IsUnspecified() {
		return fmt.Errorf("bind_addr %q binds all interfaces; use a specific private-network IP", addr)
	}
	if allowInsecure {
		return nil
	}
	if !isPrivateBindIP(ip) {
		return fmt.Errorf("bind_addr %q is a public address; bind a private-network IP "+
			"(RFC1918 / loopback / link-local / tailscale 100.64.0.0/10), "+
			"or set allow_insecure_bind:true to bind a public address", addr)
	}
	return nil
}

// isPrivateBindIP reports whether ip is safe to bind without the insecure
// escape hatch: RFC1918 / IPv6 ULA (via net.IP.IsPrivate), loopback, and
// link-local, plus the tailscale CGNAT range 100.64.0.0/10 (which IsPrivate
// does NOT cover). tailscale's IPv6 ULA fd7a:115c:a1e0::/48 is already covered
// by IsPrivate (fc00::/7).
func isPrivateBindIP(ip net.IP) bool {
	if ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return true
	}
	if v4 := ip.To4(); v4 != nil { // tailscale CGNAT 100.64.0.0/10
		return v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127
	}
	return false
}

// IsAllowedWorkdir checks if a path falls within the allowed roots.
func (c *Config) IsAllowedWorkdir(dir string) bool {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return false
	}
	for _, root := range c.AllowedRoots {
		rootAbs, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(rootAbs, abs)
		if err != nil {
			continue
		}
		// rel == "." means dir IS the root (allowed).
		// A leading ".." component means dir escapes the root (rejected).
		// Check for exactly ".." or a "../" prefix — not just a ".." substring,
		// so a directory literally named "..foo" isn't wrongly rejected.
		if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		return true
	}
	return false
}

// ClaudeFlag is one selectable launch flag offered to clients. ID is the stable
// key the client sends back; Label is shown in the picker; Arg is the actual
// command-line fragment appended to ClaudeCmd; Default controls initial checked
// state in the client UI.
type ClaudeFlag struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Arg     string `json:"arg"`
	Default bool   `json:"default,omitempty"`
}

// ResolveClaudeCmd returns the full claude command for a new session: ClaudeCmd
// plus the Arg of every configured flag whose id is in ids. Flags are appended
// in ClaudeFlags declaration order (not the order ids arrives in), so ordering
// is server-controlled. Ids not present in ClaudeFlags are ignored — the client
// can only ever select from the whitelist, never inject arbitrary args.
func (c *Config) ResolveClaudeCmd(ids []string) string {
	if len(ids) == 0 || len(c.ClaudeFlags) == 0 {
		return c.ClaudeCmd
	}
	selected := make(map[string]int) // id -> count (allow dupes to append multiple times)
	for _, id := range ids {
		selected[id]++
	}
	cmd := c.ClaudeCmd
	for _, f := range c.ClaudeFlags {
		for n := 0; n < selected[f.ID]; n++ {
			cmd += " " + f.Arg
		}
	}
	return cmd
}

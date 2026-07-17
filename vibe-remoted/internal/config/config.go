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
	// Launch claude through a login shell so the user's shell environment
	// (PATH, node version managers like fnm/nvm, etc.) is loaded — matching
	// what the user gets when running claude interactively. Default true.
	LoginShell *bool `json:"login_shell,omitempty"`
	// Shell to use for login-shell launch (default: $SHELL, else /bin/bash).
	Shell string `json:"shell,omitempty"`
	// Escape hatch: allow binding to a non-tailscale address (LAN IP, etc.).
	// Off by default so a misconfig can't silently expose the daemon beyond
	// the tailnet. Wildcard addresses (0.0.0.0 / ::) are always rejected.
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

// validateBindAddr enforces the tailnet-only assumption the rest of the
// security model rests on (skipped WS Origin check, permissive CORS). It
// rejects empty and wildcard addresses outright, and non-tailscale addresses
// unless allowInsecure is set as an explicit escape hatch.
func validateBindAddr(addr string, allowInsecure bool) error {
	if addr == "" {
		return fmt.Errorf("bind_addr must be set (to a tailscale IP)")
	}
	ip := net.ParseIP(addr)
	if ip == nil {
		return fmt.Errorf("bind_addr %q is not a valid IP address", addr)
	}
	// Wildcards bind every interface — never allowed, even with the escape hatch.
	if ip.IsUnspecified() {
		return fmt.Errorf("bind_addr %q binds all interfaces; use a specific tailscale IP", addr)
	}
	if allowInsecure {
		return nil
	}
	if !isTailscaleIP(ip) {
		return fmt.Errorf("bind_addr %q is not a tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48); "+
			"set allow_insecure_bind:true to override", addr)
	}
	return nil
}

// isTailscaleIP reports whether ip is in the tailscale CGNAT v4 range
// (100.64.0.0/10) or the tailscale ULA v6 range (fd7a:115c:a1e0::/48).
func isTailscaleIP(ip net.IP) bool {
	if v4 := ip.To4(); v4 != nil {
		return v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127
	}
	tsULA := net.IP{0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0}
	return len(ip) == net.IPv6len && ip[0] == tsULA[0] && ip[1] == tsULA[1] &&
		ip[2] == tsULA[2] && ip[3] == tsULA[3] && ip[4] == tsULA[4] && ip[5] == tsULA[5]
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

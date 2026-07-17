// Package config handles loading and validating ccdeskd configuration.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
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
	if c.BindAddr == "" || c.BindAddr == "0.0.0.0" {
		return fmt.Errorf("bind_addr must be a specific tailscale IP, not empty or 0.0.0.0")
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
		// Must not escape the root (no leading "..")
		if len(rel) >= 2 && rel[:2] == ".." {
			continue
		}
		if rel == ".." {
			continue
		}
		return true
	}
	return false
}

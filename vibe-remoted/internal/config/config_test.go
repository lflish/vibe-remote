package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIsAllowedWorkdir(t *testing.T) {
	cfg := &Config{
		AllowedRoots: []string{"/home/user", "/srv/projects"},
	}

	tests := []struct {
		name string
		dir  string
		want bool
	}{
		// Allowed: the root itself and subdirectories
		{"root itself", "/home/user", true},
		{"direct child", "/home/user/project", true},
		{"nested child", "/home/user/a/b/c", true},
		{"second root", "/srv/projects", true},
		{"second root child", "/srv/projects/foo", true},

		// Rejected: outside all roots
		{"sibling of root", "/home/other", false},
		{"parent of root", "/home", false},
		{"unrelated", "/etc", false},
		{"root fs", "/", false},

		// Path traversal attempts
		{"traversal escape", "/home/user/../other", false},
		{"traversal to etc", "/home/user/../../etc", false},
		{"deep traversal", "/srv/projects/../../etc/passwd", false},

		// Edge case: directory literally named "..foo" under root is fine
		{"dotdot-prefix dir name", "/home/user/..foo", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := cfg.IsAllowedWorkdir(tt.dir)
			if got != tt.want {
				t.Errorf("IsAllowedWorkdir(%q) = %v, want %v", tt.dir, got, tt.want)
			}
		})
	}
}

func TestIsAllowedWorkdirRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "alias")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	cfg := &Config{AllowedRoots: []string{root}}
	if _, err := cfg.ResolveAllowedWorkdir(link); err == nil {
		t.Fatalf("ResolveAllowedWorkdir(%q) accepted symlink escaping allowed root", link)
	}
}

func TestIsAllowedWorkdirEmptyRoots(t *testing.T) {
	cfg := &Config{AllowedRoots: nil}
	if cfg.IsAllowedWorkdir("/anything") {
		t.Error("empty allowed roots should reject all paths")
	}
}

// validConfig returns a config that passes Validate; each case mutates one field.
func validConfig(t *testing.T) *Config {
	t.Helper()
	root := t.TempDir()
	return &Config{
		BindAddr: "100.64.0.1", Port: 8765, Token: "0123456789abcdef0123456789abcdef",
		DefaultWorkdir: root, AllowedRoots: []string{root}, ClaudeCmd: "claude",
	}
}

func TestValidate(t *testing.T) {
	tests := []struct {
		name    string
		mutate  func(c *Config)
		wantErr string // empty = valid
	}{
		{"valid", func(c *Config) {}, ""},
		{"bind 0.0.0.0 rejected", func(c *Config) { c.BindAddr = "0.0.0.0" }, "all interfaces"},
		{"empty bind rejected", func(c *Config) { c.BindAddr = "" }, "bind_addr"},
		{"empty token rejected", func(c *Config) { c.Token = "" }, "token"},
		{"bad port rejected", func(c *Config) { c.Port = 0 }, "port"},
		{"nonexistent workdir rejected", func(c *Config) { c.DefaultWorkdir = "/nonexistent/path/xyz" }, "default_workdir"},

		// Token policy: short tokens are rejected, 16–31 chars only warn (main).
		{"15-char token rejected", func(c *Config) { c.Token = strings.Repeat("a", 15) }, "at least 16"},
		{"16-char token accepted", func(c *Config) { c.Token = strings.Repeat("a", 16) }, ""},
		{"example placeholder rejected", func(c *Config) { c.Token = "change-me-to-a-secure-token" }, "placeholder"},

		{"no allowed roots rejected", func(c *Config) { c.AllowedRoots = nil }, "allowed_roots"},
		{"missing allowed root rejected", func(c *Config) {
			c.AllowedRoots = append(c.AllowedRoots, "/nonexistent/root/xyz")
		}, "/nonexistent/root/xyz"},
		{"default workdir outside roots rejected", func(c *Config) { c.DefaultWorkdir = os.TempDir() }, "not inside allowed_roots"},
		{"blank claude_cmd rejected", func(c *Config) { c.ClaudeCmd = "   " }, "claude_cmd"},
		{"flags valid", func(c *Config) {
			c.ClaudeFlags = []ClaudeFlag{{ID: "continue", Arg: "-c"}, {ID: "skip", Arg: "--x"}}
		}, ""},
		{"flag without id rejected", func(c *Config) { c.ClaudeFlags = []ClaudeFlag{{Arg: "-c"}} }, "id must not be empty"},
		{"flag without arg rejected", func(c *Config) { c.ClaudeFlags = []ClaudeFlag{{ID: "continue"}} }, "arg must not be empty"},
		{"duplicate flag id rejected", func(c *Config) {
			c.ClaudeFlags = []ClaudeFlag{{ID: "continue", Arg: "-c"}, {ID: "continue", Arg: "--continue"}}
		}, "duplicate id"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := validConfig(t)
			tt.mutate(cfg)
			err := cfg.Validate()
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("Validate() = %v, want nil", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("Validate() = %v, want error containing %q", err, tt.wantErr)
			}
		})
	}
}

func TestLoadRejectsUnknownFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cfg.json")
	if err := os.WriteFile(path, []byte(`{"token":"x","allowed_root":["/tmp"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "allowed_root") {
		t.Fatalf("Load() = %v, want unknown-field error naming allowed_root", err)
	}
}

func TestLoadRejectsTrailingData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cfg.json")
	if err := os.WriteFile(path, []byte(`{"port":1} {"port":2}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("Load() accepted trailing data after the config object")
	}
}

// A missing file still starts from defaults so env-only setups work.
func TestLoadMissingFileUsesDefaults(t *testing.T) {
	cfg, err := Load(filepath.Join(t.TempDir(), "absent.json"))
	if err != nil {
		t.Fatalf("Load(missing) = %v, want defaults", err)
	}
	if cfg.Port != DefaultConfig().Port || cfg.ClaudeCmd != "claude" {
		t.Fatalf("Load(missing) = %+v, want defaults", cfg)
	}
}

// The configs checked into the repo root must keep loading with the strict
// decoder, and the dev ones must keep validating (they are used by make
// targets and the local smoke flow). The example deliberately carries the
// placeholder token, so it only has to parse.
func TestTrackedConfigs(t *testing.T) {
	repoRoot := filepath.Join("..", "..", "..")
	for _, name := range []string{"vibe-remoted.local.json", "vibe-remoted.tmux.json"} {
		t.Run(name, func(t *testing.T) {
			cfg, err := Load(filepath.Join(repoRoot, name))
			if err != nil {
				t.Fatal(err)
			}
			if err := cfg.Validate(); err != nil {
				t.Fatalf("Validate() = %v", err)
			}
		})
	}
	t.Run("vibe-remoted.example.json", func(t *testing.T) {
		cfg, err := Load(filepath.Join(repoRoot, "vibe-remoted.example.json"))
		if err != nil {
			t.Fatal(err)
		}
		if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "placeholder") {
			t.Fatalf("Validate() = %v, want the placeholder token rejected", err)
		}
	})
}

func TestListenAddr(t *testing.T) {
	tests := []struct {
		bind string
		want string
	}{
		{"100.64.0.1", "100.64.0.1:8765"},
		{"fd7a::1", "[fd7a::1]:8765"},
		{"::1", "[::1]:8765"},
	}
	for _, tt := range tests {
		cfg := &Config{BindAddr: tt.bind, Port: 8765}
		if got := cfg.ListenAddr(); got != tt.want {
			t.Errorf("ListenAddr(%q) = %q, want %q", tt.bind, got, tt.want)
		}
	}
}

func TestValidateBindAddr(t *testing.T) {
	tests := []struct {
		name          string
		addr          string
		allowInsecure bool
		wantErr       bool
	}{
		{"tailscale v4", "100.64.0.1", false, false},
		{"tailscale v4 high", "100.127.255.254", false, false},
		{"tailscale v6 ULA", "fd7a:115c:a1e0::1", false, false},
		{"empty", "", false, true},
		{"ipv4 wildcard", "0.0.0.0", false, true},
		{"ipv6 wildcard", "::", false, true},
		{"ipv6 wildcard even with insecure", "::", true, true},
		{"ipv4 wildcard even with insecure", "0.0.0.0", true, true},
		{"lan 192.168 allowed", "192.168.1.10", false, false},
		{"lan 10.x allowed", "10.0.0.5", false, false},
		{"lan 172.16 allowed", "172.16.0.1", false, false},
		{"loopback allowed", "127.0.0.1", false, false},
		{"ipv6 loopback allowed", "::1", false, false},
		{"link-local allowed", "169.254.1.1", false, false},
		{"ipv6 ULA allowed", "fd00::1", false, false},
		{"public ip rejected", "8.8.8.8", false, true},
		{"public ip allowed with insecure", "8.8.8.8", true, false},
		{"100.x but below cgnat is public", "100.63.0.1", false, true},
		{"100.x above cgnat is public", "100.128.0.1", false, true},
		{"not an ip", "example.com", false, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateBindAddr(tt.addr, tt.allowInsecure)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateBindAddr(%q, %v) error = %v, wantErr %v", tt.addr, tt.allowInsecure, err, tt.wantErr)
			}
		})
	}
}

func TestResolveClaudeCmd(t *testing.T) {
	cfg := &Config{
		ClaudeCmd: "claude",
		ClaudeFlags: []ClaudeFlag{
			{ID: "continue", Label: "续会话", Arg: "-c", Default: false},
			{ID: "skip", Label: "跳过权限", Arg: "--dangerously-skip-permissions", Default: true},
			{ID: "model", Label: "opus", Arg: "--model opus", Default: false},
		},
	}
	tests := []struct {
		name string
		ids  []string
		want string
	}{
		{"no flags", nil, "claude"},
		{"empty slice", []string{}, "claude"},
		{"one flag", []string{"continue"}, "claude -c"},
		{"two flags keep declared order", []string{"model", "continue"}, "claude -c --model opus"},
		{"unknown id ignored", []string{"continue", "bogus"}, "claude -c"},
		{"all unknown falls back", []string{"nope"}, "claude"},
		{"duplicate id not deduped by us", []string{"continue", "continue"}, "claude -c -c"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := cfg.ResolveClaudeCmd(tt.ids)
			if got != tt.want {
				t.Errorf("ResolveClaudeCmd(%v) = %q, want %q", tt.ids, got, tt.want)
			}
		})
	}
}

func TestResolveClaudeCmdNoFlagsConfigured(t *testing.T) {
	cfg := &Config{ClaudeCmd: "claude -c"}
	if got := cfg.ResolveClaudeCmd([]string{"anything"}); got != "claude -c" {
		t.Errorf("with no ClaudeFlags configured, want unchanged %q, got %q", "claude -c", got)
	}
}

func TestResolveClaudeReloadCmd(t *testing.T) {
	tests := []struct {
		name string
		cfg  Config
		want string
	}{
		{
			name: "explicit override",
			cfg:  Config{ClaudeCmd: "claude", ClaudeReloadCmd: "codex resume --last"},
			want: "codex resume --last",
		},
		{
			name: "configured continue flag",
			cfg: Config{ClaudeCmd: "claude", ClaudeFlags: []ClaudeFlag{
				{ID: "continue", Arg: "--continue"},
			}},
			want: "claude --continue",
		},
		{
			name: "claude default",
			cfg:  Config{ClaudeCmd: "claude"},
			want: "claude -c",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.cfg.ResolveClaudeReloadCmd(); got != tt.want {
				t.Fatalf("ResolveClaudeReloadCmd() = %q, want %q", got, tt.want)
			}
		})
	}
}

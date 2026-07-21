package config

import "testing"

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

func TestIsAllowedWorkdirEmptyRoots(t *testing.T) {
	cfg := &Config{AllowedRoots: nil}
	if cfg.IsAllowedWorkdir("/anything") {
		t.Error("empty allowed roots should reject all paths")
	}
}

func TestValidate(t *testing.T) {
	tests := []struct {
		name    string
		cfg     *Config
		wantErr bool
	}{
		{
			name: "valid",
			cfg: &Config{
				BindAddr: "100.64.0.1", Port: 8765, Token: "secret",
				DefaultWorkdir: "/tmp",
			},
			wantErr: false,
		},
		{
			name: "bind 0.0.0.0 rejected",
			cfg: &Config{
				BindAddr: "0.0.0.0", Port: 8765, Token: "secret",
				DefaultWorkdir: "/tmp",
			},
			wantErr: true,
		},
		{
			name: "empty bind rejected",
			cfg: &Config{
				BindAddr: "", Port: 8765, Token: "secret",
				DefaultWorkdir: "/tmp",
			},
			wantErr: true,
		},
		{
			name: "empty token rejected",
			cfg: &Config{
				BindAddr: "100.64.0.1", Port: 8765, Token: "",
				DefaultWorkdir: "/tmp",
			},
			wantErr: true,
		},
		{
			name: "bad port rejected",
			cfg: &Config{
				BindAddr: "100.64.0.1", Port: 0, Token: "secret",
				DefaultWorkdir: "/tmp",
			},
			wantErr: true,
		},
		{
			name: "nonexistent workdir rejected",
			cfg: &Config{
				BindAddr: "100.64.0.1", Port: 8765, Token: "secret",
				DefaultWorkdir: "/nonexistent/path/xyz",
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.cfg.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
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

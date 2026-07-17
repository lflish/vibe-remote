package session

import (
	"strings"
	"testing"
)

func TestSanitizeSessionName(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"plain", "my session", "my session"},
		{"trim spaces", "  hi  ", "hi"},
		{"strip newline", "a\nb", "ab"},
		{"strip tab and cr", "a\tb\rc", "abc"},
		{"strip ansi esc", "a\x1b[31mb", "ab"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sanitizeSessionName(tt.in); got != tt.want {
				t.Errorf("sanitizeSessionName(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestSanitizeSessionNameTruncates(t *testing.T) {
	long := strings.Repeat("x", 300)
	got := sanitizeSessionName(long)
	if len(got) != 200 {
		t.Errorf("expected truncation to 200, got len %d", len(got))
	}
}

func TestDisplayTitleFallback(t *testing.T) {
	// No tmux available in unit test → readName returns "" → falls back.
	tests := []struct {
		name   string
		runner *Runner
		want   string
	}{
		{"workdir tail", &Runner{ID: "abc", Workdir: "/home/user/proj", useTmux: false}, "proj"},
		{"empty workdir falls to id", &Runner{ID: "abc", Workdir: "", useTmux: false}, "abc"},
		{"trailing slash", &Runner{ID: "abc", Workdir: "/home/user/proj/", useTmux: false}, "proj"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.runner.displayTitle(); got != tt.want {
				t.Errorf("displayTitle() = %q, want %q", got, tt.want)
			}
		})
	}
}

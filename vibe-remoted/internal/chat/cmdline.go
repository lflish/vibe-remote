// Package chat runs claude headless (stream-json) for chat-UI sessions: it
// parses the configured claude command, probes the claude version, finds
// transcripts, and supervises the process.
package chat

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// Parsed is claude_cmd (plus selected flags) split into words.
type Parsed struct {
	// Exe is the program, with a leading ~ already expanded.
	Exe string
	// Args are the user's arguments without -c/--continue (the daemon decides
	// which conversation to open) and never contain session-control flags.
	Args []string
	// Continue: the command asked for -c/--continue.
	Continue bool
	// Bypass: --dangerously-skip-permissions or --permission-mode bypassPermissions.
	Bypass bool
	// PermissionMode is the --permission-mode value, if any.
	PermissionMode string
}

// sessionControlArgs are flags the daemon sets itself for a chat process; a
// claude_cmd that already carries one cannot be driven headless.
var sessionControlArgs = map[string]bool{
	"-p": true, "--print": true, "--input-format": true, "--output-format": true,
	"--permission-prompt-tool": true, "--resume": true, "-r": true,
	"--session-id": true, "--fork-session": true,
}

// ParseClaudeCmd splits cmd by shell rules and checks it can run a chat
// session. reason is empty on success, otherwise one of
// protocol.ChatReasonShellSyntax, ChatReasonNotClaude, ChatReasonConflictingArgs.
func ParseClaudeCmd(cmd string) (Parsed, string) {
	words, ok := splitWords(cmd)
	if !ok {
		return Parsed{}, protocol.ChatReasonShellSyntax
	}
	if len(words) == 0 || filepath.Base(words[0]) != "claude" {
		return Parsed{}, protocol.ChatReasonNotClaude
	}
	p := Parsed{Exe: words[0]}
	for i := 1; i < len(words); i++ {
		w := words[i]
		name, value, hasValue := strings.Cut(w, "=")
		if !strings.HasPrefix(w, "--") {
			name, value, hasValue = w, "", false
		}
		if sessionControlArgs[name] {
			return Parsed{}, protocol.ChatReasonConflictingArgs
		}
		switch name {
		case "-c", "--continue":
			p.Continue = true
			continue
		case "--dangerously-skip-permissions":
			p.Bypass = true
		case "--permission-mode":
			if !hasValue && i+1 < len(words) {
				p.Args = append(p.Args, w)
				i++
				w = words[i]
				value = w
			}
			p.PermissionMode = value
			if value == "bypassPermissions" {
				p.Bypass = true
			}
		}
		p.Args = append(p.Args, w)
	}
	return p, ""
}

// streamJSONArgs are the constant arguments that turn claude into a headless
// stream-json peer whose permission prompts come back over stdio.
var streamJSONArgs = []string{
	"-p", "--input-format", "stream-json", "--output-format", "stream-json",
	"--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio",
}

// ChatArgv builds the argv of a chat process from the parsed configuration and
// daemon constants only. resume opens an existing transcript (--resume),
// otherwise the conversation id is fixed up front (--session-id).
func ChatArgv(p Parsed, claudeSessionID string, resume bool) []string {
	argv := make([]string, 0, 1+len(p.Args)+len(streamJSONArgs)+2)
	argv = append(argv, p.Exe)
	argv = append(argv, p.Args...)
	argv = append(argv, streamJSONArgs...)
	return append(argv, sessionArg(claudeSessionID, resume)...)
}

func sessionArg(u string, resume bool) []string {
	if resume {
		return []string{"--resume", u}
	}
	return []string{"--session-id", u}
}

// HandoffCommand is the terminal command that continues claude conversation u
// interactively: the user's arguments minus -c, plus --resume u (or
// --session-id u when no transcript exists yet), shell-quoted.
func HandoffCommand(exe string, args []string, u string, resume bool) string {
	argv := []string{exe}
	for _, a := range args {
		if a == "-c" || a == "--continue" {
			continue
		}
		argv = append(argv, a)
	}
	return ShellJoin(append(argv, sessionArg(u, resume)...))
}

var shellSafeWord = regexp.MustCompile(`^[A-Za-z0-9_@%+=:,./-]+$`)

// ShellJoin quotes each word for a POSIX shell so that the shell's own word
// splitting returns argv unchanged.
func ShellJoin(argv []string) string {
	quoted := make([]string, len(argv))
	for i, a := range argv {
		if shellSafeWord.MatchString(a) {
			quoted[i] = a
		} else {
			quoted[i] = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
		}
	}
	return strings.Join(quoted, " ")
}

// ExpandHome expands a leading "~" or "~/" to the daemon user's home, like the
// shell does for an unquoted word. Other words are returned unchanged.
func ExpandHome(word string) string {
	if word != "~" && !strings.HasPrefix(word, "~/") {
		return word
	}
	home := os.Getenv("HOME")
	if home == "" {
		var err error
		if home, err = os.UserHomeDir(); err != nil {
			return word
		}
	}
	return home + word[1:]
}

// shellMeta are characters that, unquoted, make the shell do more than split
// words (pipes, redirects, expansions, globs, grouping, comments).
const shellMeta = "|&;<>()$`*?{}[]\n"

// splitWords splits s like a POSIX shell would split a simple command, with
// single quotes, double quotes and backslash escapes. ok is false when s uses
// any other shell syntax, or a quote is left open. A leading unquoted ~ or ~/
// is expanded (ExpandHome).
func splitWords(s string) (words []string, ok bool) {
	var (
		cur     strings.Builder
		inWord  bool
		tildeOK bool // the current word started with an unquoted ~
	)
	flush := func() {
		if inWord {
			w := cur.String()
			if tildeOK {
				w = ExpandHome(w)
			}
			words = append(words, w)
		}
		cur.Reset()
		inWord, tildeOK = false, false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == ' ' || c == '\t':
			flush()
		case c == '\'':
			j := strings.IndexByte(s[i+1:], '\'')
			if j < 0 {
				return nil, false
			}
			cur.WriteString(s[i+1 : i+1+j])
			inWord = true
			i += j + 1
		case c == '"':
			i++
			for ; i < len(s) && s[i] != '"'; i++ {
				switch s[i] {
				case '$', '`':
					return nil, false
				case '\\':
					if i+1 < len(s) && strings.IndexByte("\"\\$`", s[i+1]) >= 0 {
						i++
					} else if i+1 < len(s) && s[i+1] == '\n' {
						i++
						continue
					}
				}
				cur.WriteByte(s[i])
			}
			if i >= len(s) {
				return nil, false
			}
			inWord = true
		case c == '\\':
			if i+1 >= len(s) {
				return nil, false
			}
			i++
			if s[i] != '\n' {
				cur.WriteByte(s[i])
				inWord = true
			}
		case c == '#' && !inWord:
			return nil, false
		case strings.IndexByte(shellMeta, c) >= 0:
			return nil, false
		default:
			if !inWord && c == '~' {
				tildeOK = true
			}
			cur.WriteByte(c)
			inWord = true
		}
	}
	flush()
	return words, true
}

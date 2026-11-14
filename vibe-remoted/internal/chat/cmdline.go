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

// valueOptions are claude's options that take a value. The word after one
// (unless written --opt=value) is its value, never an option, even when it
// looks like one: `--append-system-prompt -c` is a prompt of "-c", not
// continue. variadic ones also take every following word up to the next one
// starting with "-" (claude's option parser does the same).
var valueOptions = map[string]struct{ variadic bool }{
	"--append-system-prompt": {}, "--append-system-prompt-file": {},
	"--system-prompt": {}, "--system-prompt-file": {},
	"--model": {}, "--fallback-model": {}, "--permission-mode": {},
	"--settings": {}, "--setting-sources": {}, "--agents": {}, "--agent": {},
	"--max-turns": {}, "--max-budget-usd": {}, "--json-schema": {},
	"--session-id": {}, "--resume": {}, "-r": {},
	"--output-format": {}, "--input-format": {}, "--permission-prompt-tool": {},
	"--add-dir": {variadic: true}, "--mcp-config": {variadic: true},
	"--allowedTools": {variadic: true}, "--allowed-tools": {variadic: true},
	"--disallowedTools": {variadic: true}, "--disallowed-tools": {variadic: true},
	"--tools": {variadic: true}, "--betas": {variadic: true}, "--plugin-dir": {variadic: true},
}

// Kinds of argument words (classifyArgs).
const (
	argPositional = iota // a prompt word, or anything after "--"
	argOption            // an option in option position (name, maybe =value)
	argValue             // the value of the option before it
)

// classifyArgs tells, for each of claude's argument words, whether it is an
// option, an option's value or a positional word. Only argOption words are
// ever treated as flags.
func classifyArgs(args []string) []int {
	kinds := make([]int, len(args))
	for i := 0; i < len(args); i++ {
		w := args[i]
		if w == "--" {
			kinds[i] = argOption
			for i++; i < len(args); i++ {
				kinds[i] = argPositional
			}
			break
		}
		if len(w) < 2 || w[0] != '-' {
			kinds[i] = argPositional
			continue
		}
		kinds[i] = argOption
		name, _, hasValue := optionName(w)
		vo, takes := valueOptions[name]
		if !takes || hasValue {
			continue
		}
		if i+1 < len(args) {
			i++
			kinds[i] = argValue
		}
		for vo.variadic && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
			i++
			kinds[i] = argValue
		}
	}
	return kinds
}

// optionName splits "--name=value"; a short option is its own name.
func optionName(w string) (name, value string, hasValue bool) {
	if strings.HasPrefix(w, "--") {
		return strings.Cut(w, "=")
	}
	return w, "", false
}

func isContinue(name string) bool { return name == "-c" || name == "--continue" }

// ParseClaudeCmd splits cmd by shell rules and checks it can run a chat
// session. reason is empty on success, otherwise one of
// protocol.ChatReasonShellSyntax, ChatReasonNotClaude, ChatReasonConflictingArgs.
// Only words in option position are interpreted (classifyArgs).
func ParseClaudeCmd(cmd string) (Parsed, string) {
	words, ok := splitWords(cmd)
	if !ok {
		return Parsed{}, protocol.ChatReasonShellSyntax
	}
	if len(words) == 0 || filepath.Base(words[0]) != "claude" {
		return Parsed{}, protocol.ChatReasonNotClaude
	}
	p := Parsed{Exe: words[0]}
	args := words[1:]
	kinds := classifyArgs(args)
	for i, w := range args {
		if kinds[i] != argOption {
			p.Args = append(p.Args, w)
			continue
		}
		name, value, hasValue := optionName(w)
		if sessionControlArgs[name] {
			return Parsed{}, protocol.ChatReasonConflictingArgs
		}
		switch {
		case isContinue(name):
			p.Continue = true
			continue
		case name == "--dangerously-skip-permissions":
			p.Bypass = true
		case name == "--permission-mode":
			if !hasValue && i+1 < len(args) && kinds[i+1] == argValue {
				value = args[i+1]
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
	opts, rest := splitAtDashDash(p.Args)
	argv := make([]string, 0, 1+len(p.Args)+len(streamJSONArgs)+2)
	argv = append(argv, p.Exe)
	argv = append(argv, opts...)
	argv = append(argv, streamJSONArgs...)
	argv = append(argv, sessionArg(claudeSessionID, resume)...)
	return append(argv, rest...)
}

// splitAtDashDash splits args before an option-position "--" (the daemon's
// own options must come before it, where they are still options).
func splitAtDashDash(args []string) (opts, rest []string) {
	kinds := classifyArgs(args)
	for i, a := range args {
		if a == "--" && kinds[i] == argOption {
			return args[:i:i], args[i:]
		}
	}
	return args, nil
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
	return ShellJoin(HandoffArgv(exe, args, u, resume))
}

// HandoffArgv is HandoffCommand's argv. Only a -c/--continue in option
// position is dropped; the same word as an option's value or a prompt word
// stays.
func HandoffArgv(exe string, args []string, u string, resume bool) []string {
	opts, rest := splitAtDashDash(args)
	argv := []string{exe}
	kinds := classifyArgs(opts)
	for i, a := range opts {
		if kinds[i] == argOption {
			if name, _, _ := optionName(a); isContinue(name) {
				continue
			}
		}
		argv = append(argv, a)
	}
	argv = append(argv, sessionArg(u, resume)...)
	return append(argv, rest...)
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

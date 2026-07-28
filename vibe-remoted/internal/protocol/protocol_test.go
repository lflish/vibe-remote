package protocol

import (
	"encoding/json"
	"testing"
)

func TestAttachFrameRoundTrip(t *testing.T) {
	// workdir + flags round-trip
	raw := `{"type":"attach","workdir":"/tmp","flags":["a","b"]}`
	var f AttachFrame
	if err := json.Unmarshal([]byte(raw), &f); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if f.Workdir != "/tmp" {
		t.Fatalf("Workdir = %q, want %q", f.Workdir, "/tmp")
	}
	if len(f.Flags) != 2 || f.Flags[0] != "a" || f.Flags[1] != "b" {
		t.Fatalf("Flags = %v, want [a b]", f.Flags)
	}

	// empty workdir + flags are omitted from output (headless-only shape)
	out, _ := json.Marshal(AttachFrame{Type: TypeAttach})
	if string(out) != `{"type":"attach"}` {
		t.Fatalf("marshal = %s", out)
	}
}

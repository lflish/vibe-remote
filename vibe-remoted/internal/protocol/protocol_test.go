package protocol

import (
	"encoding/json"
	"testing"
)

func TestAttachFrameMode(t *testing.T) {
	// headless mode round-trips
	raw := `{"type":"attach","workdir":"/tmp","mode":"headless"}`
	var f AttachFrame
	if err := json.Unmarshal([]byte(raw), &f); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if f.Mode != ModeHeadless {
		t.Fatalf("Mode = %q, want %q", f.Mode, ModeHeadless)
	}

	// omitted mode stays empty (caller treats empty as tui)
	var f2 AttachFrame
	if err := json.Unmarshal([]byte(`{"type":"attach"}`), &f2); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if f2.Mode != "" {
		t.Fatalf("Mode = %q, want empty", f2.Mode)
	}

	// empty Mode is omitted from output (back-compat: desktop frames unchanged)
	out, _ := json.Marshal(AttachFrame{Type: TypeAttach})
	if string(out) != `{"type":"attach","cols":0,"rows":0}` {
		t.Fatalf("marshal = %s", out)
	}
}

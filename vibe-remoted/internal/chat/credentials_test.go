package chat

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// design 7.1: the daemon never reads claude's credentials. Scan every Go
// source under internal/ (this file excluded) for the credential file name and
// the API key variable.
func TestNoCredentialAccess(t *testing.T) {
	forbidden := []string{".creden" + "tials", "ANTHROPIC_" + "API_KEY"}
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	self, _ := filepath.Abs("credentials_test.go")
	scanned := 0
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || path == self {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		scanned++
		for _, f := range forbidden {
			if strings.Contains(string(data), f) {
				t.Errorf("%s mentions %q", path, f)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if scanned < 10 {
		t.Fatalf("scanned only %d files under %s", scanned, root)
	}
}

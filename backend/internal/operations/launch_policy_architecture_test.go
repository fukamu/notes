package operations

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestLaunchPolicyHasNoRuntimeOrAdapterImports(t *testing.T) {
	t.Parallel()
	directory := operationsSourceDirectory(t)
	file, err := parser.ParseFile(
		token.NewFileSet(),
		filepath.Join(directory, "launch_policy.go"),
		nil,
		parser.ImportsOnly,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(file.Imports) != 0 {
		t.Fatalf("launch_policy.go imports %d packages; pure policy must remain import-free", len(file.Imports))
	}
}

func TestOperationsPackageDoesNotImportConcreteEffects(t *testing.T) {
	t.Parallel()
	directory := operationsSourceDirectory(t)
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	forbiddenExact := map[string]struct{}{
		"database/sql": {},
		"net/http":     {},
		"os":           {},
		"time":         {},
		"crypto/rand":  {},
		"math/rand":    {},
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		path := filepath.Join(directory, entry.Name())
		file, parseErr := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if parseErr != nil {
			t.Fatalf("parse %s: %v", path, parseErr)
		}
		for _, imported := range file.Imports {
			pathValue, unquoteErr := strconv.Unquote(imported.Path.Value)
			if unquoteErr != nil {
				t.Fatalf("decode import in %s: %v", path, unquoteErr)
			}
			_, exactForbidden := forbiddenExact[pathValue]
			if exactForbidden || strings.Contains(pathValue, "/internal/adapters/") ||
				strings.HasPrefix(pathValue, "github.com/jackc/pgx/") ||
				strings.HasPrefix(pathValue, "github.com/stripe/stripe-go/") {
				t.Errorf("%s imports forbidden concrete effect %q", entry.Name(), pathValue)
			}
		}
	}
}

func operationsSourceDirectory(t *testing.T) string {
	t.Helper()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve operations test source")
	}
	return filepath.Dir(currentFile)
}

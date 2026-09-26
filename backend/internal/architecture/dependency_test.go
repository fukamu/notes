package architecture_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

const modulePath = "github.com/fukamu/notes/backend"

var pureDomainAndApplicationRoots = map[string]struct{}{
	"access":          {},
	"accountdeletion": {},
	"billing":         {},
	"cryptocontent":   {},
	"encryptedobject": {},
	"entitlement":     {},
	"identity":        {},
	"launchgate":      {},
	"legal":           {},
	"localfixture":    {},
	"operations":      {},
	"privacyrequest":  {},
	"quota":           {},
	"stripebilling":   {},
	"synclegacy":      {},
	"syncv2":          {},
	"vaultdata":       {},
}

var forbiddenConcreteEffectImports = []string{
	"crypto/rand",
	"database/sql",
	"log/slog",
	"math/rand",
	"net/http",
	"os",
	modulePath + "/internal/adapters",
	modulePath + "/internal/config",
	modulePath + "/internal/httpapi",
	modulePath + "/internal/runtimefoundation",
	modulePath + "/cmd/",
	"github.com/coreos/go-oidc/",
	"github.com/jackc/pgx/",
	"github.com/pressly/goose/",
	"github.com/stripe/stripe-go/",
	"golang.org/x/oauth2",
}

func TestPureDomainAndApplicationPackagesDoNotImportConcreteEffects(t *testing.T) {
	t.Parallel()

	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve architecture test path")
	}
	backendRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", ".."))
	internalRoot := filepath.Join(backendRoot, "internal")
	err := filepath.WalkDir(internalRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, relErr := filepath.Rel(internalRoot, path)
		if relErr != nil {
			return relErr
		}
		first, _, _ := strings.Cut(filepath.ToSlash(relative), "/")
		if entry.IsDir() {
			if relative != "." {
				if _, protected := pureDomainAndApplicationRoots[first]; !protected {
					return filepath.SkipDir
				}
			}
			if strings.Contains(filepath.ToSlash(relative), "/testdata/") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			return nil
		}

		source, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		violations, parseErr := concreteEffectImports(source)
		if parseErr != nil {
			return parseErr
		}
		for _, importPath := range violations {
			t.Errorf("%s imports concrete effect package %s", filepath.ToSlash(relative), importPath)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestConcreteEffectImportGateRegressionFixtures(t *testing.T) {
	t.Parallel()

	for _, importPath := range []string{
		"crypto/rand",
		"database/sql",
		"log/slog",
		"math/rand",
		"net/http",
		"os",
		"github.com/fukamu/notes/backend/internal/adapters/postgres",
		"github.com/fukamu/notes/backend/internal/config",
		"github.com/coreos/go-oidc/v3/oidc",
		"github.com/jackc/pgx/v5/pgxpool",
		"github.com/pressly/goose/v3",
		"github.com/stripe/stripe-go/v84",
		"golang.org/x/oauth2",
	} {
		source := []byte("package fixture\nimport _ \"" + importPath + "\"\n")
		violations, err := concreteEffectImports(source)
		if err != nil {
			t.Fatalf("parse forbidden fixture %q: %v", importPath, err)
		}
		if len(violations) != 1 || violations[0] != importPath {
			t.Fatalf("forbidden fixture %q escaped gate: %#v", importPath, violations)
		}
	}

	neutral := []byte("package fixture\nimport (\n\t\"context\"\n\t\"errors\"\n\t\"github.com/fukamu/notes/backend/internal/identity\"\n)\n")
	violations, err := concreteEffectImports(neutral)
	if err != nil {
		t.Fatal(err)
	}
	if len(violations) != 0 {
		t.Fatalf("typed ports were falsely classified as effects: %#v", violations)
	}
}

func concreteEffectImports(source []byte) ([]string, error) {
	parsed, err := parser.ParseFile(token.NewFileSet(), "fixture.go", source, parser.ImportsOnly)
	if err != nil {
		return nil, err
	}
	violations := make([]string, 0)
	for _, declaration := range parsed.Decls {
		general, isGeneral := declaration.(*ast.GenDecl)
		if !isGeneral || general.Tok != token.IMPORT {
			continue
		}
		for _, specification := range general.Specs {
			importSpec, isImport := specification.(*ast.ImportSpec)
			if !isImport {
				continue
			}
			importPath, unquoteErr := strconv.Unquote(importSpec.Path.Value)
			if unquoteErr != nil {
				return nil, unquoteErr
			}
			if concreteEffectImport(importPath) {
				violations = append(violations, importPath)
			}
		}
	}
	return violations, nil
}

func concreteEffectImport(importPath string) bool {
	for _, forbidden := range forbiddenConcreteEffectImports {
		if importPath == forbidden || strings.HasPrefix(importPath, forbidden+"/") ||
			(strings.HasSuffix(forbidden, "/") && strings.HasPrefix(importPath, forbidden)) {
			return true
		}
	}
	return false
}

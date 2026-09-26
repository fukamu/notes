package architecture_test

import (
	"fmt"
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

// knownInternalRoots is an inventory, not an allowlist for effects. Every root
// in this inventory is scanned by default unless it has a documented exemption
// below. A newly added root fails the gate until its architectural role is
// reviewed and recorded here.
var knownInternalRoots = map[string]struct{}{
	"access":            {},
	"accountdeletion":   {},
	"adapters":          {},
	"architecture":      {},
	"billing":           {},
	"config":            {},
	"cryptocontent":     {},
	"encryptedobject":   {},
	"entitlement":       {},
	"httpapi":           {},
	"identity":          {},
	"launchgate":        {},
	"legal":             {},
	"localfixture":      {},
	"operations":        {},
	"privacyrequest":    {},
	"quota":             {},
	"runtimefoundation": {},
	"stripebilling":     {},
	"synclegacy":        {},
	"syncv2":            {},
	"telemetry":         {},
	"vaultdata":         {},
}

// Package-wide exemptions are limited to concrete adapters, configuration,
// HTTP delivery, composition, and this architecture test package itself.
var concreteEffectRootExemptions = map[string]string{
	"adapters":          "concrete infrastructure adapters",
	"architecture":      "architecture verification code",
	"config":            "environment configuration boundary",
	"httpapi":           "HTTP delivery adapters",
	"runtimefoundation": "process composition and lifecycle effects",
}

// logger.go is the single effect-bearing file in telemetry: it adapts already
// bounded telemetry records to slog. Codec, policy, metric, alert, and delivery
// decisions in the rest of telemetry remain protected by the default gate.
var concreteEffectFileExemptions = map[string]string{
	"telemetry/logger.go": "bounded slog output adapter retained beside telemetry contracts",
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
	validateConcreteEffectFileExemptions(t, internalRoot)
	err := filepath.WalkDir(internalRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, relErr := filepath.Rel(internalRoot, path)
		if relErr != nil {
			return relErr
		}
		relative = filepath.ToSlash(relative)
		action, classificationErr := classifyInternalPath(relative, entry.IsDir())
		if classificationErr != nil {
			return classificationErr
		}
		if entry.IsDir() {
			if action == internalPathSkipTree {
				return filepath.SkipDir
			}
			return nil
		}
		if action == internalPathSkipFile {
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

func TestInternalPathClassificationDefaultsToProtectedAndRejectsUnknownRoots(t *testing.T) {
	t.Parallel()

	for _, relative := range []string{
		"identity/session.go",
		"operations/quota_reconciliation.go",
		"telemetry/codec.go",
		"telemetry/logger_helper.go",
	} {
		action, err := classifyInternalPath(relative, false)
		if err != nil {
			t.Fatalf("classify protected path %q: %v", relative, err)
		}
		if action != internalPathScanFile {
			t.Fatalf("protected path %q action = %d", relative, action)
		}
	}

	for _, relative := range []string{
		"adapters/postgres/session.go",
		"config/environment.go",
		"httpapi/legal.go",
		"runtimefoundation/server.go",
	} {
		action, err := classifyInternalPath(relative, false)
		if err != nil {
			t.Fatalf("classify exempt path %q: %v", relative, err)
		}
		if action != internalPathSkipFile {
			t.Fatalf("exempt path %q action = %d", relative, action)
		}
	}

	action, err := classifyInternalPath("telemetry/logger.go", false)
	if err != nil {
		t.Fatal(err)
	}
	if action != internalPathSkipFile {
		t.Fatalf("telemetry logger action = %d", action)
	}

	if _, err := classifyInternalPath("unreviewed/new_package.go", false); err == nil {
		t.Fatal("unknown internal root escaped classification")
	}
	if _, err := classifyInternalPath("unreviewed", true); err == nil {
		t.Fatal("unknown internal directory escaped classification")
	}
}

type internalPathAction uint8

const (
	internalPathDescend internalPathAction = iota
	internalPathScanFile
	internalPathSkipFile
	internalPathSkipTree
)

func classifyInternalPath(relative string, directory bool) (internalPathAction, error) {
	if relative == "." {
		return internalPathDescend, nil
	}
	root, _, _ := strings.Cut(relative, "/")
	if _, known := knownInternalRoots[root]; !known {
		return internalPathDescend, fmt.Errorf("unclassified internal root %q", root)
	}
	if reason, exempt := concreteEffectRootExemptions[root]; exempt {
		if reason == "" {
			return internalPathDescend, fmt.Errorf("internal root %q has an undocumented exemption", root)
		}
		if directory {
			return internalPathSkipTree, nil
		}
		return internalPathSkipFile, nil
	}
	if directory {
		if strings.Contains("/"+relative+"/", "/testdata/") {
			return internalPathSkipTree, nil
		}
		return internalPathDescend, nil
	}
	if reason, exempt := concreteEffectFileExemptions[relative]; exempt {
		if reason == "" {
			return internalPathDescend, fmt.Errorf("internal file %q has an undocumented exemption", relative)
		}
		return internalPathSkipFile, nil
	}
	return internalPathScanFile, nil
}

func validateConcreteEffectFileExemptions(t *testing.T, internalRoot string) {
	t.Helper()
	for relative, reason := range concreteEffectFileExemptions {
		if reason == "" {
			t.Errorf("internal file %q has an undocumented exemption", relative)
			continue
		}
		source, err := os.ReadFile(filepath.Join(internalRoot, filepath.FromSlash(relative)))
		if err != nil {
			t.Errorf("read concrete-effect exemption %s: %v", relative, err)
			continue
		}
		violations, err := concreteEffectImports(source)
		if err != nil {
			t.Errorf("parse concrete-effect exemption %s: %v", relative, err)
			continue
		}
		if len(violations) == 0 {
			t.Errorf("concrete-effect exemption %s is stale", relative)
		}
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

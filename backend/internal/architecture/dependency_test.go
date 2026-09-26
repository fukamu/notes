package architecture_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

const modulePath = "github.com/fukamu/notes/backend"

func TestDomainPackagesDoNotImportEffectOrCompositionPackages(t *testing.T) {
	t.Parallel()

	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve architecture test path")
	}
	backendRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", ".."))
	internalRoot := filepath.Join(backendRoot, "internal")
	forbidden := []string{
		modulePath + "/internal/adapters",
		modulePath + "/internal/httpapi",
		modulePath + "/internal/runtimefoundation",
		modulePath + "/cmd/",
	}
	compositionRoots := map[string]struct{}{
		"adapters":          {},
		"httpapi":           {},
		"runtimefoundation": {},
	}

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
			if _, exempt := compositionRoots[first]; exempt {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			return nil
		}

		parsed, parseErr := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if parseErr != nil {
			return parseErr
		}
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
					return unquoteErr
				}
				for _, prefix := range forbidden {
					if importPath == prefix || strings.HasPrefix(importPath, prefix+"/") ||
						(strings.HasSuffix(prefix, "/") && strings.HasPrefix(importPath, prefix)) {
						t.Errorf("%s imports effect/composition package %s", filepath.ToSlash(relative), importPath)
					}
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

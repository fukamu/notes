package main

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunRejectsUnknownCommand(t *testing.T) {
	t.Parallel()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := run([]string{"migrate"}, &stdout, &stderr); code != 2 {
		t.Fatalf("exit code = %d", code)
	}
	if stdout.Len() != 0 || !strings.Contains(stderr.String(), "usage:") {
		t.Fatalf("stdout = %q, stderr = %q", stdout.String(), stderr.String())
	}
}

func TestRunChecksConfigurationWithoutPrintingValues(t *testing.T) {
	staticDirectory := t.TempDir()
	t.Setenv("NOTES_ENVIRONMENT", "test")
	t.Setenv("NOTES_HTTP_ADDR", "127.0.0.1:8080")
	t.Setenv("NOTES_STATIC_DIR", staticDirectory)

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := run([]string{"config", "check"}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr.String())
	}
	if stdout.String() != "configuration valid\n" {
		t.Fatalf("stdout = %q", stdout.String())
	}
	if strings.Contains(stdout.String(), filepath.Base(staticDirectory)) {
		t.Fatal("config check printed a configuration value")
	}
}

func TestRunFailsClosedWithoutConfiguration(t *testing.T) {
	for _, key := range []string{
		"NOTES_ENVIRONMENT",
		"NOTES_HTTP_ADDR",
		"NOTES_STATIC_DIR",
	} {
		t.Setenv(key, "")
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := run([]string{"config", "check"}, &stdout, &stderr); code != 1 {
		t.Fatalf("exit code = %d", code)
	}
	if stderr.String() != "configuration invalid\n" {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

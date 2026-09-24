//go:build !windows

package smoke_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestNotesProcessHealthClosedRoutesAndSIGTERM(t *testing.T) {
	binary := buildNotesBinary(t)

	address := availableAddress(t)
	staticDirectory := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(staticDirectory, "index.html"),
		[]byte("<!doctype html><title>process smoke</title>"),
		0o600,
	); err != nil {
		t.Fatalf("write index: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, binary)
	command.Env = append(
		withoutNotesEnvironment(os.Environ()),
		"NOTES_ENVIRONMENT=test",
		"NOTES_HTTP_ADDR="+address,
		"NOTES_STATIC_DIR="+staticDirectory,
		"NOTES_SHUTDOWN_TIMEOUT=2s",
		"NOTES_LOG_LEVEL=info",
	)
	var stderr bytes.Buffer
	command.Stdout = io.Discard
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		t.Fatalf("start notes: %v", err)
	}

	client := &http.Client{Timeout: 500 * time.Millisecond}
	waitForStatus(t, client, "http://"+address+"/healthz?secret=not-logged", http.StatusOK)
	waitForStatus(t, client, "http://"+address+"/", http.StatusOK)
	waitForStatus(t, client, "http://"+address+"/readyz", http.StatusServiceUnavailable)
	waitForStatus(t, client, "http://"+address+"/api/sync", http.StatusNotFound)

	if err := command.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("signal notes: %v", err)
	}
	waitResult := make(chan error, 1)
	go func() {
		waitResult <- command.Wait()
	}()
	select {
	case waitErr := <-waitResult:
		if waitErr != nil {
			t.Fatalf("notes exit: %v\n%s", waitErr, stderr.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("notes did not stop within the graceful shutdown bound")
	}

	logs := stderr.String()
	for _, forbidden := range []string{"not-logged", staticDirectory} {
		if strings.Contains(logs, forbidden) {
			t.Fatalf("process log contains sensitive configuration: %s", logs)
		}
	}
	if !strings.Contains(logs, `"reason":"shutdown"`) {
		t.Fatalf("process did not record graceful shutdown: %s", logs)
	}
}

func TestNotesProcessFailsClosedWithoutConfiguration(t *testing.T) {
	binary := buildNotesBinary(t)
	command := exec.Command(binary)
	command.Env = withoutNotesEnvironment(os.Environ())
	output, err := command.CombinedOutput()
	if err == nil {
		t.Fatal("notes started without required configuration")
	}
	var exitError *exec.ExitError
	if !errors.As(err, &exitError) || exitError.ExitCode() != 1 {
		t.Fatalf("notes exit = %v", err)
	}
	logLine := string(output)
	if !strings.Contains(logLine, `"error_code":"invalid_configuration"`) {
		t.Fatalf("missing fixed configuration error: %s", logLine)
	}
	if strings.Contains(logLine, "NOTES_") {
		t.Fatalf("configuration log exposed a key or value: %s", logLine)
	}
}

func buildNotesBinary(t *testing.T) string {
	t.Helper()
	moduleRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("module root: %v", err)
	}
	binary := filepath.Join(t.TempDir(), "notes")
	build := exec.Command("go", "build", "-o", binary, "./cmd/notes")
	build.Dir = moduleRoot
	if output, buildErr := build.CombinedOutput(); buildErr != nil {
		t.Fatalf("build notes: %v\n%s", buildErr, output)
	}
	return binary
}

func availableAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatalf("close listener: %v", err)
	}
	return address
}

func withoutNotesEnvironment(environment []string) []string {
	filtered := make([]string, 0, len(environment))
	for _, entry := range environment {
		if !strings.HasPrefix(entry, "NOTES_") {
			filtered = append(filtered, entry)
		}
	}
	return filtered
}

func waitForStatus(
	t *testing.T,
	client *http.Client,
	url string,
	wantStatus int,
) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		response, err := client.Get(url)
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode == wantStatus {
				return
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("%s did not return status %d", url, wantStatus)
}

package httpapi_test

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/telemetry"
)

func testHandler(t *testing.T, bodyLimit int64) (http.Handler, *bytes.Buffer) {
	t.Helper()
	staticDirectory := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(staticDirectory, "index.html"),
		[]byte("<!doctype html><title>Go bootstrap</title>"),
		0o600,
	); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	logs := &bytes.Buffer{}
	handler, err := httpapi.NewHandler(httpapi.HandlerOptions{
		StaticDirectory: staticDirectory,
		BodyLimit:       bodyLimit,
		Logger:          telemetry.NewLogger(logs, slog.LevelDebug),
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler, logs
}

func TestHandlerServesOnlyBootstrapAndProcessHealth(t *testing.T) {
	t.Parallel()
	handler, _ := testHandler(t, 1024)
	tests := []struct {
		name        string
		path        string
		status      int
		contentType string
		body        string
	}{
		{
			name:        "index",
			path:        "/",
			status:      http.StatusOK,
			contentType: "text/html; charset=utf-8",
			body:        "Go bootstrap",
		},
		{
			name:        "health",
			path:        "/healthz",
			status:      http.StatusOK,
			contentType: "application/json; charset=utf-8",
			body:        `{"status":"ok"}`,
		},
		{
			name:        "readiness closed before database",
			path:        "/readyz",
			status:      http.StatusServiceUnavailable,
			contentType: "application/json; charset=utf-8",
			body:        `{"status":"not_ready"}`,
		},
		{
			name:        "api closed",
			path:        "/api/sync",
			status:      http.StatusNotFound,
			contentType: "application/json; charset=utf-8",
			body:        `{"code":"not_found"}`,
		},
		{
			name:        "unknown route",
			path:        "/private/config",
			status:      http.StatusNotFound,
			contentType: "application/json; charset=utf-8",
			body:        `{"code":"not_found"}`,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, test.path, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)

			if response.Code != test.status {
				t.Fatalf("status = %d, want %d", response.Code, test.status)
			}
			if got := response.Header().Get("Content-Type"); got != test.contentType {
				t.Fatalf("Content-Type = %q", got)
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("response must not be cached")
			}
			if !strings.Contains(response.Body.String(), test.body) {
				t.Fatalf("body = %q, want marker %q", response.Body, test.body)
			}
		})
	}
}

func TestHandlerRejectsOversizedBodiesBeforeRouting(t *testing.T) {
	t.Parallel()
	handler, _ := testHandler(t, 8)
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/disconnected",
		strings.NewReader("123456789"),
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d", response.Code)
	}
	if response.Body.String() != "{\"code\":\"body_too_large\"}\n" {
		t.Fatalf("body = %q", response.Body.String())
	}
}

func TestHandlerRejectsOversizedChunkedBodies(t *testing.T) {
	t.Parallel()
	handler, _ := testHandler(t, 8)
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/disconnected",
		strings.NewReader("123456789"),
	)
	request.ContentLength = -1
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d", response.Code)
	}
	if response.Body.String() != "{\"code\":\"body_too_large\"}\n" {
		t.Fatalf("body = %q", response.Body.String())
	}
}

func TestHandlerOmitsResponseBodyForHead(t *testing.T) {
	t.Parallel()
	handler, _ := testHandler(t, 1024)
	for _, path := range []string{"/healthz", "/readyz", "/api/sync", "/missing"} {
		request := httptest.NewRequest(http.MethodHead, path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Body.Len() != 0 {
			t.Fatalf("HEAD %s body = %q", path, response.Body.String())
		}
	}
}

func TestHandlerDoesNotLogQueryHeaderOrBody(t *testing.T) {
	t.Parallel()
	handler, logs := testHandler(t, 1024)
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/disconnected?token=raw-query",
		strings.NewReader("raw-body"),
	)
	request.Header.Set("Authorization", "Bearer raw-header")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	logLine := logs.String()
	for _, forbidden := range []string{"raw-query", "raw-body", "raw-header"} {
		if strings.Contains(logLine, forbidden) {
			t.Fatalf("request log contains %q: %s", forbidden, logLine)
		}
	}
	if !strings.Contains(logLine, `"path":"/api/disconnected"`) {
		t.Fatalf("request log omitted safe path: %s", logLine)
	}
}

func TestNewHandlerRejectsMissingStaticIndex(t *testing.T) {
	t.Parallel()
	handler, err := httpapi.NewHandler(httpapi.HandlerOptions{
		StaticDirectory: t.TempDir(),
		BodyLimit:       1024,
		Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err == nil || handler != nil {
		t.Fatal("NewHandler must reject a missing index")
	}
}

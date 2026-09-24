package httpapi_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/notes/backend/internal/access"
	accessadapter "github.com/fukamu/notes/backend/internal/adapters/access"
	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/launchgate"
	"github.com/fukamu/notes/backend/internal/telemetry"
)

func testHandler(t *testing.T, bodyLimit int64) (http.Handler, *bytes.Buffer) {
	return testHandlerWithRuntime(t, bodyLimit, nil)
}

func testHandlerWithRuntime(
	t *testing.T,
	bodyLimit int64,
	privateRuntime *httpapi.PrivateRuntime,
) (http.Handler, *bytes.Buffer) {
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
		PrivateRuntime:  privateRuntime,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler, logs
}

type gateReaderFunction func(context.Context, *access.Subject) (launchgate.Facts, error)

func (reader gateReaderFunction) Read(
	ctx context.Context,
	subject *access.Subject,
) (launchgate.Facts, error) {
	return reader(ctx, subject)
}

type readinessFunction func(context.Context) error

func (check readinessFunction) Check(ctx context.Context) error {
	return check(ctx)
}

func TestPrivateLaunchStatusUsesSignedIdentityAndFailsClosed(t *testing.T) {
	t.Parallel()
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := accessadapter.NewLocalVerifier(publicKey, "https://issuer.test", "notes-local")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_800_000_000, 0)
	owner, _ := access.ParseSubject("private-owner")
	assertion, err := accessadapter.SignLocalAssertion(
		privateKey,
		"https://issuer.test",
		"notes-local",
		owner,
		now.Add(-time.Minute),
		now.Add(time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	runtime := &httpapi.PrivateRuntime{
		Verifier: verifier,
		Gate: gateReaderFunction(func(_ context.Context, subject *access.Subject) (launchgate.Facts, error) {
			return launchgate.Facts{UserAllowed: subject != nil && *subject == owner}, nil
		}),
		Readiness: readinessFunction(func(context.Context) error { return nil }),
		Clock:     func() time.Time { return now },
	}
	handler, _ := testHandlerWithRuntime(t, 1024, runtime)

	anonymous := httptest.NewRecorder()
	handler.ServeHTTP(anonymous, httptest.NewRequest(http.MethodGet, "/api/launch-status", nil))
	if anonymous.Code != http.StatusOK || anonymous.Body.String() !=
		"{\"authenticated\":false,\"canAccess\":false,\"publicAccessEnabled\":false,\"userAllowed\":false}\n" {
		t.Fatalf("anonymous launch response = %d %s", anonymous.Code, anonymous.Body.String())
	}

	approvedRequest := httptest.NewRequest(http.MethodGet, "/api/launch-status", nil)
	approvedRequest.Header.Set(accessadapter.LocalAssertionHeader, assertion)
	approved := httptest.NewRecorder()
	handler.ServeHTTP(approved, approvedRequest)
	if approved.Code != http.StatusOK || approved.Body.String() !=
		"{\"authenticated\":true,\"canAccess\":true,\"publicAccessEnabled\":false,\"userAllowed\":true}\n" {
		t.Fatalf("approved launch response = %d %s", approved.Code, approved.Body.String())
	}
	if approved.Header().Get("Cache-Control") != "private, no-store" ||
		approved.Header().Get("Vary") != "Cookie, "+accessadapter.LocalAssertionHeader {
		t.Fatalf("private headers = %#v", approved.Header())
	}

	for name, mutate := range map[string]func(*http.Request){
		"invalid assertion": func(request *http.Request) {
			request.Header.Set(accessadapter.LocalAssertionHeader, "unsigned-subject")
		},
		"duplicate assertion": func(request *http.Request) {
			request.Header.Add(accessadapter.LocalAssertionHeader, assertion)
			request.Header.Add(accessadapter.LocalAssertionHeader, assertion)
		},
		"legacy sites spoof": func(request *http.Request) {
			request.Header.Set(accessadapter.LegacySitesHeader, "private-owner")
		},
	} {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(http.MethodGet, "/api/launch-status", nil)
			mutate(request)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusServiceUnavailable ||
				response.Body.String() != "{\"error\":\"launch-gate-unavailable\"}\n" {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
			if strings.Contains(response.Body.String(), "private-owner") {
				t.Fatal("response disclosed spoofed identity")
			}
		})
	}
}

func TestPrivateReadinessRequiresAllDependenciesAndDatabase(t *testing.T) {
	t.Parallel()
	publicKey, _, _ := ed25519.GenerateKey(nil)
	verifier, _ := accessadapter.NewLocalVerifier(publicKey, "https://issuer.test", "notes-local")
	gate := gateReaderFunction(func(context.Context, *access.Subject) (launchgate.Facts, error) {
		return launchgate.Facts{}, nil
	})
	for name, test := range map[string]struct {
		runtime *httpapi.PrivateRuntime
		status  int
		body    string
	}{
		"disabled": {runtime: nil, status: http.StatusServiceUnavailable, body: "not_ready"},
		"database failure": {
			runtime: &httpapi.PrivateRuntime{
				Verifier: verifier,
				Gate:     gate,
				Readiness: readinessFunction(func(context.Context) error {
					return errors.New("raw database failure")
				}),
				Clock: time.Now,
			},
			status: http.StatusServiceUnavailable,
			body:   "not_ready",
		},
		"ready": {
			runtime: &httpapi.PrivateRuntime{
				Verifier:  verifier,
				Gate:      gate,
				Readiness: readinessFunction(func(context.Context) error { return nil }),
				Clock:     time.Now,
			},
			status: http.StatusOK,
			body:   "ready",
		},
	} {
		name, test := name, test
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			handler, _ := testHandlerWithRuntime(t, 1024, test.runtime)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
			if response.Code != test.status || !strings.Contains(response.Body.String(), test.body) ||
				strings.Contains(response.Body.String(), "raw database failure") {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
		})
	}
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

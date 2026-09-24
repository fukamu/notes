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
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/notes/backend/internal/access"
	accessadapter "github.com/fukamu/notes/backend/internal/adapters/access"
	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/launchgate"
	"github.com/fukamu/notes/backend/internal/synclegacy"
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
	writeStaticFixture(t, staticDirectory)
	logs := &bytes.Buffer{}
	handler, err := httpapi.NewHandler(httpapi.HandlerOptions{
		StaticDirectory:     staticDirectory,
		BodyLimit:           bodyLimit,
		Logger:              telemetry.NewLogger(logs, slog.LevelDebug),
		PrivateRuntime:      privateRuntime,
		EnableLocalFixtures: true,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler, logs
}

func writeStaticFixture(t *testing.T, directory string) {
	t.Helper()
	files := []string{"index.html", "favicon.svg", "manifest.webmanifest", "og.png", "sw.js"}
	for _, filename := range publicRouteFilesForTest() {
		files = append(files, filename)
	}
	for _, filename := range files {
		path := filepath.Join(directory, filepath.FromSlash(filename))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatalf("MkdirAll() error = %v", err)
		}
		if err := os.WriteFile(path, []byte("<!doctype html><title>Go bootstrap</title>"), 0o600); err != nil {
			t.Fatalf("WriteFile() error = %v", err)
		}
	}
	asset := filepath.Join(directory, "assets", "app-Ab12.js")
	if err := os.MkdirAll(filepath.Dir(asset), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(asset, []byte("export {};"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func publicRouteFilesForTest() []string {
	return []string{
		"account/billing/index.html", "account/privacy/index.html", "account/terms/index.html",
		"checkout/index.html", "company/index.html", "legal/commercial-transactions/index.html",
		"legal/external-transmission/index.html", "legal/privacy/index.html", "legal/terms/index.html",
		"pricing/index.html",
	}
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

type legacySyncFunction func(context.Context, synclegacy.Request) (synclegacy.Response, error)

func (synchronize legacySyncFunction) Sync(
	ctx context.Context,
	request synclegacy.Request,
) (synclegacy.Response, error) {
	return synchronize(ctx, request)
}

type trackingReadCloser struct {
	reads int
}

func (body *trackingReadCloser) Read([]byte) (int, error) {
	body.reads++
	return 0, errors.New("request body must not be read")
}

func (*trackingReadCloser) Close() error {
	return nil
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

func TestLegacySyncRequiresSignedAllowedOwnerAndSameOrigin(t *testing.T) {
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
	other, _ := access.ParseSubject("allowed-non-owner")
	ownerAssertion := signedAssertion(t, privateKey, owner, now)
	otherAssertion := signedAssertion(t, privateKey, other, now)
	publicOrigin, _ := url.Parse("https://notes.example")
	syncCalls := 0
	synchronize := legacySyncFunction(func(_ context.Context, request synclegacy.Request) (synclegacy.Response, error) {
		syncCalls++
		if request.DeviceID != "01991f20-61d2-7000-8000-000000001000" {
			t.Fatalf("sync request = %#v", request)
		}
		return emptyLegacySyncResponse(), nil
	})
	runtime := &httpapi.PrivateRuntime{
		Verifier: verifier,
		Gate: gateReaderFunction(func(_ context.Context, subject *access.Subject) (launchgate.Facts, error) {
			return launchgate.Facts{PublicAccessEnabled: true, UserAllowed: subject != nil}, nil
		}),
		Readiness:    readinessFunction(func(context.Context) error { return nil }),
		LegacySync:   synchronize,
		LegacyOwner:  owner,
		PublicOrigin: publicOrigin,
		Clock:        func() time.Time { return now },
	}
	handler, _ := testHandlerWithRuntime(t, 4_000_000, runtime)

	approved := legacySyncRequest(ownerAssertion, "https://notes.example", validEmptySyncBody())
	approvedResponse := httptest.NewRecorder()
	handler.ServeHTTP(approvedResponse, approved)
	if approvedResponse.Code != http.StatusOK || approvedResponse.Body.String() !=
		"{\"cards\":[],\"conflicts\":[],\"acknowledgedMutationIds\":[]}\n" || syncCalls != 1 {
		t.Fatalf("approved sync = %d %s, calls = %d", approvedResponse.Code, approvedResponse.Body.String(), syncCalls)
	}

	wrongMethod := httptest.NewRequest(http.MethodGet, "/api/sync", nil)
	wrongMethodResponse := httptest.NewRecorder()
	handler.ServeHTTP(wrongMethodResponse, wrongMethod)
	if wrongMethodResponse.Code != http.StatusMethodNotAllowed ||
		wrongMethodResponse.Header().Get("Allow") != "POST" || syncCalls != 1 {
		t.Fatalf(
			"wrong method sync = %d %s, allow = %q, calls = %d",
			wrongMethodResponse.Code,
			wrongMethodResponse.Body.String(),
			wrongMethodResponse.Header().Get("Allow"),
			syncCalls,
		)
	}

	deniedCases := map[string]func(*http.Request){
		"missing assertion": func(request *http.Request) {
			request.Header.Del(accessadapter.LocalAssertionHeader)
		},
		"unsigned assertion": func(request *http.Request) {
			request.Header.Set(accessadapter.LocalAssertionHeader, "private-owner")
		},
		"duplicate assertion": func(request *http.Request) {
			request.Header.Add(accessadapter.LocalAssertionHeader, ownerAssertion)
		},
		"old Sites header": func(request *http.Request) {
			request.Header.Set(accessadapter.LegacySitesHeader, string(owner))
		},
		"allowed non-owner": func(request *http.Request) {
			request.Header.Set(accessadapter.LocalAssertionHeader, otherAssertion)
		},
		"missing origin": func(request *http.Request) {
			request.Header.Del("Origin")
		},
		"cross-site origin": func(request *http.Request) {
			request.Header.Set("Origin", "https://evil.example")
		},
	}
	for name, mutate := range deniedCases {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			request := legacySyncRequest(ownerAssertion, "https://notes.example", validEmptySyncBody())
			mutate(request)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden ||
				response.Body.String() != "{\"error\":\"launch-access-denied\"}\n" {
				t.Fatalf("denied sync = %d %s", response.Code, response.Body.String())
			}
			if syncCalls != 1 {
				t.Fatalf("denied request reached sync store: %d calls", syncCalls)
			}
		})
	}

	unreadBody := &trackingReadCloser{}
	unauthenticated := legacySyncRequest("", "https://notes.example", "")
	unauthenticated.Body = unreadBody
	unauthenticated.ContentLength = -1
	unauthenticatedResponse := httptest.NewRecorder()
	handler.ServeHTTP(unauthenticatedResponse, unauthenticated)
	if unauthenticatedResponse.Code != http.StatusForbidden || unreadBody.reads != 0 {
		t.Fatalf(
			"unauthenticated sync = %d %s, body reads = %d",
			unauthenticatedResponse.Code,
			unauthenticatedResponse.Body.String(),
			unreadBody.reads,
		)
	}

	invalid := legacySyncRequest(ownerAssertion, "https://notes.example", "{")
	invalidResponse := httptest.NewRecorder()
	handler.ServeHTTP(invalidResponse, invalid)
	if invalidResponse.Code != http.StatusBadRequest ||
		invalidResponse.Body.String() != "{\"error\":\"同期データが正しくありません。\"}\n" ||
		syncCalls != 1 {
		t.Fatalf("invalid sync = %d %s, calls = %d", invalidResponse.Code, invalidResponse.Body.String(), syncCalls)
	}

	wrongContentType := legacySyncRequest(ownerAssertion, "https://notes.example", validEmptySyncBody())
	wrongContentType.Header.Set("Content-Type", "text/plain")
	wrongContentResponse := httptest.NewRecorder()
	handler.ServeHTTP(wrongContentResponse, wrongContentType)
	if wrongContentResponse.Code != http.StatusBadRequest || syncCalls != 1 {
		t.Fatalf("wrong content type = %d %s, calls = %d", wrongContentResponse.Code, wrongContentResponse.Body.String(), syncCalls)
	}

	contractLimitHandler, _ := testHandlerWithRuntime(
		t,
		int64(synclegacy.MaximumPayloadBytes)+1,
		runtime,
	)
	contractOversized := legacySyncRequest(ownerAssertion, "https://notes.example", validEmptySyncBody())
	contractOversized.ContentLength = int64(synclegacy.MaximumPayloadBytes) + 1
	contractOversizedResponse := httptest.NewRecorder()
	contractLimitHandler.ServeHTTP(contractOversizedResponse, contractOversized)
	if contractOversizedResponse.Code != http.StatusRequestEntityTooLarge || syncCalls != 1 {
		t.Fatalf(
			"contract oversized sync = %d %s, calls = %d",
			contractOversizedResponse.Code,
			contractOversizedResponse.Body.String(),
			syncCalls,
		)
	}

	smallHandler, _ := testHandlerWithRuntime(t, 8, runtime)
	oversized := legacySyncRequest(ownerAssertion, "https://notes.example", validEmptySyncBody())
	oversized.ContentLength = -1
	oversizedResponse := httptest.NewRecorder()
	smallHandler.ServeHTTP(oversizedResponse, oversized)
	if oversizedResponse.Code != http.StatusRequestEntityTooLarge ||
		oversizedResponse.Body.String() != "{\"error\":\"同期データが正しくありません。\"}\n" ||
		syncCalls != 1 {
		t.Fatalf("oversized sync = %d %s, calls = %d", oversizedResponse.Code, oversizedResponse.Body.String(), syncCalls)
	}
}

func TestLegacySyncSanitizesGateAndStoreFailures(t *testing.T) {
	publicKey, privateKey, _ := ed25519.GenerateKey(nil)
	verifier, _ := accessadapter.NewLocalVerifier(publicKey, "https://issuer.test", "notes-local")
	now := time.Unix(1_800_000_000, 0)
	owner, _ := access.ParseSubject("private-owner")
	assertion := signedAssertion(t, privateKey, owner, now)
	publicOrigin, _ := url.Parse("https://notes.example")
	rawFailure := errors.New("raw private database detail")

	for name, test := range map[string]struct {
		gate        gateReaderFunction
		synchronize legacySyncFunction
		status      int
	}{
		"gate denial": {
			gate: func(context.Context, *access.Subject) (launchgate.Facts, error) {
				return launchgate.Facts{}, nil
			},
			synchronize: func(context.Context, synclegacy.Request) (synclegacy.Response, error) {
				t.Fatal("gate denial reached sync store")
				return synclegacy.Response{}, nil
			},
			status: http.StatusForbidden,
		},
		"gate failure": {
			gate: func(context.Context, *access.Subject) (launchgate.Facts, error) {
				return launchgate.Facts{}, rawFailure
			},
			synchronize: func(context.Context, synclegacy.Request) (synclegacy.Response, error) {
				t.Fatal("gate failure reached sync store")
				return synclegacy.Response{}, nil
			},
			status: http.StatusServiceUnavailable,
		},
		"store failure": {
			gate: func(context.Context, *access.Subject) (launchgate.Facts, error) {
				return launchgate.Facts{UserAllowed: true}, nil
			},
			synchronize: func(context.Context, synclegacy.Request) (synclegacy.Response, error) {
				return synclegacy.Response{}, rawFailure
			},
			status: http.StatusInternalServerError,
		},
		"invalid store response": {
			gate: func(context.Context, *access.Subject) (launchgate.Facts, error) {
				return launchgate.Facts{UserAllowed: true}, nil
			},
			synchronize: func(context.Context, synclegacy.Request) (synclegacy.Response, error) {
				return synclegacy.Response{}, nil
			},
			status: http.StatusInternalServerError,
		},
	} {
		name, test := name, test
		t.Run(name, func(t *testing.T) {
			runtime := &httpapi.PrivateRuntime{
				Verifier:     verifier,
				Gate:         test.gate,
				Readiness:    readinessFunction(func(context.Context) error { return nil }),
				LegacySync:   test.synchronize,
				LegacyOwner:  owner,
				PublicOrigin: publicOrigin,
				Clock:        func() time.Time { return now },
			}
			handler, logs := testHandlerWithRuntime(t, 4_000_000, runtime)
			request := legacySyncRequest(assertion, "https://notes.example", validEmptySyncBody())
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.status || strings.Contains(response.Body.String(), rawFailure.Error()) ||
				strings.Contains(logs.String(), rawFailure.Error()) {
				t.Fatalf("failure response = %d %s; logs = %s", response.Code, response.Body.String(), logs.String())
			}
		})
	}
}

func TestDisconnectedAPIsPreserveLocalFixturesAndStayClosedInProduction(t *testing.T) {
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
	assertion := signedAssertion(t, privateKey, owner, now)
	runtime := &httpapi.PrivateRuntime{
		Verifier: verifier,
		Gate: gateReaderFunction(func(_ context.Context, subject *access.Subject) (launchgate.Facts, error) {
			return launchgate.Facts{UserAllowed: subject != nil && *subject == owner}, nil
		}),
		Clock: func() time.Time { return now },
	}
	local, _ := testHandlerWithRuntime(t, 1024, runtime)

	protected := httptest.NewRequest(http.MethodPost, "/api/billing/checkout", nil)
	protected.Header.Set(accessadapter.LocalAssertionHeader, assertion)
	protectedResponse := httptest.NewRecorder()
	local.ServeHTTP(protectedResponse, protected)
	if protectedResponse.Code != http.StatusNotFound ||
		protectedResponse.Body.String() != "{\"error\":\"not-found\"}\n" {
		t.Fatalf("local protected fixture = %d %s", protectedResponse.Code, protectedResponse.Body.String())
	}

	denied := httptest.NewRecorder()
	deniedBody := &trackingReadCloser{}
	deniedRequest := httptest.NewRequest(http.MethodPost, "/api/v2/sync", nil)
	deniedRequest.Body = deniedBody
	deniedRequest.ContentLength = 2048
	local.ServeHTTP(denied, deniedRequest)
	if denied.Code != http.StatusForbidden {
		t.Fatalf("unapproved disconnected API = %d %s", denied.Code, denied.Body.String())
	}
	if deniedBody.reads != 0 {
		t.Fatal("protected disconnected API read the body before authorization")
	}

	publicResponse := httptest.NewRecorder()
	local.ServeHTTP(publicResponse, httptest.NewRequest(http.MethodPost, "/api/billing/cancel", nil))
	if publicResponse.Code != http.StatusNotFound ||
		publicResponse.Body.String() != "{\"error\":\"not-found\"}\n" {
		t.Fatalf("local public fixture = %d %s", publicResponse.Code, publicResponse.Body.String())
	}

	staticDirectory := t.TempDir()
	writeStaticFixture(t, staticDirectory)
	production, err := httpapi.NewHandler(httpapi.HandlerOptions{
		StaticDirectory:     staticDirectory,
		BodyLimit:           1024,
		Logger:              slog.New(slog.NewTextHandler(io.Discard, nil)),
		PrivateRuntime:      runtime,
		EnableLocalFixtures: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	productionRequest := httptest.NewRequest(http.MethodPost, "/api/billing/checkout", nil)
	productionRequest.Header.Set(accessadapter.LocalAssertionHeader, assertion)
	productionResponse := httptest.NewRecorder()
	production.ServeHTTP(productionResponse, productionRequest)
	if productionResponse.Code != http.StatusServiceUnavailable ||
		productionResponse.Body.String() != "{\"error\":\"unavailable\"}\n" {
		t.Fatalf("production disconnected API = %d %s", productionResponse.Code, productionResponse.Body.String())
	}
}

func signedAssertion(
	t *testing.T,
	privateKey ed25519.PrivateKey,
	subject access.Subject,
	now time.Time,
) string {
	t.Helper()
	assertion, err := accessadapter.SignLocalAssertion(
		privateKey,
		"https://issuer.test",
		"notes-local",
		subject,
		now.Add(-time.Minute),
		now.Add(time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	return assertion
}

func legacySyncRequest(assertion string, origin string, body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/sync", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(accessadapter.LocalAssertionHeader, assertion)
	request.Header.Set("Origin", origin)
	return request
}

func validEmptySyncBody() string {
	return `{"deviceId":"01991f20-61d2-7000-8000-000000001000","mutations":[]}`
}

func emptyLegacySyncResponse() synclegacy.Response {
	return synclegacy.Response{
		Cards:                   []synclegacy.Card{},
		Conflicts:               []synclegacy.Conflict{},
		AcknowledgedMutationIDs: []synclegacy.MutationID{},
	}
}

func TestPrivateReadinessRequiresAllDependenciesAndDatabase(t *testing.T) {
	t.Parallel()
	publicKey, _, _ := ed25519.GenerateKey(nil)
	verifier, _ := accessadapter.NewLocalVerifier(publicKey, "https://issuer.test", "notes-local")
	publicOrigin, _ := url.Parse("https://notes.example")
	legacySync := legacySyncFunction(func(context.Context, synclegacy.Request) (synclegacy.Response, error) {
		return synclegacy.Response{
			Cards: []synclegacy.Card{}, Conflicts: []synclegacy.Conflict{},
			AcknowledgedMutationIDs: []synclegacy.MutationID{},
		}, nil
	})
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
				LegacySync:   legacySync,
				LegacyOwner:  "owner",
				PublicOrigin: publicOrigin,
				Clock:        time.Now,
			},
			status: http.StatusServiceUnavailable,
			body:   "not_ready",
		},
		"ready": {
			runtime: &httpapi.PrivateRuntime{
				Verifier:     verifier,
				Gate:         gate,
				Readiness:    readinessFunction(func(context.Context) error { return nil }),
				LegacySync:   legacySync,
				LegacyOwner:  "owner",
				PublicOrigin: publicOrigin,
				Clock:        time.Now,
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

func TestHandlerServesKnownFrontendRoutesAssetsAndProcessHealth(t *testing.T) {
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
			name:        "notes deep link",
			path:        "/cards/01991f20-61d2-7000-8000-000000001000/connections",
			status:      http.StatusOK,
			contentType: "text/html; charset=utf-8",
			body:        "Go bootstrap",
		},
		{
			name:        "public prerender",
			path:        "/legal/privacy",
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

func TestStaticResponsesApplySecurityAndCachePolicy(t *testing.T) {
	t.Parallel()
	handler, _ := testHandler(t, 1024)

	for _, path := range []string{"/", "/history", "/pricing"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("GET %s = %d, cache = %q", path, response.Code, response.Header().Get("Cache-Control"))
		}
		if !strings.Contains(response.Header().Get("Content-Security-Policy"), "script-src 'self'") ||
			strings.Contains(response.Header().Get("Content-Security-Policy"), "script-src 'self' 'unsafe-inline'") ||
			response.Header().Get("X-Frame-Options") != "DENY" {
			t.Fatalf("GET %s security headers = %#v", path, response.Header())
		}
	}

	asset := httptest.NewRecorder()
	handler.ServeHTTP(asset, httptest.NewRequest(http.MethodGet, "/assets/app-Ab12.js", nil))
	if asset.Code != http.StatusOK || asset.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("asset = %d, cache = %q", asset.Code, asset.Header().Get("Cache-Control"))
	}

	worker := httptest.NewRecorder()
	handler.ServeHTTP(worker, httptest.NewRequest(http.MethodGet, "/sw.js", nil))
	if worker.Code != http.StatusOK || worker.Header().Get("Cache-Control") != "no-cache" ||
		worker.Header().Get("Service-Worker-Allowed") != "/" {
		t.Fatalf("worker headers = %#v", worker.Header())
	}

	for _, path := range []string{
		"/api/missing", "/pricing/", "/cards/id/unknown", "/.vite/manifest.json", "/index.html",
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusNotFound || strings.Contains(response.Body.String(), "Go bootstrap") {
			t.Fatalf("GET %s = %d %s", path, response.Code, response.Body.String())
		}
	}
}

func TestNewHandlerRejectsStaticSymlink(t *testing.T) {
	t.Parallel()
	staticDirectory := t.TempDir()
	writeStaticFixture(t, staticDirectory)
	if err := os.Symlink(filepath.Join(staticDirectory, "index.html"), filepath.Join(staticDirectory, "assets", "linked.js")); err != nil {
		t.Fatal(err)
	}
	handler, err := httpapi.NewHandler(httpapi.HandlerOptions{
		StaticDirectory: staticDirectory,
		BodyLimit:       1024,
		Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err == nil || handler != nil {
		t.Fatal("NewHandler must reject symbolic links in static assets")
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
	for _, path := range []string{"/", "/pricing", "/assets/app-Ab12.js", "/healthz", "/readyz", "/api/sync", "/missing"} {
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

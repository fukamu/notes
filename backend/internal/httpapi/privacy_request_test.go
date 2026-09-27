package httpapi_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/privacyrequest"
)

const (
	privacyTestOrigin    = "https://notes.example"
	privacyTestToken     = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	privacyTestAccountID = "01991f20-61d2-7000-8000-000000000151"
	privacyTestVaultID   = "01991f20-61d2-7000-8000-000000000251"
	privacyTestSessionID = "01991f20-61d2-7000-8000-000000000351"
	privacyTestRequestID = "01991f20-61d2-7000-8000-000000002501"
)

type privacySessionStub struct {
	session *identity.Session
	calls   int
}

func (stub *privacySessionStub) FindSessionByToken(context.Context, identity.SessionToken) (*identity.Session, error) {
	stub.calls++
	return stub.session, nil
}

type privacyApplicationStub struct {
	result      privacyrequest.ApplicationResult
	submitScope privacyrequest.Scope
	statusScope privacyrequest.Scope
	submitCalls int
	statusCalls int
}

func (stub *privacyApplicationStub) Submit(
	_ context.Context,
	scope privacyrequest.Scope,
	_ privacyrequest.SubmitCommand,
	_ privacyrequest.RequestID,
	_ int64,
) (privacyrequest.ApplicationResult, error) {
	stub.submitCalls++
	stub.submitScope = scope
	return stub.result, nil
}

func (stub *privacyApplicationStub) Status(
	_ context.Context,
	scope privacyrequest.Scope,
	_ privacyrequest.RequestID,
) (privacyrequest.ApplicationResult, error) {
	stub.statusCalls++
	stub.statusScope = scope
	return stub.result, nil
}

type privacyTrackingBody struct{ reads int }

func (body *privacyTrackingBody) Read([]byte) (int, error) {
	body.reads++
	return 0, io.EOF
}

func (body *privacyTrackingBody) Close() error { return nil }

func TestPrivacyRequestContractAuthenticatesBeforeBody(t *testing.T) {
	for _, test := range []struct {
		name string
		path string
		pick func(httpapi.PrivacyRequestContractHandlers) http.Handler
	}{
		{name: "submit", path: "/api/account/privacy-requests", pick: func(handlers httpapi.PrivacyRequestContractHandlers) http.Handler { return handlers.Submit }},
		{name: "status", path: "/api/account/privacy-requests/status", pick: func(handlers httpapi.PrivacyRequestContractHandlers) http.Handler { return handlers.Status }},
	} {
		t.Run(test.name, func(t *testing.T) {
			handlers, sessions, application := newPrivacyHTTPHandlers(t)
			body := &privacyTrackingBody{}
			request := httptest.NewRequest(http.MethodPost, test.path, nil)
			request.Body = body
			request.Header.Set("Origin", privacyTestOrigin)
			request.Header.Set("Sec-Fetch-Site", "same-origin")
			response := httptest.NewRecorder()
			test.pick(handlers).ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized || body.reads != 0 || sessions.calls != 0 ||
				application.submitCalls != 0 || application.statusCalls != 0 {
				t.Fatalf("response=%d reads=%d sessions=%d submit=%d status=%d", response.Code, body.reads, sessions.calls, application.submitCalls, application.statusCalls)
			}
		})
	}
}

func TestPrivacyRequestContractSuccessAndFailureMappings(t *testing.T) {
	handlers, _, application := newPrivacyHTTPHandlers(t)
	response := httptest.NewRecorder()
	handlers.Submit.ServeHTTP(response, authenticatedPrivacyRequest(
		"/api/account/privacy-requests",
		`{"submissionId":"01991f20-61d2-7000-8000-000000002601","requestKind":"disclosure"}`,
	))
	if response.Code != http.StatusAccepted || response.Header().Get("Cache-Control") != "no-store" ||
		!strings.Contains(response.Body.String(), `"status":"verification-pending"`) ||
		application.submitScope.AccountID != identity.AccountID(privacyTestAccountID) ||
		application.submitScope.VaultID != identity.VaultID(privacyTestVaultID) {
		t.Fatalf("submit = %d %s scope=%#v", response.Code, response.Body.String(), application.submitScope)
	}

	application.result = privacyrequest.ApplicationResult{
		Kind: privacyrequest.ApplicationAccepted,
		Request: &privacyrequest.PublicStatus{
			RequestID: privacyTestRequestID, RequestKind: privacyrequest.KindDisclosure,
			RequestedAt: 1_000, UpdatedAt: 1_300,
			Status: privacyrequest.StateCompleted, Outcome: privacyrequest.OutcomeFulfilled,
		},
	}
	response = httptest.NewRecorder()
	handlers.Status.ServeHTTP(response, authenticatedPrivacyRequest(
		"/api/account/privacy-requests/status",
		`{"requestId":"`+privacyTestRequestID+`"}`,
	))
	if response.Code != http.StatusOK || application.statusCalls != 1 ||
		application.statusScope != application.submitScope {
		t.Fatalf("status = %d %s scope=%#v", response.Code, response.Body.String(), application.statusScope)
	}

	for _, test := range []struct {
		name   string
		body   string
		result privacyrequest.ApplicationResult
		want   int
	}{
		{name: "unknown", body: `{"submissionId":"01991f20-61d2-7000-8000-000000002601","requestKind":"disclosure","unknown":true}`, want: http.StatusBadRequest},
		{name: "conflict", body: `{"submissionId":"01991f20-61d2-7000-8000-000000002601","requestKind":"disclosure"}`, result: privacyrequest.ApplicationResult{Kind: privacyrequest.ApplicationRejected, Reason: privacyrequest.ApplicationIdentifierConflict}, want: http.StatusConflict},
		{name: "not found", body: `{"submissionId":"01991f20-61d2-7000-8000-000000002601","requestKind":"disclosure"}`, result: privacyrequest.ApplicationResult{Kind: privacyrequest.ApplicationRejected, Reason: privacyrequest.ApplicationNotFound}, want: http.StatusNotFound},
		{name: "future failure", body: `{"submissionId":"01991f20-61d2-7000-8000-000000002601","requestKind":"disclosure"}`, result: privacyrequest.ApplicationResult{Kind: privacyrequest.ApplicationRejected, Reason: "future"}, want: http.StatusServiceUnavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			application.result = test.result
			candidate := httptest.NewRecorder()
			handlers.Submit.ServeHTTP(candidate, authenticatedPrivacyRequest("/api/account/privacy-requests", test.body))
			if candidate.Code != test.want || candidate.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("response = %d %s", candidate.Code, candidate.Body.String())
			}
		})
	}
}

func TestPrivacyRequestContractRejectsCSRFAndLargeBody(t *testing.T) {
	handlers, _, application := newPrivacyHTTPHandlers(t)
	request := authenticatedPrivacyRequest("/api/account/privacy-requests", `{}`)
	request.Header.Set("Origin", "https://evil.example")
	response := httptest.NewRecorder()
	handlers.Submit.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || application.submitCalls != 0 {
		t.Fatalf("CSRF response = %d calls=%d", response.Code, application.submitCalls)
	}

	request = authenticatedPrivacyRequest("/api/account/privacy-requests", `{}`)
	request.Header["Content-Length"] = []string{"2049"}
	response = httptest.NewRecorder()
	handlers.Submit.ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge || !strings.Contains(response.Body.String(), "request-too-large") {
		t.Fatalf("large response = %d %s", response.Code, response.Body.String())
	}
}

func TestPrivacyRequestMuxAuthenticatesBeforeConfiguredBodyLimit(t *testing.T) {
	runtime, sessions, application := newPrivacyRuntime()
	staticDirectory := t.TempDir()
	writeStaticFixture(t, staticDirectory)
	handler, err := httpapi.NewHandler(httpapi.HandlerOptions{
		StaticDirectory:       staticDirectory,
		BodyLimit:             64,
		Logger:                slog.New(slog.NewTextHandler(io.Discard, nil)),
		PrivacyRequestRuntime: runtime,
	})
	if err != nil {
		t.Fatal(err)
	}

	body := &privacyTrackingBody{}
	unauthenticated := httptest.NewRequest(http.MethodPost, "/api/account/privacy-requests", nil)
	unauthenticated.Body = body
	unauthenticated.ContentLength = 65
	unauthenticated.Header.Set("Origin", privacyTestOrigin)
	unauthenticated.Header.Set("Sec-Fetch-Site", "same-origin")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, unauthenticated)
	if response.Code != http.StatusUnauthorized || body.reads != 0 || sessions.calls != 0 {
		t.Fatalf("unauthenticated = %d reads=%d sessions=%d", response.Code, body.reads, sessions.calls)
	}

	oversized := authenticatedPrivacyRequest(
		"/api/account/privacy-requests",
		`{"submissionId":"01991f20-61d2-7000-8000-000000002601","requestKind":"disclosure"}`,
	)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, oversized)
	if response.Code != http.StatusRequestEntityTooLarge || sessions.calls != 1 || application.submitCalls != 0 ||
		!strings.Contains(response.Body.String(), "request-too-large") {
		t.Fatalf("oversized = %d %s sessions=%d calls=%d", response.Code, response.Body.String(), sessions.calls, application.submitCalls)
	}
}

func TestPrivacyRequestMuxFailsClosedWithoutCompleteRuntime(t *testing.T) {
	staticDirectory := t.TempDir()
	writeStaticFixture(t, staticDirectory)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	closed, err := httpapi.NewHandler(httpapi.HandlerOptions{
		StaticDirectory: staticDirectory,
		BodyLimit:       2048,
		Logger:          logger,
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	closed.ServeHTTP(response, authenticatedPrivacyRequest(
		"/api/account/privacy-requests",
		`{"submissionId":"01991f20-61d2-7000-8000-000000002601","requestKind":"disclosure"}`,
	))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("closed route = %d %s", response.Code, response.Body.String())
	}

	for _, test := range []struct {
		name   string
		mutate func(*httpapi.PrivacyRequestRuntime)
	}{
		{name: "origin", mutate: func(runtime *httpapi.PrivacyRequestRuntime) { runtime.ExpectedOrigin = "https://notes.example/" }},
		{name: "clock", mutate: func(runtime *httpapi.PrivacyRequestRuntime) { runtime.Clock = nil }},
		{name: "sessions", mutate: func(runtime *httpapi.PrivacyRequestRuntime) { runtime.Sessions = nil }},
		{name: "application", mutate: func(runtime *httpapi.PrivacyRequestRuntime) { runtime.Application = nil }},
		{name: "request ID", mutate: func(runtime *httpapi.PrivacyRequestRuntime) { runtime.NewRequestID = nil }},
	} {
		t.Run(test.name, func(t *testing.T) {
			runtime, _, _ := newPrivacyRuntime()
			test.mutate(runtime)
			if _, err := httpapi.NewHandler(httpapi.HandlerOptions{
				StaticDirectory:       staticDirectory,
				BodyLimit:             2048,
				Logger:                logger,
				PrivacyRequestRuntime: runtime,
			}); err == nil || !strings.Contains(err.Error(), "privacy request runtime is incomplete") {
				t.Fatalf("incomplete runtime error = %v", err)
			}
		})
	}
}

func TestPrivacyRequestContractRejectsInvalidGeneratedRequestID(t *testing.T) {
	runtime, _, application := newPrivacyRuntime()
	runtime.NewRequestID = func() string { return "not-a-request-id" }
	handlers, err := httpapi.NewPrivacyRequestContractHandlers(
		runtime,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handlers.Submit.ServeHTTP(response, authenticatedPrivacyRequest(
		"/api/account/privacy-requests",
		`{"submissionId":"01991f20-61d2-7000-8000-000000002601","requestKind":"disclosure"}`,
	))
	if response.Code != http.StatusServiceUnavailable || application.submitCalls != 0 {
		t.Fatalf("invalid generated id = %d %s calls=%d", response.Code, response.Body.String(), application.submitCalls)
	}
}

func newPrivacyHTTPHandlers(t *testing.T) (httpapi.PrivacyRequestContractHandlers, *privacySessionStub, *privacyApplicationStub) {
	t.Helper()
	runtime, sessions, application := newPrivacyRuntime()
	handlers, err := httpapi.NewPrivacyRequestContractHandlers(
		runtime,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	if err != nil {
		t.Fatal(err)
	}
	return handlers, sessions, application
}

func newPrivacyRuntime() (*httpapi.PrivacyRequestRuntime, *privacySessionStub, *privacyApplicationStub) {
	sessions := &privacySessionStub{session: &identity.Session{
		Kind: identity.SessionActive, SessionID: privacyTestSessionID,
		AccountID: privacyTestAccountID, VaultID: privacyTestVaultID,
		SessionEpoch: 1, IssuedAt: 1_000, ExpiresAt: 2_000,
	}}
	requestID, _ := privacyrequest.ParseRequestID(privacyTestRequestID)
	application := &privacyApplicationStub{result: privacyrequest.ApplicationResult{
		Kind: privacyrequest.ApplicationAccepted,
		Request: &privacyrequest.PublicStatus{
			RequestID: requestID, RequestKind: privacyrequest.KindDisclosure,
			RequestedAt: 1_500, UpdatedAt: 1_500, Status: privacyrequest.StateVerificationPending,
		},
	}}
	runtime := &httpapi.PrivacyRequestRuntime{
		ExpectedOrigin: privacyTestOrigin, Clock: func() int64 { return 1_500 },
		Sessions: sessions, Application: application,
		NewRequestID: func() string { return privacyTestRequestID },
	}
	return runtime, sessions, application
}

func authenticatedPrivacyRequest(path string, body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Cookie", identity.SessionCookieName+"="+privacyTestToken)
	request.Header.Set("Origin", privacyTestOrigin)
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	return request
}

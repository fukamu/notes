package httpapi_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/identity"
)

const (
	accountDeletionOrigin      = "https://notes.example"
	accountDeletionSession     = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	accountDeletionAccountID   = "01991f20-61d2-7000-8000-000000000181"
	accountDeletionVaultID     = "01991f20-61d2-7000-8000-000000000281"
	accountDeletionSessionID   = "01991f20-61d2-7000-8000-000000000381"
	accountDeletionOperationID = "01991f20-61d2-7000-8000-000000002801"
)

type accountDeletionSessionStub struct {
	session *identity.Session
	calls   int
}

func (stub *accountDeletionSessionStub) FindSessionByToken(context.Context, identity.SessionToken) (*identity.Session, error) {
	stub.calls++
	return stub.session, nil
}

type accountDeletionApplicationStub struct {
	result      accountdeletion.ApplicationResult
	err         error
	startScope  accountdeletion.Scope
	startCalls  int
	resumeCalls int
}

func (stub *accountDeletionApplicationStub) Start(
	_ context.Context,
	scope accountdeletion.Scope,
	_ accountdeletion.StartCommand,
	_ accountdeletion.OperationID,
	_ int64,
) (accountdeletion.ApplicationResult, error) {
	stub.startCalls++
	stub.startScope = scope
	return stub.result, stub.err
}

func (stub *accountDeletionApplicationStub) Resume(
	_ context.Context,
	_ accountdeletion.ResumeCommand,
	_ int64,
) (accountdeletion.ApplicationResult, error) {
	stub.resumeCalls++
	return stub.result, stub.err
}

type accountDeletionTrackingBody struct{ reads int }

func (body *accountDeletionTrackingBody) Read([]byte) (int, error) {
	body.reads++
	return 0, io.EOF
}

func (body *accountDeletionTrackingBody) Close() error { return nil }

func TestAccountDeletionStartAuthenticatesBeforeBody(t *testing.T) {
	handlers, sessions, application, _ := newAccountDeletionHTTPHandlers(t)
	body := &accountDeletionTrackingBody{}
	request := accountDeletionRequest("/api/account/deletion", "")
	request.Body = body
	response := httptest.NewRecorder()
	handlers.Start.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || body.reads != 0 || sessions.calls != 0 || application.startCalls != 0 {
		t.Fatalf("response=%d reads=%d sessions=%d application=%d", response.Code, body.reads, sessions.calls, application.startCalls)
	}
}

func TestAccountDeletionStartAndContinuationContracts(t *testing.T) {
	handlers, _, application, token := newAccountDeletionHTTPHandlers(t)
	request := accountDeletionRequest("/api/account/deletion", `{"idempotencyKey":"`+strings.Repeat("I", 43)+`"}`)
	request.Header.Set("Cookie", identity.SessionCookieName+"="+accountDeletionSession)
	response := httptest.NewRecorder()
	handlers.Start.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted || response.Header().Get("Cache-Control") != "no-store" ||
		response.Header().Get("X-Content-Type-Options") != "nosniff" ||
		response.Header().Get("Set-Cookie") != "" ||
		!strings.Contains(response.Body.String(), string(token)) ||
		application.startScope.AccountID != identity.AccountID(accountDeletionAccountID) ||
		application.startScope.VaultID != identity.VaultID(accountDeletionVaultID) {
		t.Fatalf("start = %d %s headers=%v scope=%#v", response.Code, response.Body.String(), response.Header(), application.startScope)
	}

	application.result = accountdeletion.ApplicationResult{
		Kind:     accountdeletion.ApplicationAccepted,
		Response: &accountdeletion.PublicResponse{Status: accountdeletion.PublicCompleted},
	}
	response = httptest.NewRecorder()
	handlers.Resume.ServeHTTP(response, accountDeletionRequest(
		"/api/account/deletion/status", `{"continuationToken":"`+string(token)+`"}`,
	))
	if response.Code != http.StatusOK || application.resumeCalls != 1 ||
		strings.Contains(response.Body.String(), "continuationToken") ||
		response.Header().Get("Set-Cookie") != identity.ClearSessionCookie() {
		t.Fatalf("resume = %d %s headers=%v", response.Code, response.Body.String(), response.Header())
	}
}

func TestAccountDeletionContinuationRequiresCSRFFirstAndLimitsBody(t *testing.T) {
	handlers, _, application, token := newAccountDeletionHTTPHandlers(t)
	body := &accountDeletionTrackingBody{}
	request := accountDeletionRequest("/api/account/deletion/status", "")
	request.Body = body
	request.Header.Set("Origin", "https://evil.example")
	response := httptest.NewRecorder()
	handlers.Resume.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || body.reads != 0 || application.resumeCalls != 0 {
		t.Fatalf("csrf response=%d reads=%d application=%d", response.Code, body.reads, application.resumeCalls)
	}

	request = accountDeletionRequest("/api/account/deletion/status", `{"continuationToken":"`+string(token)+`"}`)
	request.Header["Content-Length"] = []string{"2049"}
	response = httptest.NewRecorder()
	handlers.Resume.ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge || !strings.Contains(response.Body.String(), "request-too-large") {
		t.Fatalf("large response = %d %s", response.Code, response.Body.String())
	}
}

func TestAccountDeletionContinuationUsesOneGenericCapabilityDenial(t *testing.T) {
	handlers, _, application, token := newAccountDeletionHTTPHandlers(t)
	malformed := httptest.NewRecorder()
	handlers.Resume.ServeHTTP(malformed, accountDeletionRequest(
		"/api/account/deletion/status", `{"continuationToken":"invalid"}`,
	))
	application.result = accountdeletion.ApplicationResult{
		Kind: accountdeletion.ApplicationRejected, Reason: accountdeletion.ApplicationInvalidCapability,
	}
	unknown := httptest.NewRecorder()
	handlers.Resume.ServeHTTP(unknown, accountDeletionRequest(
		"/api/account/deletion/status", `{"continuationToken":"`+string(token)+`"}`,
	))
	if malformed.Code != http.StatusUnauthorized || unknown.Code != http.StatusUnauthorized ||
		malformed.Body.String() != unknown.Body.String() || !strings.Contains(unknown.Body.String(), "continuation-required") {
		t.Fatalf("malformed=%d %s unknown=%d %s", malformed.Code, malformed.Body.String(), unknown.Code, unknown.Body.String())
	}
}

func TestAccountDeletionErrorsDoNotLogCapabilities(t *testing.T) {
	var logs bytes.Buffer
	handlers, _, application, token := newAccountDeletionHTTPHandlersWithLogger(t, slog.New(slog.NewTextHandler(&logs, nil)))
	application.err = errors.New("secret provider failure: " + string(token))
	response := httptest.NewRecorder()
	handlers.Resume.ServeHTTP(response, accountDeletionRequest(
		"/api/account/deletion/status", `{"continuationToken":"`+string(token)+`"}`,
	))
	if response.Code != http.StatusServiceUnavailable || strings.Contains(logs.String(), string(token)) ||
		!strings.Contains(logs.String(), "application_failure") {
		t.Fatalf("response=%d logs=%q", response.Code, logs.String())
	}
}

func TestAccountDeletionConstructorRejectsIncompleteRuntime(t *testing.T) {
	if _, err := httpapi.NewAccountDeletionContractHandlers(nil, slog.Default()); err == nil {
		t.Fatal("nil runtime was accepted")
	}
}

func newAccountDeletionHTTPHandlers(
	t *testing.T,
) (httpapi.AccountDeletionContractHandlers, *accountDeletionSessionStub, *accountDeletionApplicationStub, accountdeletion.ContinuationToken) {
	t.Helper()
	return newAccountDeletionHTTPHandlersWithLogger(t, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func newAccountDeletionHTTPHandlersWithLogger(
	t *testing.T,
	logger *slog.Logger,
) (httpapi.AccountDeletionContractHandlers, *accountDeletionSessionStub, *accountDeletionApplicationStub, accountdeletion.ContinuationToken) {
	t.Helper()
	secret, _ := accountdeletion.ParseContinuationSecret(strings.Repeat("S", 43))
	token, _ := accountdeletion.CreateContinuationToken(secret, 0)
	sessions := &accountDeletionSessionStub{session: &identity.Session{
		Kind: identity.SessionActive, SessionID: accountDeletionSessionID,
		AccountID: accountDeletionAccountID, VaultID: accountDeletionVaultID,
		SessionEpoch: 1, IssuedAt: 1_000, ExpiresAt: 2_000,
	}}
	application := &accountDeletionApplicationStub{result: accountdeletion.ApplicationResult{
		Kind: accountdeletion.ApplicationAccepted,
		Response: &accountdeletion.PublicResponse{
			Status: accountdeletion.PublicInProgress, ContinuationToken: token,
		},
	}}
	handlers, err := httpapi.NewAccountDeletionContractHandlers(&httpapi.AccountDeletionRuntime{
		ExpectedOrigin: accountDeletionOrigin, Clock: func() int64 { return 1_500 },
		Sessions: sessions, Application: application,
		NewOperationID: func() string { return accountDeletionOperationID },
	}, logger)
	if err != nil {
		t.Fatal(err)
	}
	return handlers, sessions, application, token
}

func accountDeletionRequest(path string, body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Origin", accountDeletionOrigin)
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	return request
}

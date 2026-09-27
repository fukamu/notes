package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/identity"
)

const (
	billingCancellationOrigin    = "https://notes.example"
	billingCancellationAccountID = "01991f20-61d2-7000-8000-000000000101"
	billingCancellationVaultID   = "01991f20-61d2-7000-8000-000000000201"
	billingCancellationSessionID = "01991f20-61d2-7000-8000-000000000301"
	billingCancellationToken     = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	billingCancellationKey       = "01991f20-61d2-7000-8000-000000000801"
)

type billingCancellationSessionStub struct {
	session *identity.Session
	err     error
}

func (stub *billingCancellationSessionStub) FindSessionByToken(context.Context, identity.SessionToken) (*identity.Session, error) {
	return stub.session, stub.err
}

type billingCancellationApplicationStub struct {
	result  billing.SubscriptionCancellationResult
	err     error
	command billing.SubscriptionCancellationCommand
	calls   int
}

func (stub *billingCancellationApplicationStub) ScheduleSubscriptionCancellation(
	_ context.Context,
	command billing.SubscriptionCancellationCommand,
) (billing.SubscriptionCancellationResult, error) {
	stub.calls++
	stub.command = command
	return stub.result, stub.err
}

func TestBillingCancellationContractReturnsProviderConfirmedPeriodEnd(t *testing.T) {
	application := &billingCancellationApplicationStub{result: billing.SubscriptionCancellationResult{
		Kind: billing.SubscriptionCancellationConfirmed, Outcome: billing.SubscriptionCancellationScheduled,
		ConfirmedAt: 1_500, AccessEndsAt: 9_000,
	}}
	handler, _ := billingCancellationContractHandler(t, application)
	response := serveBillingCancellation(handler, billingCancellationRequest(
		http.MethodPost,
		`{"idempotencyKey":"`+billingCancellationKey+`"}`,
	))
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("response = %d %#v", response.Code, response.Header())
	}
	var body struct {
		Status       string                                  `json:"status"`
		Outcome      billing.SubscriptionCancellationOutcome `json:"outcome"`
		ConfirmedAt  int64                                   `json:"confirmedAt"`
		AccessEndsAt int64                                   `json:"accessEndsAt"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Status != "cancellation-scheduled" || body.Outcome != billing.SubscriptionCancellationScheduled ||
		body.ConfirmedAt != 1_500 || body.AccessEndsAt != 9_000 {
		t.Fatalf("body = %#v", body)
	}
	if application.calls != 1 || application.command.Scope.AccountID != billingCancellationAccountID ||
		application.command.Scope.VaultID != billingCancellationVaultID ||
		application.command.IdempotencyKey != billingCancellationKey || application.command.RequestedAt != 1_500 {
		t.Fatalf("command = %#v calls=%d", application.command, application.calls)
	}
}

func TestBillingCancellationContractAuthenticatesBeforeReadingOrUsingOwnerInput(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*http.Request)
		body   string
		status int
	}{
		{name: "anonymous", mutate: func(request *http.Request) { request.Header.Del("Cookie") }, body: "not-json", status: http.StatusUnauthorized},
		{name: "cross origin", mutate: func(request *http.Request) { request.Header.Set("Origin", "https://attacker.example") }, body: "not-json", status: http.StatusForbidden},
		{name: "unknown owner field", mutate: func(*http.Request) {}, body: `{"idempotencyKey":"` + billingCancellationKey + `","accountId":"01991f20-61d2-7000-8000-000000000999"}`, status: http.StatusBadRequest},
		{name: "invalid key", mutate: func(*http.Request) {}, body: `{"idempotencyKey":"bad key"}`, status: http.StatusBadRequest},
		{name: "too large", mutate: func(*http.Request) {}, body: `{"idempotencyKey":"` + strings.Repeat("a", 20_000) + `"}`, status: http.StatusRequestEntityTooLarge},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			application := &billingCancellationApplicationStub{}
			handler, _ := billingCancellationContractHandler(t, application)
			request := billingCancellationRequest(http.MethodPost, test.body)
			test.mutate(request)
			response := serveBillingCancellation(handler, request)
			if response.Code != test.status || application.calls != 0 {
				t.Fatalf("response = %d calls=%d body=%s", response.Code, application.calls, response.Body.String())
			}
		})
	}
}

func TestMainHandlerMountsCancellationAndAppliesConfiguredBodyLimitAfterAuthentication(t *testing.T) {
	application := &billingCancellationApplicationStub{result: billing.SubscriptionCancellationResult{
		Kind: billing.SubscriptionCancellationConfirmed, Outcome: billing.SubscriptionCancellationScheduled,
		ConfirmedAt: 1_500, AccessEndsAt: 9_000,
	}}
	staticDirectory := t.TempDir()
	writeStaticFixture(t, staticDirectory)
	handler, err := httpapi.NewHandler(httpapi.HandlerOptions{
		StaticDirectory: staticDirectory, BodyLimit: 8,
		Logger: slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)),
		BillingCancellationRuntime: &httpapi.BillingCancellationRuntime{
			ExpectedOrigin: billingCancellationOrigin, Clock: func() int64 { return 1_500 },
			Sessions: &billingCancellationSessionStub{session: &identity.Session{
				Kind: identity.SessionActive, SessionID: billingCancellationSessionID,
				AccountID: billingCancellationAccountID, VaultID: billingCancellationVaultID,
				SessionEpoch: 1, IssuedAt: 1_000, ExpiresAt: 2_000,
			}},
			Cancellation: application,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	unread := &trackingReadCloser{}
	anonymous := httptest.NewRequest(http.MethodPost, "/api/billing/cancel", nil)
	anonymous.Body = unread
	anonymous.ContentLength = 10_000
	anonymous.Header.Set("Origin", billingCancellationOrigin)
	anonymous.Header.Set("Sec-Fetch-Site", "same-origin")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, anonymous)
	if response.Code != http.StatusUnauthorized || unread.reads != 0 || application.calls != 0 {
		t.Fatalf("anonymous = %d reads=%d calls=%d body=%s", response.Code, unread.reads, application.calls, response.Body.String())
	}

	authenticated := billingCancellationRequest(
		http.MethodPost,
		`{"idempotencyKey":"`+billingCancellationKey+`"}`,
	)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, authenticated)
	if response.Code != http.StatusRequestEntityTooLarge ||
		response.Body.String() != "{\"error\":\"request-too-large\"}\n" ||
		application.calls != 0 {
		t.Fatalf("authenticated = %d calls=%d body=%s", response.Code, application.calls, response.Body.String())
	}
}

func TestBillingCancellationContractMapsClosedFailureResponses(t *testing.T) {
	tests := []struct {
		name   string
		result billing.SubscriptionCancellationResult
		err    error
		status int
		code   string
	}{
		{name: "owner mismatch", result: billing.SubscriptionCancellationResult{Kind: billing.SubscriptionCancellationTerminalFailure, Reason: billing.CancellationOwnerMismatch}, status: http.StatusForbidden, code: "forbidden"},
		{name: "invalid state", result: billing.SubscriptionCancellationResult{Kind: billing.SubscriptionCancellationTerminalFailure, Reason: billing.CancellationInvalidSubscriptionState}, status: http.StatusConflict, code: "cancellation-unavailable"},
		{name: "provider unavailable", result: billing.SubscriptionCancellationResult{Kind: billing.SubscriptionCancellationRetryableFailure, Reason: billing.CancellationProviderUnavailable}, status: http.StatusServiceUnavailable, code: "unavailable"},
		{name: "application error", err: errors.New("database secret detail"), status: http.StatusServiceUnavailable, code: "unavailable"},
		{name: "cross effect response", result: billing.SubscriptionCancellationResult{Kind: billing.SubscriptionCancellationConfirmed, Outcome: billing.SubscriptionCancelled, ConfirmedAt: 1_500, AccessEndsAt: 1_500}, status: http.StatusServiceUnavailable, code: "unavailable"},
		{name: "scheduled before observation", result: billing.SubscriptionCancellationResult{Kind: billing.SubscriptionCancellationConfirmed, Outcome: billing.SubscriptionCancellationScheduled, ConfirmedAt: 1_500, AccessEndsAt: 1_499}, status: http.StatusServiceUnavailable, code: "unavailable"},
		{name: "scheduled before request", result: billing.SubscriptionCancellationResult{Kind: billing.SubscriptionCancellationConfirmed, Outcome: billing.SubscriptionCancellationScheduled, ConfirmedAt: 1_400, AccessEndsAt: 1_450}, status: http.StatusServiceUnavailable, code: "unavailable"},
		{name: "already cancelled with future access", result: billing.SubscriptionCancellationResult{Kind: billing.SubscriptionCancellationConfirmed, Outcome: billing.SubscriptionAlreadyCancelled, ConfirmedAt: 1_400, AccessEndsAt: 1_401}, status: http.StatusServiceUnavailable, code: "unavailable"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			application := &billingCancellationApplicationStub{result: test.result, err: test.err}
			handler, logs := billingCancellationContractHandler(t, application)
			response := serveBillingCancellation(handler, billingCancellationRequest(
				http.MethodPost,
				`{"idempotencyKey":"`+billingCancellationKey+`"}`,
			))
			if response.Code != test.status {
				t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
			}
			var body map[string]string
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body["error"] != test.code {
				t.Fatalf("body = %#v err=%v", body, err)
			}
			if strings.Contains(logs.String(), "database secret detail") {
				t.Fatalf("secret leaked in logs: %s", logs.String())
			}
		})
	}
}

func TestBillingCancellationContractReportsAlreadyCancelledAndRejectsInvalidRuntime(t *testing.T) {
	application := &billingCancellationApplicationStub{result: billing.SubscriptionCancellationResult{
		Kind: billing.SubscriptionCancellationConfirmed, Outcome: billing.SubscriptionAlreadyCancelled,
		ConfirmedAt: 1_400, AccessEndsAt: 1_400,
	}}
	handler, _ := billingCancellationContractHandler(t, application)
	response := serveBillingCancellation(handler, billingCancellationRequest(
		http.MethodPost,
		`{"idempotencyKey":"`+billingCancellationKey+`"}`,
	))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"cancelled"`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	if _, err := httpapi.NewBillingCancellationContractHandler(nil, logger); err == nil {
		t.Fatal("nil runtime was accepted")
	}
	if _, err := httpapi.NewBillingCancellationContractHandler(&httpapi.BillingCancellationRuntime{}, logger); err == nil {
		t.Fatal("incomplete runtime was accepted")
	}
}

func billingCancellationContractHandler(
	t *testing.T,
	application *billingCancellationApplicationStub,
) (http.Handler, *bytes.Buffer) {
	t.Helper()
	logs := &bytes.Buffer{}
	handler, err := httpapi.NewBillingCancellationContractHandler(&httpapi.BillingCancellationRuntime{
		ExpectedOrigin: billingCancellationOrigin,
		Clock:          func() int64 { return 1_500 },
		Sessions: &billingCancellationSessionStub{session: &identity.Session{
			Kind: identity.SessionActive, SessionID: billingCancellationSessionID,
			AccountID: billingCancellationAccountID, VaultID: billingCancellationVaultID,
			SessionEpoch: 1, IssuedAt: 1_000, ExpiresAt: 2_000,
		}},
		Cancellation: application,
	}, slog.New(slog.NewTextHandler(logs, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return handler, logs
}

func billingCancellationRequest(method string, body string) *http.Request {
	request := httptest.NewRequest(method, "/api/billing/cancel", strings.NewReader(body))
	request.Header.Set("Cookie", identity.SessionCookieName+"="+billingCancellationToken)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", billingCancellationOrigin)
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	return request
}

func serveBillingCancellation(handler http.Handler, request *http.Request) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

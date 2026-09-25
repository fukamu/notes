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

	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/syncv2"
)

const (
	syncV2TestOrigin    = "https://notes.example"
	syncV2TestToken     = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	syncV2TestDeviceID  = "01991f20-61d2-7000-8000-000000000451"
	syncV2TestAccountID = "01991f20-61d2-7000-8000-000000000151"
	syncV2TestVaultID   = "01991f20-61d2-7000-8000-000000000251"
	syncV2TestSessionID = "01991f20-61d2-7000-8000-000000000351"
)

type syncV2SessionStub struct {
	session *identity.Session
	err     error
	calls   int
}

func (stub *syncV2SessionStub) FindSessionByToken(context.Context, identity.SessionToken) (*identity.Session, error) {
	stub.calls++
	return stub.session, stub.err
}

type syncV2EntitlementStub struct {
	decision entitlement.Decision
	limits   entitlement.LimitDecision
	context  identity.VaultContext
	calls    int
}

func (stub *syncV2EntitlementStub) AuthorizeCapability(
	_ context.Context,
	vaultContext identity.VaultContext,
	_ entitlement.Capability,
	_ int64,
) entitlement.Decision {
	stub.calls++
	stub.context = vaultContext
	return stub.decision
}

func (stub *syncV2EntitlementStub) ReadLimits(
	_ context.Context,
	_ identity.VaultContext,
	_ int64,
) entitlement.LimitDecision {
	return stub.limits
}

type syncV2ApplicationStub struct {
	result syncv2.ApplicationResult
	err    error
	input  syncv2.SynchronizeInput
	calls  int
}

func (stub *syncV2ApplicationStub) Synchronize(
	_ context.Context,
	input syncv2.SynchronizeInput,
) (syncv2.ApplicationResult, error) {
	stub.calls++
	stub.input = input
	return stub.result, stub.err
}

type syncV2TrackingBody struct{ reads int }

func (body *syncV2TrackingBody) Read([]byte) (int, error) {
	body.reads++
	return 0, io.EOF
}

func (body *syncV2TrackingBody) Close() error { return nil }

func TestSyncV2ContractHandlerAuthenticatesBeforeReadingBody(t *testing.T) {
	handler, sessions, entitlementStub, application := newSyncV2HTTPTestHandler(t)
	tracking := &syncV2TrackingBody{}
	request := httptest.NewRequest(http.MethodPost, "/api/v2/sync", nil)
	request.Body = tracking
	request.Header.Set("Origin", syncV2TestOrigin)
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || tracking.reads != 0 || sessions.calls != 0 ||
		entitlementStub.calls != 0 || application.calls != 0 {
		t.Fatalf("anonymous response=%d reads=%d sessions=%d entitlement=%d application=%d",
			response.Code, tracking.reads, sessions.calls, entitlementStub.calls, application.calls)
	}
}

func TestSyncV2ContractHandlerBoundaryAndFailClosedMappings(t *testing.T) {
	tests := []struct {
		name       string
		configure  func(*syncV2EntitlementStub, *syncV2ApplicationStub)
		body       string
		length     string
		wantStatus int
		wantBody   string
	}{
		{name: "malformed json", body: `{`, wantStatus: http.StatusBadRequest, wantBody: `{"error":"invalid-request"}`},
		{name: "declared too large", body: `{}`, length: "4000001", wantStatus: http.StatusRequestEntityTooLarge, wantBody: `{"error":"request-too-large"}`},
		{name: "unknown entitlement denial", body: validSyncV2EmptyRequest(), wantStatus: http.StatusServiceUnavailable, wantBody: `{"error":"unavailable"}`,
			configure: func(access *syncV2EntitlementStub, _ *syncV2ApplicationStub) {
				access.decision = entitlement.Decision{Kind: entitlement.DecisionDenied, Reason: "future-denial"}
			}},
		{name: "payment lock", body: validSyncV2EmptyRequest(), wantStatus: http.StatusPaymentRequired, wantBody: `{"error":"online-access-locked"}`,
			configure: func(access *syncV2EntitlementStub, _ *syncV2ApplicationStub) {
				access.decision = entitlement.Decision{Kind: entitlement.DecisionDenied, Reason: entitlement.DenialReason(entitlement.LockPaymentFailed)}
			}},
		{name: "application conflict", body: validSyncV2EmptyRequest(), wantStatus: http.StatusConflict, wantBody: `{"error":"sync-conflict"}`,
			configure: func(_ *syncV2EntitlementStub, application *syncV2ApplicationStub) {
				application.result = syncv2.ApplicationResult{Kind: syncv2.ApplicationRejected, Reason: syncv2.ApplicationMutationConflict}
			}},
		{name: "application error", body: validSyncV2EmptyRequest(), wantStatus: http.StatusServiceUnavailable, wantBody: `{"error":"unavailable"}`,
			configure: func(_ *syncV2EntitlementStub, application *syncV2ApplicationStub) {
				application.err = errors.New("sensitive dependency detail")
			}},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			handler, _, access, application := newSyncV2HTTPTestHandler(t)
			if test.configure != nil {
				test.configure(access, application)
			}
			request := authenticatedSyncV2Request(test.body)
			if test.length != "" {
				request.Header["Content-Length"] = []string{test.length}
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.wantStatus || strings.TrimSpace(response.Body.String()) != test.wantBody ||
				response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("response = %d %q headers=%v", response.Code, response.Body.String(), response.Header())
			}
		})
	}
}

func TestSyncV2ContractHandlerSuccessPassesDecodedOwnerScope(t *testing.T) {
	handler, _, access, application := newSyncV2HTTPTestHandler(t)
	response := httptest.NewRecorder()
	body := validSyncV2EmptyRequest()
	handler.ServeHTTP(response, authenticatedSyncV2Request(body))
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" ||
		!bytes.Contains(response.Body.Bytes(), []byte(`"version":"sync/v2"`)) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	if application.calls != 1 || application.input.Context != syncV2TestContext() ||
		application.input.Request.DeviceID != syncv2.DeviceID(syncV2TestDeviceID) ||
		application.input.RequestBytes != int64(len(body)) || application.input.SynchronizedAt != 1_500 ||
		access.context != syncV2TestContext() {
		t.Fatalf("application input = %#v access=%#v", application.input, access.context)
	}
}

func newSyncV2HTTPTestHandler(
	t *testing.T,
) (http.Handler, *syncV2SessionStub, *syncV2EntitlementStub, *syncV2ApplicationStub) {
	t.Helper()
	session := &identity.Session{
		Kind: identity.SessionActive, SessionID: syncV2TestSessionID,
		AccountID: syncV2TestAccountID, VaultID: syncV2TestVaultID,
		SessionEpoch: 1, IssuedAt: 1_000, ExpiresAt: 2_000,
	}
	sessions := &syncV2SessionStub{session: session}
	access := &syncV2EntitlementStub{
		decision: entitlement.Decision{Kind: entitlement.DecisionAllowed, Capability: entitlement.CapabilityNotesSync},
		limits:   entitlement.LimitDecision{Kind: entitlement.LimitsAvailable, Limits: entitlement.PaidPersonalVaultLimits()},
	}
	application := &syncV2ApplicationStub{result: syncv2.ApplicationResult{
		Kind: syncv2.ApplicationSynchronized,
		Response: syncv2.Response{
			Version: syncv2.ProtocolVersion, Changes: []syncv2.HydratedChange{},
			Receipts: []syncv2.MutationReceipt{},
			Page: syncv2.ResponsePage{
				Kind: syncv2.PageComplete, NextCursor: syncv2.Cursor(strings.Repeat("a", 24)),
			},
		},
	}}
	handler, err := httpapi.NewSyncV2ContractHandler(&httpapi.SyncV2Runtime{
		ExpectedOrigin: syncV2TestOrigin, Clock: func() int64 { return 1_500 },
		Sessions: sessions, Entitlement: access, Application: application,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return handler, sessions, access, application
}

func authenticatedSyncV2Request(body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/v2/sync", strings.NewReader(body))
	request.Header.Set("Cookie", identity.SessionCookieName+"="+syncV2TestToken)
	request.Header.Set("Origin", syncV2TestOrigin)
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	return request
}

func validSyncV2EmptyRequest() string {
	return `{"version":"sync/v2","deviceId":"` + syncV2TestDeviceID + `","cursor":null,"mutations":[]}`
}

func syncV2TestContext() identity.VaultContext {
	return identity.VaultContext{
		AccountID: syncV2TestAccountID, VaultID: syncV2TestVaultID,
		SessionID: syncV2TestSessionID, SessionEpoch: 1,
	}
}

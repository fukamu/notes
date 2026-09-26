package httpapi_test

import (
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

func TestLocalSyncV2MuxPublishesSessionContextAndClosesLegacySync(t *testing.T) {
	t.Parallel()
	staticDirectory := t.TempDir()
	writeStaticFixture(t, staticDirectory)
	runtime := muxSyncV2Runtime()
	handler, err := httpapi.NewHandler(httpapi.HandlerOptions{
		StaticDirectory: staticDirectory,
		BodyLimit:       4_000_000,
		Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		SyncV2Runtime:   runtime,
	})
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/session-context", nil)
	request.Header.Set("Cookie", identity.SessionCookieName+"="+syncV2TestToken)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	want := `{"accountId":"` + syncV2TestAccountID + `","vaultId":"` + syncV2TestVaultID +
		`","sessionId":"` + syncV2TestSessionID + `","sessionEpoch":1}`
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != want ||
		response.Header().Get("Cache-Control") != "private, no-store" ||
		response.Header().Get("Vary") != "Cookie" || strings.Contains(response.Body.String(), syncV2TestToken) {
		t.Fatalf("session context = %d %q headers=%v", response.Code, response.Body.String(), response.Header())
	}

	legacy := httptest.NewRecorder()
	handler.ServeHTTP(
		legacy,
		httptest.NewRequest(http.MethodPost, "/api/sync", strings.NewReader("sensitive body")),
	)
	if legacy.Code != http.StatusNotFound || legacy.Body.String() != "{\"code\":\"not_found\"}\n" {
		t.Fatalf("legacy route = %d %s", legacy.Code, legacy.Body.String())
	}

	syncResponse := httptest.NewRecorder()
	handler.ServeHTTP(syncResponse, authenticatedSyncV2Request(validSyncV2EmptyRequest()))
	if syncResponse.Code != http.StatusOK {
		t.Fatalf("Sync v2 route = %d %s", syncResponse.Code, syncResponse.Body.String())
	}
}

func TestSessionContextAuthenticatesBeforeRejectingBodiesAndFailsClosed(t *testing.T) {
	t.Parallel()
	staticDirectory := t.TempDir()
	writeStaticFixture(t, staticDirectory)
	runtime := muxSyncV2Runtime()
	handler, err := httpapi.NewHandler(httpapi.HandlerOptions{
		StaticDirectory: staticDirectory,
		BodyLimit:       4_000_000,
		Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		SyncV2Runtime:   runtime,
	})
	if err != nil {
		t.Fatal(err)
	}

	tracking := &syncV2TrackingBody{}
	request := httptest.NewRequest(http.MethodPost, "/api/session-context", nil)
	request.Body = tracking
	request.ContentLength = 128
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusMethodNotAllowed || tracking.reads != 0 {
		t.Fatalf("wrong method = %d, reads=%d", response.Code, tracking.reads)
	}

	anonymousBody := &syncV2TrackingBody{}
	anonymousRequest := httptest.NewRequest(http.MethodGet, "/api/session-context", nil)
	anonymousRequest.Body = anonymousBody
	anonymousRequest.ContentLength = 128
	anonymousResponse := httptest.NewRecorder()
	handler.ServeHTTP(anonymousResponse, anonymousRequest)
	if anonymousResponse.Code != http.StatusUnauthorized || anonymousBody.reads != 0 {
		t.Fatalf("anonymous body = %d, reads=%d", anonymousResponse.Code, anonymousBody.reads)
	}

	authenticatedBody := &syncV2TrackingBody{}
	authenticatedRequest := httptest.NewRequest(http.MethodGet, "/api/session-context", nil)
	authenticatedRequest.Header.Set("Cookie", identity.SessionCookieName+"="+syncV2TestToken)
	authenticatedRequest.Body = authenticatedBody
	authenticatedRequest.ContentLength = 128
	authenticatedResponse := httptest.NewRecorder()
	handler.ServeHTTP(authenticatedResponse, authenticatedRequest)
	if authenticatedResponse.Code != http.StatusBadRequest || authenticatedBody.reads != 0 {
		t.Fatalf("authenticated body = %d, reads=%d", authenticatedResponse.Code, authenticatedBody.reads)
	}

	for _, path := range []string{"/api/session-context", "/api/session-context?unexpected=1"} {
		anonymous := httptest.NewRecorder()
		handler.ServeHTTP(anonymous, httptest.NewRequest(http.MethodGet, path, nil))
		want := http.StatusUnauthorized
		if strings.Contains(path, "?") {
			want = http.StatusBadRequest
		}
		if anonymous.Code != want {
			t.Fatalf("GET %s = %d %s", path, anonymous.Code, anonymous.Body.String())
		}
	}

	if _, err := httpapi.NewHandler(httpapi.HandlerOptions{
		StaticDirectory: staticDirectory,
		BodyLimit:       4_000_000,
		Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		SyncV2Runtime:   &httpapi.SyncV2Runtime{},
	}); err == nil {
		t.Fatal("incomplete Sync v2 runtime was accepted")
	}
}

func muxSyncV2Runtime() *httpapi.SyncV2Runtime {
	session := &identity.Session{
		Kind: identity.SessionActive, SessionID: syncV2TestSessionID,
		AccountID: syncV2TestAccountID, VaultID: syncV2TestVaultID,
		SessionEpoch: 1, IssuedAt: 1_000, ExpiresAt: 2_000,
	}
	access := &syncV2EntitlementStub{
		decision: entitlement.Decision{
			Kind: entitlement.DecisionAllowed, Capability: entitlement.CapabilityNotesSync,
		},
		limits: entitlement.LimitDecision{
			Kind: entitlement.LimitsAvailable, Limits: entitlement.PaidPersonalVaultLimits(),
		},
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
	return &httpapi.SyncV2Runtime{
		ExpectedOrigin: syncV2TestOrigin, Clock: func() int64 { return 1_500 },
		Sessions: &syncV2SessionStub{session: session}, Entitlement: access, Application: application,
	}
}

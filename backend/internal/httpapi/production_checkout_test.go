package httpapi_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/featureflag"
	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/launchgate"
)

type checkoutFlagStub struct {
	decision featureflag.Decision
	calls    int
	account  identity.AccountID
}

func (stub *checkoutFlagStub) Evaluate(
	_ context.Context,
	_ featureflag.Name,
	accountID identity.AccountID,
) (featureflag.Decision, error) {
	stub.calls++
	stub.account = accountID
	return stub.decision, nil
}

func TestProductionCheckoutIsServerFlaggedOffWithoutSideEffects(t *testing.T) {
	t.Parallel()
	staticDirectory := t.TempDir()
	writeStaticFixture(t, staticDirectory)
	session := &identity.Session{
		Kind: identity.SessionActive, SessionID: syncV2TestSessionID,
		AccountID: syncV2TestAccountID, VaultID: syncV2TestVaultID,
		SessionEpoch: 1, IssuedAt: 1_000, ExpiresAt: 2_000,
	}
	accessRuntime := &httpapi.SessionAccessRuntime{
		Clock: func() int64 { return 1_500 }, Sessions: &syncV2SessionStub{session: session},
		Admission: &syncV2AdmissionStub{decision: launchgate.Decision{UserAllowed: true, CanAccess: true}},
	}
	flags := &checkoutFlagStub{decision: featureflag.Decision{
		Kind: featureflag.DecisionDisabled, Name: featureflag.BillingCheckout,
	}}
	handler, err := httpapi.NewHandler(httpapi.HandlerOptions{
		StaticDirectory: staticDirectory, BodyLimit: 4_000_000,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		ProductionFeatureRuntime: &httpapi.ProductionFeatureRuntime{
			ExpectedOrigin: syncV2TestOrigin, Access: accessRuntime, Flags: flags,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/billing/checkout", strings.NewReader("not read"))
	request.Header.Set("Cookie", identity.SessionCookieName+"="+syncV2TestToken)
	request.Header.Set("Origin", syncV2TestOrigin)
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound || flags.calls != 1 || flags.account != syncV2TestAccountID ||
		strings.TrimSpace(response.Body.String()) != `{"code":"not_found"}` {
		t.Fatalf("checkout off = %d %s flags=%d account=%q", response.Code, response.Body.String(), flags.calls, flags.account)
	}

	flags.decision.Kind = featureflag.DecisionEnabled
	enabled := httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "/api/billing/checkout", nil)
	request.Header.Set("Cookie", identity.SessionCookieName+"="+syncV2TestToken)
	request.Header.Set("Origin", syncV2TestOrigin)
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	handler.ServeHTTP(enabled, request)
	if enabled.Code != http.StatusServiceUnavailable ||
		strings.TrimSpace(enabled.Body.String()) != `{"error":"checkout-not-connected"}` {
		t.Fatalf("checkout enabled without provider = %d %s", enabled.Code, enabled.Body.String())
	}
}

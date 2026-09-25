package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/legal"
	"github.com/fukamu/notes/backend/internal/telemetry"
)

const (
	legalTestOrigin       = "https://notes.example"
	legalTestAccountID    = "01991f20-61d2-7000-8000-000000000101"
	legalTestVaultID      = "01991f20-61d2-7000-8000-000000000201"
	legalTestSessionID    = "01991f20-61d2-7000-8000-000000000301"
	legalTestConsentID    = "01991f20-61d2-7000-8000-000000002501"
	legalTestTermsSubmit  = "01991f20-61d2-7000-8000-000000002601"
	legalTestEvidenceID   = "01991f20-61d2-7000-8000-000000001801"
	legalTestCheckoutID   = "01991f20-61d2-7000-8000-000000001901"
	legalTestTermsHash    = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	legalTestContractHash = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	legalTestToken        = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
)

type legalSessionResolver struct {
	session *identity.Session
	err     error
	calls   int
}

func (resolver *legalSessionResolver) FindSessionByToken(context.Context, identity.SessionToken) (*identity.Session, error) {
	resolver.calls++
	return resolver.session, resolver.err
}

type legalTermsStub struct {
	statusResult legal.ApplicationResult
	acceptResult legal.ApplicationResult
	statusScope  legal.TermsScope
	acceptScope  legal.TermsScope
	command      legal.TermsConsentCommand
	consentID    legal.TermsConsentID
	acceptedAt   int64
	statusCalls  int
	acceptCalls  int
	panicStatus  bool
	panicAccept  bool
}

func (application *legalTermsStub) Status(_ context.Context, scope legal.TermsScope) legal.ApplicationResult {
	application.statusCalls++
	application.statusScope = scope
	if application.panicStatus {
		panic("sensitive status detail")
	}
	return application.statusResult
}

func (application *legalTermsStub) Accept(
	_ context.Context,
	scope legal.TermsScope,
	command legal.TermsConsentCommand,
	consentID legal.TermsConsentID,
	acceptedAt int64,
) legal.ApplicationResult {
	application.acceptCalls++
	application.acceptScope = scope
	application.command = command
	application.consentID = consentID
	application.acceptedAt = acceptedAt
	if application.panicAccept {
		panic("sensitive accept detail")
	}
	return application.acceptResult
}

type legalCheckoutStub struct {
	prepareResult legal.PrepareContractOfferResult
	confirmResult legal.ContractCheckoutResult
	context       identity.VaultContext
	command       legal.ContractConfirmationCommand
	evidenceID    legal.ContractEvidenceID
	confirmedAt   int64
	prepareCalls  int
	confirmCalls  int
	panicPrepare  bool
	panicConfirm  bool
}

func (application *legalCheckoutStub) PrepareOffer(context.Context) legal.PrepareContractOfferResult {
	application.prepareCalls++
	if application.panicPrepare {
		panic("sensitive offer detail")
	}
	return application.prepareResult
}

func (application *legalCheckoutStub) Confirm(
	_ context.Context,
	vaultContext identity.VaultContext,
	command legal.ContractConfirmationCommand,
	evidenceID legal.ContractEvidenceID,
	confirmedAt int64,
) legal.ContractCheckoutResult {
	application.confirmCalls++
	application.context = vaultContext
	application.command = command
	application.evidenceID = evidenceID
	application.confirmedAt = confirmedAt
	if application.panicConfirm {
		panic("sensitive checkout detail")
	}
	return application.confirmResult
}

func TestLegalTermsHandlersPreserveHTTPContract(t *testing.T) {
	terms := legalTermsApplication()
	runtime := legalRuntime(terms, legalCheckoutApplication())
	handler, _ := legalHandler(t, runtime)

	statusResponse := serveLegal(handler, legalRequest(http.MethodGet, "/api/account/terms-consent", ""))
	if statusResponse.Code != http.StatusOK || statusResponse.Header().Get("Cache-Control") != "no-store" ||
		statusResponse.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("status response = %d %#v %s", statusResponse.Code, statusResponse.Header(), statusResponse.Body.String())
	}
	wantStatus := `{"outcome":"status","status":{"kind":"current","acceptanceRequired":true,"current":{"termsVersion":"terms-v1:2026-09-15","termsHash":"` + legalTestTermsHash + `","effectiveDate":"2026-09-15"}}}` + "\n"
	if statusResponse.Body.String() != wantStatus {
		t.Fatalf("status body = %s", statusResponse.Body.String())
	}
	if terms.statusScope != legalTestScope() {
		t.Fatalf("status scope = %#v", terms.statusScope)
	}

	body := `{"submissionId":"` + legalTestTermsSubmit + `","presentedTermsVersion":"terms-v1:2026-09-15","presentedTermsHash":"` + legalTestTermsHash + `","consent":{"kind":"affirmed"}}`
	acceptResponse := serveLegal(handler, legalRequest(http.MethodPost, "/api/account/terms-consent", body))
	if acceptResponse.Code != http.StatusOK {
		t.Fatalf("accept response = %d %s", acceptResponse.Code, acceptResponse.Body.String())
	}
	if terms.acceptScope != legalTestScope() || string(terms.command.SubmissionID) != legalTestTermsSubmit ||
		string(terms.consentID) != legalTestConsentID || terms.acceptedAt != 1_500 {
		t.Fatalf("accept input = %#v %#v %q %d", terms.acceptScope, terms.command, terms.consentID, terms.acceptedAt)
	}
	var accepted map[string]any
	if err := json.Unmarshal(acceptResponse.Body.Bytes(), &accepted); err != nil {
		t.Fatal(err)
	}
	status, ok := accepted["status"].(map[string]any)
	if accepted["outcome"] != "recorded" || !ok || status["kind"] != "accepted" {
		t.Fatalf("accept payload = %#v", accepted)
	}
}

func TestLegalCheckoutHandlersPreserveHTTPContract(t *testing.T) {
	checkout := legalCheckoutApplication()
	runtime := legalRuntime(legalTermsApplication(), checkout)
	handler, _ := legalHandler(t, runtime)

	offerResponse := serveLegal(handler, legalRequest(http.MethodGet, "/api/billing/checkout", ""))
	if offerResponse.Code != http.StatusOK || !strings.Contains(offerResponse.Body.String(), `"priceYen":980`) ||
		!strings.Contains(offerResponse.Body.String(), `"offerHash":"`+legalTestContractHash+`"`) {
		t.Fatalf("offer response = %d %s", offerResponse.Code, offerResponse.Body.String())
	}

	body := `{"submissionId":"` + legalTestCheckoutID + `","presentedOfferHash":"` + legalTestContractHash + `","consent":{"kind":"affirmed"}}`
	checkoutResponse := serveLegal(handler, legalRequest(http.MethodPost, "/api/billing/checkout", body))
	wantCheckout := `{"kind":"redirect","evidenceOutcome":"recorded","evidenceId":"` + legalTestEvidenceID + `","offerHash":"` + legalTestContractHash + `","offerVersion":"legal-commerce-v1:2026-09-15","checkoutUrl":"https://checkout.stripe.com/c/pay/cs_test_fukamu"}` + "\n"
	if checkoutResponse.Code != http.StatusOK || checkoutResponse.Body.String() != wantCheckout {
		t.Fatalf("checkout response = %d %s", checkoutResponse.Code, checkoutResponse.Body.String())
	}
	if checkout.context != legalTestVaultContext() || string(checkout.command.SubmissionID) != legalTestCheckoutID ||
		string(checkout.evidenceID) != legalTestEvidenceID || checkout.confirmedAt != 1_500 {
		t.Fatalf("checkout input = %#v %#v %q %d", checkout.context, checkout.command, checkout.evidenceID, checkout.confirmedAt)
	}
}

func TestLegalCheckoutHandlerMatchesSharedWireFixture(t *testing.T) {
	content, err := os.ReadFile("../../../contracts/fixtures/billing/checkout.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		OfferHash legal.ContractOfferHash     `json:"offerHash"`
		Offer     legal.ContractOfferSnapshot `json:"offer"`
		Redirect  struct {
			Kind            legal.ContractCheckoutResultKind `json:"kind"`
			EvidenceOutcome legal.ContractEvidenceOutcome    `json:"evidenceOutcome"`
			EvidenceID      legal.ContractEvidenceID         `json:"evidenceId"`
			OfferHash       legal.ContractOfferHash          `json:"offerHash"`
			OfferVersion    string                           `json:"offerVersion"`
			CheckoutURL     string                           `json:"checkoutUrl"`
		} `json:"redirect"`
	}
	if err := json.Unmarshal(content, &fixture); err != nil {
		t.Fatal(err)
	}
	checkout := &legalCheckoutStub{
		prepareResult: legal.PrepareContractOfferResult{
			Kind:     legal.PrepareContractAvailable,
			Prepared: legal.PreparedContractOffer{Offer: fixture.Offer, OfferHash: fixture.OfferHash},
		},
		confirmResult: legal.ContractCheckoutResult{
			Kind: fixture.Redirect.Kind, Outcome: fixture.Redirect.EvidenceOutcome,
			Evidence: legal.ContractEvidenceRecord{
				Scope: legalTestScope(), EvidenceID: fixture.Redirect.EvidenceID,
				SubmissionID: legalTestCheckoutID, OfferHash: fixture.Redirect.OfferHash,
				Offer: fixture.Offer, Consent: legal.ContractConsentAffirmed, ConfirmedAt: 1_500,
			},
			CheckoutURL: fixture.Redirect.CheckoutURL,
		},
	}
	runtime := legalRuntime(legalTermsApplication(), checkout)
	runtime.NewContractEvidenceID = func() string { return string(fixture.Redirect.EvidenceID) }
	handler, _ := legalHandler(t, runtime)

	offerResponse := serveLegal(handler, legalRequest(http.MethodGet, "/api/billing/checkout", ""))
	var offerPayload any
	if offerResponse.Code != http.StatusOK || json.Unmarshal(offerResponse.Body.Bytes(), &offerPayload) != nil {
		t.Fatalf("offer response = %d %s", offerResponse.Code, offerResponse.Body.String())
	}
	expectedOffer := map[string]any{"offer": fixture.Offer, "offerHash": fixture.OfferHash}
	expectedOfferBytes, err := json.Marshal(expectedOffer)
	if err != nil {
		t.Fatal(err)
	}
	var expectedOfferPayload any
	if err := json.Unmarshal(expectedOfferBytes, &expectedOfferPayload); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(offerPayload, expectedOfferPayload) {
		t.Fatalf("offer payload = %#v, want %#v", offerPayload, expectedOfferPayload)
	}

	body := `{"submissionId":"` + legalTestCheckoutID + `","presentedOfferHash":"` + string(fixture.OfferHash) + `","consent":{"kind":"affirmed"}}`
	checkoutResponse := serveLegal(handler, legalRequest(http.MethodPost, "/api/billing/checkout", body))
	var checkoutPayload any
	var expectedCheckoutPayload any
	expectedCheckoutBytes, err := json.Marshal(fixture.Redirect)
	if err != nil {
		t.Fatal(err)
	}
	if checkoutResponse.Code != http.StatusOK || json.Unmarshal(checkoutResponse.Body.Bytes(), &checkoutPayload) != nil ||
		json.Unmarshal(expectedCheckoutBytes, &expectedCheckoutPayload) != nil {
		t.Fatalf("checkout response = %d %s", checkoutResponse.Code, checkoutResponse.Body.String())
	}
	if !reflect.DeepEqual(checkoutPayload, expectedCheckoutPayload) {
		t.Fatalf("checkout payload = %#v, want %#v", checkoutPayload, expectedCheckoutPayload)
	}
}

func TestLegalHandlersAuthorizeBeforeReadingAndRejectInvalidBodies(t *testing.T) {
	terms := legalTermsApplication()
	checkout := legalCheckoutApplication()
	runtime := legalRuntime(terms, checkout)
	handler, _ := legalHandler(t, runtime)

	unread := &trackingReadCloser{}
	anonymous := legalRequest(http.MethodPost, "/api/account/terms-consent", "")
	anonymous.Header.Del("Cookie")
	anonymous.Body = unread
	anonymous.ContentLength = -1
	response := serveLegal(handler, anonymous)
	if response.Code != http.StatusUnauthorized || unread.reads != 0 {
		t.Fatalf("anonymous = %d %s, reads=%d", response.Code, response.Body.String(), unread.reads)
	}

	crossSite := legalRequest(http.MethodPost, "/api/billing/checkout", "{}")
	crossSite.Header.Set("Origin", "https://evil.example")
	crossSite.Header.Set("Sec-Fetch-Site", "cross-site")
	if got := serveLegal(handler, crossSite); got.Code != http.StatusForbidden {
		t.Fatalf("cross-site = %d %s", got.Code, got.Body.String())
	}

	ownerInjected := legalRequest(http.MethodPost, "/api/account/terms-consent", `{"accountId":"`+legalTestAccountID+`"}`)
	if got := serveLegal(handler, ownerInjected); got.Code != http.StatusBadRequest || got.Body.String() != "{\"error\":\"invalid-request\"}\n" {
		t.Fatalf("owner-injected = %d %s", got.Code, got.Body.String())
	}

	malformed := legalRequest(http.MethodPost, "/api/billing/checkout", "{")
	if got := serveLegal(handler, malformed); got.Code != http.StatusBadRequest {
		t.Fatalf("malformed = %d %s", got.Code, got.Body.String())
	}

	invalidUTF8 := legalRequest(http.MethodPost, "/api/billing/checkout", string([]byte{0xff}))
	if got := serveLegal(handler, invalidUTF8); got.Code != http.StatusBadRequest {
		t.Fatalf("invalid UTF-8 = %d %s", got.Code, got.Body.String())
	}

	oversized := legalRequest(http.MethodPost, "/api/billing/checkout", strings.Repeat("a", 2_049))
	oversized.ContentLength = -1
	if got := serveLegal(handler, oversized); got.Code != http.StatusRequestEntityTooLarge ||
		got.Body.String() != "{\"error\":\"request-too-large\"}\n" {
		t.Fatalf("oversized = %d %s", got.Code, got.Body.String())
	}
	if terms.acceptCalls != 0 || checkout.confirmCalls != 0 {
		t.Fatalf("invalid requests reached applications: terms=%d checkout=%d", terms.acceptCalls, checkout.confirmCalls)
	}
}

func TestLegalHandlersMapApplicationFailuresAndSanitizePanics(t *testing.T) {
	terms := legalTermsApplication()
	checkout := legalCheckoutApplication()
	runtime := legalRuntime(terms, checkout)
	handler, logs := legalHandler(t, runtime)
	termsBody := `{"submissionId":"` + legalTestTermsSubmit + `","presentedTermsVersion":"terms-v1:2026-09-15","presentedTermsHash":"` + legalTestTermsHash + `","consent":{"kind":"affirmed"}}`
	checkoutBody := `{"submissionId":"` + legalTestCheckoutID + `","presentedOfferHash":"` + legalTestContractHash + `","consent":{"kind":"affirmed"}}`

	for _, test := range []struct {
		name   string
		reason legal.ApplicationRejectionReason
		status int
		code   string
	}{
		{name: "terms required", reason: legal.ApplicationConsentRequired, status: 422, code: "consent-required"},
		{name: "terms changed", reason: legal.ApplicationStaleTerms, status: 409, code: "terms-changed"},
		{name: "terms conflict", reason: legal.ApplicationIdentifierConflict, status: 409, code: "request-conflict"},
		{name: "terms owner", reason: legal.ApplicationOwnerMismatch, status: 403, code: "forbidden"},
		{name: "terms dependency", reason: legal.ApplicationHashUnavailable, status: 503, code: "unavailable"},
	} {
		t.Run(test.name, func(t *testing.T) {
			terms.acceptResult = legal.ApplicationResult{Kind: legal.ApplicationRejected, Reason: test.reason}
			got := serveLegal(handler, legalRequest(http.MethodPost, "/api/account/terms-consent", termsBody))
			if got.Code != test.status || got.Body.String() != "{\"error\":\""+test.code+"\"}\n" {
				t.Fatalf("response = %d %s", got.Code, got.Body.String())
			}
		})
	}

	for _, test := range []struct {
		name   string
		reason legal.ContractApplicationReason
		status int
		code   string
	}{
		{name: "offer changed", reason: legal.ContractStaleOffer, status: 409, code: "offer-changed"},
		{name: "terms changed", reason: legal.ContractTermsChanged, status: 409, code: "terms-changed"},
		{name: "terms missing", reason: legal.ContractTermsRequired, status: 422, code: "terms-consent-required"},
		{name: "provider", reason: legal.ContractProviderUnavailable, status: 503, code: "unavailable"},
	} {
		t.Run(test.name, func(t *testing.T) {
			checkout.confirmResult = legal.ContractCheckoutResult{Kind: legal.ContractCheckoutRejected, Reason: test.reason}
			got := serveLegal(handler, legalRequest(http.MethodPost, "/api/billing/checkout", checkoutBody))
			if got.Code != test.status || got.Body.String() != "{\"error\":\""+test.code+"\"}\n" {
				t.Fatalf("response = %d %s", got.Code, got.Body.String())
			}
		})
	}

	terms.panicAccept = true
	got := serveLegal(handler, legalRequest(http.MethodPost, "/api/account/terms-consent", termsBody))
	if got.Code != http.StatusServiceUnavailable || strings.Contains(logs.String(), "sensitive") ||
		!strings.Contains(logs.String(), "terms_accept_panic") {
		t.Fatalf("panic response/logs = %d %s %s", got.Code, got.Body.String(), logs.String())
	}
}

func TestLegalRuntimeFailsClosed(t *testing.T) {
	incomplete := legalRuntime(legalTermsApplication(), legalCheckoutApplication())
	incomplete.ExpectedOrigin = "HTTP://NOT-CANONICAL.example"
	handler, _ := legalHandler(t, incomplete)
	response := serveLegal(handler, legalRequest(http.MethodGet, "/api/account/terms-consent", ""))
	if response.Code != http.StatusServiceUnavailable || response.Body.String() != "{\"error\":\"unavailable\"}\n" {
		t.Fatalf("incomplete runtime = %d %s", response.Code, response.Body.String())
	}

	badClock := legalRuntime(legalTermsApplication(), legalCheckoutApplication())
	badClock.Clock = func() int64 { return -1 }
	handler, _ = legalHandler(t, badClock)
	if got := serveLegal(handler, legalRequest(http.MethodGet, "/api/billing/checkout", "")); got.Code != http.StatusServiceUnavailable {
		t.Fatalf("bad clock = %d %s", got.Code, got.Body.String())
	}

	badID := legalRuntime(legalTermsApplication(), legalCheckoutApplication())
	badID.NewTermsConsentID = func() string { return "invalid" }
	handler, _ = legalHandler(t, badID)
	body := `{"submissionId":"` + legalTestTermsSubmit + `","presentedTermsVersion":"terms-v1:2026-09-15","presentedTermsHash":"` + legalTestTermsHash + `","consent":{"kind":"affirmed"}}`
	if got := serveLegal(handler, legalRequest(http.MethodPost, "/api/account/terms-consent", body)); got.Code != http.StatusServiceUnavailable {
		t.Fatalf("bad identifier = %d %s", got.Code, got.Body.String())
	}
}

func legalHandler(t *testing.T, runtime *httpapi.LegalRuntime) (http.Handler, *bytes.Buffer) {
	t.Helper()
	staticDirectory := t.TempDir()
	writeStaticFixture(t, staticDirectory)
	logs := &bytes.Buffer{}
	handler, err := httpapi.NewHandler(httpapi.HandlerOptions{
		StaticDirectory: staticDirectory, BodyLimit: 4_000_000,
		Logger: telemetry.NewLogger(logs, slog.LevelDebug), LegalRuntime: runtime,
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler, logs
}

func legalRuntime(terms *legalTermsStub, checkout *legalCheckoutStub) *httpapi.LegalRuntime {
	return &httpapi.LegalRuntime{
		ExpectedOrigin: legalTestOrigin, Clock: func() int64 { return 1_500 },
		Sessions: &legalSessionResolver{session: legalTestSession()}, Terms: terms, Checkout: checkout,
		NewTermsConsentID:     func() string { return legalTestConsentID },
		NewContractEvidenceID: func() string { return legalTestEvidenceID },
	}
}

func legalTermsApplication() *legalTermsStub {
	current := legal.CurrentTermsReference{
		TermsVersion: "terms-v1:2026-09-15", TermsHash: legalTestTermsHash, EffectiveDate: "2026-09-15",
	}
	accepted := &legal.AcceptedTermsReference{
		ConsentID: legalTestConsentID, TermsVersion: current.TermsVersion,
		TermsHash: current.TermsHash, AcceptedAt: 1_500,
	}
	return &legalTermsStub{
		statusResult: legal.ApplicationResult{
			Kind: legal.ApplicationAccepted, Outcome: legal.ApplicationStatus,
			Status: legal.TermsConsentStatus{Kind: legal.TermsStatusCurrent, AcceptanceRequired: true, Current: current},
		},
		acceptResult: legal.ApplicationResult{
			Kind: legal.ApplicationAccepted, Outcome: legal.ApplicationRecorded,
			Status: legal.TermsConsentStatus{
				Kind: legal.TermsStatusAccepted, Current: current, Accepted: accepted,
			},
		},
	}
}

func legalCheckoutApplication() *legalCheckoutStub {
	offer := legalTestOffer()
	evidence := legal.ContractEvidenceRecord{
		Scope: legalTestScope(), EvidenceID: legalTestEvidenceID, SubmissionID: legalTestCheckoutID,
		OfferHash: legalTestContractHash, Offer: offer, Consent: legal.ContractConsentAffirmed, ConfirmedAt: 1_500,
	}
	return &legalCheckoutStub{
		prepareResult: legal.PrepareContractOfferResult{
			Kind:     legal.PrepareContractAvailable,
			Prepared: legal.PreparedContractOffer{Offer: offer, OfferHash: legalTestContractHash},
		},
		confirmResult: legal.ContractCheckoutResult{
			Kind: legal.ContractCheckoutRedirect, Outcome: legal.ContractEvidenceRecorded,
			Evidence: evidence, CheckoutURL: "https://checkout.stripe.com/c/pay/cs_test_fukamu",
		},
	}
}

func legalTestOffer() legal.ContractOfferSnapshot {
	return legal.ContractOfferSnapshot{
		SchemaVersion: 1, OfferVersion: "legal-commerce-v1:2026-09-15", DisclosureVersion: "2026-09-15",
		ServiceName: "FUKAMU Notes", Quantity: "one-personal-vault", PlanName: "FUKAMU Notes 月額プラン",
		PriceYen: 980, BillingPeriod: legal.BillingPeriodMonthly, TaxIncluded: true, TrialDays: 14,
		TrialPriceYen: 0, FirstChargeDay: 15, RenewalChargeYen: 980, AnnualEstimateYen: 11_760,
		AutomaticRenewal: true, PaymentMethod: "credit-card",
		ServiceStart: "after-registration-and-payment-method-confirmation", ServicePeriod: "indefinite-until-cancelled",
		CancellationPolicy: "cancel future renewals", RefundPolicy: "no refund", AdditionalFees: "network fees",
		OnlineLockPolicy: "immediate-on-payment-failure-or-action-required", CancellationSeparateFromAccountDeletion: true,
	}
}

func legalTestSession() *identity.Session {
	return &identity.Session{
		Kind: identity.SessionActive, SessionID: legalTestSessionID, AccountID: legalTestAccountID,
		VaultID: legalTestVaultID, SessionEpoch: 1, IssuedAt: 1_000, ExpiresAt: 2_000,
	}
}

func legalTestScope() legal.TermsScope {
	return legal.TermsScope{AccountID: legalTestAccountID, VaultID: legalTestVaultID}
}

func legalTestVaultContext() identity.VaultContext {
	return identity.VaultContext{
		AccountID: legalTestAccountID, VaultID: legalTestVaultID,
		SessionID: legalTestSessionID, SessionEpoch: 1,
	}
}

func legalRequest(method, path, body string) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Cookie", identity.SessionCookieName+"="+legalTestToken)
	if method == http.MethodPost {
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", legalTestOrigin)
		request.Header.Set("Sec-Fetch-Site", "same-origin")
	}
	return request
}

func serveLegal(handler http.Handler, request *http.Request) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

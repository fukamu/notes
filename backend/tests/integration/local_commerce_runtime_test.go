//go:build integration

package integration_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/notes/backend/internal/access"
	legalhashadapter "github.com/fukamu/notes/backend/internal/adapters/legalhash"
	localcommerceadapter "github.com/fukamu/notes/backend/internal/adapters/localcommerce"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/legal"
	"github.com/fukamu/notes/backend/internal/localfixture"
	"github.com/fukamu/notes/backend/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
)

const localCommerceOrigin = "http://127.0.0.1:8080"

func TestLocalCommerceRuntimePostgres(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("NOTES_TEST_DATABASE_URL is required for integration tests")
	}
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("unsafe test database target: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 4)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, "DROP SCHEMA public CASCADE; CREATE SCHEMA public"); err != nil {
		t.Fatalf("reset local commerce schema: %v", err)
	}
	database, err := postgresadapter.OpenSQL(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	migrator, err := postgresadapter.NewMigrator(database, migrations.Files)
	if err != nil {
		t.Fatal(err)
	}
	if err := migrator.Up(ctx); err != nil {
		t.Fatalf("migrate local commerce database: %v", err)
	}

	seed, rawToken := localCommerceSeed(t)
	fixtureStore, err := postgresadapter.NewLocalFixtureStore(pool, seed)
	if err != nil {
		t.Fatal(err)
	}
	if err := fixtureStore.Seed(ctx); err != nil {
		t.Fatalf("seed local commerce fixture: %v", err)
	}
	if err := fixtureStore.Check(ctx); err != nil {
		t.Fatalf("check local commerce fixture: %v", err)
	}

	termsStore, _ := postgresadapter.NewTermsConsentStore(pool)
	evidenceStore, _ := postgresadapter.NewContractEvidenceStore(pool)
	billingStore, _ := postgresadapter.NewBillingStore(pool)
	entitlementStore, _ := postgresadapter.NewEntitlementStore(pool)
	sessionStore, _ := postgresadapter.NewSessionStore(pool)
	sessionResolver, _ := postgresadapter.NewSessionResolver(sessionStore)
	terms, err := legal.NewTermsConsentService(
		localcommerceadapter.TermsSource{}, legalhashadapter.SHA256Hasher{}, termsStore,
	)
	if err != nil {
		t.Fatal(err)
	}
	evidence, err := legal.NewContractEvidenceService(evidenceStore, legalhashadapter.OfferSHA256Hasher{})
	if err != nil {
		t.Fatal(err)
	}
	provider, err := localcommerceadapter.NewProvider(seed, billingStore, entitlementStore)
	if err != nil {
		t.Fatal(err)
	}
	checkout, err := legal.NewContractCheckoutApplication(
		evidence, localcommerceadapter.OfferSource{}, terms, provider,
	)
	if err != nil {
		t.Fatal(err)
	}
	cancellation, err := billing.NewCancellationService(billingStore, provider)
	if err != nil {
		t.Fatal(err)
	}

	now := int64(2_000)
	staticDirectory := t.TempDir()
	writeStaticSiteFixture(t, staticDirectory)
	handler, err := httpapi.NewHandler(httpapi.HandlerOptions{
		StaticDirectory: staticDirectory,
		BodyLimit:       4_000_000,
		Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		LegalRuntime: &httpapi.LegalRuntime{
			ExpectedOrigin: localCommerceOrigin,
			Clock:          func() int64 { return now },
			Sessions:       sessionResolver,
			Terms:          terms,
			Checkout:       checkout,
			NewTermsConsentID: sequenceIdentifier(
				"01999c20-9e33-7000-8000-000000000801",
				"01999c20-9e33-7000-8000-000000000802",
				"01999c20-9e33-7000-8000-000000000803",
			),
			NewContractEvidenceID: sequenceIdentifier(
				"01999c20-9e33-7000-8000-000000000811",
				"01999c20-9e33-7000-8000-000000000812",
				"01999c20-9e33-7000-8000-000000000813",
				"01999c20-9e33-7000-8000-000000000814",
			),
		},
		BillingCancellationRuntime: &httpapi.BillingCancellationRuntime{
			ExpectedOrigin: localCommerceOrigin,
			Clock:          func() int64 { return now },
			Sessions:       sessionResolver,
			Cancellation:   cancellation,
		},
		EnableDisconnectedFixtures: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	unauthenticated := serveLocalCommerce(
		handler,
		localCommerceRequest(ctx, http.MethodPost, "/api/billing/cancel", "not-json", ""),
	)
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("auth-before-body response = %d %s", unauthenticated.Code, unauthenticated.Body.String())
	}

	statusResponse := serveLocalCommerce(
		handler,
		localCommerceRequest(ctx, http.MethodGet, "/api/account/terms-consent", "", rawToken),
	)
	status := decodeLocalCommerceResponse(t, statusResponse, http.StatusOK)
	statusValue := objectValue(t, status, "status")
	currentTerms := objectValue(t, statusValue, "current")
	if stringValue(t, statusValue, "kind") != "current" ||
		boolValue(t, statusValue, "acceptanceRequired") != true {
		t.Fatalf("initial terms status = %#v", status)
	}
	termsVersion := stringValue(t, currentTerms, "termsVersion")
	termsHash := stringValue(t, currentTerms, "termsHash")

	offerResponse := serveLocalCommerce(
		handler,
		localCommerceRequest(ctx, http.MethodGet, "/api/billing/checkout", "", rawToken),
	)
	offer := decodeLocalCommerceResponse(t, offerResponse, http.StatusOK)
	offerHash := stringValue(t, offer, "offerHash")
	checkoutSubmissionID := "01999c20-9e33-7000-8000-000000000821"
	checkoutBody := marshalLocalCommerceBody(t, map[string]any{
		"submissionId":       checkoutSubmissionID,
		"presentedOfferHash": offerHash,
		"consent":            map[string]string{"kind": "affirmed"},
	})
	termsRequired := serveLocalCommerce(
		handler,
		localCommerceRequest(ctx, http.MethodPost, "/api/billing/checkout", checkoutBody, rawToken),
	)
	assertLocalCommerceError(t, termsRequired, http.StatusUnprocessableEntity, "terms-consent-required")
	assertLocalCommerceRowCount(t, ctx, pool, "contract_evidence", 0)

	termsSubmissionID := "01999c20-9e33-7000-8000-000000000822"
	termsBody := marshalLocalCommerceBody(t, map[string]any{
		"submissionId":          termsSubmissionID,
		"presentedTermsVersion": termsVersion,
		"presentedTermsHash":    termsHash,
		"consent":               map[string]string{"kind": "affirmed"},
	})
	acceptedResponse := serveLocalCommerce(
		handler,
		localCommerceRequest(ctx, http.MethodPost, "/api/account/terms-consent", termsBody, rawToken),
	)
	accepted := decodeLocalCommerceResponse(t, acceptedResponse, http.StatusOK)
	if stringValue(t, accepted, "outcome") != "recorded" {
		t.Fatalf("recorded terms response = %#v", accepted)
	}
	acceptedTerms := objectValue(t, objectValue(t, accepted, "status"), "accepted")
	consentID := stringValue(t, acceptedTerms, "consentId")
	now = 3_000
	replayedResponse := serveLocalCommerce(
		handler,
		localCommerceRequest(ctx, http.MethodPost, "/api/account/terms-consent", termsBody, rawToken),
	)
	replayed := decodeLocalCommerceResponse(t, replayedResponse, http.StatusOK)
	if stringValue(t, replayed, "outcome") != "replayed" ||
		stringValue(t, objectValue(t, objectValue(t, replayed, "status"), "accepted"), "consentId") != consentID {
		t.Fatalf("replayed terms response = %#v", replayed)
	}
	assertLocalCommerceRowCount(t, ctx, pool, "terms_consent_evidence", 1)

	staleTermsBody := marshalLocalCommerceBody(t, map[string]any{
		"submissionId":          "01999c20-9e33-7000-8000-000000000823",
		"presentedTermsVersion": termsVersion,
		"presentedTermsHash":    "sha256:" + strings.Repeat("0", 64),
		"consent":               map[string]string{"kind": "affirmed"},
	})
	staleTerms := serveLocalCommerce(
		handler,
		localCommerceRequest(ctx, http.MethodPost, "/api/account/terms-consent", staleTermsBody, rawToken),
	)
	assertLocalCommerceError(t, staleTerms, http.StatusConflict, "terms-changed")
	assertLocalCommerceRowCount(t, ctx, pool, "terms_consent_evidence", 1)

	checkoutRecordedResponse := serveLocalCommerce(
		handler,
		localCommerceRequest(ctx, http.MethodPost, "/api/billing/checkout", checkoutBody, rawToken),
	)
	checkoutRecorded := decodeLocalCommerceResponse(t, checkoutRecordedResponse, http.StatusOK)
	if stringValue(t, checkoutRecorded, "kind") != "local-confirmed" ||
		stringValue(t, checkoutRecorded, "evidenceOutcome") != "recorded" {
		t.Fatalf("recorded checkout response = %#v", checkoutRecorded)
	}
	if _, exists := checkoutRecorded["checkoutUrl"]; exists {
		t.Fatalf("local checkout leaked URL: %#v", checkoutRecorded)
	}
	evidenceID := stringValue(t, checkoutRecorded, "evidenceId")
	if evidenceID == consentID {
		t.Fatalf("terms and checkout identifiers were reused: %q", evidenceID)
	}
	now = 4_000
	checkoutReplayedResponse := serveLocalCommerce(
		handler,
		localCommerceRequest(ctx, http.MethodPost, "/api/billing/checkout", checkoutBody, rawToken),
	)
	checkoutReplayed := decodeLocalCommerceResponse(t, checkoutReplayedResponse, http.StatusOK)
	if stringValue(t, checkoutReplayed, "evidenceOutcome") != "replayed" ||
		stringValue(t, checkoutReplayed, "evidenceId") != evidenceID {
		t.Fatalf("replayed checkout response = %#v", checkoutReplayed)
	}
	assertLocalCommerceRowCount(t, ctx, pool, "contract_evidence", 1)

	staleOfferBody := marshalLocalCommerceBody(t, map[string]any{
		"submissionId":       "01999c20-9e33-7000-8000-000000000824",
		"presentedOfferHash": "sha256:" + strings.Repeat("0", 64),
		"consent":            map[string]string{"kind": "affirmed"},
	})
	staleOffer := serveLocalCommerce(
		handler,
		localCommerceRequest(ctx, http.MethodPost, "/api/billing/checkout", staleOfferBody, rawToken),
	)
	assertLocalCommerceError(t, staleOffer, http.StatusConflict, "offer-changed")
	assertLocalCommerceRowCount(t, ctx, pool, "contract_evidence", 1)

	billingBefore := localCommerceBillingRow(t, ctx, pool, seed)
	cancellationBody := marshalLocalCommerceBody(t, map[string]any{
		"idempotencyKey": "cancel_local_commerce_stable",
	})
	cancelledResponse := serveLocalCommerce(
		handler,
		localCommerceRequest(ctx, http.MethodPost, "/api/billing/cancel", cancellationBody, rawToken),
	)
	cancelled := decodeLocalCommerceResponse(t, cancelledResponse, http.StatusOK)
	if stringValue(t, cancelled, "status") != "cancellation-scheduled" ||
		stringValue(t, cancelled, "outcome") != "scheduled" {
		t.Fatalf("scheduled cancellation response = %#v", cancelled)
	}
	now = 5_000
	cancelledReplayResponse := serveLocalCommerce(
		handler,
		localCommerceRequest(ctx, http.MethodPost, "/api/billing/cancel", cancellationBody, rawToken),
	)
	cancelledReplay := decodeLocalCommerceResponse(t, cancelledReplayResponse, http.StatusOK)
	if !reflect.DeepEqual(cancelledReplay, cancelled) {
		t.Fatalf("cancellation replay = %#v, want %#v", cancelledReplay, cancelled)
	}
	if billingAfter := localCommerceBillingRow(t, ctx, pool, seed); billingAfter != billingBefore {
		t.Fatalf("no-effect cancellation changed billing row:\nbefore %s\nafter  %s", billingBefore, billingAfter)
	}

	if _, err := pool.Exec(
		ctx,
		"UPDATE billing_subscriptions SET provider_subscription_ref = $1 WHERE account_id = $2 AND vault_id = $3",
		"fixture-subscription-mismatch",
		string(seed.Context.AccountID),
		string(seed.Context.VaultID),
	); err != nil {
		t.Fatal(err)
	}
	mappingMismatch := serveLocalCommerce(
		handler,
		localCommerceRequest(ctx, http.MethodPost, "/api/billing/cancel", marshalLocalCommerceBody(t, map[string]any{
			"idempotencyKey": "cancel_local_commerce_mismatch",
		}), rawToken),
	)
	assertLocalCommerceError(t, mappingMismatch, http.StatusConflict, "cancellation-unavailable")
	if _, err := pool.Exec(
		ctx,
		"UPDATE billing_subscriptions SET provider_subscription_ref = $1 WHERE account_id = $2 AND vault_id = $3",
		string(seed.Subscription.ProviderSubscriptionReference),
		string(seed.Context.AccountID),
		string(seed.Context.VaultID),
	); err != nil {
		t.Fatal(err)
	}
	if err := fixtureStore.Check(ctx); err != nil {
		t.Fatalf("local commerce changed exact fixture state: %v", err)
	}
	assertLocalCommerceRowCount(t, ctx, pool, "terms_consent_evidence", 1)
	assertLocalCommerceRowCount(t, ctx, pool, "contract_evidence", 1)
}

func localCommerceSeed(t *testing.T) (localfixture.Seed, string) {
	t.Helper()
	allowed, _ := access.ParseSubject("fixture-owner")
	accountID, _ := identity.ParseAccountID("01999c20-9e33-7000-8000-000000000001")
	vaultID, _ := identity.ParseVaultID("01999c20-9e33-7000-8000-000000000002")
	sessionID, _ := identity.ParseSessionID("01999c20-9e33-7000-8000-000000000003")
	epoch, _ := identity.ParseSessionEpoch(1)
	rawToken := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x41}, 32))
	token, _ := identity.ParseSessionToken(rawToken)
	seed, err := localfixture.NewSeed(
		allowed,
		accountID,
		vaultID,
		sessionID,
		epoch,
		token,
		cryptocontent.VaultDEKMetadata{
			VaultID: vaultID, DEKVersion: 1, KEKReference: "local-fixture://key/1",
			WrappedDEK:     base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x52}, 32)),
			CreatedAtMilli: localfixture.FixtureTimestamp,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	return seed, rawToken
}

func sequenceIdentifier(values ...string) func() string {
	index := 0
	return func() string {
		if index >= len(values) {
			return ""
		}
		value := values[index]
		index++
		return value
	}
}

func localCommerceRequest(
	ctx context.Context,
	method string,
	path string,
	body string,
	token string,
) *http.Request {
	request := httptest.NewRequestWithContext(ctx, method, path, strings.NewReader(body))
	if token != "" {
		request.Header.Set("Cookie", identity.SessionCookieName+"="+token)
	}
	if method == http.MethodPost {
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", localCommerceOrigin)
		request.Header.Set("Sec-Fetch-Site", "same-origin")
	}
	return request
}

func serveLocalCommerce(handler http.Handler, request *http.Request) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func marshalLocalCommerceBody(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func decodeLocalCommerceResponse(
	t *testing.T,
	response *httptest.ResponseRecorder,
	wantStatus int,
) map[string]any {
	t.Helper()
	if response.Code != wantStatus {
		t.Fatalf("response = %d %s, want %d", response.Code, response.Body.String(), wantStatus)
	}
	decoder := json.NewDecoder(response.Body)
	decoder.UseNumber()
	var value map[string]any
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return value
}

func assertLocalCommerceError(
	t *testing.T,
	response *httptest.ResponseRecorder,
	wantStatus int,
	wantCode string,
) {
	t.Helper()
	value := decodeLocalCommerceResponse(t, response, wantStatus)
	if actual := stringValue(t, value, "error"); actual != wantCode {
		t.Fatalf("error code = %q, want %q", actual, wantCode)
	}
}

func objectValue(t *testing.T, value map[string]any, key string) map[string]any {
	t.Helper()
	object, ok := value[key].(map[string]any)
	if !ok {
		t.Fatalf("%s = %#v, want object", key, value[key])
	}
	return object
}

func stringValue(t *testing.T, value map[string]any, key string) string {
	t.Helper()
	text, ok := value[key].(string)
	if !ok {
		t.Fatalf("%s = %#v, want string", key, value[key])
	}
	return text
}

func boolValue(t *testing.T, value map[string]any, key string) bool {
	t.Helper()
	boolean, ok := value[key].(bool)
	if !ok {
		t.Fatalf("%s = %#v, want boolean", key, value[key])
	}
	return boolean
}

func assertLocalCommerceRowCount(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	table string,
	want int64,
) {
	t.Helper()
	var count int64
	query := fmt.Sprintf("SELECT COUNT(*) FROM %s", table)
	if err := pool.QueryRow(ctx, query).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("%s rows = %d, want %d", table, count, want)
	}
}

func localCommerceBillingRow(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	seed localfixture.Seed,
) string {
	t.Helper()
	var serialized string
	if err := pool.QueryRow(
		ctx,
		`SELECT row_to_json(snapshot)::text
		   FROM (
		     SELECT subscription_id, provider, provider_customer_ref,
		            provider_subscription_ref, version, status,
		            payment_method_ready, cancel_at, cancellation_updated_at,
		            created_at, updated_at
		       FROM billing_subscriptions
		      WHERE account_id = $1 AND vault_id = $2
		   ) AS snapshot`,
		string(seed.Context.AccountID),
		string(seed.Context.VaultID),
	).Scan(&serialized); err != nil {
		t.Fatal(err)
	}
	return serialized
}

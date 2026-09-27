//go:build integration

package integration_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/fukamu/notes/backend/internal/adapters/legalhash"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/legal"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type integrationTermsSource struct {
	value legal.CurrentTermsSourceValue
}

func (source integrationTermsSource) ReadCurrent(context.Context) (legal.CurrentTermsSourceValue, error) {
	return source.value, nil
}

type integrationTermsFixture struct {
	Disclosure legal.TermsDisclosure `json:"disclosure"`
	Expected   struct {
		CanonicalSHA256 string `json:"canonicalSha256"`
	} `json:"expected"`
}

func TestTermsConsentPostgres(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	store, err := postgresadapter.NewTermsConsentStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	provisioning, err := postgresadapter.NewSignupProvisioningStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	fixture := readIntegrationTermsFixture(t)
	service, err := legal.NewTermsConsentService(
		integrationTermsSource{value: legal.CurrentTermsSourceValue{
			Disclosure:       fixture.Disclosure,
			AcceptancePolicy: legal.AcceptancePolicy{Kind: legal.AcceptanceInitialRelease},
		}},
		legalhash.SHA256Hasher{},
		store,
	)
	if err != nil {
		t.Fatal(err)
	}
	signupTerms, err := legal.NewSignupTermsAdmission(service)
	if err != nil {
		t.Fatal(err)
	}

	reservation := integrationSignupReservation(t, 20, "terms@example.com")
	reserved, err := provisioning.Reserve(ctx, reservation)
	if err != nil || reserved.Kind != identity.SignupReservationReserved {
		t.Fatalf("Reserve() = %#v, %v", reserved, err)
	}
	termsInput := identity.SignupTermsConsent{
		SubmissionID:          reservation.SubmissionID,
		PresentedTermsVersion: string(fixture.Disclosure.TermsVersion),
		PresentedTermsHash:    fixture.Expected.CanonicalSHA256,
		Affirmed:              true,
	}
	consentID := integrationUUID(t, 720)
	accepted, err := signupTerms.AcceptSignupTerms(ctx, reservation, termsInput, consentID, 2_000)
	if err != nil || !accepted.Accepted || !accepted.Evidence.Valid() || accepted.Evidence.TermsConsentID != consentID {
		t.Fatalf("AcceptSignupTerms() = %#v, %v", accepted, err)
	}
	replayed, err := signupTerms.AcceptSignupTerms(ctx, reservation, termsInput, integrationUUID(t, 721), 3_000)
	if err != nil || !replayed.Accepted || replayed.Evidence != accepted.Evidence {
		t.Fatalf("replayed AcceptSignupTerms() = %#v, %v", replayed, err)
	}

	plan := identity.PlanSignupAdmission(reservation.Identity, reservation.SubmissionID, reservation, accepted.Evidence)
	token := integrationSessionToken(t, 'T', 'Q')
	tokenHash, _ := identity.HashSessionToken(token)
	finalized, err := provisioning.Finalize(ctx, plan, integrationSignupSession(t, reservation, 2_100), tokenHash)
	if err != nil || finalized.Kind != identity.SignupFinalizationCreated {
		t.Fatalf("Finalize() = %#v, %v", finalized, err)
	}
	scope := legal.TermsScope{AccountID: reservation.AccountID, VaultID: reservation.VaultID}
	stored, err := store.FindBySubmission(ctx, scope, mustIntegrationTermsSubmissionID(t, reservation.SubmissionID))
	if err != nil || stored == nil || string(stored.ConsentID) != consentID || stored.AcceptedAt != 2_000 {
		t.Fatalf("stored consent = %#v, %v", stored, err)
	}
	status := service.Status(ctx, scope)
	if status.Kind != legal.ApplicationAccepted || status.Status.Kind != legal.TermsStatusAccepted {
		t.Fatalf("status after finalization = %#v", status)
	}
	foreignScope := legal.TermsScope{AccountID: integrationAccountID(t, 191), VaultID: integrationVaultID(t, 291)}
	if foreign, err := store.FindByID(ctx, foreignScope, stored.ConsentID); err != nil || foreign != nil {
		t.Fatalf("cross-owner consent = %#v, %v", foreign, err)
	}

	assertTermsConsentImmutable(t, ctx, pool, scope, stored.ConsentID)
	assertTermsConsentOwnerIsolation(t, ctx, store, fixture)
	assertConcurrentTermsConsentReplay(t, ctx, provisioning, signupTerms, fixture)
	assertMalformedTermsEvidenceFailsClosed(t, ctx, pool, store, scope)
	if pool.Stat().AcquiredConns() != 0 {
		t.Fatalf("database connections still acquired: %d", pool.Stat().AcquiredConns())
	}
}

func assertMalformedTermsEvidenceFailsClosed(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	store *postgresadapter.TermsConsentStore,
	scope legal.TermsScope,
) {
	t.Helper()
	if _, err := pool.Exec(ctx, "ALTER TABLE terms_consent_evidence DROP CONSTRAINT terms_consent_shape_check"); err != nil {
		t.Fatal(err)
	}
	consentID := mustIntegrationTermsConsentID(t, integrationUUID(t, 791))
	submissionID := mustIntegrationTermsSubmissionID(t, integrationUUID(t, 891))
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO terms_consent_evidence(
		 account_id, vault_id, consent_id, submission_id, terms_version,
		 terms_hash, serialized_terms, consent, accepted_at
		) VALUES ($1, $2, $3, $4, 'terms-v1:2026-09-15', $5, '{}', 'affirmed', 6000)`,
		string(scope.AccountID), string(scope.VaultID), string(consentID), string(submissionID),
		"sha256:"+strings.Repeat("a", 64),
	); err != nil {
		t.Fatal(err)
	}
	if record, err := store.FindByID(ctx, scope, consentID); !errors.Is(err, postgresadapter.ErrInvalidTermsConsentRecord) || record != nil {
		t.Fatalf("malformed record = %#v, %v", record, err)
	}
}

func assertTermsConsentImmutable(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	scope legal.TermsScope,
	consentID legal.TermsConsentID,
) {
	t.Helper()
	_, err := pool.Exec(
		ctx,
		"UPDATE terms_consent_evidence SET accepted_at = accepted_at + 1 WHERE account_id = $1 AND vault_id = $2 AND consent_id = $3",
		string(scope.AccountID), string(scope.VaultID), string(consentID),
	)
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) || postgresError.ConstraintName != "terms_consent_immutable" {
		t.Fatalf("immutable update error = %v", err)
	}
}

func assertTermsConsentOwnerIsolation(
	t *testing.T,
	ctx context.Context,
	store *postgresadapter.TermsConsentStore,
	fixture integrationTermsFixture,
) {
	t.Helper()
	scope := legal.TermsScope{
		AccountID: integrationAccountID(t, 190),
		VaultID:   integrationVaultID(t, 290),
	}
	hash, _ := legal.ParseTermsDocumentHash(fixture.Expected.CanonicalSHA256)
	snapshot := legal.PlanTermsSnapshot(fixture.Disclosure, hash)
	record := legal.TermsConsentRecord{
		Scope:        scope,
		ConsentID:    mustIntegrationTermsConsentID(t, integrationUUID(t, 790)),
		SubmissionID: mustIntegrationTermsSubmissionID(t, integrationUUID(t, 890)),
		Snapshot:     snapshot.Snapshot,
		Consent:      legal.ConsentAffirmed,
		AcceptedAt:   4_000,
	}
	result, err := store.Append(ctx, record)
	if err != nil || result.Kind != legal.TermsAppendOwnerMismatch {
		t.Fatalf("ownerless append = %#v, %v", result, err)
	}
	if found, err := store.FindBySubmission(ctx, scope, record.SubmissionID); err != nil || found != nil {
		t.Fatalf("ownerless evidence = %#v, %v", found, err)
	}
}

func assertConcurrentTermsConsentReplay(
	t *testing.T,
	ctx context.Context,
	provisioning *postgresadapter.SignupProvisioningStore,
	signupTerms *legal.SignupTermsAdmission,
	fixture integrationTermsFixture,
) {
	t.Helper()
	reservation := integrationSignupReservation(t, 21, "terms-race@example.com")
	if result, err := provisioning.Reserve(ctx, reservation); err != nil || result.Kind != identity.SignupReservationReserved {
		t.Fatalf("race Reserve() = %#v, %v", result, err)
	}
	input := identity.SignupTermsConsent{
		SubmissionID:          reservation.SubmissionID,
		PresentedTermsVersion: string(fixture.Disclosure.TermsVersion),
		PresentedTermsHash:    fixture.Expected.CanonicalSHA256,
		Affirmed:              true,
	}
	type outcome struct {
		result identity.SignupTermsAdmissionResult
		err    error
	}
	start := make(chan struct{})
	outcomes := make(chan outcome, 2)
	var wait sync.WaitGroup
	for _, consentID := range []string{integrationUUID(t, 722), integrationUUID(t, 723)} {
		wait.Add(1)
		go func(id string) {
			defer wait.Done()
			<-start
			result, err := signupTerms.AcceptSignupTerms(ctx, reservation, input, id, 5_000)
			outcomes <- outcome{result: result, err: err}
		}(consentID)
	}
	close(start)
	wait.Wait()
	close(outcomes)
	var evidence *identity.SignupTermsEvidence
	for outcome := range outcomes {
		if outcome.err != nil || !outcome.result.Accepted {
			t.Fatalf("concurrent acceptance = %#v, %v", outcome.result, outcome.err)
		}
		if evidence == nil {
			copy := outcome.result.Evidence
			evidence = &copy
		} else if *evidence != outcome.result.Evidence {
			t.Fatalf("concurrent evidence differs: %#v and %#v", *evidence, outcome.result.Evidence)
		}
	}
}

func readIntegrationTermsFixture(t *testing.T) integrationTermsFixture {
	t.Helper()
	content, err := os.ReadFile("../../../contracts/fixtures/legal/terms-consent.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture integrationTermsFixture
	if err := json.Unmarshal(content, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func mustIntegrationTermsConsentID(t *testing.T, value string) legal.TermsConsentID {
	t.Helper()
	parsed, err := legal.ParseTermsConsentID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustIntegrationTermsSubmissionID(t *testing.T, value string) legal.TermsConsentSubmissionID {
	t.Helper()
	parsed, err := legal.ParseTermsConsentSubmissionID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

package legal

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/identity"
)

var errTermsTestUnavailable = errors.New("test dependency unavailable")

type fakeTermsSource struct {
	value CurrentTermsSourceValue
	err   error
}

func (source *fakeTermsSource) ReadCurrent(context.Context) (CurrentTermsSourceValue, error) {
	return source.value, source.err
}

type fakeTermsHasher struct{ err error }

func (hasher *fakeTermsHasher) Hash(_ context.Context, serialized string) (TermsDocumentHash, error) {
	if hasher.err != nil {
		return "", hasher.err
	}
	digest := sha256.Sum256([]byte(serialized))
	return TermsDocumentHash("sha256:" + hex.EncodeToString(digest[:])), nil
}

type fakeTermsRepository struct {
	records    []TermsConsentRecord
	readErr    error
	appendErr  error
	appendKind TermsAppendKind
}

func (repository *fakeTermsRepository) FindByID(
	_ context.Context,
	scope TermsScope,
	consentID TermsConsentID,
) (*TermsConsentRecord, error) {
	if repository.readErr != nil {
		return nil, repository.readErr
	}
	for _, record := range repository.records {
		if record.Scope == scope && record.ConsentID == consentID {
			found := cloneTermsRecord(record)
			return &found, nil
		}
	}
	return nil, nil
}

func (repository *fakeTermsRepository) FindBySubmission(
	_ context.Context,
	scope TermsScope,
	submissionID TermsConsentSubmissionID,
) (*TermsConsentRecord, error) {
	if repository.readErr != nil {
		return nil, repository.readErr
	}
	for _, record := range repository.records {
		if record.Scope == scope && record.SubmissionID == submissionID {
			found := cloneTermsRecord(record)
			return &found, nil
		}
	}
	return nil, nil
}

func (repository *fakeTermsRepository) FindLatest(
	_ context.Context,
	scope TermsScope,
) (*TermsConsentRecord, error) {
	if repository.readErr != nil {
		return nil, repository.readErr
	}
	var latest *TermsConsentRecord
	for _, record := range repository.records {
		if record.Scope == scope && (latest == nil || record.AcceptedAt > latest.AcceptedAt) {
			found := cloneTermsRecord(record)
			latest = &found
		}
	}
	return latest, nil
}

func (repository *fakeTermsRepository) Append(
	_ context.Context,
	record TermsConsentRecord,
) (TermsAppendResult, error) {
	if repository.appendErr != nil {
		return TermsAppendResult{}, repository.appendErr
	}
	if repository.appendKind != "" && repository.appendKind != TermsAppendCreated {
		return TermsAppendResult{Kind: repository.appendKind}, nil
	}
	for index := range repository.records {
		existing := repository.records[index]
		if existing.Scope == record.Scope && existing.SubmissionID == record.SubmissionID {
			found := cloneTermsRecord(existing)
			return TermsAppendResult{Kind: TermsAppendExisting, Record: &found}, nil
		}
	}
	repository.records = append(repository.records, cloneTermsRecord(record))
	return TermsAppendResult{Kind: TermsAppendCreated}, nil
}

func TestTermsConsentServiceRecordsReplaysAndVerifiesCheckout(t *testing.T) {
	fixture := readTermsFixture(t)
	source := &fakeTermsSource{value: CurrentTermsSourceValue{
		Disclosure: fixture.Disclosure, AcceptancePolicy: AcceptancePolicy{Kind: AcceptanceInitialRelease},
	}}
	repository := &fakeTermsRepository{}
	service, err := NewTermsConsentService(source, &fakeTermsHasher{}, repository)
	if err != nil {
		t.Fatal(err)
	}
	scope := fixture.termsScope(t)
	initial := service.Status(context.Background(), scope)
	if initial.Kind != ApplicationAccepted || initial.Outcome != ApplicationStatus ||
		initial.Status.Kind != TermsStatusCurrent || !initial.Status.AcceptanceRequired {
		t.Fatalf("initial status = %#v", initial)
	}
	command := fixtureTermsCommand(t, fixture)
	consentID := mustConsentID(t, fixture.ConsentID)
	recorded := service.Accept(context.Background(), scope, command, consentID, fixture.AcceptedAt)
	if recorded.Kind != ApplicationAccepted || recorded.Outcome != ApplicationRecorded ||
		recorded.Status.Accepted == nil || recorded.Status.Accepted.ConsentID != consentID {
		t.Fatalf("recorded = %#v", recorded)
	}
	replayed := service.Accept(
		context.Background(), scope, command,
		mustConsentID(t, "01991f20-61d2-7000-8000-000000002502"), 3_000,
	)
	if replayed.Kind != ApplicationAccepted || replayed.Outcome != ApplicationReplayed ||
		replayed.Status.Accepted == nil || replayed.Status.Accepted.ConsentID != consentID ||
		replayed.Status.Accepted.AcceptedAt != fixture.AcceptedAt {
		t.Fatalf("replayed = %#v", replayed)
	}

	vaultContext := identity.VaultContext{
		AccountID: scope.AccountID, VaultID: scope.VaultID,
		SessionID:    mustSessionID(t, "01991f20-61d2-7000-8000-000000000401"),
		SessionEpoch: mustSessionEpoch(t, 1),
	}
	verified := service.VerifyCheckout(context.Background(), vaultContext)
	if verified.Kind != CheckoutTermsAccepted || verified.ConsentID != consentID {
		t.Fatalf("checkout verification = %#v", verified)
	}
}

func TestCheckoutVerificationUsesLatestOwnerConsentNotCommercialSubmissionID(t *testing.T) {
	fixture := readTermsFixture(t)
	source := &fakeTermsSource{value: CurrentTermsSourceValue{
		Disclosure: fixture.Disclosure, AcceptancePolicy: AcceptancePolicy{Kind: AcceptanceInitialRelease},
	}}
	repository := &fakeTermsRepository{}
	service, err := NewTermsConsentService(source, &fakeTermsHasher{}, repository)
	if err != nil {
		t.Fatal(err)
	}
	vaultContext := identity.VaultContext{
		AccountID: fixture.termsScope(t).AccountID, VaultID: fixture.termsScope(t).VaultID,
		SessionID:    mustSessionID(t, "01991f20-61d2-7000-8000-000000000401"),
		SessionEpoch: mustSessionEpoch(t, 1),
	}

	missing := service.VerifyCheckout(context.Background(), vaultContext)
	if missing.Kind != CheckoutTermsRejected || missing.Reason != CheckoutTermsConsentRequired {
		t.Fatalf("missing consent = %#v", missing)
	}

	command := fixtureTermsCommand(t, fixture)
	accepted := service.Accept(
		context.Background(), fixture.termsScope(t), command,
		mustConsentID(t, fixture.ConsentID), fixture.AcceptedAt,
	)
	if accepted.Kind != ApplicationAccepted {
		t.Fatalf("accept = %#v", accepted)
	}
	verified := service.VerifyCheckout(context.Background(), vaultContext)
	if verified.Kind != CheckoutTermsAccepted || string(verified.ConsentID) != fixture.ConsentID {
		t.Fatalf("current consent = %#v", verified)
	}

	source.value.Disclosure.TermsVersion = "terms-v1:2026-10-01"
	source.value.Disclosure.EffectiveDate = "2026-10-01"
	source.value.AcceptancePolicy = AcceptancePolicy{
		Kind: AcceptanceReconsentRequired, LegalReviewID: "legal-review:2026-10-01",
	}
	reconsent := service.VerifyCheckout(context.Background(), vaultContext)
	if reconsent.Kind != CheckoutTermsRejected || reconsent.Reason != CheckoutTermsChanged {
		t.Fatalf("reconsent verification = %#v", reconsent)
	}

	source.value.AcceptancePolicy = AcceptancePolicy{
		Kind: AcceptanceNoticeOnly, LegalReviewID: "legal-review:2026-10-01",
	}
	noticeOnly := service.VerifyCheckout(context.Background(), vaultContext)
	if noticeOnly.Kind != CheckoutTermsAccepted || string(noticeOnly.ConsentID) != fixture.ConsentID {
		t.Fatalf("notice-only verification = %#v", noticeOnly)
	}

	repository.readErr = errTermsTestUnavailable
	unavailable := service.VerifyCheckout(context.Background(), vaultContext)
	if unavailable.Kind != CheckoutTermsRejected || unavailable.Reason != CheckoutTermsUnavailable {
		t.Fatalf("unavailable verification = %#v", unavailable)
	}
}

func TestTermsConsentServiceFailsClosed(t *testing.T) {
	fixture := readTermsFixture(t)
	scope := fixture.termsScope(t)
	validSource := CurrentTermsSourceValue{
		Disclosure: fixture.Disclosure, AcceptancePolicy: AcceptancePolicy{Kind: AcceptanceInitialRelease},
	}
	tests := []struct {
		name       string
		source     *fakeTermsSource
		hasher     *fakeTermsHasher
		repository *fakeTermsRepository
		want       ApplicationRejectionReason
	}{
		{name: "source", source: &fakeTermsSource{err: errTermsTestUnavailable}, hasher: &fakeTermsHasher{}, repository: &fakeTermsRepository{}, want: ApplicationInvalidCurrentTerms},
		{name: "hash", source: &fakeTermsSource{value: validSource}, hasher: &fakeTermsHasher{err: errTermsTestUnavailable}, repository: &fakeTermsRepository{}, want: ApplicationHashUnavailable},
		{name: "repository", source: &fakeTermsSource{value: validSource}, hasher: &fakeTermsHasher{}, repository: &fakeTermsRepository{readErr: errTermsTestUnavailable}, want: ApplicationUnavailable},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service, err := NewTermsConsentService(test.source, test.hasher, test.repository)
			if err != nil {
				t.Fatal(err)
			}
			result := service.Status(context.Background(), scope)
			if result.Kind != ApplicationRejected || result.Reason != test.want {
				t.Fatalf("status = %#v", result)
			}
		})
	}

	repository := &fakeTermsRepository{appendKind: TermsAppendOwnerMismatch}
	service, _ := NewTermsConsentService(&fakeTermsSource{value: validSource}, &fakeTermsHasher{}, repository)
	result := service.Accept(context.Background(), scope, fixtureTermsCommand(t, fixture), mustConsentID(t, fixture.ConsentID), fixture.AcceptedAt)
	if result.Kind != ApplicationRejected || result.Reason != ApplicationOwnerMismatch {
		t.Fatalf("owner mismatch = %#v", result)
	}
}

func TestSignupTermsAdmissionPreservesReplayEvidence(t *testing.T) {
	fixture := readTermsFixture(t)
	repository := &fakeTermsRepository{}
	service, _ := NewTermsConsentService(
		&fakeTermsSource{value: CurrentTermsSourceValue{
			Disclosure: fixture.Disclosure, AcceptancePolicy: AcceptancePolicy{Kind: AcceptanceInitialRelease},
		}},
		&fakeTermsHasher{}, repository,
	)
	adapter, err := NewSignupTermsAdmission(service)
	if err != nil {
		t.Fatal(err)
	}
	reservation := termsSignupReservation(t, fixture)
	input := identity.SignupTermsConsent{
		SubmissionID: fixture.SubmissionID, PresentedTermsVersion: string(fixture.Disclosure.TermsVersion),
		PresentedTermsHash: fixture.Expected.CanonicalSHA256, Affirmed: true,
	}
	created, err := adapter.AcceptSignupTerms(context.Background(), reservation, input, fixture.ConsentID, fixture.AcceptedAt)
	if err != nil || !created.Accepted || created.Evidence.TermsConsentID != fixture.ConsentID {
		t.Fatalf("created signup consent = %#v, %v", created, err)
	}
	replayed, err := adapter.AcceptSignupTerms(
		context.Background(), reservation, input,
		"01991f20-61d2-7000-8000-000000002502", 3_000,
	)
	if err != nil || !replayed.Accepted || replayed.Evidence != created.Evidence {
		t.Fatalf("replayed signup consent = %#v, %v", replayed, err)
	}

	input.Affirmed = false
	rejected, err := adapter.AcceptSignupTerms(context.Background(), reservation, input, fixture.ConsentID, 4_000)
	if err != nil || rejected.Accepted || rejected.Reason != "terms-consent-required" {
		t.Fatalf("unaffirmed signup consent = %#v, %v", rejected, err)
	}
}

func fixtureTermsCommand(t *testing.T, fixture termsFixture) TermsConsentCommand {
	t.Helper()
	return TermsConsentCommand{
		SubmissionID:          mustSubmissionID(t, fixture.SubmissionID),
		PresentedTermsVersion: fixture.Disclosure.TermsVersion,
		PresentedTermsHash:    mustTermsHash(t, fixture.Expected.CanonicalSHA256),
		Consent:               ConsentAffirmed,
	}
}

func termsSignupReservation(t *testing.T, fixture termsFixture) identity.SignupAdmissionReservation {
	t.Helper()
	email, err := identity.ParseEmailOtpAddress("person@example.com")
	if err != nil {
		t.Fatal(err)
	}
	identityID, _ := identity.ParseIdentityID("01991f20-61d2-7000-8000-000000000301")
	return identity.SignupAdmissionReservation{
		SubmissionID: fixture.SubmissionID,
		Identity:     identity.VerifiedSignupIdentity{Kind: identity.SignupIdentityEmailOtp, Address: email},
		AccountID:    fixture.termsScope(t).AccountID, VaultID: fixture.termsScope(t).VaultID,
		IdentityID: identityID, SessionID: mustSessionID(t, "01991f20-61d2-7000-8000-000000000401"),
		SessionEpoch: mustSessionEpoch(t, 1), CreatedAt: 1_000,
	}
}

func testTermsScope(t *testing.T, account string, vault string) TermsScope {
	t.Helper()
	accountID, err := identity.ParseAccountID(account)
	if err != nil {
		t.Fatal(err)
	}
	vaultID, err := identity.ParseVaultID(vault)
	if err != nil {
		t.Fatal(err)
	}
	return TermsScope{AccountID: accountID, VaultID: vaultID}
}

func mustConsentID(t *testing.T, value string) TermsConsentID {
	t.Helper()
	parsed, err := ParseTermsConsentID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustSubmissionID(t *testing.T, value string) TermsConsentSubmissionID {
	t.Helper()
	parsed, err := ParseTermsConsentSubmissionID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustTermsHash(t *testing.T, value string) TermsDocumentHash {
	t.Helper()
	parsed, err := ParseTermsDocumentHash(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustSessionID(t *testing.T, value string) identity.SessionID {
	t.Helper()
	parsed, err := identity.ParseSessionID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustSessionEpoch(t *testing.T, value int64) identity.SessionEpoch {
	t.Helper()
	parsed, err := identity.ParseSessionEpoch(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

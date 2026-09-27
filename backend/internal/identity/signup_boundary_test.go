package identity

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
)

type fakeSignupIdentifiers struct {
	tokens       []string
	consentIDs   []string
	tokenIndex   int
	consentIndex int
	mu           sync.Mutex
}

func (identifiers *fakeSignupIdentifiers) CreateAccountID(context.Context) (string, error) {
	return fixtureAccountID, nil
}

func (identifiers *fakeSignupIdentifiers) CreateVaultID(context.Context) (string, error) {
	return fixtureVaultID, nil
}

func (identifiers *fakeSignupIdentifiers) CreateIdentityID(context.Context) (string, error) {
	return fixtureIdentityID, nil
}

func (identifiers *fakeSignupIdentifiers) CreateSessionID(context.Context) (string, error) {
	return fixtureSessionID, nil
}

func (identifiers *fakeSignupIdentifiers) CreateSessionToken(context.Context) (string, error) {
	identifiers.mu.Lock()
	defer identifiers.mu.Unlock()
	if identifiers.tokenIndex >= len(identifiers.tokens) {
		return "", errors.New("tokens exhausted")
	}
	value := identifiers.tokens[identifiers.tokenIndex]
	identifiers.tokenIndex++
	return value, nil
}

func (identifiers *fakeSignupIdentifiers) CreateTermsConsentID(context.Context) (string, error) {
	identifiers.mu.Lock()
	defer identifiers.mu.Unlock()
	if identifiers.consentIndex >= len(identifiers.consentIDs) {
		return "", errors.New("consent IDs exhausted")
	}
	value := identifiers.consentIDs[identifiers.consentIndex]
	identifiers.consentIndex++
	return value, nil
}

type fakeSignupTerms struct {
	mu       sync.Mutex
	evidence map[string]SignupTermsEvidence
	reason   string
}

func (terms *fakeSignupTerms) AcceptSignupTerms(
	_ context.Context,
	reservation SignupAdmissionReservation,
	consent SignupTermsConsent,
	consentID string,
	_ int64,
) (SignupTermsAdmissionResult, error) {
	if terms.reason != "" {
		return SignupTermsAdmissionResult{Reason: terms.reason}, nil
	}
	if !consent.Affirmed {
		return SignupTermsAdmissionResult{Reason: "terms-consent-required"}, nil
	}
	terms.mu.Lock()
	defer terms.mu.Unlock()
	if terms.evidence == nil {
		terms.evidence = make(map[string]SignupTermsEvidence)
	}
	evidence, ok := terms.evidence[consent.SubmissionID]
	if !ok {
		evidence = SignupTermsEvidence{
			SubmissionID: consent.SubmissionID, AccountID: reservation.AccountID,
			VaultID: reservation.VaultID, TermsConsentID: consentID,
		}
		terms.evidence[consent.SubmissionID] = evidence
	}
	return SignupTermsAdmissionResult{Accepted: true, Evidence: evidence}, nil
}

type fakeSignupProvisioning struct {
	mu            sync.Mutex
	reservation   *SignupAdmissionReservation
	record        *SignupFinalizationRecord
	tokenHashes   []SessionTokenHash
	finalizations int
	malformed     bool
}

func (provisioning *fakeSignupProvisioning) Reserve(
	_ context.Context,
	candidate SignupAdmissionReservation,
) (SignupReservationResult, error) {
	provisioning.mu.Lock()
	defer provisioning.mu.Unlock()
	if provisioning.malformed {
		candidate.SessionEpoch = 2
		return SignupReservationResult{Kind: SignupReservationReserved, Reservation: candidate}, nil
	}
	if provisioning.reservation == nil {
		stored := candidate
		provisioning.reservation = &stored
		return SignupReservationResult{Kind: SignupReservationReserved, Reservation: stored}, nil
	}
	if provisioning.reservation.SubmissionID != candidate.SubmissionID ||
		!sameSignupIdentity(provisioning.reservation.Identity, candidate.Identity) {
		return SignupReservationResult{Kind: SignupReservationConflict}, nil
	}
	return SignupReservationResult{Kind: SignupReservationReserved, Reservation: *provisioning.reservation}, nil
}

func (provisioning *fakeSignupProvisioning) Finalize(
	_ context.Context,
	plan SignupAdmissionPlan,
	session Session,
	tokenHash SessionTokenHash,
) (SignupFinalizationResult, error) {
	provisioning.mu.Lock()
	defer provisioning.mu.Unlock()
	if provisioning.reservation == nil || !plan.Ready || plan.Reservation != *provisioning.reservation {
		return SignupFinalizationResult{Kind: SignupFinalizationConflict}, nil
	}
	record := SignupFinalizationRecord{
		Reservation: plan.Reservation, TermsConsentID: plan.ConsentID,
		IssuedAt: session.IssuedAt, ExpiresAt: session.ExpiresAt,
	}
	kind := SignupFinalizationCreated
	if provisioning.record != nil {
		if provisioning.record.Reservation != record.Reservation || provisioning.record.TermsConsentID != record.TermsConsentID {
			return SignupFinalizationResult{Kind: SignupFinalizationConflict}, nil
		}
		kind = SignupFinalizationReplayed
	}
	provisioning.record = &record
	provisioning.tokenHashes = append(provisioning.tokenHashes, tokenHash)
	provisioning.finalizations++
	return SignupFinalizationResult{Kind: kind, Record: record}, nil
}

func TestSignupApplicationCreatesAndReplaysWithFreshHashedSession(t *testing.T) {
	identifiers := &fakeSignupIdentifiers{
		tokens: []string{strings.Repeat("A", 43), strings.Repeat("B", 42) + "E"},
		consentIDs: []string{
			"01991f20-61d2-7000-8000-000000000601",
			"01991f20-61d2-7000-8000-000000000602",
		},
	}
	provisioning := &fakeSignupProvisioning{}
	application, err := NewSignupApplication(fixedEmailOtpClock(2_000), identifiers, provisioning, &fakeSignupTerms{})
	if err != nil {
		t.Fatal(err)
	}
	identity := signupGoogleFixture(t)
	consent := signupConsentFixture()
	created, err := application.Admit(context.Background(), identity, consent)
	if err != nil || !created.Admitted || created.Outcome != "created" || !created.Receipt.Valid() {
		t.Fatalf("created admission = %#v, %v", created, err)
	}
	if string(created.Receipt.SessionToken) != strings.Repeat("A", 43) {
		t.Fatalf("created token = %q", created.Receipt.SessionToken)
	}
	replayed, err := application.Admit(context.Background(), identity, consent)
	if err != nil || !replayed.Admitted || replayed.Outcome != "replayed" || !replayed.Receipt.Valid() {
		t.Fatalf("replayed admission = %#v, %v", replayed, err)
	}
	if replayed.Receipt.SessionToken == created.Receipt.SessionToken || provisioning.finalizations != 2 ||
		len(provisioning.tokenHashes) != 2 || provisioning.tokenHashes[0] == provisioning.tokenHashes[1] {
		t.Fatalf("session replay did not rotate material: created=%q replay=%q hashes=%#v", created.Receipt.SessionToken, replayed.Receipt.SessionToken, provisioning.tokenHashes)
	}
	for _, hash := range provisioning.tokenHashes {
		if string(hash) == string(created.Receipt.SessionToken) || string(hash) == string(replayed.Receipt.SessionToken) {
			t.Fatal("raw session token reached provisioning")
		}
	}
}

func TestSignupApplicationRejectsTermsAndMalformedReservation(t *testing.T) {
	identifiers := &fakeSignupIdentifiers{
		tokens:     []string{strings.Repeat("A", 43)},
		consentIDs: []string{"01991f20-61d2-7000-8000-000000000601"},
	}
	provisioning := &fakeSignupProvisioning{}
	application, _ := NewSignupApplication(fixedEmailOtpClock(2_000), identifiers, provisioning, &fakeSignupTerms{})
	consent := signupConsentFixture()
	consent.Affirmed = false
	rejected, err := application.Admit(context.Background(), signupGoogleFixture(t), consent)
	if err != nil || rejected.Admitted || rejected.Reason != "terms-consent-required" || provisioning.reservation != nil {
		t.Fatalf("not-affirmed admission = %#v, %v", rejected, err)
	}

	malformed := &fakeSignupProvisioning{malformed: true}
	application, _ = NewSignupApplication(fixedEmailOtpClock(2_000), identifiers, malformed, &fakeSignupTerms{})
	rejected, err = application.Admit(context.Background(), signupGoogleFixture(t), signupConsentFixture())
	if err != nil || rejected.Admitted || rejected.Reason != "unavailable" || malformed.finalizations != 0 {
		t.Fatalf("malformed reservation admission = %#v, %v", rejected, err)
	}
}

func TestSignupApplicationStopsBeforeFinalizeOnTermsFailure(t *testing.T) {
	identifiers := &fakeSignupIdentifiers{
		tokens:     []string{strings.Repeat("A", 43)},
		consentIDs: []string{"01991f20-61d2-7000-8000-000000000601"},
	}
	provisioning := &fakeSignupProvisioning{}
	application, _ := NewSignupApplication(
		fixedEmailOtpClock(2_000), identifiers, provisioning, &fakeSignupTerms{reason: "terms-changed"},
	)
	rejected, err := application.Admit(context.Background(), signupGoogleFixture(t), signupConsentFixture())
	if err != nil || rejected.Admitted || rejected.Reason != "terms-changed" || provisioning.finalizations != 0 {
		t.Fatalf("stale terms admission = %#v, %v", rejected, err)
	}
}

func signupConsentFixture() SignupTermsConsent {
	return SignupTermsConsent{
		SubmissionID: fixtureIdentityID, PresentedTermsVersion: "terms-v1:2026-02-27",
		PresentedTermsHash: "sha256:" + strings.Repeat("a", 64), Affirmed: true,
	}
}

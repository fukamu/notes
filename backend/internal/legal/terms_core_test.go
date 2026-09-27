package legal

import "testing"

func TestTermsConsentCoreRejectsUnsafeAlternatives(t *testing.T) {
	fixture := readTermsFixture(t)
	scope := fixture.termsScope(t)
	hash, _ := ParseTermsDocumentHash(fixture.Expected.CanonicalSHA256)
	snapshot := PlanTermsSnapshot(fixture.Disclosure, hash)
	if snapshot.Kind != SnapshotReady {
		t.Fatal("fixture snapshot is invalid")
	}
	submissionID, _ := ParseTermsConsentSubmissionID(fixture.SubmissionID)
	consentID, _ := ParseTermsConsentID(fixture.ConsentID)
	command := TermsConsentCommand{
		SubmissionID: submissionID, PresentedTermsVersion: snapshot.Snapshot.TermsVersion,
		PresentedTermsHash: snapshot.Snapshot.TermsHash, Consent: ConsentAffirmed,
	}

	notAffirmed := command
	notAffirmed.Consent = ConsentNotAffirmed
	assertConsentRejection(t, PlanTermsConsent(scope, notAffirmed, snapshot.Snapshot, consentID, 2_000, nil), ConsentRequired)
	stale := command
	stale.PresentedTermsHash = TermsDocumentHash("sha256:" + repeatTermsRune('0', 64))
	assertConsentRejection(t, PlanTermsConsent(scope, stale, snapshot.Snapshot, consentID, 2_000, nil), ConsentStaleTerms)
	assertConsentRejection(t, PlanTermsConsent(scope, command, snapshot.Snapshot, consentID, -1, nil), ConsentInvalidCommand)

	record := PlanTermsConsent(scope, command, snapshot.Snapshot, consentID, 2_000, nil).Record
	replay := PlanTermsConsent(scope, command, snapshot.Snapshot, mustConsentID(t, "01991f20-61d2-7000-8000-000000002502"), 3_000, &record)
	if replay.Kind != ConsentReplay || replay.Record.ConsentID != consentID || replay.Record.AcceptedAt != 2_000 {
		t.Fatalf("replay = %#v", replay)
	}
	conflicting := command
	conflicting.PresentedTermsHash = TermsDocumentHash("sha256:" + repeatTermsRune('1', 64))
	assertConsentRejection(t, PlanTermsConsent(scope, conflicting, snapshot.Snapshot, consentID, 2_000, &record), ConsentStaleTerms)

	foreign := record
	foreign.Scope = testTermsScope(t, "01991f20-61d2-7000-8000-000000000102", "01991f20-61d2-7000-8000-000000000202")
	assertConsentRejection(t, PlanTermsConsent(scope, command, snapshot.Snapshot, consentID, 2_000, &foreign), ConsentOwnerMismatch)
}

func TestTermsConsentStatusRequiresClassifiedVersionChanges(t *testing.T) {
	fixture := readTermsFixture(t)
	scope := fixture.termsScope(t)
	hash, _ := ParseTermsDocumentHash(fixture.Expected.CanonicalSHA256)
	current := PlanTermsSnapshot(fixture.Disclosure, hash).Snapshot
	record := fixtureTermsRecord(t, fixture, current)

	changedDisclosure := fixture.Disclosure
	changedDisclosure.TermsVersion = "terms-v1:2026-09-16"
	changedDisclosure.EffectiveDate = "2026-09-16"
	changedHash := TermsDocumentHash("sha256:" + repeatTermsRune('b', 64))
	changed := PlanTermsSnapshot(changedDisclosure, changedHash).Snapshot

	undecided := DecideTermsConsentStatus(scope, changed, &record, AcceptancePolicy{Kind: AcceptanceUndecided})
	if undecided.Kind != StatusRejected || undecided.Reason != StatusClassificationRequired {
		t.Fatalf("undecided = %#v", undecided)
	}
	reconsent := DecideTermsConsentStatus(scope, changed, &record, AcceptancePolicy{
		Kind: AcceptanceReconsentRequired, LegalReviewID: "legal/2026-09-16",
	})
	if reconsent.Kind != StatusResolved || reconsent.Status.Kind != TermsStatusReconsentRequired || !reconsent.Status.AcceptanceRequired {
		t.Fatalf("reconsent = %#v", reconsent)
	}
	notice := DecideTermsConsentStatus(scope, changed, &record, AcceptancePolicy{
		Kind: AcceptanceNoticeOnly, LegalReviewID: "legal/2026-09-16",
	})
	if notice.Kind != StatusResolved || notice.Status.Kind != TermsStatusNoticeOnly || notice.Status.AcceptanceRequired {
		t.Fatalf("notice = %#v", notice)
	}

	inconsistent := changed
	inconsistent.TermsVersion = record.Snapshot.TermsVersion
	result := DecideTermsConsentStatus(scope, inconsistent, &record, AcceptancePolicy{
		Kind: AcceptanceReconsentRequired, LegalReviewID: "legal/2026-09-16",
	})
	if result.Kind != StatusRejected || result.Reason != StatusInconsistentEvidence {
		t.Fatalf("inconsistent = %#v", result)
	}
}

func TestDecodeTermsDisclosureRejectsTrailingAndUnknownInput(t *testing.T) {
	fixture := readTermsFixture(t)
	serialized, _ := SerializeTermsDisclosure(fixture.Disclosure)
	if _, err := DecodeTermsDisclosure([]byte(serialized + `{}`)); err == nil {
		t.Fatal("trailing JSON was accepted")
	}
	if _, err := DecodeTermsDisclosure([]byte(`{"unknown":true}`)); err == nil {
		t.Fatal("unknown JSON was accepted")
	}
}

func fixtureTermsRecord(t *testing.T, fixture termsFixture, snapshot TermsSnapshot) TermsConsentRecord {
	t.Helper()
	consentID, _ := ParseTermsConsentID(fixture.ConsentID)
	submissionID, _ := ParseTermsConsentSubmissionID(fixture.SubmissionID)
	return TermsConsentRecord{
		Scope: fixture.termsScope(t), ConsentID: consentID, SubmissionID: submissionID,
		Snapshot: snapshot, Consent: ConsentAffirmed, AcceptedAt: fixture.AcceptedAt,
	}
}

func assertConsentRejection(t *testing.T, plan ConsentPlan, reason ConsentRejectionReason) {
	t.Helper()
	if plan.Kind != ConsentReject || plan.Reason != reason {
		t.Fatalf("plan = %#v, want rejection %q", plan, reason)
	}
}

func repeatTermsRune(value byte, count int) string {
	output := make([]byte, count)
	for index := range output {
		output[index] = value
	}
	return string(output)
}

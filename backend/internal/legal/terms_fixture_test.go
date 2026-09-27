package legal

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	"github.com/fukamu/notes/backend/internal/identity"
)

type termsFixture struct {
	Profile      string                  `json:"profile"`
	Scope        termsFixtureScope       `json:"scope"`
	ConsentID    string                  `json:"consentId"`
	SubmissionID string                  `json:"submissionId"`
	AcceptedAt   int64                   `json:"acceptedAt"`
	Disclosure   TermsDisclosure         `json:"disclosure"`
	Policy       termsFixturePolicy      `json:"acceptancePolicy"`
	Expected     termsFixtureExpectation `json:"expected"`
}

type termsFixtureScope struct {
	AccountID string `json:"accountId"`
	VaultID   string `json:"vaultId"`
}

type termsFixturePolicy struct {
	Kind AcceptancePolicyKind `json:"kind"`
}

type termsFixtureExpectation struct {
	CanonicalSHA256 string `json:"canonicalSha256"`
	InitialStatus   string `json:"initialStatus"`
	AcceptedStatus  string `json:"acceptedStatus"`
	ConsentPlan     string `json:"consentPlan"`
}

func TestTermsConsentSharedFixture(t *testing.T) {
	fixture := readTermsFixture(t)
	if fixture.Profile != "terms-consent-v1" {
		t.Fatalf("profile = %q", fixture.Profile)
	}
	serialized, err := SerializeTermsDisclosure(fixture.Disclosure)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(serialized))
	actualHash := "sha256:" + hex.EncodeToString(digest[:])
	if actualHash != fixture.Expected.CanonicalSHA256 {
		t.Fatalf("canonical hash = %q, want %q", actualHash, fixture.Expected.CanonicalSHA256)
	}
	if serialized == "" || containsEscapedHTML(serialized) {
		t.Fatalf("canonical serialization is incompatible with JSON.stringify: %q", serialized)
	}

	termsHash, _ := ParseTermsDocumentHash(actualHash)
	snapshot := PlanTermsSnapshot(fixture.Disclosure, termsHash)
	if snapshot.Kind != SnapshotReady {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	scope := fixture.termsScope(t)
	submissionID, _ := ParseTermsConsentSubmissionID(fixture.SubmissionID)
	consentID, _ := ParseTermsConsentID(fixture.ConsentID)
	plan := PlanTermsConsent(scope, TermsConsentCommand{
		SubmissionID: submissionID, PresentedTermsVersion: snapshot.Snapshot.TermsVersion,
		PresentedTermsHash: snapshot.Snapshot.TermsHash, Consent: ConsentAffirmed,
	}, snapshot.Snapshot, consentID, fixture.AcceptedAt, nil)
	if string(plan.Kind) != fixture.Expected.ConsentPlan {
		t.Fatalf("consent plan = %#v", plan)
	}
	initial := DecideTermsConsentStatus(scope, snapshot.Snapshot, nil, AcceptancePolicy{Kind: fixture.Policy.Kind})
	if initial.Kind != StatusResolved || string(initial.Status.Kind) != fixture.Expected.InitialStatus {
		t.Fatalf("initial status = %#v", initial)
	}
	accepted := DecideTermsConsentStatus(scope, snapshot.Snapshot, &plan.Record, AcceptancePolicy{Kind: fixture.Policy.Kind})
	if accepted.Kind != StatusResolved || string(accepted.Status.Kind) != fixture.Expected.AcceptedStatus {
		t.Fatalf("accepted status = %#v", accepted)
	}
}

func (fixture termsFixture) termsScope(t *testing.T) TermsScope {
	t.Helper()
	accountID, err := identity.ParseAccountID(fixture.Scope.AccountID)
	if err != nil {
		t.Fatal(err)
	}
	vaultID, err := identity.ParseVaultID(fixture.Scope.VaultID)
	if err != nil {
		t.Fatal(err)
	}
	return TermsScope{AccountID: accountID, VaultID: vaultID}
}

func readTermsFixture(t *testing.T) termsFixture {
	t.Helper()
	content, err := os.ReadFile("../../../contracts/fixtures/legal/terms-consent.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture termsFixture
	if err := json.Unmarshal(content, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func containsEscapedHTML(value string) bool {
	for _, escaped := range []string{`\u003c`, `\u003e`, `\u0026`, `\u2028`, `\u2029`} {
		if len(value) >= len(escaped) {
			for index := 0; index+len(escaped) <= len(value); index++ {
				if value[index:index+len(escaped)] == escaped {
					return true
				}
			}
		}
	}
	return false
}

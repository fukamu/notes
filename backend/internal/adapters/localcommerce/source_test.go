package localcommerce

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	"github.com/fukamu/notes/backend/internal/legal"
)

type fixtureHashContract struct {
	Profile              string `json:"profile"`
	Classification       string `json:"classification"`
	TermsCanonicalSHA256 string `json:"termsCanonicalSha256"`
	OfferCanonicalSHA256 string `json:"offerCanonicalSha256"`
}

func TestFixtureSourcesReturnValidatedImmutableTestData(t *testing.T) {
	t.Parallel()
	terms, err := (TermsSource{}).ReadCurrent(context.Background())
	if err != nil || !legal.ValidTermsDisclosure(terms.Disclosure) ||
		terms.AcceptancePolicy.Kind != legal.AcceptanceInitialRelease ||
		terms.Disclosure.TermsVersion != "terms-v1:2026-09-15" {
		t.Fatalf("terms = %#v, %v", terms, err)
	}
	terms.Disclosure.ProhibitedActivities[0] = "mutated"
	reloadedTerms, _ := (TermsSource{}).ReadCurrent(context.Background())
	if reloadedTerms.Disclosure.ProhibitedActivities[0] == "mutated" {
		t.Fatal("terms source leaked caller mutation")
	}

	offer, err := (OfferSource{}).ReadCurrent(context.Background())
	if err != nil || !legal.ValidLegalCommerceDisclosure(offer) ||
		offer.Offer.PriceYen != 980 || offer.EffectiveDate != "2026-09-15" {
		t.Fatalf("offer = %#v, %v", offer, err)
	}
	offer.SystemRequirements[0] = "mutated"
	reloadedOffer, _ := (OfferSource{}).ReadCurrent(context.Background())
	if reloadedOffer.SystemRequirements[0] == "mutated" {
		t.Fatal("offer source leaked caller mutation")
	}
}

func TestFixtureSourcesMatchTheBrowserLocalFixtureContract(t *testing.T) {
	t.Parallel()
	encoded, err := os.ReadFile("../../../../contracts/fixtures/legal/local-commerce-runtime.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract fixtureHashContract
	if err := json.Unmarshal(encoded, &contract); err != nil {
		t.Fatal(err)
	}
	if contract.Profile != "local-commerce-runtime-v1" ||
		contract.Classification != "local-test-data-not-production-approval" {
		t.Fatalf("fixture classification = %#v", contract)
	}
	terms, _ := (TermsSource{}).ReadCurrent(context.Background())
	serializedTerms, err := legal.SerializeTermsDisclosure(terms.Disclosure)
	if err != nil {
		t.Fatal(err)
	}
	offer, _ := (OfferSource{}).ReadCurrent(context.Background())
	plan := legal.PlanContractOffer(offer)
	serializedOffer, err := legal.SerializeContractOffer(plan.Offer)
	if err != nil || plan.Kind != legal.ContractOfferReady {
		t.Fatalf("offer plan = %#v, %v", plan, err)
	}
	if actual := canonicalSHA256(serializedTerms); actual != contract.TermsCanonicalSHA256 {
		t.Fatalf("terms hash = %q, want %q", actual, contract.TermsCanonicalSHA256)
	}
	if actual := canonicalSHA256(serializedOffer); actual != contract.OfferCanonicalSHA256 {
		t.Fatalf("offer hash = %q, want %q", actual, contract.OfferCanonicalSHA256)
	}
}

func canonicalSHA256(value string) string {
	digest := sha256.Sum256([]byte(value))
	return "sha256:" + hex.EncodeToString(digest[:])
}

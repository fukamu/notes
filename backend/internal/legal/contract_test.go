package legal

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/stripebilling"
)

type contractFixture struct {
	Profile      string                  `json:"profile"`
	Scope        contractFixtureScope    `json:"scope"`
	EvidenceID   string                  `json:"evidenceId"`
	SubmissionID string                  `json:"submissionId"`
	ConfirmedAt  int64                   `json:"confirmedAt"`
	Disclosure   LegalCommerceDisclosure `json:"disclosure"`
	Expected     struct {
		OfferVersion           string `json:"offerVersion"`
		AnnualEstimateYen      int64  `json:"annualEstimateYen"`
		CanonicalSHA256        string `json:"canonicalSha256"`
		EvidencePlan           string `json:"evidencePlan"`
		CheckoutSubscriptionID string `json:"checkoutSubscriptionId"`
		CheckoutIntentID       string `json:"checkoutIntentId"`
	} `json:"expected"`
}

type contractFixtureScope struct {
	AccountID string `json:"accountId"`
	VaultID   string `json:"vaultId"`
}

func TestContractEvidenceSharedFixture(t *testing.T) {
	fixture := readContractFixture(t)
	if fixture.Profile != "contract-evidence-v1" {
		t.Fatalf("profile = %q", fixture.Profile)
	}
	plan := PlanContractOffer(fixture.Disclosure)
	if plan.Kind != ContractOfferReady || plan.Offer.OfferVersion != fixture.Expected.OfferVersion ||
		plan.Offer.AnnualEstimateYen != fixture.Expected.AnnualEstimateYen {
		t.Fatalf("offer plan = %#v", plan)
	}
	serialized, err := SerializeContractOffer(plan.Offer)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(serialized))
	hash := "sha256:" + hex.EncodeToString(digest[:])
	if hash != fixture.Expected.CanonicalSHA256 {
		t.Fatalf("canonical hash = %q, want %q", hash, fixture.Expected.CanonicalSHA256)
	}
	for _, escaped := range []string{`\u003c`, `\u003e`, `\u0026`, `\u2028`, `\u2029`} {
		if strings.Contains(serialized, escaped) {
			t.Fatalf("canonical offer contains Go-only escape %q: %q", escaped, serialized)
		}
	}
	offerHash, _ := ParseContractOfferHash(hash)
	evidenceID, _ := ParseContractEvidenceID(fixture.EvidenceID)
	submissionID, _ := ParseContractSubmissionID(fixture.SubmissionID)
	evidence := PlanContractEvidence(
		fixture.contractScope(t),
		ContractConfirmationCommand{SubmissionID: submissionID, PresentedOfferHash: offerHash, Consent: ContractConsentAffirmed},
		PreparedContractOffer{Offer: plan.Offer, SerializedOffer: serialized, OfferHash: offerHash},
		evidenceID, fixture.ConfirmedAt, nil,
	)
	if string(evidence.Kind) != fixture.Expected.EvidencePlan {
		t.Fatalf("evidence plan = %#v", evidence)
	}
	checkout, ok := PlanContractHostedCheckout(evidence.Record, fixture.ConfirmedAt)
	if !ok || string(checkout.SubscriptionID) != fixture.Expected.CheckoutSubscriptionID ||
		string(checkout.CheckoutIntentID) != fixture.Expected.CheckoutIntentID {
		t.Fatalf("checkout = %#v, %v", checkout, ok)
	}
}

func TestContractCoreRejectsUnsafeInputs(t *testing.T) {
	fixture := readContractFixture(t)
	encoded, err := os.ReadFile("../../../contracts/fixtures/legal/contract-evidence.json")
	if err != nil {
		t.Fatal(err)
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &envelope); err != nil {
		t.Fatal(err)
	}
	withUnknown := append([]byte(`{"unexpected":true,`), envelope["disclosure"][1:]...)
	if _, err := DecodeLegalCommerceDisclosure(withUnknown); !errors.Is(err, ErrInvalidContractValue) {
		t.Fatalf("unknown-field decode error = %v", err)
	}
	plan := PlanContractOffer(fixture.Disclosure)
	serialized, _ := SerializeContractOffer(plan.Offer)
	hash := mustContractHash(t, fixture.Expected.CanonicalSHA256)
	base := func() ContractEvidencePlan {
		return PlanContractEvidence(
			fixture.contractScope(t),
			ContractConfirmationCommand{SubmissionID: mustContractSubmissionID(t, fixture.SubmissionID), PresentedOfferHash: hash, Consent: ContractConsentAffirmed},
			PreparedContractOffer{Offer: plan.Offer, SerializedOffer: serialized, OfferHash: hash},
			mustContractEvidenceID(t, fixture.EvidenceID), fixture.ConfirmedAt, nil,
		)
	}
	created := base()
	if created.Kind != ContractEvidenceAppend {
		t.Fatalf("created = %#v", created)
	}
	notAffirmed := PlanContractEvidence(
		fixture.contractScope(t),
		ContractConfirmationCommand{SubmissionID: created.Record.SubmissionID, PresentedOfferHash: hash, Consent: ContractConsentNotAffirmed},
		PreparedContractOffer{Offer: plan.Offer, SerializedOffer: serialized, OfferHash: hash},
		created.Record.EvidenceID, fixture.ConfirmedAt, nil,
	)
	if notAffirmed.Reason != ContractConsentRequired {
		t.Fatalf("not affirmed = %#v", notAffirmed)
	}
	staleHash := mustContractHash(t, "sha256:"+strings.Repeat("b", 64))
	stale := PlanContractEvidence(
		fixture.contractScope(t),
		ContractConfirmationCommand{SubmissionID: created.Record.SubmissionID, PresentedOfferHash: staleHash, Consent: ContractConsentAffirmed},
		PreparedContractOffer{Offer: plan.Offer, SerializedOffer: serialized, OfferHash: hash},
		created.Record.EvidenceID, fixture.ConfirmedAt, nil,
	)
	if stale.Reason != ContractStaleOffer {
		t.Fatalf("stale = %#v", stale)
	}
	replayed := PlanContractEvidence(
		created.Record.Scope,
		ContractConfirmationCommand{SubmissionID: created.Record.SubmissionID, PresentedOfferHash: hash, Consent: ContractConsentAffirmed},
		PreparedContractOffer{Offer: plan.Offer, SerializedOffer: serialized, OfferHash: hash},
		mustContractEvidenceID(t, "01991f20-61d2-7000-8000-000000002302"), fixture.ConfirmedAt+1, &created.Record,
	)
	if replayed.Kind != ContractEvidenceReplay || replayed.Record.EvidenceID != created.Record.EvidenceID ||
		replayed.Record.ConfirmedAt != created.Record.ConfirmedAt {
		t.Fatalf("replay = %#v", replayed)
	}
}

func TestContractCheckoutRecordsEvidenceBeforeProviderAndReplaysLostResponse(t *testing.T) {
	fixture := readContractFixture(t)
	repository := &memoryContractRepository{}
	hasher := fixtureContractHasher{hash: mustContractHash(t, fixture.Expected.CanonicalSHA256)}
	evidence, err := NewContractEvidenceService(repository, hasher)
	if err != nil {
		t.Fatal(err)
	}
	provider := &recordingContractProvider{repository: repository, failFirst: true}
	application, err := NewContractCheckoutApplication(
		evidence, fixtureContractSource{disclosure: fixture.Disclosure}, acceptedContractTerms{}, provider,
	)
	if err != nil {
		t.Fatal(err)
	}
	contextValue := fixture.vaultContext(t)
	command := ContractConfirmationCommand{
		SubmissionID:       mustContractSubmissionID(t, fixture.SubmissionID),
		PresentedOfferHash: hasher.hash, Consent: ContractConsentAffirmed,
	}
	first := application.Confirm(context.Background(), contextValue, command, mustContractEvidenceID(t, fixture.EvidenceID), fixture.ConfirmedAt)
	if first.Kind != ContractCheckoutRejected || first.Reason != ContractProviderUnavailable {
		t.Fatalf("first checkout = %#v", first)
	}
	second := application.Confirm(
		context.Background(), contextValue, command,
		mustContractEvidenceID(t, "01991f20-61d2-7000-8000-000000002302"), fixture.ConfirmedAt+1,
	)
	if second.Kind != ContractCheckoutRedirect || second.Outcome != ContractEvidenceReplayed ||
		second.Evidence.EvidenceID != mustContractEvidenceID(t, fixture.EvidenceID) {
		t.Fatalf("second checkout = %#v", second)
	}
	if len(provider.commands) != 2 || provider.commands[0] != provider.commands[1] {
		t.Fatalf("provider commands = %#v", provider.commands)
	}
}

func TestContractCheckoutStopsBeforeEvidenceAndProviderWithoutCurrentTerms(t *testing.T) {
	fixture := readContractFixture(t)
	repository := &memoryContractRepository{}
	evidence, _ := NewContractEvidenceService(repository, fixtureContractHasher{hash: mustContractHash(t, fixture.Expected.CanonicalSHA256)})
	provider := &recordingContractProvider{repository: repository}
	application, _ := NewContractCheckoutApplication(
		evidence, fixtureContractSource{disclosure: fixture.Disclosure}, rejectedContractTerms{}, provider,
	)
	result := application.Confirm(
		context.Background(), fixture.vaultContext(t),
		ContractConfirmationCommand{
			SubmissionID:       mustContractSubmissionID(t, fixture.SubmissionID),
			PresentedOfferHash: mustContractHash(t, fixture.Expected.CanonicalSHA256), Consent: ContractConsentAffirmed,
		},
		mustContractEvidenceID(t, fixture.EvidenceID), fixture.ConfirmedAt,
	)
	if result.Reason != ContractTermsRequired || repository.count() != 0 || len(provider.commands) != 0 {
		t.Fatalf("rejected checkout = %#v, records=%d provider=%d", result, repository.count(), len(provider.commands))
	}
}

func TestContractCheckoutMapsProviderFailuresWithoutLosingEvidence(t *testing.T) {
	fixture := readContractFixture(t)
	cases := []struct {
		provider stripebilling.RejectionReason
		want     ContractApplicationReason
	}{
		{provider: stripebilling.ReasonInvalidInput, want: ContractInvalidCommand},
		{provider: stripebilling.ReasonProviderUnavailable, want: ContractProviderUnavailable},
		{provider: stripebilling.ReasonMalformedProviderResponse, want: ContractMalformedProvider},
		{provider: stripebilling.ReasonProviderMappingMismatch, want: ContractProviderMismatch},
		{provider: stripebilling.ReasonBillingRejected, want: ContractBillingRejected},
	}
	for _, testCase := range cases {
		t.Run(string(testCase.provider), func(t *testing.T) {
			repository := &memoryContractRepository{}
			evidence, _ := NewContractEvidenceService(
				repository, fixtureContractHasher{hash: mustContractHash(t, fixture.Expected.CanonicalSHA256)},
			)
			application, _ := NewContractCheckoutApplication(
				evidence, fixtureContractSource{disclosure: fixture.Disclosure}, acceptedContractTerms{},
				fixedContractProvider{reason: testCase.provider},
			)
			result := application.Confirm(
				context.Background(), fixture.vaultContext(t),
				ContractConfirmationCommand{
					SubmissionID:       mustContractSubmissionID(t, fixture.SubmissionID),
					PresentedOfferHash: mustContractHash(t, fixture.Expected.CanonicalSHA256), Consent: ContractConsentAffirmed,
				},
				mustContractEvidenceID(t, fixture.EvidenceID), fixture.ConfirmedAt,
			)
			if result.Kind != ContractCheckoutRejected || result.Reason != testCase.want || repository.count() != 1 {
				t.Fatalf("provider rejection = %#v, records=%d", result, repository.count())
			}
		})
	}
}

func TestContractEvidenceServiceFailsClosedOnDependencyErrors(t *testing.T) {
	fixture := readContractFixture(t)
	hashFailure, _ := NewContractEvidenceService(
		&memoryContractRepository{}, fixtureContractHasher{err: errors.New("hash unavailable")},
	)
	if result := hashFailure.PrepareOffer(context.Background(), fixture.Disclosure); result.Reason != ContractHashUnavailable {
		t.Fatalf("hash failure = %#v", result)
	}
	mismatchedHash, _ := NewContractEvidenceService(
		&memoryContractRepository{}, fixtureContractHasher{hash: mustContractHash(t, "sha256:"+strings.Repeat("a", 64))},
	)
	if result := mismatchedHash.PrepareOffer(context.Background(), fixture.Disclosure); result.Reason != ContractHashUnavailable {
		t.Fatalf("mismatched hash = %#v", result)
	}
	repositoryFailure, _ := NewContractEvidenceService(
		failingContractRepository{}, fixtureContractHasher{hash: mustContractHash(t, fixture.Expected.CanonicalSHA256)},
	)
	result := repositoryFailure.Confirm(
		context.Background(), fixture.contractScope(t), fixture.Disclosure,
		ContractConfirmationCommand{
			SubmissionID:       mustContractSubmissionID(t, fixture.SubmissionID),
			PresentedOfferHash: mustContractHash(t, fixture.Expected.CanonicalSHA256), Consent: ContractConsentAffirmed,
		},
		mustContractEvidenceID(t, fixture.EvidenceID), fixture.ConfirmedAt,
	)
	if result.Kind != ContractConfirmationRejected || result.Reason != ContractUnavailable {
		t.Fatalf("repository failure = %#v", result)
	}
}

type fixtureContractSource struct {
	disclosure LegalCommerceDisclosure
	err        error
}

func (source fixtureContractSource) ReadCurrent(context.Context) (LegalCommerceDisclosure, error) {
	return source.disclosure, source.err
}

type fixtureContractHasher struct {
	hash ContractOfferHash
	err  error
}

func (hasher fixtureContractHasher) Hash(context.Context, string) (ContractOfferHash, error) {
	return hasher.hash, hasher.err
}

type memoryContractRepository struct {
	mu      sync.Mutex
	records map[ContractSubmissionID]ContractEvidenceRecord
}

type failingContractRepository struct{}

func (failingContractRepository) FindBySubmission(context.Context, TermsScope, ContractSubmissionID) (*ContractEvidenceRecord, error) {
	return nil, errors.New("repository unavailable")
}

func (failingContractRepository) Append(context.Context, ContractEvidenceRecord) (ContractEvidenceAppendResult, error) {
	return ContractEvidenceAppendResult{}, errors.New("repository unavailable")
}

func (repository *memoryContractRepository) FindBySubmission(
	_ context.Context,
	scope TermsScope,
	submissionID ContractSubmissionID,
) (*ContractEvidenceRecord, error) {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	if repository.records == nil {
		return nil, nil
	}
	record, found := repository.records[submissionID]
	if !found {
		return nil, nil
	}
	copy := record
	return &copy, nil
}

func (repository *memoryContractRepository) Append(
	_ context.Context,
	record ContractEvidenceRecord,
) (ContractEvidenceAppendResult, error) {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	if repository.records == nil {
		repository.records = make(map[ContractSubmissionID]ContractEvidenceRecord)
	}
	if existing, found := repository.records[record.SubmissionID]; found {
		copy := existing
		return ContractEvidenceAppendResult{Kind: ContractEvidenceAppendExisting, Record: &copy}, nil
	}
	repository.records[record.SubmissionID] = record
	return ContractEvidenceAppendResult{Kind: ContractEvidenceAppendCreated}, nil
}

func (repository *memoryContractRepository) count() int {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	return len(repository.records)
}

type acceptedContractTerms struct{}

func (acceptedContractTerms) VerifyCheckout(context.Context, identity.VaultContext, string) CheckoutVerification {
	return CheckoutVerification{Kind: CheckoutTermsAccepted}
}

type rejectedContractTerms struct{}

func (rejectedContractTerms) VerifyCheckout(context.Context, identity.VaultContext, string) CheckoutVerification {
	return CheckoutVerification{Kind: CheckoutTermsRejected, Reason: CheckoutTermsConsentRequired}
}

type recordingContractProvider struct {
	repository *memoryContractRepository
	failFirst  bool
	commands   []stripebilling.HostedCheckoutCommand
}

type fixedContractProvider struct {
	reason stripebilling.RejectionReason
}

func (provider fixedContractProvider) BeginHostedCheckout(
	context.Context,
	identity.VaultContext,
	stripebilling.HostedCheckoutCommand,
) stripebilling.HostedCheckoutResult {
	return stripebilling.HostedCheckoutResult{Kind: stripebilling.HostedCheckoutRejected, Reason: provider.reason}
}

func (provider *recordingContractProvider) BeginHostedCheckout(
	_ context.Context,
	_ identity.VaultContext,
	command stripebilling.HostedCheckoutCommand,
) stripebilling.HostedCheckoutResult {
	if provider.repository.count() == 0 {
		panic("provider called before evidence append")
	}
	provider.commands = append(provider.commands, command)
	if provider.failFirst && len(provider.commands) == 1 {
		return stripebilling.HostedCheckoutResult{Kind: stripebilling.HostedCheckoutRejected, Reason: stripebilling.ReasonProviderUnavailable}
	}
	reference, _ := billing.ParseProviderCheckoutReference("checkout_contract_test")
	return stripebilling.HostedCheckoutResult{
		Kind: stripebilling.HostedCheckoutRedirect, CheckoutURL: "https://checkout.stripe.com/c/pay/cs_test_contract",
		ProviderCheckoutReference: reference,
	}
}

func readContractFixture(t *testing.T) contractFixture {
	t.Helper()
	content, err := os.ReadFile("../../../contracts/fixtures/legal/contract-evidence.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture contractFixture
	if err := json.Unmarshal(content, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func (fixture contractFixture) contractScope(t *testing.T) TermsScope {
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

func (fixture contractFixture) vaultContext(t *testing.T) identity.VaultContext {
	t.Helper()
	scope := fixture.contractScope(t)
	sessionID, err := identity.ParseSessionID("01991f20-61d2-7000-8000-000000000301")
	if err != nil {
		t.Fatal(err)
	}
	epoch, err := identity.ParseSessionEpoch(1)
	if err != nil {
		t.Fatal(err)
	}
	return identity.VaultContext{AccountID: scope.AccountID, VaultID: scope.VaultID, SessionID: sessionID, SessionEpoch: epoch}
}

func mustContractEvidenceID(t *testing.T, value string) ContractEvidenceID {
	t.Helper()
	parsed, err := ParseContractEvidenceID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustContractSubmissionID(t *testing.T, value string) ContractSubmissionID {
	t.Helper()
	parsed, err := ParseContractSubmissionID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustContractHash(t *testing.T, value string) ContractOfferHash {
	t.Helper()
	parsed, err := ParseContractOfferHash(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

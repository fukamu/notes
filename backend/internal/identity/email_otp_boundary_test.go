package identity

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"sync"
	"testing"
)

type fixedEmailOtpClock int64

func (clock fixedEmailOtpClock) NowEpochSeconds() int64 { return int64(clock) }

type fakeEmailOtpSecrets struct {
	challengeID string
	codes       []string
	salts       []string
	codeIndex   int
	saltIndex   int
	mu          sync.Mutex
}

func (secrets *fakeEmailOtpSecrets) CreateChallengeID(context.Context) (string, error) {
	return secrets.challengeID, nil
}

func (secrets *fakeEmailOtpSecrets) CreateCode(context.Context) (string, error) {
	secrets.mu.Lock()
	defer secrets.mu.Unlock()
	if secrets.codeIndex >= len(secrets.codes) {
		return "", errors.New("codes exhausted")
	}
	value := secrets.codes[secrets.codeIndex]
	secrets.codeIndex++
	return value, nil
}

func (secrets *fakeEmailOtpSecrets) CreateSalt(context.Context) (string, error) {
	secrets.mu.Lock()
	defer secrets.mu.Unlock()
	if secrets.saltIndex >= len(secrets.salts) {
		return "", errors.New("salts exhausted")
	}
	value := secrets.salts[secrets.saltIndex]
	secrets.saltIndex++
	return value, nil
}

type testEmailOtpHasher struct{}

func (testEmailOtpHasher) CreateDigest(_ context.Context, input EmailOtpHashInput) (string, error) {
	digest := sha256.Sum256([]byte(strings.Join([]string{
		string(input.ChallengeID), string(input.Address), string(input.Salt), string(input.Code),
	}, "\x00")))
	return base64.RawURLEncoding.EncodeToString(digest[:]), nil
}

func (hasher testEmailOtpHasher) MatchesDigest(ctx context.Context, input EmailOtpHashInput, expected EmailOtpDigest) (bool, error) {
	digest, err := hasher.CreateDigest(ctx, input)
	return err == nil && digest == string(expected), err
}

type memoryEmailOtpChallenges struct {
	mu      sync.Mutex
	records map[EmailOtpChallengeID]EmailOtpChallenge
}

func newMemoryEmailOtpChallenges() *memoryEmailOtpChallenges {
	return &memoryEmailOtpChallenges{records: make(map[EmailOtpChallengeID]EmailOtpChallenge)}
}

func (store *memoryEmailOtpChallenges) InsertPending(_ context.Context, challenge EmailOtpChallenge) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if _, duplicate := store.records[challenge.ChallengeID]; duplicate {
		return errors.New("duplicate challenge")
	}
	store.records[challenge.ChallengeID] = challenge
	return nil
}

func (store *memoryEmailOtpChallenges) FindByID(_ context.Context, id EmailOtpChallengeID) (*EmailOtpChallenge, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	challenge, ok := store.records[id]
	if !ok {
		return nil, nil
	}
	return &challenge, nil
}

func (store *memoryEmailOtpChallenges) CompareAndSwap(
	_ context.Context,
	id EmailOtpChallengeID,
	expectedVersion int64,
	next EmailOtpChallenge,
) (bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	current, ok := store.records[id]
	if !ok || current.Version != expectedVersion || next.ChallengeID != id || !ValidEmailOtpChallenge(next) {
		return false, nil
	}
	store.records[id] = next
	return true, nil
}

func (store *memoryEmailOtpChallenges) only(t *testing.T) EmailOtpChallenge {
	t.Helper()
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.records) != 1 {
		t.Fatalf("challenge count = %d", len(store.records))
	}
	for _, challenge := range store.records {
		return challenge
	}
	panic("unreachable")
}

type fakeEmailOtpAbuseKeys struct {
	includeAccount bool
}

func (keys fakeEmailOtpAbuseKeys) DeriveKeys(
	_ context.Context,
	_ EmailOtpAddress,
	_ string,
	accountID *AccountID,
) (EmailOtpRateLimitKeys, error) {
	addressKey, _ := ParseEmailOtpRateLimitKey(testEmailOtpSecret)
	networkKey, _ := ParseEmailOtpRateLimitKey(testEmailOtpOtherSecret)
	result := EmailOtpRateLimitKeys{Address: addressKey, Network: networkKey}
	if accountID != nil && keys.includeAccount {
		accountKey, _ := ParseEmailOtpRateLimitKey("CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCI")
		result.Account = &accountKey
	}
	return result, nil
}

type allowEmailOtpRateLimits struct {
	mu           sync.Mutex
	reservations int
	allow        bool
}

func (limits *allowEmailOtpRateLimits) Reserve(context.Context, EmailOtpRateLimitKeys, int64) (bool, error) {
	limits.mu.Lock()
	defer limits.mu.Unlock()
	limits.reservations++
	return limits.allow, nil
}

type fakeEmailOtpDelivery struct {
	mu       sync.Mutex
	messages []EmailOtpDeliveryInput
	fail     bool
}

func (delivery *fakeEmailOtpDelivery) SendOtp(_ context.Context, message EmailOtpDeliveryInput) error {
	delivery.mu.Lock()
	defer delivery.mu.Unlock()
	if delivery.fail {
		return errors.New("delivery failed")
	}
	delivery.messages = append(delivery.messages, message)
	return nil
}

type fakeEmailOtpDirectory struct {
	identity *EmailOtpIdentityRecord
	owner    *AccountID
	err      error
}

type fakeEmailOtpSignup struct {
	result SignupAdmissionResult
	err    error
}

func (signup *fakeEmailOtpSignup) Admit(
	context.Context,
	VerifiedSignupIdentity,
	SignupTermsConsent,
) (SignupAdmissionResult, error) {
	return signup.result, signup.err
}

func (directory *fakeEmailOtpDirectory) FindByAddress(context.Context, EmailOtpAddress) (*EmailOtpIdentityRecord, error) {
	return directory.identity, directory.err
}

func (directory *fakeEmailOtpDirectory) FindAccountIDByVerifiedEmail(context.Context, VerifiedEmailAddress) (*AccountID, error) {
	return directory.owner, directory.err
}

func TestEmailOtpStartStoresDigestAndHidesInvalidInput(t *testing.T) {
	store := newMemoryEmailOtpChallenges()
	delivery := &fakeEmailOtpDelivery{}
	result := StartEmailOtp(context.Background(), emailOtpStartFixture(store, delivery, "Person@Example.COM"))
	if !result.Accepted || result.ChallengeID != emailOtpChallengeID(t) {
		t.Fatalf("StartEmailOtp() = %#v", result)
	}
	challenge := store.only(t)
	if challenge.Address != emailOtpAddress(t) || string(challenge.Digest) == "12345678" || len(delivery.messages) != 1 {
		t.Fatalf("stored=%#v delivery=%#v", challenge, delivery.messages)
	}
	invalidStore := newMemoryEmailOtpChallenges()
	invalidDelivery := &fakeEmailOtpDelivery{}
	invalid := StartEmailOtp(context.Background(), emailOtpStartFixture(invalidStore, invalidDelivery, "not-an-address"))
	if invalid != result || len(invalidStore.records) != 0 || len(invalidDelivery.messages) != 0 {
		t.Fatalf("invalid start leaked state: result=%#v store=%#v messages=%#v", invalid, invalidStore.records, invalidDelivery.messages)
	}
}

func TestEmailOtpStartInvalidatesDeliveryFailure(t *testing.T) {
	store := newMemoryEmailOtpChallenges()
	delivery := &fakeEmailOtpDelivery{fail: true}
	result := StartEmailOtp(context.Background(), emailOtpStartFixture(store, delivery, testEmailOtpAddress))
	challenge := store.only(t)
	if !result.Accepted || challenge.Kind != EmailOtpInvalidated || challenge.InvalidationReason != EmailOtpDeliveryFailed {
		t.Fatalf("delivery failure: result=%#v challenge=%#v", result, challenge)
	}
}

func TestEmailOtpCompleteHasExactlyOneConcurrentWinner(t *testing.T) {
	store := newMemoryEmailOtpChallenges()
	delivery := &fakeEmailOtpDelivery{}
	StartEmailOtp(context.Background(), emailOtpStartFixture(store, delivery, testEmailOtpAddress))
	identityRecord := emailOtpIdentityRecordFixture(t)
	input := emailOtpCompletionFixture(store, &fakeEmailOtpDirectory{identity: &identityRecord}, "12345678")
	const workers = 16
	start := make(chan struct{})
	results := make(chan EmailOtpCompletionResult, workers)
	var wait sync.WaitGroup
	for range workers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			results <- CompleteEmailOtp(context.Background(), input)
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	resolved := 0
	failed := 0
	for result := range results {
		switch result.Kind {
		case EmailOtpCompletionResolved:
			resolved++
		case EmailOtpCompletionFailed:
			failed++
		default:
			t.Fatalf("unexpected completion = %#v", result)
		}
	}
	if resolved != 1 || failed != workers-1 || store.only(t).Kind != EmailOtpConsumed {
		t.Fatalf("race outcomes: resolved=%d failed=%d challenge=%#v", resolved, failed, store.only(t))
	}
}

func TestEmailOtpCompleteLocksAndConsumesCollisions(t *testing.T) {
	store := newMemoryEmailOtpChallenges()
	StartEmailOtp(context.Background(), emailOtpStartFixture(store, &fakeEmailOtpDelivery{}, testEmailOtpAddress))
	for attempt := 0; attempt < 5; attempt++ {
		result := CompleteEmailOtp(context.Background(), emailOtpCompletionFixture(store, &fakeEmailOtpDirectory{}, "00000000"))
		if result.Kind != EmailOtpCompletionFailed || result.Error != "verification-failed" {
			t.Fatalf("failed attempt %d = %#v", attempt, result)
		}
	}
	if challenge := store.only(t); challenge.Kind != EmailOtpLocked || challenge.FailedAttempts != 5 {
		t.Fatalf("locked challenge = %#v", challenge)
	}

	collisionStore := newMemoryEmailOtpChallenges()
	StartEmailOtp(context.Background(), emailOtpStartFixture(collisionStore, &fakeEmailOtpDelivery{}, testEmailOtpAddress))
	owner := mustAccountID(t, fixtureAccountID)
	collision := CompleteEmailOtp(context.Background(), emailOtpCompletionFixture(
		collisionStore, &fakeEmailOtpDirectory{owner: &owner}, "12345678",
	))
	if collision.Kind != EmailOtpCompletionFailed || collisionStore.only(t).Kind != EmailOtpConsumed {
		t.Fatalf("collision = %#v challenge=%#v", collision, collisionStore.only(t))
	}
}

func TestEmailOtpCompletionAdmitsOnlyMatchingSignupReceipt(t *testing.T) {
	consent := &SignupTermsConsent{
		SubmissionID: fixtureIdentityID, PresentedTermsVersion: "terms-v1:2026-02-27",
		PresentedTermsHash: "sha256:" + strings.Repeat("a", 64), Affirmed: true,
	}
	receipt := SignupAdmissionReceipt{
		SubmissionID: fixtureIdentityID,
		Identity: VerifiedSignupIdentity{
			Kind: SignupIdentityEmailOtp, Address: emailOtpAddress(t),
		},
		AccountID: mustAccountID(t, fixtureAccountID), VaultID: mustVaultID(t, fixtureVaultID),
		IdentityID: mustIdentityID(t, fixtureIdentityID), SessionID: mustSessionID(t, fixtureSessionID),
		SessionEpoch: mustEpoch(t, 1), TermsConsentID: fixtureIdentityID,
		SessionToken: mustToken(t, strings.Repeat("A", 43)), IssuedAt: 1_500,
		ExpiresAt: 1_500 + SignupSessionLifetimeSeconds,
	}

	complete := func(t *testing.T, candidate SignupAdmissionReceipt) EmailOtpCompletionResult {
		t.Helper()
		store := newMemoryEmailOtpChallenges()
		start := emailOtpStartFixture(store, &fakeEmailOtpDelivery{}, testEmailOtpAddress)
		start.SignupTermsConsent = consent
		if result := StartEmailOtp(context.Background(), start); !result.Accepted {
			t.Fatalf("signup start = %#v", result)
		}
		input := emailOtpCompletionFixture(store, &fakeEmailOtpDirectory{}, "12345678")
		input.Signup = &fakeEmailOtpSignup{result: SignupAdmissionResult{Admitted: true, Receipt: candidate}}
		return CompleteEmailOtp(context.Background(), input)
	}

	if result := complete(t, receipt); result.Kind != EmailOtpCompletionAdmitted {
		t.Fatalf("matching receipt = %#v", result)
	}
	wrongIdentity := receipt
	wrongIdentity.Identity.Address, _ = ParseEmailOtpAddress("other@example.com")
	if result := complete(t, wrongIdentity); result.Kind != EmailOtpCompletionFailed {
		t.Fatalf("wrong identity receipt = %#v", result)
	}
	wrongSubmission := receipt
	wrongSubmission.SubmissionID = fixtureOtherIdentityID
	if result := complete(t, wrongSubmission); result.Kind != EmailOtpCompletionFailed {
		t.Fatalf("wrong submission receipt = %#v", result)
	}
}

func TestEmailOtpResendRotatesWithoutResettingFailureOrExpiry(t *testing.T) {
	store := newMemoryEmailOtpChallenges()
	delivery := &fakeEmailOtpDelivery{}
	startInput := emailOtpStartFixture(store, delivery, testEmailOtpAddress)
	startInput.Secrets = &fakeEmailOtpSecrets{
		challengeID: testEmailOtpChallengeID,
		codes:       []string{"12345678", "87654321"},
		salts:       []string{testEmailOtpSecret, testEmailOtpOtherSecret},
	}
	StartEmailOtp(context.Background(), startInput)
	CompleteEmailOtp(context.Background(), emailOtpCompletionFixture(store, &fakeEmailOtpDirectory{}, "00000000"))
	resend := ResendEmailOtp(context.Background(), struct {
		ChallengeID         string
		TrustedNetworkScope string
		Clock               EmailOtpClock
		Secrets             EmailOtpSecretPort
		Hasher              EmailOtpHasherPort
		Challenges          EmailOtpChallengeStore
		AbuseKeys           EmailOtpAbuseKeyPort
		RateLimits          EmailOtpRateLimitPort
		Delivery            EmailOtpDeliveryPort
	}{
		ChallengeID: testEmailOtpChallengeID, TrustedNetworkScope: "test-network",
		Clock: fixedEmailOtpClock(1_060), Secrets: startInput.Secrets, Hasher: testEmailOtpHasher{},
		Challenges: store, AbuseKeys: fakeEmailOtpAbuseKeys{},
		RateLimits: &allowEmailOtpRateLimits{allow: true}, Delivery: delivery,
	})
	challenge := store.only(t)
	if !resend.Accepted || challenge.Kind != EmailOtpPending || challenge.FailedAttempts != 1 ||
		challenge.SendCount != 2 || challenge.Version != 3 || challenge.ExpiresAtEpochSeconds != 1_600 ||
		len(delivery.messages) != 2 || delivery.messages[1].Code != mustEmailOtpCode(t, "87654321") {
		t.Fatalf("resend=%#v challenge=%#v messages=%#v", resend, challenge, delivery.messages)
	}
}

func emailOtpStartFixture(
	store EmailOtpChallengeStore,
	delivery EmailOtpDeliveryPort,
	address string,
) struct {
	Address             string
	Intent              EmailOtpStartIntent
	SignupTermsConsent  *SignupTermsConsent
	VaultContext        *VaultContext
	TrustedNetworkScope string
	Clock               EmailOtpClock
	Secrets             EmailOtpSecretPort
	Hasher              EmailOtpHasherPort
	Challenges          EmailOtpChallengeStore
	AbuseKeys           EmailOtpAbuseKeyPort
	RateLimits          EmailOtpRateLimitPort
	Delivery            EmailOtpDeliveryPort
} {
	return struct {
		Address             string
		Intent              EmailOtpStartIntent
		SignupTermsConsent  *SignupTermsConsent
		VaultContext        *VaultContext
		TrustedNetworkScope string
		Clock               EmailOtpClock
		Secrets             EmailOtpSecretPort
		Hasher              EmailOtpHasherPort
		Challenges          EmailOtpChallengeStore
		AbuseKeys           EmailOtpAbuseKeyPort
		RateLimits          EmailOtpRateLimitPort
		Delivery            EmailOtpDeliveryPort
	}{
		Address: address, Intent: EmailOtpStartSignIn, TrustedNetworkScope: "test-network",
		Clock: fixedEmailOtpClock(1_000),
		Secrets: &fakeEmailOtpSecrets{
			challengeID: testEmailOtpChallengeID, codes: []string{"12345678"}, salts: []string{testEmailOtpSecret},
		},
		Hasher: testEmailOtpHasher{}, Challenges: store, AbuseKeys: fakeEmailOtpAbuseKeys{},
		RateLimits: &allowEmailOtpRateLimits{allow: true}, Delivery: delivery,
	}
}

func emailOtpCompletionFixture(
	store EmailOtpChallengeStore,
	directory EmailOtpIdentityDirectory,
	code string,
) struct {
	ChallengeID string
	Code        string
	Clock       EmailOtpClock
	Hasher      EmailOtpHasherPort
	Challenges  EmailOtpChallengeStore
	Identities  EmailOtpIdentityDirectory
	Signup      SignupAdmissionPort
} {
	return struct {
		ChallengeID string
		Code        string
		Clock       EmailOtpClock
		Hasher      EmailOtpHasherPort
		Challenges  EmailOtpChallengeStore
		Identities  EmailOtpIdentityDirectory
		Signup      SignupAdmissionPort
	}{
		ChallengeID: testEmailOtpChallengeID, Code: code, Clock: fixedEmailOtpClock(1_001),
		Hasher: testEmailOtpHasher{}, Challenges: store, Identities: directory,
	}
}

func emailOtpIdentityRecordFixture(t *testing.T) EmailOtpIdentityRecord {
	t.Helper()
	return EmailOtpIdentityRecord{
		IdentityID: mustIdentityID(t, fixtureIdentityID), AccountID: mustAccountID(t, fixtureAccountID),
		VaultID: mustVaultID(t, fixtureVaultID), Address: emailOtpAddress(t),
	}
}

func mustEmailOtpCode(t *testing.T, value string) EmailOtpCode {
	t.Helper()
	parsed, err := ParseEmailOtpCode(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

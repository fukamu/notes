package identity

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

type fixedOidcClock int64

func (clock fixedOidcClock) NowEpochSeconds() int64 { return int64(clock) }

type fakeOidcSecrets struct {
	state    string
	nonce    string
	verifier string
	err      error
}

func (secrets fakeOidcSecrets) CreateState(context.Context) (string, error) {
	return secrets.state, secrets.err
}

func (secrets fakeOidcSecrets) CreateNonce(context.Context) (string, error) {
	return secrets.nonce, secrets.err
}

func (secrets fakeOidcSecrets) CreateCodeVerifier(context.Context) (string, error) {
	return secrets.verifier, secrets.err
}

type fixedPkce struct {
	challenge string
	err       error
}

func (pkce fixedPkce) DeriveS256(PkceCodeVerifier) (string, error) {
	return pkce.challenge, pkce.err
}

type memoryOidcTransactions struct {
	mu      sync.Mutex
	pending map[OidcState]PendingOidcTransaction
}

func newMemoryOidcTransactions() *memoryOidcTransactions {
	return &memoryOidcTransactions{pending: make(map[OidcState]PendingOidcTransaction)}
}

func (store *memoryOidcTransactions) InsertPending(_ context.Context, transaction PendingOidcTransaction) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if _, duplicate := store.pending[transaction.State]; duplicate {
		return errors.New("duplicate state")
	}
	store.pending[transaction.State] = transaction
	return nil
}

func (store *memoryOidcTransactions) ConsumeByState(_ context.Context, state OidcState) (*PendingOidcTransaction, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	transaction, ok := store.pending[state]
	if !ok {
		return nil, nil
	}
	delete(store.pending, state)
	copy := transaction
	return &copy, nil
}

func (store *memoryOidcTransactions) remaining() int {
	store.mu.Lock()
	defer store.mu.Unlock()
	return len(store.pending)
}

type fakeOidcProvider struct {
	claims    RawOidcClaims
	err       error
	exchanges atomic.Int64
	last      OidcCodeExchangeInput
	mu        sync.Mutex
}

func (provider *fakeOidcProvider) ExchangeCodeForVerifiedClaims(
	_ context.Context,
	input OidcCodeExchangeInput,
) (RawOidcClaims, error) {
	provider.mu.Lock()
	provider.last = input
	provider.mu.Unlock()
	provider.exchanges.Add(1)
	return provider.claims, provider.err
}

type fakeOidcDirectory struct {
	identity *OidcIdentityRecord
	account  *AccountID
	err      error
}

type fakeOidcSignup struct {
	result SignupAdmissionResult
	err    error
	calls  atomic.Int64
}

func (signup *fakeOidcSignup) Admit(
	context.Context,
	VerifiedSignupIdentity,
	SignupTermsConsent,
) (SignupAdmissionResult, error) {
	signup.calls.Add(1)
	return signup.result, signup.err
}

func (directory *fakeOidcDirectory) FindByIssuerSubject(
	context.Context,
	OidcIdentityKey,
) (*OidcIdentityRecord, error) {
	return directory.identity, directory.err
}

func (directory *fakeOidcDirectory) FindAccountIDByVerifiedEmail(
	context.Context,
	VerifiedEmailAddress,
) (*AccountID, error) {
	return directory.account, directory.err
}

func TestGoogleOidcStartBoundary(t *testing.T) {
	t.Parallel()
	store := newMemoryOidcTransactions()
	result := startFixtureOidc(t, store, OidcStartSignIn, nil)
	if !result.Redirect || store.remaining() != 1 || result.Request.CodeChallenge != mustOidcChallenge(t, fixtureOidcChallenge) {
		t.Fatalf("start result = %#v, remaining=%d", result, store.remaining())
	}
	serialized, err := SerializeOidcAuthorizationRequest(result.Request)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(serialized)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Scheme+"://"+parsed.Host+parsed.Path != fixtureOidcEndpoint {
		t.Fatalf("authorization destination = %q", parsed.String())
	}
	want := map[string]string{
		"response_type": "code", "client_id": fixtureOidcClientID,
		"redirect_uri": fixtureOidcRedirect, "scope": "openid email",
		"state": fixtureOidcState, "nonce": fixtureOidcNonce,
		"code_challenge": fixtureOidcChallenge, "code_challenge_method": "S256",
	}
	for name, value := range want {
		if parsed.Query().Get(name) != value {
			t.Fatalf("query %s = %q, want %q", name, parsed.Query().Get(name), value)
		}
	}

	base := startFixtureInput(t, newMemoryOidcTransactions())
	base.RedirectURI = fixtureOidcOtherURI
	if rejected := StartGoogleOidc(context.Background(), base); rejected.Error != "authentication-unavailable" {
		t.Fatalf("redirect rejection = %#v", rejected)
	}
	base = startFixtureInput(t, newMemoryOidcTransactions())
	base.Intent = OidcStartLinkCurrentAccount
	if rejected := StartGoogleOidc(context.Background(), base); rejected.Error != "authentication-unavailable" {
		t.Fatalf("missing context rejection = %#v", rejected)
	}
	contextValue := VaultContext{
		AccountID: mustAccountID(t, fixtureAccountID), VaultID: mustVaultID(t, fixtureVaultID),
		SessionID: mustSessionID(t, fixtureSessionID), SessionEpoch: mustEpoch(t, 1),
	}
	base.VaultContext = &contextValue
	if linked := StartGoogleOidc(context.Background(), base); !linked.Redirect {
		t.Fatalf("link start = %#v", linked)
	}
}

func TestGoogleOidcCompletionConsumesOnce(t *testing.T) {
	t.Parallel()
	store := newMemoryOidcTransactions()
	startFixtureOidc(t, store, OidcStartSignIn, nil)
	provider := &fakeOidcProvider{claims: fixtureRawOidcClaims()}
	record := fixtureOidcIdentityRecord(t)
	input := completeFixtureInput(t, store, provider, &fakeOidcDirectory{identity: &record})
	result := CompleteGoogleOidc(context.Background(), input)
	if result.Kind != OidcCompletionResolved || result.Resolution.Kind != OidcAuthenticateExisting {
		t.Fatalf("completion = %#v", result)
	}
	if provider.exchanges.Load() != 1 || store.remaining() != 0 {
		t.Fatalf("exchanges=%d remaining=%d", provider.exchanges.Load(), store.remaining())
	}
	provider.mu.Lock()
	last := provider.last
	provider.mu.Unlock()
	if last.Code != mustOidcCode(t, "google-code-1") || last.RedirectURI != mustOidcRedirect(t, fixtureOidcRedirect) ||
		last.CodeVerifier != mustOidcVerifier(t, fixtureOidcVerifier) {
		t.Fatalf("exchange input = %#v", last)
	}
	replay := CompleteGoogleOidc(context.Background(), input)
	if replay.Kind != OidcCompletionFailed || replay.Error != "authentication-failed" || provider.exchanges.Load() != 1 {
		t.Fatalf("replay = %#v, exchanges=%d", replay, provider.exchanges.Load())
	}
}

func TestGoogleOidcCompletionFailurePaths(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		change func(*RawOidcClaims)
	}{
		{"nonce", func(claims *RawOidcClaims) { claims.Nonce = fixtureOidcOtherNonce }},
		{"issuer", func(claims *RawOidcClaims) { claims.Issuer = fixtureOidcOtherIssuer }},
		{"audience", func(claims *RawOidcClaims) { claims.Audience = []string{fixtureOidcOtherClient} }},
		{"expiry", func(claims *RawOidcClaims) { claims.ExpiresAt = 1_500 }},
		{"unverified email", func(claims *RawOidcClaims) { claims.EmailVerified = false }},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			store := newMemoryOidcTransactions()
			startFixtureOidc(t, store, OidcStartSignIn, nil)
			claims := fixtureRawOidcClaims()
			testCase.change(&claims)
			provider := &fakeOidcProvider{claims: claims}
			result := CompleteGoogleOidc(
				context.Background(), completeFixtureInput(t, store, provider, &fakeOidcDirectory{}),
			)
			if result.Kind != OidcCompletionFailed || result.Error != "authentication-failed" || store.remaining() != 0 {
				t.Fatalf("result = %#v, remaining=%d", result, store.remaining())
			}
		})
	}

	store := newMemoryOidcTransactions()
	startFixtureOidc(t, store, OidcStartSignIn, nil)
	provider := &fakeOidcProvider{claims: fixtureRawOidcClaims()}
	input := completeFixtureInput(t, store, provider, &fakeOidcDirectory{})
	providerError := "access_denied"
	input.Callback = OidcCallbackInput{State: fixtureOidcState, ProviderError: &providerError}
	result := CompleteGoogleOidc(context.Background(), input)
	if result.Kind != OidcCompletionFailed || provider.exchanges.Load() != 0 || store.remaining() != 0 {
		t.Fatalf("provider denial = %#v, exchanges=%d remaining=%d", result, provider.exchanges.Load(), store.remaining())
	}

	store = newMemoryOidcTransactions()
	startFixtureOidc(t, store, OidcStartSignIn, nil)
	account := mustAccountID(t, fixtureAccountID)
	result = CompleteGoogleOidc(context.Background(), completeFixtureInput(
		t, store, &fakeOidcProvider{claims: fixtureRawOidcClaims()}, &fakeOidcDirectory{account: &account},
	))
	if result.Kind != OidcCompletionFailed || result.Error != "authentication-failed" {
		t.Fatalf("email collision leaked = %#v", result)
	}

	store = newMemoryOidcTransactions()
	startFixtureOidc(t, store, OidcStartSignIn, nil)
	malformed := OidcIdentityRecord{AccountID: AccountID("not-an-account")}
	result = CompleteGoogleOidc(context.Background(), completeFixtureInput(
		t, store, &fakeOidcProvider{claims: fixtureRawOidcClaims()}, &fakeOidcDirectory{identity: &malformed},
	))
	if result.Kind != OidcCompletionFailed || result.Error != "authentication-failed" {
		t.Fatalf("malformed directory value = %#v", result)
	}

	store = newMemoryOidcTransactions()
	startFixtureOidc(t, store, OidcStartSignIn, nil)
	providerFailure := &fakeOidcProvider{err: errors.New("provider unavailable")}
	result = CompleteGoogleOidc(
		context.Background(), completeFixtureInput(t, store, providerFailure, &fakeOidcDirectory{}),
	)
	if result.Kind != OidcCompletionFailed || store.remaining() != 0 || providerFailure.exchanges.Load() != 1 {
		t.Fatalf("provider failure = %#v, remaining=%d", result, store.remaining())
	}
}

func TestGoogleOidcCompletionAdmitsSignupOnlyWithConsent(t *testing.T) {
	t.Parallel()
	consent := &SignupTermsConsent{
		SubmissionID: fixtureIdentityID, PresentedTermsVersion: "terms-v1:2026-02-27",
		PresentedTermsHash: "sha256:" + strings.Repeat("a", 64), Affirmed: true,
	}
	store := newMemoryOidcTransactions()
	input := startFixtureInput(t, store)
	input.SignupTermsConsent = consent
	if started := StartGoogleOidc(context.Background(), input); !started.Redirect {
		t.Fatalf("signup start = %#v", started)
	}
	signup := &fakeOidcSignup{result: SignupAdmissionResult{
		Admitted: true,
		Receipt: SignupAdmissionReceipt{
			SubmissionID: fixtureIdentityID,
			Identity: VerifiedSignupIdentity{
				Kind: SignupIdentityGoogle, Issuer: mustOidcIssuer(t, fixtureOidcIssuer),
				Subject: mustOidcSubject(t, fixtureOidcSubject), Email: VerifiedEmailAddress(fixtureOidcEmail),
			},
			AccountID: mustAccountID(t, fixtureAccountID), VaultID: mustVaultID(t, fixtureVaultID),
			IdentityID: mustIdentityID(t, fixtureIdentityID), SessionID: mustSessionID(t, fixtureSessionID),
			SessionEpoch: mustEpoch(t, 1), TermsConsentID: fixtureIdentityID,
			SessionToken: mustToken(t, strings.Repeat("A", 43)), IssuedAt: 1_500,
			ExpiresAt: 1_500 + SignupSessionLifetimeSeconds,
		},
	}}
	completion := completeFixtureInput(
		t, store, &fakeOidcProvider{claims: fixtureRawOidcClaims()}, &fakeOidcDirectory{},
	)
	completion.Signup = signup
	result := CompleteGoogleOidc(context.Background(), completion)
	if result.Kind != OidcCompletionAdmitted || signup.calls.Load() != 1 ||
		result.Admission.AccountID != mustAccountID(t, fixtureAccountID) {
		t.Fatalf("signup completion = %#v, calls=%d", result, signup.calls.Load())
	}

	for _, testCase := range []struct {
		name   string
		mutate func(*SignupAdmissionReceipt)
	}{
		{
			name: "different identity",
			mutate: func(receipt *SignupAdmissionReceipt) {
				receipt.Identity.Subject = mustOidcSubject(t, "different-google-subject")
			},
		},
		{
			name: "different terms submission",
			mutate: func(receipt *SignupAdmissionReceipt) {
				receipt.SubmissionID = fixtureOtherIdentityID
			},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			freshStore := newMemoryOidcTransactions()
			startInput := startFixtureInput(t, freshStore)
			startInput.SignupTermsConsent = consent
			if started := StartGoogleOidc(context.Background(), startInput); !started.Redirect {
				t.Fatalf("signup start = %#v", started)
			}
			badResult := signup.result
			testCase.mutate(&badResult.Receipt)
			badSignup := &fakeOidcSignup{result: badResult}
			completion := completeFixtureInput(
				t, freshStore, &fakeOidcProvider{claims: fixtureRawOidcClaims()}, &fakeOidcDirectory{},
			)
			completion.Signup = badSignup
			if completed := CompleteGoogleOidc(context.Background(), completion); completed.Kind != OidcCompletionFailed {
				t.Fatalf("mismatched signup receipt accepted: %#v", completed)
			}
		})
	}

	store = newMemoryOidcTransactions()
	startFixtureOidc(t, store, OidcStartSignIn, nil)
	completion = completeFixtureInput(
		t, store, &fakeOidcProvider{claims: fixtureRawOidcClaims()}, &fakeOidcDirectory{},
	)
	completion.Signup = signup
	result = CompleteGoogleOidc(context.Background(), completion)
	if result.Kind != OidcCompletionFailed || signup.calls.Load() != 1 {
		t.Fatalf("signup without consent = %#v, calls=%d", result, signup.calls.Load())
	}
}

func TestOidcCallbackAndConcurrentConsume(t *testing.T) {
	t.Parallel()
	callbackURL := "https://notes.example/auth/google/callback?state=" + fixtureOidcState +
		"&state=" + fixtureOidcOtherState + "&code=google-code-1"
	if _, err := OidcCallbackInputFromURL(callbackURL); err == nil {
		t.Fatal("duplicate callback state accepted")
	}
	code := "google-code-1"
	providerError := "access_denied"
	if _, err := DecodeOidcCallback(OidcCallbackInput{
		State: fixtureOidcState, Code: &code, ProviderError: &providerError,
	}); err == nil {
		t.Fatal("callback with code and provider error accepted")
	}

	store := newMemoryOidcTransactions()
	transaction := fixturePendingOidcTransaction(t)
	if err := store.InsertPending(context.Background(), transaction); err != nil {
		t.Fatal(err)
	}
	var winners atomic.Int64
	var wait sync.WaitGroup
	for range 16 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			consumed, err := store.ConsumeByState(context.Background(), transaction.State)
			if err != nil {
				t.Errorf("consume: %v", err)
				return
			}
			if consumed != nil {
				winners.Add(1)
			}
		}()
	}
	wait.Wait()
	if winners.Load() != 1 {
		t.Fatalf("consume winners = %d", winners.Load())
	}
}

func startFixtureOidc(
	t *testing.T,
	store OidcTransactionStore,
	intent OidcStartIntent,
	vaultContext *VaultContext,
) OidcStartResult {
	t.Helper()
	input := startFixtureInput(t, store)
	input.Intent = intent
	input.VaultContext = vaultContext
	return StartGoogleOidc(context.Background(), input)
}

func startFixtureInput(t *testing.T, store OidcTransactionStore) struct {
	Configuration      OidcProviderConfiguration
	RedirectURI        string
	Intent             OidcStartIntent
	SignupTermsConsent *SignupTermsConsent
	VaultContext       *VaultContext
	Clock              OidcClock
	Secrets            OidcSecretPort
	Pkce               PkceChallengePort
	Transactions       OidcTransactionStore
} {
	t.Helper()
	return struct {
		Configuration      OidcProviderConfiguration
		RedirectURI        string
		Intent             OidcStartIntent
		SignupTermsConsent *SignupTermsConsent
		VaultContext       *VaultContext
		Clock              OidcClock
		Secrets            OidcSecretPort
		Pkce               PkceChallengePort
		Transactions       OidcTransactionStore
	}{
		Configuration: fixtureOidcConfiguration(t), RedirectURI: fixtureOidcRedirect,
		Intent: OidcStartSignIn, Clock: fixedOidcClock(1_000),
		Secrets: fakeOidcSecrets{state: fixtureOidcState, nonce: fixtureOidcNonce, verifier: fixtureOidcVerifier},
		Pkce:    fixedPkce{challenge: fixtureOidcChallenge}, Transactions: store,
	}
}

func completeFixtureInput(
	t *testing.T,
	store OidcTransactionStore,
	provider OidcVerifiedClaimsPort,
	directory OidcIdentityDirectory,
) struct {
	Callback      OidcCallbackInput
	Configuration OidcProviderConfiguration
	Clock         OidcClock
	Transactions  OidcTransactionStore
	Provider      OidcVerifiedClaimsPort
	Identities    OidcIdentityDirectory
	Signup        SignupAdmissionPort
} {
	t.Helper()
	code := "google-code-1"
	return struct {
		Callback      OidcCallbackInput
		Configuration OidcProviderConfiguration
		Clock         OidcClock
		Transactions  OidcTransactionStore
		Provider      OidcVerifiedClaimsPort
		Identities    OidcIdentityDirectory
		Signup        SignupAdmissionPort
	}{
		Callback:      OidcCallbackInput{State: fixtureOidcState, Code: &code},
		Configuration: fixtureOidcConfiguration(t), Clock: fixedOidcClock(1_500),
		Transactions: store, Provider: provider, Identities: directory,
	}
}

func fixtureRawOidcClaims() RawOidcClaims {
	return RawOidcClaims{
		Issuer: fixtureOidcIssuer, Subject: fixtureOidcSubject,
		Audience: []string{fixtureOidcClientID}, ExpiresAt: 2_000, IssuedAt: 1_000,
		Nonce: fixtureOidcNonce, Email: fixtureOidcEmail, EmailVerified: true,
	}
}

func mustOidcCode(t *testing.T, value string) OidcAuthorizationCode {
	t.Helper()
	parsed, err := ParseOidcAuthorizationCode(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

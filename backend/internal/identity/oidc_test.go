package identity

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

const (
	fixtureOidcState       = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA"
	fixtureOidcOtherState  = "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEA"
	fixtureOidcVerifier    = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	fixtureOidcChallenge   = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
	fixtureOidcIssuer      = "https://accounts.google.com"
	fixtureOidcOtherIssuer = "https://issuer.example"
	fixtureOidcClientID    = "fukamu-test.apps.googleusercontent.com"
	fixtureOidcOtherClient = "other.apps.googleusercontent.com"
	fixtureOidcEndpoint    = "https://accounts.google.com/o/oauth2/v2/auth"
	fixtureOidcRedirect    = "https://notes.example/auth/google/callback"
	fixtureOidcOtherURI    = "https://preview.notes.example/auth/google/callback"
	fixtureOidcSubject     = "google-subject-123"
	fixtureOidcEmail       = "person@example.com"
	fixtureIdentityID      = "01991f20-61d2-7000-8000-000000000401"
)

var (
	fixtureOidcNonce      = strings.Repeat("D", 42) + "A"
	fixtureOidcOtherNonce = strings.Repeat("F", 42) + "A"
)

func TestOidcValueBoundaries(t *testing.T) {
	t.Parallel()
	if _, err := ParseOidcState(strings.Repeat("A", 43)); err != nil {
		t.Fatalf("valid state rejected: %v", err)
	}
	for _, value := range []string{"short", strings.Repeat("A", 42) + "B", strings.Repeat("A", 129)} {
		if _, err := ParseOidcState(value); err == nil {
			t.Fatalf("invalid state %q accepted", value)
		}
	}
	if _, err := ParsePkceCodeVerifier(strings.Repeat("A", 42) + "!"); err == nil {
		t.Fatal("invalid PKCE verifier accepted")
	}
	if _, err := ParseOidcIssuer("accounts.google.com"); err != nil {
		t.Fatalf("Google legacy issuer rejected: %v", err)
	}
	if _, err := ParseOidcAuthorizationEndpoint("http://accounts.google.com/auth"); err == nil {
		t.Fatal("non-TLS authorization endpoint accepted")
	}
	if _, err := ParseOidcRedirectURI("http://localhost:3000/auth/callback"); err != nil {
		t.Fatalf("loopback redirect rejected: %v", err)
	}
	for _, value := range []string{
		"http://notes.example/auth/callback",
		"https://user@notes.example/auth/callback",
		"https://notes.example/auth/callback#fragment",
		" https://notes.example/auth/callback",
	} {
		if _, err := ParseOidcRedirectURI(value); err == nil {
			t.Fatalf("unsafe redirect %q accepted", value)
		}
	}
	if _, err := ParseOidcEmailAddress("person@@example.com"); err == nil {
		t.Fatal("ambiguous email address accepted")
	}
}

func TestOidcTransactionAndAuthorizationRequest(t *testing.T) {
	t.Parallel()
	configuration := fixtureOidcConfiguration(t)
	transaction := fixturePendingOidcTransaction(t)
	transaction.ExpiresAtEpochSeconds = 0
	decision := CreateOidcTransaction(transaction, configuration)
	if !decision.Created || decision.Transaction.ExpiresAtEpochSeconds != 1_600 {
		t.Fatalf("create transaction = %#v", decision)
	}
	request := CreateOidcAuthorizationRequest(
		configuration,
		decision.Transaction,
		mustOidcChallenge(t, fixtureOidcChallenge),
	)
	if request.ResponseType != "code" || request.Scope != "openid email" ||
		request.CodeChallengeMethod != "S256" || request.RedirectURI != mustOidcRedirect(t, fixtureOidcRedirect) {
		t.Fatalf("authorization request = %#v", request)
	}

	badRedirect := transaction
	badRedirect.RedirectURI = mustOidcRedirect(t, fixtureOidcOtherURI)
	if rejected := CreateOidcTransaction(badRedirect, configuration); rejected.Reason != CreateOidcRedirectNotAllowed {
		t.Fatalf("redirect rejection = %#v", rejected)
	}
	reused := transaction
	reused.Nonce = mustOidcNonce(t, fixtureOidcState)
	if rejected := CreateOidcTransaction(reused, configuration); rejected.Reason != CreateOidcStateNonceReused {
		t.Fatalf("secret reuse rejection = %#v", rejected)
	}
	invalidClock := transaction
	invalidClock.CreatedAtEpochSeconds = MaximumSafeInteger
	if rejected := CreateOidcTransaction(invalidClock, configuration); rejected.Reason != CreateOidcInvalidClock {
		t.Fatalf("clock rejection = %#v", rejected)
	}
	malformedStored := decision.Transaction
	malformedStored.ExpiresAtEpochSeconds++
	if ValidPendingOidcTransaction(malformedStored) {
		t.Fatal("overlong stored transaction accepted")
	}
}

func TestOidcTransactionAndClaimsValidation(t *testing.T) {
	t.Parallel()
	configuration := fixtureOidcConfiguration(t)
	transaction := fixturePendingOidcTransaction(t)
	if validation := ValidateOidcTransaction(transaction, transaction.State, configuration, 1_500); !validation.Valid {
		t.Fatalf("valid transaction rejected = %#v", validation)
	}
	if validation := ValidateOidcTransaction(
		transaction, mustOidcState(t, fixtureOidcOtherState), configuration, 1_500,
	); validation.Reason != OidcTransactionStateMismatch {
		t.Fatalf("state mismatch = %#v", validation)
	}
	if validation := ValidateOidcTransaction(transaction, transaction.State, configuration, 1_600); validation.Reason != OidcTransactionExpired {
		t.Fatalf("expiry = %#v", validation)
	}

	validClaims := fixtureVerifiedOidcClaims(t)
	validation := ValidateOidcClaims(validClaims, transaction, configuration, 1_500)
	if !validation.Valid || validation.IdentityKey.Issuer != validClaims.Issuer || validation.Email != validClaims.Email {
		t.Fatalf("valid claims rejected = %#v", validation)
	}
	cases := []struct {
		name   string
		change func(*VerifiedOidcClaims)
		reason OidcClaimsValidationReason
	}{
		{"issuer", func(claims *VerifiedOidcClaims) { claims.Issuer = mustOidcIssuer(t, fixtureOidcOtherIssuer) }, OidcClaimsIssuerMismatch},
		{"audience", func(claims *VerifiedOidcClaims) {
			claims.Audience = []OidcClientID{mustOidcClientID(t, fixtureOidcOtherClient)}
		}, OidcClaimsAudienceMismatch},
		{"azp", func(claims *VerifiedOidcClaims) {
			claims.Audience = []OidcClientID{mustOidcClientID(t, fixtureOidcClientID), mustOidcClientID(t, fixtureOidcOtherClient)}
			other := mustOidcClientID(t, fixtureOidcOtherClient)
			claims.AuthorizedParty = &other
		}, OidcClaimsAuthorizedPartyMismatch},
		{"expiry", func(claims *VerifiedOidcClaims) { claims.ExpiresAt = 1_500 }, OidcClaimsExpired},
		{"issued-at", func(claims *VerifiedOidcClaims) { claims.IssuedAt = 1_561 }, OidcClaimsInvalidIssuedAt},
		{"nonce", func(claims *VerifiedOidcClaims) { claims.Nonce = mustOidcNonce(t, fixtureOidcOtherNonce) }, OidcClaimsNonceMismatch},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			claims := validClaims
			claims.Audience = append([]OidcClientID(nil), validClaims.Audience...)
			testCase.change(&claims)
			if got := ValidateOidcClaims(claims, transaction, configuration, 1_500); got.Reason != testCase.reason {
				t.Fatalf("validation = %#v, want %q", got, testCase.reason)
			}
		})
	}
	if _, err := DecodeVerifiedOidcClaims(RawOidcClaims{
		Issuer: fixtureOidcIssuer, Subject: fixtureOidcSubject,
		Audience: []string{fixtureOidcClientID}, ExpiresAt: 2_000, IssuedAt: 1_000,
		Nonce: fixtureOidcNonce, Email: fixtureOidcEmail, EmailVerified: false,
	}); err == nil {
		t.Fatal("unverified email claim accepted")
	}
}

func TestOidcIdentityResolutionAndSession(t *testing.T) {
	t.Parallel()
	key := OidcIdentityKey{
		Issuer: mustOidcIssuer(t, fixtureOidcIssuer), Subject: mustOidcSubject(t, fixtureOidcSubject),
	}
	record := fixtureOidcIdentityRecord(t)
	signIn := OidcPurpose{Kind: OidcPurposeSignIn}
	resolution := DecideOidcIdentityResolution(struct {
		Purpose                OidcPurpose
		IdentityKey            OidcIdentityKey
		Email                  OidcEmailAddress
		ExistingIdentity       *OidcIdentityRecord
		VerifiedEmailAccountID *AccountID
	}{Purpose: signIn, IdentityKey: key, Email: mustOidcEmail(t, fixtureOidcEmail), ExistingIdentity: &record})
	if resolution.Kind != OidcAuthenticateExisting || resolution.Identity != &record {
		t.Fatalf("existing resolution = %#v", resolution)
	}
	otherAccount := mustAccountID(t, fixtureOtherAccount)
	resolution = DecideOidcIdentityResolution(struct {
		Purpose                OidcPurpose
		IdentityKey            OidcIdentityKey
		Email                  OidcEmailAddress
		ExistingIdentity       *OidcIdentityRecord
		VerifiedEmailAccountID *AccountID
	}{Purpose: signIn, IdentityKey: key, Email: mustOidcEmail(t, fixtureOidcEmail), VerifiedEmailAccountID: &otherAccount})
	if resolution.Kind != OidcIdentityRejected || resolution.Reason != OidcIdentityEmailCollision {
		t.Fatalf("email collision = %#v", resolution)
	}
	linkPurpose := OidcPurpose{Kind: OidcPurposeLink, AccountID: mustAccountID(t, fixtureOtherAccount)}
	resolution = DecideOidcIdentityResolution(struct {
		Purpose                OidcPurpose
		IdentityKey            OidcIdentityKey
		Email                  OidcEmailAddress
		ExistingIdentity       *OidcIdentityRecord
		VerifiedEmailAccountID *AccountID
	}{Purpose: linkPurpose, IdentityKey: key, Email: mustOidcEmail(t, fixtureOidcEmail), ExistingIdentity: &record})
	if resolution.Reason != OidcIdentityOwnedElsewhere {
		t.Fatalf("cross-account link = %#v", resolution)
	}

	created := EstablishOidcSession(struct {
		Principal        OidcIdentityRecord
		CurrentSession   *Session
		CurrentToken     *SessionToken
		NextSessionID    SessionID
		NextSessionEpoch SessionEpoch
		NextToken        SessionToken
		Now              int64
		ExpiresAt        int64
	}{
		Principal: record, NextSessionID: mustSessionID(t, fixtureNextSessionID),
		NextSessionEpoch: mustEpoch(t, 1), NextToken: mustToken(t, strings.Repeat("B", 42)+"A"),
		Now: 1_500, ExpiresAt: 3_000,
	})
	if created.Kind != OidcSessionCreated || created.Session.AccountID != record.AccountID {
		t.Fatalf("created session = %#v", created)
	}
	current := fixtureSession(t)
	currentToken := mustToken(t, strings.Repeat("A", 43))
	rotated := EstablishOidcSession(struct {
		Principal        OidcIdentityRecord
		CurrentSession   *Session
		CurrentToken     *SessionToken
		NextSessionID    SessionID
		NextSessionEpoch SessionEpoch
		NextToken        SessionToken
		Now              int64
		ExpiresAt        int64
	}{
		Principal: record, CurrentSession: &current, CurrentToken: &currentToken,
		NextSessionID: mustSessionID(t, fixtureNextSessionID), NextSessionEpoch: mustEpoch(t, 2),
		NextToken: mustToken(t, strings.Repeat("B", 42)+"A"), Now: 1_500, ExpiresAt: 3_000,
	})
	if rotated.Kind != OidcSessionRotated || !rotated.Rotation.Rotated {
		t.Fatalf("rotated session = %#v", rotated)
	}
	crossAccount := record
	crossAccount.AccountID = mustAccountID(t, fixtureOtherAccount)
	crossAccount.VaultID = mustVaultID(t, fixtureOtherVault)
	rejected := EstablishOidcSession(struct {
		Principal        OidcIdentityRecord
		CurrentSession   *Session
		CurrentToken     *SessionToken
		NextSessionID    SessionID
		NextSessionEpoch SessionEpoch
		NextToken        SessionToken
		Now              int64
		ExpiresAt        int64
	}{
		Principal: crossAccount, CurrentSession: &current, CurrentToken: &currentToken,
		NextSessionID: mustSessionID(t, fixtureNextSessionID), NextSessionEpoch: mustEpoch(t, 2),
		NextToken: mustToken(t, strings.Repeat("B", 42)+"A"), Now: 1_500, ExpiresAt: 3_000,
	})
	if rejected.Reason != "account-switch-requires-logout" {
		t.Fatalf("cross-account session = %#v", rejected)
	}
}

func TestSharedOidcFixture(t *testing.T) {
	t.Parallel()
	content, err := os.ReadFile("../../../contracts/fixtures/identity/oidc.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Profile       string `json:"profile"`
		Configuration struct {
			AuthorizationEndpoint string   `json:"authorizationEndpoint"`
			ClientID              string   `json:"clientId"`
			AllowedIssuers        []string `json:"allowedIssuers"`
			RedirectURIs          []string `json:"redirectUris"`
		} `json:"configuration"`
		Transaction struct {
			State        string `json:"state"`
			Nonce        string `json:"nonce"`
			CodeVerifier string `json:"codeVerifier"`
			RedirectURI  string `json:"redirectUri"`
			Purpose      struct {
				Kind string `json:"kind"`
			} `json:"purpose"`
			CreatedAtEpochSeconds int64 `json:"createdAtEpochSeconds"`
			ExpiresAtEpochSeconds int64 `json:"expiresAtEpochSeconds"`
		} `json:"transaction"`
		Claims struct {
			Issuer        string `json:"iss"`
			Subject       string `json:"sub"`
			Audience      string `json:"aud"`
			ExpiresAt     int64  `json:"exp"`
			IssuedAt      int64  `json:"iat"`
			Nonce         string `json:"nonce"`
			Email         string `json:"email"`
			EmailVerified bool   `json:"email_verified"`
		} `json:"claims"`
		NowEpochSeconds int64 `json:"nowEpochSeconds"`
		Expected        struct {
			Issuer  string `json:"issuer"`
			Subject string `json:"subject"`
			Email   string `json:"email"`
		} `json:"expected"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(content)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fixture); err != nil {
		t.Fatalf("decode shared OIDC fixture: %v", err)
	}
	if fixture.Profile != "oidc-core" || len(fixture.Configuration.AllowedIssuers) != 1 ||
		len(fixture.Configuration.RedirectURIs) != 1 || fixture.Transaction.Purpose.Kind != "sign-in" {
		t.Fatalf("invalid fixture shape: %#v", fixture)
	}
	configuration := OidcProviderConfiguration{
		AuthorizationEndpoint: mustOidcEndpoint(t, fixture.Configuration.AuthorizationEndpoint),
		ClientID:              mustOidcClientID(t, fixture.Configuration.ClientID),
		AllowedIssuers:        []OidcIssuer{mustOidcIssuer(t, fixture.Configuration.AllowedIssuers[0])},
		RedirectURIs:          []OidcRedirectURI{mustOidcRedirect(t, fixture.Configuration.RedirectURIs[0])},
	}
	transaction := PendingOidcTransaction{
		State:                 mustOidcState(t, fixture.Transaction.State),
		Nonce:                 mustOidcNonce(t, fixture.Transaction.Nonce),
		CodeVerifier:          mustOidcVerifier(t, fixture.Transaction.CodeVerifier),
		RedirectURI:           mustOidcRedirect(t, fixture.Transaction.RedirectURI),
		Purpose:               OidcPurpose{Kind: OidcPurposeSignIn},
		CreatedAtEpochSeconds: fixture.Transaction.CreatedAtEpochSeconds,
		ExpiresAtEpochSeconds: fixture.Transaction.ExpiresAtEpochSeconds,
	}
	claims, err := DecodeVerifiedOidcClaims(RawOidcClaims{
		Issuer: fixture.Claims.Issuer, Subject: fixture.Claims.Subject,
		Audience: []string{fixture.Claims.Audience}, ExpiresAt: fixture.Claims.ExpiresAt,
		IssuedAt: fixture.Claims.IssuedAt, Nonce: fixture.Claims.Nonce,
		Email: fixture.Claims.Email, EmailVerified: fixture.Claims.EmailVerified,
	})
	if err != nil {
		t.Fatal(err)
	}
	if validation := ValidateOidcTransaction(
		transaction, transaction.State, configuration, fixture.NowEpochSeconds,
	); !validation.Valid {
		t.Fatalf("fixture transaction validation = %#v", validation)
	}
	validation := ValidateOidcClaims(claims, transaction, configuration, fixture.NowEpochSeconds)
	if !validation.Valid || string(validation.IdentityKey.Issuer) != fixture.Expected.Issuer ||
		string(validation.IdentityKey.Subject) != fixture.Expected.Subject || string(validation.Email) != fixture.Expected.Email {
		t.Fatalf("fixture claims validation = %#v", validation)
	}
}

func fixtureOidcConfiguration(t *testing.T) OidcProviderConfiguration {
	t.Helper()
	return OidcProviderConfiguration{
		AuthorizationEndpoint: mustOidcEndpoint(t, fixtureOidcEndpoint),
		ClientID:              mustOidcClientID(t, fixtureOidcClientID),
		AllowedIssuers:        []OidcIssuer{mustOidcIssuer(t, fixtureOidcIssuer)},
		RedirectURIs:          []OidcRedirectURI{mustOidcRedirect(t, fixtureOidcRedirect)},
	}
}

func fixturePendingOidcTransaction(t *testing.T) PendingOidcTransaction {
	t.Helper()
	return PendingOidcTransaction{
		State: mustOidcState(t, fixtureOidcState), Nonce: mustOidcNonce(t, fixtureOidcNonce),
		CodeVerifier: mustOidcVerifier(t, fixtureOidcVerifier), RedirectURI: mustOidcRedirect(t, fixtureOidcRedirect),
		Purpose: OidcPurpose{Kind: OidcPurposeSignIn}, CreatedAtEpochSeconds: 1_000, ExpiresAtEpochSeconds: 1_600,
	}
}

func fixtureVerifiedOidcClaims(t *testing.T) VerifiedOidcClaims {
	t.Helper()
	return VerifiedOidcClaims{
		Issuer: mustOidcIssuer(t, fixtureOidcIssuer), Subject: mustOidcSubject(t, fixtureOidcSubject),
		Audience:  []OidcClientID{mustOidcClientID(t, fixtureOidcClientID)},
		ExpiresAt: 2_000, IssuedAt: 1_000,
		Nonce: mustOidcNonce(t, fixtureOidcNonce), Email: mustOidcEmail(t, fixtureOidcEmail),
	}
}

func fixtureOidcIdentityRecord(t *testing.T) OidcIdentityRecord {
	t.Helper()
	return OidcIdentityRecord{
		IdentityID: mustIdentityID(t, fixtureIdentityID), AccountID: mustAccountID(t, fixtureAccountID),
		VaultID: mustVaultID(t, fixtureVaultID), Issuer: mustOidcIssuer(t, fixtureOidcIssuer),
		Subject: mustOidcSubject(t, fixtureOidcSubject),
	}
}

func mustOidcState(t *testing.T, value string) OidcState {
	t.Helper()
	parsed, err := ParseOidcState(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustOidcNonce(t *testing.T, value string) OidcNonce {
	t.Helper()
	parsed, err := ParseOidcNonce(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustOidcVerifier(t *testing.T, value string) PkceCodeVerifier {
	t.Helper()
	parsed, err := ParsePkceCodeVerifier(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustOidcChallenge(t *testing.T, value string) PkceCodeChallenge {
	t.Helper()
	parsed, err := ParsePkceCodeChallenge(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustOidcIssuer(t *testing.T, value string) OidcIssuer {
	t.Helper()
	parsed, err := ParseOidcIssuer(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustOidcSubject(t *testing.T, value string) OidcSubject {
	t.Helper()
	parsed, err := ParseOidcSubject(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustOidcClientID(t *testing.T, value string) OidcClientID {
	t.Helper()
	parsed, err := ParseOidcClientID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustOidcEndpoint(t *testing.T, value string) OidcAuthorizationEndpoint {
	t.Helper()
	parsed, err := ParseOidcAuthorizationEndpoint(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustOidcRedirect(t *testing.T, value string) OidcRedirectURI {
	t.Helper()
	parsed, err := ParseOidcRedirectURI(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustOidcEmail(t *testing.T, value string) OidcEmailAddress {
	t.Helper()
	parsed, err := ParseOidcEmailAddress(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustIdentityID(t *testing.T, value string) IdentityID {
	t.Helper()
	parsed, err := ParseIdentityID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

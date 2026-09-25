package identity

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	OidcTransactionTTLSeconds = int64(600)
	OidcClockSkewSeconds      = int64(60)
)

var (
	ErrInvalidOidcValue = errors.New("invalid OIDC value")

	oidcSecretPattern   = regexp.MustCompile(`^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$`)
	pkceVerifierPattern = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)
	visibleASCIIPattern = regexp.MustCompile(`^[\x21-\x7e]+$`)
	termsVersionPattern = regexp.MustCompile(`^terms-v1:\d{4}-\d{2}-\d{2}$`)
	termsHashPattern    = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
)

type OidcState string
type OidcNonce string
type PkceCodeVerifier string
type PkceCodeChallenge string
type OidcAuthorizationCode string
type OidcIssuer string
type OidcSubject string
type OidcClientID string
type OidcAuthorizationEndpoint string
type OidcRedirectURI string
type OidcEmailAddress string

func ParseOidcState(value string) (OidcState, error) {
	if !oidcSecretPattern.MatchString(value) {
		return "", ErrInvalidOidcValue
	}
	return OidcState(value), nil
}

func ParseOidcNonce(value string) (OidcNonce, error) {
	if !oidcSecretPattern.MatchString(value) {
		return "", ErrInvalidOidcValue
	}
	return OidcNonce(value), nil
}

func ParsePkceCodeVerifier(value string) (PkceCodeVerifier, error) {
	if !pkceVerifierPattern.MatchString(value) {
		return "", ErrInvalidOidcValue
	}
	return PkceCodeVerifier(value), nil
}

func ParsePkceCodeChallenge(value string) (PkceCodeChallenge, error) {
	if !oidcSecretPattern.MatchString(value) {
		return "", ErrInvalidOidcValue
	}
	return PkceCodeChallenge(value), nil
}

func ParseOidcAuthorizationCode(value string) (OidcAuthorizationCode, error) {
	if len(value) < 1 || len(value) > 4_096 || !visibleASCIIPattern.MatchString(value) {
		return "", ErrInvalidOidcValue
	}
	return OidcAuthorizationCode(value), nil
}

func ParseOidcIssuer(value string) (OidcIssuer, error) {
	if len(value) < 1 || len(value) > 2_048 ||
		(value != "accounts.google.com" && !validHTTPSURI(value, false)) {
		return "", ErrInvalidOidcValue
	}
	return OidcIssuer(value), nil
}

func ParseOidcSubject(value string) (OidcSubject, error) {
	if len(value) < 1 || len(value) > 255 || !visibleASCIIPattern.MatchString(value) {
		return "", ErrInvalidOidcValue
	}
	return OidcSubject(value), nil
}

func ParseOidcClientID(value string) (OidcClientID, error) {
	if len(value) < 1 || len(value) > 512 || !visibleASCIIPattern.MatchString(value) {
		return "", ErrInvalidOidcValue
	}
	return OidcClientID(value), nil
}

func ParseOidcAuthorizationEndpoint(value string) (OidcAuthorizationEndpoint, error) {
	if len(value) < 1 || len(value) > 2_048 || !validHTTPSURI(value, true) {
		return "", ErrInvalidOidcValue
	}
	return OidcAuthorizationEndpoint(value), nil
}

func ParseOidcRedirectURI(value string) (OidcRedirectURI, error) {
	if len(value) < 1 || len(value) > 2_048 || !validRedirectURI(value) {
		return "", ErrInvalidOidcValue
	}
	return OidcRedirectURI(value), nil
}

func ParseOidcEmailAddress(value string) (OidcEmailAddress, error) {
	canonical, err := ParseVerifiedEmailAddress(value)
	if err != nil {
		return "", ErrInvalidOidcValue
	}
	return OidcEmailAddress(canonical), nil
}

func (address OidcEmailAddress) Verified() VerifiedEmailAddress {
	return VerifiedEmailAddress(address)
}

func validHTTPSURI(value string, allowQuery bool) bool {
	parsed, ok := parseAbsoluteURI(value)
	return ok && parsed.Scheme == "https" && (allowQuery || parsed.RawQuery == "")
}

func validRedirectURI(value string) bool {
	parsed, ok := parseAbsoluteURI(value)
	if !ok {
		return false
	}
	if parsed.Scheme == "https" {
		return true
	}
	host := parsed.Hostname()
	return parsed.Scheme == "http" &&
		(host == "localhost" || host == "127.0.0.1" || host == "::1")
}

func parseAbsoluteURI(value string) (*url.URL, bool) {
	if !utf8.ValidString(value) || strings.IndexFunc(value, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\r' || r == '\n'
	}) >= 0 {
		return nil, false
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return nil, false
	}
	return parsed, true
}

type OidcPurposeKind string

const (
	OidcPurposeSignIn OidcPurposeKind = "sign-in"
	OidcPurposeLink   OidcPurposeKind = "link"
)

type OidcPurpose struct {
	Kind      OidcPurposeKind
	AccountID AccountID
}

func (purpose OidcPurpose) Valid() bool {
	switch purpose.Kind {
	case OidcPurposeSignIn:
		return purpose.AccountID == ""
	case OidcPurposeLink:
		_, err := ParseAccountID(string(purpose.AccountID))
		return err == nil
	default:
		return false
	}
}

// SignupTermsConsent is carried through the authentication transaction. Its
// policy and persistence remain owned by the signup/terms boundaries.
type SignupTermsConsent struct {
	SubmissionID          string
	PresentedTermsVersion string
	PresentedTermsHash    string
	Affirmed              bool
}

func (consent SignupTermsConsent) Valid() bool {
	return uuidV7Pattern.MatchString(consent.SubmissionID) &&
		termsVersionPattern.MatchString(consent.PresentedTermsVersion) &&
		termsHashPattern.MatchString(consent.PresentedTermsHash)
}

type PendingOidcTransaction struct {
	State                 OidcState
	Nonce                 OidcNonce
	CodeVerifier          PkceCodeVerifier
	RedirectURI           OidcRedirectURI
	Purpose               OidcPurpose
	SignupTermsConsent    *SignupTermsConsent
	CreatedAtEpochSeconds int64
	ExpiresAtEpochSeconds int64
}

func ValidPendingOidcTransaction(transaction PendingOidcTransaction) bool {
	if _, err := ParseOidcState(string(transaction.State)); err != nil {
		return false
	}
	if _, err := ParseOidcNonce(string(transaction.Nonce)); err != nil {
		return false
	}
	if _, err := ParsePkceCodeVerifier(string(transaction.CodeVerifier)); err != nil {
		return false
	}
	if _, err := ParseOidcRedirectURI(string(transaction.RedirectURI)); err != nil {
		return false
	}
	if !transaction.Purpose.Valid() || transaction.State == OidcState(transaction.Nonce) ||
		!validTimestamp(transaction.CreatedAtEpochSeconds) ||
		!validTimestamp(transaction.ExpiresAtEpochSeconds) ||
		transaction.ExpiresAtEpochSeconds <= transaction.CreatedAtEpochSeconds ||
		transaction.ExpiresAtEpochSeconds-transaction.CreatedAtEpochSeconds > OidcTransactionTTLSeconds {
		return false
	}
	if transaction.SignupTermsConsent != nil {
		return transaction.Purpose.Kind == OidcPurposeSignIn && transaction.SignupTermsConsent.Valid()
	}
	return true
}

type OidcProviderConfiguration struct {
	AuthorizationEndpoint OidcAuthorizationEndpoint
	ClientID              OidcClientID
	AllowedIssuers        []OidcIssuer
	RedirectURIs          []OidcRedirectURI
}

func (configuration OidcProviderConfiguration) Valid() bool {
	if _, err := ParseOidcAuthorizationEndpoint(string(configuration.AuthorizationEndpoint)); err != nil {
		return false
	}
	if _, err := ParseOidcClientID(string(configuration.ClientID)); err != nil {
		return false
	}
	if len(configuration.AllowedIssuers) < 1 || len(configuration.AllowedIssuers) > 4 ||
		len(configuration.RedirectURIs) < 1 || len(configuration.RedirectURIs) > 8 {
		return false
	}
	issuers := make(map[OidcIssuer]struct{}, len(configuration.AllowedIssuers))
	for _, issuer := range configuration.AllowedIssuers {
		if _, err := ParseOidcIssuer(string(issuer)); err != nil {
			return false
		}
		if _, duplicate := issuers[issuer]; duplicate {
			return false
		}
		issuers[issuer] = struct{}{}
	}
	redirects := make(map[OidcRedirectURI]struct{}, len(configuration.RedirectURIs))
	for _, redirect := range configuration.RedirectURIs {
		if _, err := ParseOidcRedirectURI(string(redirect)); err != nil {
			return false
		}
		if _, duplicate := redirects[redirect]; duplicate {
			return false
		}
		redirects[redirect] = struct{}{}
	}
	return true
}

type CreateOidcTransactionReason string

const (
	CreateOidcInvalidClock       CreateOidcTransactionReason = "invalid-clock"
	CreateOidcRedirectNotAllowed CreateOidcTransactionReason = "redirect-not-allowed"
	CreateOidcStateNonceReused   CreateOidcTransactionReason = "state-nonce-reused"
	CreateOidcInvalidPurpose     CreateOidcTransactionReason = "invalid-purpose"
	CreateOidcInvalidInput       CreateOidcTransactionReason = "invalid-input"
)

type CreateOidcTransactionDecision struct {
	Created     bool
	Reason      CreateOidcTransactionReason
	Transaction PendingOidcTransaction
}

func CreateOidcTransaction(input PendingOidcTransaction, configuration OidcProviderConfiguration) CreateOidcTransactionDecision {
	if !configuration.Valid() {
		return CreateOidcTransactionDecision{Reason: CreateOidcInvalidInput}
	}
	if !validTimestamp(input.CreatedAtEpochSeconds) ||
		input.CreatedAtEpochSeconds > MaximumSafeInteger-OidcTransactionTTLSeconds {
		return CreateOidcTransactionDecision{Reason: CreateOidcInvalidClock}
	}
	if !containsRedirect(configuration.RedirectURIs, input.RedirectURI) {
		return CreateOidcTransactionDecision{Reason: CreateOidcRedirectNotAllowed}
	}
	if input.State == OidcState(input.Nonce) || string(input.State) == string(input.CodeVerifier) {
		return CreateOidcTransactionDecision{Reason: CreateOidcStateNonceReused}
	}
	if !input.Purpose.Valid() ||
		(input.Purpose.Kind == OidcPurposeLink && input.SignupTermsConsent != nil) {
		return CreateOidcTransactionDecision{Reason: CreateOidcInvalidPurpose}
	}
	if input.SignupTermsConsent != nil {
		consent := *input.SignupTermsConsent
		input.SignupTermsConsent = &consent
	}
	input.ExpiresAtEpochSeconds = input.CreatedAtEpochSeconds + OidcTransactionTTLSeconds
	if !ValidPendingOidcTransaction(input) {
		return CreateOidcTransactionDecision{Reason: CreateOidcInvalidInput}
	}
	return CreateOidcTransactionDecision{Created: true, Transaction: input}
}

type OidcAuthorizationRequest struct {
	AuthorizationEndpoint OidcAuthorizationEndpoint
	ResponseType          string
	ClientID              OidcClientID
	RedirectURI           OidcRedirectURI
	Scope                 string
	State                 OidcState
	Nonce                 OidcNonce
	CodeChallenge         PkceCodeChallenge
	CodeChallengeMethod   string
}

func CreateOidcAuthorizationRequest(
	configuration OidcProviderConfiguration,
	transaction PendingOidcTransaction,
	challenge PkceCodeChallenge,
) OidcAuthorizationRequest {
	return OidcAuthorizationRequest{
		AuthorizationEndpoint: configuration.AuthorizationEndpoint,
		ResponseType:          "code", ClientID: configuration.ClientID,
		RedirectURI: transaction.RedirectURI, Scope: "openid email",
		State: transaction.State, Nonce: transaction.Nonce,
		CodeChallenge: challenge, CodeChallengeMethod: "S256",
	}
}

type OidcTransactionValidationReason string

const (
	OidcTransactionInvalidClock       OidcTransactionValidationReason = "invalid-clock"
	OidcTransactionStateMismatch      OidcTransactionValidationReason = "state-mismatch"
	OidcTransactionExpired            OidcTransactionValidationReason = "expired-transaction"
	OidcTransactionRedirectNotAllowed OidcTransactionValidationReason = "redirect-not-allowed"
	OidcTransactionInvalid            OidcTransactionValidationReason = "invalid-transaction"
)

type OidcTransactionValidation struct {
	Valid  bool
	Reason OidcTransactionValidationReason
}

func ValidateOidcTransaction(
	transaction PendingOidcTransaction,
	callbackState OidcState,
	configuration OidcProviderConfiguration,
	now int64,
) OidcTransactionValidation {
	if !validTimestamp(now) {
		return OidcTransactionValidation{Reason: OidcTransactionInvalidClock}
	}
	if !ValidPendingOidcTransaction(transaction) || !configuration.Valid() {
		return OidcTransactionValidation{Reason: OidcTransactionInvalid}
	}
	if transaction.State != callbackState {
		return OidcTransactionValidation{Reason: OidcTransactionStateMismatch}
	}
	if now >= transaction.ExpiresAtEpochSeconds {
		return OidcTransactionValidation{Reason: OidcTransactionExpired}
	}
	if !containsRedirect(configuration.RedirectURIs, transaction.RedirectURI) {
		return OidcTransactionValidation{Reason: OidcTransactionRedirectNotAllowed}
	}
	return OidcTransactionValidation{Valid: true}
}

type RawOidcClaims struct {
	Issuer          string
	Subject         string
	Audience        []string
	AuthorizedParty string
	ExpiresAt       int64
	IssuedAt        int64
	Nonce           string
	Email           string
	EmailVerified   bool
}

type VerifiedOidcClaims struct {
	Issuer          OidcIssuer
	Subject         OidcSubject
	Audience        []OidcClientID
	AuthorizedParty *OidcClientID
	ExpiresAt       int64
	IssuedAt        int64
	Nonce           OidcNonce
	Email           OidcEmailAddress
}

func DecodeVerifiedOidcClaims(raw RawOidcClaims) (VerifiedOidcClaims, error) {
	issuer, err := ParseOidcIssuer(raw.Issuer)
	if err != nil {
		return VerifiedOidcClaims{}, err
	}
	subject, err := ParseOidcSubject(raw.Subject)
	if err != nil {
		return VerifiedOidcClaims{}, err
	}
	if len(raw.Audience) < 1 || len(raw.Audience) > 16 || !raw.EmailVerified ||
		!validTimestamp(raw.ExpiresAt) || !validTimestamp(raw.IssuedAt) {
		return VerifiedOidcClaims{}, ErrInvalidOidcValue
	}
	audience := make([]OidcClientID, 0, len(raw.Audience))
	seen := make(map[OidcClientID]struct{}, len(raw.Audience))
	for _, rawClientID := range raw.Audience {
		clientID, parseErr := ParseOidcClientID(rawClientID)
		if parseErr != nil {
			return VerifiedOidcClaims{}, parseErr
		}
		if _, duplicate := seen[clientID]; duplicate {
			return VerifiedOidcClaims{}, ErrInvalidOidcValue
		}
		seen[clientID] = struct{}{}
		audience = append(audience, clientID)
	}
	nonce, err := ParseOidcNonce(raw.Nonce)
	if err != nil {
		return VerifiedOidcClaims{}, err
	}
	email, err := ParseOidcEmailAddress(raw.Email)
	if err != nil {
		return VerifiedOidcClaims{}, err
	}
	claims := VerifiedOidcClaims{
		Issuer: issuer, Subject: subject, Audience: audience,
		ExpiresAt: raw.ExpiresAt, IssuedAt: raw.IssuedAt, Nonce: nonce, Email: email,
	}
	if raw.AuthorizedParty != "" {
		authorizedParty, parseErr := ParseOidcClientID(raw.AuthorizedParty)
		if parseErr != nil {
			return VerifiedOidcClaims{}, parseErr
		}
		claims.AuthorizedParty = &authorizedParty
	}
	return claims, nil
}

type OidcIdentityKey struct {
	Issuer  OidcIssuer
	Subject OidcSubject
}

type OidcClaimsValidationReason string

const (
	OidcClaimsInvalidClock            OidcClaimsValidationReason = "invalid-clock"
	OidcClaimsIssuerMismatch          OidcClaimsValidationReason = "issuer-mismatch"
	OidcClaimsAudienceMismatch        OidcClaimsValidationReason = "audience-mismatch"
	OidcClaimsAuthorizedPartyMismatch OidcClaimsValidationReason = "authorized-party-mismatch"
	OidcClaimsExpired                 OidcClaimsValidationReason = "expired-token"
	OidcClaimsInvalidIssuedAt         OidcClaimsValidationReason = "invalid-issued-at"
	OidcClaimsNonceMismatch           OidcClaimsValidationReason = "nonce-mismatch"
)

type OidcClaimsValidation struct {
	Valid       bool
	Reason      OidcClaimsValidationReason
	IdentityKey OidcIdentityKey
	Email       OidcEmailAddress
}

func ValidateOidcClaims(
	claims VerifiedOidcClaims,
	transaction PendingOidcTransaction,
	configuration OidcProviderConfiguration,
	now int64,
) OidcClaimsValidation {
	if !validTimestamp(now) {
		return OidcClaimsValidation{Reason: OidcClaimsInvalidClock}
	}
	if !containsIssuer(configuration.AllowedIssuers, claims.Issuer) {
		return OidcClaimsValidation{Reason: OidcClaimsIssuerMismatch}
	}
	if !containsClientID(claims.Audience, configuration.ClientID) {
		return OidcClaimsValidation{Reason: OidcClaimsAudienceMismatch}
	}
	if (len(claims.Audience) > 1 || claims.AuthorizedParty != nil) &&
		(claims.AuthorizedParty == nil || *claims.AuthorizedParty != configuration.ClientID) {
		return OidcClaimsValidation{Reason: OidcClaimsAuthorizedPartyMismatch}
	}
	if now >= claims.ExpiresAt {
		return OidcClaimsValidation{Reason: OidcClaimsExpired}
	}
	if claims.IssuedAt > now+OidcClockSkewSeconds || claims.IssuedAt >= claims.ExpiresAt {
		return OidcClaimsValidation{Reason: OidcClaimsInvalidIssuedAt}
	}
	if claims.Nonce != transaction.Nonce {
		return OidcClaimsValidation{Reason: OidcClaimsNonceMismatch}
	}
	return OidcClaimsValidation{
		Valid: true, IdentityKey: OidcIdentityKey{Issuer: claims.Issuer, Subject: claims.Subject},
		Email: claims.Email,
	}
}

type OidcIdentityRecord struct {
	IdentityID IdentityID
	AccountID  AccountID
	VaultID    VaultID
	Issuer     OidcIssuer
	Subject    OidcSubject
}

func (record OidcIdentityRecord) Valid() bool {
	_, identityErr := ParseIdentityID(string(record.IdentityID))
	_, accountErr := ParseAccountID(string(record.AccountID))
	_, vaultErr := ParseVaultID(string(record.VaultID))
	_, issuerErr := ParseOidcIssuer(string(record.Issuer))
	_, subjectErr := ParseOidcSubject(string(record.Subject))
	return identityErr == nil && accountErr == nil && vaultErr == nil && issuerErr == nil && subjectErr == nil
}

type OidcIdentityResolutionKind string
type OidcIdentityResolutionReason string

const (
	OidcAuthenticateExisting OidcIdentityResolutionKind = "authenticate-existing"
	OidcProvisionAccount     OidcIdentityResolutionKind = "provision-account"
	OidcLinkIdentity         OidcIdentityResolutionKind = "link-identity"
	OidcAlreadyLinked        OidcIdentityResolutionKind = "already-linked"
	OidcIdentityRejected     OidcIdentityResolutionKind = "rejected"

	OidcIdentityRecordMismatch OidcIdentityResolutionReason = "identity-record-mismatch"
	OidcIdentityOwnedElsewhere OidcIdentityResolutionReason = "identity-owned-by-another-account"
	OidcIdentityEmailCollision OidcIdentityResolutionReason = "email-collision"
)

type OidcIdentityResolution struct {
	Kind        OidcIdentityResolutionKind
	Reason      OidcIdentityResolutionReason
	Identity    *OidcIdentityRecord
	AccountID   AccountID
	IdentityKey OidcIdentityKey
	Email       OidcEmailAddress
}

func DecideOidcIdentityResolution(input struct {
	Purpose                OidcPurpose
	IdentityKey            OidcIdentityKey
	Email                  OidcEmailAddress
	ExistingIdentity       *OidcIdentityRecord
	VerifiedEmailAccountID *AccountID
}) OidcIdentityResolution {
	if input.ExistingIdentity != nil &&
		(input.ExistingIdentity.Issuer != input.IdentityKey.Issuer || input.ExistingIdentity.Subject != input.IdentityKey.Subject) {
		return OidcIdentityResolution{Kind: OidcIdentityRejected, Reason: OidcIdentityRecordMismatch}
	}
	if input.Purpose.Kind == OidcPurposeSignIn {
		if input.ExistingIdentity != nil {
			return OidcIdentityResolution{Kind: OidcAuthenticateExisting, Identity: input.ExistingIdentity}
		}
		if input.VerifiedEmailAccountID != nil {
			return OidcIdentityResolution{Kind: OidcIdentityRejected, Reason: OidcIdentityEmailCollision}
		}
		return OidcIdentityResolution{
			Kind: OidcProvisionAccount, IdentityKey: input.IdentityKey, Email: input.Email,
		}
	}
	if input.ExistingIdentity != nil {
		if input.ExistingIdentity.AccountID == input.Purpose.AccountID {
			return OidcIdentityResolution{Kind: OidcAlreadyLinked, Identity: input.ExistingIdentity}
		}
		return OidcIdentityResolution{Kind: OidcIdentityRejected, Reason: OidcIdentityOwnedElsewhere}
	}
	if input.VerifiedEmailAccountID != nil && *input.VerifiedEmailAccountID != input.Purpose.AccountID {
		return OidcIdentityResolution{Kind: OidcIdentityRejected, Reason: OidcIdentityEmailCollision}
	}
	return OidcIdentityResolution{
		Kind: OidcLinkIdentity, AccountID: input.Purpose.AccountID,
		IdentityKey: input.IdentityKey, Email: input.Email,
	}
}

type OidcSessionEstablishmentKind string

const (
	OidcSessionCreated  OidcSessionEstablishmentKind = "created"
	OidcSessionRotated  OidcSessionEstablishmentKind = "rotated"
	OidcSessionRejected OidcSessionEstablishmentKind = "rejected"
)

type OidcSessionEstablishment struct {
	Kind     OidcSessionEstablishmentKind
	Reason   string
	Session  Session
	Token    SessionToken
	Rotation RotationDecision
}

func EstablishOidcSession(input struct {
	Principal        OidcIdentityRecord
	CurrentSession   *Session
	CurrentToken     *SessionToken
	NextSessionID    SessionID
	NextSessionEpoch SessionEpoch
	NextToken        SessionToken
	Now              int64
	ExpiresAt        int64
}) OidcSessionEstablishment {
	if !input.Principal.Valid() || !validToken(input.NextToken) {
		return OidcSessionEstablishment{Kind: OidcSessionRejected, Reason: "invalid-session"}
	}
	if input.CurrentSession == nil {
		if input.NextSessionEpoch != 1 {
			return OidcSessionEstablishment{Kind: OidcSessionRejected, Reason: "initial-epoch-must-be-one"}
		}
		created := CreateActiveSession(SessionInput{
			SessionID: input.NextSessionID, AccountID: input.Principal.AccountID,
			VaultID: input.Principal.VaultID, SessionEpoch: input.NextSessionEpoch,
			IssuedAt: input.Now, ExpiresAt: input.ExpiresAt,
		})
		if !created.Created {
			return OidcSessionEstablishment{Kind: OidcSessionRejected, Reason: string(created.Reason)}
		}
		return OidcSessionEstablishment{Kind: OidcSessionCreated, Session: created.Session, Token: input.NextToken}
	}
	if input.CurrentSession.AccountID != input.Principal.AccountID || input.CurrentSession.VaultID != input.Principal.VaultID {
		return OidcSessionEstablishment{Kind: OidcSessionRejected, Reason: "account-switch-requires-logout"}
	}
	if input.CurrentToken == nil {
		return OidcSessionEstablishment{Kind: OidcSessionRejected, Reason: "missing-current-token"}
	}
	rotation := RotateSession(*input.CurrentSession, RotationInput{
		NextSessionID: input.NextSessionID, NextSessionEpoch: input.NextSessionEpoch,
		CurrentToken: *input.CurrentToken, NextToken: input.NextToken,
		RotatedAt: input.Now, ExpiresAt: input.ExpiresAt,
	})
	if !rotation.Rotated {
		return OidcSessionEstablishment{Kind: OidcSessionRejected, Reason: string(rotation.Reason)}
	}
	return OidcSessionEstablishment{Kind: OidcSessionRotated, Rotation: rotation}
}

func containsIssuer(values []OidcIssuer, candidate OidcIssuer) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

func containsRedirect(values []OidcRedirectURI, candidate OidcRedirectURI) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

func containsClientID(values []OidcClientID, candidate OidcClientID) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

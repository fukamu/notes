package identity

import (
	"context"
	"net/url"
)

type OidcClock interface {
	NowEpochSeconds() int64
}

type OidcSecretPort interface {
	CreateState(context.Context) (string, error)
	CreateNonce(context.Context) (string, error)
	CreateCodeVerifier(context.Context) (string, error)
}

type PkceChallengePort interface {
	DeriveS256(PkceCodeVerifier) (string, error)
}

type OidcTransactionStore interface {
	InsertPending(context.Context, PendingOidcTransaction) error
	ConsumeByState(context.Context, OidcState) (*PendingOidcTransaction, error)
}

type OidcCodeExchangeInput struct {
	Code         OidcAuthorizationCode
	ClientID     OidcClientID
	RedirectURI  OidcRedirectURI
	CodeVerifier PkceCodeVerifier
}

type OidcVerifiedClaimsPort interface {
	ExchangeCodeForVerifiedClaims(context.Context, OidcCodeExchangeInput) (RawOidcClaims, error)
}

type OidcIdentityDirectory interface {
	FindByIssuerSubject(context.Context, OidcIdentityKey) (*OidcIdentityRecord, error)
	FindAccountIDByVerifiedEmail(context.Context, VerifiedEmailAddress) (*AccountID, error)
}

type OidcStartIntent string

const (
	OidcStartSignIn             OidcStartIntent = "sign-in"
	OidcStartLinkCurrentAccount OidcStartIntent = "link-current-account"
)

type OidcStartResult struct {
	Redirect bool
	Request  OidcAuthorizationRequest
	Error    string
}

func StartGoogleOidc(ctx context.Context, input struct {
	Configuration      OidcProviderConfiguration
	RedirectURI        string
	Intent             OidcStartIntent
	SignupTermsConsent *SignupTermsConsent
	VaultContext       *VaultContext
	Clock              OidcClock
	Secrets            OidcSecretPort
	Pkce               PkceChallengePort
	Transactions       OidcTransactionStore
}) OidcStartResult {
	failure := OidcStartResult{Error: "authentication-unavailable"}
	if input.Clock == nil || input.Secrets == nil || input.Pkce == nil || input.Transactions == nil ||
		!input.Configuration.Valid() {
		return failure
	}
	now := input.Clock.NowEpochSeconds()
	redirectURI, err := ParseOidcRedirectURI(input.RedirectURI)
	if err != nil || !validTimestamp(now) ||
		(input.Intent != OidcStartSignIn && input.Intent != OidcStartLinkCurrentAccount) ||
		(input.Intent == OidcStartLinkCurrentAccount &&
			(input.VaultContext == nil || !validOidcVaultContext(*input.VaultContext))) ||
		(input.Intent == OidcStartLinkCurrentAccount && input.SignupTermsConsent != nil) ||
		(input.SignupTermsConsent != nil && !input.SignupTermsConsent.Valid()) {
		return failure
	}
	rawState, err := input.Secrets.CreateState(ctx)
	if err != nil {
		return failure
	}
	rawNonce, err := input.Secrets.CreateNonce(ctx)
	if err != nil {
		return failure
	}
	rawVerifier, err := input.Secrets.CreateCodeVerifier(ctx)
	if err != nil {
		return failure
	}
	state, err := ParseOidcState(rawState)
	if err != nil {
		return failure
	}
	nonce, err := ParseOidcNonce(rawNonce)
	if err != nil {
		return failure
	}
	verifier, err := ParsePkceCodeVerifier(rawVerifier)
	if err != nil {
		return failure
	}
	purpose := OidcPurpose{Kind: OidcPurposeSignIn}
	if input.Intent == OidcStartLinkCurrentAccount {
		purpose = OidcPurpose{Kind: OidcPurposeLink, AccountID: input.VaultContext.AccountID}
	}
	decision := CreateOidcTransaction(PendingOidcTransaction{
		State: state, Nonce: nonce, CodeVerifier: verifier, RedirectURI: redirectURI,
		Purpose: purpose, SignupTermsConsent: input.SignupTermsConsent,
		CreatedAtEpochSeconds: now,
	}, input.Configuration)
	if !decision.Created {
		return failure
	}
	rawChallenge, err := input.Pkce.DeriveS256(verifier)
	if err != nil {
		return failure
	}
	challenge, err := ParsePkceCodeChallenge(rawChallenge)
	if err != nil {
		return failure
	}
	if err := input.Transactions.InsertPending(ctx, decision.Transaction); err != nil {
		return failure
	}
	return OidcStartResult{
		Redirect: true,
		Request:  CreateOidcAuthorizationRequest(input.Configuration, decision.Transaction, challenge),
	}
}

func validOidcVaultContext(value VaultContext) bool {
	return validAccountID(value.AccountID) && validVaultID(value.VaultID) &&
		validSessionID(value.SessionID) && validEpoch(value.SessionEpoch)
}

type OidcCallbackKind string

const (
	OidcCallbackAuthorizationCode OidcCallbackKind = "authorization-code"
	OidcCallbackProviderError     OidcCallbackKind = "provider-error"
)

type OidcCallback struct {
	Kind          OidcCallbackKind
	State         OidcState
	Code          OidcAuthorizationCode
	ProviderError string
}

type OidcCallbackInput struct {
	State            string
	Code             *string
	ProviderError    *string
	ErrorDescription *string
}

func DecodeOidcCallback(input OidcCallbackInput) (OidcCallback, error) {
	state, err := ParseOidcState(input.State)
	if err != nil || (input.Code == nil) == (input.ProviderError == nil) ||
		(input.ProviderError == nil && input.ErrorDescription != nil) {
		return OidcCallback{}, ErrInvalidOidcValue
	}
	if input.Code != nil {
		code, parseErr := ParseOidcAuthorizationCode(*input.Code)
		if parseErr != nil {
			return OidcCallback{}, parseErr
		}
		return OidcCallback{Kind: OidcCallbackAuthorizationCode, State: state, Code: code}, nil
	}
	if len(*input.ProviderError) < 1 || len(*input.ProviderError) > 256 ||
		!visibleASCIIPattern.MatchString(*input.ProviderError) ||
		(input.ErrorDescription != nil && len(*input.ErrorDescription) > 1_024) {
		return OidcCallback{}, ErrInvalidOidcValue
	}
	return OidcCallback{
		Kind: OidcCallbackProviderError, State: state, ProviderError: *input.ProviderError,
	}, nil
}

func OidcCallbackInputFromURL(raw string) (OidcCallbackInput, error) {
	if len(raw) > 8_192 {
		return OidcCallbackInput{}, ErrInvalidOidcValue
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return OidcCallbackInput{}, ErrInvalidOidcValue
	}
	values, err := url.ParseQuery(parsed.RawQuery)
	if err != nil {
		return OidcCallbackInput{}, ErrInvalidOidcValue
	}
	for _, name := range []string{"state", "code", "error", "error_description"} {
		if len(values[name]) > 1 {
			return OidcCallbackInput{}, ErrInvalidOidcValue
		}
	}
	input := OidcCallbackInput{State: values.Get("state")}
	if values.Has("code") {
		value := values.Get("code")
		input.Code = &value
	}
	if values.Has("error") {
		value := values.Get("error")
		input.ProviderError = &value
	}
	if values.Has("error_description") {
		value := values.Get("error_description")
		input.ErrorDescription = &value
	}
	return input, nil
}

func SerializeOidcAuthorizationRequest(request OidcAuthorizationRequest) (string, error) {
	endpoint, err := url.Parse(string(request.AuthorizationEndpoint))
	if err != nil {
		return "", ErrInvalidOidcValue
	}
	query := endpoint.Query()
	query.Set("response_type", request.ResponseType)
	query.Set("client_id", string(request.ClientID))
	query.Set("redirect_uri", string(request.RedirectURI))
	query.Set("scope", request.Scope)
	query.Set("state", string(request.State))
	query.Set("nonce", string(request.Nonce))
	query.Set("code_challenge", string(request.CodeChallenge))
	query.Set("code_challenge_method", request.CodeChallengeMethod)
	endpoint.RawQuery = query.Encode()
	return endpoint.String(), nil
}

type OidcCompletionKind string

const (
	OidcCompletionResolved OidcCompletionKind = "resolved"
	OidcCompletionAdmitted OidcCompletionKind = "admitted"
	OidcCompletionFailed   OidcCompletionKind = "failed"
)

type OidcCompletionResult struct {
	Kind       OidcCompletionKind
	Error      string
	Resolution OidcIdentityResolution
	Admission  SignupAdmissionReceipt
}

func CompleteGoogleOidc(ctx context.Context, input struct {
	Callback      OidcCallbackInput
	Configuration OidcProviderConfiguration
	Clock         OidcClock
	Transactions  OidcTransactionStore
	Provider      OidcVerifiedClaimsPort
	Identities    OidcIdentityDirectory
	Signup        SignupAdmissionPort
}) OidcCompletionResult {
	failure := OidcCompletionResult{Kind: OidcCompletionFailed, Error: "authentication-failed"}
	if input.Clock == nil || input.Transactions == nil || input.Provider == nil || input.Identities == nil ||
		!input.Configuration.Valid() {
		return failure
	}
	callback, err := DecodeOidcCallback(input.Callback)
	if err != nil {
		return failure
	}
	now := input.Clock.NowEpochSeconds()
	if !validTimestamp(now) {
		return failure
	}
	transaction, err := input.Transactions.ConsumeByState(ctx, callback.State)
	if err != nil || transaction == nil || !ValidPendingOidcTransaction(*transaction) {
		return failure
	}
	if validation := ValidateOidcTransaction(*transaction, callback.State, input.Configuration, now); !validation.Valid ||
		callback.Kind == OidcCallbackProviderError {
		return failure
	}
	rawClaims, err := input.Provider.ExchangeCodeForVerifiedClaims(ctx, OidcCodeExchangeInput{
		Code: callback.Code, ClientID: input.Configuration.ClientID,
		RedirectURI: transaction.RedirectURI, CodeVerifier: transaction.CodeVerifier,
	})
	if err != nil {
		return failure
	}
	claims, err := DecodeVerifiedOidcClaims(rawClaims)
	if err != nil {
		return failure
	}
	claimsValidation := ValidateOidcClaims(claims, *transaction, input.Configuration, now)
	if !claimsValidation.Valid {
		return failure
	}
	existingIdentity, err := input.Identities.FindByIssuerSubject(ctx, claimsValidation.IdentityKey)
	if err != nil || (existingIdentity != nil && !existingIdentity.Valid()) {
		return failure
	}
	verifiedEmailAccountID, err := input.Identities.FindAccountIDByVerifiedEmail(ctx, claimsValidation.Email.Verified())
	if err != nil || (verifiedEmailAccountID != nil && !validAccountID(*verifiedEmailAccountID)) {
		return failure
	}
	resolution := DecideOidcIdentityResolution(struct {
		Purpose                OidcPurpose
		IdentityKey            OidcIdentityKey
		Email                  OidcEmailAddress
		ExistingIdentity       *OidcIdentityRecord
		VerifiedEmailAccountID *AccountID
	}{
		Purpose: transaction.Purpose, IdentityKey: claimsValidation.IdentityKey,
		Email: claimsValidation.Email, ExistingIdentity: existingIdentity,
		VerifiedEmailAccountID: verifiedEmailAccountID,
	})
	if resolution.Kind == OidcIdentityRejected {
		return failure
	}
	if resolution.Kind == OidcProvisionAccount {
		if transaction.SignupTermsConsent == nil || input.Signup == nil {
			return failure
		}
		verifiedIdentity := VerifiedSignupIdentity{
			Kind:   SignupIdentityGoogle,
			Issuer: resolution.IdentityKey.Issuer, Subject: resolution.IdentityKey.Subject,
			Email: resolution.Email.Verified(),
		}
		admission, admitErr := input.Signup.Admit(ctx, verifiedIdentity, *transaction.SignupTermsConsent)
		if admitErr != nil || !admission.Admitted ||
			!signupAdmissionMatchesRequest(admission.Receipt, verifiedIdentity, *transaction.SignupTermsConsent) {
			return failure
		}
		return OidcCompletionResult{Kind: OidcCompletionAdmitted, Admission: admission.Receipt}
	}
	return OidcCompletionResult{Kind: OidcCompletionResolved, Resolution: resolution}
}

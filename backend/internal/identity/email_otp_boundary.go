package identity

import "context"

type EmailOtpClock interface {
	NowEpochSeconds() int64
}

type EmailOtpSecretPort interface {
	CreateChallengeID(context.Context) (string, error)
	CreateCode(context.Context) (string, error)
	CreateSalt(context.Context) (string, error)
}

type EmailOtpHashInput struct {
	ChallengeID EmailOtpChallengeID
	Address     EmailOtpAddress
	Code        EmailOtpCode
	Salt        EmailOtpSalt
}

type EmailOtpHasherPort interface {
	CreateDigest(context.Context, EmailOtpHashInput) (string, error)
	MatchesDigest(context.Context, EmailOtpHashInput, EmailOtpDigest) (bool, error)
}

type EmailOtpChallengeStore interface {
	InsertPending(context.Context, EmailOtpChallenge) error
	FindByID(context.Context, EmailOtpChallengeID) (*EmailOtpChallenge, error)
	CompareAndSwap(context.Context, EmailOtpChallengeID, int64, EmailOtpChallenge) (bool, error)
}

type EmailOtpRateLimitKeys struct {
	Address EmailOtpRateLimitKey
	Network EmailOtpRateLimitKey
	Account *EmailOtpRateLimitKey
}

func (keys EmailOtpRateLimitKeys) Valid(requireAccount bool) bool {
	if _, err := ParseEmailOtpRateLimitKey(string(keys.Address)); err != nil {
		return false
	}
	if _, err := ParseEmailOtpRateLimitKey(string(keys.Network)); err != nil {
		return false
	}
	if keys.Account != nil {
		if _, err := ParseEmailOtpRateLimitKey(string(*keys.Account)); err != nil {
			return false
		}
	}
	return !requireAccount || keys.Account != nil
}

type EmailOtpAbuseKeyPort interface {
	DeriveKeys(context.Context, EmailOtpAddress, string, *AccountID) (EmailOtpRateLimitKeys, error)
}

type EmailOtpRateLimitPort interface {
	Reserve(context.Context, EmailOtpRateLimitKeys, int64) (bool, error)
}

type EmailOtpDeliveryInput struct {
	ChallengeID EmailOtpChallengeID
	Address     EmailOtpAddress
	Code        EmailOtpCode
	ExpiresAt   int64
}

type EmailOtpDeliveryPort interface {
	SendOtp(context.Context, EmailOtpDeliveryInput) error
}

type EmailOtpIdentityDirectory interface {
	FindByAddress(context.Context, EmailOtpAddress) (*EmailOtpIdentityRecord, error)
	FindAccountIDByVerifiedEmail(context.Context, VerifiedEmailAddress) (*AccountID, error)
}

type EmailOtpStartIntent string

const (
	EmailOtpStartSignIn             EmailOtpStartIntent = "sign-in"
	EmailOtpStartLinkCurrentAccount EmailOtpStartIntent = "link-current-account"
)

type EmailOtpStartResult struct {
	Accepted    bool
	ChallengeID EmailOtpChallengeID
	Error       string
}

func StartEmailOtp(ctx context.Context, input struct {
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
}) EmailOtpStartResult {
	failure := EmailOtpStartResult{Error: "authentication-unavailable"}
	if input.Secrets == nil {
		return failure
	}
	rawChallengeID, err := input.Secrets.CreateChallengeID(ctx)
	if err != nil {
		return failure
	}
	challengeID, err := ParseEmailOtpChallengeID(rawChallengeID)
	if err != nil {
		return failure
	}
	accepted := EmailOtpStartResult{Accepted: true, ChallengeID: challengeID}
	if input.Clock == nil || input.Hasher == nil || input.Challenges == nil || input.AbuseKeys == nil ||
		input.RateLimits == nil || input.Delivery == nil || input.TrustedNetworkScope == "" {
		return accepted
	}
	address, err := ParseEmailOtpAddress(input.Address)
	if err != nil {
		return accepted
	}
	now := input.Clock.NowEpochSeconds()
	if !validTimestamp(now) {
		return accepted
	}
	purpose, accountID, ok := emailOtpPurposeFromStart(input.Intent, input.VaultContext)
	if !ok || (purpose.Kind == EmailOtpPurposeLink && input.SignupTermsConsent != nil) ||
		(input.SignupTermsConsent != nil && !input.SignupTermsConsent.Valid()) {
		return accepted
	}
	keys, err := input.AbuseKeys.DeriveKeys(ctx, address, input.TrustedNetworkScope, accountID)
	if err != nil || !keys.Valid(purpose.Kind == EmailOtpPurposeLink) {
		return accepted
	}
	reserved, err := input.RateLimits.Reserve(ctx, keys, now)
	if err != nil || !reserved {
		return accepted
	}
	rawCode, err := input.Secrets.CreateCode(ctx)
	if err != nil {
		return accepted
	}
	rawSalt, err := input.Secrets.CreateSalt(ctx)
	if err != nil {
		return accepted
	}
	code, err := ParseEmailOtpCode(rawCode)
	if err != nil {
		return accepted
	}
	salt, err := ParseEmailOtpSalt(rawSalt)
	if err != nil {
		return accepted
	}
	rawDigest, err := input.Hasher.CreateDigest(ctx, EmailOtpHashInput{
		ChallengeID: challengeID, Address: address, Code: code, Salt: salt,
	})
	if err != nil {
		return accepted
	}
	digest, err := ParseEmailOtpDigest(rawDigest)
	if err != nil {
		return accepted
	}
	decision := CreateEmailOtpChallenge(EmailOtpChallenge{
		ChallengeID: challengeID, Address: address, Digest: digest, Salt: salt,
		Purpose: purpose, SignupTermsConsent: input.SignupTermsConsent, CreatedAtEpochSeconds: now,
	})
	if !decision.Created {
		return accepted
	}
	if err := input.Challenges.InsertPending(ctx, decision.Challenge); err != nil {
		return accepted
	}
	if err := input.Delivery.SendOtp(ctx, EmailOtpDeliveryInput{
		ChallengeID: challengeID, Address: address, Code: code, ExpiresAt: decision.Challenge.ExpiresAtEpochSeconds,
	}); err != nil {
		if invalidated, valid := InvalidateEmailOtpDelivery(decision.Challenge, now); valid {
			_, _ = input.Challenges.CompareAndSwap(ctx, challengeID, decision.Challenge.Version, invalidated)
		}
	}
	return accepted
}

func emailOtpPurposeFromStart(intent EmailOtpStartIntent, vaultContext *VaultContext) (EmailOtpPurpose, *AccountID, bool) {
	switch intent {
	case EmailOtpStartSignIn:
		return EmailOtpPurpose{Kind: EmailOtpPurposeSignIn}, nil, true
	case EmailOtpStartLinkCurrentAccount:
		if vaultContext == nil || !validOidcVaultContext(*vaultContext) {
			return EmailOtpPurpose{}, nil, false
		}
		accountID := vaultContext.AccountID
		return EmailOtpPurpose{Kind: EmailOtpPurposeLink, AccountID: accountID}, &accountID, true
	default:
		return EmailOtpPurpose{}, nil, false
	}
}

type EmailOtpCompletionKind string

const (
	EmailOtpCompletionResolved EmailOtpCompletionKind = "resolved"
	EmailOtpCompletionAdmitted EmailOtpCompletionKind = "admitted"
	EmailOtpCompletionFailed   EmailOtpCompletionKind = "failed"
)

type EmailOtpCompletionResult struct {
	Kind       EmailOtpCompletionKind
	Error      string
	Resolution EmailOtpIdentityResolution
	Admission  SignupAdmissionReceipt
}

func CompleteEmailOtp(ctx context.Context, input struct {
	ChallengeID string
	Code        string
	Clock       EmailOtpClock
	Hasher      EmailOtpHasherPort
	Challenges  EmailOtpChallengeStore
	Identities  EmailOtpIdentityDirectory
	Signup      SignupAdmissionPort
}) EmailOtpCompletionResult {
	failure := EmailOtpCompletionResult{Kind: EmailOtpCompletionFailed, Error: "verification-failed"}
	if input.Clock == nil || input.Hasher == nil || input.Challenges == nil || input.Identities == nil {
		return failure
	}
	challengeID, err := ParseEmailOtpChallengeID(input.ChallengeID)
	if err != nil {
		return failure
	}
	code, err := ParseEmailOtpCode(input.Code)
	if err != nil {
		return failure
	}
	now := input.Clock.NowEpochSeconds()
	if !validTimestamp(now) {
		return failure
	}
	challenge, err := input.Challenges.FindByID(ctx, challengeID)
	if err != nil || challenge == nil || !ValidEmailOtpChallenge(*challenge) || challenge.Kind != EmailOtpPending {
		return failure
	}
	matches, err := input.Hasher.MatchesDigest(ctx, EmailOtpHashInput{
		ChallengeID: challenge.ChallengeID, Address: challenge.Address,
		Code: code, Salt: challenge.Salt,
	}, challenge.Digest)
	if err != nil {
		return failure
	}
	decision := VerifyEmailOtpChallenge(*challenge, matches, now)
	if decision.Changed {
		swapped, swapErr := input.Challenges.CompareAndSwap(ctx, challenge.ChallengeID, challenge.Version, decision.Challenge)
		if swapErr != nil || !swapped {
			return failure
		}
	}
	if !decision.Verified {
		return failure
	}
	existingIdentity, err := input.Identities.FindByAddress(ctx, challenge.Address)
	if err != nil || (existingIdentity != nil && !existingIdentity.Valid()) {
		return failure
	}
	verifiedEmailOwner, err := input.Identities.FindAccountIDByVerifiedEmail(ctx, challenge.Address.Verified())
	if err != nil || (verifiedEmailOwner != nil && !validAccountID(*verifiedEmailOwner)) {
		return failure
	}
	resolution := DecideEmailOtpIdentityResolution(struct {
		Purpose                     EmailOtpPurpose
		Address                     EmailOtpAddress
		ExistingIdentity            *EmailOtpIdentityRecord
		VerifiedEmailOwnerAccountID *AccountID
	}{
		Purpose: challenge.Purpose, Address: challenge.Address,
		ExistingIdentity: existingIdentity, VerifiedEmailOwnerAccountID: verifiedEmailOwner,
	})
	if resolution.Kind == EmailOtpIdentityRejected {
		return failure
	}
	if resolution.Kind == EmailOtpProvisionAccount {
		if challenge.SignupTermsConsent == nil || input.Signup == nil {
			return failure
		}
		verifiedIdentity := VerifiedSignupIdentity{
			Kind: SignupIdentityEmailOtp, Address: resolution.Address,
		}
		admission, admitErr := input.Signup.Admit(ctx, verifiedIdentity, *challenge.SignupTermsConsent)
		if admitErr != nil || !admission.Admitted ||
			!signupAdmissionMatchesRequest(admission.Receipt, verifiedIdentity, *challenge.SignupTermsConsent) {
			return failure
		}
		return EmailOtpCompletionResult{Kind: EmailOtpCompletionAdmitted, Admission: admission.Receipt}
	}
	return EmailOtpCompletionResult{Kind: EmailOtpCompletionResolved, Resolution: resolution}
}

type EmailOtpResendResult struct {
	Accepted bool
}

func ResendEmailOtp(ctx context.Context, input struct {
	ChallengeID         string
	TrustedNetworkScope string
	Clock               EmailOtpClock
	Secrets             EmailOtpSecretPort
	Hasher              EmailOtpHasherPort
	Challenges          EmailOtpChallengeStore
	AbuseKeys           EmailOtpAbuseKeyPort
	RateLimits          EmailOtpRateLimitPort
	Delivery            EmailOtpDeliveryPort
}) EmailOtpResendResult {
	accepted := EmailOtpResendResult{Accepted: true}
	if input.Clock == nil || input.Secrets == nil || input.Hasher == nil || input.Challenges == nil ||
		input.AbuseKeys == nil || input.RateLimits == nil || input.Delivery == nil || input.TrustedNetworkScope == "" {
		return accepted
	}
	challengeID, err := ParseEmailOtpChallengeID(input.ChallengeID)
	if err != nil {
		return accepted
	}
	now := input.Clock.NowEpochSeconds()
	if !validTimestamp(now) {
		return accepted
	}
	challenge, err := input.Challenges.FindByID(ctx, challengeID)
	if err != nil || challenge == nil || !ValidEmailOtpChallenge(*challenge) || challenge.Kind != EmailOtpPending {
		return accepted
	}
	var accountID *AccountID
	if challenge.Purpose.Kind == EmailOtpPurposeLink {
		value := challenge.Purpose.AccountID
		accountID = &value
	}
	keys, err := input.AbuseKeys.DeriveKeys(ctx, challenge.Address, input.TrustedNetworkScope, accountID)
	if err != nil || !keys.Valid(accountID != nil) {
		return accepted
	}
	reserved, err := input.RateLimits.Reserve(ctx, keys, now)
	if err != nil || !reserved {
		return accepted
	}
	rawCode, err := input.Secrets.CreateCode(ctx)
	if err != nil {
		return accepted
	}
	rawSalt, err := input.Secrets.CreateSalt(ctx)
	if err != nil {
		return accepted
	}
	code, err := ParseEmailOtpCode(rawCode)
	if err != nil {
		return accepted
	}
	salt, err := ParseEmailOtpSalt(rawSalt)
	if err != nil {
		return accepted
	}
	rawDigest, err := input.Hasher.CreateDigest(ctx, EmailOtpHashInput{
		ChallengeID: challenge.ChallengeID, Address: challenge.Address, Code: code, Salt: salt,
	})
	if err != nil {
		return accepted
	}
	digest, err := ParseEmailOtpDigest(rawDigest)
	if err != nil {
		return accepted
	}
	decision := ResendEmailOtpChallenge(*challenge, digest, salt, now)
	if decision.Changed {
		swapped, swapErr := input.Challenges.CompareAndSwap(ctx, challenge.ChallengeID, challenge.Version, decision.Challenge)
		if swapErr != nil || !swapped {
			return accepted
		}
	}
	if !decision.Resent {
		return accepted
	}
	if err := input.Delivery.SendOtp(ctx, EmailOtpDeliveryInput{
		ChallengeID: challenge.ChallengeID, Address: challenge.Address,
		Code: code, ExpiresAt: decision.Challenge.ExpiresAtEpochSeconds,
	}); err != nil {
		if invalidated, valid := InvalidateEmailOtpDelivery(decision.Challenge, now); valid {
			_, _ = input.Challenges.CompareAndSwap(ctx, challenge.ChallengeID, decision.Challenge.Version, invalidated)
		}
	}
	return accepted
}

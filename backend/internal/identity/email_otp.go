package identity

import (
	"errors"
	"strings"
)

const (
	EmailOtpTTLSeconds             = int64(600)
	EmailOtpResendIntervalSeconds  = int64(60)
	EmailOtpMaximumFailedAttempts  = int64(5)
	EmailOtpMaximumSends           = int64(3)
	EmailOtpRateLimitWindowSeconds = int64(3_600)
)

var ErrInvalidEmailOtpValue = errors.New("invalid Email OTP value")

type EmailOtpChallengeID string
type EmailOtpAddress string
type VerifiedEmailAddress string
type EmailOtpCode string
type EmailOtpSalt string
type EmailOtpDigest string
type EmailOtpRateLimitKey string

func ParseEmailOtpChallengeID(value string) (EmailOtpChallengeID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidEmailOtpValue
	}
	return EmailOtpChallengeID(value), nil
}

func ParseEmailOtpAddress(value string) (EmailOtpAddress, error) {
	canonical, ok := canonicalEmailAddress(value, 254, true)
	if !ok {
		return "", ErrInvalidEmailOtpValue
	}
	return EmailOtpAddress(canonical), nil
}

// ParseVerifiedEmailAddress provides the provider-neutral collision key. Only
// the domain is folded because local-part case and provider aliases are not
// equivalent without provider-specific proof.
func ParseVerifiedEmailAddress(value string) (VerifiedEmailAddress, error) {
	canonical, ok := canonicalEmailAddress(value, 320, false)
	if !ok {
		return "", ErrInvalidEmailOtpValue
	}
	return VerifiedEmailAddress(canonical), nil
}

func canonicalEmailAddress(value string, maximumLength int, strict bool) (string, bool) {
	if len(value) < 3 || len(value) > maximumLength || !visibleASCIIPattern.MatchString(value) ||
		strings.Count(value, "@") != 1 {
		return "", false
	}
	separator := strings.LastIndexByte(value, '@')
	if separator <= 0 || separator == len(value)-1 {
		return "", false
	}
	local := value[:separator]
	domain := value[separator+1:]
	if strict && !validStrictEmailParts(local, domain) {
		return "", false
	}
	return local + "@" + strings.ToLower(domain), true
}

func validStrictEmailParts(local string, domain string) bool {
	if len(local) > 64 || len(domain) > 253 || strings.HasPrefix(local, ".") ||
		strings.HasSuffix(local, ".") || strings.Contains(local, "..") {
		return false
	}
	for _, character := range local {
		if !strings.ContainsRune("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?^_`{|}~-", character) {
			return false
		}
	}
	for _, label := range strings.Split(domain, ".") {
		if len(label) < 1 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, character := range label {
			if !(character >= 'A' && character <= 'Z') && !(character >= 'a' && character <= 'z') &&
				!(character >= '0' && character <= '9') && character != '-' {
				return false
			}
		}
	}
	return true
}

func (address EmailOtpAddress) Verified() VerifiedEmailAddress {
	return VerifiedEmailAddress(address)
}

func ParseEmailOtpCode(value string) (EmailOtpCode, error) {
	if len(value) != 8 {
		return "", ErrInvalidEmailOtpValue
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return "", ErrInvalidEmailOtpValue
		}
	}
	return EmailOtpCode(value), nil
}

func ParseEmailOtpSalt(value string) (EmailOtpSalt, error) {
	if !oidcSecretPattern.MatchString(value) {
		return "", ErrInvalidEmailOtpValue
	}
	return EmailOtpSalt(value), nil
}

func ParseEmailOtpDigest(value string) (EmailOtpDigest, error) {
	if !oidcSecretPattern.MatchString(value) {
		return "", ErrInvalidEmailOtpValue
	}
	return EmailOtpDigest(value), nil
}

func ParseEmailOtpRateLimitKey(value string) (EmailOtpRateLimitKey, error) {
	if !oidcSecretPattern.MatchString(value) {
		return "", ErrInvalidEmailOtpValue
	}
	return EmailOtpRateLimitKey(value), nil
}

type EmailOtpPurposeKind string

const (
	EmailOtpPurposeSignIn EmailOtpPurposeKind = "sign-in"
	EmailOtpPurposeLink   EmailOtpPurposeKind = "link"
)

type EmailOtpPurpose struct {
	Kind      EmailOtpPurposeKind
	AccountID AccountID
}

func (purpose EmailOtpPurpose) Valid() bool {
	switch purpose.Kind {
	case EmailOtpPurposeSignIn:
		return purpose.AccountID == ""
	case EmailOtpPurposeLink:
		_, err := ParseAccountID(string(purpose.AccountID))
		return err == nil
	default:
		return false
	}
}

type EmailOtpChallengeKind string
type EmailOtpInvalidationReason string

const (
	EmailOtpPending     EmailOtpChallengeKind = "pending"
	EmailOtpConsumed    EmailOtpChallengeKind = "consumed"
	EmailOtpLocked      EmailOtpChallengeKind = "locked"
	EmailOtpInvalidated EmailOtpChallengeKind = "invalidated"

	EmailOtpDeliveryFailed EmailOtpInvalidationReason = "delivery-failed"
	EmailOtpExpired        EmailOtpInvalidationReason = "expired"
	EmailOtpSuperseded     EmailOtpInvalidationReason = "superseded"
)

type EmailOtpChallenge struct {
	Kind                   EmailOtpChallengeKind
	ChallengeID            EmailOtpChallengeID
	Address                EmailOtpAddress
	Digest                 EmailOtpDigest
	Salt                   EmailOtpSalt
	Purpose                EmailOtpPurpose
	SignupTermsConsent     *SignupTermsConsent
	CreatedAtEpochSeconds  int64
	ExpiresAtEpochSeconds  int64
	FailedAttempts         int64
	SendCount              int64
	LastSentAtEpochSeconds int64
	Version                int64
	TerminalAtEpochSeconds int64
	InvalidationReason     EmailOtpInvalidationReason
}

func ValidEmailOtpChallenge(challenge EmailOtpChallenge) bool {
	if _, err := ParseEmailOtpChallengeID(string(challenge.ChallengeID)); err != nil {
		return false
	}
	if _, err := ParseEmailOtpAddress(string(challenge.Address)); err != nil {
		return false
	}
	if _, err := ParseEmailOtpDigest(string(challenge.Digest)); err != nil {
		return false
	}
	if _, err := ParseEmailOtpSalt(string(challenge.Salt)); err != nil {
		return false
	}
	if !challenge.Purpose.Valid() || !validTimestamp(challenge.CreatedAtEpochSeconds) ||
		!validTimestamp(challenge.ExpiresAtEpochSeconds) ||
		challenge.ExpiresAtEpochSeconds-challenge.CreatedAtEpochSeconds != EmailOtpTTLSeconds ||
		challenge.LastSentAtEpochSeconds < challenge.CreatedAtEpochSeconds ||
		challenge.LastSentAtEpochSeconds >= challenge.ExpiresAtEpochSeconds ||
		challenge.FailedAttempts < 0 || challenge.FailedAttempts > EmailOtpMaximumFailedAttempts ||
		challenge.SendCount < 1 || challenge.SendCount > EmailOtpMaximumSends ||
		challenge.Version < 1 || challenge.Version > MaximumSafeInteger ||
		(challenge.Purpose.Kind == EmailOtpPurposeLink && challenge.SignupTermsConsent != nil) {
		return false
	}
	if challenge.SignupTermsConsent != nil && !challenge.SignupTermsConsent.Valid() {
		return false
	}
	baseVersion := challenge.SendCount + challenge.FailedAttempts
	switch challenge.Kind {
	case EmailOtpPending:
		return challenge.FailedAttempts < EmailOtpMaximumFailedAttempts && challenge.Version == baseVersion &&
			challenge.TerminalAtEpochSeconds == 0 && challenge.InvalidationReason == ""
	case EmailOtpLocked:
		return challenge.FailedAttempts == EmailOtpMaximumFailedAttempts && challenge.Version == baseVersion &&
			challenge.TerminalAtEpochSeconds >= challenge.LastSentAtEpochSeconds &&
			challenge.TerminalAtEpochSeconds < challenge.ExpiresAtEpochSeconds && challenge.InvalidationReason == ""
	case EmailOtpConsumed:
		return challenge.FailedAttempts < EmailOtpMaximumFailedAttempts && challenge.Version == baseVersion+1 &&
			challenge.TerminalAtEpochSeconds >= challenge.LastSentAtEpochSeconds &&
			challenge.TerminalAtEpochSeconds < challenge.ExpiresAtEpochSeconds && challenge.InvalidationReason == ""
	case EmailOtpInvalidated:
		if challenge.FailedAttempts >= EmailOtpMaximumFailedAttempts || challenge.Version != baseVersion+1 {
			return false
		}
		switch challenge.InvalidationReason {
		case EmailOtpExpired:
			return challenge.TerminalAtEpochSeconds >= challenge.ExpiresAtEpochSeconds
		case EmailOtpDeliveryFailed, EmailOtpSuperseded:
			return challenge.TerminalAtEpochSeconds >= challenge.LastSentAtEpochSeconds &&
				challenge.TerminalAtEpochSeconds < challenge.ExpiresAtEpochSeconds
		default:
			return false
		}
	default:
		return false
	}
}

type CreateEmailOtpChallengeReason string

const (
	CreateEmailOtpInvalidClock   CreateEmailOtpChallengeReason = "invalid-clock"
	CreateEmailOtpInvalidPurpose CreateEmailOtpChallengeReason = "invalid-purpose"
	CreateEmailOtpInvalidInput   CreateEmailOtpChallengeReason = "invalid-input"
)

type CreateEmailOtpChallengeDecision struct {
	Created   bool
	Reason    CreateEmailOtpChallengeReason
	Challenge EmailOtpChallenge
}

func CreateEmailOtpChallenge(input EmailOtpChallenge) CreateEmailOtpChallengeDecision {
	if !validTimestamp(input.CreatedAtEpochSeconds) ||
		input.CreatedAtEpochSeconds > MaximumSafeInteger-EmailOtpTTLSeconds {
		return CreateEmailOtpChallengeDecision{Reason: CreateEmailOtpInvalidClock}
	}
	if !input.Purpose.Valid() || (input.Purpose.Kind == EmailOtpPurposeLink && input.SignupTermsConsent != nil) {
		return CreateEmailOtpChallengeDecision{Reason: CreateEmailOtpInvalidPurpose}
	}
	input.Kind = EmailOtpPending
	input.ExpiresAtEpochSeconds = input.CreatedAtEpochSeconds + EmailOtpTTLSeconds
	input.FailedAttempts = 0
	input.SendCount = 1
	input.LastSentAtEpochSeconds = input.CreatedAtEpochSeconds
	input.Version = 1
	input.TerminalAtEpochSeconds = 0
	input.InvalidationReason = ""
	if input.SignupTermsConsent != nil {
		consent := *input.SignupTermsConsent
		input.SignupTermsConsent = &consent
	}
	if !ValidEmailOtpChallenge(input) {
		return CreateEmailOtpChallengeDecision{Reason: CreateEmailOtpInvalidInput}
	}
	return CreateEmailOtpChallengeDecision{Created: true, Challenge: input}
}

type VerifyEmailOtpChallengeReason string

const (
	VerifyEmailOtpInvalidClock VerifyEmailOtpChallengeReason = "invalid-clock"
	VerifyEmailOtpExpired      VerifyEmailOtpChallengeReason = "expired"
	VerifyEmailOtpIncorrect    VerifyEmailOtpChallengeReason = "incorrect-code"
	VerifyEmailOtpNotPending   VerifyEmailOtpChallengeReason = "not-pending"
)

type VerifyEmailOtpChallengeDecision struct {
	Verified  bool
	Reason    VerifyEmailOtpChallengeReason
	Changed   bool
	Challenge EmailOtpChallenge
}

func VerifyEmailOtpChallenge(challenge EmailOtpChallenge, digestMatches bool, now int64) VerifyEmailOtpChallengeDecision {
	if !validTimestamp(now) || now > MaximumSafeInteger-1 {
		return VerifyEmailOtpChallengeDecision{Reason: VerifyEmailOtpInvalidClock}
	}
	if !ValidEmailOtpChallenge(challenge) || challenge.Kind != EmailOtpPending {
		return VerifyEmailOtpChallengeDecision{Reason: VerifyEmailOtpNotPending}
	}
	if now < challenge.CreatedAtEpochSeconds {
		return VerifyEmailOtpChallengeDecision{Reason: VerifyEmailOtpInvalidClock}
	}
	if now >= challenge.ExpiresAtEpochSeconds {
		challenge.Kind = EmailOtpInvalidated
		challenge.TerminalAtEpochSeconds = now
		challenge.InvalidationReason = EmailOtpExpired
		challenge.Version++
		return VerifyEmailOtpChallengeDecision{Reason: VerifyEmailOtpExpired, Changed: true, Challenge: challenge}
	}
	if digestMatches {
		challenge.Kind = EmailOtpConsumed
		challenge.TerminalAtEpochSeconds = now
		challenge.Version++
		return VerifyEmailOtpChallengeDecision{Verified: true, Changed: true, Challenge: challenge}
	}
	challenge.FailedAttempts++
	challenge.Version++
	if challenge.FailedAttempts >= EmailOtpMaximumFailedAttempts {
		challenge.Kind = EmailOtpLocked
		challenge.TerminalAtEpochSeconds = now
	}
	return VerifyEmailOtpChallengeDecision{Reason: VerifyEmailOtpIncorrect, Changed: true, Challenge: challenge}
}

type ResendEmailOtpChallengeReason string

const (
	ResendEmailOtpInvalidClock ResendEmailOtpChallengeReason = "invalid-clock"
	ResendEmailOtpNotPending   ResendEmailOtpChallengeReason = "not-pending"
	ResendEmailOtpExpired      ResendEmailOtpChallengeReason = "expired"
	ResendEmailOtpTooSoon      ResendEmailOtpChallengeReason = "too-soon"
	ResendEmailOtpSendLimit    ResendEmailOtpChallengeReason = "send-limit"
	ResendEmailOtpInvalidInput ResendEmailOtpChallengeReason = "invalid-input"
)

type ResendEmailOtpChallengeDecision struct {
	Resent    bool
	Reason    ResendEmailOtpChallengeReason
	Changed   bool
	Challenge EmailOtpChallenge
}

func ResendEmailOtpChallenge(challenge EmailOtpChallenge, digest EmailOtpDigest, salt EmailOtpSalt, now int64) ResendEmailOtpChallengeDecision {
	if !validTimestamp(now) || now > MaximumSafeInteger-1 {
		return ResendEmailOtpChallengeDecision{Reason: ResendEmailOtpInvalidClock}
	}
	if !ValidEmailOtpChallenge(challenge) || challenge.Kind != EmailOtpPending {
		return ResendEmailOtpChallengeDecision{Reason: ResendEmailOtpNotPending}
	}
	if _, err := ParseEmailOtpDigest(string(digest)); err != nil {
		return ResendEmailOtpChallengeDecision{Reason: ResendEmailOtpInvalidInput}
	}
	if _, err := ParseEmailOtpSalt(string(salt)); err != nil {
		return ResendEmailOtpChallengeDecision{Reason: ResendEmailOtpInvalidInput}
	}
	if now < challenge.CreatedAtEpochSeconds {
		return ResendEmailOtpChallengeDecision{Reason: ResendEmailOtpInvalidClock}
	}
	if now >= challenge.ExpiresAtEpochSeconds {
		challenge.Kind = EmailOtpInvalidated
		challenge.TerminalAtEpochSeconds = now
		challenge.InvalidationReason = EmailOtpExpired
		challenge.Version++
		return ResendEmailOtpChallengeDecision{Reason: ResendEmailOtpExpired, Changed: true, Challenge: challenge}
	}
	if now-challenge.LastSentAtEpochSeconds < EmailOtpResendIntervalSeconds {
		return ResendEmailOtpChallengeDecision{Reason: ResendEmailOtpTooSoon}
	}
	if challenge.SendCount >= EmailOtpMaximumSends {
		return ResendEmailOtpChallengeDecision{Reason: ResendEmailOtpSendLimit}
	}
	challenge.Digest = digest
	challenge.Salt = salt
	challenge.SendCount++
	challenge.LastSentAtEpochSeconds = now
	challenge.Version++
	return ResendEmailOtpChallengeDecision{Resent: true, Changed: true, Challenge: challenge}
}

func InvalidateEmailOtpDelivery(challenge EmailOtpChallenge, now int64) (EmailOtpChallenge, bool) {
	if !ValidEmailOtpChallenge(challenge) || challenge.Kind != EmailOtpPending || !validTimestamp(now) ||
		now < challenge.CreatedAtEpochSeconds || now >= challenge.ExpiresAtEpochSeconds ||
		challenge.Version >= MaximumSafeInteger {
		return EmailOtpChallenge{}, false
	}
	challenge.Kind = EmailOtpInvalidated
	challenge.TerminalAtEpochSeconds = now
	challenge.InvalidationReason = EmailOtpDeliveryFailed
	challenge.Version++
	return challenge, true
}

type EmailOtpRateLimitBucket struct {
	Key                         EmailOtpRateLimitKey
	Count                       int64
	WindowStartedAtEpochSeconds int64
}

type EmailOtpRateLimitState struct {
	Address EmailOtpRateLimitBucket
	Network EmailOtpRateLimitBucket
	Account *EmailOtpRateLimitBucket
}

type ReserveEmailOtpRateLimitDecision struct {
	Reserved bool
	Reason   string
	State    EmailOtpRateLimitState
}

func ReserveEmailOtpRateLimit(state EmailOtpRateLimitState, now int64) ReserveEmailOtpRateLimitDecision {
	if !validTimestamp(now) || !validRateLimitBucket(state.Address) || !validRateLimitBucket(state.Network) ||
		(state.Account != nil && !validRateLimitBucket(*state.Account)) ||
		state.Address.WindowStartedAtEpochSeconds > now || state.Network.WindowStartedAtEpochSeconds > now ||
		(state.Account != nil && state.Account.WindowStartedAtEpochSeconds > now) {
		return ReserveEmailOtpRateLimitDecision{Reason: "invalid-clock"}
	}
	state.Address = normalizeEmailOtpBucket(state.Address, now)
	state.Network = normalizeEmailOtpBucket(state.Network, now)
	if state.Account != nil {
		account := normalizeEmailOtpBucket(*state.Account, now)
		state.Account = &account
	}
	if state.Address.Count >= 5 || state.Network.Count >= 30 || (state.Account != nil && state.Account.Count >= 5) {
		return ReserveEmailOtpRateLimitDecision{Reason: "limited"}
	}
	state.Address.Count++
	state.Network.Count++
	if state.Account != nil {
		state.Account.Count++
	}
	return ReserveEmailOtpRateLimitDecision{Reserved: true, State: state}
}

func validRateLimitBucket(bucket EmailOtpRateLimitBucket) bool {
	_, err := ParseEmailOtpRateLimitKey(string(bucket.Key))
	return err == nil && bucket.Count >= 0 && bucket.Count <= 1_000_000 && validTimestamp(bucket.WindowStartedAtEpochSeconds)
}

func normalizeEmailOtpBucket(bucket EmailOtpRateLimitBucket, now int64) EmailOtpRateLimitBucket {
	if now-bucket.WindowStartedAtEpochSeconds >= EmailOtpRateLimitWindowSeconds {
		bucket.Count = 0
		bucket.WindowStartedAtEpochSeconds = now
	}
	return bucket
}

type EmailOtpIdentityRecord struct {
	IdentityID IdentityID
	AccountID  AccountID
	VaultID    VaultID
	Address    EmailOtpAddress
}

func (record EmailOtpIdentityRecord) Valid() bool {
	_, identityErr := ParseIdentityID(string(record.IdentityID))
	_, accountErr := ParseAccountID(string(record.AccountID))
	_, vaultErr := ParseVaultID(string(record.VaultID))
	_, addressErr := ParseEmailOtpAddress(string(record.Address))
	return identityErr == nil && accountErr == nil && vaultErr == nil && addressErr == nil
}

type EmailOtpIdentityResolutionKind string
type EmailOtpIdentityResolutionReason string

const (
	EmailOtpAuthenticateExisting EmailOtpIdentityResolutionKind = "authenticate-existing"
	EmailOtpProvisionAccount     EmailOtpIdentityResolutionKind = "provision-account"
	EmailOtpLinkIdentity         EmailOtpIdentityResolutionKind = "link-identity"
	EmailOtpAlreadyLinked        EmailOtpIdentityResolutionKind = "already-linked"
	EmailOtpIdentityRejected     EmailOtpIdentityResolutionKind = "rejected"

	EmailOtpIdentityRecordMismatch EmailOtpIdentityResolutionReason = "identity-record-mismatch"
	EmailOtpIdentityOwnedElsewhere EmailOtpIdentityResolutionReason = "identity-owned-by-another-account"
	EmailOtpIdentityEmailCollision EmailOtpIdentityResolutionReason = "email-collision"
)

type EmailOtpIdentityResolution struct {
	Kind      EmailOtpIdentityResolutionKind
	Reason    EmailOtpIdentityResolutionReason
	Identity  *EmailOtpIdentityRecord
	AccountID AccountID
	Address   EmailOtpAddress
}

func DecideEmailOtpIdentityResolution(input struct {
	Purpose                     EmailOtpPurpose
	Address                     EmailOtpAddress
	ExistingIdentity            *EmailOtpIdentityRecord
	VerifiedEmailOwnerAccountID *AccountID
}) EmailOtpIdentityResolution {
	if input.ExistingIdentity != nil && input.ExistingIdentity.Address != input.Address {
		return EmailOtpIdentityResolution{Kind: EmailOtpIdentityRejected, Reason: EmailOtpIdentityRecordMismatch}
	}
	if input.Purpose.Kind == EmailOtpPurposeSignIn {
		if input.ExistingIdentity != nil {
			return EmailOtpIdentityResolution{Kind: EmailOtpAuthenticateExisting, Identity: input.ExistingIdentity}
		}
		if input.VerifiedEmailOwnerAccountID != nil {
			return EmailOtpIdentityResolution{Kind: EmailOtpIdentityRejected, Reason: EmailOtpIdentityEmailCollision}
		}
		return EmailOtpIdentityResolution{Kind: EmailOtpProvisionAccount, Address: input.Address}
	}
	if input.ExistingIdentity != nil {
		if input.ExistingIdentity.AccountID == input.Purpose.AccountID {
			return EmailOtpIdentityResolution{Kind: EmailOtpAlreadyLinked, Identity: input.ExistingIdentity}
		}
		return EmailOtpIdentityResolution{Kind: EmailOtpIdentityRejected, Reason: EmailOtpIdentityOwnedElsewhere}
	}
	if input.VerifiedEmailOwnerAccountID != nil && *input.VerifiedEmailOwnerAccountID != input.Purpose.AccountID {
		return EmailOtpIdentityResolution{Kind: EmailOtpIdentityRejected, Reason: EmailOtpIdentityEmailCollision}
	}
	return EmailOtpIdentityResolution{Kind: EmailOtpLinkIdentity, AccountID: input.Purpose.AccountID, Address: input.Address}
}

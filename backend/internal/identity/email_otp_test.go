package identity

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

const (
	testEmailOtpChallengeID = "01991f20-61d2-7000-8000-000000000501"
	testEmailOtpAddress     = "Person@example.com"
	testEmailOtpSecret      = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	testEmailOtpOtherSecret = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBE"
)

func TestEmailOtpValueParsersAndNormalization(t *testing.T) {
	address, err := ParseEmailOtpAddress("Person@Example.COM")
	if err != nil || address != testEmailOtpAddress {
		t.Fatalf("ParseEmailOtpAddress() = %q, %v", address, err)
	}
	verified, err := ParseVerifiedEmailAddress("Person@Example.COM")
	if err != nil || verified != VerifiedEmailAddress(testEmailOtpAddress) {
		t.Fatalf("ParseVerifiedEmailAddress() = %q, %v", verified, err)
	}
	oidcEmail, err := ParseOidcEmailAddress("Person@Example.COM")
	if err != nil || oidcEmail.Verified() != verified {
		t.Fatalf("ParseOidcEmailAddress() = %q, %v", oidcEmail, err)
	}
	for _, candidate := range []string{
		"person..x@example.com", ".person@example.com", "person@example.com ",
		"person@-example.com", "person@example..com", "person@example.com@evil.test",
	} {
		if _, err := ParseEmailOtpAddress(candidate); err == nil {
			t.Errorf("ParseEmailOtpAddress(%q) succeeded", candidate)
		}
	}
	if _, err := ParseEmailOtpCode("12345678"); err != nil {
		t.Fatalf("ParseEmailOtpCode() error = %v", err)
	}
	for _, candidate := range []string{"1234567", "123456789", "1234abcd"} {
		if _, err := ParseEmailOtpCode(candidate); err == nil {
			t.Errorf("ParseEmailOtpCode(%q) succeeded", candidate)
		}
	}
	if _, err := ParseEmailOtpChallengeID("not-a-uuid"); err == nil {
		t.Fatal("malformed challenge ID accepted")
	}
	if _, err := ParseEmailOtpDigest("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB"); err == nil {
		t.Fatal("non-canonical digest accepted")
	}
}

func TestSharedEmailOtpFixture(t *testing.T) {
	t.Parallel()
	content, err := os.ReadFile("../../../contracts/fixtures/identity/email-otp.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Profile               string `json:"profile"`
		ChallengeID           string `json:"challengeId"`
		Address               string `json:"address"`
		Code                  string `json:"code"`
		Salt                  string `json:"salt"`
		Digest                string `json:"digest"`
		CreatedAtEpochSeconds int64  `json:"createdAtEpochSeconds"`
		VerifyAtEpochSeconds  int64  `json:"verifyAtEpochSeconds"`
		ResendAtEpochSeconds  int64  `json:"resendAtEpochSeconds"`
		Expected              struct {
			CanonicalAddress      string `json:"canonicalAddress"`
			ExpiresAtEpochSeconds int64  `json:"expiresAtEpochSeconds"`
			FailedAttempts        int64  `json:"failedAttempts"`
			SendCount             int64  `json:"sendCount"`
			Version               int64  `json:"version"`
		} `json:"expected"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(content)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fixture); err != nil {
		t.Fatalf("decode shared Email OTP fixture: %v", err)
	}
	address, err := ParseEmailOtpAddress(fixture.Address)
	if err != nil {
		t.Fatal(err)
	}
	created := CreateEmailOtpChallenge(EmailOtpChallenge{
		ChallengeID: mustEmailOtpChallengeID(t, fixture.ChallengeID), Address: address,
		Digest: mustEmailOtpDigest(t, fixture.Digest), Salt: mustEmailOtpSalt(t, fixture.Salt),
		Purpose: EmailOtpPurpose{Kind: EmailOtpPurposeSignIn}, CreatedAtEpochSeconds: fixture.CreatedAtEpochSeconds,
	})
	if fixture.Profile != "email-otp-core" || !created.Created ||
		string(created.Challenge.Address) != fixture.Expected.CanonicalAddress ||
		created.Challenge.ExpiresAtEpochSeconds != fixture.Expected.ExpiresAtEpochSeconds ||
		created.Challenge.FailedAttempts != fixture.Expected.FailedAttempts ||
		created.Challenge.SendCount != fixture.Expected.SendCount || created.Challenge.Version != fixture.Expected.Version {
		t.Fatalf("shared fixture creation = %#v", created)
	}
	if _, err := ParseEmailOtpCode(fixture.Code); err != nil {
		t.Fatal(err)
	}
	verified := VerifyEmailOtpChallenge(created.Challenge, true, fixture.VerifyAtEpochSeconds)
	if !verified.Verified || verified.Challenge.Kind != EmailOtpConsumed {
		t.Fatalf("shared fixture verification = %#v", verified)
	}
	resent := ResendEmailOtpChallenge(
		created.Challenge,
		mustEmailOtpDigest(t, fixture.Digest),
		mustEmailOtpSalt(t, fixture.Salt),
		fixture.ResendAtEpochSeconds,
	)
	if !resent.Resent || resent.Challenge.ExpiresAtEpochSeconds != fixture.Expected.ExpiresAtEpochSeconds ||
		resent.Challenge.FailedAttempts != fixture.Expected.FailedAttempts || resent.Challenge.SendCount != 2 {
		t.Fatalf("shared fixture resend = %#v", resent)
	}
}

func TestEmailOtpChallengeLifecycle(t *testing.T) {
	created := CreateEmailOtpChallenge(emailOtpChallengeFixture(t))
	if !created.Created || !ValidEmailOtpChallenge(created.Challenge) {
		t.Fatalf("CreateEmailOtpChallenge() = %#v", created)
	}
	if created.Challenge.ExpiresAtEpochSeconds != 1_600 || created.Challenge.Version != 1 {
		t.Fatalf("created challenge = %#v", created.Challenge)
	}
	if decision := CreateEmailOtpChallenge(EmailOtpChallenge{
		ChallengeID: emailOtpChallengeID(t), Address: emailOtpAddress(t),
		Digest: emailOtpDigest(t), Salt: emailOtpSalt(t),
		Purpose: EmailOtpPurpose{Kind: EmailOtpPurposeSignIn}, CreatedAtEpochSeconds: MaximumSafeInteger,
	}); decision.Created || decision.Reason != CreateEmailOtpInvalidClock {
		t.Fatalf("unsafe clock decision = %#v", decision)
	}

	verified := VerifyEmailOtpChallenge(created.Challenge, true, 1_500)
	if !verified.Verified || verified.Challenge.Kind != EmailOtpConsumed ||
		!ValidEmailOtpChallenge(verified.Challenge) {
		t.Fatalf("verified decision = %#v", verified)
	}
	if replay := VerifyEmailOtpChallenge(verified.Challenge, true, 1_501); replay.Verified || replay.Reason != VerifyEmailOtpNotPending {
		t.Fatalf("replay decision = %#v", replay)
	}
	expired := VerifyEmailOtpChallenge(created.Challenge, true, 1_600)
	if !expired.Changed || expired.Reason != VerifyEmailOtpExpired ||
		expired.Challenge.InvalidationReason != EmailOtpExpired || !ValidEmailOtpChallenge(expired.Challenge) {
		t.Fatalf("expired decision = %#v", expired)
	}
}

func TestEmailOtpLocksAfterFiveFailures(t *testing.T) {
	challenge := CreateEmailOtpChallenge(emailOtpChallengeFixture(t)).Challenge
	for attempt := int64(1); attempt <= EmailOtpMaximumFailedAttempts; attempt++ {
		decision := VerifyEmailOtpChallenge(challenge, false, 1_000+attempt)
		if decision.Verified || !decision.Changed || decision.Challenge.FailedAttempts != attempt {
			t.Fatalf("attempt %d = %#v", attempt, decision)
		}
		challenge = decision.Challenge
	}
	if challenge.Kind != EmailOtpLocked || !ValidEmailOtpChallenge(challenge) {
		t.Fatalf("locked challenge = %#v", challenge)
	}
	if decision := VerifyEmailOtpChallenge(challenge, true, 1_100); decision.Verified || decision.Reason != VerifyEmailOtpNotPending {
		t.Fatalf("post-lock decision = %#v", decision)
	}
}

func TestEmailOtpResendPreservesFailuresAndExpiry(t *testing.T) {
	challenge := CreateEmailOtpChallenge(emailOtpChallengeFixture(t)).Challenge
	failed := VerifyEmailOtpChallenge(challenge, false, 1_001)
	challenge = failed.Challenge
	tooSoon := ResendEmailOtpChallenge(challenge, emailOtpOtherDigest(t), emailOtpOtherSalt(t), 1_059)
	if tooSoon.Resent || tooSoon.Reason != ResendEmailOtpTooSoon {
		t.Fatalf("too-soon decision = %#v", tooSoon)
	}
	resent := ResendEmailOtpChallenge(challenge, emailOtpOtherDigest(t), emailOtpOtherSalt(t), 1_060)
	if !resent.Resent || resent.Challenge.FailedAttempts != 1 || resent.Challenge.SendCount != 2 ||
		resent.Challenge.ExpiresAtEpochSeconds != 1_600 || resent.Challenge.Version != 3 ||
		!ValidEmailOtpChallenge(resent.Challenge) {
		t.Fatalf("resent decision = %#v", resent)
	}
	third := ResendEmailOtpChallenge(resent.Challenge, emailOtpDigest(t), emailOtpSalt(t), 1_120)
	if !third.Resent {
		t.Fatalf("third send = %#v", third)
	}
	limited := ResendEmailOtpChallenge(third.Challenge, emailOtpOtherDigest(t), emailOtpOtherSalt(t), 1_180)
	if limited.Resent || limited.Reason != ResendEmailOtpSendLimit {
		t.Fatalf("send-limit decision = %#v", limited)
	}
	if third.Challenge.FailedAttempts != 1 || third.Challenge.ExpiresAtEpochSeconds != 1_600 {
		t.Fatalf("resend reset protection = %#v", third.Challenge)
	}
}

func TestEmailOtpDeliveryInvalidation(t *testing.T) {
	challenge := CreateEmailOtpChallenge(emailOtpChallengeFixture(t)).Challenge
	invalidated, ok := InvalidateEmailOtpDelivery(challenge, 1_001)
	if !ok || invalidated.Kind != EmailOtpInvalidated || invalidated.InvalidationReason != EmailOtpDeliveryFailed ||
		!ValidEmailOtpChallenge(invalidated) {
		t.Fatalf("InvalidateEmailOtpDelivery() = %#v, %t", invalidated, ok)
	}
	if _, ok := InvalidateEmailOtpDelivery(challenge, 1_600); ok {
		t.Fatal("delivery failure after expiry was accepted")
	}
}

func TestEmailOtpRateLimitPolicy(t *testing.T) {
	state := EmailOtpRateLimitState{
		Address: emailOtpBucket(t, 4, 1_000, 'A'),
		Network: emailOtpBucket(t, 4, 1_000, 'B'),
	}
	reserved := ReserveEmailOtpRateLimit(state, 1_100)
	if !reserved.Reserved || reserved.State.Address.Count != 5 || reserved.State.Network.Count != 5 {
		t.Fatalf("reserve decision = %#v", reserved)
	}
	state.Address.Count = 5
	if limited := ReserveEmailOtpRateLimit(state, 1_100); limited.Reserved || limited.Reason != "limited" {
		t.Fatalf("limited decision = %#v", limited)
	}
	account := emailOtpBucket(t, 5, 1_000, 'C')
	state.Account = &account
	state.Network.Count = 30
	reset := ReserveEmailOtpRateLimit(state, 1_000+EmailOtpRateLimitWindowSeconds)
	if !reset.Reserved || reset.State.Address.Count != 1 || reset.State.Network.Count != 1 ||
		reset.State.Account == nil || reset.State.Account.Count != 1 {
		t.Fatalf("reset decision = %#v", reset)
	}
	if account.Count != 5 {
		t.Fatalf("caller-owned account bucket mutated: %#v", account)
	}
}

func TestEmailOtpIdentityResolutionNeverAutoLinks(t *testing.T) {
	accountID := mustAccountID(t, "01991f20-61d2-7000-8000-000000000101")
	otherAccountID := mustAccountID(t, "01991f20-61d2-7000-8000-000000000102")
	record := EmailOtpIdentityRecord{
		IdentityID: mustIdentityID(t, "01991f20-61d2-7000-8000-000000000301"),
		AccountID:  accountID, VaultID: mustVaultID(t, "01991f20-61d2-7000-8000-000000000201"),
		Address: emailOtpAddress(t),
	}
	owner := accountID
	collision := DecideEmailOtpIdentityResolution(struct {
		Purpose                     EmailOtpPurpose
		Address                     EmailOtpAddress
		ExistingIdentity            *EmailOtpIdentityRecord
		VerifiedEmailOwnerAccountID *AccountID
	}{Purpose: EmailOtpPurpose{Kind: EmailOtpPurposeSignIn}, Address: emailOtpAddress(t), VerifiedEmailOwnerAccountID: &owner})
	if collision.Kind != EmailOtpIdentityRejected || collision.Reason != EmailOtpIdentityEmailCollision {
		t.Fatalf("collision = %#v", collision)
	}
	authenticated := DecideEmailOtpIdentityResolution(struct {
		Purpose                     EmailOtpPurpose
		Address                     EmailOtpAddress
		ExistingIdentity            *EmailOtpIdentityRecord
		VerifiedEmailOwnerAccountID *AccountID
	}{Purpose: EmailOtpPurpose{Kind: EmailOtpPurposeSignIn}, Address: emailOtpAddress(t), ExistingIdentity: &record})
	if authenticated.Kind != EmailOtpAuthenticateExisting {
		t.Fatalf("authenticated = %#v", authenticated)
	}
	wrongOwner := DecideEmailOtpIdentityResolution(struct {
		Purpose                     EmailOtpPurpose
		Address                     EmailOtpAddress
		ExistingIdentity            *EmailOtpIdentityRecord
		VerifiedEmailOwnerAccountID *AccountID
	}{Purpose: EmailOtpPurpose{Kind: EmailOtpPurposeLink, AccountID: otherAccountID}, Address: emailOtpAddress(t), ExistingIdentity: &record})
	if wrongOwner.Kind != EmailOtpIdentityRejected || wrongOwner.Reason != EmailOtpIdentityOwnedElsewhere {
		t.Fatalf("wrong owner = %#v", wrongOwner)
	}
}

func emailOtpChallengeFixture(t *testing.T) EmailOtpChallenge {
	t.Helper()
	return EmailOtpChallenge{
		ChallengeID: emailOtpChallengeID(t), Address: emailOtpAddress(t),
		Digest: emailOtpDigest(t), Salt: emailOtpSalt(t),
		Purpose: EmailOtpPurpose{Kind: EmailOtpPurposeSignIn}, CreatedAtEpochSeconds: 1_000,
	}
}

func emailOtpChallengeID(t *testing.T) EmailOtpChallengeID {
	t.Helper()
	value, err := ParseEmailOtpChallengeID(testEmailOtpChallengeID)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func mustEmailOtpChallengeID(t *testing.T, raw string) EmailOtpChallengeID {
	t.Helper()
	value, err := ParseEmailOtpChallengeID(raw)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func emailOtpAddress(t *testing.T) EmailOtpAddress {
	t.Helper()
	value, err := ParseEmailOtpAddress(testEmailOtpAddress)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func emailOtpDigest(t *testing.T) EmailOtpDigest {
	t.Helper()
	value, err := ParseEmailOtpDigest(testEmailOtpSecret)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func mustEmailOtpDigest(t *testing.T, raw string) EmailOtpDigest {
	t.Helper()
	value, err := ParseEmailOtpDigest(raw)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func emailOtpOtherDigest(t *testing.T) EmailOtpDigest {
	t.Helper()
	value, err := ParseEmailOtpDigest(testEmailOtpOtherSecret)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func emailOtpSalt(t *testing.T) EmailOtpSalt {
	t.Helper()
	value, err := ParseEmailOtpSalt(testEmailOtpSecret)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func mustEmailOtpSalt(t *testing.T, raw string) EmailOtpSalt {
	t.Helper()
	value, err := ParseEmailOtpSalt(raw)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func emailOtpOtherSalt(t *testing.T) EmailOtpSalt {
	t.Helper()
	value, err := ParseEmailOtpSalt(testEmailOtpOtherSecret)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func emailOtpBucket(t *testing.T, count int64, startedAt int64, repeated byte) EmailOtpRateLimitBucket {
	t.Helper()
	raw := string(make([]byte, 42))
	buffer := []byte(raw)
	for index := range buffer {
		buffer[index] = repeated
	}
	buffer = append(buffer, 'A')
	key, err := ParseEmailOtpRateLimitKey(string(buffer))
	if err != nil {
		t.Fatal(err)
	}
	return EmailOtpRateLimitBucket{Key: key, Count: count, WindowStartedAtEpochSeconds: startedAt}
}

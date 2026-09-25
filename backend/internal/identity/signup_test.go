package identity

import (
	"strings"
	"testing"
)

func TestSignupAdmissionPlanBindsIdentitySubmissionAndOwner(t *testing.T) {
	identity := signupGoogleFixture(t)
	reservation := signupReservationFixture(t, identity)
	evidence := SignupTermsEvidence{
		SubmissionID: reservation.SubmissionID, AccountID: reservation.AccountID,
		VaultID: reservation.VaultID, TermsConsentID: "01991f20-61d2-7000-8000-000000000601",
	}
	plan := PlanSignupAdmission(identity, reservation.SubmissionID, reservation, evidence)
	if !plan.Ready {
		t.Fatalf("PlanSignupAdmission() = %#v", plan)
	}
	receipt := SignupAdmissionReceipt{
		SubmissionID: reservation.SubmissionID, Identity: identity,
		AccountID: reservation.AccountID, VaultID: reservation.VaultID,
		IdentityID: reservation.IdentityID, SessionID: reservation.SessionID,
		SessionEpoch: reservation.SessionEpoch, TermsConsentID: evidence.TermsConsentID,
		SessionToken: mustToken(t, strings.Repeat("A", 43)),
		IssuedAt:     2_000, ExpiresAt: 2_000 + SignupSessionLifetimeSeconds,
	}
	if !SignupReceiptMatchesPlan(receipt, plan) {
		t.Fatalf("receipt did not match plan: %#v", receipt)
	}
	receipt.SessionID = mustSessionID(t, fixtureNextSessionID)
	if SignupReceiptMatchesPlan(receipt, plan) {
		t.Fatal("substituted session ID matched plan")
	}
}

func TestSignupAdmissionPlanRejectsSubstitution(t *testing.T) {
	google := signupGoogleFixture(t)
	reservation := signupReservationFixture(t, google)
	evidence := SignupTermsEvidence{
		SubmissionID: reservation.SubmissionID, AccountID: reservation.AccountID,
		VaultID: reservation.VaultID, TermsConsentID: "01991f20-61d2-7000-8000-000000000601",
	}
	emailIdentity := VerifiedSignupIdentity{Kind: SignupIdentityEmailOtp, Address: emailOtpAddress(t)}
	if decision := PlanSignupAdmission(emailIdentity, reservation.SubmissionID, reservation, evidence); decision.Ready || decision.Reason != "identity-mismatch" {
		t.Fatalf("identity substitution = %#v", decision)
	}
	if decision := PlanSignupAdmission(google, fixtureOtherAccount, reservation, evidence); decision.Ready || decision.Reason != "submission-mismatch" {
		t.Fatalf("submission substitution = %#v", decision)
	}
	evidence.VaultID = mustVaultID(t, fixtureOtherVault)
	if decision := PlanSignupAdmission(google, reservation.SubmissionID, reservation, evidence); decision.Ready || decision.Reason != "owner-mismatch" {
		t.Fatalf("owner substitution = %#v", decision)
	}
}

func TestVerifiedSignupIdentityUsesOneCanonicalEmailOwnershipKey(t *testing.T) {
	google := signupGoogleFixture(t)
	emailIdentity := VerifiedSignupIdentity{Kind: SignupIdentityEmailOtp, Address: emailOtpAddress(t)}
	if !google.Valid() || !emailIdentity.Valid() || google.VerifiedEmail() != emailIdentity.VerifiedEmail() {
		t.Fatalf("ownership keys differ: google=%q otp=%q", google.VerifiedEmail(), emailIdentity.VerifiedEmail())
	}
	provider, issuer, subject := emailIdentity.ProviderIdentityKey()
	if provider != "email-otp" || issuer != "fukamu.email-otp" || subject != testEmailOtpAddress {
		t.Fatalf("Email OTP identity key = %q %q %q", provider, issuer, subject)
	}
}

func signupGoogleFixture(t *testing.T) VerifiedSignupIdentity {
	t.Helper()
	email, err := ParseVerifiedEmailAddress("Person@Example.COM")
	if err != nil {
		t.Fatal(err)
	}
	return VerifiedSignupIdentity{
		Kind: SignupIdentityGoogle, Issuer: mustOidcIssuer(t, fixtureOidcIssuer),
		Subject: mustOidcSubject(t, fixtureOidcSubject), Email: email,
	}
}

func signupReservationFixture(t *testing.T, identity VerifiedSignupIdentity) SignupAdmissionReservation {
	t.Helper()
	return SignupAdmissionReservation{
		SubmissionID: fixtureIdentityID, Identity: identity,
		AccountID: mustAccountID(t, fixtureAccountID), VaultID: mustVaultID(t, fixtureVaultID),
		IdentityID: mustIdentityID(t, fixtureIdentityID), SessionID: mustSessionID(t, fixtureSessionID),
		SessionEpoch: mustEpoch(t, 1), CreatedAt: 1_000,
	}
}

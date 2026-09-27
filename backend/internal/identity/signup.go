package identity

import "context"

const SignupSessionLifetimeSeconds = int64(MaximumSessionCookieAgeSeconds)

type SignupIdentityKind string

const (
	SignupIdentityGoogle   SignupIdentityKind = "google"
	SignupIdentityEmailOtp SignupIdentityKind = "email-otp"
)

type VerifiedSignupIdentity struct {
	Kind    SignupIdentityKind
	Issuer  OidcIssuer
	Subject OidcSubject
	Email   VerifiedEmailAddress
	Address EmailOtpAddress
}

func (value VerifiedSignupIdentity) Valid() bool {
	switch value.Kind {
	case SignupIdentityGoogle:
		if value.Address != "" {
			return false
		}
		if _, err := ParseOidcIssuer(string(value.Issuer)); err != nil {
			return false
		}
		if _, err := ParseOidcSubject(string(value.Subject)); err != nil {
			return false
		}
		_, err := ParseVerifiedEmailAddress(string(value.Email))
		return err == nil
	case SignupIdentityEmailOtp:
		if value.Issuer != "" || value.Subject != "" || value.Email != "" {
			return false
		}
		_, err := ParseEmailOtpAddress(string(value.Address))
		return err == nil
	default:
		return false
	}
}

func (value VerifiedSignupIdentity) VerifiedEmail() VerifiedEmailAddress {
	if value.Kind == SignupIdentityEmailOtp {
		return value.Address.Verified()
	}
	return value.Email
}

func (value VerifiedSignupIdentity) ProviderIdentityKey() (provider string, issuer string, subject string) {
	switch value.Kind {
	case SignupIdentityGoogle:
		return "google-oidc", string(value.Issuer), string(value.Subject)
	case SignupIdentityEmailOtp:
		return "email-otp", "fukamu.email-otp", string(value.Address)
	default:
		return "", "", ""
	}
}

type SignupAdmissionReservation struct {
	SubmissionID string
	Identity     VerifiedSignupIdentity
	AccountID    AccountID
	VaultID      VaultID
	IdentityID   IdentityID
	SessionID    SessionID
	SessionEpoch SessionEpoch
	CreatedAt    int64
}

func (reservation SignupAdmissionReservation) Valid() bool {
	return uuidV7Pattern.MatchString(reservation.SubmissionID) && reservation.Identity.Valid() &&
		validAccountID(reservation.AccountID) && validVaultID(reservation.VaultID) &&
		validSessionID(reservation.SessionID) && validEpoch(reservation.SessionEpoch) &&
		reservation.SessionEpoch == 1 && uuidV7Pattern.MatchString(string(reservation.IdentityID)) &&
		validTimestamp(reservation.CreatedAt)
}

type SignupTermsEvidence struct {
	SubmissionID   string
	AccountID      AccountID
	VaultID        VaultID
	TermsConsentID string
}

func (evidence SignupTermsEvidence) Valid() bool {
	return uuidV7Pattern.MatchString(evidence.SubmissionID) && validAccountID(evidence.AccountID) &&
		validVaultID(evidence.VaultID) && uuidV7Pattern.MatchString(evidence.TermsConsentID)
}

type SignupAdmissionPlan struct {
	Ready       bool
	Reason      string
	Reservation SignupAdmissionReservation
	ConsentID   string
}

func PlanSignupAdmission(
	identity VerifiedSignupIdentity,
	submissionID string,
	reservation SignupAdmissionReservation,
	evidence SignupTermsEvidence,
) SignupAdmissionPlan {
	if !identity.Valid() || !reservation.Valid() || !evidence.Valid() || !sameSignupIdentity(identity, reservation.Identity) {
		return SignupAdmissionPlan{Reason: "identity-mismatch"}
	}
	if reservation.SubmissionID != submissionID || evidence.SubmissionID != submissionID {
		return SignupAdmissionPlan{Reason: "submission-mismatch"}
	}
	if reservation.AccountID != evidence.AccountID || reservation.VaultID != evidence.VaultID {
		return SignupAdmissionPlan{Reason: "owner-mismatch"}
	}
	return SignupAdmissionPlan{Ready: true, Reservation: reservation, ConsentID: evidence.TermsConsentID}
}

type SignupAdmissionReceipt struct {
	SubmissionID   string
	Identity       VerifiedSignupIdentity
	AccountID      AccountID
	VaultID        VaultID
	IdentityID     IdentityID
	SessionID      SessionID
	SessionEpoch   SessionEpoch
	TermsConsentID string
	SessionToken   SessionToken
	IssuedAt       int64
	ExpiresAt      int64
}

func (receipt SignupAdmissionReceipt) Valid() bool {
	reservation := SignupAdmissionReservation{
		SubmissionID: receipt.SubmissionID, Identity: receipt.Identity,
		AccountID: receipt.AccountID, VaultID: receipt.VaultID, IdentityID: receipt.IdentityID,
		SessionID: receipt.SessionID, SessionEpoch: receipt.SessionEpoch, CreatedAt: receipt.IssuedAt,
	}
	if !reservation.Valid() || !uuidV7Pattern.MatchString(receipt.TermsConsentID) || !validToken(receipt.SessionToken) {
		return false
	}
	created := CreateActiveSession(SessionInput{
		SessionID: receipt.SessionID, AccountID: receipt.AccountID, VaultID: receipt.VaultID,
		SessionEpoch: receipt.SessionEpoch, IssuedAt: receipt.IssuedAt, ExpiresAt: receipt.ExpiresAt,
	})
	return created.Created && receipt.ExpiresAt-receipt.IssuedAt == SignupSessionLifetimeSeconds
}

func SignupReceiptMatchesPlan(receipt SignupAdmissionReceipt, plan SignupAdmissionPlan) bool {
	if !plan.Ready || !receipt.Valid() {
		return false
	}
	reservation := plan.Reservation
	return receipt.SubmissionID == reservation.SubmissionID &&
		sameSignupIdentity(receipt.Identity, reservation.Identity) &&
		receipt.AccountID == reservation.AccountID && receipt.VaultID == reservation.VaultID &&
		receipt.IdentityID == reservation.IdentityID && receipt.SessionID == reservation.SessionID &&
		receipt.SessionEpoch == reservation.SessionEpoch && receipt.TermsConsentID == plan.ConsentID
}

func signupAdmissionMatchesRequest(
	receipt SignupAdmissionReceipt,
	identity VerifiedSignupIdentity,
	consent SignupTermsConsent,
) bool {
	return receipt.Valid() && identity.Valid() && consent.Valid() &&
		receipt.SubmissionID == consent.SubmissionID &&
		sameSignupIdentity(receipt.Identity, identity)
}

func sameSignupIdentity(left VerifiedSignupIdentity, right VerifiedSignupIdentity) bool {
	if left.Kind != right.Kind {
		return false
	}
	switch left.Kind {
	case SignupIdentityGoogle:
		return left.Issuer == right.Issuer && left.Subject == right.Subject && left.Email == right.Email
	case SignupIdentityEmailOtp:
		return left.Address == right.Address
	default:
		return false
	}
}

type SignupAdmissionResult struct {
	Admitted bool
	Outcome  string
	Receipt  SignupAdmissionReceipt
	Reason   string
}

type SignupAdmissionPort interface {
	Admit(context.Context, VerifiedSignupIdentity, SignupTermsConsent) (SignupAdmissionResult, error)
}

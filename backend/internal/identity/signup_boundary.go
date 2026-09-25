package identity

import "context"

type SignupClock interface {
	NowEpochSeconds() int64
}

type SignupIdentifierPort interface {
	CreateAccountID(context.Context) (string, error)
	CreateVaultID(context.Context) (string, error)
	CreateIdentityID(context.Context) (string, error)
	CreateSessionID(context.Context) (string, error)
	CreateSessionToken(context.Context) (string, error)
	CreateTermsConsentID(context.Context) (string, error)
}

type SignupReservationKind string

const (
	SignupReservationReserved SignupReservationKind = "reserved"
	SignupReservationConflict SignupReservationKind = "conflict"
)

type SignupReservationResult struct {
	Kind        SignupReservationKind
	Reservation SignupAdmissionReservation
}

type SignupFinalizationKind string

const (
	SignupFinalizationCreated  SignupFinalizationKind = "created"
	SignupFinalizationReplayed SignupFinalizationKind = "replayed"
	SignupFinalizationConflict SignupFinalizationKind = "conflict"
)

type SignupFinalizationRecord struct {
	Reservation    SignupAdmissionReservation
	TermsConsentID string
	IssuedAt       int64
	ExpiresAt      int64
}

func (record SignupFinalizationRecord) Valid() bool {
	if !record.Reservation.Valid() || !uuidV7Pattern.MatchString(record.TermsConsentID) {
		return false
	}
	created := CreateActiveSession(SessionInput{
		SessionID: record.Reservation.SessionID, AccountID: record.Reservation.AccountID,
		VaultID: record.Reservation.VaultID, SessionEpoch: record.Reservation.SessionEpoch,
		IssuedAt: record.IssuedAt, ExpiresAt: record.ExpiresAt,
	})
	return created.Created && record.ExpiresAt-record.IssuedAt == SignupSessionLifetimeSeconds
}

type SignupFinalizationResult struct {
	Kind   SignupFinalizationKind
	Record SignupFinalizationRecord
}

type SignupProvisioningPort interface {
	Reserve(context.Context, SignupAdmissionReservation) (SignupReservationResult, error)
	Finalize(context.Context, SignupAdmissionPlan, Session, SessionTokenHash) (SignupFinalizationResult, error)
}

type SignupTermsAdmissionResult struct {
	Accepted bool
	Reason   string
	Evidence SignupTermsEvidence
}

type SignupTermsAdmissionPort interface {
	AcceptSignupTerms(
		context.Context,
		SignupAdmissionReservation,
		SignupTermsConsent,
		string,
		int64,
	) (SignupTermsAdmissionResult, error)
}

type SignupApplication struct {
	clock        SignupClock
	identifiers  SignupIdentifierPort
	provisioning SignupProvisioningPort
	terms        SignupTermsAdmissionPort
}

func NewSignupApplication(
	clock SignupClock,
	identifiers SignupIdentifierPort,
	provisioning SignupProvisioningPort,
	terms SignupTermsAdmissionPort,
) (*SignupApplication, error) {
	if clock == nil || identifiers == nil || provisioning == nil || terms == nil {
		return nil, ErrInvalidEmailOtpValue
	}
	return &SignupApplication{clock: clock, identifiers: identifiers, provisioning: provisioning, terms: terms}, nil
}

func (application *SignupApplication) Admit(
	ctx context.Context,
	verifiedIdentity VerifiedSignupIdentity,
	consent SignupTermsConsent,
) (SignupAdmissionResult, error) {
	rejected := func(reason string) SignupAdmissionResult {
		return SignupAdmissionResult{Reason: reason}
	}
	if application == nil || application.clock == nil || application.identifiers == nil ||
		application.provisioning == nil || application.terms == nil || !verifiedIdentity.Valid() {
		return rejected("unavailable"), nil
	}
	if !consent.Valid() || !consent.Affirmed {
		return rejected("terms-consent-required"), nil
	}
	now := application.clock.NowEpochSeconds()
	if !validTimestamp(now) || now > MaximumSafeInteger-SignupSessionLifetimeSeconds {
		return rejected("unavailable"), nil
	}
	candidate, err := application.createReservation(ctx, verifiedIdentity, consent.SubmissionID, now)
	if err != nil {
		return rejected("unavailable"), nil
	}
	reserved, err := application.provisioning.Reserve(ctx, candidate)
	if err != nil {
		return rejected("unavailable"), nil
	}
	if reserved.Kind == SignupReservationConflict {
		return rejected("provisioning-conflict"), nil
	}
	if reserved.Kind != SignupReservationReserved || !reserved.Reservation.Valid() ||
		reserved.Reservation.SubmissionID != consent.SubmissionID ||
		!sameSignupIdentity(reserved.Reservation.Identity, verifiedIdentity) {
		return rejected("unavailable"), nil
	}
	consentID, err := application.identifiers.CreateTermsConsentID(ctx)
	if err != nil || !uuidV7Pattern.MatchString(consentID) {
		return rejected("unavailable"), nil
	}
	terms, err := application.terms.AcceptSignupTerms(ctx, reserved.Reservation, consent, consentID, now)
	if err != nil {
		return rejected("unavailable"), nil
	}
	if !terms.Accepted {
		switch terms.Reason {
		case "terms-consent-required", "terms-changed", "owner-mismatch":
			return rejected(terms.Reason), nil
		default:
			return rejected("unavailable"), nil
		}
	}
	plan := PlanSignupAdmission(verifiedIdentity, consent.SubmissionID, reserved.Reservation, terms.Evidence)
	if !plan.Ready {
		if plan.Reason == "owner-mismatch" {
			return rejected("owner-mismatch"), nil
		}
		return rejected("provisioning-conflict"), nil
	}
	rawToken, err := application.identifiers.CreateSessionToken(ctx)
	if err != nil {
		return rejected("unavailable"), nil
	}
	token, err := ParseSessionToken(rawToken)
	if err != nil {
		return rejected("unavailable"), nil
	}
	tokenHash, err := HashSessionToken(token)
	if err != nil {
		return rejected("unavailable"), nil
	}
	created := CreateActiveSession(SessionInput{
		SessionID: plan.Reservation.SessionID, AccountID: plan.Reservation.AccountID,
		VaultID: plan.Reservation.VaultID, SessionEpoch: plan.Reservation.SessionEpoch,
		IssuedAt: now, ExpiresAt: now + SignupSessionLifetimeSeconds,
	})
	if !created.Created {
		return rejected("unavailable"), nil
	}
	finalized, err := application.provisioning.Finalize(ctx, plan, created.Session, tokenHash)
	if err != nil {
		return rejected("unavailable"), nil
	}
	if finalized.Kind == SignupFinalizationConflict {
		return rejected("provisioning-conflict"), nil
	}
	if (finalized.Kind != SignupFinalizationCreated && finalized.Kind != SignupFinalizationReplayed) ||
		!finalized.Record.Valid() || !finalizationMatchesPlan(finalized.Record, plan, created.Session) {
		return rejected("provisioning-conflict"), nil
	}
	record := finalized.Record
	receipt := SignupAdmissionReceipt{
		SubmissionID: record.Reservation.SubmissionID, Identity: record.Reservation.Identity,
		AccountID: record.Reservation.AccountID, VaultID: record.Reservation.VaultID,
		IdentityID: record.Reservation.IdentityID, SessionID: record.Reservation.SessionID,
		SessionEpoch: record.Reservation.SessionEpoch, TermsConsentID: record.TermsConsentID,
		SessionToken: token, IssuedAt: record.IssuedAt, ExpiresAt: record.ExpiresAt,
	}
	if !SignupReceiptMatchesPlan(receipt, plan) {
		return rejected("provisioning-conflict"), nil
	}
	outcome := "created"
	if finalized.Kind == SignupFinalizationReplayed {
		outcome = "replayed"
	}
	return SignupAdmissionResult{Admitted: true, Outcome: outcome, Receipt: receipt}, nil
}

func (application *SignupApplication) createReservation(
	ctx context.Context,
	verifiedIdentity VerifiedSignupIdentity,
	submissionID string,
	now int64,
) (SignupAdmissionReservation, error) {
	rawAccountID, err := application.identifiers.CreateAccountID(ctx)
	if err != nil {
		return SignupAdmissionReservation{}, err
	}
	rawVaultID, err := application.identifiers.CreateVaultID(ctx)
	if err != nil {
		return SignupAdmissionReservation{}, err
	}
	rawIdentityID, err := application.identifiers.CreateIdentityID(ctx)
	if err != nil {
		return SignupAdmissionReservation{}, err
	}
	rawSessionID, err := application.identifiers.CreateSessionID(ctx)
	if err != nil {
		return SignupAdmissionReservation{}, err
	}
	accountID, err := ParseAccountID(rawAccountID)
	if err != nil {
		return SignupAdmissionReservation{}, err
	}
	vaultID, err := ParseVaultID(rawVaultID)
	if err != nil {
		return SignupAdmissionReservation{}, err
	}
	identityID, err := ParseIdentityID(rawIdentityID)
	if err != nil {
		return SignupAdmissionReservation{}, err
	}
	sessionID, err := ParseSessionID(rawSessionID)
	if err != nil {
		return SignupAdmissionReservation{}, err
	}
	epoch, err := ParseSessionEpoch(1)
	if err != nil {
		return SignupAdmissionReservation{}, err
	}
	reservation := SignupAdmissionReservation{
		SubmissionID: submissionID, Identity: verifiedIdentity,
		AccountID: accountID, VaultID: vaultID, IdentityID: identityID,
		SessionID: sessionID, SessionEpoch: epoch, CreatedAt: now,
	}
	if !reservation.Valid() {
		return SignupAdmissionReservation{}, ErrInvalidEmailOtpValue
	}
	return reservation, nil
}

func finalizationMatchesPlan(record SignupFinalizationRecord, plan SignupAdmissionPlan, session Session) bool {
	reservation := record.Reservation
	return plan.Ready && reservation == plan.Reservation && record.TermsConsentID == plan.ConsentID &&
		session.Kind == SessionActive && session.SessionID == reservation.SessionID &&
		session.AccountID == reservation.AccountID && session.VaultID == reservation.VaultID &&
		session.SessionEpoch == reservation.SessionEpoch && session.IssuedAt == record.IssuedAt &&
		session.ExpiresAt == record.ExpiresAt
}

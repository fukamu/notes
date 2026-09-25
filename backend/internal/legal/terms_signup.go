package legal

import (
	"context"

	"github.com/fukamu/notes/backend/internal/identity"
)

type SignupTermsAdmission struct {
	service *TermsConsentService
}

var _ identity.SignupTermsAdmissionPort = (*SignupTermsAdmission)(nil)

func NewSignupTermsAdmission(service *TermsConsentService) (*SignupTermsAdmission, error) {
	if service == nil {
		return nil, ErrInvalidTermsServiceConfiguration
	}
	return &SignupTermsAdmission{service: service}, nil
}

func (adapter *SignupTermsAdmission) AcceptSignupTerms(
	ctx context.Context,
	reservation identity.SignupAdmissionReservation,
	input identity.SignupTermsConsent,
	rawConsentID string,
	acceptedAt int64,
) (identity.SignupTermsAdmissionResult, error) {
	rejected := func(reason string) identity.SignupTermsAdmissionResult {
		return identity.SignupTermsAdmissionResult{Reason: reason}
	}
	if adapter == nil || adapter.service == nil || !reservation.Valid() || !input.Valid() ||
		reservation.SubmissionID != input.SubmissionID {
		return rejected("terms-consent-required"), nil
	}
	submissionID, submissionErr := ParseTermsConsentSubmissionID(input.SubmissionID)
	version, versionErr := ParseTermsVersion(input.PresentedTermsVersion)
	hash, hashErr := ParseTermsDocumentHash(input.PresentedTermsHash)
	consentID, consentErr := ParseTermsConsentID(rawConsentID)
	if submissionErr != nil || versionErr != nil || hashErr != nil || consentErr != nil {
		return rejected("terms-consent-required"), nil
	}
	choice := ConsentNotAffirmed
	if input.Affirmed {
		choice = ConsentAffirmed
	}
	result := adapter.service.Accept(
		ctx,
		TermsScope{AccountID: reservation.AccountID, VaultID: reservation.VaultID},
		TermsConsentCommand{
			SubmissionID: submissionID, PresentedTermsVersion: version,
			PresentedTermsHash: hash, Consent: choice,
		},
		consentID,
		acceptedAt,
	)
	if result.Kind != ApplicationAccepted || result.Status.Kind != TermsStatusAccepted || result.Status.Accepted == nil {
		return rejected(mapSignupTermsFailure(result.Reason)), nil
	}
	accepted := result.Status.Accepted
	return identity.SignupTermsAdmissionResult{
		Accepted: true,
		Evidence: identity.SignupTermsEvidence{
			SubmissionID: reservation.SubmissionID, AccountID: reservation.AccountID,
			VaultID: reservation.VaultID, TermsConsentID: string(accepted.ConsentID),
		},
	}, nil
}

func mapSignupTermsFailure(reason ApplicationRejectionReason) string {
	switch reason {
	case ApplicationInvalidCommand, ApplicationConsentRequired:
		return "terms-consent-required"
	case ApplicationStaleTerms, ApplicationClassificationNeeded, ApplicationInconsistentEvidence:
		return "terms-changed"
	case ApplicationOwnerMismatch:
		return "owner-mismatch"
	default:
		return "unavailable"
	}
}

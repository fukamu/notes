package legal

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/identity"
)

var ErrInvalidTermsServiceConfiguration = errors.New("invalid terms consent service configuration")

type ApplicationResultKind string

const (
	ApplicationAccepted ApplicationResultKind = "accepted"
	ApplicationRejected ApplicationResultKind = "rejected"
)

type ApplicationOutcome string

const (
	ApplicationStatus   ApplicationOutcome = "status"
	ApplicationRecorded ApplicationOutcome = "recorded"
	ApplicationReplayed ApplicationOutcome = "replayed"
)

type ApplicationRejectionReason string

const (
	ApplicationInvalidCurrentTerms  ApplicationRejectionReason = "invalid-current-terms"
	ApplicationHashUnavailable      ApplicationRejectionReason = "hash-unavailable"
	ApplicationClassificationNeeded ApplicationRejectionReason = "classification-required"
	ApplicationInconsistentEvidence ApplicationRejectionReason = "inconsistent-evidence"
	ApplicationInvalidCommand       ApplicationRejectionReason = "invalid-command"
	ApplicationConsentRequired      ApplicationRejectionReason = "consent-required"
	ApplicationStaleTerms           ApplicationRejectionReason = "stale-terms"
	ApplicationOwnerMismatch        ApplicationRejectionReason = "owner-mismatch"
	ApplicationIdentifierConflict   ApplicationRejectionReason = "identifier-conflict"
	ApplicationUnavailable          ApplicationRejectionReason = "unavailable"
)

type ApplicationResult struct {
	Kind    ApplicationResultKind
	Outcome ApplicationOutcome
	Status  TermsConsentStatus
	Reason  ApplicationRejectionReason
}

type CheckoutVerificationKind string

const (
	CheckoutTermsAccepted CheckoutVerificationKind = "accepted"
	CheckoutTermsRejected CheckoutVerificationKind = "rejected"
)

type CheckoutVerificationReason string

const (
	CheckoutTermsConsentRequired CheckoutVerificationReason = "terms-consent-required"
	CheckoutTermsChanged         CheckoutVerificationReason = "terms-changed"
	CheckoutTermsOwnerMismatch   CheckoutVerificationReason = "owner-mismatch"
	CheckoutTermsUnavailable     CheckoutVerificationReason = "unavailable"
)

type CheckoutVerification struct {
	Kind      CheckoutVerificationKind
	ConsentID TermsConsentID
	Reason    CheckoutVerificationReason
}

type TermsConsentService struct {
	source     CurrentTermsSource
	hasher     TermsDocumentHasher
	repository TermsConsentRepository
}

func NewTermsConsentService(
	source CurrentTermsSource,
	hasher TermsDocumentHasher,
	repository TermsConsentRepository,
) (*TermsConsentService, error) {
	if source == nil || hasher == nil || repository == nil {
		return nil, ErrInvalidTermsServiceConfiguration
	}
	return &TermsConsentService{source: source, hasher: hasher, repository: repository}, nil
}

func (service *TermsConsentService) Status(ctx context.Context, scope TermsScope) ApplicationResult {
	if service == nil || !ValidTermsScope(scope) {
		return rejectApplication(ApplicationInvalidCommand)
	}
	prepared, reason := service.current(ctx)
	if reason != "" {
		return rejectApplication(reason)
	}
	latest, err := service.repository.FindLatest(ctx, scope)
	if err != nil {
		return rejectApplication(ApplicationUnavailable)
	}
	plan := DecideTermsConsentStatus(scope, prepared.snapshot, latest, prepared.policy)
	if plan.Kind != StatusResolved {
		return rejectApplication(mapStatusReason(plan.Reason))
	}
	return ApplicationResult{Kind: ApplicationAccepted, Outcome: ApplicationStatus, Status: plan.Status}
}

func (service *TermsConsentService) Accept(
	ctx context.Context,
	scope TermsScope,
	command TermsConsentCommand,
	consentID TermsConsentID,
	acceptedAt int64,
) ApplicationResult {
	if service == nil || !ValidTermsScope(scope) || !validConsentCommand(command) || !validTimestamp(acceptedAt) {
		return rejectApplication(ApplicationInvalidCommand)
	}
	prepared, reason := service.current(ctx)
	if reason != "" {
		return rejectApplication(reason)
	}
	existing, err := service.repository.FindBySubmission(ctx, scope, command.SubmissionID)
	if err != nil {
		return rejectApplication(ApplicationUnavailable)
	}
	plan := PlanTermsConsent(scope, command, prepared.snapshot, consentID, acceptedAt, existing)
	if plan.Kind == ConsentReject {
		return rejectApplication(mapConsentReason(plan.Reason))
	}
	if plan.Kind == ConsentReplay {
		return service.acceptedResult(ApplicationReplayed, prepared.snapshot, plan.Record)
	}
	appended, err := service.repository.Append(ctx, plan.Record)
	if err != nil {
		return rejectApplication(ApplicationUnavailable)
	}
	switch appended.Kind {
	case TermsAppendCreated:
		return service.acceptedResult(ApplicationRecorded, prepared.snapshot, plan.Record)
	case TermsAppendConflict:
		return rejectApplication(ApplicationIdentifierConflict)
	case TermsAppendOwnerMismatch:
		return rejectApplication(ApplicationOwnerMismatch)
	case TermsAppendExisting:
		if appended.Record == nil {
			return rejectApplication(ApplicationUnavailable)
		}
		raced := PlanTermsConsent(scope, command, prepared.snapshot, consentID, acceptedAt, appended.Record)
		if raced.Kind == ConsentReplay {
			return service.acceptedResult(ApplicationReplayed, prepared.snapshot, raced.Record)
		}
		if raced.Kind == ConsentReject {
			return rejectApplication(mapConsentReason(raced.Reason))
		}
		return rejectApplication(ApplicationIdentifierConflict)
	default:
		return rejectApplication(ApplicationUnavailable)
	}
}

func (service *TermsConsentService) VerifyCheckout(
	ctx context.Context,
	vaultContext identity.VaultContext,
	rawSubmissionID string,
) CheckoutVerification {
	if service == nil || !validVaultContext(vaultContext) {
		return CheckoutVerification{Kind: CheckoutTermsRejected, Reason: CheckoutTermsUnavailable}
	}
	submissionID, err := ParseTermsConsentSubmissionID(rawSubmissionID)
	if err != nil {
		return CheckoutVerification{Kind: CheckoutTermsRejected, Reason: CheckoutTermsConsentRequired}
	}
	scope := TermsScope{AccountID: vaultContext.AccountID, VaultID: vaultContext.VaultID}
	status := service.Status(ctx, scope)
	if status.Kind != ApplicationAccepted {
		reason := CheckoutTermsUnavailable
		if status.Reason == ApplicationOwnerMismatch {
			reason = CheckoutTermsOwnerMismatch
		}
		return CheckoutVerification{Kind: CheckoutTermsRejected, Reason: reason}
	}
	record, err := service.repository.FindBySubmission(ctx, scope, submissionID)
	if err != nil {
		return CheckoutVerification{Kind: CheckoutTermsRejected, Reason: CheckoutTermsUnavailable}
	}
	if record == nil {
		return CheckoutVerification{Kind: CheckoutTermsRejected, Reason: CheckoutTermsConsentRequired}
	}
	if record.Scope != scope {
		return CheckoutVerification{Kind: CheckoutTermsRejected, Reason: CheckoutTermsOwnerMismatch}
	}
	if record.Snapshot.TermsVersion != status.Status.Current.TermsVersion ||
		record.Snapshot.TermsHash != status.Status.Current.TermsHash {
		return CheckoutVerification{Kind: CheckoutTermsRejected, Reason: CheckoutTermsChanged}
	}
	return CheckoutVerification{Kind: CheckoutTermsAccepted, ConsentID: record.ConsentID}
}

type preparedCurrentTerms struct {
	snapshot TermsSnapshot
	policy   AcceptancePolicy
}

func (service *TermsConsentService) current(ctx context.Context) (preparedCurrentTerms, ApplicationRejectionReason) {
	value, err := service.source.ReadCurrent(ctx)
	if err != nil || !ValidTermsDisclosure(value.Disclosure) || !ValidAcceptancePolicy(value.AcceptancePolicy) {
		return preparedCurrentTerms{}, ApplicationInvalidCurrentTerms
	}
	serialized, err := SerializeTermsDisclosure(value.Disclosure)
	if err != nil {
		return preparedCurrentTerms{}, ApplicationInvalidCurrentTerms
	}
	hash, err := service.hasher.Hash(ctx, serialized)
	if err != nil {
		return preparedCurrentTerms{}, ApplicationHashUnavailable
	}
	plan := PlanTermsSnapshot(value.Disclosure, hash)
	if plan.Kind != SnapshotReady {
		return preparedCurrentTerms{}, ApplicationHashUnavailable
	}
	return preparedCurrentTerms{snapshot: plan.Snapshot, policy: value.AcceptancePolicy}, ""
}

func (service *TermsConsentService) acceptedResult(
	outcome ApplicationOutcome,
	current TermsSnapshot,
	record TermsConsentRecord,
) ApplicationResult {
	status := AcceptedTermsStatus(current, record)
	if status.Kind != StatusResolved {
		return rejectApplication(mapStatusReason(status.Reason))
	}
	return ApplicationResult{Kind: ApplicationAccepted, Outcome: outcome, Status: status.Status}
}

func rejectApplication(reason ApplicationRejectionReason) ApplicationResult {
	return ApplicationResult{Kind: ApplicationRejected, Reason: reason}
}

func mapConsentReason(reason ConsentRejectionReason) ApplicationRejectionReason {
	switch reason {
	case ConsentInvalidCommand:
		return ApplicationInvalidCommand
	case ConsentRequired:
		return ApplicationConsentRequired
	case ConsentStaleTerms:
		return ApplicationStaleTerms
	case ConsentOwnerMismatch:
		return ApplicationOwnerMismatch
	case ConsentIdentifierConflict:
		return ApplicationIdentifierConflict
	default:
		return ApplicationUnavailable
	}
}

func mapStatusReason(reason StatusRejectionReason) ApplicationRejectionReason {
	switch reason {
	case StatusOwnerMismatch:
		return ApplicationOwnerMismatch
	case StatusClassificationRequired:
		return ApplicationClassificationNeeded
	case StatusInconsistentEvidence:
		return ApplicationInconsistentEvidence
	default:
		return ApplicationUnavailable
	}
}

func validVaultContext(value identity.VaultContext) bool {
	_, accountErr := identity.ParseAccountID(string(value.AccountID))
	_, vaultErr := identity.ParseVaultID(string(value.VaultID))
	_, sessionErr := identity.ParseSessionID(string(value.SessionID))
	_, epochErr := identity.ParseSessionEpoch(int64(value.SessionEpoch))
	return accountErr == nil && vaultErr == nil && sessionErr == nil && epochErr == nil
}

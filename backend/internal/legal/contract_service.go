package legal

import (
	"context"
	"errors"
)

var ErrInvalidContractServiceConfiguration = errors.New("invalid contract evidence service configuration")

type ContractApplicationReason string

const (
	ContractInvalidOffer        ContractApplicationReason = "invalid-offer"
	ContractHashUnavailable     ContractApplicationReason = "hash-unavailable"
	ContractInvalidCommand      ContractApplicationReason = "invalid-command"
	ContractConsentRequired     ContractApplicationReason = "consent-required"
	ContractStaleOffer          ContractApplicationReason = "stale-offer"
	ContractOwnerMismatch       ContractApplicationReason = "owner-mismatch"
	ContractIdentifierConflict  ContractApplicationReason = "identifier-conflict"
	ContractUnavailable         ContractApplicationReason = "unavailable"
	ContractProviderUnavailable ContractApplicationReason = "provider-unavailable"
	ContractMalformedProvider   ContractApplicationReason = "malformed-provider-response"
	ContractProviderMismatch    ContractApplicationReason = "provider-mapping-mismatch"
	ContractBillingRejected     ContractApplicationReason = "billing-rejected"
	ContractTermsRequired       ContractApplicationReason = "terms-consent-required"
	ContractTermsChanged        ContractApplicationReason = "terms-changed"
)

type PrepareContractOfferKind string

const (
	PrepareContractAvailable   PrepareContractOfferKind = "available"
	PrepareContractUnavailable PrepareContractOfferKind = "unavailable"
)

type PrepareContractOfferResult struct {
	Kind     PrepareContractOfferKind
	Prepared PreparedContractOffer
	Reason   ContractApplicationReason
}

type ContractConfirmationKind string
type ContractEvidenceOutcome string

const (
	ContractConfirmationAccepted ContractConfirmationKind = "accepted"
	ContractConfirmationRejected ContractConfirmationKind = "rejected"
	ContractEvidenceRecorded     ContractEvidenceOutcome  = "recorded"
	ContractEvidenceReplayed     ContractEvidenceOutcome  = "replayed"
)

type ContractConfirmationResult struct {
	Kind     ContractConfirmationKind
	Outcome  ContractEvidenceOutcome
	Evidence ContractEvidenceRecord
	Reason   ContractApplicationReason
}

type ContractEvidenceService struct {
	repository ContractEvidenceRepository
	hasher     ContractOfferHasher
}

func NewContractEvidenceService(repository ContractEvidenceRepository, hasher ContractOfferHasher) (*ContractEvidenceService, error) {
	if repository == nil || hasher == nil {
		return nil, ErrInvalidContractServiceConfiguration
	}
	return &ContractEvidenceService{repository: repository, hasher: hasher}, nil
}

func (service *ContractEvidenceService) PrepareOffer(
	ctx context.Context,
	disclosure LegalCommerceDisclosure,
) PrepareContractOfferResult {
	if service == nil {
		return unavailableContractOffer(ContractInvalidOffer)
	}
	plan := PlanContractOffer(disclosure)
	if plan.Kind != ContractOfferReady {
		return unavailableContractOffer(plan.Reason)
	}
	serialized, err := SerializeContractOffer(plan.Offer)
	if err != nil {
		return unavailableContractOffer(ContractInvalidOffer)
	}
	hash, err := service.hasher.Hash(ctx, serialized)
	if err != nil {
		return unavailableContractOffer(ContractHashUnavailable)
	}
	if _, err := ParseContractOfferHash(string(hash)); err != nil || hash != canonicalContractOfferHash(serialized) {
		return unavailableContractOffer(ContractHashUnavailable)
	}
	return PrepareContractOfferResult{Kind: PrepareContractAvailable, Prepared: PreparedContractOffer{
		Offer: plan.Offer, SerializedOffer: serialized, OfferHash: hash,
	}}
}

func (service *ContractEvidenceService) Confirm(
	ctx context.Context,
	scope TermsScope,
	disclosure LegalCommerceDisclosure,
	command ContractConfirmationCommand,
	evidenceID ContractEvidenceID,
	confirmedAt int64,
) ContractConfirmationResult {
	if service == nil || !ValidTermsScope(scope) || !validContractConfirmationCommand(command) ||
		!validTimestamp(confirmedAt) {
		return rejectedContractConfirmation(ContractInvalidCommand)
	}
	if _, err := ParseContractEvidenceID(string(evidenceID)); err != nil {
		return rejectedContractConfirmation(ContractInvalidCommand)
	}
	prepared := service.PrepareOffer(ctx, disclosure)
	if prepared.Kind != PrepareContractAvailable {
		return rejectedContractConfirmation(prepared.Reason)
	}
	existing, err := service.repository.FindBySubmission(ctx, scope, command.SubmissionID)
	if err != nil {
		return rejectedContractConfirmation(ContractUnavailable)
	}
	plan := PlanContractEvidence(scope, command, prepared.Prepared, evidenceID, confirmedAt, existing)
	if plan.Kind == ContractEvidenceReject {
		return rejectedContractConfirmation(plan.Reason)
	}
	if plan.Kind == ContractEvidenceReplay {
		return acceptedContractConfirmation(ContractEvidenceReplayed, plan.Record)
	}
	appended, err := service.repository.Append(ctx, plan.Record)
	if err != nil {
		return rejectedContractConfirmation(ContractUnavailable)
	}
	switch appended.Kind {
	case ContractEvidenceAppendCreated:
		return acceptedContractConfirmation(ContractEvidenceRecorded, plan.Record)
	case ContractEvidenceAppendOwnerMismatch:
		return rejectedContractConfirmation(ContractOwnerMismatch)
	case ContractEvidenceAppendConflict:
		return rejectedContractConfirmation(ContractIdentifierConflict)
	case ContractEvidenceAppendExisting:
		if appended.Record == nil {
			return rejectedContractConfirmation(ContractUnavailable)
		}
		raced := PlanContractEvidence(scope, command, prepared.Prepared, evidenceID, confirmedAt, appended.Record)
		if raced.Kind == ContractEvidenceReplay {
			return acceptedContractConfirmation(ContractEvidenceReplayed, raced.Record)
		}
		if raced.Kind == ContractEvidenceReject {
			return rejectedContractConfirmation(raced.Reason)
		}
		return rejectedContractConfirmation(ContractIdentifierConflict)
	default:
		return rejectedContractConfirmation(ContractUnavailable)
	}
}

func unavailableContractOffer(reason ContractApplicationReason) PrepareContractOfferResult {
	return PrepareContractOfferResult{Kind: PrepareContractUnavailable, Reason: reason}
}

func acceptedContractConfirmation(outcome ContractEvidenceOutcome, evidence ContractEvidenceRecord) ContractConfirmationResult {
	return ContractConfirmationResult{Kind: ContractConfirmationAccepted, Outcome: outcome, Evidence: evidence}
}

func rejectedContractConfirmation(reason ContractApplicationReason) ContractConfirmationResult {
	return ContractConfirmationResult{Kind: ContractConfirmationRejected, Reason: reason}
}

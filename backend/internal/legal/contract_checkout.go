package legal

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/stripebilling"
)

var ErrInvalidContractCheckoutConfiguration = errors.New("invalid contract checkout configuration")

type ContractCheckoutTermsVerifier interface {
	VerifyCheckout(context.Context, identity.VaultContext, string) CheckoutVerification
}

var _ ContractCheckoutTermsVerifier = (*TermsConsentService)(nil)

type ContractCheckoutProvider interface {
	BeginHostedCheckout(context.Context, identity.VaultContext, stripebilling.HostedCheckoutCommand) stripebilling.HostedCheckoutResult
}

type ContractCheckoutResultKind string

const (
	ContractCheckoutRedirect ContractCheckoutResultKind = "redirect"
	ContractCheckoutRejected ContractCheckoutResultKind = "rejected"
)

type ContractCheckoutResult struct {
	Kind        ContractCheckoutResultKind
	Outcome     ContractEvidenceOutcome
	Evidence    ContractEvidenceRecord
	CheckoutURL string
	Reason      ContractApplicationReason
}

type ContractCheckoutApplication struct {
	evidence *ContractEvidenceService
	source   CurrentContractOfferSource
	terms    ContractCheckoutTermsVerifier
	provider ContractCheckoutProvider
}

func NewContractCheckoutApplication(
	evidence *ContractEvidenceService,
	source CurrentContractOfferSource,
	terms ContractCheckoutTermsVerifier,
	provider ContractCheckoutProvider,
) (*ContractCheckoutApplication, error) {
	if evidence == nil || source == nil || terms == nil || provider == nil {
		return nil, ErrInvalidContractCheckoutConfiguration
	}
	return &ContractCheckoutApplication{evidence: evidence, source: source, terms: terms, provider: provider}, nil
}

func (application *ContractCheckoutApplication) PrepareOffer(ctx context.Context) PrepareContractOfferResult {
	if application == nil {
		return unavailableContractOffer(ContractInvalidOffer)
	}
	disclosure, err := application.source.ReadCurrent(ctx)
	if err != nil {
		return unavailableContractOffer(ContractInvalidOffer)
	}
	return application.evidence.PrepareOffer(ctx, disclosure)
}

func (application *ContractCheckoutApplication) Confirm(
	ctx context.Context,
	vaultContext identity.VaultContext,
	command ContractConfirmationCommand,
	evidenceID ContractEvidenceID,
	confirmedAt int64,
) ContractCheckoutResult {
	if application == nil || !validVaultContext(vaultContext) || !validContractConfirmationCommand(command) ||
		!validTimestamp(confirmedAt) {
		return rejectedContractCheckout(ContractInvalidCommand)
	}
	if _, err := ParseContractEvidenceID(string(evidenceID)); err != nil {
		return rejectedContractCheckout(ContractInvalidCommand)
	}
	terms := application.terms.VerifyCheckout(ctx, vaultContext, string(command.SubmissionID))
	if terms.Kind != CheckoutTermsAccepted {
		switch terms.Reason {
		case CheckoutTermsConsentRequired:
			return rejectedContractCheckout(ContractTermsRequired)
		case CheckoutTermsChanged:
			return rejectedContractCheckout(ContractTermsChanged)
		case CheckoutTermsOwnerMismatch:
			return rejectedContractCheckout(ContractOwnerMismatch)
		default:
			return rejectedContractCheckout(ContractUnavailable)
		}
	}
	disclosure, err := application.source.ReadCurrent(ctx)
	if err != nil {
		return rejectedContractCheckout(ContractInvalidOffer)
	}
	confirmation := application.evidence.Confirm(
		ctx, contractScope(vaultContext), disclosure, command, evidenceID, confirmedAt,
	)
	if confirmation.Kind != ContractConfirmationAccepted {
		return rejectedContractCheckout(confirmation.Reason)
	}
	// A replay must reuse the timestamp stored with the first immutable evidence.
	// Otherwise a lost provider response retried under a later server clock would
	// conflict with the already-created Billing checkout intent.
	checkout, ok := PlanContractHostedCheckout(confirmation.Evidence, confirmation.Evidence.ConfirmedAt)
	if !ok {
		return rejectedContractCheckout(ContractInvalidCommand)
	}
	provider := application.provider.BeginHostedCheckout(ctx, vaultContext, checkout)
	if provider.Kind != stripebilling.HostedCheckoutRedirect {
		return rejectedContractCheckout(mapContractProviderReason(provider.Reason))
	}
	return ContractCheckoutResult{
		Kind: ContractCheckoutRedirect, Outcome: confirmation.Outcome,
		Evidence: confirmation.Evidence, CheckoutURL: provider.CheckoutURL,
	}
}

func PlanContractHostedCheckout(evidence ContractEvidenceRecord, createdAt int64) (stripebilling.HostedCheckoutCommand, bool) {
	if !ValidContractEvidenceRecord(evidence) || !validTimestamp(createdAt) {
		return stripebilling.HostedCheckoutCommand{}, false
	}
	subscriptionID, subscriptionErr := billing.ParseSubscriptionID(string(evidence.EvidenceID))
	checkoutID, checkoutErr := billing.ParseCheckoutIntentID(string(evidence.SubmissionID))
	if subscriptionErr != nil || checkoutErr != nil {
		return stripebilling.HostedCheckoutCommand{}, false
	}
	period := stripebilling.BillingPeriod(evidence.Offer.BillingPeriod)
	if period != stripebilling.BillingMonthly && period != stripebilling.BillingAnnual {
		return stripebilling.HostedCheckoutCommand{}, false
	}
	return stripebilling.HostedCheckoutCommand{
		SubscriptionID: subscriptionID, CheckoutIntentID: checkoutID, CreatedAt: createdAt,
		Contract: stripebilling.HostedCheckoutContract{
			EvidenceID: string(evidence.EvidenceID), OfferHash: string(evidence.OfferHash),
			Offer: stripebilling.ContractOffer{
				OfferVersion: evidence.Offer.OfferVersion, DisclosureVersion: evidence.Offer.DisclosureVersion,
				BillingPeriod: period, RenewalChargeYen: evidence.Offer.RenewalChargeYen,
			},
		},
	}, true
}

func mapContractProviderReason(reason stripebilling.RejectionReason) ContractApplicationReason {
	switch reason {
	case stripebilling.ReasonInvalidInput:
		return ContractInvalidCommand
	case stripebilling.ReasonProviderUnavailable:
		return ContractProviderUnavailable
	case stripebilling.ReasonMalformedProviderResponse:
		return ContractMalformedProvider
	case stripebilling.ReasonProviderMappingMismatch:
		return ContractProviderMismatch
	default:
		return ContractBillingRejected
	}
}

func rejectedContractCheckout(reason ContractApplicationReason) ContractCheckoutResult {
	return ContractCheckoutResult{Kind: ContractCheckoutRejected, Reason: reason}
}

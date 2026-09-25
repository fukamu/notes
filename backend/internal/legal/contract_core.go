package legal

type ContractOfferPlanKind string

const (
	ContractOfferReady    ContractOfferPlanKind = "ready"
	ContractOfferRejected ContractOfferPlanKind = "rejected"
)

type ContractOfferPlan struct {
	Kind   ContractOfferPlanKind
	Offer  ContractOfferSnapshot
	Reason ContractApplicationReason
}

func PlanContractOffer(disclosure LegalCommerceDisclosure) ContractOfferPlan {
	if !ValidLegalCommerceDisclosure(disclosure) {
		return ContractOfferPlan{Kind: ContractOfferRejected, Reason: ContractInvalidOffer}
	}
	annualEstimate := disclosure.Offer.PriceYen
	if disclosure.Offer.BillingPeriod == BillingPeriodMonthly {
		annualEstimate *= 12
	}
	offer := ContractOfferSnapshot{
		SchemaVersion: 1, OfferVersion: "legal-commerce-v1:" + disclosure.EffectiveDate,
		DisclosureVersion: disclosure.EffectiveDate, ServiceName: "FUKAMU Notes", Quantity: "one-personal-vault",
		PlanName: disclosure.Offer.PlanName, PriceYen: disclosure.Offer.PriceYen,
		BillingPeriod: disclosure.Offer.BillingPeriod, TaxIncluded: true, TrialDays: 14, TrialPriceYen: 0,
		FirstChargeDay: 15, RenewalChargeYen: disclosure.Offer.PriceYen, AnnualEstimateYen: annualEstimate,
		AutomaticRenewal: true, PaymentMethod: "credit-card",
		ServiceStart: "after-registration-and-payment-method-confirmation", ServicePeriod: "indefinite-until-cancelled",
		CancellationPolicy: disclosure.CancellationPolicy, RefundPolicy: disclosure.RefundPolicy,
		AdditionalFees: disclosure.AdditionalFees, OnlineLockPolicy: "immediate-on-payment-failure-or-action-required",
		CancellationSeparateFromAccountDeletion: true,
	}
	if !ValidContractOfferSnapshot(offer) {
		return ContractOfferPlan{Kind: ContractOfferRejected, Reason: ContractInvalidOffer}
	}
	return ContractOfferPlan{Kind: ContractOfferReady, Offer: offer}
}

type ContractEvidencePlanKind string

const (
	ContractEvidenceAppend ContractEvidencePlanKind = "append"
	ContractEvidenceReplay ContractEvidencePlanKind = "replay"
	ContractEvidenceReject ContractEvidencePlanKind = "rejected"
)

type ContractEvidencePlan struct {
	Kind   ContractEvidencePlanKind
	Record ContractEvidenceRecord
	Reason ContractApplicationReason
}

func PlanContractEvidence(
	scope TermsScope,
	command ContractConfirmationCommand,
	prepared PreparedContractOffer,
	evidenceID ContractEvidenceID,
	confirmedAt int64,
	existing *ContractEvidenceRecord,
) ContractEvidencePlan {
	if !ValidTermsScope(scope) || !validContractConfirmationCommand(command) || !validTimestamp(confirmedAt) ||
		!ValidContractOfferSnapshot(prepared.Offer) {
		return rejectedContractEvidence(ContractInvalidCommand)
	}
	if _, err := ParseContractEvidenceID(string(evidenceID)); err != nil {
		return rejectedContractEvidence(ContractInvalidCommand)
	}
	if _, err := ParseContractOfferHash(string(prepared.OfferHash)); err != nil {
		return rejectedContractEvidence(ContractHashUnavailable)
	}
	serialized, err := SerializeContractOffer(prepared.Offer)
	if err != nil || serialized != prepared.SerializedOffer {
		return rejectedContractEvidence(ContractInvalidCommand)
	}
	if command.Consent != ContractConsentAffirmed {
		return rejectedContractEvidence(ContractConsentRequired)
	}
	if command.PresentedOfferHash != prepared.OfferHash {
		return rejectedContractEvidence(ContractStaleOffer)
	}
	if existing != nil {
		if !ValidContractEvidenceRecord(*existing) {
			return rejectedContractEvidence(ContractIdentifierConflict)
		}
		if existing.Scope != scope {
			return rejectedContractEvidence(ContractOwnerMismatch)
		}
		if existing.SubmissionID != command.SubmissionID || existing.OfferHash != prepared.OfferHash ||
			existing.SerializedOffer != prepared.SerializedOffer || existing.Consent != ContractConsentAffirmed {
			return rejectedContractEvidence(ContractIdentifierConflict)
		}
		return ContractEvidencePlan{Kind: ContractEvidenceReplay, Record: cloneContractEvidenceRecord(*existing)}
	}
	record := ContractEvidenceRecord{
		Scope: scope, EvidenceID: evidenceID, SubmissionID: command.SubmissionID,
		OfferHash: prepared.OfferHash, Offer: prepared.Offer, SerializedOffer: prepared.SerializedOffer,
		Consent: ContractConsentAffirmed, ConfirmedAt: confirmedAt,
	}
	if !ValidContractEvidenceRecord(record) {
		return rejectedContractEvidence(ContractInvalidCommand)
	}
	return ContractEvidencePlan{Kind: ContractEvidenceAppend, Record: record}
}

func rejectedContractEvidence(reason ContractApplicationReason) ContractEvidencePlan {
	return ContractEvidencePlan{Kind: ContractEvidenceReject, Reason: reason}
}

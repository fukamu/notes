package legal

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
)

var legalCommercePhonePattern = regexp.MustCompile(`^\+?[0-9][0-9()-]{7,28}[0-9]$`)

func ValidLegalCommerceDisclosure(value LegalCommerceDisclosure) bool {
	if value.SchemaVersion != 1 || !validCalendarDate(value.EffectiveDate) ||
		!boundedString(value.Seller.LegalName, 1, 200) ||
		!boundedString(value.Seller.Representative, 1, 200) ||
		!boundedString(value.Seller.PostalAddress, 5, 500) ||
		!boundedString(value.Seller.Phone, 9, 30) || !legalCommercePhonePattern.MatchString(value.Seller.Phone) ||
		!boundedString(value.Seller.SupportURL, 1, 500) || !validHTTPURL(value.Seller.SupportURL) {
		return false
	}
	offer := value.Offer
	if !boundedString(offer.PlanName, 1, 200) || offer.PriceYen < 1 || offer.PriceYen > 10_000_000 ||
		(offer.BillingPeriod != BillingPeriodMonthly && offer.BillingPeriod != BillingPeriodAnnual) ||
		!offer.TaxIncluded || offer.TrialDays != 14 {
		return false
	}
	if !boundedString(value.AdditionalFees, 1, 500) || !boundedString(value.CancellationPolicy, 1, 1_000) ||
		!boundedString(value.RefundPolicy, 1, 1_000) || !boundedString(value.SpecialTerms, 1, 1_000) ||
		len(value.SystemRequirements) < 1 || len(value.SystemRequirements) > 10 {
		return false
	}
	seen := make(map[string]struct{}, len(value.SystemRequirements))
	for _, requirement := range value.SystemRequirements {
		if !boundedString(requirement, 1, 500) {
			return false
		}
		if _, exists := seen[requirement]; exists {
			return false
		}
		seen[requirement] = struct{}{}
	}
	return true
}

func ValidContractOfferSnapshot(value ContractOfferSnapshot) bool {
	if value.SchemaVersion != 1 || !contractOfferVersionPattern.MatchString(value.OfferVersion) ||
		!validCalendarDate(value.DisclosureVersion) || value.OfferVersion != "legal-commerce-v1:"+value.DisclosureVersion ||
		value.ServiceName != "FUKAMU Notes" || value.Quantity != "one-personal-vault" ||
		!boundedString(value.PlanName, 1, 200) || value.PriceYen < 1 || value.PriceYen > 10_000_000 ||
		(value.BillingPeriod != BillingPeriodMonthly && value.BillingPeriod != BillingPeriodAnnual) ||
		!value.TaxIncluded || value.TrialDays != 14 || value.TrialPriceYen != 0 || value.FirstChargeDay != 15 ||
		value.RenewalChargeYen < 1 || value.RenewalChargeYen > 10_000_000 ||
		value.AnnualEstimateYen < 1 || value.AnnualEstimateYen > 120_000_000 || !value.AutomaticRenewal ||
		value.PaymentMethod != "credit-card" || value.ServiceStart != "after-registration-and-payment-method-confirmation" ||
		value.ServicePeriod != "indefinite-until-cancelled" ||
		!boundedString(value.CancellationPolicy, 1, 1_000) || !boundedString(value.RefundPolicy, 1, 1_000) ||
		!boundedString(value.AdditionalFees, 1, 500) ||
		value.OnlineLockPolicy != "immediate-on-payment-failure-or-action-required" ||
		!value.CancellationSeparateFromAccountDeletion {
		return false
	}
	expectedAnnual := value.PriceYen
	if value.BillingPeriod == BillingPeriodMonthly {
		expectedAnnual = value.PriceYen * 12
	}
	return value.RenewalChargeYen == value.PriceYen && value.AnnualEstimateYen == expectedAnnual
}

func ValidContractEvidenceRecord(value ContractEvidenceRecord) bool {
	if !ValidTermsScope(value.Scope) || !ValidContractOfferSnapshot(value.Offer) ||
		value.Consent != ContractConsentAffirmed || !validTimestamp(value.ConfirmedAt) {
		return false
	}
	if _, err := ParseContractEvidenceID(string(value.EvidenceID)); err != nil {
		return false
	}
	if _, err := ParseContractSubmissionID(string(value.SubmissionID)); err != nil {
		return false
	}
	if _, err := ParseContractOfferHash(string(value.OfferHash)); err != nil {
		return false
	}
	serialized, err := SerializeContractOffer(value.Offer)
	return err == nil && serialized == value.SerializedOffer && boundedString(value.SerializedOffer, 1, 8_192) &&
		value.OfferHash == canonicalContractOfferHash(serialized)
}

func validContractConfirmationCommand(value ContractConfirmationCommand) bool {
	if _, err := ParseContractSubmissionID(string(value.SubmissionID)); err != nil {
		return false
	}
	if _, err := ParseContractOfferHash(string(value.PresentedOfferHash)); err != nil {
		return false
	}
	return value.Consent == ContractConsentAffirmed || value.Consent == ContractConsentNotAffirmed
}

func canonicalContractOfferHash(serialized string) ContractOfferHash {
	digest := sha256.Sum256([]byte(serialized))
	return ContractOfferHash("sha256:" + hex.EncodeToString(digest[:]))
}

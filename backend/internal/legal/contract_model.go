package legal

import (
	"context"
	"errors"
	"regexp"

	"github.com/fukamu/notes/backend/internal/identity"
)

var (
	ErrInvalidContractValue     = errors.New("invalid contract evidence value")
	contractOfferHashPattern    = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	contractOfferVersionPattern = regexp.MustCompile(`^legal-commerce-v1:\d{4}-\d{2}-\d{2}$`)
)

type ContractEvidenceID string
type ContractSubmissionID string
type ContractOfferHash string

func ParseContractEvidenceID(value string) (ContractEvidenceID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidContractValue
	}
	return ContractEvidenceID(value), nil
}

func ParseContractSubmissionID(value string) (ContractSubmissionID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidContractValue
	}
	return ContractSubmissionID(value), nil
}

func ParseContractOfferHash(value string) (ContractOfferHash, error) {
	if !contractOfferHashPattern.MatchString(value) {
		return "", ErrInvalidContractValue
	}
	return ContractOfferHash(value), nil
}

type BillingPeriod string

const (
	BillingPeriodMonthly BillingPeriod = "monthly"
	BillingPeriodAnnual  BillingPeriod = "annual"
)

type LegalCommerceSeller struct {
	LegalName      string `json:"legalName"`
	Representative string `json:"representative"`
	PostalAddress  string `json:"postalAddress"`
	Phone          string `json:"phone"`
	SupportURL     string `json:"supportUrl"`
}

type LegalCommerceOffer struct {
	PlanName      string        `json:"planName"`
	PriceYen      int64         `json:"priceYen"`
	BillingPeriod BillingPeriod `json:"billingPeriod"`
	TaxIncluded   bool          `json:"taxIncluded"`
	TrialDays     int64         `json:"trialDays"`
}

type LegalCommerceDisclosure struct {
	SchemaVersion      int64               `json:"schemaVersion"`
	Seller             LegalCommerceSeller `json:"seller"`
	Offer              LegalCommerceOffer  `json:"offer"`
	AdditionalFees     string              `json:"additionalFees"`
	CancellationPolicy string              `json:"cancellationPolicy"`
	RefundPolicy       string              `json:"refundPolicy"`
	SpecialTerms       string              `json:"specialTerms"`
	SystemRequirements []string            `json:"systemRequirements"`
	EffectiveDate      string              `json:"effectiveDate"`
}

type ContractOfferSnapshot struct {
	SchemaVersion                           int64         `json:"schemaVersion"`
	OfferVersion                            string        `json:"offerVersion"`
	DisclosureVersion                       string        `json:"disclosureVersion"`
	ServiceName                             string        `json:"serviceName"`
	Quantity                                string        `json:"quantity"`
	PlanName                                string        `json:"planName"`
	PriceYen                                int64         `json:"priceYen"`
	BillingPeriod                           BillingPeriod `json:"billingPeriod"`
	TaxIncluded                             bool          `json:"taxIncluded"`
	TrialDays                               int64         `json:"trialDays"`
	TrialPriceYen                           int64         `json:"trialPriceYen"`
	FirstChargeDay                          int64         `json:"firstChargeDay"`
	RenewalChargeYen                        int64         `json:"renewalChargeYen"`
	AnnualEstimateYen                       int64         `json:"annualEstimateYen"`
	AutomaticRenewal                        bool          `json:"automaticRenewal"`
	PaymentMethod                           string        `json:"paymentMethod"`
	ServiceStart                            string        `json:"serviceStart"`
	ServicePeriod                           string        `json:"servicePeriod"`
	CancellationPolicy                      string        `json:"cancellationPolicy"`
	RefundPolicy                            string        `json:"refundPolicy"`
	AdditionalFees                          string        `json:"additionalFees"`
	OnlineLockPolicy                        string        `json:"onlineLockPolicy"`
	CancellationSeparateFromAccountDeletion bool          `json:"cancellationSeparateFromAccountDeletion"`
}

type ContractConsent string

const (
	ContractConsentNotAffirmed ContractConsent = "not-affirmed"
	ContractConsentAffirmed    ContractConsent = "affirmed"
)

type ContractConfirmationCommand struct {
	SubmissionID       ContractSubmissionID
	PresentedOfferHash ContractOfferHash
	Consent            ContractConsent
}

type ContractEvidenceRecord struct {
	Scope           TermsScope
	EvidenceID      ContractEvidenceID
	SubmissionID    ContractSubmissionID
	OfferHash       ContractOfferHash
	Offer           ContractOfferSnapshot
	SerializedOffer string
	Consent         ContractConsent
	ConfirmedAt     int64
}

type PreparedContractOffer struct {
	Offer           ContractOfferSnapshot
	SerializedOffer string
	OfferHash       ContractOfferHash
}

type CurrentContractOfferSource interface {
	ReadCurrent(context.Context) (LegalCommerceDisclosure, error)
}

type ContractOfferHasher interface {
	Hash(context.Context, string) (ContractOfferHash, error)
}

type ContractEvidenceAppendKind string

const (
	ContractEvidenceAppendCreated       ContractEvidenceAppendKind = "created"
	ContractEvidenceAppendExisting      ContractEvidenceAppendKind = "existing"
	ContractEvidenceAppendConflict      ContractEvidenceAppendKind = "conflict"
	ContractEvidenceAppendOwnerMismatch ContractEvidenceAppendKind = "owner-mismatch"
)

type ContractEvidenceAppendResult struct {
	Kind   ContractEvidenceAppendKind
	Record *ContractEvidenceRecord
}

type ContractEvidenceRepository interface {
	FindBySubmission(context.Context, TermsScope, ContractSubmissionID) (*ContractEvidenceRecord, error)
	Append(context.Context, ContractEvidenceRecord) (ContractEvidenceAppendResult, error)
}

func contractScope(context identity.VaultContext) TermsScope {
	return TermsScope{AccountID: context.AccountID, VaultID: context.VaultID}
}

package legal

import (
	"context"
	"errors"
	"regexp"

	"github.com/fukamu/notes/backend/internal/identity"
)

const MaximumSafeInteger int64 = 9_007_199_254_740_991

var (
	ErrInvalidTermsValue = errors.New("invalid terms consent value")
	uuidV7Pattern        = regexp.MustCompile(`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-7[0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$`)
	termsHashPattern     = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	termsVersionPattern  = regexp.MustCompile(`^terms-v1:\d{4}-\d{2}-\d{2}$`)
	legalReviewPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]*$`)
)

type TermsConsentID string
type TermsConsentSubmissionID string
type TermsDocumentHash string
type TermsVersion string

func ParseTermsConsentID(value string) (TermsConsentID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidTermsValue
	}
	return TermsConsentID(value), nil
}

func ParseTermsConsentSubmissionID(value string) (TermsConsentSubmissionID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidTermsValue
	}
	return TermsConsentSubmissionID(value), nil
}

func ParseTermsDocumentHash(value string) (TermsDocumentHash, error) {
	if !termsHashPattern.MatchString(value) {
		return "", ErrInvalidTermsValue
	}
	return TermsDocumentHash(value), nil
}

func ParseTermsVersion(value string) (TermsVersion, error) {
	if !termsVersionPattern.MatchString(value) {
		return "", ErrInvalidTermsValue
	}
	return TermsVersion(value), nil
}

type TermsScope struct {
	AccountID identity.AccountID
	VaultID   identity.VaultID
}

type TermsOperator struct {
	LegalName  string `json:"legalName"`
	SupportURL string `json:"supportUrl"`
}

type TermsAuthentication struct {
	GoogleLogin bool `json:"googleLogin"`
	EmailOTP    bool `json:"emailOtp"`
	Password    bool `json:"password"`
	SharedVault bool `json:"sharedVault"`
}

type TermsUserContent struct {
	Ownership      string `json:"ownership"`
	LicenseScope   string `json:"licenseScope"`
	LicensePurpose string `json:"licensePurpose"`
}

type TermsBilling struct {
	PaidOnly                        bool   `json:"paidOnly"`
	TrialDays                       int64  `json:"trialDays"`
	FirstChargeDay                  int64  `json:"firstChargeDay"`
	AutomaticRenewal                bool   `json:"automaticRenewal"`
	CancellationPolicy              string `json:"cancellationPolicy"`
	RefundPolicy                    string `json:"refundPolicy"`
	PaymentFailureLock              string `json:"paymentFailureLock"`
	ResumePolicy                    string `json:"resumePolicy"`
	CancellationSeparateFromAccount bool   `json:"cancellationSeparateFromAccountDeletion"`
}

type TermsDataHandling struct {
	OneAccountOnePersonalVault bool   `json:"oneAccountOnePersonalVault"`
	LocalContentOnLogout       string `json:"localContentOnLogout"`
	LiveDataOnAccountDeletion  string `json:"liveDataOnAccountDeletion"`
	BackupMaximumDays          int64  `json:"backupMaximumDays"`
}

type TermsAmendments struct {
	Procedure              string `json:"procedure"`
	MaterialChangeHandling string `json:"materialChangeHandling"`
}

type TermsDisclosure struct {
	SchemaVersion         int64               `json:"schemaVersion"`
	TermsVersion          TermsVersion        `json:"termsVersion"`
	EffectiveDate         string              `json:"effectiveDate"`
	ServiceName           string              `json:"serviceName"`
	Operator              TermsOperator       `json:"operator"`
	ServiceEligibility    string              `json:"serviceEligibility"`
	AccountSecurity       string              `json:"accountSecurity"`
	Authentication        TermsAuthentication `json:"authentication"`
	ProhibitedActivities  []string            `json:"prohibitedActivities"`
	UserContent           TermsUserContent    `json:"userContent"`
	Billing               TermsBilling        `json:"billing"`
	DataHandling          TermsDataHandling   `json:"dataHandling"`
	SuspensionPolicy      string              `json:"suspensionPolicy"`
	MaintenanceAndChanges string              `json:"maintenanceAndChanges"`
	ServiceTermination    string              `json:"serviceTermination"`
	IntellectualProperty  string              `json:"intellectualProperty"`
	Liability             string              `json:"liability"`
	Notices               string              `json:"notices"`
	GoverningLawAndVenue  string              `json:"governingLawAndVenue"`
	Amendments            TermsAmendments     `json:"amendments"`
}

type AcceptancePolicyKind string

const (
	AcceptanceInitialRelease    AcceptancePolicyKind = "initial-release"
	AcceptanceReconsentRequired AcceptancePolicyKind = "reconsent-required"
	AcceptanceNoticeOnly        AcceptancePolicyKind = "notice-only"
	AcceptanceUndecided         AcceptancePolicyKind = "undecided"
)

type AcceptancePolicy struct {
	Kind          AcceptancePolicyKind
	LegalReviewID string
}

type CurrentTermsSourceValue struct {
	Disclosure       TermsDisclosure
	AcceptancePolicy AcceptancePolicy
}

type TermsSnapshot struct {
	TermsVersion    TermsVersion
	TermsHash       TermsDocumentHash
	Disclosure      TermsDisclosure
	SerializedTerms string
}

type ConsentChoice string

const (
	ConsentNotAffirmed ConsentChoice = "not-affirmed"
	ConsentAffirmed    ConsentChoice = "affirmed"
)

type TermsConsentCommand struct {
	SubmissionID          TermsConsentSubmissionID
	PresentedTermsVersion TermsVersion
	PresentedTermsHash    TermsDocumentHash
	Consent               ConsentChoice
}

type TermsConsentRecord struct {
	Scope        TermsScope
	ConsentID    TermsConsentID
	SubmissionID TermsConsentSubmissionID
	Snapshot     TermsSnapshot
	Consent      ConsentChoice
	AcceptedAt   int64
}

type TermsStatusKind string

const (
	TermsStatusCurrent           TermsStatusKind = "current"
	TermsStatusAccepted          TermsStatusKind = "accepted"
	TermsStatusReconsentRequired TermsStatusKind = "reconsent-required"
	TermsStatusNoticeOnly        TermsStatusKind = "notice-only"
)

type CurrentTermsReference struct {
	TermsVersion  TermsVersion
	TermsHash     TermsDocumentHash
	EffectiveDate string
}

type AcceptedTermsReference struct {
	ConsentID    TermsConsentID
	TermsVersion TermsVersion
	TermsHash    TermsDocumentHash
	AcceptedAt   int64
}

type TermsConsentStatus struct {
	Kind               TermsStatusKind
	AcceptanceRequired bool
	Current            CurrentTermsReference
	Accepted           *AcceptedTermsReference
}

type CurrentTermsSource interface {
	ReadCurrent(context.Context) (CurrentTermsSourceValue, error)
}

type TermsDocumentHasher interface {
	Hash(context.Context, string) (TermsDocumentHash, error)
}

type TermsAppendKind string

const (
	TermsAppendCreated       TermsAppendKind = "created"
	TermsAppendExisting      TermsAppendKind = "existing"
	TermsAppendConflict      TermsAppendKind = "conflict"
	TermsAppendOwnerMismatch TermsAppendKind = "owner-mismatch"
)

type TermsAppendResult struct {
	Kind   TermsAppendKind
	Record *TermsConsentRecord
}

type TermsConsentRepository interface {
	FindByID(context.Context, TermsScope, TermsConsentID) (*TermsConsentRecord, error)
	FindBySubmission(context.Context, TermsScope, TermsConsentSubmissionID) (*TermsConsentRecord, error)
	FindLatest(context.Context, TermsScope) (*TermsConsentRecord, error)
	Append(context.Context, TermsConsentRecord) (TermsAppendResult, error)
}

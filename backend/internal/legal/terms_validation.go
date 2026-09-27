package legal

import (
	"net/url"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/fukamu/notes/backend/internal/identity"
)

func ValidTermsScope(value TermsScope) bool {
	_, accountErr := identity.ParseAccountID(string(value.AccountID))
	_, vaultErr := identity.ParseVaultID(string(value.VaultID))
	return accountErr == nil && vaultErr == nil
}

func ValidTermsDisclosure(value TermsDisclosure) bool {
	if value.SchemaVersion != 1 || value.ServiceName != "FUKAMU Notes" ||
		!validCalendarDate(value.EffectiveDate) || string(value.TermsVersion) != "terms-v1:"+value.EffectiveDate {
		return false
	}
	if !boundedString(value.Operator.LegalName, 1, 200) || !boundedString(value.Operator.SupportURL, 1, 500) ||
		!validHTTPURL(value.Operator.SupportURL) || !boundedString(value.ServiceEligibility, 1, 2_000) ||
		!boundedString(value.AccountSecurity, 1, 2_000) {
		return false
	}
	if !value.Authentication.GoogleLogin || !value.Authentication.EmailOTP || value.Authentication.Password ||
		value.Authentication.SharedVault || len(value.ProhibitedActivities) < 1 || len(value.ProhibitedActivities) > 20 {
		return false
	}
	seen := make(map[string]struct{}, len(value.ProhibitedActivities))
	for _, activity := range value.ProhibitedActivities {
		if !boundedString(activity, 1, 500) {
			return false
		}
		if _, ok := seen[activity]; ok {
			return false
		}
		seen[activity] = struct{}{}
	}
	if value.UserContent.Ownership != "retained-by-user" ||
		value.UserContent.LicenseScope != "minimum-necessary-for-service" ||
		!boundedString(value.UserContent.LicensePurpose, 1, 2_000) {
		return false
	}
	billing := value.Billing
	if !billing.PaidOnly || billing.TrialDays != 14 || billing.FirstChargeDay != 15 || !billing.AutomaticRenewal ||
		!boundedString(billing.CancellationPolicy, 1, 1_000) || !boundedString(billing.RefundPolicy, 1, 1_000) ||
		billing.PaymentFailureLock != "immediate-online-lock" || billing.ResumePolicy != "invoice-paid-only" ||
		!billing.CancellationSeparateFromAccount {
		return false
	}
	data := value.DataHandling
	if !data.OneAccountOnePersonalVault || data.LocalContentOnLogout != "deleted-on-logout" ||
		data.LiveDataOnAccountDeletion != "deleted-on-account-deletion" || data.BackupMaximumDays != 30 {
		return false
	}
	for _, policy := range []string{
		value.SuspensionPolicy, value.MaintenanceAndChanges, value.ServiceTermination,
		value.IntellectualProperty, value.Liability, value.Notices, value.GoverningLawAndVenue,
		value.Amendments.Procedure,
	} {
		if !boundedString(policy, 1, 2_000) {
			return false
		}
	}
	return value.Amendments.MaterialChangeHandling == "legal-review-required-before-enforcement"
}

func ValidAcceptancePolicy(value AcceptancePolicy) bool {
	switch value.Kind {
	case AcceptanceInitialRelease, AcceptanceUndecided:
		return value.LegalReviewID == ""
	case AcceptanceReconsentRequired, AcceptanceNoticeOnly:
		return boundedString(value.LegalReviewID, 1, 128) && legalReviewPattern.MatchString(value.LegalReviewID)
	default:
		return false
	}
}

func ValidTermsSnapshot(value TermsSnapshot) bool {
	if !ValidTermsDisclosure(value.Disclosure) || value.TermsVersion != value.Disclosure.TermsVersion {
		return false
	}
	if _, err := ParseTermsDocumentHash(string(value.TermsHash)); err != nil {
		return false
	}
	serialized, err := SerializeTermsDisclosure(value.Disclosure)
	return err == nil && value.SerializedTerms == serialized && utf16Length(value.SerializedTerms) >= 1 &&
		utf16Length(value.SerializedTerms) <= 65_536
}

func ValidTermsConsentRecord(value TermsConsentRecord) bool {
	if !ValidTermsScope(value.Scope) || !ValidTermsSnapshot(value.Snapshot) || value.Consent != ConsentAffirmed ||
		!validTimestamp(value.AcceptedAt) {
		return false
	}
	if _, err := ParseTermsConsentID(string(value.ConsentID)); err != nil {
		return false
	}
	_, err := ParseTermsConsentSubmissionID(string(value.SubmissionID))
	return err == nil
}

func validConsentCommand(value TermsConsentCommand) bool {
	if _, err := ParseTermsConsentSubmissionID(string(value.SubmissionID)); err != nil {
		return false
	}
	if _, err := ParseTermsVersion(string(value.PresentedTermsVersion)); err != nil {
		return false
	}
	if _, err := ParseTermsDocumentHash(string(value.PresentedTermsHash)); err != nil {
		return false
	}
	return value.Consent == ConsentAffirmed || value.Consent == ConsentNotAffirmed
}

func validTimestamp(value int64) bool {
	return value >= 0 && value <= MaximumSafeInteger
}

func boundedString(value string, minimum int, maximum int) bool {
	if !utf8.ValidString(value) {
		return false
	}
	length := utf16Length(value)
	return length >= minimum && length <= maximum
}

func utf16Length(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func validCalendarDate(value string) bool {
	if len(value) != len("2006-01-02") {
		return false
	}
	parsed, err := time.Parse("2006-01-02", value)
	return err == nil && parsed.Format("2006-01-02") == value
}

func validHTTPURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != ""
}

package stripebilling

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/fukamu/notes/backend/internal/billing"
)

var (
	ErrInvalidConfiguration  = errors.New("invalid Stripe billing configuration")
	ErrInvalidCheckout       = errors.New("invalid Stripe checkout input")
	ErrInvalidReconciliation = errors.New("invalid Stripe reconciliation input")

	pricePattern        = regexp.MustCompile(`^price_[A-Za-z0-9]+$`)
	secretPattern       = regexp.MustCompile(`^whsec_[A-Za-z0-9]+$`)
	stripeIDPattern     = regexp.MustCompile(`^[A-Za-z0-9_]+$`)
	offerVersionPattern = regexp.MustCompile(`^legal-commerce-v1:\d{4}-\d{2}-\d{2}$`)
	datePattern         = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	hashPattern         = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	uuidV7Pattern       = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
)

func ValidateReconciliationCommand(command ReconciliationCommand) error {
	if _, err := billing.ParseReconciliationSnapshotID(string(command.SnapshotID)); err != nil {
		return ErrInvalidReconciliation
	}
	if _, err := billing.ParseSubscriptionID(string(command.SubscriptionID)); err != nil {
		return ErrInvalidReconciliation
	}
	if !validStripeID(string(command.ProviderCustomerReference), "cus_") ||
		!validStripeID(string(command.ProviderSubscriptionReference), "sub_") ||
		!validMillis(command.ObservedAt) || !validMillis(command.RecordedAt) ||
		command.RecordedAt < command.ObservedAt {
		return ErrInvalidReconciliation
	}
	return nil
}

func (configuration Configuration) Valid() bool {
	return (configuration.Mode == ModeTest || configuration.Mode == ModeLive) &&
		configuration.APIVersion == APIVersion &&
		len(configuration.PriceReference) >= 7 && len(configuration.PriceReference) <= 255 &&
		pricePattern.MatchString(configuration.PriceReference) &&
		validReturnURL(configuration.SuccessURL) && validReturnURL(configuration.CancelURL)
}

func validReturnURL(value string) bool {
	if len(value) < 1 || len(value) > 2_048 || !utf8.ValidString(value) {
		return false
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.IsAbs() == false || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return false
	}
	if parsed.Scheme == "https" {
		return true
	}
	host := parsed.Hostname()
	return parsed.Scheme == "http" && (host == "localhost" || host == "127.0.0.1" || host == "::1")
}

func validWebhookSecret(value string) bool {
	return len(value) >= 22 && len(value) <= 255 && secretPattern.MatchString(value)
}

func validContract(contract HostedCheckoutContract) bool {
	if !uuidV7Pattern.MatchString(contract.EvidenceID) {
		return false
	}
	return hashPattern.MatchString(contract.OfferHash) &&
		offerVersionPattern.MatchString(contract.Offer.OfferVersion) &&
		datePattern.MatchString(contract.Offer.DisclosureVersion) &&
		(contract.Offer.BillingPeriod == BillingMonthly || contract.Offer.BillingPeriod == BillingAnnual) &&
		contract.Offer.RenewalChargeYen >= 1 && contract.Offer.RenewalChargeYen <= 10_000_000
}

func validStripeID(value string, prefix string) bool {
	return len(value) > len(prefix) && len(value) <= 255 && strings.HasPrefix(value, prefix) && stripeIDPattern.MatchString(value)
}

func validMillis(value int64) bool {
	return value >= 0 && value <= 9_007_199_254_740_991
}

func millisFromSeconds(value int64) (int64, bool) {
	if value < 0 || value > 9_007_199_254_740 {
		return 0, false
	}
	return value * 1_000, true
}

func stringValue(values map[string]string, key string) (string, bool) {
	if values == nil {
		return "", false
	}
	value, ok := values[key]
	return value, ok && value != "" && utf8.ValidString(value)
}

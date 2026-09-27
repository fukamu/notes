package billing

import (
	"errors"
	"regexp"
	"unicode/utf8"
)

var (
	ErrInvalidIdentifier = errors.New("invalid billing identifier")

	uuidV7Pattern       = regexp.MustCompile(`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-7[0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$`)
	providerNamePattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
)

type SubscriptionID string
type CheckoutIntentID string
type Provider string
type ProviderEventID string
type ProviderCustomerReference string
type ProviderSubscriptionReference string
type ProviderCheckoutReference string
type ProviderInvoiceReference string
type ReconciliationSnapshotID string
type Version int64

func ParseSubscriptionID(value string) (SubscriptionID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidIdentifier
	}
	return SubscriptionID(value), nil
}

func ParseCheckoutIntentID(value string) (CheckoutIntentID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidIdentifier
	}
	return CheckoutIntentID(value), nil
}

func ParseProvider(value string) (Provider, error) {
	if len(value) < 1 || len(value) > 32 || !providerNamePattern.MatchString(value) {
		return "", ErrInvalidIdentifier
	}
	return Provider(value), nil
}

func ParseProviderEventID(value string) (ProviderEventID, error) {
	if !validProviderReference(value) {
		return "", ErrInvalidIdentifier
	}
	return ProviderEventID(value), nil
}

func ParseProviderCustomerReference(value string) (ProviderCustomerReference, error) {
	if !validProviderReference(value) {
		return "", ErrInvalidIdentifier
	}
	return ProviderCustomerReference(value), nil
}

func ParseProviderSubscriptionReference(value string) (ProviderSubscriptionReference, error) {
	if !validProviderReference(value) {
		return "", ErrInvalidIdentifier
	}
	return ProviderSubscriptionReference(value), nil
}

func ParseProviderCheckoutReference(value string) (ProviderCheckoutReference, error) {
	if !validProviderReference(value) {
		return "", ErrInvalidIdentifier
	}
	return ProviderCheckoutReference(value), nil
}

func ParseProviderInvoiceReference(value string) (ProviderInvoiceReference, error) {
	if !validProviderReference(value) {
		return "", ErrInvalidIdentifier
	}
	return ProviderInvoiceReference(value), nil
}

func ParseReconciliationSnapshotID(value string) (ReconciliationSnapshotID, error) {
	if !validProviderReference(value) {
		return "", ErrInvalidIdentifier
	}
	return ReconciliationSnapshotID(value), nil
}

func ParseVersion(value int64) (Version, error) {
	if value < 1 || value > 2_147_483_647 {
		return 0, ErrInvalidIdentifier
	}
	return Version(value), nil
}

func validProviderReference(value string) bool {
	if len(value) < 1 || len(value) > 255 || !utf8.ValidString(value) {
		return false
	}
	for _, character := range []byte(value) {
		if character < 0x21 || character > 0x7e {
			return false
		}
	}
	return true
}

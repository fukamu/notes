package localfixture

import (
	"errors"
	"net"
	"net/url"
	"strings"

	"github.com/fukamu/notes/backend/internal/access"
	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
)

const (
	DisposableDatabaseName = "fukamu_notes_go_test"
	ObjectDirectoryName    = "objects"
	NonceDirectoryName     = "nonces"
	KeyDirectoryName       = "keys"
	FixtureTimestamp       = int64(1)
)

var ErrInvalidFixture = errors.New("invalid local fixture")

type Seed struct {
	AllowedSubject access.Subject
	Context        identity.VaultContext
	Session        identity.Session
	TokenHash      identity.SessionTokenHash
	Subscription   billing.SubscriptionRecord
	Entitlement    entitlement.ProjectionRecord
	DEK            cryptocontent.VaultDEKMetadata
}

func NewSeed(
	allowedSubject access.Subject,
	accountID identity.AccountID,
	vaultID identity.VaultID,
	sessionID identity.SessionID,
	sessionEpoch identity.SessionEpoch,
	sessionToken identity.SessionToken,
	dek cryptocontent.VaultDEKMetadata,
) (Seed, error) {
	if _, err := access.ParseSubject(string(allowedSubject)); err != nil {
		return Seed{}, ErrInvalidFixture
	}
	context := identity.VaultContext{
		AccountID: accountID, VaultID: vaultID, SessionID: sessionID, SessionEpoch: sessionEpoch,
	}
	if !entitlement.ValidVaultContext(context) || cryptocontent.ValidateVaultDEKMetadata(dek) != nil ||
		dek.VaultID != vaultID || dek.DEKVersion != 1 || dek.CreatedAtMilli != FixtureTimestamp {
		return Seed{}, ErrInvalidFixture
	}
	sessionDecision := identity.CreateActiveSession(identity.SessionInput{
		SessionID: sessionID, AccountID: accountID, VaultID: vaultID, SessionEpoch: sessionEpoch,
		IssuedAt: FixtureTimestamp, ExpiresAt: identity.MaximumSafeInteger,
	})
	if !sessionDecision.Created {
		return Seed{}, ErrInvalidFixture
	}
	tokenHash, err := identity.HashSessionToken(sessionToken)
	if err != nil {
		return Seed{}, ErrInvalidFixture
	}
	version, err := billing.ParseVersion(1)
	if err != nil {
		return Seed{}, ErrInvalidFixture
	}
	provider, err := billing.ParseProvider("local-fixture")
	if err != nil {
		return Seed{}, ErrInvalidFixture
	}
	subscriptionID, err := billing.ParseSubscriptionID(string(accountID))
	if err != nil {
		return Seed{}, ErrInvalidFixture
	}
	customerReference, err := billing.ParseProviderCustomerReference("fixture-customer-" + string(accountID))
	if err != nil {
		return Seed{}, ErrInvalidFixture
	}
	subscriptionReference, err := billing.ParseProviderSubscriptionReference("fixture-subscription-" + string(accountID))
	if err != nil {
		return Seed{}, ErrInvalidFixture
	}
	invoiceReference, err := billing.ParseProviderInvoiceReference("fixture-invoice-" + string(accountID))
	if err != nil {
		return Seed{}, ErrInvalidFixture
	}
	paidAt := FixtureTimestamp
	paymentMethodUpdatedAt := FixtureTimestamp
	subscription := billing.SubscriptionRecord{
		SubscriptionID:                subscriptionID,
		AccountID:                     accountID,
		VaultID:                       vaultID,
		Provider:                      provider,
		ProviderCustomerReference:     customerReference,
		ProviderSubscriptionReference: subscriptionReference,
		Version:                       version,
		Lifecycle: billing.Lifecycle{
			Kind: billing.LifecycleActive, PaidPeriodStartedAt: FixtureTimestamp,
			PaidThrough: identity.MaximumSafeInteger,
		},
		PaymentMethodReady:       true,
		PaymentMethodUpdatedAt:   &paymentMethodUpdatedAt,
		LastPaidAt:               &paidAt,
		LastPaidInvoiceReference: invoiceReference,
		CreatedAt:                FixtureTimestamp,
		UpdatedAt:                FixtureTimestamp,
	}
	if !billing.ValidRecord(subscription) {
		return Seed{}, ErrInvalidFixture
	}
	projectionVersion, err := entitlement.ParseProjectionVersion(1)
	if err != nil {
		return Seed{}, ErrInvalidFixture
	}
	projection := entitlement.ProjectionRecord{
		AccountID:            accountID,
		VaultID:              vaultID,
		Version:              projectionVersion,
		SourceSubscriptionID: subscriptionID,
		SourceBillingVersion: version,
		State: entitlement.State{
			Kind: entitlement.StatePaidActive, ValidUntil: identity.MaximumSafeInteger,
		},
		CheckedAt: FixtureTimestamp,
		CreatedAt: FixtureTimestamp,
		UpdatedAt: FixtureTimestamp,
	}
	if !entitlement.ValidProjectionRecord(projection) {
		return Seed{}, ErrInvalidFixture
	}
	return Seed{
		AllowedSubject: allowedSubject,
		Context:        context, Session: sessionDecision.Session, TokenHash: tokenHash,
		Subscription: subscription, Entitlement: projection, DEK: dek,
	}, nil
}

func ValidSeed(seed Seed) bool {
	if _, err := access.ParseSubject(string(seed.AllowedSubject)); err != nil {
		return false
	}
	if !entitlement.ValidVaultContext(seed.Context) || !identity.ValidSession(seed.Session) ||
		seed.Session.Kind != identity.SessionActive || seed.Session.AccountID != seed.Context.AccountID ||
		seed.Session.VaultID != seed.Context.VaultID || seed.Session.SessionID != seed.Context.SessionID ||
		seed.Session.SessionEpoch != seed.Context.SessionEpoch {
		return false
	}
	if _, err := identity.ParseSessionTokenHash(string(seed.TokenHash)); err != nil {
		return false
	}
	if !billing.ValidRecord(seed.Subscription) ||
		seed.Subscription.AccountID != seed.Context.AccountID || seed.Subscription.VaultID != seed.Context.VaultID {
		return false
	}
	if !entitlement.ValidProjectionRecord(seed.Entitlement) ||
		seed.Entitlement.AccountID != seed.Context.AccountID || seed.Entitlement.VaultID != seed.Context.VaultID ||
		seed.Entitlement.SourceSubscriptionID != seed.Subscription.SubscriptionID ||
		seed.Entitlement.SourceBillingVersion != seed.Subscription.Version {
		return false
	}
	return cryptocontent.ValidateVaultDEKMetadata(seed.DEK) == nil && seed.DEK.VaultID == seed.Context.VaultID
}

func ValidateDatabaseURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") {
		return ErrInvalidFixture
	}
	if parsed.Opaque != "" || parsed.RawPath != "" || parsed.Fragment != "" || parsed.Host == "" {
		return ErrInvalidFixture
	}
	hostname := strings.ToLower(parsed.Hostname())
	if hostname != "localhost" && hostname != "127.0.0.1" && hostname != "::1" {
		return ErrInvalidFixture
	}
	if parsed.Path != "/"+DisposableDatabaseName {
		return ErrInvalidFixture
	}
	for key, values := range parsed.Query() {
		if key != "sslmode" || len(values) != 1 {
			return ErrInvalidFixture
		}
	}
	if port := parsed.Port(); port != "" {
		if _, err := net.LookupPort("tcp", port); err != nil {
			return ErrInvalidFixture
		}
	}
	return nil
}

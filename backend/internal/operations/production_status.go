package operations

import (
	"encoding/hex"
	"errors"
	"strings"
)

var ErrProductionStatus = errors.New("production status invalid")

const productionStatusMaximumSafeInteger int64 = 9_007_199_254_740_991

type ProductionStatusOutcome string

const (
	ProductionStatusBlocked         ProductionStatusOutcome = "blocked"
	ProductionStatusRestrictedEmpty ProductionStatusOutcome = "restricted-empty"
	ProductionStatusRestrictedReady ProductionStatusOutcome = "restricted-ready"
)

type ProductionStatusBlocker string

const (
	ProductionStatusSchemaMismatch     ProductionStatusBlocker = "schema-mismatch"
	ProductionStatusLaunchConfig       ProductionStatusBlocker = "launch-config-invalid"
	ProductionStatusPublicAccess       ProductionStatusBlocker = "public-access-enabled"
	ProductionStatusBillingFlag        ProductionStatusBlocker = "billing-checkout-invalid"
	ProductionStatusBillingEnabled     ProductionStatusBlocker = "billing-checkout-enabled"
	ProductionStatusAccessInconsistent ProductionStatusBlocker = "access-state-inconsistent"
	ProductionStatusCryptoInconsistent ProductionStatusBlocker = "crypto-state-inconsistent"
)

// ProductionStatusFacts contains only non-secret aggregate database state.
// Adapters must not place identifiers, key references, ciphertext, or content
// in this value.
type ProductionStatusFacts struct {
	ObservedAtMillis           int64
	AppliedSchemaVersion       int64
	TargetSchemaVersion        int64
	TargetSchemaChecksum       string
	LaunchConfigRows           int64
	PublicAccessEnabled        bool
	BillingCheckoutFlagRows    int64
	BillingCheckoutEnabled     bool
	Accounts                   int64
	Vaults                     int64
	GoogleIdentities           int64
	AllowedUsers               int64
	ActiveLimitedGrants        int64
	ExpiredUnrevokedGrants     int64
	ActiveSessions             int64
	WrappedKeyVersions         int64
	WriteKeys                  int64
	EncryptedObjects           int64
	PendingEncryptedWrites     int64
	PendingObjectDeletes       int64
	NonceReservations          int64
	AccessInconsistencies      int64
	CryptographicInconsistency int64
}

type ProductionStatusResult struct {
	Outcome  ProductionStatusOutcome
	Facts    ProductionStatusFacts
	Blockers []ProductionStatusBlocker
}

func EvaluateProductionStatus(facts ProductionStatusFacts) (ProductionStatusResult, error) {
	if !validProductionStatusFacts(facts) {
		return ProductionStatusResult{}, ErrProductionStatus
	}
	blockers := make([]ProductionStatusBlocker, 0, 6)
	if facts.AppliedSchemaVersion != facts.TargetSchemaVersion {
		blockers = append(blockers, ProductionStatusSchemaMismatch)
	}
	if facts.AppliedSchemaVersion == facts.TargetSchemaVersion {
		if facts.LaunchConfigRows != 1 {
			blockers = append(blockers, ProductionStatusLaunchConfig)
		} else if facts.PublicAccessEnabled {
			blockers = append(blockers, ProductionStatusPublicAccess)
		}
		if facts.BillingCheckoutFlagRows != 1 {
			blockers = append(blockers, ProductionStatusBillingFlag)
		} else if facts.BillingCheckoutEnabled {
			blockers = append(blockers, ProductionStatusBillingEnabled)
		}
		if facts.AccessInconsistencies != 0 || facts.AllowedUsers != facts.ActiveLimitedGrants {
			blockers = append(blockers, ProductionStatusAccessInconsistent)
		}
		if facts.CryptographicInconsistency != 0 || facts.Vaults != facts.WriteKeys {
			blockers = append(blockers, ProductionStatusCryptoInconsistent)
		}
	}
	outcome := ProductionStatusRestrictedEmpty
	if len(blockers) != 0 {
		outcome = ProductionStatusBlocked
	} else if facts.AllowedUsers > 0 {
		outcome = ProductionStatusRestrictedReady
	}
	return ProductionStatusResult{Outcome: outcome, Facts: facts, Blockers: blockers}, nil
}

func validProductionStatusFacts(facts ProductionStatusFacts) bool {
	digest := strings.TrimPrefix(facts.TargetSchemaChecksum, "sha256:")
	_, digestErr := hex.DecodeString(digest)
	if facts.ObservedAtMillis < 0 || facts.ObservedAtMillis > productionStatusMaximumSafeInteger ||
		facts.AppliedSchemaVersion < 0 || facts.TargetSchemaVersion < 1 ||
		facts.TargetSchemaVersion > productionStatusMaximumSafeInteger ||
		len(facts.TargetSchemaChecksum) != 71 ||
		!strings.HasPrefix(facts.TargetSchemaChecksum, "sha256:") || digestErr != nil ||
		len(digest) != 64 || digest != strings.ToLower(digest) {
		return false
	}
	for _, value := range []int64{
		facts.LaunchConfigRows, facts.BillingCheckoutFlagRows, facts.Accounts,
		facts.Vaults, facts.GoogleIdentities, facts.AllowedUsers,
		facts.ActiveLimitedGrants, facts.ExpiredUnrevokedGrants, facts.ActiveSessions,
		facts.WrappedKeyVersions, facts.WriteKeys, facts.EncryptedObjects,
		facts.PendingEncryptedWrites, facts.PendingObjectDeletes, facts.NonceReservations,
		facts.AccessInconsistencies, facts.CryptographicInconsistency,
	} {
		if value < 0 || value > productionStatusMaximumSafeInteger {
			return false
		}
	}
	return true
}

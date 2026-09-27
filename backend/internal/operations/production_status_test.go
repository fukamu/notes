package operations

import (
	"reflect"
	"strings"
	"testing"
)

func TestEvaluateProductionStatusClassifiesRestrictedStates(t *testing.T) {
	t.Parallel()
	base := validProductionStatusTestFacts()
	result, err := EvaluateProductionStatus(base)
	if err != nil || result.Outcome != ProductionStatusRestrictedEmpty || len(result.Blockers) != 0 {
		t.Fatalf("empty result = %#v, error = %v", result, err)
	}
	base.AllowedUsers = 2
	base.ActiveLimitedGrants = 2
	result, err = EvaluateProductionStatus(base)
	if err != nil || result.Outcome != ProductionStatusRestrictedReady || len(result.Blockers) != 0 {
		t.Fatalf("ready result = %#v, error = %v", result, err)
	}
}

func TestEvaluateProductionStatusReturnsOrderedBlockers(t *testing.T) {
	t.Parallel()
	facts := validProductionStatusTestFacts()
	facts.AppliedSchemaVersion = 17
	result, err := EvaluateProductionStatus(facts)
	if err != nil || !reflect.DeepEqual(result.Blockers, []ProductionStatusBlocker{
		ProductionStatusSchemaMismatch,
	}) {
		t.Fatalf("schema result = %#v, error = %v", result, err)
	}
	facts.AppliedSchemaVersion = facts.TargetSchemaVersion
	facts.LaunchConfigRows = 2
	facts.BillingCheckoutFlagRows = 0
	facts.AccessInconsistencies = 1
	facts.CryptographicInconsistency = 1
	result, err = EvaluateProductionStatus(facts)
	if err != nil || !reflect.DeepEqual(result.Blockers, []ProductionStatusBlocker{
		ProductionStatusLaunchConfig,
		ProductionStatusBillingFlag,
		ProductionStatusAccessInconsistent,
		ProductionStatusCryptoInconsistent,
	}) {
		t.Fatalf("blocked result = %#v, error = %v", result, err)
	}
}

func TestEvaluateProductionStatusRejectsMalformedFacts(t *testing.T) {
	t.Parallel()
	tests := map[string]ProductionStatusFacts{
		"negative observed time": func() ProductionStatusFacts {
			value := validProductionStatusTestFacts()
			value.ObservedAtMillis = -1
			return value
		}(),
		"bad checksum": func() ProductionStatusFacts {
			value := validProductionStatusTestFacts()
			value.TargetSchemaChecksum = "sha256:bad"
			return value
		}(),
		"negative count": func() ProductionStatusFacts {
			value := validProductionStatusTestFacts()
			value.AllowedUsers = -1
			return value
		}(),
	}
	for name, facts := range tests {
		facts := facts
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := EvaluateProductionStatus(facts); err == nil {
				t.Fatal("malformed facts accepted")
			}
		})
	}
}

func validProductionStatusTestFacts() ProductionStatusFacts {
	return ProductionStatusFacts{
		ObservedAtMillis: 1_000, AppliedSchemaVersion: 18, TargetSchemaVersion: 18,
		TargetSchemaChecksum: "sha256:" + strings.Repeat("a", 64),
		LaunchConfigRows:     1, BillingCheckoutFlagRows: 1,
	}
}

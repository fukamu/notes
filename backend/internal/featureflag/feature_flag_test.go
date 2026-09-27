package featureflag_test

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/featureflag"
	"github.com/fukamu/notes/backend/internal/identity"
)

type flagReader struct {
	facts featureflag.Facts
	err   error
}

func (reader flagReader) Read(
	context.Context,
	featureflag.Name,
	identity.AccountID,
) (featureflag.Facts, error) {
	return reader.facts, reader.err
}

func TestEvaluateFeatureFlagFailsClosedAndSupportsGlobalOrAccountEnablement(t *testing.T) {
	t.Parallel()
	for name, testCase := range map[string]struct {
		facts featureflag.Facts
		want  featureflag.DecisionKind
	}{
		"unconfigured": {facts: featureflag.Facts{}, want: featureflag.DecisionDisabled},
		"configured off": {
			facts: featureflag.Facts{Configured: true}, want: featureflag.DecisionDisabled,
		},
		"global": {
			facts: featureflag.Facts{Configured: true, GloballyEnabled: true},
			want:  featureflag.DecisionEnabled,
		},
		"account": {
			facts: featureflag.Facts{Configured: true, AccountEnabled: true},
			want:  featureflag.DecisionEnabled,
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			decision := featureflag.Evaluate(featureflag.BillingCheckout, testCase.facts)
			if decision.Kind != testCase.want || decision.Name != featureflag.BillingCheckout {
				t.Fatalf("decision = %#v", decision)
			}
		})
	}
	if decision := featureflag.Evaluate("Invalid", featureflag.Facts{
		Configured: true, GloballyEnabled: true, AccountEnabled: true,
	}); decision.Kind != featureflag.DecisionDisabled {
		t.Fatalf("invalid flag decision = %#v", decision)
	}
}

func TestFeatureFlagServiceKeepsUnknownOffAndPropagatesStoreFailure(t *testing.T) {
	t.Parallel()
	accountID, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000101")
	service, err := featureflag.NewService(flagReader{facts: featureflag.Facts{
		Configured: true, AccountEnabled: true,
	}})
	if err != nil {
		t.Fatal(err)
	}
	unknown, err := service.Evaluate(context.Background(), "Unknown", accountID)
	if err != nil || unknown.Kind != featureflag.DecisionDisabled {
		t.Fatalf("unknown = %#v, %v", unknown, err)
	}
	wantErr := errors.New("database unavailable")
	failing, _ := featureflag.NewService(flagReader{err: wantErr})
	decision, err := failing.Evaluate(context.Background(), featureflag.BillingCheckout, accountID)
	if !errors.Is(err, wantErr) || decision.Kind != featureflag.DecisionDisabled {
		t.Fatalf("failure = %#v, %v", decision, err)
	}
}

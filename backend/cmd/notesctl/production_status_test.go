package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/operations"
)

func TestRunProductionStatusEmitsOnlyRedactedAggregateEvidence(t *testing.T) {
	t.Parallel()
	values := productionStatusEnvironment(
		"production", "postgres://notes:secret@db.example/notes?sslmode=require",
	)
	called := false
	code, stdout, stderr := runProductionStatusForTest(
		t, productionStatusCLIArguments(), values,
		func(_ context.Context, databaseURL string, observedAt int64) (operations.ProductionStatusResult, error) {
			called = strings.Contains(databaseURL, "secret") && observedAt == 5_000
			facts := validProductionStatusFactsForCLI()
			facts.AllowedUsers = 1
			facts.ActiveLimitedGrants = 1
			facts.Accounts = 1
			facts.Vaults = 1
			facts.GoogleIdentities = 1
			facts.WrappedKeyVersions = 1
			facts.WriteKeys = 1
			return operations.EvaluateProductionStatus(facts)
		},
	)
	if code != 0 || !called || stderr != "" {
		t.Fatalf("code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout, stderr)
	}
	var output struct {
		Command              string `json:"command"`
		Outcome              string `json:"outcome"`
		AllowedUsers         int64  `json:"allowedUsers"`
		ActiveLimitedGrants  int64  `json:"activeLimitedGrants"`
		TargetSchemaChecksum string `json:"targetSchemaChecksum"`
	}
	if err := json.Unmarshal([]byte(stdout), &output); err != nil ||
		output.Command != "production-status" || output.Outcome != "restricted-ready" ||
		output.AllowedUsers != 1 || output.ActiveLimitedGrants != 1 ||
		len(output.TargetSchemaChecksum) != 71 {
		t.Fatalf("output = %#v, error = %v", output, err)
	}
	for _, forbidden := range []string{"secret", "db.example", "postgres://", "accountId", "vaultId", "subject"} {
		if strings.Contains(stdout+stderr, forbidden) {
			t.Fatalf("output disclosed %q: %q %q", forbidden, stdout, stderr)
		}
	}
}

func TestRunProductionStatusReturnsBlockedEvidenceAsFailure(t *testing.T) {
	t.Parallel()
	values := productionStatusEnvironment(
		"production", "postgres://notes:secret@db.example/notes?sslmode=verify-full",
	)
	code, stdout, stderr := runProductionStatusForTest(
		t, productionStatusCLIArguments(), values,
		func(context.Context, string, int64) (operations.ProductionStatusResult, error) {
			facts := validProductionStatusFactsForCLI()
			facts.PublicAccessEnabled = true
			return operations.EvaluateProductionStatus(facts)
		},
	)
	if code != 1 || stderr != "" || !strings.Contains(stdout, `"outcome":"blocked"`) ||
		!strings.Contains(stdout, `"public-access-enabled"`) {
		t.Fatalf("code = %d, stdout = %q, stderr = %q", code, stdout, stderr)
	}
}

func TestRunProductionStatusRejectsMalformedArgumentsBeforeInspection(t *testing.T) {
	t.Parallel()
	valid := productionStatusCLIArguments()
	tests := map[string][]string{
		"missing confirmation": removeCLIArgument(valid, "--confirm-production-read-only"),
		"duplicate confirmation": append(
			append([]string(nil), valid...), "--confirm-production-read-only",
		),
		"wrong environment": replaceCLIArgument(valid, "--environment=", "--environment=test"),
		"bad timestamp":     replaceCLIArgument(valid, "--observed-at-millis=", "--observed-at-millis=-1"),
		"unknown":           append(append([]string(nil), valid...), "--other=value"),
	}
	for name, arguments := range tests {
		arguments := arguments
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			called := false
			code, stdout, stderr := runProductionStatusForTest(
				t, arguments,
				productionStatusEnvironment("production", "postgres://notes:secret@db.example/notes?sslmode=require"),
				func(context.Context, string, int64) (operations.ProductionStatusResult, error) {
					called = true
					return operations.ProductionStatusResult{}, nil
				},
			)
			if code != 2 || called || stdout != "" || !strings.Contains(stderr, "usage:") {
				t.Fatalf("code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout, stderr)
			}
		})
	}
}

func TestRunProductionStatusRefusesConfigurationTargetAndDependencyFailure(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		values  map[string]string
		want    string
		inspect productionStatusFunction
	}{
		{
			name: "environment", want: "configuration invalid\n",
			values: productionStatusEnvironment(
				"test", "postgres://notes:secret@db.example/notes?sslmode=require",
			),
		},
		{
			name: "target", want: "target refused\n",
			values: productionStatusEnvironment(
				"production", "postgres://notes:secret@other.example/notes?sslmode=require",
			),
		},
		{
			name: "dependency", want: "inspection failed\n",
			values: productionStatusEnvironment(
				"production", "postgres://notes:secret@db.example/notes?sslmode=require",
			),
			inspect: func(context.Context, string, int64) (operations.ProductionStatusResult, error) {
				return operations.ProductionStatusResult{}, errors.New("PRIVATE-DB-FAILURE")
			},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			called := false
			inspect := test.inspect
			if inspect == nil {
				inspect = func(context.Context, string, int64) (operations.ProductionStatusResult, error) {
					called = true
					return operations.ProductionStatusResult{}, nil
				}
			}
			code, stdout, stderr := runProductionStatusForTest(
				t, productionStatusCLIArguments(), test.values, inspect,
			)
			if code != 1 || stdout != "" || !strings.Contains(stderr, test.want) ||
				strings.Contains(stderr, "secret") || strings.Contains(stderr, "PRIVATE") || called {
				t.Fatalf("code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout, stderr)
			}
		})
	}
}

func runProductionStatusForTest(
	t *testing.T,
	arguments []string,
	values map[string]string,
	inspect productionStatusFunction,
) (int, string, string) {
	t.Helper()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := runProductionStatus(
		context.Background(), arguments, &stdout, &stderr,
		func(key string) (string, bool) { value, ok := values[key]; return value, ok },
		inspect,
	)
	return code, stdout.String(), stderr.String()
}

func productionStatusEnvironment(environment, databaseURL string) map[string]string {
	return map[string]string{"NOTES_ENVIRONMENT": environment, "NOTES_DATABASE_URL": databaseURL}
}

func productionStatusCLIArguments() []string {
	return []string{
		"production", "status", "--environment=production", "--observed-at-millis=5000",
		"--expected-database-host=db.example", "--expected-database-name=notes",
		"--confirm-production-read-only",
	}
}

func validProductionStatusFactsForCLI() operations.ProductionStatusFacts {
	return operations.ProductionStatusFacts{
		ObservedAtMillis: 5_000, AppliedSchemaVersion: 18, TargetSchemaVersion: 18,
		TargetSchemaChecksum: "sha256:" + strings.Repeat("a", 64),
		LaunchConfigRows:     1, BillingCheckoutFlagRows: 1,
	}
}

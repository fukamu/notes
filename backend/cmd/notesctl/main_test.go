package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/operations"
	"github.com/fukamu/notes/backend/internal/quota"
)

func TestRunRejectsUnknownCommand(t *testing.T) {
	t.Parallel()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := run(context.Background(), []string{"migrate"}, &stdout, &stderr); code != 2 {
		t.Fatalf("exit code = %d", code)
	}
	if stdout.Len() != 0 || !strings.Contains(stderr.String(), "usage:") {
		t.Fatalf("stdout = %q, stderr = %q", stdout.String(), stderr.String())
	}
}

func TestRunMigratesOnlyTheExplicitAllowlistedEnvironment(t *testing.T) {
	t.Parallel()
	values := map[string]string{
		"NOTES_ENVIRONMENT":  "test",
		"NOTES_DATABASE_URL": "postgres://notes:secret@127.0.0.1:5432/fukamu_notes_go_test",
	}
	called := false
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := runWithDependencies(
		context.Background(),
		[]string{"migrate", "--environment=test"},
		&stdout,
		&stderr,
		func(key string) (string, bool) { value, ok := values[key]; return value, ok },
		func(_ context.Context, databaseURL string) error {
			called = true
			if !strings.Contains(databaseURL, "secret") {
				t.Fatal("migration did not receive the configured URL")
			}
			return nil
		},
		func(context.Context, string, string) error { t.Fatal("e2e preparation must not run"); return nil },
		func(context.Context, string, operations.QuotaCandidateQuery) (operations.QuotaAuditResult, error) {
			t.Fatal("quota audit must not run")
			return operations.QuotaAuditResult{}, nil
		},
	)
	if code != 0 || !called || stdout.String() != "migration complete\n" || stderr.Len() != 0 {
		t.Fatalf("code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout.String(), stderr.String())
	}
}

func TestRunRefusesMigrationEnvironmentMismatchWithoutDisclosingURL(t *testing.T) {
	t.Parallel()
	values := map[string]string{
		"NOTES_ENVIRONMENT":  "test",
		"NOTES_DATABASE_URL": "postgres://notes:secret@127.0.0.1:5432/fukamu_notes_go_test",
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := runWithDependencies(
		context.Background(),
		[]string{"migrate", "--environment=local"},
		&stdout,
		&stderr,
		func(key string) (string, bool) { value, ok := values[key]; return value, ok },
		func(context.Context, string) error { t.Fatal("migration must not run"); return nil },
		func(context.Context, string, string) error { t.Fatal("e2e preparation must not run"); return nil },
		func(context.Context, string, operations.QuotaCandidateQuery) (operations.QuotaAuditResult, error) {
			t.Fatal("quota audit must not run")
			return operations.QuotaAuditResult{}, nil
		},
	)
	if code != 1 || stdout.Len() != 0 || !strings.Contains(stderr.String(), "refused") {
		t.Fatalf("code = %d, stdout = %q, stderr = %q", code, stdout.String(), stderr.String())
	}
	if strings.Contains(stderr.String(), "secret") {
		t.Fatal("migration refusal disclosed credentials")
	}
}

func TestRunPreparesOnlyTheAllowlistedE2EDatabase(t *testing.T) {
	t.Parallel()
	values := map[string]string{
		"NOTES_ENVIRONMENT":  "test",
		"NOTES_DATABASE_URL": "postgres://notes:secret@127.0.0.1:5432/fukamu_notes_go_test",
	}
	called := false
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := runWithDependencies(
		context.Background(),
		[]string{"prepare-e2e", "--environment=test", "--allowed-subject=fukamu-notes-e2e-user"},
		&stdout,
		&stderr,
		func(key string) (string, bool) { value, ok := values[key]; return value, ok },
		func(context.Context, string) error { t.Fatal("migration must not run"); return nil },
		func(_ context.Context, databaseURL string, subject string) error {
			called = true
			if !strings.Contains(databaseURL, "secret") || subject != "fukamu-notes-e2e-user" {
				t.Fatal("prepare-e2e did not receive validated inputs")
			}
			return nil
		},
		func(context.Context, string, operations.QuotaCandidateQuery) (operations.QuotaAuditResult, error) {
			t.Fatal("quota audit must not run")
			return operations.QuotaAuditResult{}, nil
		},
	)
	if code != 0 || !called || stdout.String() != "e2e database prepared\n" || stderr.Len() != 0 {
		t.Fatalf("code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout.String(), stderr.String())
	}
}

func TestRunChecksConfigurationWithoutPrintingValues(t *testing.T) {
	staticDirectory := t.TempDir()
	t.Setenv("NOTES_ENVIRONMENT", "test")
	t.Setenv("NOTES_HTTP_ADDR", "127.0.0.1:8080")
	t.Setenv("NOTES_STATIC_DIR", staticDirectory)

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := run(context.Background(), []string{"config", "check"}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr.String())
	}
	if stdout.String() != "configuration valid\n" {
		t.Fatalf("stdout = %q", stdout.String())
	}
	if strings.Contains(stdout.String(), filepath.Base(staticDirectory)) {
		t.Fatal("config check printed a configuration value")
	}
}

func TestRunFailsClosedWithoutConfiguration(t *testing.T) {
	for _, key := range []string{
		"NOTES_ENVIRONMENT",
		"NOTES_HTTP_ADDR",
		"NOTES_STATIC_DIR",
	} {
		t.Setenv(key, "")
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := run(context.Background(), []string{"config", "check"}, &stdout, &stderr); code != 1 {
		t.Fatalf("exit code = %d", code)
	}
	if stderr.String() != "configuration invalid\n" {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestRunListsQuotaCandidatesWithMinimalStableJSON(t *testing.T) {
	t.Parallel()
	values := quotaAuditEnvironment("test", "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable")
	reservationID, _ := quota.ParseReservationID("01991f20-61d2-7000-8000-000000000401")
	called := false
	code, stdout, stderr := runQuotaAuditForTest(
		t,
		context.Background(),
		quotaAuditCLIArguments("test"),
		values,
		func(_ context.Context, databaseURL string, query operations.QuotaCandidateQuery) (operations.QuotaAuditResult, error) {
			called = true
			if !strings.Contains(databaseURL, "secret") || query.AsOfMillis != 5_000 || query.Limit != 2 {
				t.Fatalf("database URL or query = %q, %#v", databaseURL, query)
			}
			return operations.QuotaAuditResult{
				Kind: operations.QuotaAuditListed, AsOfMillis: query.AsOfMillis,
				Candidates: []operations.QuotaCandidate{{ReservationID: reservationID, ReconcileAfter: 4_000}},
			}, nil
		},
	)
	if code != 0 || !called || stderr != "" {
		t.Fatalf("code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout, stderr)
	}
	var output struct {
		Command        string `json:"command"`
		AsOfMillis     int64  `json:"asOfMillis"`
		CandidateCount int    `json:"candidateCount"`
		Candidates     []struct {
			ReservationID  string `json:"reservationId"`
			ReconcileAfter int64  `json:"reconcileAfter"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal([]byte(stdout), &output); err != nil ||
		output.Command != "quota-reconcile-list" || output.AsOfMillis != 5_000 ||
		output.CandidateCount != 1 || len(output.Candidates) != 1 ||
		output.Candidates[0].ReservationID != string(reservationID) || output.Candidates[0].ReconcileAfter != 4_000 {
		t.Fatalf("output = %#v, error = %v", output, err)
	}
	for _, forbidden := range []string{
		"secret", "01991f20-61d2-7000-8000-000000000101", "01991f20-61d2-7000-8000-000000000201",
	} {
		if strings.Contains(stdout+stderr, forbidden) {
			t.Fatalf("output disclosed %q: %q %q", forbidden, stdout, stderr)
		}
	}
}

func TestRunQuotaAuditRejectsMalformedArgumentsBeforeDatabaseAccess(t *testing.T) {
	t.Parallel()
	valid := quotaAuditCLIArguments("test")
	tests := map[string][]string{
		"missing":                valid[:len(valid)-1],
		"duplicate":              append(append([]string(nil), valid...), "--limit=1"),
		"invalid account":        replaceCLIArgument(valid, "--account-id=", "--account-id=invalid"),
		"invalid vault":          replaceCLIArgument(valid, "--vault-id=", "--vault-id=invalid"),
		"invalid timestamp":      replaceCLIArgument(valid, "--as-of-millis=", "--as-of-millis=-1"),
		"invalid limit":          replaceCLIArgument(valid, "--limit=", "--limit=101"),
		"unknown":                append(append([]string(nil), valid...), "--other=value"),
		"production unconfirmed": quotaAuditCLIArguments("production"),
		"test with confirmation": append(append([]string(nil), valid...), "--confirm-production-read-only"),
	}
	for name, arguments := range tests {
		name, arguments := name, arguments
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			called := false
			code, stdout, stderr := runQuotaAuditForTest(
				t, context.Background(), arguments,
				quotaAuditEnvironment("test", "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test"),
				func(context.Context, string, operations.QuotaCandidateQuery) (operations.QuotaAuditResult, error) {
					called = true
					return operations.QuotaAuditResult{}, nil
				},
			)
			if code != 2 || called || stdout != "" || !strings.Contains(stderr, "usage:") {
				t.Fatalf("code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout, stderr)
			}
		})
	}
}

func TestRunQuotaAuditRefusesEnvironmentAndUnsafeTarget(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		values map[string]string
	}{
		{
			name: "environment mismatch",
			values: quotaAuditEnvironment(
				"local", "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test",
			),
		},
		{
			name: "non-loopback test target",
			values: quotaAuditEnvironment(
				"test", "postgres://notes:secret@database.example/fukamu_notes_go_test",
			),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			called := false
			code, stdout, stderr := runQuotaAuditForTest(
				t, context.Background(), quotaAuditCLIArguments("test"), test.values,
				func(context.Context, string, operations.QuotaCandidateQuery) (operations.QuotaAuditResult, error) {
					called = true
					return operations.QuotaAuditResult{}, nil
				},
			)
			if code != 1 || called || stdout != "" || !strings.Contains(stderr, "refused") ||
				strings.Contains(stderr, "secret") {
				t.Fatalf("code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout, stderr)
			}
		})
	}
}

func TestRunQuotaAuditRequiresExplicitProductionConfirmation(t *testing.T) {
	t.Parallel()
	arguments := append(quotaAuditCLIArguments("production"), "--confirm-production-read-only")
	called := false
	code, stdout, stderr := runQuotaAuditForTest(
		t, context.Background(), arguments,
		quotaAuditEnvironment("production", "postgres://notes:secret@database.example/notes"),
		func(_ context.Context, databaseURL string, query operations.QuotaCandidateQuery) (operations.QuotaAuditResult, error) {
			called = strings.Contains(databaseURL, "database.example") && query.Limit == 2
			return operations.QuotaAuditResult{Kind: operations.QuotaAuditListed, AsOfMillis: query.AsOfMillis}, nil
		},
	)
	if code != 0 || !called || stderr != "" || !strings.Contains(stdout, `"candidateCount":0`) ||
		strings.Contains(stdout+stderr, "secret") {
		t.Fatalf("code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout, stderr)
	}
}

func TestRunQuotaAuditMapsRefusalFailureAndCancellationToFixedMessages(t *testing.T) {
	t.Parallel()
	values := quotaAuditEnvironment("test", "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test")
	tests := []struct {
		name string
		ctx  context.Context
		list listQuotaCandidatesFunction
		want string
	}{
		{
			name: "scope refusal", ctx: context.Background(), want: "quota reconciliation scope refused\n",
			list: func(_ context.Context, _ string, query operations.QuotaCandidateQuery) (operations.QuotaAuditResult, error) {
				return operations.QuotaAuditResult{
					Kind: operations.QuotaAuditRefused, Reason: operations.QuotaAuditOwnerMismatch,
					AsOfMillis: query.AsOfMillis,
				}, nil
			},
		},
		{
			name: "dependency failure", ctx: context.Background(), want: "quota reconciliation audit failed\n",
			list: func(context.Context, string, operations.QuotaCandidateQuery) (operations.QuotaAuditResult, error) {
				return operations.QuotaAuditResult{}, errors.New("PRIVATE-DB-FAILURE")
			},
		},
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	tests = append(tests, struct {
		name string
		ctx  context.Context
		list listQuotaCandidatesFunction
		want string
	}{
		name: "cancelled", ctx: cancelled, want: "quota reconciliation audit failed\n",
		list: func(ctx context.Context, _ string, _ operations.QuotaCandidateQuery) (operations.QuotaAuditResult, error) {
			return operations.QuotaAuditResult{}, ctx.Err()
		},
	})
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			code, stdout, stderr := runQuotaAuditForTest(
				t, test.ctx, quotaAuditCLIArguments("test"), values, test.list,
			)
			if code != 1 || stdout != "" || stderr != test.want || strings.Contains(stderr, "PRIVATE") {
				t.Fatalf("code = %d, stdout = %q, stderr = %q", code, stdout, stderr)
			}
		})
	}
}

func runQuotaAuditForTest(
	t *testing.T,
	ctx context.Context,
	arguments []string,
	values map[string]string,
	list listQuotaCandidatesFunction,
) (int, string, string) {
	t.Helper()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := runWithDependencies(
		ctx, arguments, &stdout, &stderr,
		func(key string) (string, bool) { value, ok := values[key]; return value, ok },
		func(context.Context, string) error { t.Fatal("migration must not run"); return nil },
		func(context.Context, string, string) error { t.Fatal("e2e preparation must not run"); return nil },
		list,
	)
	return code, stdout.String(), stderr.String()
}

func quotaAuditEnvironment(environment, databaseURL string) map[string]string {
	return map[string]string{"NOTES_ENVIRONMENT": environment, "NOTES_DATABASE_URL": databaseURL}
}

func quotaAuditCLIArguments(environment string) []string {
	return []string{
		"quota", "reconcile-list", "--limit=2",
		"--vault-id=01991f20-61d2-7000-8000-000000000201",
		"--environment=" + environment,
		"--as-of-millis=5000",
		"--account-id=01991f20-61d2-7000-8000-000000000101",
	}
}

func replaceCLIArgument(arguments []string, prefix, replacement string) []string {
	result := append([]string(nil), arguments...)
	for index, argument := range result {
		if strings.HasPrefix(argument, prefix) {
			result[index] = replacement
			return result
		}
	}
	return result
}

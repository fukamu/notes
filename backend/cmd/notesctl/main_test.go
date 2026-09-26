package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/operations"
	"github.com/fukamu/notes/backend/internal/quota"
	"github.com/fukamu/notes/backend/internal/stripebilling"
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
		func(context.Context, string, operations.QuotaCommitCommand) (operations.QuotaCommitResult, error) {
			t.Fatal("quota commit must not run")
			return operations.QuotaCommitResult{}, nil
		},
		func(context.Context, string, operations.AccountDeletionAuditQuery) (operations.AccountDeletionAuditResult, error) {
			t.Fatal("account deletion audit must not run")
			return operations.AccountDeletionAuditResult{}, nil
		},
		billingReconciliationMustNotRun(t),
		dekRotationMustNotRun(t),
		dekReencryptionMustNotRun(t),
		orphanScanMustNotRun(t),
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
		func(context.Context, string, operations.QuotaCommitCommand) (operations.QuotaCommitResult, error) {
			t.Fatal("quota commit must not run")
			return operations.QuotaCommitResult{}, nil
		},
		func(context.Context, string, operations.AccountDeletionAuditQuery) (operations.AccountDeletionAuditResult, error) {
			t.Fatal("account deletion audit must not run")
			return operations.AccountDeletionAuditResult{}, nil
		},
		billingReconciliationMustNotRun(t),
		dekRotationMustNotRun(t),
		dekReencryptionMustNotRun(t),
		orphanScanMustNotRun(t),
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
		func(context.Context, string, operations.QuotaCommitCommand) (operations.QuotaCommitResult, error) {
			t.Fatal("quota commit must not run")
			return operations.QuotaCommitResult{}, nil
		},
		func(context.Context, string, operations.AccountDeletionAuditQuery) (operations.AccountDeletionAuditResult, error) {
			t.Fatal("account deletion audit must not run")
			return operations.AccountDeletionAuditResult{}, nil
		},
		billingReconciliationMustNotRun(t),
		dekRotationMustNotRun(t),
		dekReencryptionMustNotRun(t),
		orphanScanMustNotRun(t),
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
		func(context.Context, string, operations.QuotaCommitCommand) (operations.QuotaCommitResult, error) {
			t.Fatal("quota commit must not run")
			return operations.QuotaCommitResult{}, nil
		},
		func(context.Context, string, operations.AccountDeletionAuditQuery) (operations.AccountDeletionAuditResult, error) {
			t.Fatal("account deletion audit must not run")
			return operations.AccountDeletionAuditResult{}, nil
		},
		billingReconciliationMustNotRun(t),
		dekRotationMustNotRun(t),
		dekReencryptionMustNotRun(t),
		orphanScanMustNotRun(t),
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

func TestRunCommitsQuotaOnlyThroughConfirmedEvidenceCommand(t *testing.T) {
	t.Parallel()
	values := quotaAuditEnvironment("test", "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test")
	called := false
	code, stdout, stderr := runQuotaCommitForTest(
		t, context.Background(), quotaCommitCLIArguments("test"), values,
		func(_ context.Context, databaseURL string, command operations.QuotaCommitCommand) (operations.QuotaCommitResult, error) {
			called = strings.Contains(databaseURL, "secret") && command.FinalizedAt == 5_000
			return operations.QuotaCommitResult{
				Kind:          operations.QuotaCommitCommitted,
				ReservationID: command.ReservationID, FinalizedAt: command.FinalizedAt,
			}, nil
		},
	)
	if code != 0 || !called || stderr != "" {
		t.Fatalf("code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout, stderr)
	}
	var output struct {
		Command       string `json:"command"`
		Outcome       string `json:"outcome"`
		ReservationID string `json:"reservationId"`
		FinalizedAt   int64  `json:"finalizedAt"`
	}
	if err := json.Unmarshal([]byte(stdout), &output); err != nil ||
		output.Command != "quota-reconcile-commit" || output.Outcome != "committed" ||
		output.ReservationID != "01991f20-61d2-7000-8000-000000000401" || output.FinalizedAt != 5_000 {
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

func TestRunQuotaCommitRejectsMalformedOrUnconfirmedArgumentsBeforeMutation(t *testing.T) {
	t.Parallel()
	valid := quotaCommitCLIArguments("test")
	tests := map[string][]string{
		"missing evidence confirmation":   removeCLIArgument(valid, "--confirm-durable-sync-receipt"),
		"duplicate evidence confirmation": append(append([]string(nil), valid...), "--confirm-durable-sync-receipt"),
		"missing value":                   valid[:len(valid)-1],
		"invalid reservation": replaceCLIArgument(
			valid, "--reservation-id=", "--reservation-id=invalid",
		),
		"invalid timestamp": replaceCLIArgument(
			valid, "--finalized-at-millis=", "--finalized-at-millis=-1",
		),
		"test production confirmation": append(append([]string(nil), valid...), "--confirm-production-mutation"),
		"production unconfirmed":       quotaCommitCLIArguments("production"),
	}
	for name, arguments := range tests {
		name, arguments := name, arguments
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			called := false
			code, stdout, stderr := runQuotaCommitForTest(
				t, context.Background(), arguments,
				quotaAuditEnvironment("test", "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test"),
				func(context.Context, string, operations.QuotaCommitCommand) (operations.QuotaCommitResult, error) {
					called = true
					return operations.QuotaCommitResult{}, nil
				},
			)
			if code != 2 || called || stdout != "" || !strings.Contains(stderr, "usage:") {
				t.Fatalf("code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout, stderr)
			}
		})
	}
}

func TestRunQuotaCommitMapsRefusalFailureAndCancellationToFixedMessages(t *testing.T) {
	t.Parallel()
	values := quotaAuditEnvironment("test", "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test")
	tests := []struct {
		name     string
		ctx      context.Context
		finalize finalizeQuotaCommitFunction
		want     string
	}{
		{
			name: "refused", ctx: context.Background(), want: "quota reconciliation commit refused\n",
			finalize: func(_ context.Context, _ string, command operations.QuotaCommitCommand) (operations.QuotaCommitResult, error) {
				return operations.QuotaCommitResult{
					Kind: operations.QuotaCommitRefused, Reason: operations.QuotaCommitEvidenceMissing,
					ReservationID: command.ReservationID,
				}, nil
			},
		},
		{
			name: "dependency", ctx: context.Background(), want: "quota reconciliation commit failed\n",
			finalize: func(context.Context, string, operations.QuotaCommitCommand) (operations.QuotaCommitResult, error) {
				return operations.QuotaCommitResult{}, errors.New("PRIVATE-DB-FAILURE")
			},
		},
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	tests = append(tests, struct {
		name     string
		ctx      context.Context
		finalize finalizeQuotaCommitFunction
		want     string
	}{
		name: "cancelled", ctx: cancelled, want: "quota reconciliation commit failed\n",
		finalize: func(ctx context.Context, _ string, _ operations.QuotaCommitCommand) (operations.QuotaCommitResult, error) {
			return operations.QuotaCommitResult{}, ctx.Err()
		},
	})
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			code, stdout, stderr := runQuotaCommitForTest(
				t, test.ctx, quotaCommitCLIArguments("test"), values, test.finalize,
			)
			if code != 1 || stdout != "" || stderr != test.want || strings.Contains(stderr, "PRIVATE") {
				t.Fatalf("code = %d, stdout = %q, stderr = %q", code, stdout, stderr)
			}
		})
	}
}

func TestRunQuotaCommitRequiresExplicitProductionMutationConfirmation(t *testing.T) {
	t.Parallel()
	arguments := append(quotaCommitCLIArguments("production"), "--confirm-production-mutation")
	called := false
	code, stdout, stderr := runQuotaCommitForTest(
		t, context.Background(), arguments,
		quotaAuditEnvironment("production", "postgres://notes:secret@database.example/notes"),
		func(_ context.Context, databaseURL string, command operations.QuotaCommitCommand) (operations.QuotaCommitResult, error) {
			called = strings.Contains(databaseURL, "database.example")
			return operations.QuotaCommitResult{
				Kind:          operations.QuotaCommitReplayed,
				ReservationID: command.ReservationID, FinalizedAt: command.FinalizedAt,
			}, nil
		},
	)
	if code != 0 || !called || stderr != "" || !strings.Contains(stdout, `"outcome":"replayed"`) ||
		strings.Contains(stdout+stderr, "secret") {
		t.Fatalf("code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout, stderr)
	}
}

func runQuotaCommitForTest(
	t *testing.T,
	ctx context.Context,
	arguments []string,
	values map[string]string,
	finalize finalizeQuotaCommitFunction,
) (int, string, string) {
	t.Helper()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := runWithDependencies(
		ctx, arguments, &stdout, &stderr,
		func(key string) (string, bool) { value, ok := values[key]; return value, ok },
		func(context.Context, string) error { t.Fatal("migration must not run"); return nil },
		func(context.Context, string, string) error { t.Fatal("e2e preparation must not run"); return nil },
		func(context.Context, string, operations.QuotaCandidateQuery) (operations.QuotaAuditResult, error) {
			t.Fatal("quota audit must not run")
			return operations.QuotaAuditResult{}, nil
		},
		finalize,
		func(context.Context, string, operations.AccountDeletionAuditQuery) (operations.AccountDeletionAuditResult, error) {
			t.Fatal("account deletion audit must not run")
			return operations.AccountDeletionAuditResult{}, nil
		},
		billingReconciliationMustNotRun(t),
		dekRotationMustNotRun(t),
		dekReencryptionMustNotRun(t),
		orphanScanMustNotRun(t),
	)
	return code, stdout.String(), stderr.String()
}

func quotaCommitCLIArguments(environment string) []string {
	return []string{
		"quota", "reconcile-commit",
		"--reservation-id=01991f20-61d2-7000-8000-000000000401",
		"--vault-id=01991f20-61d2-7000-8000-000000000201",
		"--environment=" + environment,
		"--finalized-at-millis=5000",
		"--account-id=01991f20-61d2-7000-8000-000000000101",
		"--confirm-durable-sync-receipt",
	}
}

func removeCLIArgument(arguments []string, value string) []string {
	result := make([]string, 0, len(arguments))
	for _, argument := range arguments {
		if argument != value {
			result = append(result, argument)
		}
	}
	return result
}

func TestRunInspectsAccountDeletionWithMinimalStableJSON(t *testing.T) {
	t.Parallel()
	values := quotaAuditEnvironment("test", "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test")
	operationID := "01991f20-61d2-7000-8000-000000000301"
	called := false
	code, stdout, stderr := runAccountDeletionAuditForTest(
		t, context.Background(), accountDeletionAuditCLIArguments("test"), values,
		func(_ context.Context, databaseURL string, query operations.AccountDeletionAuditQuery) (operations.AccountDeletionAuditResult, error) {
			called = strings.Contains(databaseURL, "secret") && query.ObservedAt == 5_000
			parsedOperationID, _ := accountdeletion.ParseOperationID(operationID)
			return operations.AccountDeletionAuditResult{
				Kind: operations.AccountDeletionAuditInspected, OperationID: parsedOperationID,
				State: operations.AccountDeletionRetryDue, Step: accountdeletion.StepCancelSubscription,
				ReadyToAdvance: true, RelevantAt: 4_900, ObservedAt: query.ObservedAt,
			}, nil
		},
	)
	if code != 0 || !called || stderr != "" {
		t.Fatalf("code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout, stderr)
	}
	var output struct {
		Command        string `json:"command"`
		OperationID    string `json:"operationId"`
		State          string `json:"state"`
		Step           string `json:"step"`
		ReadyToAdvance bool   `json:"readyToAdvance"`
		RelevantAt     int64  `json:"relevantAt"`
		ObservedAt     int64  `json:"observedAt"`
	}
	if err := json.Unmarshal([]byte(stdout), &output); err != nil ||
		output.Command != "account-deletion-inspect" || output.OperationID != operationID ||
		output.State != "retry-due" || output.Step != "cancel-subscription" ||
		!output.ReadyToAdvance || output.RelevantAt != 4_900 || output.ObservedAt != 5_000 {
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

func TestRunAccountDeletionAuditRejectsMalformedArgumentsBeforeDatabaseAccess(t *testing.T) {
	t.Parallel()
	valid := accountDeletionAuditCLIArguments("test")
	tests := map[string][]string{
		"missing":                valid[:len(valid)-1],
		"duplicate":              append(append([]string(nil), valid...), "--observed-at-millis=5"),
		"invalid account":        replaceCLIArgument(valid, "--account-id=", "--account-id=invalid"),
		"invalid vault":          replaceCLIArgument(valid, "--vault-id=", "--vault-id=invalid"),
		"invalid timestamp":      replaceCLIArgument(valid, "--observed-at-millis=", "--observed-at-millis=-1"),
		"unknown":                append(append([]string(nil), valid...), "--other=value"),
		"production unconfirmed": accountDeletionAuditCLIArguments("production"),
		"test with confirmation": append(append([]string(nil), valid...), "--confirm-production-read-only"),
	}
	for name, arguments := range tests {
		name, arguments := name, arguments
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			called := false
			code, stdout, stderr := runAccountDeletionAuditForTest(
				t, context.Background(), arguments, quotaAuditEnvironment(
					"test", "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test",
				),
				func(context.Context, string, operations.AccountDeletionAuditQuery) (operations.AccountDeletionAuditResult, error) {
					called = true
					return operations.AccountDeletionAuditResult{}, nil
				},
			)
			if code != 2 || called || stdout != "" || !strings.Contains(stderr, "usage:") {
				t.Fatalf("code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout, stderr)
			}
		})
	}
}

func TestRunAccountDeletionAuditRefusesUnsafeTargetAndMapsFailures(t *testing.T) {
	t.Parallel()
	called := false
	code, stdout, stderr := runAccountDeletionAuditForTest(
		t, context.Background(), accountDeletionAuditCLIArguments("test"),
		quotaAuditEnvironment("test", "postgres://notes:secret@database.example/fukamu_notes_go_test"),
		func(context.Context, string, operations.AccountDeletionAuditQuery) (operations.AccountDeletionAuditResult, error) {
			called = true
			return operations.AccountDeletionAuditResult{}, nil
		},
	)
	if code != 1 || called || stdout != "" || !strings.Contains(stderr, "target refused") ||
		strings.Contains(stderr, "secret") {
		t.Fatalf("unsafe target: code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout, stderr)
	}

	tests := []struct {
		name    string
		ctx     context.Context
		inspect inspectAccountDeletionFunction
		want    string
	}{
		{
			name: "scope refusal", ctx: context.Background(), want: "account deletion scope refused\n",
			inspect: func(_ context.Context, _ string, query operations.AccountDeletionAuditQuery) (operations.AccountDeletionAuditResult, error) {
				return operations.AccountDeletionAuditResult{
					Kind: operations.AccountDeletionAuditRefused, Reason: operations.AccountDeletionAuditOwnerMismatch,
					ObservedAt: query.ObservedAt,
				}, nil
			},
		},
		{
			name: "dependency failure", ctx: context.Background(), want: "account deletion audit failed\n",
			inspect: func(context.Context, string, operations.AccountDeletionAuditQuery) (operations.AccountDeletionAuditResult, error) {
				return operations.AccountDeletionAuditResult{}, errors.New("PRIVATE-DB-FAILURE")
			},
		},
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	tests = append(tests, struct {
		name    string
		ctx     context.Context
		inspect inspectAccountDeletionFunction
		want    string
	}{
		name: "cancelled", ctx: cancelled, want: "account deletion audit failed\n",
		inspect: func(ctx context.Context, _ string, _ operations.AccountDeletionAuditQuery) (operations.AccountDeletionAuditResult, error) {
			return operations.AccountDeletionAuditResult{}, ctx.Err()
		},
	})
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			code, stdout, stderr := runAccountDeletionAuditForTest(
				t, test.ctx, accountDeletionAuditCLIArguments("test"),
				quotaAuditEnvironment("test", "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test"),
				test.inspect,
			)
			if code != 1 || stdout != "" || stderr != test.want || strings.Contains(stderr, "PRIVATE") {
				t.Fatalf("code = %d, stdout = %q, stderr = %q", code, stdout, stderr)
			}
		})
	}
}

func TestRunAccountDeletionAuditRequiresExplicitProductionConfirmation(t *testing.T) {
	t.Parallel()
	arguments := append(accountDeletionAuditCLIArguments("production"), "--confirm-production-read-only")
	called := false
	code, stdout, stderr := runAccountDeletionAuditForTest(
		t, context.Background(), arguments,
		quotaAuditEnvironment("production", "postgres://notes:secret@database.example/notes"),
		func(_ context.Context, databaseURL string, query operations.AccountDeletionAuditQuery) (operations.AccountDeletionAuditResult, error) {
			called = strings.Contains(databaseURL, "database.example")
			operationID, _ := accountdeletion.ParseOperationID("01991f20-61d2-7000-8000-000000000301")
			return operations.AccountDeletionAuditResult{
				Kind: operations.AccountDeletionAuditInspected, OperationID: operationID,
				State: operations.AccountDeletionCompleted, RelevantAt: 4_000, ObservedAt: query.ObservedAt,
			}, nil
		},
	)
	if code != 0 || !called || stderr != "" || !strings.Contains(stdout, `"state":"completed"`) ||
		strings.Contains(stdout+stderr, "secret") {
		t.Fatalf("code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout, stderr)
	}
}

func runAccountDeletionAuditForTest(
	t *testing.T,
	ctx context.Context,
	arguments []string,
	values map[string]string,
	inspect inspectAccountDeletionFunction,
) (int, string, string) {
	t.Helper()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := runWithDependencies(
		ctx, arguments, &stdout, &stderr,
		func(key string) (string, bool) { value, ok := values[key]; return value, ok },
		func(context.Context, string) error { t.Fatal("migration must not run"); return nil },
		func(context.Context, string, string) error { t.Fatal("e2e preparation must not run"); return nil },
		func(context.Context, string, operations.QuotaCandidateQuery) (operations.QuotaAuditResult, error) {
			t.Fatal("quota audit must not run")
			return operations.QuotaAuditResult{}, nil
		},
		func(context.Context, string, operations.QuotaCommitCommand) (operations.QuotaCommitResult, error) {
			t.Fatal("quota commit must not run")
			return operations.QuotaCommitResult{}, nil
		},
		inspect,
		billingReconciliationMustNotRun(t),
		dekRotationMustNotRun(t),
		dekReencryptionMustNotRun(t),
		orphanScanMustNotRun(t),
	)
	return code, stdout.String(), stderr.String()
}

func accountDeletionAuditCLIArguments(environment string) []string {
	return []string{
		"account-deletion", "inspect",
		"--vault-id=01991f20-61d2-7000-8000-000000000201",
		"--environment=" + environment,
		"--observed-at-millis=5000",
		"--account-id=01991f20-61d2-7000-8000-000000000101",
	}
}

func TestRunBillingReconciliationUsesExplicitScopeAndRedactedOutput(t *testing.T) {
	values := billingReconciliationEnvironment(
		"test",
		"postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable",
		"sk_test_FukamuOperationsOnly",
	)
	called := false
	code, stdout, stderr := runBillingReconciliationForTest(
		t, context.Background(), billingReconciliationCLIArguments("test"), values,
		func(
			_ context.Context,
			databaseURL string,
			mode stripebilling.RuntimeMode,
			apiKey string,
			command operations.BillingReconciliationCommand,
		) (operations.BillingReconciliationResult, error) {
			called = true
			if !strings.Contains(databaseURL, "fukamu_notes_go_test") || mode != stripebilling.ModeTest ||
				apiKey != values["NOTES_STRIPE_API_KEY"] || command.ObservedAt != 5_000 || command.RecordedAt != 5_100 {
				t.Fatalf("unexpected input: %q, %q, %q, %#v", databaseURL, mode, apiKey, command)
			}
			return operations.BillingReconciliationResult{
				Kind: operations.BillingReconciliationApplied, SnapshotID: command.SnapshotID,
				ObservedAt: command.ObservedAt, RecordedAt: command.RecordedAt,
			}, nil
		},
	)
	if code != 0 || !called || stderr != "" {
		t.Fatalf("code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout, stderr)
	}
	var output struct {
		Command    string `json:"command"`
		Outcome    string `json:"outcome"`
		SnapshotID string `json:"snapshotId"`
		ObservedAt int64  `json:"observedAt"`
		RecordedAt int64  `json:"recordedAt"`
	}
	if err := json.Unmarshal([]byte(stdout), &output); err != nil || output.Command != "billing-reconcile" ||
		output.Outcome != "applied" || output.SnapshotID != "manual-2026-09-26T00:00:00Z" ||
		output.ObservedAt != 5_000 || output.RecordedAt != 5_100 {
		t.Fatalf("output = %#v, err = %v", output, err)
	}
	for _, forbidden := range []string{
		"01991f20-61d2-7000-8000-000000000101",
		"01991f20-61d2-7000-8000-000000000201",
		"sk_test_",
		"secret",
		"sub_",
	} {
		if strings.Contains(stdout+stderr, forbidden) {
			t.Fatalf("output disclosed %q: stdout = %q, stderr = %q", forbidden, stdout, stderr)
		}
	}
}

func TestRunBillingReconciliationRejectsInvalidArgumentsBeforeDependencies(t *testing.T) {
	valid := billingReconciliationCLIArguments("test")
	tests := map[string][]string{
		"missing":                 valid[:len(valid)-1],
		"duplicate":               append(append([]string(nil), valid...), "--snapshot-id=another"),
		"unknown":                 append(append([]string(nil), valid...), "--limit=1"),
		"invalid snapshot":        replaceCLIArgument(valid, "--snapshot-id=", "--snapshot-id=bad snapshot"),
		"zero observation":        replaceCLIArgument(valid, "--observed-at-millis=", "--observed-at-millis=0"),
		"reversed time":           replaceCLIArgument(valid, "--recorded-at-millis=", "--recorded-at-millis=4999"),
		"production unconfirmed":  billingReconciliationCLIArguments("production"),
		"test production confirm": append(append([]string(nil), valid...), "--confirm-production-provider-read"),
	}
	values := billingReconciliationEnvironment(
		"test", "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test", "sk_test_FukamuOperationsOnly",
	)
	for name, arguments := range tests {
		t.Run(name, func(t *testing.T) {
			code, stdout, stderr := runBillingReconciliationForTest(
				t, context.Background(), arguments, values, billingReconciliationMustNotRun(t),
			)
			if code != 2 || stdout != "" || !strings.Contains(stderr, "usage:") {
				t.Fatalf("code = %d, stdout = %q, stderr = %q", code, stdout, stderr)
			}
		})
	}
}

func TestRunBillingReconciliationEnforcesEnvironmentTargetAndProviderConfiguration(t *testing.T) {
	valid := billingReconciliationCLIArguments("test")
	tests := []struct {
		name   string
		values map[string]string
		want   string
	}{
		{
			name: "environment mismatch",
			values: billingReconciliationEnvironment(
				"local", "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test", "sk_test_FukamuOperationsOnly",
			),
			want: "billing reconciliation environment refused\n",
		},
		{
			name: "remote test database",
			values: billingReconciliationEnvironment(
				"test", "postgres://notes:secret@database.example/fukamu_notes_go_test", "sk_test_FukamuOperationsOnly",
			),
			want: "billing reconciliation target refused\n",
		},
		{
			name: "missing provider key",
			values: quotaAuditEnvironment(
				"test", "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test",
			),
			want: "billing reconciliation provider configuration invalid\n",
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			code, stdout, stderr := runBillingReconciliationForTest(
				t, context.Background(), valid, testCase.values, billingReconciliationMustNotRun(t),
			)
			if code != 1 || stdout != "" || stderr != testCase.want || strings.Contains(stderr, "secret") {
				t.Fatalf("code = %d, stdout = %q, stderr = %q", code, stdout, stderr)
			}
		})
	}
}

func TestRunBillingReconciliationProductionSyntaxSelectsLiveModeWithoutCallingProvider(t *testing.T) {
	arguments := append(billingReconciliationCLIArguments("production"), "--confirm-production-provider-read")
	values := billingReconciliationEnvironment(
		"production", "postgres://notes:secret@database.example/notes", "sk_live_FukamuOperationsOnly",
	)
	code, stdout, stderr := runBillingReconciliationForTest(
		t, context.Background(), arguments, values,
		func(
			_ context.Context,
			_ string,
			mode stripebilling.RuntimeMode,
			_ string,
			command operations.BillingReconciliationCommand,
		) (operations.BillingReconciliationResult, error) {
			if mode != stripebilling.ModeLive {
				t.Fatalf("mode = %q", mode)
			}
			return operations.BillingReconciliationResult{
				Kind: operations.BillingReconciliationReplayed, SnapshotID: command.SnapshotID,
				ObservedAt: command.ObservedAt, RecordedAt: command.RecordedAt,
			}, nil
		},
	)
	if code != 0 || stderr != "" || !strings.Contains(stdout, `"outcome":"replayed"`) {
		t.Fatalf("code = %d, stdout = %q, stderr = %q", code, stdout, stderr)
	}
}

func TestRunBillingReconciliationRedactsRefusalFailureCancellationAndOutputError(t *testing.T) {
	values := billingReconciliationEnvironment(
		"test", "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test", "sk_test_FukamuOperationsOnly",
	)
	arguments := billingReconciliationCLIArguments("test")
	command := operations.BillingReconciliationCommand{}
	parsed, requested, err := parseBillingReconciliationArguments(arguments)
	if err != nil || !requested {
		t.Fatalf("parse = %#v, %t, %v", parsed, requested, err)
	}
	command = parsed.command
	tests := []struct {
		name      string
		ctx       context.Context
		reconcile reconcileBillingFunction
		want      string
	}{
		{
			name: "refused", ctx: context.Background(), want: "billing reconciliation scope refused\n",
			reconcile: func(context.Context, string, stripebilling.RuntimeMode, string, operations.BillingReconciliationCommand) (operations.BillingReconciliationResult, error) {
				return operations.BillingReconciliationResult{
					Kind: operations.BillingReconciliationRefused, SnapshotID: command.SnapshotID,
					ObservedAt: command.ObservedAt, RecordedAt: command.RecordedAt,
				}, nil
			},
		},
		{
			name: "dependency", ctx: context.Background(), want: "billing reconciliation failed\n",
			reconcile: func(context.Context, string, stripebilling.RuntimeMode, string, operations.BillingReconciliationCommand) (operations.BillingReconciliationResult, error) {
				return operations.BillingReconciliationResult{}, errors.New("STRIPE_PRIVATE_SECRET")
			},
		},
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	tests = append(tests, struct {
		name      string
		ctx       context.Context
		reconcile reconcileBillingFunction
		want      string
	}{
		name: "cancelled", ctx: cancelled, want: "billing reconciliation failed\n",
		reconcile: func(ctx context.Context, _ string, _ stripebilling.RuntimeMode, _ string, _ operations.BillingReconciliationCommand) (operations.BillingReconciliationResult, error) {
			return operations.BillingReconciliationResult{}, ctx.Err()
		},
	})
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			code, stdout, stderr := runBillingReconciliationForTest(
				t, testCase.ctx, arguments, values, testCase.reconcile,
			)
			if code != 1 || stdout != "" || stderr != testCase.want || strings.Contains(stderr, "PRIVATE") {
				t.Fatalf("code = %d, stdout = %q, stderr = %q", code, stdout, stderr)
			}
		})
	}
	var stderr bytes.Buffer
	code := runBillingReconciliation(
		context.Background(), parsed, rejectingWriter{}, &stderr,
		func(key string) (string, bool) { value, ok := values[key]; return value, ok },
		func(context.Context, string, stripebilling.RuntimeMode, string, operations.BillingReconciliationCommand) (operations.BillingReconciliationResult, error) {
			return operations.BillingReconciliationResult{
				Kind: operations.BillingReconciliationApplied, SnapshotID: command.SnapshotID,
				ObservedAt: command.ObservedAt, RecordedAt: command.RecordedAt,
			}, nil
		},
	)
	if code != 1 || stderr.String() != "billing reconciliation output failed\n" {
		t.Fatalf("code = %d, stderr = %q", code, stderr.String())
	}
}

func runBillingReconciliationForTest(
	t *testing.T,
	ctx context.Context,
	arguments []string,
	values map[string]string,
	reconcile reconcileBillingFunction,
) (int, string, string) {
	t.Helper()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := runWithDependencies(
		ctx, arguments, &stdout, &stderr,
		func(key string) (string, bool) { value, ok := values[key]; return value, ok },
		func(context.Context, string) error { t.Fatal("migration must not run"); return nil },
		func(context.Context, string, string) error { t.Fatal("e2e preparation must not run"); return nil },
		func(context.Context, string, operations.QuotaCandidateQuery) (operations.QuotaAuditResult, error) {
			t.Fatal("quota audit must not run")
			return operations.QuotaAuditResult{}, nil
		},
		func(context.Context, string, operations.QuotaCommitCommand) (operations.QuotaCommitResult, error) {
			t.Fatal("quota commit must not run")
			return operations.QuotaCommitResult{}, nil
		},
		func(context.Context, string, operations.AccountDeletionAuditQuery) (operations.AccountDeletionAuditResult, error) {
			t.Fatal("account deletion audit must not run")
			return operations.AccountDeletionAuditResult{}, nil
		},
		reconcile,
		dekRotationMustNotRun(t),
		dekReencryptionMustNotRun(t),
		orphanScanMustNotRun(t),
	)
	return code, stdout.String(), stderr.String()
}

func billingReconciliationCLIArguments(environment string) []string {
	return []string{
		"billing", "reconcile",
		"--vault-id=01991f20-61d2-7000-8000-000000000201",
		"--environment=" + environment,
		"--snapshot-id=manual-2026-09-26T00:00:00Z",
		"--recorded-at-millis=5100",
		"--account-id=01991f20-61d2-7000-8000-000000000101",
		"--observed-at-millis=5000",
	}
}

func billingReconciliationEnvironment(environment, databaseURL, apiKey string) map[string]string {
	return map[string]string{
		"NOTES_ENVIRONMENT": environment, "NOTES_DATABASE_URL": databaseURL,
		"NOTES_STRIPE_API_KEY": apiKey,
	}
}

func TestRunDEKRotationUsesExactScopeStableTimesAndRedactedOutput(t *testing.T) {
	arguments := dekRotationCLIArguments("test")
	values := dekRotationEnvironment(
		"test",
		"postgres://notes:PRIVATE_DATABASE@127.0.0.1:55432/fukamu_notes_go_test",
	)
	called := 0
	code, stdout, stderr := runDEKRotationForTest(
		t,
		context.Background(),
		arguments,
		values,
		func(
			_ context.Context,
			databaseURL string,
			keyVersion string,
			accessToken string,
			command operations.DEKRotationCommand,
		) (operations.DEKRotationResult, error) {
			called++
			if !strings.Contains(databaseURL, "PRIVATE_DATABASE") ||
				keyVersion != testKMSKeyVersion || accessToken != testKMSAccessToken ||
				command.RequestedAtMilli != 2_000 || command.GeneratedAtMilli != 2_200 ||
				command.CompletedAtMilli != 2_300 ||
				string(command.AccountID) != "01991f20-61d2-7000-8000-000000000101" ||
				string(command.VaultID) != "01991f20-61d2-7000-8000-000000000201" {
				t.Fatalf("rotation inputs = %q, %q, %q, %#v", databaseURL, keyVersion, accessToken, command)
			}
			return operations.DEKRotationResult{
				Kind: operations.DEKRotationCompleted, OperationID: command.OperationID,
			}, nil
		},
	)
	if code != 0 || called != 1 || stderr != "" ||
		!strings.Contains(stdout, `"command":"dek-rotate"`) ||
		!strings.Contains(stdout, `"outcome":"completed"`) ||
		strings.Contains(stdout, "PRIVATE") || strings.Contains(stdout, testKMSKeyVersion) ||
		strings.Contains(stdout, "000000000101") || strings.Contains(stdout, "000000000201") {
		t.Fatalf("code = %d, called = %d, stdout = %q, stderr = %q", code, called, stdout, stderr)
	}
}

func TestRunDEKRotationRejectsInvalidArgumentsBeforeDependencies(t *testing.T) {
	valid := dekRotationCLIArguments("test")
	tests := [][]string{
		valid[:len(valid)-1],
		append(append([]string{}, valid...), "--operation-id=01991f20-61d2-7000-8000-000000000499"),
		func() []string {
			value := append([]string{}, valid...)
			for index := range value {
				if strings.HasPrefix(value[index], "--completed-at-millis=") {
					value[index] = "--completed-at-millis=2100"
				}
			}
			return value
		}(),
	}
	for _, arguments := range tests {
		code, stdout, stderr := runDEKRotationForTest(
			t,
			context.Background(),
			arguments,
			dekRotationEnvironment("test", "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test"),
			dekRotationMustNotRun(t),
		)
		if code != 2 || stdout != "" || !strings.Contains(stderr, "usage:") {
			t.Fatalf("arguments = %#v, code = %d, stdout = %q, stderr = %q", arguments, code, stdout, stderr)
		}
	}
}

func TestRunDEKRotationEnforcesEnvironmentTargetAndProviderConfiguration(t *testing.T) {
	valid := dekRotationCLIArguments("test")
	tests := []struct {
		name   string
		values map[string]string
		want   string
	}{
		{
			name: "environment mismatch",
			values: dekRotationEnvironment(
				"local", "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test",
			),
			want: "DEK rotation environment refused\n",
		},
		{
			name: "remote test database",
			values: dekRotationEnvironment(
				"test", "postgres://notes:secret@database.example/fukamu_notes_go_test",
			),
			want: "DEK rotation target refused\n",
		},
		{
			name: "missing provider token",
			values: map[string]string{
				"NOTES_ENVIRONMENT":                "test",
				"NOTES_DATABASE_URL":               "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test",
				"NOTES_GCP_KMS_CRYPTO_KEY_VERSION": testKMSKeyVersion,
			},
			want: "DEK rotation provider configuration invalid\n",
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			code, stdout, stderr := runDEKRotationForTest(
				t, context.Background(), valid, testCase.values, dekRotationMustNotRun(t),
			)
			if code != 1 || stdout != "" || stderr != testCase.want || strings.Contains(stderr, "secret") {
				t.Fatalf("code = %d, stdout = %q, stderr = %q", code, stdout, stderr)
			}
		})
	}
}

func TestRunDEKRotationProductionSyntaxRequiresBothGuards(t *testing.T) {
	withoutProductionGuard := dekRotationCLIArguments("production")
	code, _, stderr := runDEKRotationForTest(
		t,
		context.Background(),
		withoutProductionGuard,
		dekRotationEnvironment("production", "postgres://notes:secret@database.example/notes"),
		dekRotationMustNotRun(t),
	)
	if code != 2 || !strings.Contains(stderr, "usage:") {
		t.Fatalf("unguarded code = %d, stderr = %q", code, stderr)
	}

	arguments := append(withoutProductionGuard, "--confirm-production-kms-mutation")
	code, stdout, stderr := runDEKRotationForTest(
		t,
		context.Background(),
		arguments,
		dekRotationEnvironment("production", "postgres://notes:secret@database.example/notes"),
		func(
			_ context.Context,
			_ string,
			_ string,
			_ string,
			command operations.DEKRotationCommand,
		) (operations.DEKRotationResult, error) {
			return operations.DEKRotationResult{
				Kind: operations.DEKRotationReplayed, OperationID: command.OperationID,
			}, nil
		},
	)
	if code != 0 || stderr != "" || !strings.Contains(stdout, `"outcome":"replayed"`) {
		t.Fatalf("code = %d, stdout = %q, stderr = %q", code, stdout, stderr)
	}
}

func TestRunDEKRotationRedactsRefusalFailureCancellationAndOutputError(t *testing.T) {
	values := dekRotationEnvironment(
		"test", "postgres://notes:PRIVATE_DATABASE@127.0.0.1:55432/fukamu_notes_go_test",
	)
	arguments := dekRotationCLIArguments("test")
	parsed, requested, err := parseDEKRotationArguments(arguments)
	if err != nil || !requested {
		t.Fatalf("parse = %#v, %t, %v", parsed, requested, err)
	}
	tests := []struct {
		name   string
		ctx    context.Context
		rotate rotateDEKFunction
		want   string
	}{
		{
			name: "refused", ctx: context.Background(), want: "DEK rotation scope refused\n",
			rotate: func(context.Context, string, string, string, operations.DEKRotationCommand) (operations.DEKRotationResult, error) {
				return operations.DEKRotationResult{
					Kind: operations.DEKRotationRefused, OperationID: parsed.command.OperationID,
				}, nil
			},
		},
		{
			name: "dependency", ctx: context.Background(), want: "DEK rotation failed\n",
			rotate: func(context.Context, string, string, string, operations.DEKRotationCommand) (operations.DEKRotationResult, error) {
				return operations.DEKRotationResult{}, errors.New("PRIVATE KMS FAILURE")
			},
		},
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	tests = append(tests, struct {
		name   string
		ctx    context.Context
		rotate rotateDEKFunction
		want   string
	}{
		name: "cancelled", ctx: cancelled, want: "DEK rotation failed\n",
		rotate: func(ctx context.Context, _ string, _ string, _ string, _ operations.DEKRotationCommand) (operations.DEKRotationResult, error) {
			return operations.DEKRotationResult{}, ctx.Err()
		},
	})
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			code, stdout, stderr := runDEKRotationForTest(
				t, testCase.ctx, arguments, values, testCase.rotate,
			)
			if code != 1 || stdout != "" || stderr != testCase.want || strings.Contains(stderr, "PRIVATE") {
				t.Fatalf("code = %d, stdout = %q, stderr = %q", code, stdout, stderr)
			}
		})
	}
	var stderr bytes.Buffer
	code := runDEKRotation(
		context.Background(), parsed, rejectingWriter{}, &stderr,
		func(key string) (string, bool) { value, ok := values[key]; return value, ok },
		func(context.Context, string, string, string, operations.DEKRotationCommand) (operations.DEKRotationResult, error) {
			return operations.DEKRotationResult{
				Kind: operations.DEKRotationCompleted, OperationID: parsed.command.OperationID,
			}, nil
		},
	)
	if code != 1 || stderr.String() != "DEK rotation output failed\n" {
		t.Fatalf("code = %d, stderr = %q", code, stderr.String())
	}
}

func runDEKRotationForTest(
	t *testing.T,
	ctx context.Context,
	arguments []string,
	values map[string]string,
	rotate rotateDEKFunction,
) (int, string, string) {
	t.Helper()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := runWithDependencies(
		ctx, arguments, &stdout, &stderr,
		func(key string) (string, bool) { value, ok := values[key]; return value, ok },
		func(context.Context, string) error { t.Fatal("migration must not run"); return nil },
		func(context.Context, string, string) error { t.Fatal("e2e preparation must not run"); return nil },
		func(context.Context, string, operations.QuotaCandidateQuery) (operations.QuotaAuditResult, error) {
			t.Fatal("quota audit must not run")
			return operations.QuotaAuditResult{}, nil
		},
		func(context.Context, string, operations.QuotaCommitCommand) (operations.QuotaCommitResult, error) {
			t.Fatal("quota commit must not run")
			return operations.QuotaCommitResult{}, nil
		},
		func(context.Context, string, operations.AccountDeletionAuditQuery) (operations.AccountDeletionAuditResult, error) {
			t.Fatal("account deletion audit must not run")
			return operations.AccountDeletionAuditResult{}, nil
		},
		billingReconciliationMustNotRun(t),
		rotate,
		dekReencryptionMustNotRun(t),
		orphanScanMustNotRun(t),
	)
	return code, stdout.String(), stderr.String()
}

func TestRunDEKReencryptionUsesBoundedScopeAndRedactedOutput(t *testing.T) {
	arguments := dekReencryptionCLIArguments("test", t.TempDir(), t.TempDir())
	values := dekRotationEnvironment(
		"test", "postgres://notes:PRIVATE_DATABASE@127.0.0.1:55432/fukamu_notes_go_test",
	)
	called := false
	code, stdout, stderr := runDEKReencryptionForTest(
		t,
		context.Background(),
		arguments,
		values,
		func(
			_ context.Context,
			databaseURL string,
			keyVersion string,
			accessToken string,
			objectRoot string,
			nonceRoot string,
			command operations.DEKReencryptionCommand,
		) (operations.DEKReencryptionResult, error) {
			called = true
			if !strings.Contains(databaseURL, "fukamu_notes_go_test") || keyVersion != testKMSKeyVersion ||
				accessToken != testKMSAccessToken || objectRoot != arguments[8][len("--object-root="):] ||
				nonceRoot != arguments[9][len("--nonce-root="):] || command.Limit != 2 ||
				command.PerformedAtMilli != 3_000 || command.TargetVersion != 2 {
				t.Fatalf("unexpected inputs: %q, %q, %q, %q, %q, %#v",
					databaseURL, keyVersion, accessToken, objectRoot, nonceRoot, command)
			}
			return operations.DEKReencryptionResult{
				Kind: operations.DEKReencryptionPending, Processed: 2,
				TargetVersion: command.TargetVersion, Pending: encryptedobject.ReencryptionPageLimit,
			}, nil
		},
	)
	if code != 0 || !called || stderr != "" {
		t.Fatalf("code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout, stderr)
	}
	var output map[string]any
	if err := json.Unmarshal([]byte(stdout), &output); err != nil {
		t.Fatal(err)
	}
	if output["command"] != "dek-reencrypt" || output["outcome"] != "pending" ||
		output["processed"] != float64(2) || output["targetVersion"] != float64(2) ||
		output["pending"] != string(encryptedobject.ReencryptionPageLimit) || len(output) != 5 {
		t.Fatalf("output = %#v", output)
	}
	for _, private := range []string{
		"PRIVATE_DATABASE", testKMSAccessToken,
		"01991f20-61d2-7000-8000-000000000101",
		"01991f20-61d2-7000-8000-000000000201",
		arguments[8][len("--object-root="):], arguments[9][len("--nonce-root="):],
	} {
		if strings.Contains(stdout+stderr, private) {
			t.Fatalf("output disclosed private value %q", private)
		}
	}
}

func TestParseDEKReencryptionRejectsInvalidAndProductionCommands(t *testing.T) {
	valid := dekReencryptionCLIArguments("test", t.TempDir(), t.TempDir())
	tests := [][]string{
		removeCLIArgument(valid, "--confirm-local-object-writes"),
		removeCLIArgument(valid, "--confirm-kms-unwrapping"),
		replaceCLIArgument(valid, "--environment=", "--environment=production"),
		replaceCLIArgument(valid, "--limit=", "--limit=0"),
		replaceCLIArgument(valid, "--target-version=", "--target-version=0"),
		replaceCLIArgument(valid, "--performed-at-millis=", "--performed-at-millis=0"),
		replaceCLIArgument(valid, "--object-root=", "--object-root=bad\npath"),
		replaceCLIArgument(valid, "--object-root=", "--object-root=relative"),
		replaceCLIArgument(valid, "--nonce-root=", "--nonce-root="+valid[8][len("--object-root="):]),
		append(append([]string(nil), valid...), "--unknown=value"),
	}
	for index, arguments := range tests {
		if _, requested, err := parseDEKReencryptionArguments(arguments); !requested || err == nil {
			t.Fatalf("case %d parsed: requested=%t err=%v", index, requested, err)
		}
	}
	if _, requested, err := parseDEKReencryptionArguments([]string{"dek", "rotate"}); requested || err != nil {
		t.Fatalf("unrelated command requested=%t err=%v", requested, err)
	}
}

func TestRunDEKReencryptionRefusesEnvironmentTargetAndProviderConfiguration(t *testing.T) {
	arguments := dekReencryptionCLIArguments("test", t.TempDir(), t.TempDir())
	tests := []struct {
		name   string
		values map[string]string
		want   string
	}{
		{
			name: "environment mismatch",
			values: dekRotationEnvironment(
				"local", "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test",
			),
			want: "DEK re-encryption environment refused\n",
		},
		{
			name:   "remote database",
			values: dekRotationEnvironment("test", "postgres://notes:secret@database.example/notes"),
			want:   "DEK re-encryption target refused\n",
		},
		{
			name: "missing provider",
			values: map[string]string{
				"NOTES_ENVIRONMENT":  "test",
				"NOTES_DATABASE_URL": "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test",
			},
			want: "DEK re-encryption provider configuration invalid\n",
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			code, stdout, stderr := runDEKReencryptionForTest(
				t, context.Background(), arguments, testCase.values, dekReencryptionMustNotRun(t),
			)
			if code != 1 || stdout != "" || stderr != testCase.want || strings.Contains(stderr, "secret") {
				t.Fatalf("code = %d, stdout = %q, stderr = %q", code, stdout, stderr)
			}
		})
	}
}

func TestRunDEKReencryptionRedactsRefusalFailureCancellationAndOutputError(t *testing.T) {
	arguments := dekReencryptionCLIArguments("test", t.TempDir(), t.TempDir())
	values := dekRotationEnvironment(
		"test", "postgres://notes:PRIVATE_DATABASE@127.0.0.1:55432/fukamu_notes_go_test",
	)
	parsed, requested, err := parseDEKReencryptionArguments(arguments)
	if err != nil || !requested {
		t.Fatalf("parse = %#v, %t, %v", parsed, requested, err)
	}
	tests := []struct {
		name      string
		ctx       context.Context
		reencrypt reencryptDEKFunction
		want      string
	}{
		{
			name: "refused", ctx: context.Background(), want: "DEK re-encryption scope refused\n",
			reencrypt: func(context.Context, string, string, string, string, string, operations.DEKReencryptionCommand) (operations.DEKReencryptionResult, error) {
				return operations.DEKReencryptionResult{
					Kind: operations.DEKReencryptionRefused, TargetVersion: parsed.command.TargetVersion,
				}, nil
			},
		},
		{
			name: "dependency", ctx: context.Background(), want: "DEK re-encryption failed\n",
			reencrypt: func(context.Context, string, string, string, string, string, operations.DEKReencryptionCommand) (operations.DEKReencryptionResult, error) {
				return operations.DEKReencryptionResult{}, errors.New("PRIVATE OBJECT FAILURE")
			},
		},
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	tests = append(tests, struct {
		name      string
		ctx       context.Context
		reencrypt reencryptDEKFunction
		want      string
	}{
		name: "cancelled", ctx: cancelled, want: "DEK re-encryption failed\n",
		reencrypt: func(ctx context.Context, _ string, _ string, _ string, _ string, _ string, _ operations.DEKReencryptionCommand) (operations.DEKReencryptionResult, error) {
			return operations.DEKReencryptionResult{}, ctx.Err()
		},
	})
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			code, stdout, stderr := runDEKReencryptionForTest(
				t, testCase.ctx, arguments, values, testCase.reencrypt,
			)
			if code != 1 || stdout != "" || stderr != testCase.want || strings.Contains(stderr, "PRIVATE") {
				t.Fatalf("code = %d, stdout = %q, stderr = %q", code, stdout, stderr)
			}
		})
	}
	var stderr bytes.Buffer
	code := runDEKReencryption(
		context.Background(), parsed, rejectingWriter{}, &stderr,
		func(key string) (string, bool) { value, ok := values[key]; return value, ok },
		func(context.Context, string, string, string, string, string, operations.DEKReencryptionCommand) (operations.DEKReencryptionResult, error) {
			return operations.DEKReencryptionResult{
				Kind: operations.DEKReencryptionCompleted, TargetVersion: parsed.command.TargetVersion,
			}, nil
		},
	)
	if code != 1 || stderr.String() != "DEK re-encryption output failed\n" {
		t.Fatalf("code = %d, stderr = %q", code, stderr.String())
	}
}

func runDEKReencryptionForTest(
	t *testing.T,
	ctx context.Context,
	arguments []string,
	values map[string]string,
	reencrypt reencryptDEKFunction,
) (int, string, string) {
	t.Helper()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := runWithDependencies(
		ctx, arguments, &stdout, &stderr,
		func(key string) (string, bool) { value, ok := values[key]; return value, ok },
		func(context.Context, string) error { t.Fatal("migration must not run"); return nil },
		func(context.Context, string, string) error { t.Fatal("e2e preparation must not run"); return nil },
		func(context.Context, string, operations.QuotaCandidateQuery) (operations.QuotaAuditResult, error) {
			t.Fatal("quota audit must not run")
			return operations.QuotaAuditResult{}, nil
		},
		func(context.Context, string, operations.QuotaCommitCommand) (operations.QuotaCommitResult, error) {
			t.Fatal("quota commit must not run")
			return operations.QuotaCommitResult{}, nil
		},
		func(context.Context, string, operations.AccountDeletionAuditQuery) (operations.AccountDeletionAuditResult, error) {
			t.Fatal("account deletion audit must not run")
			return operations.AccountDeletionAuditResult{}, nil
		},
		billingReconciliationMustNotRun(t),
		dekRotationMustNotRun(t),
		reencrypt,
		orphanScanMustNotRun(t),
	)
	return code, stdout.String(), stderr.String()
}

func dekReencryptionCLIArguments(environment, objectRoot, nonceRoot string) []string {
	return []string{
		"dek", "reencrypt",
		"--vault-id=01991f20-61d2-7000-8000-000000000201",
		"--environment=" + environment,
		"--limit=2",
		"--target-version=2",
		"--performed-at-millis=3000",
		"--account-id=01991f20-61d2-7000-8000-000000000101",
		"--object-root=" + objectRoot,
		"--nonce-root=" + nonceRoot,
		"--confirm-local-object-writes",
		"--confirm-kms-unwrapping",
	}
}

const (
	testKMSKeyVersion  = "projects/fukamu-test/locations/asia-northeast1/keyRings/notes/cryptoKeys/vault/cryptoKeyVersions/7"
	testKMSAccessToken = "test-access-token-value"
)

func dekRotationCLIArguments(environment string) []string {
	return []string{
		"dek", "rotate",
		"--vault-id=01991f20-61d2-7000-8000-000000000201",
		"--environment=" + environment,
		"--operation-id=01991f20-61d2-7000-8000-000000000401",
		"--completed-at-millis=2300",
		"--account-id=01991f20-61d2-7000-8000-000000000101",
		"--generated-at-millis=2200",
		"--requested-at-millis=2000",
		"--confirm-kms-key-generation",
	}
}

func dekRotationEnvironment(environment, databaseURL string) map[string]string {
	return map[string]string{
		"NOTES_ENVIRONMENT": environment, "NOTES_DATABASE_URL": databaseURL,
		"NOTES_GCP_KMS_CRYPTO_KEY_VERSION": testKMSKeyVersion,
		"NOTES_GCP_KMS_ACCESS_TOKEN":       testKMSAccessToken,
	}
}

func billingReconciliationMustNotRun(t *testing.T) reconcileBillingFunction {
	t.Helper()
	return func(
		context.Context,
		string,
		stripebilling.RuntimeMode,
		string,
		operations.BillingReconciliationCommand,
	) (operations.BillingReconciliationResult, error) {
		t.Fatal("billing reconciliation must not run")
		return operations.BillingReconciliationResult{}, nil
	}
}

func dekRotationMustNotRun(t *testing.T) rotateDEKFunction {
	t.Helper()
	return func(
		context.Context,
		string,
		string,
		string,
		operations.DEKRotationCommand,
	) (operations.DEKRotationResult, error) {
		t.Fatal("DEK rotation must not run")
		return operations.DEKRotationResult{}, nil
	}
}

func dekReencryptionMustNotRun(t *testing.T) reencryptDEKFunction {
	t.Helper()
	return func(
		context.Context,
		string,
		string,
		string,
		string,
		string,
		operations.DEKReencryptionCommand,
	) (operations.DEKReencryptionResult, error) {
		t.Fatal("DEK re-encryption must not run")
		return operations.DEKReencryptionResult{}, nil
	}
}

func TestRunOrphanScanUsesBoundedScopeAndRedactedOutput(t *testing.T) {
	root := t.TempDir()
	arguments := orphanScanCLIArguments("test", root)
	values := map[string]string{
		"NOTES_ENVIRONMENT":  "test",
		"NOTES_DATABASE_URL": "postgres://notes:PRIVATE_DATABASE@127.0.0.1:55432/fukamu_notes_go_test",
	}
	called := false
	code, stdout, stderr := runOrphanScanForTest(
		t,
		context.Background(),
		arguments,
		values,
		func(
			_ context.Context,
			databaseURL string,
			objectRoot string,
			command operations.OrphanScanCommand,
		) (operations.OrphanScanResult, error) {
			called = true
			if !strings.Contains(databaseURL, "fukamu_notes_go_test") || objectRoot != root ||
				command.ScanStartedAt != 10_000 || command.GracePeriodMilli != 1_000 || command.Limit != 2 {
				t.Fatalf("unexpected inputs: %q, %q, %#v", databaseURL, objectRoot, command)
			}
			return operations.OrphanScanResult{Kind: operations.OrphanScanPending, Enqueued: 2}, nil
		},
	)
	if code != 0 || !called || stderr != "" {
		t.Fatalf("code = %d, called = %t, stdout = %q, stderr = %q", code, called, stdout, stderr)
	}
	var output map[string]any
	if err := json.Unmarshal([]byte(stdout), &output); err != nil {
		t.Fatal(err)
	}
	if output["command"] != "objects-orphan-scan" || output["outcome"] != "pending" ||
		output["enqueued"] != float64(2) || output["limit"] != float64(2) || len(output) != 4 {
		t.Fatalf("output = %#v", output)
	}
	for _, private := range []string{
		"PRIVATE_DATABASE", root,
		"01991f20-61d2-7000-8000-000000000101",
		"01991f20-61d2-7000-8000-000000000201",
	} {
		if strings.Contains(stdout+stderr, private) {
			t.Fatalf("output disclosed private value %q", private)
		}
	}
}

func TestParseOrphanScanRejectsInvalidAndProductionCommands(t *testing.T) {
	valid := orphanScanCLIArguments("test", t.TempDir())
	tests := [][]string{
		removeCLIArgument(valid, "--confirm-local-object-scan"),
		removeCLIArgument(valid, "--confirm-delete-enqueue"),
		replaceCLIArgument(valid, "--environment=", "--environment=production"),
		replaceCLIArgument(valid, "--limit=", "--limit=0"),
		replaceCLIArgument(valid, "--scan-started-at-millis=", "--scan-started-at-millis=0"),
		replaceCLIArgument(valid, "--grace-period-millis=", "--grace-period-millis=-1"),
		replaceCLIArgument(valid, "--object-root=", "--object-root=relative"),
		append(append([]string(nil), valid...), "--unknown=value"),
	}
	for index, arguments := range tests {
		if _, requested, err := parseOrphanScanArguments(arguments); !requested || err == nil {
			t.Fatalf("case %d parsed: requested=%t err=%v", index, requested, err)
		}
	}
	if _, requested, err := parseOrphanScanArguments([]string{"dek", "reencrypt"}); requested || err != nil {
		t.Fatalf("unrelated command requested=%t err=%v", requested, err)
	}
}

func TestRunOrphanScanRefusesUnsafeTargetsAndRedactsFailures(t *testing.T) {
	arguments := orphanScanCLIArguments("test", t.TempDir())
	tests := []struct {
		name   string
		ctx    context.Context
		values map[string]string
		scan   scanOrphansFunction
		want   string
	}{
		{
			name: "environment mismatch",
			values: map[string]string{
				"NOTES_ENVIRONMENT":  "local",
				"NOTES_DATABASE_URL": "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test",
			},
			scan: orphanScanMustNotRun(t), want: "orphan scan environment refused\n",
		},
		{
			name: "remote database",
			values: map[string]string{
				"NOTES_ENVIRONMENT":  "test",
				"NOTES_DATABASE_URL": "postgres://notes:secret@database.example/notes",
			},
			scan: orphanScanMustNotRun(t), want: "orphan scan target refused\n",
		},
		{
			name: "scope refused",
			values: map[string]string{
				"NOTES_ENVIRONMENT":  "test",
				"NOTES_DATABASE_URL": "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test",
			},
			scan: func(context.Context, string, string, operations.OrphanScanCommand) (operations.OrphanScanResult, error) {
				return operations.OrphanScanResult{Kind: operations.OrphanScanRefused}, nil
			},
			want: "orphan scan scope refused\n",
		},
		{
			name: "dependency failure",
			values: map[string]string{
				"NOTES_ENVIRONMENT":  "test",
				"NOTES_DATABASE_URL": "postgres://notes:PRIVATE_DATABASE@127.0.0.1:55432/fukamu_notes_go_test",
			},
			scan: func(context.Context, string, string, operations.OrphanScanCommand) (operations.OrphanScanResult, error) {
				return operations.OrphanScanResult{}, errors.New("PRIVATE OBJECT FAILURE")
			},
			want: "orphan scan failed\n",
		},
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	tests = append(tests, struct {
		name   string
		ctx    context.Context
		values map[string]string
		scan   scanOrphansFunction
		want   string
	}{
		name: "cancelled", ctx: cancelled,
		values: map[string]string{
			"NOTES_ENVIRONMENT":  "test",
			"NOTES_DATABASE_URL": "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test",
		},
		scan: func(ctx context.Context, _ string, _ string, _ operations.OrphanScanCommand) (operations.OrphanScanResult, error) {
			return operations.OrphanScanResult{}, ctx.Err()
		},
		want: "orphan scan failed\n",
	})
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			ctx := testCase.ctx
			if ctx == nil {
				ctx = context.Background()
			}
			code, stdout, stderr := runOrphanScanForTest(t, ctx, arguments, testCase.values, testCase.scan)
			if code != 1 || stdout != "" || stderr != testCase.want ||
				strings.Contains(stderr, "PRIVATE") || strings.Contains(stderr, "secret") {
				t.Fatalf("code = %d, stdout = %q, stderr = %q", code, stdout, stderr)
			}
		})
	}

	parsed, requested, err := parseOrphanScanArguments(arguments)
	if err != nil || !requested {
		t.Fatalf("parse = %#v, %t, %v", parsed, requested, err)
	}
	values := map[string]string{
		"NOTES_ENVIRONMENT":  "test",
		"NOTES_DATABASE_URL": "postgres://notes:secret@127.0.0.1:55432/fukamu_notes_go_test",
	}
	var stderr bytes.Buffer
	code := runOrphanScan(
		context.Background(), parsed, rejectingWriter{}, &stderr,
		func(key string) (string, bool) { value, ok := values[key]; return value, ok },
		func(context.Context, string, string, operations.OrphanScanCommand) (operations.OrphanScanResult, error) {
			return operations.OrphanScanResult{Kind: operations.OrphanScanCompleted}, nil
		},
	)
	if code != 1 || stderr.String() != "orphan scan output failed\n" {
		t.Fatalf("code = %d, stderr = %q", code, stderr.String())
	}
}

func runOrphanScanForTest(
	t *testing.T,
	ctx context.Context,
	arguments []string,
	values map[string]string,
	scan scanOrphansFunction,
) (int, string, string) {
	t.Helper()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := runWithDependencies(
		ctx, arguments, &stdout, &stderr,
		func(key string) (string, bool) { value, ok := values[key]; return value, ok },
		func(context.Context, string) error { t.Fatal("migration must not run"); return nil },
		func(context.Context, string, string) error { t.Fatal("e2e preparation must not run"); return nil },
		func(context.Context, string, operations.QuotaCandidateQuery) (operations.QuotaAuditResult, error) {
			t.Fatal("quota audit must not run")
			return operations.QuotaAuditResult{}, nil
		},
		func(context.Context, string, operations.QuotaCommitCommand) (operations.QuotaCommitResult, error) {
			t.Fatal("quota commit must not run")
			return operations.QuotaCommitResult{}, nil
		},
		func(context.Context, string, operations.AccountDeletionAuditQuery) (operations.AccountDeletionAuditResult, error) {
			t.Fatal("account deletion audit must not run")
			return operations.AccountDeletionAuditResult{}, nil
		},
		billingReconciliationMustNotRun(t),
		dekRotationMustNotRun(t),
		dekReencryptionMustNotRun(t),
		scan,
	)
	return code, stdout.String(), stderr.String()
}

func orphanScanCLIArguments(environment, objectRoot string) []string {
	return []string{
		"objects", "orphan-scan",
		"--environment=" + environment,
		"--account-id=01991f20-61d2-7000-8000-000000000101",
		"--vault-id=01991f20-61d2-7000-8000-000000000201",
		"--scan-started-at-millis=10000",
		"--grace-period-millis=1000",
		"--limit=2",
		"--object-root=" + objectRoot,
		"--confirm-local-object-scan",
		"--confirm-delete-enqueue",
	}
}

func orphanScanMustNotRun(t *testing.T) scanOrphansFunction {
	t.Helper()
	return func(
		context.Context,
		string,
		string,
		operations.OrphanScanCommand,
	) (operations.OrphanScanResult, error) {
		t.Fatal("orphan scan must not run")
		return operations.OrphanScanResult{}, nil
	}
}

type rejectingWriter struct{}

func (rejectingWriter) Write([]byte) (int, error) {
	return 0, errors.New("write failed")
}

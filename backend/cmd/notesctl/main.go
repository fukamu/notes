package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/fukamu/notes/backend/internal/access"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/config"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/operations"
	"github.com/fukamu/notes/backend/internal/quota"
	"github.com/fukamu/notes/backend/migrations"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], os.Stdout, os.Stderr))
}

func run(ctx context.Context, arguments []string, stdout io.Writer, stderr io.Writer) int {
	return runWithDependencies(
		ctx,
		arguments,
		stdout,
		stderr,
		os.LookupEnv,
		migrateDatabase,
		prepareE2EDatabase,
		listQuotaReconciliationCandidates,
		finalizeQuotaReconciliationCommit,
	)
}

type migrateFunction func(context.Context, string) error
type prepareE2EFunction func(context.Context, string, string) error
type listQuotaCandidatesFunction func(
	context.Context,
	string,
	operations.QuotaCandidateQuery,
) (operations.QuotaAuditResult, error)
type finalizeQuotaCommitFunction func(
	context.Context,
	string,
	operations.QuotaCommitCommand,
) (operations.QuotaCommitResult, error)

func runWithDependencies(
	parent context.Context,
	arguments []string,
	stdout io.Writer,
	stderr io.Writer,
	lookup func(string) (string, bool),
	migrate migrateFunction,
	prepareE2E prepareE2EFunction,
	listQuotaCandidates listQuotaCandidatesFunction,
	finalizeQuotaCommit finalizeQuotaCommitFunction,
) int {
	if parent == nil || listQuotaCandidates == nil || finalizeQuotaCommit == nil {
		_, _ = fmt.Fprintln(stderr, "operation dependencies invalid")
		return 1
	}
	if len(arguments) == 2 && arguments[0] == "config" && arguments[1] == "check" {
		if _, err := config.Load(lookup); err != nil {
			_, _ = fmt.Fprintln(stderr, "configuration invalid")
			return 1
		}
		_, _ = fmt.Fprintln(stdout, "configuration valid")
		return 0
	}
	quotaAudit, quotaAuditRequested, quotaAuditErr := parseQuotaAuditArguments(arguments)
	if quotaAuditRequested {
		if quotaAuditErr != nil {
			printUsage(stderr)
			return 2
		}
		return runQuotaAudit(
			parent, quotaAudit, stdout, stderr, lookup, listQuotaCandidates,
		)
	}
	quotaCommit, quotaCommitRequested, quotaCommitErr := parseQuotaCommitArguments(arguments)
	if quotaCommitRequested {
		if quotaCommitErr != nil {
			printUsage(stderr)
			return 2
		}
		return runQuotaCommit(
			parent, quotaCommit, stdout, stderr, lookup, finalizeQuotaCommit,
		)
	}
	prepareE2ERequested := len(arguments) == 3 && arguments[0] == "prepare-e2e" &&
		arguments[1] == "--environment=test" && strings.HasPrefix(arguments[2], "--allowed-subject=")
	migrateRequested := len(arguments) == 2 && arguments[0] == "migrate" &&
		strings.HasPrefix(arguments[1], "--environment=")
	if !migrateRequested && !prepareE2ERequested {
		printUsage(stderr)
		return 2
	}
	requestedEnvironment := config.Environment(strings.TrimPrefix(arguments[1], "--environment="))
	databaseConfig, err := config.LoadDatabase(lookup)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "database configuration invalid")
		return 1
	}
	if requestedEnvironment != databaseConfig.Environment ||
		(requestedEnvironment != config.EnvironmentLocal && requestedEnvironment != config.EnvironmentTest) {
		_, _ = fmt.Fprintln(stderr, "migration environment refused")
		return 1
	}
	if err := postgresadapter.ValidateTestDatabaseURL(databaseConfig.URL); err != nil {
		_, _ = fmt.Fprintln(stderr, "migration target refused")
		return 1
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	defer cancel()
	if prepareE2ERequested {
		if requestedEnvironment != config.EnvironmentTest {
			_, _ = fmt.Fprintln(stderr, "e2e environment refused")
			return 1
		}
		subjectValue := strings.TrimPrefix(arguments[2], "--allowed-subject=")
		if _, err := access.ParseSubject(subjectValue); err != nil {
			_, _ = fmt.Fprintln(stderr, "e2e subject refused")
			return 1
		}
		if err := prepareE2E(ctx, databaseConfig.URL, subjectValue); err != nil {
			_, _ = fmt.Fprintln(stderr, "e2e preparation failed")
			return 1
		}
		_, _ = fmt.Fprintln(stdout, "e2e database prepared")
		return 0
	}
	if err := migrate(ctx, databaseConfig.URL); err != nil {
		_, _ = fmt.Fprintln(stderr, "migration failed")
		return 1
	}
	_, _ = fmt.Fprintln(stdout, "migration complete")
	return 0
}

type quotaAuditArguments struct {
	environment config.Environment
	production  bool
	query       operations.QuotaCandidateQuery
}

func parseQuotaAuditArguments(arguments []string) (quotaAuditArguments, bool, error) {
	if len(arguments) < 2 || arguments[0] != "quota" || arguments[1] != "reconcile-list" {
		return quotaAuditArguments{}, false, nil
	}
	values := make(map[string]string, 5)
	confirmedProduction := false
	for _, argument := range arguments[2:] {
		if argument == "--confirm-production-read-only" {
			if confirmedProduction {
				return quotaAuditArguments{}, true, operations.ErrQuotaReconciliationAudit
			}
			confirmedProduction = true
			continue
		}
		name, value, found := strings.Cut(argument, "=")
		if !found || value == "" ||
			(name != "--environment" && name != "--account-id" && name != "--vault-id" &&
				name != "--as-of-millis" && name != "--limit") {
			return quotaAuditArguments{}, true, operations.ErrQuotaReconciliationAudit
		}
		if _, duplicate := values[name]; duplicate {
			return quotaAuditArguments{}, true, operations.ErrQuotaReconciliationAudit
		}
		values[name] = value
	}
	if len(values) != 5 {
		return quotaAuditArguments{}, true, operations.ErrQuotaReconciliationAudit
	}
	environment := config.Environment(values["--environment"])
	if environment != config.EnvironmentLocal && environment != config.EnvironmentTest &&
		environment != config.EnvironmentProduction {
		return quotaAuditArguments{}, true, operations.ErrQuotaReconciliationAudit
	}
	if (environment == config.EnvironmentProduction) != confirmedProduction {
		return quotaAuditArguments{}, true, operations.ErrQuotaReconciliationAudit
	}
	accountID, err := identity.ParseAccountID(values["--account-id"])
	if err != nil {
		return quotaAuditArguments{}, true, operations.ErrQuotaReconciliationAudit
	}
	vaultID, err := identity.ParseVaultID(values["--vault-id"])
	if err != nil {
		return quotaAuditArguments{}, true, operations.ErrQuotaReconciliationAudit
	}
	asOfMillis, err := strconv.ParseInt(values["--as-of-millis"], 10, 64)
	if err != nil {
		return quotaAuditArguments{}, true, operations.ErrQuotaReconciliationAudit
	}
	limit, err := strconv.Atoi(values["--limit"])
	if err != nil {
		return quotaAuditArguments{}, true, operations.ErrQuotaReconciliationAudit
	}
	query := operations.QuotaCandidateQuery{
		AccountID: accountID, VaultID: vaultID, AsOfMillis: asOfMillis, Limit: limit,
	}
	if operations.ValidateQuotaCandidateQuery(query) != nil {
		return quotaAuditArguments{}, true, operations.ErrQuotaReconciliationAudit
	}
	return quotaAuditArguments{
		environment: environment, production: confirmedProduction, query: query,
	}, true, nil
}

func runQuotaAudit(
	parent context.Context,
	arguments quotaAuditArguments,
	stdout io.Writer,
	stderr io.Writer,
	lookup func(string) (string, bool),
	listQuotaCandidates listQuotaCandidatesFunction,
) int {
	databaseConfig, err := config.LoadDatabase(lookup)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "database configuration invalid")
		return 1
	}
	if arguments.environment != databaseConfig.Environment ||
		(arguments.environment == config.EnvironmentProduction && !arguments.production) {
		_, _ = fmt.Fprintln(stderr, "quota reconciliation environment refused")
		return 1
	}
	if arguments.environment != config.EnvironmentProduction {
		if err := postgresadapter.ValidateTestDatabaseURL(databaseConfig.URL); err != nil {
			_, _ = fmt.Fprintln(stderr, "quota reconciliation target refused")
			return 1
		}
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	defer cancel()
	result, err := listQuotaCandidates(ctx, databaseConfig.URL, arguments.query)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "quota reconciliation audit failed")
		return 1
	}
	switch result.Kind {
	case operations.QuotaAuditRefused:
		_, _ = fmt.Fprintln(stderr, "quota reconciliation scope refused")
		return 1
	case operations.QuotaAuditListed:
	default:
		_, _ = fmt.Fprintln(stderr, "quota reconciliation audit failed")
		return 1
	}
	type outputCandidate struct {
		ReservationID  string `json:"reservationId"`
		ReconcileAfter int64  `json:"reconcileAfter"`
	}
	output := struct {
		Command        string            `json:"command"`
		AsOfMillis     int64             `json:"asOfMillis"`
		CandidateCount int               `json:"candidateCount"`
		Candidates     []outputCandidate `json:"candidates"`
	}{
		Command: "quota-reconcile-list", AsOfMillis: result.AsOfMillis,
		CandidateCount: len(result.Candidates), Candidates: make([]outputCandidate, 0, len(result.Candidates)),
	}
	for _, candidate := range result.Candidates {
		output.Candidates = append(output.Candidates, outputCandidate{
			ReservationID: string(candidate.ReservationID), ReconcileAfter: candidate.ReconcileAfter,
		})
	}
	if err := json.NewEncoder(stdout).Encode(output); err != nil {
		_, _ = fmt.Fprintln(stderr, "quota reconciliation audit output failed")
		return 1
	}
	return 0
}

type quotaCommitArguments struct {
	environment config.Environment
	production  bool
	command     operations.QuotaCommitCommand
}

func parseQuotaCommitArguments(arguments []string) (quotaCommitArguments, bool, error) {
	if len(arguments) < 2 || arguments[0] != "quota" || arguments[1] != "reconcile-commit" {
		return quotaCommitArguments{}, false, nil
	}
	values := make(map[string]string, 5)
	confirmedEvidence := false
	confirmedProduction := false
	for _, argument := range arguments[2:] {
		switch argument {
		case "--confirm-durable-sync-receipt":
			if confirmedEvidence {
				return quotaCommitArguments{}, true, operations.ErrQuotaReconciliationAudit
			}
			confirmedEvidence = true
			continue
		case "--confirm-production-mutation":
			if confirmedProduction {
				return quotaCommitArguments{}, true, operations.ErrQuotaReconciliationAudit
			}
			confirmedProduction = true
			continue
		}
		name, value, found := strings.Cut(argument, "=")
		if !found || value == "" ||
			(name != "--environment" && name != "--account-id" && name != "--vault-id" &&
				name != "--reservation-id" && name != "--finalized-at-millis") {
			return quotaCommitArguments{}, true, operations.ErrQuotaReconciliationAudit
		}
		if _, duplicate := values[name]; duplicate {
			return quotaCommitArguments{}, true, operations.ErrQuotaReconciliationAudit
		}
		values[name] = value
	}
	if len(values) != 5 || !confirmedEvidence {
		return quotaCommitArguments{}, true, operations.ErrQuotaReconciliationAudit
	}
	environment := config.Environment(values["--environment"])
	if environment != config.EnvironmentLocal && environment != config.EnvironmentTest &&
		environment != config.EnvironmentProduction {
		return quotaCommitArguments{}, true, operations.ErrQuotaReconciliationAudit
	}
	if (environment == config.EnvironmentProduction) != confirmedProduction {
		return quotaCommitArguments{}, true, operations.ErrQuotaReconciliationAudit
	}
	accountID, err := identity.ParseAccountID(values["--account-id"])
	if err != nil {
		return quotaCommitArguments{}, true, operations.ErrQuotaReconciliationAudit
	}
	vaultID, err := identity.ParseVaultID(values["--vault-id"])
	if err != nil {
		return quotaCommitArguments{}, true, operations.ErrQuotaReconciliationAudit
	}
	reservationID, err := quota.ParseReservationID(values["--reservation-id"])
	if err != nil {
		return quotaCommitArguments{}, true, operations.ErrQuotaReconciliationAudit
	}
	finalizedAt, err := strconv.ParseInt(values["--finalized-at-millis"], 10, 64)
	if err != nil {
		return quotaCommitArguments{}, true, operations.ErrQuotaReconciliationAudit
	}
	command := operations.QuotaCommitCommand{
		AccountID: accountID, VaultID: vaultID,
		ReservationID: reservationID, FinalizedAt: finalizedAt,
	}
	if operations.ValidateQuotaCommitCommand(command) != nil {
		return quotaCommitArguments{}, true, operations.ErrQuotaReconciliationAudit
	}
	return quotaCommitArguments{
		environment: environment, production: confirmedProduction, command: command,
	}, true, nil
}

func runQuotaCommit(
	parent context.Context,
	arguments quotaCommitArguments,
	stdout io.Writer,
	stderr io.Writer,
	lookup func(string) (string, bool),
	finalize finalizeQuotaCommitFunction,
) int {
	databaseConfig, err := config.LoadDatabase(lookup)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "database configuration invalid")
		return 1
	}
	if arguments.environment != databaseConfig.Environment ||
		(arguments.environment == config.EnvironmentProduction && !arguments.production) {
		_, _ = fmt.Fprintln(stderr, "quota reconciliation environment refused")
		return 1
	}
	if arguments.environment != config.EnvironmentProduction {
		if err := postgresadapter.ValidateTestDatabaseURL(databaseConfig.URL); err != nil {
			_, _ = fmt.Fprintln(stderr, "quota reconciliation target refused")
			return 1
		}
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	defer cancel()
	result, err := finalize(ctx, databaseConfig.URL, arguments.command)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "quota reconciliation commit failed")
		return 1
	}
	if result.Kind == operations.QuotaCommitRefused {
		_, _ = fmt.Fprintln(stderr, "quota reconciliation commit refused")
		return 1
	}
	if (result.Kind != operations.QuotaCommitCommitted && result.Kind != operations.QuotaCommitReplayed) ||
		result.ReservationID != arguments.command.ReservationID {
		_, _ = fmt.Fprintln(stderr, "quota reconciliation commit failed")
		return 1
	}
	output := struct {
		Command       string `json:"command"`
		Outcome       string `json:"outcome"`
		ReservationID string `json:"reservationId"`
		FinalizedAt   int64  `json:"finalizedAt"`
	}{
		Command: "quota-reconcile-commit", Outcome: string(result.Kind),
		ReservationID: string(result.ReservationID), FinalizedAt: result.FinalizedAt,
	}
	if err := json.NewEncoder(stdout).Encode(output); err != nil {
		_, _ = fmt.Fprintln(stderr, "quota reconciliation commit output failed")
		return 1
	}
	return 0
}

func printUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "usage: notesctl config check | notesctl migrate --environment=local|test | notesctl prepare-e2e --environment=test --allowed-subject=<subject> | notesctl quota reconcile-list --environment=local|test|production --account-id=<uuidv7> --vault-id=<uuidv7> --as-of-millis=<unix-ms> --limit=1..100 [--confirm-production-read-only] | notesctl quota reconcile-commit --environment=local|test|production --account-id=<uuidv7> --vault-id=<uuidv7> --reservation-id=<uuidv7> --finalized-at-millis=<unix-ms> --confirm-durable-sync-receipt [--confirm-production-mutation]")
}

func prepareE2EDatabase(ctx context.Context, databaseURL string, allowedSubject string) error {
	database, err := postgresadapter.OpenSQL(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer database.Close()
	if _, err := database.ExecContext(ctx, "DROP SCHEMA public CASCADE; CREATE SCHEMA public"); err != nil {
		return err
	}
	migrator, err := postgresadapter.NewMigrator(database, migrations.Files)
	if err != nil {
		return err
	}
	if err := migrator.Up(ctx); err != nil {
		return err
	}
	_, err = database.ExecContext(
		ctx,
		"INSERT INTO launch_allowed_users(user_id, created_at) VALUES ($1, $2)",
		allowedSubject,
		time.Now().UnixMilli(),
	)
	return err
}

func migrateDatabase(ctx context.Context, databaseURL string) error {
	database, err := postgresadapter.OpenSQL(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer database.Close()
	migrator, err := postgresadapter.NewMigrator(database, migrations.Files)
	if err != nil {
		return err
	}
	return migrator.Up(ctx)
}

func listQuotaReconciliationCandidates(
	ctx context.Context,
	databaseURL string,
	query operations.QuotaCandidateQuery,
) (operations.QuotaAuditResult, error) {
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 2)
	if err != nil {
		return operations.QuotaAuditResult{}, err
	}
	defer pool.Close()
	store, err := postgresadapter.NewQuotaAuditStore(pool)
	if err != nil {
		return operations.QuotaAuditResult{}, err
	}
	service, err := operations.NewQuotaAuditService(store)
	if err != nil {
		return operations.QuotaAuditResult{}, err
	}
	return service.ListCandidates(ctx, query)
}

func finalizeQuotaReconciliationCommit(
	ctx context.Context,
	databaseURL string,
	command operations.QuotaCommitCommand,
) (operations.QuotaCommitResult, error) {
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 2)
	if err != nil {
		return operations.QuotaCommitResult{}, err
	}
	defer pool.Close()
	store, err := postgresadapter.NewQuotaCommitStore(pool)
	if err != nil {
		return operations.QuotaCommitResult{}, err
	}
	service, err := operations.NewQuotaCommitService(store)
	if err != nil {
		return operations.QuotaCommitResult{}, err
	}
	return service.Commit(ctx, command)
}

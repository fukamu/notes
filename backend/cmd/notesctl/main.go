package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/fukamu/notes/backend/internal/access"
	contentcryptoadapter "github.com/fukamu/notes/backend/internal/adapters/contentcrypto"
	kmsadapter "github.com/fukamu/notes/backend/internal/adapters/kms"
	objectstorageadapter "github.com/fukamu/notes/backend/internal/adapters/objectstorage"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	recoverybackupadapter "github.com/fukamu/notes/backend/internal/adapters/recoverybackup"
	recoverykeyadapter "github.com/fukamu/notes/backend/internal/adapters/recoverykey"
	stripeadapter "github.com/fukamu/notes/backend/internal/adapters/stripe"
	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/config"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/operations"
	"github.com/fukamu/notes/backend/internal/quota"
	"github.com/fukamu/notes/backend/internal/stripebilling"
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
		inspectAccountDeletion,
		reconcileBillingSubscription,
		rotateVaultDEK,
		reencryptVaultDEK,
		scanVaultOrphans,
		drainVaultDeleteOutbox,
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
type inspectAccountDeletionFunction func(
	context.Context,
	string,
	operations.AccountDeletionAuditQuery,
) (operations.AccountDeletionAuditResult, error)
type reconcileBillingFunction func(
	context.Context,
	string,
	stripebilling.RuntimeMode,
	string,
	operations.BillingReconciliationCommand,
) (operations.BillingReconciliationResult, error)
type rotateDEKFunction func(
	context.Context,
	string,
	string,
	string,
	operations.DEKRotationCommand,
) (operations.DEKRotationResult, error)
type reencryptDEKFunction func(
	context.Context,
	string,
	string,
	string,
	string,
	string,
	operations.DEKReencryptionCommand,
) (operations.DEKReencryptionResult, error)
type scanOrphansFunction func(
	context.Context,
	string,
	string,
	operations.OrphanScanCommand,
) (operations.OrphanScanResult, error)
type drainDeleteOutboxFunction func(
	context.Context,
	string,
	string,
	operations.DeleteOutboxCommand,
) (operations.DeleteOutboxResult, error)
type runRecoveryDrillFunction func(
	context.Context,
	string,
	string,
	operations.RecoveryDrillCommand,
) (operations.RecoveryDrillResult, error)

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
	inspectDeletion inspectAccountDeletionFunction,
	reconcileBilling reconcileBillingFunction,
	rotateDEK rotateDEKFunction,
	reencryptDEK reencryptDEKFunction,
	scanOrphans scanOrphansFunction,
	drainDeleteOutbox drainDeleteOutboxFunction,
) int {
	return runWithRecoveryDependency(
		parent, arguments, stdout, stderr, lookup, migrate, prepareE2E,
		listQuotaCandidates, finalizeQuotaCommit, inspectDeletion, reconcileBilling,
		rotateDEK, reencryptDEK, scanOrphans, drainDeleteOutbox, runVaultRecoveryDrill,
	)
}

func runWithRecoveryDependency(
	parent context.Context,
	arguments []string,
	stdout io.Writer,
	stderr io.Writer,
	lookup func(string) (string, bool),
	migrate migrateFunction,
	prepareE2E prepareE2EFunction,
	listQuotaCandidates listQuotaCandidatesFunction,
	finalizeQuotaCommit finalizeQuotaCommitFunction,
	inspectDeletion inspectAccountDeletionFunction,
	reconcileBilling reconcileBillingFunction,
	rotateDEK rotateDEKFunction,
	reencryptDEK reencryptDEKFunction,
	scanOrphans scanOrphansFunction,
	drainDeleteOutbox drainDeleteOutboxFunction,
	recoveryDrill runRecoveryDrillFunction,
) int {
	if parent == nil || listQuotaCandidates == nil || finalizeQuotaCommit == nil || inspectDeletion == nil ||
		reconcileBilling == nil || rotateDEK == nil || reencryptDEK == nil || scanOrphans == nil ||
		drainDeleteOutbox == nil || recoveryDrill == nil {
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
	deletionAudit, deletionAuditRequested, deletionAuditErr := parseAccountDeletionAuditArguments(arguments)
	if deletionAuditRequested {
		if deletionAuditErr != nil {
			printUsage(stderr)
			return 2
		}
		return runAccountDeletionAudit(
			parent, deletionAudit, stdout, stderr, lookup, inspectDeletion,
		)
	}
	billingReconciliation, billingReconciliationRequested, billingReconciliationErr :=
		parseBillingReconciliationArguments(arguments)
	if billingReconciliationRequested {
		if billingReconciliationErr != nil {
			printUsage(stderr)
			return 2
		}
		return runBillingReconciliation(
			parent, billingReconciliation, stdout, stderr, lookup, reconcileBilling,
		)
	}
	dekRotation, dekRotationRequested, dekRotationErr := parseDEKRotationArguments(arguments)
	if dekRotationRequested {
		if dekRotationErr != nil {
			printUsage(stderr)
			return 2
		}
		return runDEKRotation(parent, dekRotation, stdout, stderr, lookup, rotateDEK)
	}
	dekReencryption, dekReencryptionRequested, dekReencryptionErr := parseDEKReencryptionArguments(arguments)
	if dekReencryptionRequested {
		if dekReencryptionErr != nil {
			printUsage(stderr)
			return 2
		}
		return runDEKReencryption(parent, dekReencryption, stdout, stderr, lookup, reencryptDEK)
	}
	orphanScan, orphanScanRequested, orphanScanErr := parseOrphanScanArguments(arguments)
	if orphanScanRequested {
		if orphanScanErr != nil {
			printUsage(stderr)
			return 2
		}
		return runOrphanScan(parent, orphanScan, stdout, stderr, lookup, scanOrphans)
	}
	deleteOutbox, deleteOutboxRequested, deleteOutboxErr := parseDeleteOutboxArguments(arguments)
	if deleteOutboxRequested {
		if deleteOutboxErr != nil {
			printUsage(stderr)
			return 2
		}
		return runDeleteOutbox(parent, deleteOutbox, stdout, stderr, lookup, drainDeleteOutbox)
	}
	recovery, recoveryRequested, recoveryErr := parseRecoveryDrillArguments(arguments)
	if recoveryRequested {
		if recoveryErr != nil {
			printUsage(stderr)
			return 2
		}
		return runRecoveryDrill(parent, recovery, stdout, stderr, lookup, recoveryDrill)
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

type accountDeletionAuditArguments struct {
	environment config.Environment
	production  bool
	query       operations.AccountDeletionAuditQuery
}

func parseAccountDeletionAuditArguments(
	arguments []string,
) (accountDeletionAuditArguments, bool, error) {
	if len(arguments) < 2 || arguments[0] != "account-deletion" || arguments[1] != "inspect" {
		return accountDeletionAuditArguments{}, false, nil
	}
	values := make(map[string]string, 4)
	confirmedProduction := false
	for _, argument := range arguments[2:] {
		if argument == "--confirm-production-read-only" {
			if confirmedProduction {
				return accountDeletionAuditArguments{}, true, operations.ErrAccountDeletionAudit
			}
			confirmedProduction = true
			continue
		}
		name, value, found := strings.Cut(argument, "=")
		if !found || value == "" ||
			(name != "--environment" && name != "--account-id" && name != "--vault-id" &&
				name != "--observed-at-millis") {
			return accountDeletionAuditArguments{}, true, operations.ErrAccountDeletionAudit
		}
		if _, duplicate := values[name]; duplicate {
			return accountDeletionAuditArguments{}, true, operations.ErrAccountDeletionAudit
		}
		values[name] = value
	}
	if len(values) != 4 {
		return accountDeletionAuditArguments{}, true, operations.ErrAccountDeletionAudit
	}
	environment := config.Environment(values["--environment"])
	if environment != config.EnvironmentLocal && environment != config.EnvironmentTest &&
		environment != config.EnvironmentProduction {
		return accountDeletionAuditArguments{}, true, operations.ErrAccountDeletionAudit
	}
	if (environment == config.EnvironmentProduction) != confirmedProduction {
		return accountDeletionAuditArguments{}, true, operations.ErrAccountDeletionAudit
	}
	accountID, err := identity.ParseAccountID(values["--account-id"])
	if err != nil {
		return accountDeletionAuditArguments{}, true, operations.ErrAccountDeletionAudit
	}
	vaultID, err := identity.ParseVaultID(values["--vault-id"])
	if err != nil {
		return accountDeletionAuditArguments{}, true, operations.ErrAccountDeletionAudit
	}
	observedAt, err := strconv.ParseInt(values["--observed-at-millis"], 10, 64)
	if err != nil {
		return accountDeletionAuditArguments{}, true, operations.ErrAccountDeletionAudit
	}
	query := operations.AccountDeletionAuditQuery{
		AccountID: accountID, VaultID: vaultID, ObservedAt: observedAt,
	}
	if operations.ValidateAccountDeletionAuditQuery(query) != nil {
		return accountDeletionAuditArguments{}, true, operations.ErrAccountDeletionAudit
	}
	return accountDeletionAuditArguments{
		environment: environment, production: confirmedProduction, query: query,
	}, true, nil
}

func runAccountDeletionAudit(
	parent context.Context,
	arguments accountDeletionAuditArguments,
	stdout io.Writer,
	stderr io.Writer,
	lookup func(string) (string, bool),
	inspect inspectAccountDeletionFunction,
) int {
	databaseConfig, err := config.LoadDatabase(lookup)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "database configuration invalid")
		return 1
	}
	if arguments.environment != databaseConfig.Environment ||
		(arguments.environment == config.EnvironmentProduction && !arguments.production) {
		_, _ = fmt.Fprintln(stderr, "account deletion audit environment refused")
		return 1
	}
	if arguments.environment != config.EnvironmentProduction {
		if err := postgresadapter.ValidateTestDatabaseURL(databaseConfig.URL); err != nil {
			_, _ = fmt.Fprintln(stderr, "account deletion audit target refused")
			return 1
		}
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	defer cancel()
	result, err := inspect(ctx, databaseConfig.URL, arguments.query)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "account deletion audit failed")
		return 1
	}
	if result.Kind == operations.AccountDeletionAuditRefused {
		_, _ = fmt.Fprintln(stderr, "account deletion scope refused")
		return 1
	}
	if result.Kind != operations.AccountDeletionAuditInspected || result.OperationID == "" ||
		result.State == "" || result.ObservedAt != arguments.query.ObservedAt {
		_, _ = fmt.Fprintln(stderr, "account deletion audit failed")
		return 1
	}
	output := struct {
		Command        string `json:"command"`
		OperationID    string `json:"operationId"`
		State          string `json:"state"`
		Step           string `json:"step,omitempty"`
		ReadyToAdvance bool   `json:"readyToAdvance"`
		RelevantAt     int64  `json:"relevantAt"`
		ObservedAt     int64  `json:"observedAt"`
	}{
		Command: "account-deletion-inspect", OperationID: string(result.OperationID),
		State: string(result.State), Step: string(result.Step), ReadyToAdvance: result.ReadyToAdvance,
		RelevantAt: result.RelevantAt, ObservedAt: result.ObservedAt,
	}
	if err := json.NewEncoder(stdout).Encode(output); err != nil {
		_, _ = fmt.Fprintln(stderr, "account deletion audit output failed")
		return 1
	}
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

type billingReconciliationArguments struct {
	environment config.Environment
	production  bool
	command     operations.BillingReconciliationCommand
}

func parseBillingReconciliationArguments(
	arguments []string,
) (billingReconciliationArguments, bool, error) {
	if len(arguments) < 2 || arguments[0] != "billing" || arguments[1] != "reconcile" {
		return billingReconciliationArguments{}, false, nil
	}
	values := make(map[string]string, 6)
	confirmedProduction := false
	for _, argument := range arguments[2:] {
		if argument == "--confirm-production-provider-read" {
			if confirmedProduction {
				return billingReconciliationArguments{}, true, operations.ErrBillingReconciliation
			}
			confirmedProduction = true
			continue
		}
		name, value, found := strings.Cut(argument, "=")
		if !found || value == "" ||
			(name != "--environment" && name != "--account-id" && name != "--vault-id" &&
				name != "--snapshot-id" && name != "--observed-at-millis" && name != "--recorded-at-millis") {
			return billingReconciliationArguments{}, true, operations.ErrBillingReconciliation
		}
		if _, duplicate := values[name]; duplicate {
			return billingReconciliationArguments{}, true, operations.ErrBillingReconciliation
		}
		values[name] = value
	}
	if len(values) != 6 {
		return billingReconciliationArguments{}, true, operations.ErrBillingReconciliation
	}
	environment := config.Environment(values["--environment"])
	if environment != config.EnvironmentLocal && environment != config.EnvironmentTest &&
		environment != config.EnvironmentProduction {
		return billingReconciliationArguments{}, true, operations.ErrBillingReconciliation
	}
	if (environment == config.EnvironmentProduction) != confirmedProduction {
		return billingReconciliationArguments{}, true, operations.ErrBillingReconciliation
	}
	accountID, err := identity.ParseAccountID(values["--account-id"])
	if err != nil {
		return billingReconciliationArguments{}, true, operations.ErrBillingReconciliation
	}
	vaultID, err := identity.ParseVaultID(values["--vault-id"])
	if err != nil {
		return billingReconciliationArguments{}, true, operations.ErrBillingReconciliation
	}
	snapshotID, err := billing.ParseReconciliationSnapshotID(values["--snapshot-id"])
	if err != nil {
		return billingReconciliationArguments{}, true, operations.ErrBillingReconciliation
	}
	observedAt, err := strconv.ParseInt(values["--observed-at-millis"], 10, 64)
	if err != nil {
		return billingReconciliationArguments{}, true, operations.ErrBillingReconciliation
	}
	recordedAt, err := strconv.ParseInt(values["--recorded-at-millis"], 10, 64)
	if err != nil {
		return billingReconciliationArguments{}, true, operations.ErrBillingReconciliation
	}
	command := operations.BillingReconciliationCommand{
		AccountID: accountID, VaultID: vaultID, SnapshotID: snapshotID,
		ObservedAt: observedAt, RecordedAt: recordedAt,
	}
	if operations.ValidateBillingReconciliationCommand(command) != nil {
		return billingReconciliationArguments{}, true, operations.ErrBillingReconciliation
	}
	return billingReconciliationArguments{
		environment: environment, production: confirmedProduction, command: command,
	}, true, nil
}

func runBillingReconciliation(
	parent context.Context,
	arguments billingReconciliationArguments,
	stdout io.Writer,
	stderr io.Writer,
	lookup func(string) (string, bool),
	reconcile reconcileBillingFunction,
) int {
	databaseConfig, err := config.LoadDatabase(lookup)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "database configuration invalid")
		return 1
	}
	if arguments.environment != databaseConfig.Environment ||
		(arguments.environment == config.EnvironmentProduction && !arguments.production) {
		_, _ = fmt.Fprintln(stderr, "billing reconciliation environment refused")
		return 1
	}
	if arguments.environment != config.EnvironmentProduction {
		if err := postgresadapter.ValidateTestDatabaseURL(databaseConfig.URL); err != nil {
			_, _ = fmt.Fprintln(stderr, "billing reconciliation target refused")
			return 1
		}
	}
	apiKey, found := lookup("NOTES_STRIPE_API_KEY")
	if !found || apiKey == "" || strings.ContainsAny(apiKey, "\r\n\x00") {
		_, _ = fmt.Fprintln(stderr, "billing reconciliation provider configuration invalid")
		return 1
	}
	mode := stripebilling.ModeTest
	if arguments.environment == config.EnvironmentProduction {
		mode = stripebilling.ModeLive
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	defer cancel()
	result, err := reconcile(ctx, databaseConfig.URL, mode, apiKey, arguments.command)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "billing reconciliation failed")
		return 1
	}
	if result.Kind == operations.BillingReconciliationRefused {
		_, _ = fmt.Fprintln(stderr, "billing reconciliation scope refused")
		return 1
	}
	if (result.Kind != operations.BillingReconciliationApplied &&
		result.Kind != operations.BillingReconciliationIgnored &&
		result.Kind != operations.BillingReconciliationReplayed) ||
		result.SnapshotID != arguments.command.SnapshotID ||
		result.ObservedAt != arguments.command.ObservedAt || result.RecordedAt != arguments.command.RecordedAt {
		_, _ = fmt.Fprintln(stderr, "billing reconciliation failed")
		return 1
	}
	output := struct {
		Command    string `json:"command"`
		Outcome    string `json:"outcome"`
		SnapshotID string `json:"snapshotId"`
		ObservedAt int64  `json:"observedAt"`
		RecordedAt int64  `json:"recordedAt"`
	}{
		Command: "billing-reconcile", Outcome: string(result.Kind),
		SnapshotID: string(result.SnapshotID), ObservedAt: result.ObservedAt, RecordedAt: result.RecordedAt,
	}
	if err := json.NewEncoder(stdout).Encode(output); err != nil {
		_, _ = fmt.Fprintln(stderr, "billing reconciliation output failed")
		return 1
	}
	return 0
}

type dekRotationArguments struct {
	environment config.Environment
	production  bool
	command     operations.DEKRotationCommand
}

func parseDEKRotationArguments(arguments []string) (dekRotationArguments, bool, error) {
	if len(arguments) < 2 || arguments[0] != "dek" || arguments[1] != "rotate" {
		return dekRotationArguments{}, false, nil
	}
	values := make(map[string]string, 7)
	confirmedGeneration := false
	confirmedProduction := false
	for _, argument := range arguments[2:] {
		switch argument {
		case "--confirm-kms-key-generation":
			if confirmedGeneration {
				return dekRotationArguments{}, true, operations.ErrDEKRotation
			}
			confirmedGeneration = true
			continue
		case "--confirm-production-kms-mutation":
			if confirmedProduction {
				return dekRotationArguments{}, true, operations.ErrDEKRotation
			}
			confirmedProduction = true
			continue
		}
		name, value, found := strings.Cut(argument, "=")
		if !found || value == "" ||
			(name != "--environment" && name != "--account-id" && name != "--vault-id" &&
				name != "--operation-id" && name != "--requested-at-millis" &&
				name != "--generated-at-millis" && name != "--completed-at-millis") {
			return dekRotationArguments{}, true, operations.ErrDEKRotation
		}
		if _, duplicate := values[name]; duplicate {
			return dekRotationArguments{}, true, operations.ErrDEKRotation
		}
		values[name] = value
	}
	if len(values) != 7 || !confirmedGeneration {
		return dekRotationArguments{}, true, operations.ErrDEKRotation
	}
	environment := config.Environment(values["--environment"])
	if environment != config.EnvironmentLocal && environment != config.EnvironmentTest &&
		environment != config.EnvironmentProduction {
		return dekRotationArguments{}, true, operations.ErrDEKRotation
	}
	if (environment == config.EnvironmentProduction) != confirmedProduction {
		return dekRotationArguments{}, true, operations.ErrDEKRotation
	}
	accountID, err := identity.ParseAccountID(values["--account-id"])
	if err != nil {
		return dekRotationArguments{}, true, operations.ErrDEKRotation
	}
	vaultID, err := identity.ParseVaultID(values["--vault-id"])
	if err != nil {
		return dekRotationArguments{}, true, operations.ErrDEKRotation
	}
	operationID, err := cryptocontent.ParseRotationOperationID(values["--operation-id"])
	if err != nil {
		return dekRotationArguments{}, true, operations.ErrDEKRotation
	}
	requestedAt, err := strconv.ParseInt(values["--requested-at-millis"], 10, 64)
	if err != nil {
		return dekRotationArguments{}, true, operations.ErrDEKRotation
	}
	generatedAt, err := strconv.ParseInt(values["--generated-at-millis"], 10, 64)
	if err != nil {
		return dekRotationArguments{}, true, operations.ErrDEKRotation
	}
	completedAt, err := strconv.ParseInt(values["--completed-at-millis"], 10, 64)
	if err != nil {
		return dekRotationArguments{}, true, operations.ErrDEKRotation
	}
	command := operations.DEKRotationCommand{
		AccountID: accountID, VaultID: vaultID, OperationID: operationID,
		RequestedAtMilli: requestedAt, GeneratedAtMilli: generatedAt, CompletedAtMilli: completedAt,
	}
	if operations.ValidateDEKRotationCommand(command) != nil {
		return dekRotationArguments{}, true, operations.ErrDEKRotation
	}
	return dekRotationArguments{
		environment: environment, production: confirmedProduction, command: command,
	}, true, nil
}

func runDEKRotation(
	parent context.Context,
	arguments dekRotationArguments,
	stdout io.Writer,
	stderr io.Writer,
	lookup func(string) (string, bool),
	rotate rotateDEKFunction,
) int {
	databaseConfig, err := config.LoadDatabase(lookup)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "database configuration invalid")
		return 1
	}
	if arguments.environment != databaseConfig.Environment ||
		(arguments.environment == config.EnvironmentProduction && !arguments.production) {
		_, _ = fmt.Fprintln(stderr, "DEK rotation environment refused")
		return 1
	}
	if arguments.environment != config.EnvironmentProduction {
		if err := postgresadapter.ValidateTestDatabaseURL(databaseConfig.URL); err != nil {
			_, _ = fmt.Fprintln(stderr, "DEK rotation target refused")
			return 1
		}
	}
	keyVersion, keyVersionFound := lookup("NOTES_GCP_KMS_CRYPTO_KEY_VERSION")
	accessToken, tokenFound := lookup("NOTES_GCP_KMS_ACCESS_TOKEN")
	if !keyVersionFound || keyVersion == "" || strings.ContainsAny(keyVersion, "\r\n\x00") ||
		!tokenFound || !validKMSAccessToken(accessToken) {
		_, _ = fmt.Fprintln(stderr, "DEK rotation provider configuration invalid")
		return 1
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	defer cancel()
	result, err := rotate(ctx, databaseConfig.URL, keyVersion, accessToken, arguments.command)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "DEK rotation failed")
		return 1
	}
	if result.Kind == operations.DEKRotationRefused {
		_, _ = fmt.Fprintln(stderr, "DEK rotation scope refused")
		return 1
	}
	if (result.Kind != operations.DEKRotationCompleted && result.Kind != operations.DEKRotationReplayed) ||
		result.OperationID != arguments.command.OperationID {
		_, _ = fmt.Fprintln(stderr, "DEK rotation failed")
		return 1
	}
	output := struct {
		Command           string `json:"command"`
		Outcome           string `json:"outcome"`
		OperationID       string `json:"operationId"`
		RequestedAtMillis int64  `json:"requestedAtMillis"`
		GeneratedAtMillis int64  `json:"generatedAtMillis"`
		CompletedAtMillis int64  `json:"completedAtMillis"`
	}{
		Command: "dek-rotate", Outcome: string(result.Kind), OperationID: string(result.OperationID),
		RequestedAtMillis: arguments.command.RequestedAtMilli,
		GeneratedAtMillis: arguments.command.GeneratedAtMilli,
		CompletedAtMillis: arguments.command.CompletedAtMilli,
	}
	if err := json.NewEncoder(stdout).Encode(output); err != nil {
		_, _ = fmt.Fprintln(stderr, "DEK rotation output failed")
		return 1
	}
	return 0
}

type dekReencryptionArguments struct {
	environment config.Environment
	objectRoot  string
	nonceRoot   string
	command     operations.DEKReencryptionCommand
}

func parseDEKReencryptionArguments(arguments []string) (dekReencryptionArguments, bool, error) {
	if len(arguments) < 2 || arguments[0] != "dek" || arguments[1] != "reencrypt" {
		return dekReencryptionArguments{}, false, nil
	}
	values := make(map[string]string, 8)
	confirmedObjects := false
	confirmedKMS := false
	for _, argument := range arguments[2:] {
		switch argument {
		case "--confirm-local-object-writes":
			if confirmedObjects {
				return dekReencryptionArguments{}, true, operations.ErrDEKReencryption
			}
			confirmedObjects = true
			continue
		case "--confirm-kms-unwrapping":
			if confirmedKMS {
				return dekReencryptionArguments{}, true, operations.ErrDEKReencryption
			}
			confirmedKMS = true
			continue
		}
		name, value, found := strings.Cut(argument, "=")
		if !found || value == "" || strings.ContainsAny(value, "\r\n\x00") ||
			(name != "--environment" && name != "--account-id" && name != "--vault-id" &&
				name != "--target-version" && name != "--limit" && name != "--performed-at-millis" &&
				name != "--object-root" && name != "--nonce-root") {
			return dekReencryptionArguments{}, true, operations.ErrDEKReencryption
		}
		if _, duplicate := values[name]; duplicate {
			return dekReencryptionArguments{}, true, operations.ErrDEKReencryption
		}
		values[name] = value
	}
	if len(values) != 8 || !confirmedObjects || !confirmedKMS {
		return dekReencryptionArguments{}, true, operations.ErrDEKReencryption
	}
	objectRoot := values["--object-root"]
	nonceRoot := values["--nonce-root"]
	if len(objectRoot) > 4_096 || len(nonceRoot) > 4_096 || !filepath.IsAbs(objectRoot) ||
		!filepath.IsAbs(nonceRoot) || filepath.Clean(objectRoot) == filepath.Clean(nonceRoot) {
		return dekReencryptionArguments{}, true, operations.ErrDEKReencryption
	}
	environment := config.Environment(values["--environment"])
	if environment != config.EnvironmentLocal && environment != config.EnvironmentTest {
		return dekReencryptionArguments{}, true, operations.ErrDEKReencryption
	}
	accountID, err := identity.ParseAccountID(values["--account-id"])
	if err != nil {
		return dekReencryptionArguments{}, true, operations.ErrDEKReencryption
	}
	vaultID, err := identity.ParseVaultID(values["--vault-id"])
	if err != nil {
		return dekReencryptionArguments{}, true, operations.ErrDEKReencryption
	}
	targetVersionValue, err := strconv.ParseInt(values["--target-version"], 10, 64)
	if err != nil {
		return dekReencryptionArguments{}, true, operations.ErrDEKReencryption
	}
	targetVersion, err := cryptocontent.ParseDEKVersion(targetVersionValue)
	if err != nil {
		return dekReencryptionArguments{}, true, operations.ErrDEKReencryption
	}
	limit, err := strconv.Atoi(values["--limit"])
	if err != nil {
		return dekReencryptionArguments{}, true, operations.ErrDEKReencryption
	}
	performedAt, err := strconv.ParseInt(values["--performed-at-millis"], 10, 64)
	if err != nil {
		return dekReencryptionArguments{}, true, operations.ErrDEKReencryption
	}
	command := operations.DEKReencryptionCommand{
		AccountID: accountID, VaultID: vaultID, TargetVersion: targetVersion,
		Limit: limit, PerformedAtMilli: performedAt,
	}
	if operations.ValidateDEKReencryptionCommand(command) != nil {
		return dekReencryptionArguments{}, true, operations.ErrDEKReencryption
	}
	return dekReencryptionArguments{
		environment: environment,
		objectRoot:  objectRoot,
		nonceRoot:   nonceRoot,
		command:     command,
	}, true, nil
}

func runDEKReencryption(
	parent context.Context,
	arguments dekReencryptionArguments,
	stdout io.Writer,
	stderr io.Writer,
	lookup func(string) (string, bool),
	reencrypt reencryptDEKFunction,
) int {
	databaseConfig, err := config.LoadDatabase(lookup)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "database configuration invalid")
		return 1
	}
	if arguments.environment != databaseConfig.Environment {
		_, _ = fmt.Fprintln(stderr, "DEK re-encryption environment refused")
		return 1
	}
	if err := postgresadapter.ValidateTestDatabaseURL(databaseConfig.URL); err != nil {
		_, _ = fmt.Fprintln(stderr, "DEK re-encryption target refused")
		return 1
	}
	keyVersion, keyVersionFound := lookup("NOTES_GCP_KMS_CRYPTO_KEY_VERSION")
	accessToken, tokenFound := lookup("NOTES_GCP_KMS_ACCESS_TOKEN")
	if !keyVersionFound || keyVersion == "" || strings.ContainsAny(keyVersion, "\r\n\x00") ||
		!tokenFound || !validKMSAccessToken(accessToken) {
		_, _ = fmt.Fprintln(stderr, "DEK re-encryption provider configuration invalid")
		return 1
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	defer cancel()
	result, err := reencrypt(
		ctx,
		databaseConfig.URL,
		keyVersion,
		accessToken,
		arguments.objectRoot,
		arguments.nonceRoot,
		arguments.command,
	)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "DEK re-encryption failed")
		return 1
	}
	if result.Kind == operations.DEKReencryptionRefused {
		_, _ = fmt.Fprintln(stderr, "DEK re-encryption scope refused")
		return 1
	}
	if (result.Kind != operations.DEKReencryptionCompleted && result.Kind != operations.DEKReencryptionPending) ||
		result.TargetVersion != arguments.command.TargetVersion || result.Processed < 0 ||
		result.Processed > arguments.command.Limit {
		_, _ = fmt.Fprintln(stderr, "DEK re-encryption failed")
		return 1
	}
	output := struct {
		Command       string `json:"command"`
		Outcome       string `json:"outcome"`
		Processed     int    `json:"processed"`
		TargetVersion int64  `json:"targetVersion"`
		Pending       string `json:"pending,omitempty"`
	}{
		Command: "dek-reencrypt", Outcome: string(result.Kind), Processed: result.Processed,
		TargetVersion: int64(result.TargetVersion), Pending: string(result.Pending),
	}
	if err := json.NewEncoder(stdout).Encode(output); err != nil {
		_, _ = fmt.Fprintln(stderr, "DEK re-encryption output failed")
		return 1
	}
	return 0
}

func validKMSAccessToken(value string) bool {
	if len(value) < 20 || len(value) > 8_192 {
		return false
	}
	for index := range len(value) {
		if value[index] < 0x21 || value[index] > 0x7e {
			return false
		}
	}
	return true
}

type orphanScanArguments struct {
	environment config.Environment
	objectRoot  string
	command     operations.OrphanScanCommand
}

func parseOrphanScanArguments(arguments []string) (orphanScanArguments, bool, error) {
	if len(arguments) < 2 || arguments[0] != "objects" || arguments[1] != "orphan-scan" {
		return orphanScanArguments{}, false, nil
	}
	values := make(map[string]string, 7)
	confirmedScan := false
	confirmedEnqueue := false
	for _, argument := range arguments[2:] {
		switch argument {
		case "--confirm-local-object-scan":
			if confirmedScan {
				return orphanScanArguments{}, true, operations.ErrOrphanScan
			}
			confirmedScan = true
			continue
		case "--confirm-delete-enqueue":
			if confirmedEnqueue {
				return orphanScanArguments{}, true, operations.ErrOrphanScan
			}
			confirmedEnqueue = true
			continue
		}
		name, value, found := strings.Cut(argument, "=")
		if !found || value == "" || strings.ContainsAny(value, "\r\n\x00") ||
			(name != "--environment" && name != "--account-id" && name != "--vault-id" &&
				name != "--scan-started-at-millis" && name != "--grace-period-millis" &&
				name != "--limit" && name != "--object-root") {
			return orphanScanArguments{}, true, operations.ErrOrphanScan
		}
		if _, duplicate := values[name]; duplicate {
			return orphanScanArguments{}, true, operations.ErrOrphanScan
		}
		values[name] = value
	}
	if len(values) != 7 || !confirmedScan || !confirmedEnqueue {
		return orphanScanArguments{}, true, operations.ErrOrphanScan
	}
	environment := config.Environment(values["--environment"])
	if environment != config.EnvironmentLocal && environment != config.EnvironmentTest {
		return orphanScanArguments{}, true, operations.ErrOrphanScan
	}
	objectRoot := values["--object-root"]
	if len(objectRoot) > 4_096 || !filepath.IsAbs(objectRoot) {
		return orphanScanArguments{}, true, operations.ErrOrphanScan
	}
	accountID, err := identity.ParseAccountID(values["--account-id"])
	if err != nil {
		return orphanScanArguments{}, true, operations.ErrOrphanScan
	}
	vaultID, err := identity.ParseVaultID(values["--vault-id"])
	if err != nil {
		return orphanScanArguments{}, true, operations.ErrOrphanScan
	}
	scanStartedAt, err := strconv.ParseInt(values["--scan-started-at-millis"], 10, 64)
	if err != nil {
		return orphanScanArguments{}, true, operations.ErrOrphanScan
	}
	gracePeriod, err := strconv.ParseInt(values["--grace-period-millis"], 10, 64)
	if err != nil {
		return orphanScanArguments{}, true, operations.ErrOrphanScan
	}
	limit, err := strconv.Atoi(values["--limit"])
	if err != nil {
		return orphanScanArguments{}, true, operations.ErrOrphanScan
	}
	command := operations.OrphanScanCommand{
		AccountID: accountID, VaultID: vaultID, ScanStartedAt: scanStartedAt,
		GracePeriodMilli: gracePeriod, Limit: limit,
	}
	if operations.ValidateOrphanScanCommand(command) != nil {
		return orphanScanArguments{}, true, operations.ErrOrphanScan
	}
	return orphanScanArguments{environment: environment, objectRoot: objectRoot, command: command}, true, nil
}

func runOrphanScan(
	parent context.Context,
	arguments orphanScanArguments,
	stdout io.Writer,
	stderr io.Writer,
	lookup func(string) (string, bool),
	scan scanOrphansFunction,
) int {
	databaseConfig, err := config.LoadDatabase(lookup)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "database configuration invalid")
		return 1
	}
	if arguments.environment != databaseConfig.Environment {
		_, _ = fmt.Fprintln(stderr, "orphan scan environment refused")
		return 1
	}
	if err := postgresadapter.ValidateTestDatabaseURL(databaseConfig.URL); err != nil {
		_, _ = fmt.Fprintln(stderr, "orphan scan target refused")
		return 1
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	defer cancel()
	result, err := scan(ctx, databaseConfig.URL, arguments.objectRoot, arguments.command)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "orphan scan failed")
		return 1
	}
	if result.Kind == operations.OrphanScanRefused {
		_, _ = fmt.Fprintln(stderr, "orphan scan scope refused")
		return 1
	}
	if (result.Kind != operations.OrphanScanCompleted && result.Kind != operations.OrphanScanPending) ||
		result.Enqueued < 0 || result.Enqueued > arguments.command.Limit ||
		(result.Kind == operations.OrphanScanPending && result.Enqueued != arguments.command.Limit) {
		_, _ = fmt.Fprintln(stderr, "orphan scan failed")
		return 1
	}
	output := struct {
		Command  string `json:"command"`
		Outcome  string `json:"outcome"`
		Enqueued int    `json:"enqueued"`
		Limit    int    `json:"limit"`
	}{
		Command: "objects-orphan-scan", Outcome: string(result.Kind),
		Enqueued: result.Enqueued, Limit: arguments.command.Limit,
	}
	if err := json.NewEncoder(stdout).Encode(output); err != nil {
		_, _ = fmt.Fprintln(stderr, "orphan scan output failed")
		return 1
	}
	return 0
}

type deleteOutboxArguments struct {
	environment config.Environment
	objectRoot  string
	command     operations.DeleteOutboxCommand
}

func parseDeleteOutboxArguments(arguments []string) (deleteOutboxArguments, bool, error) {
	if len(arguments) < 2 || arguments[0] != "objects" || arguments[1] != "delete-outbox" {
		return deleteOutboxArguments{}, false, nil
	}
	values := make(map[string]string, 7)
	confirmedDelete := false
	confirmedMutation := false
	for _, argument := range arguments[2:] {
		switch argument {
		case "--confirm-local-object-deletes":
			if confirmedDelete {
				return deleteOutboxArguments{}, true, operations.ErrDeleteOutboxDrain
			}
			confirmedDelete = true
			continue
		case "--confirm-delete-outbox-mutation":
			if confirmedMutation {
				return deleteOutboxArguments{}, true, operations.ErrDeleteOutboxDrain
			}
			confirmedMutation = true
			continue
		}
		name, value, found := strings.Cut(argument, "=")
		if !found || value == "" || strings.ContainsAny(value, "\r\n\x00") ||
			(name != "--environment" && name != "--account-id" && name != "--vault-id" &&
				name != "--attempted-at-millis" && name != "--retry-delay-millis" &&
				name != "--limit" && name != "--object-root") {
			return deleteOutboxArguments{}, true, operations.ErrDeleteOutboxDrain
		}
		if _, duplicate := values[name]; duplicate {
			return deleteOutboxArguments{}, true, operations.ErrDeleteOutboxDrain
		}
		values[name] = value
	}
	if len(values) != 7 || !confirmedDelete || !confirmedMutation {
		return deleteOutboxArguments{}, true, operations.ErrDeleteOutboxDrain
	}
	environment := config.Environment(values["--environment"])
	if environment != config.EnvironmentLocal && environment != config.EnvironmentTest {
		return deleteOutboxArguments{}, true, operations.ErrDeleteOutboxDrain
	}
	objectRoot := values["--object-root"]
	if len(objectRoot) > 4_096 || !filepath.IsAbs(objectRoot) {
		return deleteOutboxArguments{}, true, operations.ErrDeleteOutboxDrain
	}
	accountID, err := identity.ParseAccountID(values["--account-id"])
	if err != nil {
		return deleteOutboxArguments{}, true, operations.ErrDeleteOutboxDrain
	}
	vaultID, err := identity.ParseVaultID(values["--vault-id"])
	if err != nil {
		return deleteOutboxArguments{}, true, operations.ErrDeleteOutboxDrain
	}
	attemptedAt, err := strconv.ParseInt(values["--attempted-at-millis"], 10, 64)
	if err != nil {
		return deleteOutboxArguments{}, true, operations.ErrDeleteOutboxDrain
	}
	retryDelay, err := strconv.ParseInt(values["--retry-delay-millis"], 10, 64)
	if err != nil {
		return deleteOutboxArguments{}, true, operations.ErrDeleteOutboxDrain
	}
	limit, err := strconv.Atoi(values["--limit"])
	if err != nil {
		return deleteOutboxArguments{}, true, operations.ErrDeleteOutboxDrain
	}
	command := operations.DeleteOutboxCommand{
		Scope:       operations.DeleteOutboxScope{AccountID: accountID, VaultID: vaultID},
		AttemptedAt: attemptedAt, RetryDelayMilli: retryDelay, Limit: limit,
	}
	if operations.ValidateDeleteOutboxCommand(command) != nil {
		return deleteOutboxArguments{}, true, operations.ErrDeleteOutboxDrain
	}
	return deleteOutboxArguments{environment: environment, objectRoot: objectRoot, command: command}, true, nil
}

func runDeleteOutbox(
	parent context.Context,
	arguments deleteOutboxArguments,
	stdout io.Writer,
	stderr io.Writer,
	lookup func(string) (string, bool),
	drain drainDeleteOutboxFunction,
) int {
	databaseConfig, err := config.LoadDatabase(lookup)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "delete outbox configuration invalid")
		return 1
	}
	if arguments.environment != databaseConfig.Environment {
		_, _ = fmt.Fprintln(stderr, "delete outbox environment refused")
		return 1
	}
	if err := postgresadapter.ValidateTestDatabaseURL(databaseConfig.URL); err != nil {
		_, _ = fmt.Fprintln(stderr, "delete outbox target refused")
		return 1
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	defer cancel()
	result, err := drain(ctx, databaseConfig.URL, arguments.objectRoot, arguments.command)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "delete outbox drain failed")
		return 1
	}
	if result.Kind == operations.DeleteOutboxRefused {
		_, _ = fmt.Fprintln(stderr, "delete outbox scope refused")
		return 1
	}
	processed := result.Completed + result.Retried + result.Replayed + result.Contended
	if (result.Kind != operations.DeleteOutboxCompleted && result.Kind != operations.DeleteOutboxPending) ||
		result.Completed < 0 || result.Retried < 0 || result.Replayed < 0 || result.Contended < 0 ||
		processed > arguments.command.Limit {
		_, _ = fmt.Fprintln(stderr, "delete outbox drain failed")
		return 1
	}
	output := struct {
		Command   string `json:"command"`
		Outcome   string `json:"outcome"`
		Completed int    `json:"completed"`
		Retried   int    `json:"retried"`
		Replayed  int    `json:"replayed"`
		Contended int    `json:"contended"`
		Limit     int    `json:"limit"`
	}{
		Command: "objects-delete-outbox", Outcome: string(result.Kind),
		Completed: result.Completed, Retried: result.Retried,
		Replayed: result.Replayed, Contended: result.Contended, Limit: arguments.command.Limit,
	}
	if err := json.NewEncoder(stdout).Encode(output); err != nil {
		_, _ = fmt.Fprintln(stderr, "delete outbox output failed")
		return 1
	}
	return 0
}

type recoveryDrillArguments struct {
	environment config.Environment
	backupRoot  string
	keyRoot     string
	command     operations.RecoveryDrillCommand
}

func parseRecoveryDrillArguments(arguments []string) (recoveryDrillArguments, bool, error) {
	if len(arguments) < 2 || arguments[0] != "recovery" || arguments[1] != "drill" {
		return recoveryDrillArguments{}, false, nil
	}
	values := make(map[string]string, 6)
	confirmedBackup := false
	confirmedKeys := false
	for _, argument := range arguments[2:] {
		switch argument {
		case "--confirm-local-backup-read":
			if confirmedBackup {
				return recoveryDrillArguments{}, true, operations.ErrRecoveryDrill
			}
			confirmedBackup = true
			continue
		case "--confirm-local-fixture-key-read":
			if confirmedKeys {
				return recoveryDrillArguments{}, true, operations.ErrRecoveryDrill
			}
			confirmedKeys = true
			continue
		}
		name, value, found := strings.Cut(argument, "=")
		if !found || value == "" || strings.ContainsAny(value, "\r\n\x00") ||
			(name != "--environment" && name != "--account-id" && name != "--vault-id" &&
				name != "--drilled-at-millis" && name != "--backup-root" && name != "--key-root") {
			return recoveryDrillArguments{}, true, operations.ErrRecoveryDrill
		}
		if _, duplicate := values[name]; duplicate {
			return recoveryDrillArguments{}, true, operations.ErrRecoveryDrill
		}
		values[name] = value
	}
	if len(values) != 6 || !confirmedBackup || !confirmedKeys {
		return recoveryDrillArguments{}, true, operations.ErrRecoveryDrill
	}
	environment := config.Environment(values["--environment"])
	if environment != config.EnvironmentLocal && environment != config.EnvironmentTest {
		return recoveryDrillArguments{}, true, operations.ErrRecoveryDrill
	}
	backupRoot := values["--backup-root"]
	keyRoot := values["--key-root"]
	if len(backupRoot) > 4_096 || len(keyRoot) > 4_096 || !filepath.IsAbs(backupRoot) ||
		!filepath.IsAbs(keyRoot) || filepath.Clean(backupRoot) == filepath.Clean(keyRoot) {
		return recoveryDrillArguments{}, true, operations.ErrRecoveryDrill
	}
	accountID, err := identity.ParseAccountID(values["--account-id"])
	if err != nil {
		return recoveryDrillArguments{}, true, operations.ErrRecoveryDrill
	}
	vaultID, err := identity.ParseVaultID(values["--vault-id"])
	if err != nil {
		return recoveryDrillArguments{}, true, operations.ErrRecoveryDrill
	}
	drilledAt, err := strconv.ParseInt(values["--drilled-at-millis"], 10, 64)
	if err != nil {
		return recoveryDrillArguments{}, true, operations.ErrRecoveryDrill
	}
	command := operations.RecoveryDrillCommand{
		AccountID: accountID, VaultID: vaultID, DrilledAt: drilledAt,
	}
	if operations.ValidateRecoveryDrillCommand(command) != nil {
		return recoveryDrillArguments{}, true, operations.ErrRecoveryDrill
	}
	return recoveryDrillArguments{
		environment: environment, backupRoot: backupRoot, keyRoot: keyRoot, command: command,
	}, true, nil
}

func runRecoveryDrill(
	parent context.Context,
	arguments recoveryDrillArguments,
	stdout io.Writer,
	stderr io.Writer,
	lookup func(string) (string, bool),
	runDrill runRecoveryDrillFunction,
) int {
	configuredEnvironment, found := lookup("NOTES_ENVIRONMENT")
	if !found || config.Environment(configuredEnvironment) != arguments.environment {
		_, _ = fmt.Fprintln(stderr, "recovery drill environment refused")
		return 1
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	defer cancel()
	result, err := runDrill(ctx, arguments.backupRoot, arguments.keyRoot, arguments.command)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "recovery drill failed")
		return 1
	}
	if !operations.ValidRecoveryDrillResult(result) {
		_, _ = fmt.Fprintln(stderr, "recovery drill failed")
		return 1
	}
	if result.Kind == operations.RecoveryDrillBlocked {
		output := struct {
			Command string `json:"command"`
			Outcome string `json:"outcome"`
			Reason  string `json:"reason"`
		}{Command: "recovery-drill", Outcome: string(result.Kind), Reason: string(result.Reason)}
		if err := json.NewEncoder(stdout).Encode(output); err != nil {
			_, _ = fmt.Fprintln(stderr, "recovery drill output failed")
			return 1
		}
		return 1
	}
	output := struct {
		Command          string `json:"command"`
		Outcome          string `json:"outcome"`
		SourceVersion    int64  `json:"sourceVersion"`
		TargetVersion    int64  `json:"targetVersion"`
		ObjectCount      int64  `json:"objectCount"`
		VerifiedVersions int    `json:"verifiedVersions"`
	}{
		Command: "recovery-drill", Outcome: string(result.Kind),
		SourceVersion: int64(result.SourceVersion), TargetVersion: int64(result.TargetVersion),
		ObjectCount: result.ObjectCount, VerifiedVersions: result.VerifiedVersions,
	}
	if err := json.NewEncoder(stdout).Encode(output); err != nil {
		_, _ = fmt.Fprintln(stderr, "recovery drill output failed")
		return 1
	}
	return 0
}

func printUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "usage: notesctl config check | notesctl migrate --environment=local|test | notesctl prepare-e2e --environment=test --allowed-subject=<subject> | notesctl quota reconcile-list --environment=local|test|production --account-id=<uuidv7> --vault-id=<uuidv7> --as-of-millis=<unix-ms> --limit=1..100 [--confirm-production-read-only] | notesctl quota reconcile-commit --environment=local|test|production --account-id=<uuidv7> --vault-id=<uuidv7> --reservation-id=<uuidv7> --finalized-at-millis=<unix-ms> --confirm-durable-sync-receipt [--confirm-production-mutation] | notesctl account-deletion inspect --environment=local|test|production --account-id=<uuidv7> --vault-id=<uuidv7> --observed-at-millis=<unix-ms> [--confirm-production-read-only] | notesctl billing reconcile --environment=local|test|production --account-id=<uuidv7> --vault-id=<uuidv7> --snapshot-id=<stable-id> --observed-at-millis=<unix-ms> --recorded-at-millis=<unix-ms> [--confirm-production-provider-read] | notesctl dek rotate --environment=local|test|production --account-id=<uuidv7> --vault-id=<uuidv7> --operation-id=<uuidv7> --requested-at-millis=<unix-ms> --generated-at-millis=<unix-ms> --completed-at-millis=<unix-ms> --confirm-kms-key-generation [--confirm-production-kms-mutation] | notesctl dek reencrypt --environment=local|test --account-id=<uuidv7> --vault-id=<uuidv7> --target-version=<version> --limit=1..100 --performed-at-millis=<unix-ms> --object-root=<absolute-secure-directory> --nonce-root=<absolute-secure-directory> --confirm-local-object-writes --confirm-kms-unwrapping | notesctl objects orphan-scan --environment=local|test --account-id=<uuidv7> --vault-id=<uuidv7> --scan-started-at-millis=<unix-ms> --grace-period-millis=<duration-ms> --limit=1..100 --object-root=<absolute-secure-directory> --confirm-local-object-scan --confirm-delete-enqueue | notesctl objects delete-outbox --environment=local|test --account-id=<uuidv7> --vault-id=<uuidv7> --attempted-at-millis=<unix-ms> --retry-delay-millis=<duration-ms> --limit=1..100 --object-root=<absolute-secure-directory> --confirm-local-object-deletes --confirm-delete-outbox-mutation | notesctl recovery drill --environment=local|test --account-id=<uuidv7> --vault-id=<uuidv7> --drilled-at-millis=<unix-ms> --backup-root=<absolute-private-directory> --key-root=<absolute-private-directory> --confirm-local-backup-read --confirm-local-fixture-key-read")
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

func inspectAccountDeletion(
	ctx context.Context,
	databaseURL string,
	query operations.AccountDeletionAuditQuery,
) (operations.AccountDeletionAuditResult, error) {
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 2)
	if err != nil {
		return operations.AccountDeletionAuditResult{}, err
	}
	defer pool.Close()
	store, err := postgresadapter.NewAccountDeletionStore(pool)
	if err != nil {
		return operations.AccountDeletionAuditResult{}, err
	}
	service, err := operations.NewAccountDeletionAuditService(store)
	if err != nil {
		return operations.AccountDeletionAuditResult{}, err
	}
	return service.Inspect(ctx, query)
}

func reconcileBillingSubscription(
	ctx context.Context,
	databaseURL string,
	mode stripebilling.RuntimeMode,
	apiKey string,
	command operations.BillingReconciliationCommand,
) (operations.BillingReconciliationResult, error) {
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 2)
	if err != nil {
		return operations.BillingReconciliationResult{}, err
	}
	defer pool.Close()
	billingStore, err := postgresadapter.NewBillingStore(pool)
	if err != nil {
		return operations.BillingReconciliationResult{}, err
	}
	ownership, err := postgresadapter.NewEntitlementStore(pool)
	if err != nil {
		return operations.BillingReconciliationResult{}, err
	}
	billingService, err := billing.NewService(ownership, billingStore)
	if err != nil {
		return operations.BillingReconciliationResult{}, err
	}
	provider, err := stripeadapter.NewProvider(apiKey, mode, &http.Client{Timeout: 30 * time.Second})
	if err != nil {
		return operations.BillingReconciliationResult{}, err
	}
	stripeReconciler, err := stripebilling.NewReconciliationService(billingService, provider)
	if err != nil {
		return operations.BillingReconciliationResult{}, err
	}
	service, err := operations.NewBillingReconciliationService(billingStore, stripeReconciler)
	if err != nil {
		return operations.BillingReconciliationResult{}, err
	}
	return service.Reconcile(ctx, command)
}

type fixedKMSAccessToken string

func (token fixedKMSAccessToken) ReadAccessToken(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return string(token), nil
}

type fixedKMSClock int64

func (clock fixedKMSClock) NowMillis() int64 { return int64(clock) }

func rotateVaultDEK(
	ctx context.Context,
	databaseURL string,
	keyVersion string,
	accessToken string,
	command operations.DEKRotationCommand,
) (operations.DEKRotationResult, error) {
	transport, err := kmsadapter.NewRESTTransport(
		fixedKMSAccessToken(accessToken),
		&http.Client{Timeout: 30 * time.Second},
	)
	if err != nil {
		return operations.DEKRotationResult{}, err
	}
	keys, err := kmsadapter.NewGCPKeyManagement(
		keyVersion,
		transport,
		kmsadapter.SecureEntropy{},
		fixedKMSClock(command.GeneratedAtMilli),
	)
	if err != nil {
		return operations.DEKRotationResult{}, err
	}
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 2)
	if err != nil {
		return operations.DEKRotationResult{}, err
	}
	defer pool.Close()
	store, err := postgresadapter.NewDEKRotationStore(pool)
	if err != nil {
		return operations.DEKRotationResult{}, err
	}
	rotation, err := cryptocontent.NewRotationService(store, keys)
	if err != nil {
		return operations.DEKRotationResult{}, err
	}
	service, err := operations.NewDEKRotationService(rotation)
	if err != nil {
		return operations.DEKRotationResult{}, err
	}
	return service.Run(ctx, command)
}

func reencryptVaultDEK(
	ctx context.Context,
	databaseURL string,
	keyVersion string,
	accessToken string,
	objectRoot string,
	nonceRoot string,
	command operations.DEKReencryptionCommand,
) (operations.DEKReencryptionResult, error) {
	objects, err := objectstorageadapter.NewDirectory(objectRoot)
	if err != nil {
		return operations.DEKReencryptionResult{}, err
	}
	nonces, err := contentcryptoadapter.NewDirectoryNonceReservations(nonceRoot)
	if err != nil {
		return operations.DEKReencryptionResult{}, err
	}
	transport, err := kmsadapter.NewRESTTransport(
		fixedKMSAccessToken(accessToken),
		&http.Client{Timeout: 30 * time.Second},
	)
	if err != nil {
		return operations.DEKReencryptionResult{}, err
	}
	keys, err := kmsadapter.NewGCPKeyManagement(
		keyVersion,
		transport,
		kmsadapter.SecureEntropy{},
		kmsadapter.SystemClock{},
	)
	if err != nil {
		return operations.DEKReencryptionResult{}, err
	}
	encryption, err := cryptocontent.NewService(
		keys,
		contentcryptoadapter.NewSecureRandomNonceGenerator(),
		nonces,
		contentcryptoadapter.AES256GCM{},
	)
	if err != nil {
		return operations.DEKReencryptionResult{}, err
	}
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 2)
	if err != nil {
		return operations.DEKReencryptionResult{}, err
	}
	defer pool.Close()
	loader, err := postgresadapter.NewDEKReencryptionScopeStore(pool)
	if err != nil {
		return operations.DEKReencryptionResult{}, err
	}
	repository, err := postgresadapter.NewEncryptedObjectStore(pool, command.VaultID)
	if err != nil {
		return operations.DEKReencryptionResult{}, err
	}
	batches, err := encryptedobject.NewReencryptionService(
		command.VaultID,
		repository,
		objects,
		objectstorageadapter.NewRandomObjectKeyGenerator(),
		encryption,
	)
	if err != nil {
		return operations.DEKReencryptionResult{}, err
	}
	service, err := operations.NewDEKReencryptionService(loader, batches)
	if err != nil {
		return operations.DEKReencryptionResult{}, err
	}
	return service.Run(ctx, command)
}

func scanVaultOrphans(
	ctx context.Context,
	databaseURL string,
	objectRoot string,
	command operations.OrphanScanCommand,
) (operations.OrphanScanResult, error) {
	objects, err := objectstorageadapter.NewDirectory(objectRoot)
	if err != nil {
		return operations.OrphanScanResult{}, err
	}
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 2)
	if err != nil {
		return operations.OrphanScanResult{}, err
	}
	defer pool.Close()
	loader, err := postgresadapter.NewOrphanScanScopeStore(pool)
	if err != nil {
		return operations.OrphanScanResult{}, err
	}
	repository, err := postgresadapter.NewEncryptedObjectStore(pool, command.VaultID)
	if err != nil {
		return operations.OrphanScanResult{}, err
	}
	collector, err := encryptedobject.NewOrphanCollector(repository, objects)
	if err != nil {
		return operations.OrphanScanResult{}, err
	}
	service, err := operations.NewOrphanScanService(loader, collector)
	if err != nil {
		return operations.OrphanScanResult{}, err
	}
	return service.Run(ctx, command)
}

func drainVaultDeleteOutbox(
	ctx context.Context,
	databaseURL string,
	objectRoot string,
	command operations.DeleteOutboxCommand,
) (operations.DeleteOutboxResult, error) {
	objects, err := objectstorageadapter.NewDirectory(objectRoot)
	if err != nil {
		return operations.DeleteOutboxResult{}, err
	}
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 2)
	if err != nil {
		return operations.DeleteOutboxResult{}, err
	}
	defer pool.Close()
	loader, err := postgresadapter.NewDeleteOutboxScopeStore(pool)
	if err != nil {
		return operations.DeleteOutboxResult{}, err
	}
	repository, err := postgresadapter.NewScopedDeleteOutboxStore(pool, command.Scope)
	if err != nil {
		return operations.DeleteOutboxResult{}, err
	}
	drainer, err := encryptedobject.NewDeleteOutboxDrainer(repository, objects)
	if err != nil {
		return operations.DeleteOutboxResult{}, err
	}
	service, err := operations.NewDeleteOutboxService(command.Scope, loader, drainer)
	if err != nil {
		return operations.DeleteOutboxResult{}, err
	}
	return service.Run(ctx, command)
}

type disabledRecoveryNonceReservations struct{}

func (disabledRecoveryNonceReservations) ReserveNonce(
	context.Context,
	identity.VaultID,
	cryptocontent.DEKVersion,
	string,
) (bool, error) {
	return false, operations.ErrRecoveryDrill
}

func runVaultRecoveryDrill(
	ctx context.Context,
	backupRoot string,
	keyRoot string,
	command operations.RecoveryDrillCommand,
) (operations.RecoveryDrillResult, error) {
	backup, err := recoverybackupadapter.NewDirectory(backupRoot)
	if err != nil {
		return operations.RecoveryDrillResult{}, err
	}
	keys, err := recoverykeyadapter.NewDirectory(keyRoot, command.VaultID)
	if err != nil {
		return operations.RecoveryDrillResult{}, err
	}
	encryption, err := cryptocontent.NewService(
		keys,
		contentcryptoadapter.NewSecureRandomNonceGenerator(),
		disabledRecoveryNonceReservations{},
		contentcryptoadapter.AES256GCM{},
	)
	if err != nil {
		return operations.RecoveryDrillResult{}, err
	}
	drill, err := encryptedobject.NewRecoveryDrillService(backup, encryption)
	if err != nil {
		return operations.RecoveryDrillResult{}, err
	}
	service, err := operations.NewRecoveryDrillService(drill)
	if err != nil {
		return operations.RecoveryDrillResult{}, err
	}
	return service.Run(ctx, command)
}

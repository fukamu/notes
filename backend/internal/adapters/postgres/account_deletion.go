package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalidAccountDeletionOperation = errors.New("invalid account deletion operation")
	ErrInvalidAccountDeletionRecord    = errors.New("invalid stored account deletion record")
)

type AccountDeletionStore struct {
	pool *pgxpool.Pool
}

var _ accountdeletion.Repository = (*AccountDeletionStore)(nil)

const accountDeletionOperationSelect = `SELECT operation_id, account_id, vault_id,
       revision, state, current_step, attempt, not_before, lease_expires_at,
       failure_code, created_at, updated_at, completed_at
  FROM account_deletion_operations`

const accountDeletionContinuationSelect = `SELECT operation_id, idempotency_key_hash,
       secret_hash, sequence, expires_at, created_at, updated_at
  FROM account_deletion_continuations`

type accountDeletionQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func NewAccountDeletionStore(pool *pgxpool.Pool) (*AccountDeletionStore, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &AccountDeletionStore{pool: pool}, nil
}

func (store *AccountDeletionStore) FindByOwner(
	ctx context.Context,
	scope accountdeletion.Scope,
) (*accountdeletion.Snapshot, error) {
	if !validAccountDeletionStore(store) || !accountdeletion.ValidScope(scope) {
		return nil, ErrInvalidAccountDeletionOperation
	}
	return findAccountDeletionSnapshot(ctx, store.pool,
		" WHERE account_id = $1 AND vault_id = $2", string(scope.AccountID), string(scope.VaultID))
}

func (store *AccountDeletionStore) Start(
	ctx context.Context,
	operation accountdeletion.Operation,
	continuation accountdeletion.Continuation,
) (accountdeletion.StartResult, error) {
	if !validAccountDeletionStore(store) || !accountdeletion.InitialOperation(operation) ||
		!accountdeletion.ValidContinuation(continuation) ||
		continuation.OperationID != operation.OperationID || continuation.CreatedAt != operation.CreatedAt {
		return accountdeletion.StartResult{Kind: accountdeletion.StartRejected, Reason: accountdeletion.StartInvalid}, nil
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return accountdeletion.StartResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	operationBindings := accountDeletionOperationBindings(operation)
	_, err = tx.Exec(ctx, `INSERT INTO account_deletion_operations(
		operation_id, account_id, vault_id, revision, state, current_step,
		attempt, not_before, lease_expires_at, failure_code, created_at,
		updated_at, completed_at
	) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`, operationBindings...)
	if err != nil {
		_ = tx.Rollback(ctx)
		if isAccountDeletionOwnerViolation(err) {
			return accountdeletion.StartResult{Kind: accountdeletion.StartRejected, Reason: accountdeletion.StartInvalid}, nil
		}
		if isUniqueViolation(err) {
			return store.replayAccountDeletionStart(ctx, operation.Scope, continuation)
		}
		return accountdeletion.StartResult{}, classifyAccountDeletionError(err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO account_deletion_continuations(
		operation_id, idempotency_key_hash, secret_hash, sequence,
		expires_at, created_at, updated_at
	) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		string(continuation.OperationID), string(continuation.IdempotencyHash),
		string(continuation.SecretHash), continuation.Sequence, continuation.ExpiresAt,
		continuation.CreatedAt, continuation.UpdatedAt,
	)
	if err != nil {
		_ = tx.Rollback(ctx)
		if isUniqueViolation(err) {
			return store.replayAccountDeletionStart(ctx, operation.Scope, continuation)
		}
		return accountdeletion.StartResult{}, classifyAccountDeletionError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return accountdeletion.StartResult{}, err
	}
	return accountdeletion.StartResult{
		Kind: accountdeletion.StartCreated,
		AuthorizedSnapshot: accountdeletion.AuthorizedSnapshot{
			Snapshot: accountdeletion.Snapshot{Operation: operation}, Continuation: continuation,
		},
	}, nil
}

func (store *AccountDeletionStore) replayAccountDeletionStart(
	ctx context.Context,
	scope accountdeletion.Scope,
	requested accountdeletion.Continuation,
) (accountdeletion.StartResult, error) {
	existing, err := store.FindByOwner(ctx, scope)
	if err != nil {
		return accountdeletion.StartResult{}, err
	}
	if existing == nil {
		return accountdeletion.StartResult{Kind: accountdeletion.StartRejected, Reason: accountdeletion.StartInvalid}, nil
	}
	continuation, err := findAccountDeletionContinuationByOperation(ctx, store.pool, existing.Operation.OperationID)
	if err != nil {
		return accountdeletion.StartResult{}, err
	}
	if continuation == nil {
		return accountdeletion.StartResult{}, ErrInvalidAccountDeletionRecord
	}
	if continuation.IdempotencyHash != requested.IdempotencyHash || continuation.SecretHash != requested.SecretHash {
		return accountdeletion.StartResult{Kind: accountdeletion.StartRejected, Reason: accountdeletion.StartCredentialConflict}, nil
	}
	if requested.ExpiresAt > continuation.ExpiresAt {
		updatedAt := continuation.UpdatedAt
		if requested.CreatedAt > updatedAt {
			updatedAt = requested.CreatedAt
		}
		candidate := *continuation
		candidate.ExpiresAt = requested.ExpiresAt
		candidate.UpdatedAt = updatedAt
		if !accountdeletion.ValidContinuation(candidate) {
			return accountdeletion.StartResult{}, ErrInvalidAccountDeletionRecord
		}
		tag, updateErr := store.pool.Exec(ctx, `UPDATE account_deletion_continuations
			SET expires_at = $1, updated_at = $2
			WHERE operation_id = $3 AND idempotency_key_hash = $4
			  AND secret_hash = $5 AND sequence = $6 AND expires_at = $7`,
			candidate.ExpiresAt, candidate.UpdatedAt, string(continuation.OperationID),
			string(continuation.IdempotencyHash), string(continuation.SecretHash),
			continuation.Sequence, continuation.ExpiresAt,
		)
		if updateErr != nil {
			return accountdeletion.StartResult{}, classifyAccountDeletionError(updateErr)
		}
		if tag.RowsAffected() == 1 {
			continuation = &candidate
		} else {
			continuation, err = findAccountDeletionContinuationByOperation(ctx, store.pool, existing.Operation.OperationID)
			if err != nil || continuation == nil {
				return accountdeletion.StartResult{}, firstAccountDeletionError(err)
			}
		}
	}
	return accountdeletion.StartResult{
		Kind: accountdeletion.StartExisting,
		AuthorizedSnapshot: accountdeletion.AuthorizedSnapshot{
			Snapshot: *existing, Continuation: *continuation,
		},
	}, nil
}

func (store *AccountDeletionStore) Consume(
	ctx context.Context,
	secretHash accountdeletion.CredentialHash,
	sequence int64,
	consumedAt int64,
) (accountdeletion.ConsumeResult, error) {
	if !validAccountDeletionStore(store) {
		return accountdeletion.ConsumeResult{}, ErrInvalidAccountDeletionOperation
	}
	if _, err := accountdeletion.ParseCredentialHash(string(secretHash)); err != nil {
		return accountdeletion.ConsumeResult{Kind: accountdeletion.ConsumeRejected, Reason: accountdeletion.ConsumeInvalidCapability}, nil
	}
	current, err := findAccountDeletionContinuationBySecret(ctx, store.pool, secretHash)
	if err != nil {
		return accountdeletion.ConsumeResult{}, err
	}
	if current == nil {
		return accountdeletion.ConsumeResult{Kind: accountdeletion.ConsumeRejected, Reason: accountdeletion.ConsumeInvalidCapability}, nil
	}
	plan := accountdeletion.PlanContinuationConsume(*current, sequence, consumedAt)
	if plan.Kind == accountdeletion.ContinuationConsumeRejected {
		return rejectedConsume(plan), nil
	}
	if plan.Kind == accountdeletion.ContinuationConsumeReplay {
		return store.authorizedConsume(ctx, accountdeletion.ConsumeReplayed, *current)
	}
	tag, err := store.pool.Exec(ctx, `UPDATE account_deletion_continuations
		SET sequence = $1, updated_at = $2
		WHERE operation_id = $3 AND secret_hash = $4 AND sequence = $5 AND expires_at > $6`,
		plan.Next.Sequence, plan.Next.UpdatedAt, string(current.OperationID), string(current.SecretHash),
		current.Sequence, consumedAt,
	)
	if err != nil {
		return accountdeletion.ConsumeResult{}, classifyAccountDeletionError(err)
	}
	persisted, err := findAccountDeletionContinuationBySecret(ctx, store.pool, secretHash)
	if err != nil {
		return accountdeletion.ConsumeResult{}, err
	}
	if persisted == nil {
		return accountdeletion.ConsumeResult{Kind: accountdeletion.ConsumeRejected, Reason: accountdeletion.ConsumeInvalidCapability}, nil
	}
	if tag.RowsAffected() == 1 {
		return store.authorizedConsume(ctx, accountdeletion.ConsumeConsumed, *persisted)
	}
	retry := accountdeletion.PlanContinuationConsume(*persisted, sequence, consumedAt)
	if retry.Kind == accountdeletion.ContinuationConsumeReplay {
		return store.authorizedConsume(ctx, accountdeletion.ConsumeReplayed, *persisted)
	}
	return rejectedConsume(retry), nil
}

func (store *AccountDeletionStore) authorizedConsume(
	ctx context.Context,
	kind accountdeletion.ConsumeResultKind,
	continuation accountdeletion.Continuation,
) (accountdeletion.ConsumeResult, error) {
	snapshot, err := findAccountDeletionSnapshot(ctx, store.pool, " WHERE operation_id = $1", string(continuation.OperationID))
	if err != nil {
		return accountdeletion.ConsumeResult{}, err
	}
	if snapshot == nil || snapshot.Operation.OperationID != continuation.OperationID {
		return accountdeletion.ConsumeResult{}, ErrInvalidAccountDeletionRecord
	}
	return accountdeletion.ConsumeResult{
		Kind: kind,
		AuthorizedSnapshot: accountdeletion.AuthorizedSnapshot{
			Snapshot: *snapshot, Continuation: continuation,
		},
	}, nil
}

func (store *AccountDeletionStore) Commit(
	ctx context.Context,
	scope accountdeletion.Scope,
	transition accountdeletion.Transition,
) (accountdeletion.CommitResult, error) {
	if !validAccountDeletionStore(store) || !accountdeletion.ValidTransition(scope, transition) {
		return accountdeletion.CommitResult{Kind: accountdeletion.CommitRejected}, nil
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return accountdeletion.CommitResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	state := accountDeletionStateBindings(transition.Next.State)
	tag, err := tx.Exec(ctx, `UPDATE account_deletion_operations SET
		revision = $1, state = $2, current_step = $3, attempt = $4,
		not_before = $5, lease_expires_at = $6, failure_code = $7,
		updated_at = $8, completed_at = $9
		WHERE operation_id = $10 AND account_id = $11 AND vault_id = $12 AND revision = $13`,
		transition.Next.Revision, state.kind, state.currentStep, state.attempt,
		state.notBefore, state.leaseExpiresAt, state.failureCode,
		transition.Next.UpdatedAt, state.completedAt, string(transition.Current.OperationID),
		string(scope.AccountID), string(scope.VaultID), transition.Current.Revision,
	)
	if err != nil {
		return accountdeletion.CommitResult{}, classifyAccountDeletionError(err)
	}
	if tag.RowsAffected() == 0 {
		_ = tx.Rollback(ctx)
		return store.accountDeletionConflict(ctx, scope, transition)
	}
	if transition.Receipt != nil {
		_, err = tx.Exec(ctx, `INSERT INTO account_deletion_step_receipts(operation_id, step, completed_at)
			VALUES ($1, $2, $3)`, string(transition.Receipt.OperationID), string(transition.Receipt.Step), transition.Receipt.CompletedAt)
		if err != nil {
			return accountdeletion.CommitResult{}, classifyAccountDeletionError(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return accountdeletion.CommitResult{}, err
	}
	persisted, err := store.FindByOwner(ctx, scope)
	if err != nil {
		return accountdeletion.CommitResult{}, err
	}
	if persisted == nil || !accountdeletion.SameOperation(persisted.Operation, transition.Next) ||
		!accountDeletionReceiptPersisted(*persisted, transition.Receipt) {
		return accountdeletion.CommitResult{}, ErrInvalidAccountDeletionRecord
	}
	return accountdeletion.CommitResult{Kind: accountdeletion.CommitApplied, Current: persisted}, nil
}

func (store *AccountDeletionStore) accountDeletionConflict(
	ctx context.Context,
	scope accountdeletion.Scope,
	transition accountdeletion.Transition,
) (accountdeletion.CommitResult, error) {
	persisted, err := store.FindByOwner(ctx, scope)
	if err != nil {
		return accountdeletion.CommitResult{}, err
	}
	if persisted != nil && accountdeletion.SameOperation(persisted.Operation, transition.Next) &&
		accountDeletionReceiptPersisted(*persisted, transition.Receipt) {
		return accountdeletion.CommitResult{Kind: accountdeletion.CommitReplayed, Current: persisted}, nil
	}
	return accountdeletion.CommitResult{Kind: accountdeletion.CommitConflict, Current: persisted}, nil
}

type accountDeletionStateColumns struct {
	kind                                   string
	currentStep, failureCode               *string
	attempt                                int64
	notBefore, leaseExpiresAt, completedAt *int64
}

func accountDeletionOperationBindings(operation accountdeletion.Operation) []any {
	state := accountDeletionStateBindings(operation.State)
	return []any{
		string(operation.OperationID), string(operation.Scope.AccountID), string(operation.Scope.VaultID),
		operation.Revision, state.kind, state.currentStep, state.attempt, state.notBefore,
		state.leaseExpiresAt, state.failureCode, operation.CreatedAt, operation.UpdatedAt, state.completedAt,
	}
}

func accountDeletionStateBindings(state accountdeletion.State) accountDeletionStateColumns {
	kind := string(state.Kind())
	columns := accountDeletionStateColumns{kind: kind}
	switch value := state.(type) {
	case accountdeletion.Ready:
		columns.currentStep = stringPointer(string(value.Step))
		columns.attempt = value.Attempt
		columns.notBefore = int64Pointer(value.NotBefore)
	case accountdeletion.Running:
		columns.currentStep = stringPointer(string(value.Step))
		columns.attempt = value.Attempt
		columns.leaseExpiresAt = int64Pointer(value.LeaseExpiresAt)
	case accountdeletion.RetryWait:
		columns.currentStep = stringPointer(string(value.Step))
		columns.attempt = value.Attempt
		columns.notBefore = int64Pointer(value.RetryAt)
		columns.failureCode = stringPointer(string(value.FailureCode))
	case accountdeletion.TerminalFailure:
		columns.currentStep = stringPointer(string(value.Step))
		columns.attempt = value.Attempt
		columns.failureCode = stringPointer(string(value.FailureCode))
	case accountdeletion.Completed:
		columns.completedAt = int64Pointer(value.CompletedAt)
	}
	return columns
}

func findAccountDeletionSnapshot(
	ctx context.Context,
	querier accountDeletionQuerier,
	clause string,
	arguments ...any,
) (*accountdeletion.Snapshot, error) {
	operation, err := scanOptionalAccountDeletionOperation(querier.QueryRow(ctx, accountDeletionOperationSelect+clause, arguments...))
	if err != nil || operation == nil {
		return nil, err
	}
	rows, err := querier.Query(ctx, `SELECT operation_id, step, completed_at
		FROM account_deletion_step_receipts WHERE operation_id = $1
		ORDER BY CASE step
		  WHEN 'revoke-sessions' THEN 1
		  WHEN 'cancel-subscription' THEN 2
		  WHEN 'delete-vault-data' THEN 3
		  WHEN 'delete-private-objects' THEN 4
		  WHEN 'finalize-account' THEN 5
		END ASC`, string(operation.OperationID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	receipts := make([]accountdeletion.Receipt, 0, 5)
	for rows.Next() {
		var rawOperationID, rawStep string
		var completedAt int64
		if err := rows.Scan(&rawOperationID, &rawStep, &completedAt); err != nil {
			return nil, err
		}
		operationID, operationErr := accountdeletion.ParseOperationID(rawOperationID)
		receipt := accountdeletion.Receipt{OperationID: operationID, Step: accountdeletion.Step(rawStep), CompletedAt: completedAt}
		if operationErr != nil || !accountdeletion.ValidStep(receipt.Step) {
			return nil, ErrInvalidAccountDeletionRecord
		}
		receipts = append(receipts, receipt)
		if len(receipts) > 5 {
			return nil, ErrInvalidAccountDeletionRecord
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	snapshot := accountdeletion.Snapshot{Operation: *operation, Receipts: receipts}
	if !accountdeletion.ValidSnapshot(snapshot) {
		return nil, ErrInvalidAccountDeletionRecord
	}
	return &snapshot, nil
}

func scanOptionalAccountDeletionOperation(row rowScanner) (*accountdeletion.Operation, error) {
	operation, err := scanAccountDeletionOperation(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &operation, nil
}

func scanAccountDeletionOperation(row rowScanner) (accountdeletion.Operation, error) {
	var operationID, accountID, vaultID, stateKind string
	var currentStep, failureCode *string
	var revision, attempt, createdAt, updatedAt int64
	var notBefore, leaseExpiresAt, completedAt *int64
	if err := row.Scan(
		&operationID, &accountID, &vaultID, &revision, &stateKind, &currentStep,
		&attempt, &notBefore, &leaseExpiresAt, &failureCode, &createdAt, &updatedAt, &completedAt,
	); err != nil {
		return accountdeletion.Operation{}, err
	}
	parsedOperationID, operationErr := accountdeletion.ParseOperationID(operationID)
	parsedAccountID, accountErr := identity.ParseAccountID(accountID)
	parsedVaultID, vaultErr := identity.ParseVaultID(vaultID)
	state, stateErr := decodeAccountDeletionState(stateKind, currentStep, attempt, notBefore, leaseExpiresAt, failureCode, completedAt)
	operation := accountdeletion.Operation{
		Scope:       accountdeletion.Scope{AccountID: parsedAccountID, VaultID: parsedVaultID},
		OperationID: parsedOperationID, Revision: revision, State: state,
		CreatedAt: createdAt, UpdatedAt: updatedAt,
	}
	if operationErr != nil || accountErr != nil || vaultErr != nil || stateErr != nil || !accountdeletion.ValidOperation(operation) {
		return accountdeletion.Operation{}, ErrInvalidAccountDeletionRecord
	}
	return operation, nil
}

func decodeAccountDeletionState(
	kind string,
	step *string,
	attempt int64,
	notBefore, leaseExpiresAt *int64,
	failureCode *string,
	completedAt *int64,
) (accountdeletion.State, error) {
	parseStep := func() (accountdeletion.Step, error) {
		if step == nil || !accountdeletion.ValidStep(accountdeletion.Step(*step)) {
			return "", ErrInvalidAccountDeletionRecord
		}
		return accountdeletion.Step(*step), nil
	}
	switch accountdeletion.StateKind(kind) {
	case accountdeletion.StateReady:
		parsedStep, err := parseStep()
		if err == nil && notBefore != nil && leaseExpiresAt == nil && failureCode == nil && completedAt == nil {
			return accountdeletion.Ready{Step: parsedStep, Attempt: attempt, NotBefore: *notBefore}, nil
		}
	case accountdeletion.StateRunning:
		parsedStep, err := parseStep()
		if err == nil && notBefore == nil && leaseExpiresAt != nil && failureCode == nil && completedAt == nil {
			return accountdeletion.Running{Step: parsedStep, Attempt: attempt, LeaseExpiresAt: *leaseExpiresAt}, nil
		}
	case accountdeletion.StateRetryWait:
		parsedStep, stepErr := parseStep()
		if stepErr == nil && notBefore != nil && leaseExpiresAt == nil && failureCode != nil && completedAt == nil {
			parsedCode, codeErr := accountdeletion.ParseFailureCode(*failureCode)
			return accountdeletion.RetryWait{Step: parsedStep, Attempt: attempt, RetryAt: *notBefore, FailureCode: parsedCode}, codeErr
		}
	case accountdeletion.StateTerminalFailure:
		parsedStep, stepErr := parseStep()
		if stepErr == nil && notBefore == nil && leaseExpiresAt == nil && failureCode != nil && completedAt == nil {
			parsedCode, codeErr := accountdeletion.ParseFailureCode(*failureCode)
			return accountdeletion.TerminalFailure{Step: parsedStep, Attempt: attempt, FailureCode: parsedCode}, codeErr
		}
	case accountdeletion.StateCompleted:
		if step == nil && attempt == 0 && notBefore == nil && leaseExpiresAt == nil && failureCode == nil && completedAt != nil {
			return accountdeletion.Completed{CompletedAt: *completedAt}, nil
		}
	}
	return nil, ErrInvalidAccountDeletionRecord
}

func findAccountDeletionContinuationByOperation(
	ctx context.Context,
	querier accountDeletionQuerier,
	operationID accountdeletion.OperationID,
) (*accountdeletion.Continuation, error) {
	return scanOptionalAccountDeletionContinuation(querier.QueryRow(ctx,
		accountDeletionContinuationSelect+" WHERE operation_id = $1", string(operationID)))
}

func findAccountDeletionContinuationBySecret(
	ctx context.Context,
	querier accountDeletionQuerier,
	secretHash accountdeletion.CredentialHash,
) (*accountdeletion.Continuation, error) {
	return scanOptionalAccountDeletionContinuation(querier.QueryRow(ctx,
		accountDeletionContinuationSelect+" WHERE secret_hash = $1", string(secretHash)))
}

func scanOptionalAccountDeletionContinuation(row rowScanner) (*accountdeletion.Continuation, error) {
	var operationID, idempotencyHash, secretHash string
	var sequence, expiresAt, createdAt, updatedAt int64
	if err := row.Scan(&operationID, &idempotencyHash, &secretHash, &sequence, &expiresAt, &createdAt, &updatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	parsedOperationID, operationErr := accountdeletion.ParseOperationID(operationID)
	parsedIdempotency, idempotencyErr := accountdeletion.ParseCredentialHash(idempotencyHash)
	parsedSecret, secretErr := accountdeletion.ParseCredentialHash(secretHash)
	continuation := accountdeletion.Continuation{
		OperationID: parsedOperationID, IdempotencyHash: parsedIdempotency,
		SecretHash: parsedSecret, Sequence: sequence, ExpiresAt: expiresAt,
		CreatedAt: createdAt, UpdatedAt: updatedAt,
	}
	if operationErr != nil || idempotencyErr != nil || secretErr != nil || !accountdeletion.ValidContinuation(continuation) {
		return nil, ErrInvalidAccountDeletionRecord
	}
	return &continuation, nil
}

func accountDeletionReceiptPersisted(snapshot accountdeletion.Snapshot, receipt *accountdeletion.Receipt) bool {
	if receipt == nil {
		return true
	}
	for _, candidate := range snapshot.Receipts {
		if accountdeletion.SameReceipt(candidate, *receipt) {
			return true
		}
	}
	return false
}

func rejectedConsume(plan accountdeletion.ContinuationConsumePlan) accountdeletion.ConsumeResult {
	reason := accountdeletion.ConsumeInvalidCapability
	if plan.Reason == accountdeletion.ContinuationExpired {
		reason = accountdeletion.ConsumeExpired
	}
	return accountdeletion.ConsumeResult{Kind: accountdeletion.ConsumeRejected, Reason: reason}
}

func validAccountDeletionStore(store *AccountDeletionStore) bool {
	return store != nil && store.pool != nil
}

func isAccountDeletionOwnerViolation(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "23503" &&
		postgresError.ConstraintName == "account_deletion_owner"
}

func classifyAccountDeletionError(err error) error {
	if err == nil {
		return nil
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		switch postgresError.Code {
		case "23503":
			return ErrInvalidAccountDeletionOperation
		case "23514", "22003":
			return ErrInvalidAccountDeletionRecord
		}
	}
	return err
}

func firstAccountDeletionError(err error) error {
	if err != nil {
		return err
	}
	return ErrInvalidAccountDeletionRecord
}

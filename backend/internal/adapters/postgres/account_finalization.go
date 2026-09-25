package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrInvalidAccountFinalizationOperation = errors.New("invalid account finalization operation")

type AccountFinalizationStore struct {
	pool *pgxpool.Pool
}

var (
	_ accountdeletion.AccountFinalizationGate       = (*AccountFinalizationStore)(nil)
	_ accountdeletion.LegalEvidenceFinalizationGate = (*AccountFinalizationStore)(nil)
	_ accountdeletion.WrappedKeyFinalizationGate    = (*AccountFinalizationStore)(nil)
	_ accountdeletion.LiveStateFinalizationGate     = (*AccountFinalizationStore)(nil)
)

func NewAccountFinalizationStore(pool *pgxpool.Pool) (*AccountFinalizationStore, error) {
	if pool == nil {
		return nil, ErrInvalidAccountFinalizationOperation
	}
	return &AccountFinalizationStore{pool: pool}, nil
}

func (store *AccountFinalizationStore) Evaluate(
	ctx context.Context,
	command accountdeletion.AccountFinalizationCommand,
) (accountdeletion.AccountFinalizationResult, error) {
	if store.invalid(command) {
		return accountdeletion.AccountFinalizationResult{}, ErrInvalidAccountFinalizationOperation
	}
	state, err := readAccountFinalizationState(ctx, store.pool, command)
	if err != nil {
		return accountdeletion.AccountFinalizationResult{}, err
	}
	if rejected := rejectAccountFinalizationState(state); rejected != nil {
		return *rejected, nil
	}
	if state.objectDeleteCount != 0 {
		return accountFinalizationRetryable(accountdeletion.AccountFinalizationPrivateObjectsRemaining), nil
	}
	return accountFinalizationReady(state), nil
}

func (store *AccountFinalizationStore) EvaluateLegalEvidence(
	ctx context.Context,
	command accountdeletion.AccountFinalizationCommand,
	policy accountdeletion.LegalEvidenceFinalizationPolicy,
) (accountdeletion.AccountFinalizationResult, error) {
	if store.invalid(command) || !accountdeletion.ValidLegalEvidenceFinalizationPolicy(policy) {
		return accountdeletion.AccountFinalizationResult{}, ErrInvalidAccountFinalizationOperation
	}
	state, err := readAccountFinalizationState(ctx, store.pool, command)
	if err != nil {
		return accountdeletion.AccountFinalizationResult{}, err
	}
	if rejected := rejectAccountFinalizationState(state); rejected != nil {
		return *rejected, nil
	}
	if state.legalEvidenceCount() != 0 && policy.Kind == accountdeletion.LegalEvidencePolicyUndecided {
		return accountFinalizationRetryable(accountdeletion.AccountFinalizationLegalPolicyPending), nil
	}
	return accountFinalizationReady(state), nil
}

func (store *AccountFinalizationStore) FinalizeWrappedKeys(
	ctx context.Context,
	command accountdeletion.AccountFinalizationCommand,
	policy accountdeletion.LegalEvidenceFinalizationPolicy,
) (accountdeletion.AccountFinalizationResult, error) {
	if store.invalid(command) || !accountdeletion.ValidLegalEvidenceFinalizationPolicy(policy) {
		return accountdeletion.AccountFinalizationResult{}, ErrInvalidAccountFinalizationOperation
	}
	transaction, err := store.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return accountdeletion.AccountFinalizationResult{}, errors.New("begin wrapped-key finalization")
	}
	defer func() { _ = transaction.Rollback(context.Background()) }()
	if err := lockAccountFinalizationScope(ctx, transaction, command); err != nil {
		return accountdeletion.AccountFinalizationResult{}, err
	}
	state, err := readAccountFinalizationState(ctx, transaction, command)
	if err != nil {
		return accountdeletion.AccountFinalizationResult{}, err
	}
	if rejected := rejectAccountFinalizationState(state); rejected != nil {
		return *rejected, nil
	}
	if state.objectDeleteCount != 0 {
		return accountFinalizationRetryable(accountdeletion.AccountFinalizationPrivateObjectsRemaining), nil
	}
	if state.legalEvidenceCount() != 0 && policy.Kind == accountdeletion.LegalEvidencePolicyUndecided {
		return accountFinalizationRetryable(accountdeletion.AccountFinalizationLegalPolicyPending), nil
	}

	_, err = transaction.Exec(ctx, `DELETE FROM vault_dek_versions wrapped
		WHERE wrapped.vault_id = $2
		  AND EXISTS (
		    SELECT 1 FROM personal_vaults owner
		    WHERE owner.account_id = $1 AND owner.vault_id = wrapped.vault_id
		  )
		  AND EXISTS (`+accountFinalizationAuthorizationSQL+`)
		  AND ($5 OR NOT EXISTS (
		    SELECT 1 FROM terms_consent_evidence terms
		    WHERE terms.account_id = $1 AND terms.vault_id = wrapped.vault_id
		  ))
		  AND ($5 OR NOT EXISTS (
		    SELECT 1 FROM contract_evidence evidence
		    WHERE evidence.account_id = $1 AND evidence.vault_id = wrapped.vault_id
		  ))`, string(command.Scope.AccountID), string(command.Scope.VaultID),
		string(command.OperationID), command.PreviousReceiptAt,
		policy.Kind == accountdeletion.LegalEvidenceDeleteLive)
	if err != nil {
		return accountdeletion.AccountFinalizationResult{}, errors.New("delete wrapped DEK metadata")
	}
	after, err := readAccountFinalizationState(ctx, transaction, command)
	if err != nil {
		return accountdeletion.AccountFinalizationResult{}, err
	}
	if rejected := rejectAccountFinalizationState(after); rejected != nil {
		return *rejected, nil
	}
	if after.legalEvidenceCount() != 0 && policy.Kind == accountdeletion.LegalEvidencePolicyUndecided {
		return accountFinalizationRetryable(accountdeletion.AccountFinalizationLegalPolicyPending), nil
	}
	if after.wrappedKeyCount != 0 {
		return accountFinalizationRetryable(accountdeletion.AccountFinalizationWrappedKeysRemaining), nil
	}
	if err := transaction.Commit(ctx); err != nil {
		return accountdeletion.AccountFinalizationResult{}, errors.New("commit wrapped-key finalization")
	}
	return accountFinalizationReady(after), nil
}

func (store *AccountFinalizationStore) FinalizeLiveState(
	ctx context.Context,
	command accountdeletion.AccountFinalizationCommand,
	policy accountdeletion.LegalEvidenceFinalizationPolicy,
) (accountdeletion.AccountFinalizationResult, error) {
	if store.invalid(command) || !accountdeletion.ValidLegalEvidenceFinalizationPolicy(policy) {
		return accountdeletion.AccountFinalizationResult{}, ErrInvalidAccountFinalizationOperation
	}
	transaction, err := store.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return accountdeletion.AccountFinalizationResult{}, errors.New("begin Account live-state finalization")
	}
	defer func() { _ = transaction.Rollback(context.Background()) }()
	if err := lockAccountFinalizationScope(ctx, transaction, command); err != nil {
		return accountdeletion.AccountFinalizationResult{}, err
	}
	before, err := readAccountFinalizationState(ctx, transaction, command)
	if err != nil {
		return accountdeletion.AccountFinalizationResult{}, err
	}
	if rejected := rejectAccountFinalizationState(before); rejected != nil {
		return *rejected, nil
	}
	if before.objectDeleteCount != 0 || before.wrappedKeyCount != 0 {
		return accountFinalizationRetryable(accountdeletion.AccountFinalizationLiveStateRemaining), nil
	}
	if before.legalEvidenceCount() != 0 && policy.Kind == accountdeletion.LegalEvidencePolicyUndecided {
		return accountFinalizationRetryable(accountdeletion.AccountFinalizationLegalPolicyPending), nil
	}

	if policy.Kind == accountdeletion.LegalEvidenceDeleteLive {
		if err := deleteFinalizationLegalEvidence(ctx, transaction, command); err != nil {
			return accountdeletion.AccountFinalizationResult{}, err
		}
	}
	if err := deleteAccountLiveState(ctx, transaction, command); err != nil {
		return accountdeletion.AccountFinalizationResult{}, err
	}
	after, err := readAccountFinalizationState(ctx, transaction, command)
	if err != nil {
		return accountdeletion.AccountFinalizationResult{}, err
	}
	if !after.authorized || after.ownerCount != 0 || after.accountCount != 0 || after.vaultCount != 0 ||
		after.identityCount != 0 || after.sessionCount != 0 || after.verifiedEmailCount != 0 ||
		after.signupReservationCount != 0 || after.objectDeleteCount != 0 || after.wrappedKeyCount != 0 ||
		after.legalEvidenceCount() != 0 {
		return accountFinalizationRetryable(accountdeletion.AccountFinalizationLiveStateRemaining), nil
	}
	if err := transaction.Commit(ctx); err != nil {
		return accountdeletion.AccountFinalizationResult{}, errors.New("commit Account live-state finalization")
	}
	return accountdeletion.AccountFinalizationResult{
		Kind: accountdeletion.AccountFinalizationConfirmed,
		Outcome: func() accountdeletion.AccountFinalizationOutcome {
			if before.absent() {
				return accountdeletion.AccountFinalizationAlreadyFinalized
			}
			return accountdeletion.AccountFinalizationDeleted
		}(),
	}, nil
}

func (store *AccountFinalizationStore) invalid(command accountdeletion.AccountFinalizationCommand) bool {
	return store == nil || store.pool == nil || !accountdeletion.ValidAccountFinalizationCommand(command)
}

type accountFinalizationState struct {
	ownerCount             int64
	accountCount           int64
	vaultCount             int64
	identityCount          int64
	sessionCount           int64
	verifiedEmailCount     int64
	signupReservationCount int64
	objectDeleteCount      int64
	wrappedKeyCount        int64
	termsEvidenceCount     int64
	contractEvidenceCount  int64
	authorized             bool
}

func (state accountFinalizationState) valid() bool {
	counts := [...]int64{
		state.ownerCount, state.accountCount, state.vaultCount, state.identityCount,
		state.sessionCount, state.verifiedEmailCount, state.signupReservationCount,
		state.objectDeleteCount, state.wrappedKeyCount, state.termsEvidenceCount,
		state.contractEvidenceCount,
	}
	for _, count := range counts {
		if count < 0 || count > identity.MaximumSafeInteger {
			return false
		}
	}
	return state.ownerCount <= 1 && state.accountCount <= 1 && state.vaultCount <= 1
}

func (state accountFinalizationState) live() bool {
	return state.ownerCount == 1 && state.accountCount == 1 && state.vaultCount == 1
}

func (state accountFinalizationState) absent() bool {
	return state.ownerCount == 0 && state.accountCount == 0 && state.vaultCount == 0 &&
		state.identityCount == 0 && state.sessionCount == 0 && state.verifiedEmailCount == 0 &&
		state.signupReservationCount == 0
}

func (state accountFinalizationState) legalEvidenceCount() int64 {
	return state.termsEvidenceCount + state.contractEvidenceCount
}

type accountFinalizationStateQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func readAccountFinalizationState(
	ctx context.Context,
	query accountFinalizationStateQuerier,
	command accountdeletion.AccountFinalizationCommand,
) (accountFinalizationState, error) {
	var state accountFinalizationState
	err := query.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM personal_vaults WHERE account_id = $1 AND vault_id = $2),
		(SELECT COUNT(*) FROM accounts WHERE account_id = $1),
		(SELECT COUNT(*) FROM personal_vaults WHERE vault_id = $2),
		(SELECT COUNT(*) FROM identities WHERE account_id = $1),
		(SELECT COUNT(*) FROM sessions WHERE account_id = $1 OR vault_id = $2),
		(SELECT COUNT(*) FROM verified_email_owners WHERE account_id = $1),
		(SELECT COUNT(*) FROM signup_admission_reservations WHERE account_id = $1 OR vault_id = $2),
		(SELECT COUNT(*) FROM vault_object_delete_outbox WHERE vault_id = $2),
		(SELECT COUNT(*) FROM vault_dek_versions WHERE vault_id = $2),
		(SELECT COUNT(*) FROM terms_consent_evidence WHERE account_id = $1 AND vault_id = $2),
		(SELECT COUNT(*) FROM contract_evidence WHERE account_id = $1 AND vault_id = $2),
		EXISTS (`+accountFinalizationAuthorizationSQL+`)`,
		string(command.Scope.AccountID), string(command.Scope.VaultID),
		string(command.OperationID), command.PreviousReceiptAt).Scan(
		&state.ownerCount, &state.accountCount, &state.vaultCount, &state.identityCount,
		&state.sessionCount, &state.verifiedEmailCount, &state.signupReservationCount,
		&state.objectDeleteCount, &state.wrappedKeyCount, &state.termsEvidenceCount,
		&state.contractEvidenceCount, &state.authorized,
	)
	if err != nil || !state.valid() {
		return accountFinalizationState{}, errors.New("read Account finalization state")
	}
	return state, nil
}

func rejectAccountFinalizationState(
	state accountFinalizationState,
) *accountdeletion.AccountFinalizationResult {
	if !state.live() && !state.absent() {
		result := accountFinalizationTerminal(accountdeletion.AccountFinalizationOwnerMismatch)
		return &result
	}
	if !state.authorized {
		result := accountFinalizationTerminal(accountdeletion.AccountFinalizationIntegrityFailure)
		return &result
	}
	return nil
}

type accountFinalizationScopeLocker interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func lockAccountFinalizationScope(
	ctx context.Context,
	query accountFinalizationScopeLocker,
	command accountdeletion.AccountFinalizationCommand,
) error {
	locks := []struct {
		sql  string
		args []any
	}{
		{sql: `SELECT account_id FROM accounts WHERE account_id = $1 FOR UPDATE`, args: []any{string(command.Scope.AccountID)}},
		{sql: `SELECT vault_id FROM personal_vaults
			WHERE account_id = $1 OR vault_id = $2 ORDER BY vault_id FOR UPDATE`,
			args: []any{string(command.Scope.AccountID), string(command.Scope.VaultID)}},
	}
	for _, lock := range locks {
		rows, err := query.Query(ctx, lock.sql, lock.args...)
		if err != nil {
			return errors.New("lock Account finalization scope")
		}
		for rows.Next() {
			var ignored string
			if err := rows.Scan(&ignored); err != nil {
				rows.Close()
				return errors.New("lock Account finalization scope")
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return errors.New("lock Account finalization scope")
		}
		rows.Close()
	}
	return nil
}

func deleteFinalizationLegalEvidence(
	ctx context.Context,
	transaction pgx.Tx,
	command accountdeletion.AccountFinalizationCommand,
) error {
	arguments := []any{string(command.Scope.AccountID), string(command.Scope.VaultID),
		string(command.OperationID), command.PreviousReceiptAt}
	if _, err := transaction.Exec(ctx, `DELETE FROM contract_evidence evidence
		WHERE evidence.account_id = $1 AND evidence.vault_id = $2
		  AND EXISTS (`+accountFinalizationAuthorizationSQL+`)`, arguments...); err != nil {
		return errors.New("delete Account contract evidence")
	}
	if _, err := transaction.Exec(ctx, `DELETE FROM terms_consent_evidence evidence
		WHERE evidence.account_id = $1 AND evidence.vault_id = $2
		  AND EXISTS (`+accountFinalizationAuthorizationSQL+`)`, arguments...); err != nil {
		return errors.New("delete Account terms evidence")
	}
	return nil
}

func deleteAccountLiveState(
	ctx context.Context,
	transaction pgx.Tx,
	command accountdeletion.AccountFinalizationCommand,
) error {
	accountID := string(command.Scope.AccountID)
	vaultID := string(command.Scope.VaultID)
	operationID := string(command.OperationID)
	queries := []struct {
		name string
		sql  string
	}{
		{name: "sessions", sql: `DELETE FROM sessions live
			WHERE (live.account_id = $1 OR live.vault_id = $2) AND EXISTS (
			  SELECT 1 FROM personal_vaults owner WHERE owner.account_id = $1 AND owner.vault_id = $2
			) AND EXISTS (` + accountFinalizationAuthorizationSQL + `)`},
		{name: "identities", sql: `DELETE FROM identities live
			WHERE live.account_id = $1 AND EXISTS (
			  SELECT 1 FROM personal_vaults owner WHERE owner.account_id = $1 AND owner.vault_id = $2
			) AND EXISTS (` + accountFinalizationAuthorizationSQL + `)`},
		{name: "verified email owners", sql: `DELETE FROM verified_email_owners live
			WHERE live.account_id = $1 AND EXISTS (
			  SELECT 1 FROM personal_vaults owner WHERE owner.account_id = $1 AND owner.vault_id = $2
			) AND EXISTS (` + accountFinalizationAuthorizationSQL + `)`},
		{name: "signup reservations", sql: `DELETE FROM signup_admission_reservations live
			WHERE (live.account_id = $1 OR live.vault_id = $2) AND EXISTS (
			  SELECT 1 FROM personal_vaults owner WHERE owner.account_id = $1 AND owner.vault_id = $2
			) AND EXISTS (` + accountFinalizationAuthorizationSQL + `)`},
		{name: "Personal Vault", sql: `DELETE FROM personal_vaults live
			WHERE live.account_id = $1 AND live.vault_id = $2 AND EXISTS (` + accountFinalizationAuthorizationSQL + `)
			  AND NOT EXISTS (SELECT 1 FROM vault_object_delete_outbox pending WHERE pending.vault_id = $2)
			  AND NOT EXISTS (SELECT 1 FROM vault_dek_versions wrapped WHERE wrapped.vault_id = $2)
			  AND NOT EXISTS (SELECT 1 FROM terms_consent_evidence terms WHERE terms.account_id = $1 AND terms.vault_id = $2)
			  AND NOT EXISTS (SELECT 1 FROM contract_evidence evidence WHERE evidence.account_id = $1 AND evidence.vault_id = $2)`},
		{name: "Account", sql: `DELETE FROM accounts live
			WHERE live.account_id = $1 AND EXISTS (` + accountFinalizationAuthorizationSQL + `)
			  AND NOT EXISTS (SELECT 1 FROM personal_vaults owner WHERE owner.account_id = $1)
			  AND NOT EXISTS (SELECT 1 FROM identities identity WHERE identity.account_id = $1)
			  AND NOT EXISTS (SELECT 1 FROM verified_email_owners email WHERE email.account_id = $1)
			  AND NOT EXISTS (SELECT 1 FROM signup_admission_reservations reservation WHERE reservation.account_id = $1)`},
	}
	for _, query := range queries {
		if _, err := transaction.Exec(ctx, query.sql, accountID, vaultID, operationID, command.PreviousReceiptAt); err != nil {
			return errors.New("delete " + query.name + " during Account finalization")
		}
	}
	return nil
}

const accountFinalizationAuthorizationSQL = `
	SELECT 1 FROM account_deletion_operations operation
	JOIN account_deletion_step_receipts revoked
	  ON revoked.operation_id = operation.operation_id AND revoked.step = 'revoke-sessions'
	JOIN account_deletion_step_receipts cancelled
	  ON cancelled.operation_id = operation.operation_id AND cancelled.step = 'cancel-subscription'
	JOIN account_deletion_step_receipts live_data
	  ON live_data.operation_id = operation.operation_id AND live_data.step = 'delete-vault-data'
	JOIN account_deletion_step_receipts private_objects
	  ON private_objects.operation_id = operation.operation_id AND private_objects.step = 'delete-private-objects'
	WHERE operation.operation_id = $3 AND operation.account_id = $1 AND operation.vault_id = $2
	  AND operation.state = 'running' AND operation.current_step = 'finalize-account'
	  AND revoked.completed_at <= cancelled.completed_at
	  AND cancelled.completed_at <= live_data.completed_at
	  AND live_data.completed_at <= private_objects.completed_at
	  AND private_objects.completed_at = $4
	  AND (SELECT COUNT(*) FROM account_deletion_step_receipts exact
	       WHERE exact.operation_id = operation.operation_id) = 4`

func accountFinalizationReady(state accountFinalizationState) accountdeletion.AccountFinalizationResult {
	outcome := accountdeletion.AccountFinalizationReady
	if state.absent() {
		outcome = accountdeletion.AccountFinalizationAlreadyFinalized
	}
	return accountdeletion.AccountFinalizationResult{
		Kind: accountdeletion.AccountFinalizationConfirmed, Outcome: outcome,
	}
}

func accountFinalizationRetryable(
	reason accountdeletion.AccountFinalizationFailureReason,
) accountdeletion.AccountFinalizationResult {
	return accountdeletion.AccountFinalizationResult{
		Kind: accountdeletion.AccountFinalizationRetryableFailure, Reason: reason,
	}
}

func accountFinalizationTerminal(
	reason accountdeletion.AccountFinalizationFailureReason,
) accountdeletion.AccountFinalizationResult {
	return accountdeletion.AccountFinalizationResult{
		Kind: accountdeletion.AccountFinalizationTerminalFailure, Reason: reason,
	}
}

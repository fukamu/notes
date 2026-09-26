package postgres

import (
	"context"
	"sort"

	"github.com/fukamu/notes/backend/internal/access"
	"github.com/fukamu/notes/backend/internal/accountdeletion"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
	fixture "github.com/fukamu/notes/backend/internal/localfixture"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type LocalFixtureDeletionPhase string

const (
	LocalFixturePristine  LocalFixtureDeletionPhase = "pristine"
	LocalFixtureDeleting  LocalFixtureDeletionPhase = "deleting"
	LocalFixtureCompleted LocalFixtureDeletionPhase = "completed"
)

type LocalFixtureDeletionState struct {
	Phase              LocalFixtureDeletionPhase
	Snapshot           *accountdeletion.Snapshot
	ObjectKeys         []encryptedobject.ObjectKey
	WrappedKeyMetadata *cryptocontent.VaultDEKMetadata
}

type LocalFixtureDeletionPreflight struct {
	pool           *pgxpool.Pool
	allowedSubject access.Subject
	context        identity.VaultContext
}

func NewLocalFixtureDeletionPreflight(
	pool *pgxpool.Pool,
	allowedSubject access.Subject,
	vaultContext identity.VaultContext,
) (*LocalFixtureDeletionPreflight, error) {
	if pool == nil || !validDeletionPreflightIdentity(allowedSubject, vaultContext) {
		return nil, ErrInvalidLocalFixture
	}
	return &LocalFixtureDeletionPreflight{
		pool: pool, allowedSubject: allowedSubject, context: vaultContext,
	}, nil
}

func (preflight *LocalFixtureDeletionPreflight) Check(ctx context.Context) error {
	_, err := preflight.Inspect(ctx)
	return err
}

func (preflight *LocalFixtureDeletionPreflight) Inspect(
	ctx context.Context,
) (LocalFixtureDeletionState, error) {
	if preflight == nil || preflight.pool == nil || ctx == nil ||
		!validDeletionPreflightIdentity(preflight.allowedSubject, preflight.context) {
		return LocalFixtureDeletionState{}, ErrInvalidLocalFixture
	}
	tx, err := preflight.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.Serializable, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return LocalFixtureDeletionState{}, ErrLocalFixtureConflict
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := inspectDeletionDatabaseEnvelope(ctx, tx, preflight.allowedSubject); err != nil {
		return LocalFixtureDeletionState{}, ErrLocalFixtureConflict
	}
	if err := inspectDeletionForeignInventory(ctx, tx, preflight.context); err != nil {
		return LocalFixtureDeletionState{}, ErrLocalFixtureConflict
	}
	state, err := inspectDeletionPhase(ctx, tx, preflight.context)
	if err != nil {
		return LocalFixtureDeletionState{}, ErrLocalFixtureConflict
	}
	if err := tx.Commit(ctx); err != nil {
		return LocalFixtureDeletionState{}, ErrLocalFixtureConflict
	}
	return state, nil
}

var expectedLocalFixtureTables = []string{
	"account_deletion_continuations", "account_deletion_operations", "account_deletion_step_receipts",
	"accounts", "billing_checkout_intents", "billing_provider_event_receipts",
	"billing_reconciliation_checkpoints", "billing_subscriptions", "card_mutations", "cards",
	"conflicts", "contract_evidence", "entitlement_offline_leases", "entitlement_projections",
	"identities", "launch_allowed_users", "launch_config", "notes_goose_checksums",
	"notes_goose_versions", "personal_vaults", "privacy_requests", "schema_migrations", "sessions",
	"signup_admission_reservations", "sync_state", "terms_consent_evidence",
	"vault_dek_rotation_operations", "vault_dek_versions", "vault_encrypted_objects",
	"vault_encrypted_write_intents", "vault_object_delete_outbox", "vault_quota_finalization_assertions",
	"vault_quota_reservations", "vault_quota_usage", "vault_reencryption_jobs", "vault_sync_v2_cards",
	"vault_sync_v2_changes", "vault_sync_v2_commits", "vault_sync_v2_conflicts", "vault_sync_v2_states",
	"verified_email_owners",
}

func inspectDeletionDatabaseEnvelope(
	ctx context.Context,
	tx pgx.Tx,
	allowedSubject access.Subject,
) error {
	var database, schema string
	if err := tx.QueryRow(ctx, `SELECT current_database(), current_schema()`).Scan(&database, &schema); err != nil ||
		database != fixture.DisposableDatabaseName || schema != "public" {
		return ErrLocalFixtureConflict
	}
	rows, err := tx.Query(ctx, `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)
	if err != nil {
		return ErrLocalFixtureConflict
	}
	tables := make([]string, 0, len(expectedLocalFixtureTables))
	for rows.Next() {
		var table string
		if rows.Scan(&table) != nil {
			rows.Close()
			return ErrLocalFixtureConflict
		}
		tables = append(tables, table)
	}
	rowsErr := rows.Err()
	rows.Close()
	want := append([]string(nil), expectedLocalFixtureTables...)
	sort.Strings(want)
	if rowsErr != nil || len(tables) != len(want) {
		return ErrLocalFixtureConflict
	}
	for index := range want {
		if tables[index] != want[index] {
			return ErrLocalFixtureConflict
		}
	}
	var launchCount, allowedCount, legacyCount, syncCount int64
	if err := tx.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM launch_config WHERE singleton = 1 AND NOT public_access_enabled AND updated_at = 0),
		(SELECT COUNT(*) FROM launch_allowed_users WHERE user_id = $1 AND created_at = $2),
		(SELECT COUNT(*) FROM cards) + (SELECT COUNT(*) FROM card_mutations) + (SELECT COUNT(*) FROM conflicts),
		(SELECT COUNT(*) FROM sync_state WHERE singleton = 1 AND next_display_id = 1)
	`, string(allowedSubject), fixture.FixtureTimestamp).Scan(
		&launchCount, &allowedCount, &legacyCount, &syncCount,
	); err != nil || launchCount != 1 || allowedCount != 1 || legacyCount != 0 || syncCount != 1 {
		return ErrLocalFixtureConflict
	}
	var launchRows, allowedRows, syncRows int64
	if err := tx.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM launch_config),
		(SELECT COUNT(*) FROM launch_allowed_users),
		(SELECT COUNT(*) FROM sync_state)
	`).Scan(&launchRows, &allowedRows, &syncRows); err != nil ||
		launchRows != 1 || allowedRows != 1 || syncRows != 1 {
		return ErrLocalFixtureConflict
	}
	return nil
}

func inspectDeletionForeignInventory(
	ctx context.Context,
	tx pgx.Tx,
	vaultContext identity.VaultContext,
) error {
	accountID := string(vaultContext.AccountID)
	vaultID := string(vaultContext.VaultID)
	checks := []struct {
		statement string
		values    []any
	}{
		{`SELECT COUNT(*) FROM accounts WHERE account_id <> $1`, []any{accountID}},
		{`SELECT COUNT(*) FROM personal_vaults WHERE account_id <> $1 OR vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM identities WHERE account_id <> $1`, []any{accountID}},
		{`SELECT COUNT(*) FROM sessions WHERE account_id <> $1 OR vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM verified_email_owners WHERE account_id <> $1`, []any{accountID}},
		{`SELECT COUNT(*) FROM signup_admission_reservations WHERE account_id <> $1 OR vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM vault_dek_versions WHERE vault_id <> $1`, []any{vaultID}},
		{`SELECT COUNT(*) FROM vault_encrypted_objects WHERE vault_id <> $1`, []any{vaultID}},
		{`SELECT COUNT(*) FROM vault_encrypted_write_intents WHERE vault_id <> $1`, []any{vaultID}},
		{`SELECT COUNT(*) FROM vault_object_delete_outbox WHERE vault_id <> $1`, []any{vaultID}},
		{`SELECT COUNT(*) FROM vault_dek_rotation_operations WHERE account_id <> $1 OR vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM vault_reencryption_jobs WHERE vault_id <> $1`, []any{vaultID}},
		{`SELECT COUNT(*) FROM billing_subscriptions WHERE account_id <> $1 OR vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM entitlement_projections WHERE account_id <> $1 OR vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM entitlement_offline_leases WHERE account_id <> $1 OR vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM terms_consent_evidence WHERE account_id <> $1 OR vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM contract_evidence WHERE account_id <> $1 OR vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM privacy_requests WHERE account_id <> $1 OR vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM vault_quota_usage WHERE account_id <> $1 OR vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM vault_quota_reservations WHERE account_id <> $1 OR vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM vault_quota_finalization_assertions WHERE account_id <> $1 OR vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM vault_sync_v2_states WHERE account_id <> $1 OR vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM vault_sync_v2_cards WHERE account_id <> $1 OR vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM vault_sync_v2_conflicts WHERE account_id <> $1 OR vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM vault_sync_v2_commits WHERE account_id <> $1 OR vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM vault_sync_v2_changes WHERE account_id <> $1 OR vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM account_deletion_operations WHERE account_id <> $1 OR vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM billing_checkout_intents child LEFT JOIN billing_subscriptions owner USING (subscription_id)
			WHERE owner.subscription_id IS NULL OR owner.account_id <> $1 OR owner.vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM billing_provider_event_receipts child LEFT JOIN billing_subscriptions owner USING (subscription_id)
			WHERE owner.subscription_id IS NULL OR owner.account_id <> $1 OR owner.vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM billing_reconciliation_checkpoints child LEFT JOIN billing_subscriptions owner USING (subscription_id)
			WHERE owner.subscription_id IS NULL OR owner.account_id <> $1 OR owner.vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM account_deletion_step_receipts child LEFT JOIN account_deletion_operations owner USING (operation_id)
			WHERE owner.operation_id IS NULL OR owner.account_id <> $1 OR owner.vault_id <> $2`, []any{accountID, vaultID}},
		{`SELECT COUNT(*) FROM account_deletion_continuations child LEFT JOIN account_deletion_operations owner USING (operation_id)
			WHERE owner.operation_id IS NULL OR owner.account_id <> $1 OR owner.vault_id <> $2`, []any{accountID, vaultID}},
	}
	for _, check := range checks {
		var count int64
		if err := tx.QueryRow(ctx, check.statement, check.values...).Scan(&count); err != nil || count != 0 {
			return ErrLocalFixtureConflict
		}
	}
	return nil
}

type deletionPhaseFacts struct {
	accountCount, vaultCount, activeSessions, wrappedKeys int64
	vaultDataRows, outboxRows, allLiveRows                int64
}

func inspectDeletionPhase(
	ctx context.Context,
	tx pgx.Tx,
	vaultContext identity.VaultContext,
) (LocalFixtureDeletionState, error) {
	accountID := string(vaultContext.AccountID)
	vaultID := string(vaultContext.VaultID)
	var operationCount int64
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM account_deletion_operations`).Scan(&operationCount); err != nil ||
		operationCount < 0 || operationCount > 1 {
		return LocalFixtureDeletionState{}, ErrLocalFixtureConflict
	}
	objectKeys, err := readDeletionObjectKeys(ctx, tx, vaultID)
	if err != nil {
		return LocalFixtureDeletionState{}, err
	}
	wrappedKey, err := readDeletionWrappedKey(ctx, tx, vaultContext.VaultID)
	if err != nil {
		return LocalFixtureDeletionState{}, err
	}
	if operationCount == 0 {
		var journalCount int64
		if err := tx.QueryRow(ctx, `SELECT
			(SELECT COUNT(*) FROM account_deletion_step_receipts) +
			(SELECT COUNT(*) FROM account_deletion_continuations)
		`).Scan(&journalCount); err != nil || journalCount != 0 {
			return LocalFixtureDeletionState{}, ErrLocalFixtureConflict
		}
		if wrappedKey == nil {
			return LocalFixtureDeletionState{}, ErrLocalFixtureConflict
		}
		return LocalFixtureDeletionState{
			Phase: LocalFixturePristine, ObjectKeys: objectKeys, WrappedKeyMetadata: wrappedKey,
		}, nil
	}
	snapshot, err := findAccountDeletionSnapshot(
		ctx, tx, " WHERE account_id = $1 AND vault_id = $2", accountID, vaultID,
	)
	if err != nil || snapshot == nil {
		return LocalFixtureDeletionState{}, ErrLocalFixtureConflict
	}
	continuation, err := findAccountDeletionContinuationByOperation(ctx, tx, snapshot.Operation.OperationID)
	if err != nil || continuation == nil || continuation.OperationID != snapshot.Operation.OperationID {
		return LocalFixtureDeletionState{}, ErrLocalFixtureConflict
	}
	var continuationCount int64
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM account_deletion_continuations`).Scan(&continuationCount); err != nil || continuationCount != 1 {
		return LocalFixtureDeletionState{}, ErrLocalFixtureConflict
	}
	facts, err := readDeletionPhaseFacts(ctx, tx, accountID, vaultID)
	if err != nil || !validDeletionPhase(*snapshot, facts) || (wrappedKey != nil) != (facts.wrappedKeys == 1) {
		return LocalFixtureDeletionState{}, ErrLocalFixtureConflict
	}
	phase := LocalFixtureDeleting
	if _, complete := snapshot.Operation.State.(accountdeletion.Completed); complete {
		phase = LocalFixtureCompleted
	}
	copy := *snapshot
	return LocalFixtureDeletionState{
		Phase: phase, Snapshot: &copy, ObjectKeys: objectKeys, WrappedKeyMetadata: wrappedKey,
	}, nil
}

func readDeletionWrappedKey(
	ctx context.Context,
	tx pgx.Tx,
	vaultID identity.VaultID,
) (*cryptocontent.VaultDEKMetadata, error) {
	rows, err := tx.Query(ctx, `SELECT vault_id, dek_version, kek_key_reference, wrapped_dek, is_write_key, created_at
		FROM vault_dek_versions WHERE vault_id = $1 ORDER BY dek_version`, string(vaultID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var metadata *cryptocontent.VaultDEKMetadata
	for rows.Next() {
		if metadata != nil {
			return nil, ErrLocalFixtureConflict
		}
		var rawVaultID, keyReference, wrappedDEK string
		var rawVersion, createdAt int64
		var writeKey bool
		if rows.Scan(
			&rawVaultID, &rawVersion, &keyReference, &wrappedDEK, &writeKey, &createdAt,
		) != nil || rawVaultID != string(vaultID) || !writeKey {
			return nil, ErrLocalFixtureConflict
		}
		version, parseErr := cryptocontent.ParseDEKVersion(rawVersion)
		if parseErr != nil {
			return nil, ErrLocalFixtureConflict
		}
		value := cryptocontent.VaultDEKMetadata{
			VaultID: vaultID, DEKVersion: version, KEKReference: keyReference,
			WrappedDEK: wrappedDEK, CreatedAtMilli: createdAt,
		}
		if cryptocontent.ValidateVaultDEKMetadata(value) != nil {
			return nil, ErrLocalFixtureConflict
		}
		metadata = &value
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return metadata, nil
}

func readDeletionPhaseFacts(
	ctx context.Context,
	tx pgx.Tx,
	accountID, vaultID string,
) (deletionPhaseFacts, error) {
	var facts deletionPhaseFacts
	err := tx.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM accounts WHERE account_id = $1),
		(SELECT COUNT(*) FROM personal_vaults WHERE account_id = $1 AND vault_id = $2),
		(SELECT COUNT(*) FROM sessions WHERE account_id = $1 AND vault_id = $2 AND revoked_at IS NULL),
		(SELECT COUNT(*) FROM vault_dek_versions WHERE vault_id = $2),
		(SELECT COUNT(*) FROM vault_encrypted_objects WHERE vault_id = $2) +
		(SELECT COUNT(*) FROM vault_encrypted_write_intents WHERE vault_id = $2) +
		(SELECT COUNT(*) FROM vault_sync_v2_states WHERE account_id = $1 AND vault_id = $2) +
		(SELECT COUNT(*) FROM vault_sync_v2_cards WHERE account_id = $1 AND vault_id = $2) +
		(SELECT COUNT(*) FROM vault_sync_v2_conflicts WHERE account_id = $1 AND vault_id = $2) +
		(SELECT COUNT(*) FROM vault_sync_v2_commits WHERE account_id = $1 AND vault_id = $2) +
		(SELECT COUNT(*) FROM vault_sync_v2_changes WHERE account_id = $1 AND vault_id = $2) +
		(SELECT COUNT(*) FROM vault_quota_usage WHERE account_id = $1 AND vault_id = $2) +
		(SELECT COUNT(*) FROM vault_quota_reservations WHERE account_id = $1 AND vault_id = $2) +
		(SELECT COUNT(*) FROM vault_quota_finalization_assertions WHERE account_id = $1 AND vault_id = $2),
		(SELECT COUNT(*) FROM vault_object_delete_outbox WHERE vault_id = $2),
		(SELECT COUNT(*) FROM accounts WHERE account_id = $1) +
		(SELECT COUNT(*) FROM personal_vaults WHERE account_id = $1 AND vault_id = $2) +
		(SELECT COUNT(*) FROM identities WHERE account_id = $1) +
		(SELECT COUNT(*) FROM sessions WHERE account_id = $1 OR vault_id = $2) +
		(SELECT COUNT(*) FROM verified_email_owners WHERE account_id = $1) +
		(SELECT COUNT(*) FROM signup_admission_reservations WHERE account_id = $1 OR vault_id = $2) +
		(SELECT COUNT(*) FROM vault_dek_versions WHERE vault_id = $2) +
		(SELECT COUNT(*) FROM vault_encrypted_objects WHERE vault_id = $2) +
		(SELECT COUNT(*) FROM vault_encrypted_write_intents WHERE vault_id = $2) +
		(SELECT COUNT(*) FROM vault_object_delete_outbox WHERE vault_id = $2) +
		(SELECT COUNT(*) FROM vault_dek_rotation_operations WHERE account_id = $1 OR vault_id = $2) +
		(SELECT COUNT(*) FROM vault_reencryption_jobs WHERE vault_id = $2) +
		(SELECT COUNT(*) FROM billing_subscriptions WHERE account_id = $1 OR vault_id = $2) +
		(SELECT COUNT(*) FROM billing_checkout_intents child JOIN billing_subscriptions owner USING (subscription_id)
		 WHERE owner.account_id = $1 OR owner.vault_id = $2) +
		(SELECT COUNT(*) FROM billing_provider_event_receipts child JOIN billing_subscriptions owner USING (subscription_id)
		 WHERE owner.account_id = $1 OR owner.vault_id = $2) +
		(SELECT COUNT(*) FROM billing_reconciliation_checkpoints child JOIN billing_subscriptions owner USING (subscription_id)
		 WHERE owner.account_id = $1 OR owner.vault_id = $2) +
		(SELECT COUNT(*) FROM entitlement_projections WHERE account_id = $1 OR vault_id = $2) +
		(SELECT COUNT(*) FROM entitlement_offline_leases WHERE account_id = $1 OR vault_id = $2) +
		(SELECT COUNT(*) FROM terms_consent_evidence WHERE account_id = $1 OR vault_id = $2) +
		(SELECT COUNT(*) FROM contract_evidence WHERE account_id = $1 OR vault_id = $2) +
		(SELECT COUNT(*) FROM vault_quota_usage WHERE account_id = $1 OR vault_id = $2) +
		(SELECT COUNT(*) FROM vault_quota_reservations WHERE account_id = $1 OR vault_id = $2) +
		(SELECT COUNT(*) FROM vault_quota_finalization_assertions WHERE account_id = $1 OR vault_id = $2) +
		(SELECT COUNT(*) FROM vault_sync_v2_states WHERE account_id = $1 OR vault_id = $2) +
		(SELECT COUNT(*) FROM vault_sync_v2_cards WHERE account_id = $1 OR vault_id = $2) +
		(SELECT COUNT(*) FROM vault_sync_v2_conflicts WHERE account_id = $1 OR vault_id = $2) +
		(SELECT COUNT(*) FROM vault_sync_v2_commits WHERE account_id = $1 OR vault_id = $2) +
		(SELECT COUNT(*) FROM vault_sync_v2_changes WHERE account_id = $1 OR vault_id = $2)
	`, accountID, vaultID).Scan(
		&facts.accountCount, &facts.vaultCount, &facts.activeSessions, &facts.wrappedKeys,
		&facts.vaultDataRows, &facts.outboxRows, &facts.allLiveRows,
	)
	return facts, err
}

func validDeletionPhase(snapshot accountdeletion.Snapshot, facts deletionPhaseFacts) bool {
	if !accountdeletion.ValidSnapshot(snapshot) || facts.accountCount < 0 || facts.accountCount > 1 ||
		facts.vaultCount < 0 || facts.vaultCount > 1 || facts.activeSessions < 0 ||
		facts.wrappedKeys < 0 || facts.wrappedKeys > 1 || facts.vaultDataRows < 0 ||
		facts.outboxRows < 0 || facts.allLiveRows < 0 {
		return false
	}
	if _, complete := snapshot.Operation.State.(accountdeletion.Completed); complete {
		return len(snapshot.Receipts) == 5 && facts.accountCount == 0 && facts.vaultCount == 0 &&
			facts.activeSessions == 0 && facts.wrappedKeys == 0 && facts.vaultDataRows == 0 &&
			facts.outboxRows == 0 && facts.allLiveRows == 0
	}
	ownerLive := facts.accountCount == 1 && facts.vaultCount == 1
	ownerAbsent := facts.accountCount == 0 && facts.vaultCount == 0
	if !ownerLive && !ownerAbsent {
		return false
	}
	step := deletionStateStep(snapshot.Operation.State)
	if ownerAbsent && (step != accountdeletion.StepFinalizeAccount || len(snapshot.Receipts) != 4 ||
		facts.allLiveRows != 0 || facts.wrappedKeys != 0) {
		return false
	}
	if len(snapshot.Receipts) >= 1 && facts.activeSessions != 0 {
		return false
	}
	if len(snapshot.Receipts) >= 3 && facts.vaultDataRows != 0 {
		return false
	}
	if len(snapshot.Receipts) >= 4 && facts.outboxRows != 0 {
		return false
	}
	if step != accountdeletion.StepFinalizeAccount && facts.wrappedKeys != 1 {
		return false
	}
	return true
}

func deletionStateStep(state accountdeletion.State) accountdeletion.Step {
	switch value := state.(type) {
	case accountdeletion.Ready:
		return value.Step
	case accountdeletion.Running:
		return value.Step
	case accountdeletion.RetryWait:
		return value.Step
	case accountdeletion.TerminalFailure:
		return value.Step
	default:
		return ""
	}
}

func readDeletionObjectKeys(
	ctx context.Context,
	tx pgx.Tx,
	vaultID string,
) ([]encryptedobject.ObjectKey, error) {
	rows, err := tx.Query(ctx, `SELECT object_key FROM (
		SELECT object_key FROM vault_encrypted_objects WHERE vault_id = $1
		UNION SELECT object_key FROM vault_encrypted_write_intents WHERE vault_id = $1
		UNION SELECT object_key FROM vault_object_delete_outbox WHERE vault_id = $1
	) inventory ORDER BY object_key`, vaultID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	keys := make([]encryptedobject.ObjectKey, 0)
	for rows.Next() {
		var raw string
		if rows.Scan(&raw) != nil {
			return nil, ErrLocalFixtureConflict
		}
		key, parseErr := encryptedobject.ParseObjectKey(raw)
		if parseErr != nil {
			return nil, ErrLocalFixtureConflict
		}
		keys = append(keys, key)
	}
	return keys, rows.Err()
}

func validDeletionPreflightIdentity(
	allowedSubject access.Subject,
	vaultContext identity.VaultContext,
) bool {
	_, subjectErr := access.ParseSubject(string(allowedSubject))
	_, accountErr := identity.ParseAccountID(string(vaultContext.AccountID))
	_, vaultErr := identity.ParseVaultID(string(vaultContext.VaultID))
	_, sessionErr := identity.ParseSessionID(string(vaultContext.SessionID))
	_, epochErr := identity.ParseSessionEpoch(int64(vaultContext.SessionEpoch))
	return subjectErr == nil && accountErr == nil && vaultErr == nil && sessionErr == nil && epochErr == nil
}

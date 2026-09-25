package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/syncv2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const maximumSyncV2TransactionAttempts = 3

var (
	ErrInvalidSyncV2Operation = errors.New("invalid Sync v2 journal operation")
	ErrInvalidSyncV2Record    = errors.New("invalid stored Sync v2 journal record")
	errSyncV2CASConflict      = errors.New("Sync v2 journal compare-and-swap conflict")
	ErrSyncV2PageGap          = errors.New("non-contiguous Sync v2 journal page")
)

type SyncV2JournalDirectory struct {
	pool *pgxpool.Pool
}

type SyncV2JournalRepository struct {
	pool  *pgxpool.Pool
	scope syncv2.Scope
}

var (
	_ syncv2.Directory  = (*SyncV2JournalDirectory)(nil)
	_ syncv2.Repository = (*SyncV2JournalRepository)(nil)
)

func NewSyncV2JournalDirectory(pool *pgxpool.Pool) (*SyncV2JournalDirectory, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &SyncV2JournalDirectory{pool: pool}, nil
}

func (directory *SyncV2JournalDirectory) Open(
	ctx context.Context,
	vaultContext identity.VaultContext,
) (syncv2.OpenResult, error) {
	if directory == nil || directory.pool == nil || !entitlement.ValidVaultContext(vaultContext) {
		return syncv2.OpenResult{}, ErrInvalidSyncV2Operation
	}
	scope := syncv2.Scope{AccountID: vaultContext.AccountID, VaultID: vaultContext.VaultID}
	for attempt := 0; attempt < maximumSyncV2TransactionAttempts; attempt++ {
		result := syncv2.OpenResult{Kind: syncv2.JournalOwnerMismatch}
		err := WithSerializableTx(ctx, directory.pool, func(transaction pgx.Tx) error {
			var owned bool
			if err := transaction.QueryRow(ctx, `SELECT EXISTS(
				SELECT 1 FROM personal_vaults WHERE account_id = $1 AND vault_id = $2
			)`, string(scope.AccountID), string(scope.VaultID)).Scan(&owned); err != nil {
				return err
			}
			if !owned {
				return nil
			}
			if _, err := transaction.Exec(ctx, `INSERT INTO vault_sync_v2_states(
				account_id, vault_id, next_display_id, next_change_sequence
			) VALUES ($1, $2, 1, 1) ON CONFLICT (account_id, vault_id) DO NOTHING`,
				string(scope.AccountID), string(scope.VaultID)); err != nil {
				return err
			}
			if _, err := loadSyncV2State(ctx, transaction, scope, true); err != nil {
				return err
			}
			result = syncv2.OpenResult{
				Kind:       syncv2.JournalOpened,
				Repository: &SyncV2JournalRepository{pool: directory.pool, scope: scope},
			}
			return nil
		})
		if err == nil {
			return result, nil
		}
		if !isRetryableTransactionError(err) || ctx.Err() != nil {
			return syncv2.OpenResult{}, err
		}
	}
	return syncv2.OpenResult{}, ErrConcurrentChange
}

func (repository *SyncV2JournalRepository) FindCard(
	ctx context.Context,
	cardID syncv2.CardID,
) (*syncv2.CardHead, error) {
	if !validSyncV2Repository(repository) || !validSyncV2CardID(cardID) {
		return nil, ErrInvalidSyncV2Operation
	}
	return findSyncV2Card(ctx, repository.pool, repository.scope, cardID)
}

func (repository *SyncV2JournalRepository) FindReceipt(
	ctx context.Context,
	mutationID syncv2.MutationID,
) (*syncv2.Receipt, error) {
	if !validSyncV2Repository(repository) || !validSyncV2MutationID(mutationID) {
		return nil, ErrInvalidSyncV2Operation
	}
	return findSyncV2Receipt(ctx, repository.pool, repository.scope, mutationID, false)
}

func (repository *SyncV2JournalRepository) Commit(
	ctx context.Context,
	command syncv2.CommitCommand,
) (syncv2.CommitResult, error) {
	if !validSyncV2Repository(repository) {
		return syncv2.CommitResult{}, ErrInvalidSyncV2Operation
	}
	if reason := syncv2.ValidateCommitCommand(command); reason != "" {
		return syncv2.CommitResult{Kind: syncv2.CommitRejected, Reason: reason}, nil
	}
	for attempt := 0; attempt < maximumSyncV2TransactionAttempts; attempt++ {
		result := syncv2.CommitResult{}
		err := WithSerializableTx(ctx, repository.pool, func(transaction pgx.Tx) error {
			if _, err := transaction.Exec(ctx,
				`SELECT pg_advisory_xact_lock(hashtextextended($1, 7312))`, string(repository.scope.VaultID)); err != nil {
				return fmt.Errorf("lock Sync v2 journal: %w", err)
			}
			snapshot, err := loadSyncV2Snapshot(ctx, transaction, repository.scope, command)
			if err != nil {
				return err
			}
			plan := syncv2.PlanCommitCommand(command, snapshot)
			switch plan.Kind {
			case syncv2.PlanRejected:
				result = syncv2.CommitResult{Kind: syncv2.CommitRejected, Reason: plan.Reason}
				return nil
			case syncv2.PlanReplay:
				receipt := plan.Receipt
				result = syncv2.CommitResult{Kind: syncv2.CommitReplayed, Receipt: &receipt}
				return nil
			case syncv2.PlanCommit:
				if err := applySyncV2Commit(ctx, transaction, repository.scope, command, plan); err != nil {
					return err
				}
				receipt := plan.Receipt
				result = syncv2.CommitResult{Kind: syncv2.CommitApplied, Receipt: &receipt}
				return nil
			default:
				return ErrInvalidSyncV2Operation
			}
		})
		if err == nil {
			return result, nil
		}
		if errors.Is(err, errSyncV2CASConflict) || isUniqueViolation(err) {
			return syncv2.CommitResult{Kind: syncv2.CommitRejected, Reason: syncv2.ReasonCASConflict}, nil
		}
		if !isRetryableTransactionError(err) || ctx.Err() != nil {
			return syncv2.CommitResult{}, err
		}
	}
	return syncv2.CommitResult{Kind: syncv2.CommitRejected, Reason: syncv2.ReasonCASConflict}, nil
}

func (repository *SyncV2JournalRepository) ReadPage(
	ctx context.Context,
	afterSequence syncv2.Sequence,
	highWatermark *syncv2.Sequence,
	limit int,
) (syncv2.Page, error) {
	if !validSyncV2Repository(repository) || limit < 1 || limit > syncv2.MaximumPageSize {
		return syncv2.Page{}, ErrInvalidSyncV2Operation
	}
	if _, err := syncv2.ParseSequence(int64(afterSequence)); err != nil {
		return syncv2.Page{}, ErrInvalidSyncV2Operation
	}
	state, err := loadSyncV2State(ctx, repository.pool, repository.scope, false)
	if err != nil {
		return syncv2.Page{}, err
	}
	currentHighWatermark := syncv2.Sequence(int64(state.NextSequence) - 1)
	requestedHighWatermark := currentHighWatermark
	if highWatermark != nil {
		requestedHighWatermark = *highWatermark
	}
	if _, err := syncv2.ParseSequence(int64(requestedHighWatermark)); err != nil ||
		afterSequence > requestedHighWatermark || requestedHighWatermark > currentHighWatermark {
		return syncv2.Page{}, ErrInvalidSyncV2Operation
	}
	rows, err := repository.pool.Query(ctx, `SELECT sequence, change_kind, card_id,
		conflict_id, revision, official_display_id, occurred_at
		FROM vault_sync_v2_changes
		WHERE account_id = $1 AND vault_id = $2 AND sequence > $3 AND sequence <= $4
		ORDER BY sequence ASC LIMIT $5`, string(repository.scope.AccountID), string(repository.scope.VaultID),
		int64(afterSequence), int64(requestedHighWatermark), limit+1)
	if err != nil {
		return syncv2.Page{}, err
	}
	defer rows.Close()
	candidates := make([]syncv2.Change, 0, limit+1)
	for rows.Next() {
		change, err := scanSyncV2Change(rows)
		if err != nil {
			return syncv2.Page{}, err
		}
		candidates = append(candidates, change)
	}
	if err := rows.Err(); err != nil {
		return syncv2.Page{}, err
	}
	page, valid := syncv2.PlanPage(afterSequence, requestedHighWatermark, candidates, limit)
	if !valid {
		return syncv2.Page{}, ErrSyncV2PageGap
	}
	return page, nil
}

type syncV2Querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func loadSyncV2Snapshot(
	ctx context.Context,
	transaction pgx.Tx,
	scope syncv2.Scope,
	command syncv2.CommitCommand,
) (syncv2.Snapshot, error) {
	state, err := loadSyncV2State(ctx, transaction, scope, true)
	if err != nil {
		return syncv2.Snapshot{}, err
	}
	receipt, err := findSyncV2Receipt(ctx, transaction, scope, command.MutationID, false)
	if err != nil {
		return syncv2.Snapshot{}, err
	}
	card, err := findSyncV2Card(ctx, transaction, scope, command.CardID)
	if err != nil {
		return syncv2.Snapshot{}, err
	}
	selected := []syncv2.ConflictHead{}
	all := []syncv2.ConflictHead{}
	switch command.Kind {
	case syncv2.CommandConflictUpsert:
		conflict, findErr := findSyncV2Conflict(ctx, transaction, scope, command.ConflictID)
		if findErr != nil {
			return syncv2.Snapshot{}, findErr
		}
		if conflict != nil {
			selected = append(selected, *conflict)
		}
	case syncv2.CommandResolveConflicts:
		selected, err = listSelectedSyncV2Conflicts(ctx, transaction, scope, command.ConflictIDs)
		if err != nil {
			return syncv2.Snapshot{}, err
		}
	case syncv2.CommandCardDelete:
		all, err = listSyncV2CardConflicts(ctx, transaction, scope, command.CardID)
		if err != nil {
			return syncv2.Snapshot{}, err
		}
	}
	return syncv2.Snapshot{
		State: state, ExistingReceipt: receipt, Card: card,
		SelectedConflicts: selected, AllCardConflicts: all,
	}, nil
}

func applySyncV2Commit(
	ctx context.Context,
	transaction pgx.Tx,
	scope syncv2.Scope,
	command syncv2.CommitCommand,
	plan syncv2.CommitPlan,
) error {
	arguments := []any{string(scope.AccountID), string(scope.VaultID), string(command.CardID)}
	var tag pgconn.CommandTag
	var err error
	switch command.Kind {
	case syncv2.CommandCardUpsert:
		if command.ExpectedRevision == nil {
			tag, err = transaction.Exec(ctx, `INSERT INTO vault_sync_v2_cards(
				account_id, vault_id, card_id, official_display_id, revision, updated_at
			) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
				append(arguments, plan.OfficialDisplayID, int64(command.NextRevision), command.OccurredAt)...)
		} else {
			tag, err = transaction.Exec(ctx, `UPDATE vault_sync_v2_cards
				SET revision = $4, updated_at = $5
				WHERE account_id = $1 AND vault_id = $2 AND card_id = $3 AND revision = $6`,
				append(arguments, int64(command.NextRevision), command.OccurredAt, int64(*command.ExpectedRevision))...)
		}
	case syncv2.CommandConflictUpsert:
		tag, err = transaction.Exec(ctx, `INSERT INTO vault_sync_v2_conflicts(
			account_id, vault_id, conflict_id, card_id, server_revision, created_at
		) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
			string(scope.AccountID), string(scope.VaultID), string(command.ConflictID),
			string(command.CardID), int64(command.ServerRevision), command.OccurredAt)
	case syncv2.CommandResolveConflicts:
		tag, err = transaction.Exec(ctx, `UPDATE vault_sync_v2_cards
			SET revision = $4, updated_at = $5
			WHERE account_id = $1 AND vault_id = $2 AND card_id = $3 AND revision = $6`,
			append(arguments, int64(command.NextRevision), command.OccurredAt, int64(*command.ExpectedRevision))...)
	case syncv2.CommandCardDelete:
		tag, err = transaction.Exec(ctx, `DELETE FROM vault_sync_v2_cards
			WHERE account_id = $1 AND vault_id = $2 AND card_id = $3 AND revision = $4`,
			append(arguments, int64(*command.ExpectedRevision))...)
	default:
		return ErrInvalidSyncV2Operation
	}
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errSyncV2CASConflict
	}
	if command.Kind == syncv2.CommandResolveConflicts {
		for _, conflictID := range command.ConflictIDs {
			tag, err := transaction.Exec(ctx, `DELETE FROM vault_sync_v2_conflicts
				WHERE account_id = $1 AND vault_id = $2 AND conflict_id = $3 AND card_id = $4`,
				string(scope.AccountID), string(scope.VaultID), string(conflictID), string(command.CardID))
			if err != nil {
				return err
			}
			if tag.RowsAffected() != 1 {
				return errSyncV2CASConflict
			}
		}
	}
	if _, err := transaction.Exec(ctx, `INSERT INTO vault_sync_v2_commits(
		account_id, vault_id, mutation_id, fingerprint, card_id, applied_revision, committed_at
	) VALUES ($1, $2, $3, $4, $5, $6, $7)`, string(scope.AccountID), string(scope.VaultID),
		string(plan.Receipt.MutationID), string(plan.Receipt.Fingerprint), string(plan.Receipt.CardID),
		int64(plan.Receipt.AppliedRevision), plan.Receipt.CommittedAt); err != nil {
		return err
	}
	for _, change := range plan.Changes {
		var conflictID any
		if change.ConflictID != "" {
			conflictID = string(change.ConflictID)
		}
		var displayID any
		if change.OfficialDisplayID != 0 {
			displayID = change.OfficialDisplayID
		}
		if _, err := transaction.Exec(ctx, `INSERT INTO vault_sync_v2_changes(
			account_id, vault_id, sequence, change_kind, card_id, conflict_id,
			revision, official_display_id, occurred_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, string(scope.AccountID), string(scope.VaultID),
			int64(change.Sequence), string(change.Kind), string(change.CardID), conflictID,
			int64(change.Revision), displayID, change.OccurredAt); err != nil {
			return err
		}
	}
	tag, err = transaction.Exec(ctx, `UPDATE vault_sync_v2_states
		SET next_display_id = $3, next_change_sequence = $4
		WHERE account_id = $1 AND vault_id = $2
		AND next_display_id = $5 AND next_change_sequence = $6`, string(scope.AccountID), string(scope.VaultID),
		plan.NextState.NextDisplayID, int64(plan.NextState.NextSequence),
		plan.ExpectedState.NextDisplayID, int64(plan.ExpectedState.NextSequence))
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errSyncV2CASConflict
	}
	return nil
}

func loadSyncV2State(
	ctx context.Context,
	querier syncV2Querier,
	scope syncv2.Scope,
	forUpdate bool,
) (syncv2.State, error) {
	query := `SELECT next_display_id, next_change_sequence FROM vault_sync_v2_states
		WHERE account_id = $1 AND vault_id = $2`
	if forUpdate {
		query += ` FOR UPDATE`
	}
	var nextDisplayID, nextSequence int64
	if err := querier.QueryRow(ctx, query, string(scope.AccountID), string(scope.VaultID)).Scan(
		&nextDisplayID, &nextSequence,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return syncv2.State{}, ErrInvalidSyncV2Operation
		}
		return syncv2.State{}, err
	}
	sequence, err := syncv2.ParseSequence(nextSequence)
	if err != nil || nextDisplayID < 1 || nextDisplayID > syncv2.MaximumDisplayID || sequence < 1 {
		return syncv2.State{}, ErrInvalidSyncV2Record
	}
	return syncv2.State{NextDisplayID: nextDisplayID, NextSequence: sequence}, nil
}

func findSyncV2Card(
	ctx context.Context,
	querier syncV2Querier,
	scope syncv2.Scope,
	cardID syncv2.CardID,
) (*syncv2.CardHead, error) {
	var rawCardID string
	var displayID, revision, updatedAt int64
	err := querier.QueryRow(ctx, `SELECT card_id, official_display_id, revision, updated_at
		FROM vault_sync_v2_cards WHERE account_id = $1 AND vault_id = $2 AND card_id = $3`,
		string(scope.AccountID), string(scope.VaultID), string(cardID)).Scan(
		&rawCardID, &displayID, &revision, &updatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	parsedCardID, parseErr := syncv2.ParseCardID(rawCardID)
	parsedRevision, revisionErr := syncv2.ParseRevision(revision)
	if parseErr != nil || revisionErr != nil || displayID < 1 || displayID > syncv2.MaximumDisplayID ||
		updatedAt < 0 || updatedAt > syncv2.MaximumSafeInteger {
		return nil, ErrInvalidSyncV2Record
	}
	return &syncv2.CardHead{
		CardID: parsedCardID, OfficialDisplayID: displayID,
		Revision: parsedRevision, UpdatedAt: updatedAt,
	}, nil
}

func findSyncV2Receipt(
	ctx context.Context,
	querier syncV2Querier,
	scope syncv2.Scope,
	mutationID syncv2.MutationID,
	lock bool,
) (*syncv2.Receipt, error) {
	var rawMutationID, rawFingerprint, rawCardID string
	var revision, committedAt int64
	query := `SELECT mutation_id, fingerprint, card_id, applied_revision, committed_at
		FROM vault_sync_v2_commits WHERE account_id = $1 AND vault_id = $2 AND mutation_id = $3`
	if lock {
		query += " FOR SHARE"
	}
	err := querier.QueryRow(ctx, query,
		string(scope.AccountID), string(scope.VaultID), string(mutationID)).Scan(
		&rawMutationID, &rawFingerprint, &rawCardID, &revision, &committedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	parsedMutationID, mutationErr := syncv2.ParseMutationID(rawMutationID)
	fingerprint, fingerprintErr := syncv2.ParseFingerprint(rawFingerprint)
	cardID, cardErr := syncv2.ParseCardID(rawCardID)
	parsedRevision, revisionErr := syncv2.ParseRevision(revision)
	if mutationErr != nil || fingerprintErr != nil || cardErr != nil || revisionErr != nil ||
		committedAt < 0 || committedAt > syncv2.MaximumSafeInteger {
		return nil, ErrInvalidSyncV2Record
	}
	return &syncv2.Receipt{
		MutationID: parsedMutationID, Fingerprint: fingerprint, CardID: cardID,
		AppliedRevision: parsedRevision, CommittedAt: committedAt,
	}, nil
}

func findSyncV2Conflict(
	ctx context.Context,
	querier syncV2Querier,
	scope syncv2.Scope,
	conflictID syncv2.ConflictID,
) (*syncv2.ConflictHead, error) {
	var rawConflictID, rawCardID string
	var revision, createdAt int64
	err := querier.QueryRow(ctx, `SELECT conflict_id, card_id, server_revision, created_at
		FROM vault_sync_v2_conflicts WHERE account_id = $1 AND vault_id = $2 AND conflict_id = $3`,
		string(scope.AccountID), string(scope.VaultID), string(conflictID)).Scan(
		&rawConflictID, &rawCardID, &revision, &createdAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	conflict, err := decodeSyncV2Conflict(rawConflictID, rawCardID, revision, createdAt)
	if err != nil {
		return nil, err
	}
	return &conflict, nil
}

func listSyncV2CardConflicts(
	ctx context.Context,
	transaction pgx.Tx,
	scope syncv2.Scope,
	cardID syncv2.CardID,
) ([]syncv2.ConflictHead, error) {
	rows, err := transaction.Query(ctx, `SELECT conflict_id, card_id, server_revision, created_at
		FROM vault_sync_v2_conflicts WHERE account_id = $1 AND vault_id = $2 AND card_id = $3
		ORDER BY conflict_id ASC LIMIT $4`, string(scope.AccountID), string(scope.VaultID), string(cardID),
		syncv2.MaximumConflictsPerCard+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	conflicts := []syncv2.ConflictHead{}
	for rows.Next() {
		var rawConflictID, rawCardID string
		var revision, createdAt int64
		if err := rows.Scan(&rawConflictID, &rawCardID, &revision, &createdAt); err != nil {
			return nil, err
		}
		conflict, err := decodeSyncV2Conflict(rawConflictID, rawCardID, revision, createdAt)
		if err != nil {
			return nil, err
		}
		conflicts = append(conflicts, conflict)
		if len(conflicts) > syncv2.MaximumConflictsPerCard {
			return nil, ErrInvalidSyncV2Record
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return conflicts, nil
}

func listSelectedSyncV2Conflicts(
	ctx context.Context,
	transaction pgx.Tx,
	scope syncv2.Scope,
	conflictIDs []syncv2.ConflictID,
) ([]syncv2.ConflictHead, error) {
	rawIDs := make([]string, len(conflictIDs))
	for index, conflictID := range conflictIDs {
		rawIDs[index] = string(conflictID)
	}
	rows, err := transaction.Query(ctx, `SELECT conflict_id, card_id, server_revision, created_at
		FROM vault_sync_v2_conflicts
		WHERE account_id = $1 AND vault_id = $2 AND conflict_id = ANY($3)
		ORDER BY conflict_id ASC`, string(scope.AccountID), string(scope.VaultID), rawIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	conflicts := make([]syncv2.ConflictHead, 0, len(conflictIDs))
	for rows.Next() {
		var rawConflictID, rawCardID string
		var revision, createdAt int64
		if err := rows.Scan(&rawConflictID, &rawCardID, &revision, &createdAt); err != nil {
			return nil, err
		}
		conflict, err := decodeSyncV2Conflict(rawConflictID, rawCardID, revision, createdAt)
		if err != nil {
			return nil, err
		}
		conflicts = append(conflicts, conflict)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return conflicts, nil
}

func decodeSyncV2Conflict(rawConflictID, rawCardID string, revision, createdAt int64) (syncv2.ConflictHead, error) {
	conflictID, conflictErr := syncv2.ParseConflictID(rawConflictID)
	cardID, cardErr := syncv2.ParseCardID(rawCardID)
	parsedRevision, revisionErr := syncv2.ParseRevision(revision)
	if conflictErr != nil || cardErr != nil || revisionErr != nil ||
		createdAt < 0 || createdAt > syncv2.MaximumSafeInteger {
		return syncv2.ConflictHead{}, ErrInvalidSyncV2Record
	}
	return syncv2.ConflictHead{
		ConflictID: conflictID, CardID: cardID,
		ServerRevision: parsedRevision, CreatedAt: createdAt,
	}, nil
}

type syncV2Row interface {
	Scan(...any) error
}

func scanSyncV2Change(row syncV2Row) (syncv2.Change, error) {
	var sequence, revision, occurredAt int64
	var kind, rawCardID string
	var rawConflictID *string
	var officialDisplayID *int64
	if err := row.Scan(&sequence, &kind, &rawCardID, &rawConflictID, &revision, &officialDisplayID, &occurredAt); err != nil {
		return syncv2.Change{}, err
	}
	parsedSequence, sequenceErr := syncv2.ParseSequence(sequence)
	cardID, cardErr := syncv2.ParseCardID(rawCardID)
	parsedRevision, revisionErr := syncv2.ParseRevision(revision)
	if sequenceErr != nil || sequence < 1 || cardErr != nil || revisionErr != nil ||
		occurredAt < 0 || occurredAt > syncv2.MaximumSafeInteger {
		return syncv2.Change{}, ErrInvalidSyncV2Record
	}
	change := syncv2.Change{
		Kind: syncv2.ChangeKind(kind), Sequence: parsedSequence, CardID: cardID,
		Revision: parsedRevision, OccurredAt: occurredAt,
	}
	if rawConflictID != nil {
		conflictID, err := syncv2.ParseConflictID(*rawConflictID)
		if err != nil {
			return syncv2.Change{}, ErrInvalidSyncV2Record
		}
		change.ConflictID = conflictID
	}
	if officialDisplayID != nil {
		change.OfficialDisplayID = *officialDisplayID
	}
	// The pure page planner validates the tag-specific shape before exposing it.
	return change, nil
}

func validSyncV2Repository(repository *SyncV2JournalRepository) bool {
	if repository == nil || repository.pool == nil {
		return false
	}
	if _, err := identity.ParseAccountID(string(repository.scope.AccountID)); err != nil {
		return false
	}
	if _, err := identity.ParseVaultID(string(repository.scope.VaultID)); err != nil {
		return false
	}
	return true
}

func validSyncV2CardID(cardID syncv2.CardID) bool {
	_, err := syncv2.ParseCardID(string(cardID))
	return err == nil
}

func validSyncV2MutationID(mutationID syncv2.MutationID) bool {
	_, err := syncv2.ParseMutationID(string(mutationID))
	return err == nil
}

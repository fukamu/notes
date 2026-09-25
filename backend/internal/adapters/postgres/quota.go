package postgres

import (
	"context"
	"database/sql"
	"errors"

	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/quota"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const maximumQuotaTransactionAttempts = 3

var (
	ErrInvalidQuotaOperation = errors.New("invalid quota operation")
	ErrInvalidQuotaRecord    = errors.New("invalid stored quota record")
)

type QuotaLedgerDirectory struct {
	pool *pgxpool.Pool
}

type QuotaLedger struct {
	pool  *pgxpool.Pool
	scope quota.Scope
}

var (
	_ quota.Directory = (*QuotaLedgerDirectory)(nil)
	_ quota.Ledger    = (*QuotaLedger)(nil)
)

const quotaSnapshotSelect = `SELECT usage.account_id, usage.vault_id,
       usage.revision, usage.active_cards, usage.plaintext_bytes,
       COALESCE((
         SELECT SUM(reservation.charged_card_delta)
           FROM vault_quota_reservations reservation
          WHERE reservation.account_id = usage.account_id
            AND reservation.vault_id = usage.vault_id
            AND reservation.state = 'reserved'
       ), 0),
       COALESCE((
         SELECT SUM(reservation.charged_plaintext_byte_delta)
           FROM vault_quota_reservations reservation
          WHERE reservation.account_id = usage.account_id
            AND reservation.vault_id = usage.vault_id
            AND reservation.state = 'reserved'
       ), 0),
       usage.created_at, usage.updated_at
  FROM vault_quota_usage usage`

const quotaReservationSelect = `SELECT account_id, vault_id, reservation_id,
       fingerprint, card_id, change_kind, card_delta,
       plaintext_byte_delta, charged_card_delta,
       charged_plaintext_byte_delta, usage_revision_at_reservation,
       state, created_at, reconcile_after, finalized_at,
       finalized_usage_revision
  FROM vault_quota_reservations`

func NewQuotaLedgerDirectory(pool *pgxpool.Pool) (*QuotaLedgerDirectory, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &QuotaLedgerDirectory{pool: pool}, nil
}

func (directory *QuotaLedgerDirectory) Open(
	ctx context.Context,
	vaultContext identity.VaultContext,
	initializedAt int64,
) (quota.OpenResult, error) {
	if directory == nil || directory.pool == nil ||
		!entitlement.ValidVaultContext(vaultContext) || !validQuotaTimestamp(initializedAt) {
		return quota.OpenResult{}, ErrInvalidQuotaOperation
	}
	scope := quota.Scope{AccountID: vaultContext.AccountID, VaultID: vaultContext.VaultID}
	for attempt := 0; attempt < maximumQuotaTransactionAttempts; attempt++ {
		result := quota.OpenResult{Kind: quota.LedgerOwnerMismatch}
		err := WithSerializableTx(ctx, directory.pool, func(transaction pgx.Tx) error {
			var owned bool
			if err := transaction.QueryRow(
				ctx,
				`SELECT EXISTS(
				   SELECT 1 FROM personal_vaults
				    WHERE account_id = $1 AND vault_id = $2
				 )`,
				string(scope.AccountID), string(scope.VaultID),
			).Scan(&owned); err != nil {
				return err
			}
			if !owned {
				return nil
			}
			if _, err := transaction.Exec(
				ctx,
				`INSERT INTO vault_quota_usage(
				   account_id, vault_id, revision, active_cards, plaintext_bytes,
				   last_transition_reservation_id, created_at, updated_at
				 ) VALUES ($1, $2, 1, 0, 0, NULL, $3, $3)
				 ON CONFLICT (account_id, vault_id) DO NOTHING`,
				string(scope.AccountID), string(scope.VaultID), initializedAt,
			); err != nil {
				return err
			}
			if _, err := loadQuotaSnapshot(ctx, transaction, scope); err != nil {
				return err
			}
			result = quota.OpenResult{
				Kind:   quota.LedgerOpened,
				Ledger: &QuotaLedger{pool: directory.pool, scope: scope},
			}
			return nil
		})
		if err == nil {
			return result, nil
		}
		if !isRetryableTransactionError(err) || ctx.Err() != nil {
			return quota.OpenResult{}, err
		}
	}
	return quota.OpenResult{}, ErrConcurrentChange
}

func (ledger *QuotaLedger) Snapshot(ctx context.Context) (quota.Snapshot, error) {
	if !validQuotaLedger(ledger) {
		return quota.Snapshot{}, ErrInvalidQuotaOperation
	}
	return loadQuotaSnapshot(ctx, ledger.pool, ledger.scope)
}

func (ledger *QuotaLedger) FindReservation(
	ctx context.Context,
	reservationID quota.ReservationID,
) (*quota.Reservation, error) {
	if !validQuotaLedger(ledger) || !validQuotaReservationID(reservationID) {
		return nil, ErrInvalidQuotaOperation
	}
	return findQuotaReservation(ctx, ledger.pool, ledger.scope, reservationID, false)
}

func (ledger *QuotaLedger) Reserve(
	ctx context.Context,
	command quota.ReservationCommand,
) (quota.ReservationResult, error) {
	if !validQuotaLedger(ledger) {
		return quota.ReservationResult{}, ErrInvalidQuotaOperation
	}
	for attempt := 0; attempt < maximumQuotaTransactionAttempts; attempt++ {
		result := quota.ReservationResult{}
		err := WithSerializableTx(ctx, ledger.pool, func(transaction pgx.Tx) error {
			if err := lockQuotaUsage(ctx, transaction, ledger.scope); err != nil {
				return err
			}
			current, err := loadQuotaSnapshot(ctx, transaction, ledger.scope)
			if err != nil {
				return err
			}
			existing, err := findQuotaReservation(
				ctx, transaction, ledger.scope, command.ReservationID, true,
			)
			if err != nil {
				return err
			}
			plan := quota.PlanReservation(ledger.scope, current, existing, command)
			switch plan.Kind {
			case quota.ReservationPlanRejected:
				result = quota.ReservationResult{Kind: quota.ReservationRejected, Reason: plan.Reason}
				return nil
			case quota.ReservationPlanReplay:
				reservation := plan.Reservation
				result = quota.ReservationResult{
					Kind: quota.ReservationReplayed, Reservation: &reservation, Snapshot: &current,
				}
				return nil
			case quota.ReservationPlanApply:
				if err := insertQuotaReservation(ctx, transaction, plan); err != nil {
					return err
				}
			default:
				return ErrInvalidQuotaOperation
			}
			reservation, err := findQuotaReservation(
				ctx, transaction, ledger.scope, command.ReservationID, false,
			)
			if err != nil {
				return err
			}
			if reservation == nil {
				return ErrInvalidQuotaRecord
			}
			next, err := loadQuotaSnapshot(ctx, transaction, ledger.scope)
			if err != nil {
				return err
			}
			result = quota.ReservationResult{
				Kind: quota.ReservationApplied, Reservation: reservation, Snapshot: &next,
			}
			return nil
		})
		if err == nil {
			return result, nil
		}
		if ctx.Err() != nil {
			return quota.ReservationResult{}, ctx.Err()
		}
		if !errors.Is(err, ErrConcurrentChange) && !isRetryableTransactionError(err) && !isUniqueViolation(err) {
			return quota.ReservationResult{}, err
		}
	}
	return quota.ReservationResult{
		Kind: quota.ReservationRejected, Reason: quota.RejectionCASConflict,
	}, nil
}

func (ledger *QuotaLedger) Finalize(
	ctx context.Context,
	command quota.FinalizationCommand,
) (quota.FinalizationResult, error) {
	if !validQuotaLedger(ledger) {
		return quota.FinalizationResult{}, ErrInvalidQuotaOperation
	}
	for attempt := 0; attempt < maximumQuotaTransactionAttempts; attempt++ {
		result := quota.FinalizationResult{}
		err := WithSerializableTx(ctx, ledger.pool, func(transaction pgx.Tx) error {
			if err := lockQuotaUsage(ctx, transaction, ledger.scope); err != nil {
				return err
			}
			current, err := loadQuotaSnapshot(ctx, transaction, ledger.scope)
			if err != nil {
				return err
			}
			reservation, err := findQuotaReservation(
				ctx, transaction, ledger.scope, command.ReservationID, true,
			)
			if err != nil {
				return err
			}
			if reservation == nil {
				result = quota.FinalizationResult{
					Kind: quota.FinalizationRejected, Reason: quota.RejectionNotFound,
				}
				return nil
			}
			plan := quota.PlanFinalization(ledger.scope, current, *reservation, command)
			switch plan.Kind {
			case quota.FinalizationPlanRejected:
				result = quota.FinalizationResult{Kind: quota.FinalizationRejected, Reason: plan.Reason}
				return nil
			case quota.FinalizationPlanReplay:
				replayed := plan.Reservation
				result = quota.FinalizationResult{
					Kind: quota.FinalizationReplayed, Reservation: &replayed, Snapshot: &current,
				}
				return nil
			case quota.FinalizationPlanApply:
				if err := applyQuotaFinalization(ctx, transaction, plan); err != nil {
					return err
				}
			default:
				return ErrInvalidQuotaOperation
			}
			nextReservation, err := findQuotaReservation(
				ctx, transaction, ledger.scope, command.ReservationID, false,
			)
			if err != nil {
				return err
			}
			if nextReservation == nil || nextReservation.State != plan.Reservation.State {
				return ErrConcurrentChange
			}
			next, err := loadQuotaSnapshot(ctx, transaction, ledger.scope)
			if err != nil {
				return err
			}
			kind := quota.FinalizationCommitted
			if command.Outcome == quota.FinalizationRelease {
				kind = quota.FinalizationReleased
			}
			result = quota.FinalizationResult{
				Kind: kind, Reservation: nextReservation, Snapshot: &next,
			}
			return nil
		})
		if err == nil {
			return result, nil
		}
		if ctx.Err() != nil {
			return quota.FinalizationResult{}, ctx.Err()
		}
		if !errors.Is(err, ErrConcurrentChange) && !isRetryableTransactionError(err) {
			return quota.FinalizationResult{}, err
		}
	}
	return quota.FinalizationResult{
		Kind: quota.FinalizationRejected, Reason: quota.RejectionCASConflict,
	}, nil
}

func (ledger *QuotaLedger) ListReconciliationCandidates(
	ctx context.Context,
	now int64,
	limit int,
) ([]quota.Reservation, error) {
	if !validQuotaLedger(ledger) || !validQuotaTimestamp(now) ||
		limit < 1 || limit > quota.MaximumReconciliationPageSize {
		return nil, ErrInvalidQuotaOperation
	}
	rows, err := ledger.pool.Query(
		ctx,
		quotaReservationSelect+` WHERE account_id = $1 AND vault_id = $2
		   AND state = 'reserved' AND reconcile_after <= $3
		 ORDER BY reconcile_after, reservation_id LIMIT $4`,
		string(ledger.scope.AccountID), string(ledger.scope.VaultID), now, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	reservations := make([]quota.Reservation, 0, limit)
	for rows.Next() {
		reservation, scanErr := scanQuotaReservation(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		if !sameQuotaScope(reservation.Scope, ledger.scope) {
			return nil, ErrInvalidQuotaRecord
		}
		reservations = append(reservations, reservation)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return reservations, nil
}

func insertQuotaReservation(ctx context.Context, transaction pgx.Tx, plan quota.ReservationPlan) error {
	reservation := plan.Reservation
	tag, err := transaction.Exec(
		ctx,
		`INSERT INTO vault_quota_reservations(
		   account_id, vault_id, reservation_id, fingerprint, card_id,
		   change_kind, card_delta, plaintext_byte_delta, charged_card_delta,
		   charged_plaintext_byte_delta, usage_revision_at_reservation,
		   state, created_at, reconcile_after, finalized_at,
		   finalized_usage_revision
		 ) SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
		          'reserved', $12, $13, NULL, NULL
		   FROM vault_quota_usage
		  WHERE account_id = $1 AND vault_id = $2 AND revision = $11
		    AND active_cards = $14 AND plaintext_bytes = $15 AND updated_at = $16`,
		string(reservation.AccountID), string(reservation.VaultID), string(reservation.ReservationID),
		string(reservation.Fingerprint), string(reservation.CardID), string(reservation.ChangeKind),
		reservation.CardDelta, reservation.PlaintextByteDelta, reservation.ChargedCardDelta,
		reservation.ChargedPlaintextByteDelta, int64(reservation.UsageRevisionAtReservation),
		reservation.CreatedAt, reservation.ReconcileAfter, plan.Current.Committed.ActiveCards,
		plan.Current.Committed.PlaintextBytes, plan.Current.UpdatedAt,
	)
	if err != nil {
		return err
	}
	return RequireOneRow(tag)
}

func applyQuotaFinalization(ctx context.Context, transaction pgx.Tx, plan quota.FinalizationPlan) error {
	tag, err := transaction.Exec(
		ctx,
		`UPDATE vault_quota_usage SET
		   revision = $1, active_cards = $2, plaintext_bytes = $3,
		   last_transition_reservation_id = $4, updated_at = $5
		 WHERE account_id = $6 AND vault_id = $7 AND revision = $8
		   AND active_cards = $9 AND plaintext_bytes = $10 AND updated_at = $11`,
		int64(plan.Next.Revision), plan.Next.Committed.ActiveCards, plan.Next.Committed.PlaintextBytes,
		string(plan.Reservation.ReservationID), plan.Next.UpdatedAt,
		string(plan.Next.AccountID), string(plan.Next.VaultID), int64(plan.Current.Revision),
		plan.Current.Committed.ActiveCards, plan.Current.Committed.PlaintextBytes, plan.Current.UpdatedAt,
	)
	if err != nil {
		return err
	}
	if err := RequireOneRow(tag); err != nil {
		return err
	}
	tag, err = transaction.Exec(
		ctx,
		`UPDATE vault_quota_reservations SET
		   state = $1, finalized_at = $2, finalized_usage_revision = $3
		 WHERE account_id = $4 AND vault_id = $5 AND reservation_id = $6
		   AND fingerprint = $7 AND state = 'reserved'
		   AND card_delta = $8 AND plaintext_byte_delta = $9
		   AND usage_revision_at_reservation = $10`,
		string(plan.Reservation.State.Kind), plan.Reservation.State.FinalizedAt,
		int64(plan.Reservation.State.UsageRevision), string(plan.Reservation.AccountID),
		string(plan.Reservation.VaultID), string(plan.Reservation.ReservationID),
		string(plan.Reservation.Fingerprint), plan.Reservation.CardDelta,
		plan.Reservation.PlaintextByteDelta, int64(plan.Reservation.UsageRevisionAtReservation),
	)
	if err != nil {
		return err
	}
	return RequireOneRow(tag)
}

func lockQuotaUsage(ctx context.Context, transaction pgx.Tx, scope quota.Scope) error {
	var revision int64
	err := transaction.QueryRow(
		ctx,
		`SELECT revision FROM vault_quota_usage
		 WHERE account_id = $1 AND vault_id = $2 FOR UPDATE`,
		string(scope.AccountID), string(scope.VaultID),
	).Scan(&revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrInvalidQuotaRecord
	}
	return err
}

func loadQuotaSnapshot(ctx context.Context, query rowQueryer, scope quota.Scope) (quota.Snapshot, error) {
	return scanQuotaSnapshot(query.QueryRow(
		ctx,
		quotaSnapshotSelect+" WHERE usage.account_id = $1 AND usage.vault_id = $2",
		string(scope.AccountID), string(scope.VaultID),
	))
}

func scanQuotaSnapshot(row rowScanner) (quota.Snapshot, error) {
	var accountID, vaultID string
	var revision, committedCards, committedBytes, reservedCards, reservedBytes int64
	var createdAt, updatedAt int64
	if err := row.Scan(
		&accountID, &vaultID, &revision, &committedCards, &committedBytes,
		&reservedCards, &reservedBytes, &createdAt, &updatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return quota.Snapshot{}, ErrInvalidQuotaRecord
		}
		return quota.Snapshot{}, err
	}
	parsedAccountID, accountErr := identity.ParseAccountID(accountID)
	parsedVaultID, vaultErr := identity.ParseVaultID(vaultID)
	parsedRevision, revisionErr := quota.ParseRevision(revision)
	effectiveCards, cardsOK := quotaUsageSum(committedCards, reservedCards)
	effectiveBytes, bytesOK := quotaUsageSum(committedBytes, reservedBytes)
	snapshot := quota.Snapshot{
		Scope:     quota.Scope{AccountID: parsedAccountID, VaultID: parsedVaultID},
		Revision:  parsedRevision,
		Committed: quota.Usage{ActiveCards: committedCards, PlaintextBytes: committedBytes},
		Reserved:  quota.Usage{ActiveCards: reservedCards, PlaintextBytes: reservedBytes},
		Effective: quota.Usage{ActiveCards: effectiveCards, PlaintextBytes: effectiveBytes},
		CreatedAt: createdAt, UpdatedAt: updatedAt,
	}
	if accountErr != nil || vaultErr != nil || revisionErr != nil || !cardsOK || !bytesOK ||
		!quota.ValidSnapshot(snapshot) {
		return quota.Snapshot{}, ErrInvalidQuotaRecord
	}
	return snapshot, nil
}

func findQuotaReservation(
	ctx context.Context,
	query rowQueryer,
	scope quota.Scope,
	reservationID quota.ReservationID,
	lock bool,
) (*quota.Reservation, error) {
	queryText := quotaReservationSelect +
		" WHERE account_id = $1 AND vault_id = $2 AND reservation_id = $3"
	if lock {
		queryText += " FOR UPDATE"
	}
	reservation, err := scanQuotaReservation(query.QueryRow(
		ctx, queryText, string(scope.AccountID), string(scope.VaultID), string(reservationID),
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !sameQuotaScope(reservation.Scope, scope) {
		return nil, ErrInvalidQuotaRecord
	}
	return &reservation, nil
}

func scanQuotaReservation(row rowScanner) (quota.Reservation, error) {
	var accountID, vaultID, reservationID, fingerprint, cardID, changeKind, state string
	var cardDelta, byteDelta, chargedCardDelta, chargedByteDelta, usageRevision int64
	var createdAt, reconcileAfter int64
	var finalizedAt, finalizedRevision sql.NullInt64
	if err := row.Scan(
		&accountID, &vaultID, &reservationID, &fingerprint, &cardID, &changeKind,
		&cardDelta, &byteDelta, &chargedCardDelta, &chargedByteDelta, &usageRevision,
		&state, &createdAt, &reconcileAfter, &finalizedAt, &finalizedRevision,
	); err != nil {
		return quota.Reservation{}, err
	}
	parsedAccountID, accountErr := identity.ParseAccountID(accountID)
	parsedVaultID, vaultErr := identity.ParseVaultID(vaultID)
	parsedReservationID, reservationErr := quota.ParseReservationID(reservationID)
	parsedFingerprint, fingerprintErr := quota.ParseFingerprint(fingerprint)
	parsedCardID, cardErr := quota.ParseCardID(cardID)
	parsedUsageRevision, usageRevisionErr := quota.ParseRevision(usageRevision)
	reservationState := quota.ReservationState{Kind: quota.ReservationStateKind(state)}
	if state == string(quota.ReservationCommitted) || state == string(quota.ReservationReleased) {
		if !finalizedAt.Valid || !finalizedRevision.Valid {
			return quota.Reservation{}, ErrInvalidQuotaRecord
		}
		parsedFinalizedRevision, err := quota.ParseRevision(finalizedRevision.Int64)
		if err != nil {
			return quota.Reservation{}, ErrInvalidQuotaRecord
		}
		reservationState.FinalizedAt = finalizedAt.Int64
		reservationState.UsageRevision = parsedFinalizedRevision
	} else if finalizedAt.Valid || finalizedRevision.Valid {
		return quota.Reservation{}, ErrInvalidQuotaRecord
	}
	reservation := quota.Reservation{
		Scope:         quota.Scope{AccountID: parsedAccountID, VaultID: parsedVaultID},
		ReservationID: parsedReservationID, Fingerprint: parsedFingerprint, CardID: parsedCardID,
		ChangeKind: quota.ChangeKind(changeKind), CardDelta: cardDelta, PlaintextByteDelta: byteDelta,
		ChargedCardDelta: chargedCardDelta, ChargedPlaintextByteDelta: chargedByteDelta,
		UsageRevisionAtReservation: parsedUsageRevision, State: reservationState,
		CreatedAt: createdAt, ReconcileAfter: reconcileAfter,
	}
	if accountErr != nil || vaultErr != nil || reservationErr != nil || fingerprintErr != nil ||
		cardErr != nil || usageRevisionErr != nil || !quota.ValidReservation(reservation) {
		return quota.Reservation{}, ErrInvalidQuotaRecord
	}
	return reservation, nil
}

type rowQueryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func validQuotaLedger(ledger *QuotaLedger) bool {
	if ledger == nil || ledger.pool == nil {
		return false
	}
	_, accountErr := identity.ParseAccountID(string(ledger.scope.AccountID))
	_, vaultErr := identity.ParseVaultID(string(ledger.scope.VaultID))
	return accountErr == nil && vaultErr == nil
}

func validQuotaTimestamp(value int64) bool {
	return value >= 0 && value <= quota.MaximumSafeInteger
}

func validQuotaReservationID(value quota.ReservationID) bool {
	_, err := quota.ParseReservationID(string(value))
	return err == nil
}

func sameQuotaScope(left, right quota.Scope) bool {
	return left.AccountID == right.AccountID && left.VaultID == right.VaultID
}

func quotaUsageSum(left, right int64) (int64, bool) {
	if left < 0 || right < 0 || left > quota.MaximumSafeInteger-right {
		return 0, false
	}
	return left + right, true
}

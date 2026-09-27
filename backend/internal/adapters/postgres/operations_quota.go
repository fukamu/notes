package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/operations"
	"github.com/fukamu/notes/backend/internal/quota"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrInvalidQuotaAuditOperation = errors.New("invalid quota audit operation")

type QuotaAuditStore struct {
	pool *pgxpool.Pool
}

func NewQuotaAuditStore(pool *pgxpool.Pool) (*QuotaAuditStore, error) {
	if pool == nil {
		return nil, ErrInvalidQuotaAuditOperation
	}
	return &QuotaAuditStore{pool: pool}, nil
}

func (store *QuotaAuditStore) ListQuotaCandidates(
	ctx context.Context,
	query operations.QuotaCandidateQuery,
) (operations.QuotaCandidateLoad, error) {
	if store == nil || store.pool == nil || ctx == nil || operations.ValidateQuotaCandidateQuery(query) != nil {
		return operations.QuotaCandidateLoad{}, ErrInvalidQuotaAuditOperation
	}
	rows, err := store.pool.Query(ctx, `
WITH owner_scope AS (
  SELECT EXISTS(
    SELECT 1
      FROM personal_vaults
     WHERE account_id = $1 AND vault_id = $2
  ) AS owned
)
SELECT owner_scope.owned, candidate.reservation_id, candidate.reconcile_after
  FROM owner_scope
  LEFT JOIN LATERAL (
    SELECT reservation_id, reconcile_after
      FROM vault_quota_reservations
     WHERE account_id = $1 AND vault_id = $2
       AND state = 'reserved' AND reconcile_after <= $3
     ORDER BY reconcile_after, reservation_id
     LIMIT $4
  ) candidate ON owner_scope.owned
 ORDER BY candidate.reconcile_after NULLS LAST, candidate.reservation_id NULLS LAST`,
		string(query.AccountID), string(query.VaultID), query.AsOfMillis, query.Limit,
	)
	if err != nil {
		return operations.QuotaCandidateLoad{}, err
	}
	defer rows.Close()
	loaded := operations.QuotaCandidateLoad{Candidates: make([]operations.QuotaCandidate, 0, query.Limit)}
	rowCount := 0
	for rows.Next() {
		rowCount++
		var owned bool
		var rawReservationID *string
		var reconcileAfter *int64
		if err := rows.Scan(&owned, &rawReservationID, &reconcileAfter); err != nil {
			return operations.QuotaCandidateLoad{}, err
		}
		if rowCount == 1 {
			loaded.Owned = owned
		} else if owned != loaded.Owned {
			return operations.QuotaCandidateLoad{}, ErrInvalidQuotaAuditOperation
		}
		if rawReservationID == nil || reconcileAfter == nil {
			if rawReservationID != nil || reconcileAfter != nil || rowCount != 1 {
				return operations.QuotaCandidateLoad{}, ErrInvalidQuotaAuditOperation
			}
			continue
		}
		reservationID, parseErr := quota.ParseReservationID(*rawReservationID)
		if parseErr != nil {
			return operations.QuotaCandidateLoad{}, ErrInvalidQuotaAuditOperation
		}
		loaded.Candidates = append(loaded.Candidates, operations.QuotaCandidate{
			ReservationID: reservationID, ReconcileAfter: *reconcileAfter,
		})
	}
	if err := rows.Err(); err != nil {
		return operations.QuotaCandidateLoad{}, err
	}
	if rowCount == 0 || (!loaded.Owned && len(loaded.Candidates) != 0) {
		return operations.QuotaCandidateLoad{}, ErrInvalidQuotaAuditOperation
	}
	return loaded, nil
}

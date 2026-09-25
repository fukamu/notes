package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/operations"
	"github.com/fukamu/notes/backend/internal/quota"
	"github.com/fukamu/notes/backend/internal/syncv2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type QuotaCommitStore struct {
	pool *pgxpool.Pool
}

func NewQuotaCommitStore(pool *pgxpool.Pool) (*QuotaCommitStore, error) {
	if pool == nil {
		return nil, ErrInvalidQuotaAuditOperation
	}
	return &QuotaCommitStore{pool: pool}, nil
}

func (store *QuotaCommitStore) InspectQuotaCommit(
	ctx context.Context,
	command operations.QuotaCommitCommand,
) (operations.QuotaCommitEvidence, error) {
	if store == nil || store.pool == nil || ctx == nil || operations.ValidateQuotaCommitCommand(command) != nil {
		return operations.QuotaCommitEvidence{}, ErrInvalidQuotaAuditOperation
	}
	var owned bool
	if err := store.pool.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM personal_vaults WHERE account_id = $1 AND vault_id = $2
	)`, string(command.AccountID), string(command.VaultID)).Scan(&owned); err != nil {
		return operations.QuotaCommitEvidence{}, err
	}
	if !owned {
		return operations.QuotaCommitEvidence{Owned: false}, nil
	}
	scope := quota.Scope{AccountID: command.AccountID, VaultID: command.VaultID}
	reservation, err := findQuotaReservation(ctx, store.pool, scope, command.ReservationID, false)
	if err != nil {
		return operations.QuotaCommitEvidence{}, err
	}
	mutationID, err := syncv2.ParseMutationID(string(command.ReservationID))
	if err != nil {
		return operations.QuotaCommitEvidence{}, ErrInvalidQuotaAuditOperation
	}
	receipt, err := findSyncV2Receipt(ctx, store.pool, syncv2.Scope{
		AccountID: command.AccountID, VaultID: command.VaultID,
	}, mutationID, false)
	if err != nil {
		return operations.QuotaCommitEvidence{}, err
	}
	return operations.QuotaCommitEvidence{
		Owned: true, Reservation: reservation, Receipt: receipt,
	}, nil
}

func (store *QuotaCommitStore) FinalizeQuotaCommit(
	ctx context.Context,
	scope quota.Scope,
	command quota.FinalizationCommand,
) (quota.FinalizationResult, error) {
	if store == nil || store.pool == nil || ctx == nil ||
		command.Outcome != quota.FinalizationCommit ||
		scope.AccountID == "" || scope.VaultID == "" {
		return quota.FinalizationResult{}, ErrInvalidQuotaAuditOperation
	}
	operationCommand := operations.QuotaCommitCommand{
		AccountID: scope.AccountID, VaultID: scope.VaultID,
		ReservationID: command.ReservationID, FinalizedAt: command.FinalizedAt,
	}
	if operations.ValidateQuotaCommitCommand(operationCommand) != nil {
		return quota.FinalizationResult{}, ErrInvalidQuotaAuditOperation
	}
	for attempt := 0; attempt < maximumQuotaTransactionAttempts; attempt++ {
		result := quota.FinalizationResult{
			Kind: quota.FinalizationRejected, Reason: quota.RejectionCASConflict,
		}
		err := WithSerializableTx(ctx, store.pool, func(transaction pgx.Tx) error {
			if err := lockQuotaUsage(ctx, transaction, scope); err != nil {
				return err
			}
			current, err := loadQuotaSnapshot(ctx, transaction, scope)
			if err != nil {
				return err
			}
			reservation, err := findQuotaReservation(
				ctx, transaction, scope, command.ReservationID, true,
			)
			if err != nil {
				return err
			}
			mutationID, err := syncv2.ParseMutationID(string(command.ReservationID))
			if err != nil {
				return ErrInvalidQuotaAuditOperation
			}
			receipt, err := findSyncV2Receipt(ctx, transaction, syncv2.Scope{
				AccountID: scope.AccountID, VaultID: scope.VaultID,
			}, mutationID, true)
			if err != nil {
				return err
			}
			plan := operations.PlanQuotaCommit(operationCommand, operations.QuotaCommitEvidence{
				Owned: true, Reservation: reservation, Receipt: receipt,
			})
			switch plan.Kind {
			case operations.QuotaCommitPlanRefuse:
				return nil
			case operations.QuotaCommitPlanReplay:
				if plan.Reservation == nil {
					return ErrInvalidQuotaAuditOperation
				}
				replayed := *plan.Reservation
				result = quota.FinalizationResult{
					Kind: quota.FinalizationReplayed, Reservation: &replayed, Snapshot: &current,
				}
				return nil
			case operations.QuotaCommitPlanApply:
				if plan.Reservation == nil {
					return ErrInvalidQuotaAuditOperation
				}
			default:
				return ErrInvalidQuotaAuditOperation
			}
			finalization := quota.PlanFinalization(scope, current, *plan.Reservation, command)
			switch finalization.Kind {
			case quota.FinalizationPlanRejected:
				result = quota.FinalizationResult{
					Kind: quota.FinalizationRejected, Reason: finalization.Reason,
				}
				return nil
			case quota.FinalizationPlanReplay:
				replayed := finalization.Reservation
				result = quota.FinalizationResult{
					Kind: quota.FinalizationReplayed, Reservation: &replayed, Snapshot: &current,
				}
				return nil
			case quota.FinalizationPlanApply:
				if err := applyQuotaFinalization(ctx, transaction, finalization); err != nil {
					return err
				}
			default:
				return ErrInvalidQuotaAuditOperation
			}
			nextReservation, err := findQuotaReservation(
				ctx, transaction, scope, command.ReservationID, false,
			)
			if err != nil {
				return err
			}
			if nextReservation == nil || nextReservation.State != finalization.Reservation.State {
				return ErrConcurrentChange
			}
			next, err := loadQuotaSnapshot(ctx, transaction, scope)
			if err != nil {
				return err
			}
			result = quota.FinalizationResult{
				Kind: quota.FinalizationCommitted, Reservation: nextReservation, Snapshot: &next,
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

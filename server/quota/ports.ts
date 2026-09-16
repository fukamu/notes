import type { VaultContext } from '../../lib/domain/identity';
import type { MutationId } from '../../lib/domain/id';
import type {
  VaultQuotaFinalizationCommand,
  VaultQuotaReservation,
  VaultQuotaReservationCommand,
  VaultQuotaSnapshot,
} from './ledger-core';

export type VaultQuotaReservationResult =
  | {
      readonly kind: 'reserved' | 'replayed';
      readonly reservation: VaultQuotaReservation;
      readonly snapshot: VaultQuotaSnapshot;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-input'
        | 'idempotency-key-reuse'
        | 'active-card-limit'
        | 'vault-plaintext-limit'
        | 'cas-conflict';
    };

export type VaultQuotaFinalizationResult =
  | {
      readonly kind: 'committed' | 'released' | 'replayed';
      readonly reservation: VaultQuotaReservation;
      readonly snapshot: VaultQuotaSnapshot;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'not-found'
        | 'invalid-input'
        | 'idempotency-key-reuse'
        | 'invalid-state'
        | 'cas-conflict';
    };

export type VaultQuotaLedger = {
  snapshot(): Promise<VaultQuotaSnapshot>;
  reserve(
    command: VaultQuotaReservationCommand,
  ): Promise<VaultQuotaReservationResult>;
  finalize(
    command: VaultQuotaFinalizationCommand,
  ): Promise<VaultQuotaFinalizationResult>;
  listReconciliationCandidates(input: {
    readonly now: number;
    readonly limit: number;
  }): Promise<readonly VaultQuotaReservation[]>;
  findReservation(
    reservationId: MutationId,
  ): Promise<VaultQuotaReservation | undefined>;
};

export type VaultQuotaLedgerOpenResult =
  | { readonly kind: 'opened'; readonly ledger: VaultQuotaLedger }
  | { readonly kind: 'owner-mismatch' };

export type VaultQuotaLedgerDirectory = {
  open(
    context: VaultContext,
    initializedAt: number,
  ): Promise<VaultQuotaLedgerOpenResult>;
};

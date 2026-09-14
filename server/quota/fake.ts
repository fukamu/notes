import { decodeOrThrow, safeIntegerDecoder } from '../../lib/codec/core';
import type { VaultContext } from '../../lib/domain/identity';
import type { MutationId } from '../../lib/domain/id';
import {
  planVaultQuotaFinalization,
  planVaultQuotaReservation,
  type VaultQuotaFinalizationCommand,
  type VaultQuotaReservation,
  type VaultQuotaReservationCommand,
  type VaultQuotaScope,
  type VaultQuotaSnapshot,
} from './ledger-core';
import type {
  VaultQuotaFinalizationResult,
  VaultQuotaLedger,
  VaultQuotaLedgerDirectory,
  VaultQuotaLedgerOpenResult,
  VaultQuotaReservationResult,
} from './ports';
import { parseActiveCardCount, parseQuotaByteCount } from './core';
import { emptyVaultQuotaSnapshot } from './records';

const timestampDecoder = safeIntegerDecoder({ minimum: 0 });
const reconciliationLimitDecoder = safeIntegerDecoder({
  minimum: 1,
  maximum: 100,
});

type LedgerState = {
  snapshot: VaultQuotaSnapshot;
  readonly reservations: Map<MutationId, VaultQuotaReservation>;
};

export type FakeVaultQuotaLedgerInspection = {
  readonly snapshots: readonly VaultQuotaSnapshot[];
  readonly reservations: readonly VaultQuotaReservation[];
};

export class FakeVaultQuotaLedgerDirectory implements VaultQuotaLedgerDirectory {
  private readonly ownerKeys: ReadonlySet<string>;
  private readonly states = new Map<string, LedgerState>();

  constructor(owners: readonly VaultQuotaScope[]) {
    this.ownerKeys = new Set(owners.map(ownerKey));
  }

  async open(
    context: VaultContext,
    initializedAtInput: number,
  ): Promise<VaultQuotaLedgerOpenResult> {
    const initializedAt = decodeOrThrow(
      timestampDecoder,
      initializedAtInput,
      'Fake Vault quota initialization timestamp',
    );
    const key = ownerKey(context);
    if (!this.ownerKeys.has(key)) return { kind: 'owner-mismatch' };
    if (!this.states.has(key)) {
      this.states.set(key, {
        snapshot: emptyVaultQuotaSnapshot({
          accountId: context.accountId,
          vaultId: context.vaultId,
          initializedAt,
        }),
        reservations: new Map(),
      });
    }
    return {
      kind: 'opened',
      ledger: new FakeVaultQuotaLedger(this.requireState(key)),
    };
  }

  inspect(): FakeVaultQuotaLedgerInspection {
    return {
      snapshots: [...this.states.values()].map((state) => state.snapshot),
      reservations: [...this.states.values()].flatMap((state) => [
        ...state.reservations.values(),
      ]),
    };
  }

  private requireState(key: string): LedgerState {
    const state = this.states.get(key);
    if (state === undefined) throw new Error('Fake quota state is unavailable');
    return state;
  }
}

class FakeVaultQuotaLedger implements VaultQuotaLedger {
  constructor(private readonly state: LedgerState) {}

  async snapshot(): Promise<VaultQuotaSnapshot> {
    return this.state.snapshot;
  }

  async findReservation(
    reservationId: MutationId,
  ): Promise<VaultQuotaReservation | undefined> {
    return this.state.reservations.get(reservationId);
  }

  async reserve(
    command: VaultQuotaReservationCommand,
  ): Promise<VaultQuotaReservationResult> {
    const plan = planVaultQuotaReservation({
      scope: this.state.snapshot,
      current: this.state.snapshot,
      existing: this.state.reservations.get(command.reservationId),
      command,
    });
    if (plan.kind === 'rejected') return plan;
    if (plan.kind === 'replay') {
      return {
        kind: 'replayed',
        reservation: plan.reservation,
        snapshot: this.state.snapshot,
      };
    }
    this.state.reservations.set(
      plan.reservation.reservationId,
      plan.reservation,
    );
    this.state.snapshot = addPendingCharge(
      this.state.snapshot,
      plan.reservation,
    );
    return {
      kind: 'reserved',
      reservation: plan.reservation,
      snapshot: this.state.snapshot,
    };
  }

  async finalize(
    command: VaultQuotaFinalizationCommand,
  ): Promise<VaultQuotaFinalizationResult> {
    const reservation = this.state.reservations.get(command.reservationId);
    if (reservation === undefined) {
      return { kind: 'rejected', reason: 'not-found' };
    }
    const plan = planVaultQuotaFinalization({
      scope: this.state.snapshot,
      current: this.state.snapshot,
      reservation,
      command,
    });
    if (plan.kind === 'rejected') return plan;
    if (plan.kind === 'replay') {
      return {
        kind: 'replayed',
        reservation: plan.reservation,
        snapshot: this.state.snapshot,
      };
    }
    this.state.snapshot = plan.next;
    this.state.reservations.set(command.reservationId, plan.reservation);
    return {
      kind: command.outcome === 'commit' ? 'committed' : 'released',
      reservation: plan.reservation,
      snapshot: plan.next,
    };
  }

  async listReconciliationCandidates(input: {
    readonly now: number;
    readonly limit: number;
  }): Promise<readonly VaultQuotaReservation[]> {
    const now = decodeOrThrow(
      timestampDecoder,
      input.now,
      'Fake quota reconcile now',
    );
    const limit = decodeOrThrow(
      reconciliationLimitDecoder,
      input.limit,
      'Fake quota reconcile limit',
    );
    return [...this.state.reservations.values()]
      .filter(
        (reservation) =>
          reservation.state.kind === 'reserved' &&
          reservation.reconcileAfter <= now,
      )
      .sort(
        (left, right) =>
          left.reconcileAfter - right.reconcileAfter ||
          left.reservationId.localeCompare(right.reservationId),
      )
      .slice(0, limit);
  }
}

function addPendingCharge(
  snapshot: VaultQuotaSnapshot,
  reservation: VaultQuotaReservation,
): VaultQuotaSnapshot {
  const reserved = {
    activeCards: parseActiveCardCount(
      snapshot.reserved.activeCards + reservation.chargedCardDelta,
    ),
    plaintextBytes: parseQuotaByteCount(
      snapshot.reserved.plaintextBytes + reservation.chargedPlaintextByteDelta,
    ),
  };
  return {
    ...snapshot,
    reserved,
    effective: {
      activeCards: parseActiveCardCount(
        snapshot.committed.activeCards + reserved.activeCards,
      ),
      plaintextBytes: parseQuotaByteCount(
        snapshot.committed.plaintextBytes + reserved.plaintextBytes,
      ),
    },
  };
}

function ownerKey(scope: VaultQuotaScope): string {
  return `${scope.accountId}\u0000${scope.vaultId}`;
}

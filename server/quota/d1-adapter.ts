import {
  decodeOrThrow,
  objectDecoder,
  safeIntegerDecoder,
} from '../../lib/codec/core';
import { accountIdDecoder, vaultIdDecoder } from '../../lib/domain/identity';
import type { VaultContext } from '../../lib/domain/identity';
import type { MutationId } from '../../lib/domain/id';
import type { D1DatabaseBinding } from '../../db/d1-types';
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
import {
  mapVaultQuotaReservationRow,
  mapVaultQuotaSnapshotRow,
  vaultQuotaReservationRowDecoder,
  vaultQuotaReservationRowsDecoder,
  vaultQuotaSnapshotRowDecoder,
} from './records';

const maximumCasAttempts = 3;
const maximumReconciliationPageSize = 100;
const ownerDecoder = objectDecoder({
  account_id: accountIdDecoder,
  vault_id: vaultIdDecoder,
});
const timestampDecoder = safeIntegerDecoder({ minimum: 0 });
const pendingCardDelta = `(SELECT COALESCE(SUM(pending.charged_card_delta), 0)
  FROM vault_quota_reservations pending
  WHERE pending.account_id = usage.account_id
    AND pending.vault_id = usage.vault_id
    AND pending.state = 'reserved')`;
const pendingPlaintextDelta = `(SELECT COALESCE(SUM(pending.charged_plaintext_byte_delta), 0)
  FROM vault_quota_reservations pending
  WHERE pending.account_id = usage.account_id
    AND pending.vault_id = usage.vault_id
    AND pending.state = 'reserved')`;
const snapshotColumns = `usage.account_id AS account_id,
  usage.vault_id AS vault_id, usage.revision AS revision,
  usage.active_cards AS committed_active_cards,
  usage.plaintext_bytes AS committed_plaintext_bytes,
  ${pendingCardDelta} AS reserved_active_cards,
  ${pendingPlaintextDelta} AS reserved_plaintext_bytes,
  usage.active_cards + ${pendingCardDelta} AS effective_active_cards,
  usage.plaintext_bytes + ${pendingPlaintextDelta} AS effective_plaintext_bytes,
  usage.created_at AS created_at, usage.updated_at AS updated_at`;
const reservationColumns = `account_id, vault_id, reservation_id,
  fingerprint, card_id, change_kind, card_delta, plaintext_byte_delta,
  charged_card_delta, charged_plaintext_byte_delta,
  usage_revision_at_reservation, state, created_at, reconcile_after,
  finalized_at, finalized_usage_revision`;

export class D1VaultQuotaLedgerDirectory implements VaultQuotaLedgerDirectory {
  constructor(private readonly database: D1DatabaseBinding) {}

  async open(
    context: VaultContext,
    initializedAtInput: number,
  ): Promise<VaultQuotaLedgerOpenResult> {
    const initializedAt = decodeOrThrow(
      timestampDecoder,
      initializedAtInput,
      'Vault quota initialization timestamp',
    );
    const rawOwner: unknown = await this.database
      .prepare(
        `SELECT account_id, vault_id FROM personal_vaults
         WHERE account_id = ? AND vault_id = ?`,
      )
      .bind(context.accountId, context.vaultId)
      .first();
    if (rawOwner === null) return { kind: 'owner-mismatch' };
    const owner = decodeOrThrow(ownerDecoder, rawOwner, 'D1 Vault quota owner');
    if (
      owner.account_id !== context.accountId ||
      owner.vault_id !== context.vaultId
    ) {
      return { kind: 'owner-mismatch' };
    }
    await this.database
      .prepare(
        `INSERT INTO vault_quota_usage(
          account_id, vault_id, revision, active_cards, plaintext_bytes,
          last_transition_reservation_id, created_at, updated_at
        ) VALUES (?, ?, 1, 0, 0, NULL, ?, ?)
        ON CONFLICT(account_id, vault_id) DO NOTHING`,
      )
      .bind(context.accountId, context.vaultId, initializedAt, initializedAt)
      .run();
    return {
      kind: 'opened',
      ledger: new D1VaultQuotaLedger(this.database, {
        accountId: context.accountId,
        vaultId: context.vaultId,
      }),
    };
  }
}

export class D1VaultQuotaLedger implements VaultQuotaLedger {
  constructor(
    private readonly database: D1DatabaseBinding,
    private readonly scope: VaultQuotaScope,
  ) {}

  async snapshot(): Promise<VaultQuotaSnapshot> {
    const raw: unknown = await this.database
      .prepare(
        `SELECT ${snapshotColumns} FROM vault_quota_usage usage
         WHERE usage.account_id = ? AND usage.vault_id = ?`,
      )
      .bind(this.scope.accountId, this.scope.vaultId)
      .first();
    if (raw === null) throw new VaultQuotaIntegrityError();
    return mapVaultQuotaSnapshotRow(
      decodeOrThrow(
        vaultQuotaSnapshotRowDecoder,
        raw,
        'D1 Vault quota snapshot row',
      ),
    );
  }

  async findReservation(
    reservationId: MutationId,
  ): Promise<VaultQuotaReservation | undefined> {
    const raw: unknown = await this.database
      .prepare(
        `SELECT ${reservationColumns} FROM vault_quota_reservations
         WHERE account_id = ? AND vault_id = ? AND reservation_id = ?`,
      )
      .bind(this.scope.accountId, this.scope.vaultId, reservationId)
      .first();
    return raw === null
      ? undefined
      : mapVaultQuotaReservationRow(
          decodeOrThrow(
            vaultQuotaReservationRowDecoder,
            raw,
            'D1 Vault quota reservation row',
          ),
        );
  }

  async reserve(
    command: VaultQuotaReservationCommand,
  ): Promise<VaultQuotaReservationResult> {
    for (let attempt = 0; attempt < maximumCasAttempts; attempt += 1) {
      const [current, existing] = await Promise.all([
        this.snapshot(),
        this.findReservation(command.reservationId),
      ]);
      const plan = planVaultQuotaReservation({
        scope: this.scope,
        current,
        existing,
        command,
      });
      if (plan.kind === 'rejected') return plan;
      if (plan.kind === 'replay') {
        return {
          kind: 'replayed',
          reservation: plan.reservation,
          snapshot: current,
        };
      }
      const inserted = await this.insertReservation(
        plan.current,
        plan.reservation,
        command,
      );
      if (inserted) {
        const [reservation, snapshot] = await Promise.all([
          this.findReservation(command.reservationId),
          this.snapshot(),
        ]);
        if (reservation === undefined) throw new VaultQuotaIntegrityError();
        return { kind: 'reserved', reservation, snapshot };
      }
    }
    return { kind: 'rejected', reason: 'cas-conflict' };
  }

  async finalize(
    command: VaultQuotaFinalizationCommand,
  ): Promise<VaultQuotaFinalizationResult> {
    for (let attempt = 0; attempt < maximumCasAttempts; attempt += 1) {
      const [current, reservation] = await Promise.all([
        this.snapshot(),
        this.findReservation(command.reservationId),
      ]);
      if (reservation === undefined) {
        return { kind: 'rejected', reason: 'not-found' };
      }
      const plan = planVaultQuotaFinalization({
        scope: this.scope,
        current,
        reservation,
        command,
      });
      if (plan.kind === 'rejected') return plan;
      if (plan.kind === 'replay') {
        return {
          kind: 'replayed',
          reservation: plan.reservation,
          snapshot: current,
        };
      }
      const state = command.outcome === 'commit' ? 'committed' : 'released';
      await this.database
        .prepare(
          `UPDATE vault_quota_reservations SET
            state = ?, finalized_at = ?, finalized_usage_revision = ?
           WHERE account_id = ? AND vault_id = ? AND reservation_id = ?
             AND fingerprint = ? AND state = 'reserved'`,
        )
        .bind(
          state,
          command.finalizedAt,
          plan.next.revision,
          this.scope.accountId,
          this.scope.vaultId,
          command.reservationId,
          command.fingerprint,
        )
        .run();
      const [nextReservation, snapshot] = await Promise.all([
        this.findReservation(command.reservationId),
        this.snapshot(),
      ]);
      if (nextReservation === undefined) throw new VaultQuotaIntegrityError();
      if (
        nextReservation.state.kind === state &&
        nextReservation.state.finalizedAt === command.finalizedAt &&
        nextReservation.state.usageRevision === plan.next.revision
      ) {
        return {
          kind: state,
          reservation: nextReservation,
          snapshot,
        };
      }
    }
    return { kind: 'rejected', reason: 'cas-conflict' };
  }

  async listReconciliationCandidates(input: {
    readonly now: number;
    readonly limit: number;
  }): Promise<readonly VaultQuotaReservation[]> {
    const now = decodeOrThrow(
      timestampDecoder,
      input.now,
      'quota reconcile now',
    );
    const limit = decodeOrThrow(
      safeIntegerDecoder({
        minimum: 1,
        maximum: maximumReconciliationPageSize,
      }),
      input.limit,
      'quota reconcile limit',
    );
    const raw: unknown = await this.database
      .prepare(
        `SELECT ${reservationColumns} FROM vault_quota_reservations
         WHERE account_id = ? AND vault_id = ? AND state = 'reserved'
           AND reconcile_after <= ?
         ORDER BY reconcile_after ASC, reservation_id ASC LIMIT ?`,
      )
      .bind(this.scope.accountId, this.scope.vaultId, now, limit)
      .all();
    const decoded = decodeOrThrow(
      vaultQuotaReservationRowsDecoder,
      raw,
      'D1 Vault quota reconciliation rows',
    );
    return decoded.results.map(mapVaultQuotaReservationRow);
  }

  private async insertReservation(
    current: VaultQuotaSnapshot,
    reservation: VaultQuotaReservation,
    command: VaultQuotaReservationCommand,
  ): Promise<boolean> {
    const result = await this.database
      .prepare(
        `INSERT INTO vault_quota_reservations(${reservationColumns})
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, NULL, NULL
         FROM vault_quota_usage usage
         WHERE usage.account_id = ? AND usage.vault_id = ?
           AND usage.revision = ?
           AND usage.active_cards = ? AND usage.plaintext_bytes = ?
           AND usage.active_cards + ${pendingCardDelta} = ?
           AND usage.plaintext_bytes + ${pendingPlaintextDelta} = ?
           AND usage.active_cards + ${pendingCardDelta} + ? <= ?
           AND usage.plaintext_bytes + ${pendingPlaintextDelta} + ? <= ?
         ON CONFLICT(account_id, vault_id, reservation_id) DO NOTHING`,
      )
      .bind(
        this.scope.accountId,
        this.scope.vaultId,
        reservation.reservationId,
        reservation.fingerprint,
        reservation.cardId,
        reservation.changeKind,
        reservation.cardDelta,
        reservation.plaintextByteDelta,
        reservation.chargedCardDelta,
        reservation.chargedPlaintextByteDelta,
        reservation.usageRevisionAtReservation,
        reservation.createdAt,
        reservation.reconcileAfter,
        this.scope.accountId,
        this.scope.vaultId,
        current.revision,
        current.committed.activeCards,
        current.committed.plaintextBytes,
        current.effective.activeCards,
        current.effective.plaintextBytes,
        reservation.chargedCardDelta,
        command.limits.activeCards,
        reservation.chargedPlaintextByteDelta,
        command.limits.plaintextBytesPerVault,
      )
      .run();
    return result.meta.changes === 1;
  }
}

export class VaultQuotaIntegrityError extends Error {
  constructor() {
    super('Vault quota ledger integrity validation failed');
    this.name = 'VaultQuotaIntegrityError';
  }
}

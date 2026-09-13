import {
  arrayDecoder,
  decodeOrThrow,
  objectDecoder,
  safeIntegerDecoder,
} from '../../lib/codec/core';
import type { VaultContext } from '../../lib/domain/identity';
import type { CardId, ConflictId, MutationId } from '../../lib/domain/id';
import type { D1DatabaseBinding } from '../../db/d1-types';
import type { IdentityVaultControlPlane } from '../control-plane/public';
import {
  evaluateVaultLiveDataPurge,
  planCardCompareAndSwap,
  planPartitionAssignment,
  planPartitionCompareAndSwap,
} from './core';
import type {
  CardCompareAndSwap,
  ConflictIndexWrite,
  MutationReceiptWrite,
  PartitionAssignment,
  PartitionCommandResult,
  PartitionCompareAndSwap,
  ScopedWriteResult,
  VaultContentDirectory,
  VaultLiveDataPurgePort,
  VaultLiveDataPurgeResult,
  VaultLiveDataPurgeScope,
  VaultContentRepository,
  VaultRepositoryOpenResult,
} from './public';
import {
  cardIndexRowDecoder,
  conflictIndexRowDecoder,
  mapCardIndexRow,
  mapConflictIndexRow,
  mapMutationReceiptRow,
  mapPartitionRouteRow,
  mutationReceiptRowDecoder,
  partitionRouteRowDecoder,
  type ContentRevision,
  type VaultCardIndexRecord,
  type VaultConflictIndexRecord,
  type VaultMutationReceiptRecord,
  type VaultPartitionRoute,
} from './records';

const maximumCardsPerVaultBoundary = 10_000;
const cardListResultDecoder = objectDecoder(
  {
    results: arrayDecoder(cardIndexRowDecoder, {
      maxLength: maximumCardsPerVaultBoundary,
    }),
  },
  { unknownFields: 'allow' },
);
const liveDataCountsDecoder = objectDecoder(
  {
    routes: safeIntegerDecoder({ minimum: 0 }),
    cards: safeIntegerDecoder({ minimum: 0 }),
    mutation_receipts: safeIntegerDecoder({ minimum: 0 }),
    conflicts: safeIntegerDecoder({ minimum: 0 }),
    sync_states: safeIntegerDecoder({ minimum: 0 }),
    display_ids: safeIntegerDecoder({ minimum: 0 }),
    sync_commits: safeIntegerDecoder({ minimum: 0 }),
    sync_changes: safeIntegerDecoder({ minimum: 0 }),
    encrypted_objects: safeIntegerDecoder({ minimum: 0 }),
    encrypted_write_intents: safeIntegerDecoder({ minimum: 0 }),
  },
  { unknownFields: 'allow' },
);

export class D1VaultContentDirectory
  implements VaultContentDirectory, VaultLiveDataPurgePort
{
  constructor(
    private readonly database: D1DatabaseBinding,
    private readonly controlPlane: IdentityVaultControlPlane,
  ) {}

  async assignPartition(
    context: VaultContext,
    assignment: PartitionAssignment,
  ): Promise<PartitionCommandResult> {
    const owner = await this.readOwner(context);
    const plan = planPartitionAssignment(context, owner, assignment);
    if (plan.kind === 'rejected') return { kind: 'not-applied' };
    const result = await this.database
      .prepare(
        `INSERT INTO vault_partition_mappings(
          vault_id, account_id, partition_id, routing_revision, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(vault_id) DO NOTHING`,
      )
      .bind(
        context.vaultId,
        context.accountId,
        plan.route.partitionId,
        plan.route.routingRevision,
        plan.route.updatedAt,
      )
      .run();
    return result.meta.changes === 1
      ? { kind: 'applied', route: plan.route }
      : { kind: 'not-applied' };
  }

  async compareAndSwapPartition(
    context: VaultContext,
    command: PartitionCompareAndSwap,
  ): Promise<PartitionCommandResult> {
    if ((await this.readOwner(context)) === undefined) {
      return { kind: 'not-applied' };
    }
    const current = await this.readRoute(context);
    if (current === undefined) return { kind: 'not-applied' };
    const plan = planPartitionCompareAndSwap(current, command);
    if (plan.kind === 'rejected') return { kind: 'not-applied' };
    const result = await this.database
      .prepare(
        `UPDATE vault_partition_mappings
         SET partition_id = ?, routing_revision = ?, updated_at = ?
         WHERE account_id = ? AND vault_id = ? AND routing_revision = ?`,
      )
      .bind(
        plan.route.partitionId,
        plan.route.routingRevision,
        plan.route.updatedAt,
        context.accountId,
        context.vaultId,
        command.expectedRoutingRevision,
      )
      .run();
    return result.meta.changes === 1
      ? { kind: 'applied', route: plan.route }
      : { kind: 'not-applied' };
  }

  async open(context: VaultContext): Promise<VaultRepositoryOpenResult> {
    if ((await this.readOwner(context)) === undefined) {
      return { kind: 'not-found' };
    }
    const route = await this.readRoute(context);
    return route === undefined
      ? { kind: 'not-found' }
      : {
          kind: 'opened',
          route,
          repository: new D1ScopedVaultContentRepository(
            this.database,
            context,
            route,
          ),
        };
  }

  async purgeVaultLiveData(
    scope: VaultLiveDataPurgeScope,
  ): Promise<VaultLiveDataPurgeResult> {
    if ((await this.readOwner(scope)) === undefined) {
      return evaluateVaultLiveDataPurge({
        ownerMatches: false,
        routePresentBefore: false,
        remaining: emptyLiveDataCounts(),
      });
    }

    const before = await this.readLiveDataCounts(scope);
    if (
      before.encrypted_objects !== 0 ||
      before.encrypted_write_intents !== 0
    ) {
      return evaluateVaultLiveDataPurge({
        ownerMatches: true,
        routePresentBefore: before.routes === 1,
        remaining: {
          routes: before.routes,
          cards: before.cards,
          mutationReceipts: before.mutation_receipts,
          conflicts: before.conflicts,
          syncStates: before.sync_states,
          displayIds: before.display_ids,
          syncCommits: before.sync_commits,
          syncChanges: before.sync_changes,
          encryptedObjects: before.encrypted_objects,
          encryptedWriteIntents: before.encrypted_write_intents,
        },
      });
    }

    await this.database
      .prepare(
        `DELETE FROM vault_partition_mappings
         WHERE account_id = ? AND vault_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM vault_encrypted_objects stored
             WHERE stored.vault_id = vault_partition_mappings.vault_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM vault_encrypted_write_intents pending
             WHERE pending.vault_id = vault_partition_mappings.vault_id
           )`,
      )
      .bind(scope.accountId, scope.vaultId)
      .run();
    const remaining = await this.readLiveDataCounts(scope);
    return evaluateVaultLiveDataPurge({
      ownerMatches: true,
      routePresentBefore: before.routes === 1,
      remaining: {
        routes: remaining.routes,
        cards: remaining.cards,
        mutationReceipts: remaining.mutation_receipts,
        conflicts: remaining.conflicts,
        syncStates: remaining.sync_states,
        displayIds: remaining.display_ids,
        syncCommits: remaining.sync_commits,
        syncChanges: remaining.sync_changes,
        encryptedObjects: remaining.encrypted_objects,
        encryptedWriteIntents: remaining.encrypted_write_intents,
      },
    });
  }

  private async readRoute(
    context: VaultContext,
  ): Promise<VaultPartitionRoute | undefined> {
    const input: unknown = await this.database
      .prepare(
        `SELECT partition_id, routing_revision, updated_at
         FROM vault_partition_mappings
         WHERE account_id = ? AND vault_id = ?`,
      )
      .bind(context.accountId, context.vaultId)
      .first();
    return input === null
      ? undefined
      : mapPartitionRouteRow(
          decodeOrThrow(
            partitionRouteRowDecoder,
            input,
            'D1 Vault partition route row',
          ),
        );
  }

  private async readOwner(context: VaultLiveDataPurgeScope) {
    const account = await this.controlPlane.findPersonalAccount(
      context.accountId,
    );
    if (
      account === undefined ||
      account.account.accountId !== context.accountId ||
      account.vault.vaultId !== context.vaultId
    ) {
      return undefined;
    }
    return {
      accountId: account.account.accountId,
      vaultId: account.vault.vaultId,
    };
  }

  private async readLiveDataCounts(scope: VaultLiveDataPurgeScope) {
    const raw: unknown = await this.database
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM vault_partition_mappings WHERE vault_id = ?) AS routes,
          (SELECT COUNT(*) FROM vault_cards WHERE vault_id = ?) AS cards,
          (SELECT COUNT(*) FROM vault_mutation_receipts WHERE vault_id = ?) AS mutation_receipts,
          (SELECT COUNT(*) FROM vault_conflicts WHERE vault_id = ?) AS conflicts,
          (SELECT COUNT(*) FROM vault_sync_v2_states WHERE vault_id = ?) AS sync_states,
          (SELECT COUNT(*) FROM vault_card_display_ids WHERE vault_id = ?) AS display_ids,
          (SELECT COUNT(*) FROM vault_sync_v2_commits WHERE vault_id = ?) AS sync_commits,
          (SELECT COUNT(*) FROM vault_sync_v2_changes WHERE vault_id = ?) AS sync_changes,
          (SELECT COUNT(*) FROM vault_encrypted_objects WHERE vault_id = ?) AS encrypted_objects,
          (SELECT COUNT(*) FROM vault_encrypted_write_intents WHERE vault_id = ?) AS encrypted_write_intents`,
      )
      .bind(
        scope.vaultId,
        scope.vaultId,
        scope.vaultId,
        scope.vaultId,
        scope.vaultId,
        scope.vaultId,
        scope.vaultId,
        scope.vaultId,
        scope.vaultId,
        scope.vaultId,
      )
      .first();
    return decodeOrThrow(
      liveDataCountsDecoder,
      raw,
      'D1 Vault live data counts',
    );
  }
}

class D1ScopedVaultContentRepository implements VaultContentRepository {
  constructor(
    private readonly database: D1DatabaseBinding,
    private readonly context: VaultContext,
    private readonly route: VaultPartitionRoute,
  ) {}

  async findCard(cardId: CardId): Promise<VaultCardIndexRecord | undefined> {
    const input: unknown = await this.database
      .prepare(
        `SELECT card_id, revision, updated_at
         FROM vault_cards card
         WHERE card.vault_id = ? AND card.card_id = ?
           AND ${routeGuard('card.vault_id')}`,
      )
      .bind(this.context.vaultId, cardId, ...this.routeGuardBindings())
      .first();
    return input === null
      ? undefined
      : mapCardIndexRow(
          decodeOrThrow(cardIndexRowDecoder, input, 'D1 Vault card index row'),
        );
  }

  async listCards(): Promise<readonly VaultCardIndexRecord[]> {
    const input: unknown = await this.database
      .prepare(
        `SELECT card_id, revision, updated_at
         FROM vault_cards card
         WHERE card.vault_id = ? AND ${routeGuard('card.vault_id')}
         ORDER BY card_id ASC`,
      )
      .bind(this.context.vaultId, ...this.routeGuardBindings())
      .all();
    return decodeOrThrow(
      cardListResultDecoder,
      input,
      'D1 Vault card index results',
    ).results.map(mapCardIndexRow);
  }

  async compareAndSwapCard(
    command: CardCompareAndSwap,
  ): Promise<ScopedWriteResult> {
    const current = await this.findCard(command.cardId);
    const plan = planCardCompareAndSwap(current, command);
    if (plan.kind === 'rejected') return { kind: 'not-applied' };
    const result =
      plan.operation === 'insert'
        ? await this.database
            .prepare(
              `INSERT INTO vault_cards(vault_id, card_id, revision, updated_at)
               SELECT ?, ?, ?, ? WHERE ${routeGuard('?')}
               ON CONFLICT(vault_id, card_id) DO NOTHING`,
            )
            .bind(
              this.context.vaultId,
              plan.record.cardId,
              plan.record.revision,
              plan.record.updatedAt,
              ...this.insertRouteGuardBindings(),
            )
            .run()
        : await this.database
            .prepare(
              `UPDATE vault_cards
               SET revision = ?, updated_at = ?
               WHERE vault_id = ? AND card_id = ? AND revision = ?
                 AND ${routeGuard('vault_cards.vault_id')}`,
            )
            .bind(
              plan.record.revision,
              plan.record.updatedAt,
              this.context.vaultId,
              plan.record.cardId,
              command.expectedRevision,
              ...this.routeGuardBindings(),
            )
            .run();
    return writeResult(result.meta.changes);
  }

  async deleteCard(
    cardId: CardId,
    expectedRevision: ContentRevision,
  ): Promise<ScopedWriteResult> {
    const result = await this.database
      .prepare(
        `DELETE FROM vault_cards
         WHERE vault_id = ? AND card_id = ? AND revision = ?
           AND ${routeGuard('vault_cards.vault_id')}`,
      )
      .bind(
        this.context.vaultId,
        cardId,
        expectedRevision,
        ...this.routeGuardBindings(),
      )
      .run();
    return writeResult(result.meta.changes);
  }

  async findMutationReceipt(
    mutationId: MutationId,
  ): Promise<VaultMutationReceiptRecord | undefined> {
    const input: unknown = await this.database
      .prepare(
        `SELECT mutation_id, card_id, applied_revision, created_at
         FROM vault_mutation_receipts receipt
         WHERE receipt.vault_id = ? AND receipt.mutation_id = ?
           AND ${routeGuard('receipt.vault_id')}`,
      )
      .bind(this.context.vaultId, mutationId, ...this.routeGuardBindings())
      .first();
    return input === null
      ? undefined
      : mapMutationReceiptRow(
          decodeOrThrow(
            mutationReceiptRowDecoder,
            input,
            'D1 Vault mutation receipt row',
          ),
        );
  }

  async recordMutationReceipt(
    receipt: MutationReceiptWrite,
  ): Promise<ScopedWriteResult> {
    const result = await this.database
      .prepare(
        `INSERT INTO vault_mutation_receipts(
          vault_id, mutation_id, card_id, applied_revision, created_at
        )
        SELECT ?, ?, ?, ?, ?
        WHERE ${routeGuard('?')}
          AND EXISTS (
            SELECT 1 FROM vault_cards card
            WHERE card.vault_id = ? AND card.card_id = ? AND card.revision = ?
          )
        ON CONFLICT(vault_id, mutation_id) DO NOTHING`,
      )
      .bind(
        this.context.vaultId,
        receipt.mutationId,
        receipt.cardId,
        receipt.appliedRevision,
        receipt.createdAt,
        ...this.insertRouteGuardBindings(),
        this.context.vaultId,
        receipt.cardId,
        receipt.appliedRevision,
      )
      .run();
    return writeResult(result.meta.changes);
  }

  async findConflict(
    conflictId: ConflictId,
  ): Promise<VaultConflictIndexRecord | undefined> {
    const input: unknown = await this.database
      .prepare(
        `SELECT conflict_id, card_id, server_revision, created_at
         FROM vault_conflicts entry
         WHERE entry.vault_id = ? AND entry.conflict_id = ?
           AND ${routeGuard('entry.vault_id')}`,
      )
      .bind(this.context.vaultId, conflictId, ...this.routeGuardBindings())
      .first();
    return input === null
      ? undefined
      : mapConflictIndexRow(
          decodeOrThrow(
            conflictIndexRowDecoder,
            input,
            'D1 Vault conflict index row',
          ),
        );
  }

  async recordConflict(
    conflict: ConflictIndexWrite,
  ): Promise<ScopedWriteResult> {
    const result = await this.database
      .prepare(
        `INSERT INTO vault_conflicts(
          vault_id, conflict_id, card_id, server_revision, created_at
        )
        SELECT ?, ?, ?, ?, ?
        WHERE ${routeGuard('?')}
          AND EXISTS (
            SELECT 1 FROM vault_cards card
            WHERE card.vault_id = ? AND card.card_id = ?
          )
        ON CONFLICT(vault_id, conflict_id) DO NOTHING`,
      )
      .bind(
        this.context.vaultId,
        conflict.conflictId,
        conflict.cardId,
        conflict.serverRevision,
        conflict.createdAt,
        ...this.insertRouteGuardBindings(),
        this.context.vaultId,
        conflict.cardId,
      )
      .run();
    return writeResult(result.meta.changes);
  }

  async deleteConflict(
    conflictId: ConflictId,
    expectedServerRevision: ContentRevision,
  ): Promise<ScopedWriteResult> {
    const result = await this.database
      .prepare(
        `DELETE FROM vault_conflicts
         WHERE vault_id = ? AND conflict_id = ? AND server_revision = ?
           AND ${routeGuard('vault_conflicts.vault_id')}`,
      )
      .bind(
        this.context.vaultId,
        conflictId,
        expectedServerRevision,
        ...this.routeGuardBindings(),
      )
      .run();
    return writeResult(result.meta.changes);
  }

  private routeGuardBindings(): readonly [string, string, string, number] {
    return [
      this.context.accountId,
      this.context.vaultId,
      this.route.partitionId,
      this.route.routingRevision,
    ];
  }

  private insertRouteGuardBindings(): readonly [
    string,
    string,
    string,
    string,
    number,
  ] {
    return [
      this.context.accountId,
      this.context.vaultId,
      this.context.vaultId,
      this.route.partitionId,
      this.route.routingRevision,
    ];
  }
}

function routeGuard(vaultExpression: string): string {
  return `EXISTS (
    SELECT 1 FROM vault_partition_mappings route
    WHERE route.account_id = ? AND route.vault_id = ?
      AND route.vault_id = ${vaultExpression}
      AND route.partition_id = ? AND route.routing_revision = ?
  )`;
}

function writeResult(changes: number): ScopedWriteResult {
  return changes > 0 ? { kind: 'applied' } : { kind: 'not-applied' };
}

function emptyLiveDataCounts() {
  return {
    routes: 0,
    cards: 0,
    mutationReceipts: 0,
    conflicts: 0,
    syncStates: 0,
    displayIds: 0,
    syncCommits: 0,
    syncChanges: 0,
    encryptedObjects: 0,
    encryptedWriteIntents: 0,
  } as const;
}

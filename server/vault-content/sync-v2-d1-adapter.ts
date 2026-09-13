import {
  arrayDecoder,
  BoundaryDecodeError,
  decodeOrThrow,
  objectDecoder,
  safeIntegerDecoder,
} from '../../lib/codec/core';
import type { VaultContext } from '../../lib/domain/identity';
import type { CardId, ConflictId } from '../../lib/domain/id';
import { assertNever } from '../../lib/shared/invariant';
import {
  parseSyncSequence,
  SYNC_V2_LIMITS,
  type SyncSequence,
} from '../../lib/sync/v2-protocol';
import type { D1DatabaseBinding } from '../../db/d1-types';
import {
  planSyncV2JournalCommit,
  planSyncV2JournalPage,
  type SyncV2JournalSnapshot,
  type SyncV2JournalState,
} from './sync-v2-core';
import {
  conflictIndexRowDecoder,
  mapConflictIndexRow,
  type VaultConflictIndexRecord,
  type VaultPartitionRoute,
} from './records';
import type { VaultContentDirectory } from './public';
import type {
  SyncV2JournalChange,
  SyncV2JournalCommit,
  SyncV2JournalCommitResult,
  SyncV2JournalDirectory,
  SyncV2JournalOpenResult,
  SyncV2JournalPage,
  SyncV2JournalRepository,
} from './sync-v2-public';
import {
  mapSyncV2CardHeadRow,
  mapSyncV2JournalChangeRow,
  mapSyncV2JournalReceiptRow,
  mapSyncV2JournalStateRow,
  syncV2CardHeadRowDecoder,
  syncV2JournalChangeRowDecoder,
  syncV2JournalReceiptRowDecoder,
  syncV2JournalStateRowDecoder,
} from './sync-v2-records';

const conflictBoundary = 100_000;
const pageLimitDecoder = safeIntegerDecoder({
  minimum: 1,
  maximum: SYNC_V2_LIMITS.changesPerPage,
});
const selectedConflictResultsDecoder = objectDecoder(
  {
    results: arrayDecoder(conflictIndexRowDecoder, {
      maxLength: SYNC_V2_LIMITS.changesPerPage,
      uniqueBy: (row) => row.conflict_id,
    }),
  },
  { unknownFields: 'allow' },
);
const allConflictResultsDecoder = objectDecoder(
  {
    results: arrayDecoder(conflictIndexRowDecoder, {
      maxLength: conflictBoundary,
      uniqueBy: (row) => row.conflict_id,
    }),
  },
  { unknownFields: 'allow' },
);
const changeResultsDecoder = objectDecoder(
  {
    results: arrayDecoder(syncV2JournalChangeRowDecoder, {
      maxLength: SYNC_V2_LIMITS.changesPerPage + 1,
      uniqueBy: (row) => row.sequence,
    }),
  },
  { unknownFields: 'allow' },
);

export class D1SyncV2JournalDirectory implements SyncV2JournalDirectory {
  constructor(
    private readonly database: D1DatabaseBinding,
    private readonly vaultContent: VaultContentDirectory,
  ) {}

  async open(context: VaultContext): Promise<SyncV2JournalOpenResult> {
    const scope = await this.vaultContent.open(context);
    if (scope.kind === 'not-found') return scope;
    const repository = new D1ScopedSyncV2JournalRepository(
      this.database,
      context,
      scope.route,
    );
    await repository.initialize();
    return { kind: 'opened', route: scope.route, repository };
  }
}

class D1ScopedSyncV2JournalRepository implements SyncV2JournalRepository {
  constructor(
    private readonly database: D1DatabaseBinding,
    private readonly context: VaultContext,
    private readonly route: VaultPartitionRoute,
  ) {}

  async initialize(): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO vault_sync_v2_states(
          vault_id, next_display_id, next_change_sequence
        )
        SELECT ?, 1, 1 WHERE ${routeGuard('?')}
        ON CONFLICT(vault_id) DO NOTHING`,
      )
      .bind(this.context.vaultId, ...this.insertRouteGuardBindings())
      .run();
  }

  async findCard(cardId: CardId) {
    const input: unknown = await this.database
      .prepare(
        `SELECT card.card_id, display.official_display_id,
          card.revision, card.updated_at
         FROM vault_cards card
         INNER JOIN vault_card_display_ids display
           ON display.vault_id = card.vault_id AND display.card_id = card.card_id
         WHERE card.vault_id = ? AND card.card_id = ?
           AND ${routeGuard('card.vault_id')}`,
      )
      .bind(this.context.vaultId, cardId, ...this.routeGuardBindings())
      .first();
    return input === null
      ? undefined
      : mapSyncV2CardHeadRow(
          decodeOrThrow(
            syncV2CardHeadRowDecoder,
            input,
            'D1 Sync v2 card head row',
          ),
        );
  }

  async findReceipt(mutationId: SyncV2JournalCommit['mutationId']) {
    const input: unknown = await this.database
      .prepare(
        `SELECT mutation_id, fingerprint, card_id, applied_revision, committed_at
         FROM vault_sync_v2_commits entry
         WHERE entry.vault_id = ? AND entry.mutation_id = ?
           AND entry.state = 'committed'
           AND ${routeGuard('entry.vault_id')}`,
      )
      .bind(this.context.vaultId, mutationId, ...this.routeGuardBindings())
      .first();
    return input === null
      ? undefined
      : mapSyncV2JournalReceiptRow(
          decodeOrThrow(
            syncV2JournalReceiptRowDecoder,
            input,
            'D1 Sync v2 receipt row',
          ),
        );
  }

  async commit(
    command: SyncV2JournalCommit,
  ): Promise<SyncV2JournalCommitResult> {
    const snapshot = await this.snapshot(command);
    const plan = planSyncV2JournalCommit(command, snapshot);
    if (plan.kind === 'not-applied' || plan.kind === 'replayed') {
      return plan;
    }

    const prepared = [
      this.prepareCommitReservation(command, plan),
      ...this.prepareIndexChanges(command, plan),
      ...this.prepareJournalChanges(command, plan.changes),
      this.prepareStateAdvance(command, plan),
      this.prepareCommitCompletion(command),
    ];
    const results = await this.database.batch(prepared);
    const receipt = await this.findReceipt(command.mutationId);
    if (receipt === undefined) {
      return { kind: 'not-applied', reason: 'cas-conflict' };
    }
    if (receipt.fingerprint !== command.fingerprint) {
      return { kind: 'not-applied', reason: 'idempotency-key-reuse' };
    }
    return {
      kind: results[0]?.meta.changes === 1 ? 'applied' : 'replayed',
      receipt,
    };
  }

  async readPage(input: {
    readonly afterSequence: SyncSequence;
    readonly highWatermark: SyncSequence | null;
    readonly limit: number;
  }): Promise<SyncV2JournalPage> {
    const limit = decodeOrThrow(
      pageLimitDecoder,
      input.limit,
      'Sync v2 journal page limit',
    );
    const state = await this.readState();
    const currentHighWatermark = parseSyncSequence(state.nextSequence - 1);
    const highWatermark = input.highWatermark ?? currentHighWatermark;
    if (
      input.afterSequence > highWatermark ||
      highWatermark > currentHighWatermark
    ) {
      throw new BoundaryDecodeError('Sync v2 journal page', [
        { path: ['highWatermark'], reason: 'invalid page window' },
      ]);
    }
    const candidate: unknown = await this.database
      .prepare(
        `SELECT sequence, change_kind, card_id, conflict_id, revision,
          official_display_id, occurred_at
         FROM vault_sync_v2_changes entry
         WHERE entry.vault_id = ? AND entry.sequence > ? AND entry.sequence <= ?
           AND ${routeGuard('entry.vault_id')}
         ORDER BY entry.sequence ASC LIMIT ?`,
      )
      .bind(
        this.context.vaultId,
        input.afterSequence,
        highWatermark,
        ...this.routeGuardBindings(),
        limit + 1,
      )
      .all();
    const rows = decodeOrThrow(
      changeResultsDecoder,
      candidate,
      'D1 Sync v2 change page',
    ).results;
    const page = planSyncV2JournalPage({
      afterSequence: input.afterSequence,
      highWatermark,
      candidates: rows.map(mapSyncV2JournalChangeRow),
      limit,
    });
    if (page.kind === 'rejected') {
      throw new BoundaryDecodeError('Sync v2 journal page', [
        { path: ['changes'], reason: 'non-contiguous journal page' },
      ]);
    }
    return page.page;
  }

  private async snapshot(
    command: SyncV2JournalCommit,
  ): Promise<SyncV2JournalSnapshot> {
    const conflictIds =
      command.kind === 'conflict-upsert'
        ? [command.conflictId]
        : command.kind === 'resolve-conflicts'
          ? command.conflictIds
          : [];
    const [state, existingReceipt, card, selectedConflicts, allCardConflicts] =
      await Promise.all([
        this.readState(),
        this.findReceipt(command.mutationId),
        this.findCard(command.cardId),
        this.findConflicts(conflictIds),
        command.kind === 'card-delete'
          ? this.listCardConflicts(command.cardId)
          : Promise.resolve([]),
      ]);
    return {
      state,
      existingReceipt,
      card,
      selectedConflicts,
      allCardConflicts,
    };
  }

  private async readState(): Promise<SyncV2JournalState> {
    const input: unknown = await this.database
      .prepare(
        `SELECT next_display_id, next_change_sequence
         FROM vault_sync_v2_states state
         WHERE state.vault_id = ? AND ${routeGuard('state.vault_id')}`,
      )
      .bind(this.context.vaultId, ...this.routeGuardBindings())
      .first();
    if (input === null) {
      throw new BoundaryDecodeError('D1 Sync v2 state row', [
        { path: ['vault_id'], reason: 'missing scoped journal state' },
      ]);
    }
    return mapSyncV2JournalStateRow(
      decodeOrThrow(
        syncV2JournalStateRowDecoder,
        input,
        'D1 Sync v2 state row',
      ),
    );
  }

  private async findConflicts(
    conflictIds: readonly ConflictId[],
  ): Promise<readonly VaultConflictIndexRecord[]> {
    if (conflictIds.length === 0) return [];
    const placeholders = conflictIds.map(() => '?').join(', ');
    const candidate: unknown = await this.database
      .prepare(
        `SELECT conflict_id, card_id, server_revision, created_at
         FROM vault_conflicts entry
         WHERE entry.vault_id = ? AND entry.conflict_id IN (${placeholders})
           AND ${routeGuard('entry.vault_id')}
         ORDER BY entry.conflict_id ASC`,
      )
      .bind(this.context.vaultId, ...conflictIds, ...this.routeGuardBindings())
      .all();
    return decodeOrThrow(
      selectedConflictResultsDecoder,
      candidate,
      'D1 Sync v2 selected conflicts',
    ).results.map(mapConflictIndexRow);
  }

  private async listCardConflicts(
    cardId: CardId,
  ): Promise<readonly VaultConflictIndexRecord[]> {
    const candidate: unknown = await this.database
      .prepare(
        `SELECT conflict_id, card_id, server_revision, created_at
         FROM vault_conflicts entry
         WHERE entry.vault_id = ? AND entry.card_id = ?
           AND ${routeGuard('entry.vault_id')}
         ORDER BY entry.conflict_id ASC`,
      )
      .bind(this.context.vaultId, cardId, ...this.routeGuardBindings())
      .all();
    return decodeOrThrow(
      allConflictResultsDecoder,
      candidate,
      'D1 Sync v2 card conflicts',
    ).results.map(mapConflictIndexRow);
  }

  private prepareCommitReservation(
    command: SyncV2JournalCommit,
    plan: Extract<
      ReturnType<typeof planSyncV2JournalCommit>,
      { readonly kind: 'commit' }
    >,
  ): D1PreparedStatement {
    const condition = this.operationPrecondition(command, plan);
    return this.database
      .prepare(
        `INSERT INTO vault_sync_v2_commits(
          vault_id, mutation_id, fingerprint, card_id,
          applied_revision, committed_at, state
        )
        SELECT ?, ?, ?, ?, ?, ?, 'pending'
        WHERE ${routeGuard('?')}
          AND EXISTS (
            SELECT 1 FROM vault_sync_v2_states sync_state
            WHERE sync_state.vault_id = ?
              AND sync_state.next_display_id = ?
              AND sync_state.next_change_sequence = ?
          )
          AND ${condition.sql}
        ON CONFLICT(vault_id, mutation_id) DO NOTHING`,
      )
      .bind(
        this.context.vaultId,
        command.mutationId,
        command.fingerprint,
        command.cardId,
        plan.receipt.appliedRevision,
        command.committedAt,
        ...this.insertRouteGuardBindings(),
        this.context.vaultId,
        plan.expectedState.nextDisplayId,
        plan.expectedState.nextSequence,
        ...condition.bindings,
      );
  }

  private operationPrecondition(
    command: SyncV2JournalCommit,
    plan: Extract<
      ReturnType<typeof planSyncV2JournalCommit>,
      { readonly kind: 'commit' }
    >,
  ): { readonly sql: string; readonly bindings: readonly unknown[] } {
    switch (command.kind) {
      case 'card-upsert':
        return command.expectedRevision === null
          ? {
              sql: `NOT EXISTS (
                SELECT 1 FROM vault_cards card
                WHERE card.vault_id = ? AND card.card_id = ?
              )`,
              bindings: [this.context.vaultId, command.cardId],
            }
          : {
              sql: `EXISTS (
                SELECT 1 FROM vault_cards card
                INNER JOIN vault_card_display_ids display
                  ON display.vault_id = card.vault_id
                  AND display.card_id = card.card_id
                WHERE card.vault_id = ? AND card.card_id = ?
                  AND card.revision = ? AND display.official_display_id = ?
              )`,
              bindings: [
                this.context.vaultId,
                command.cardId,
                command.expectedRevision,
                cardUpsertChange(plan).officialDisplayId,
              ],
            };
      case 'conflict-upsert':
        return {
          sql: `EXISTS (
              SELECT 1 FROM vault_cards card
              WHERE card.vault_id = ? AND card.card_id = ? AND card.revision = ?
            ) AND NOT EXISTS (
              SELECT 1 FROM vault_conflicts conflict
              WHERE conflict.vault_id = ? AND conflict.conflict_id = ?
            )`,
          bindings: [
            this.context.vaultId,
            command.cardId,
            command.serverRevision,
            this.context.vaultId,
            command.conflictId,
          ],
        };
      case 'resolve-conflicts': {
        const placeholders = command.conflictIds.map(() => '?').join(', ');
        return {
          sql: `EXISTS (
              SELECT 1 FROM vault_cards card
              WHERE card.vault_id = ? AND card.card_id = ? AND card.revision = ?
            ) AND (
              SELECT COUNT(*) FROM vault_conflicts conflict
              WHERE conflict.vault_id = ? AND conflict.card_id = ?
                AND conflict.conflict_id IN (${placeholders})
            ) = ?`,
          bindings: [
            this.context.vaultId,
            command.cardId,
            command.expectedRevision,
            this.context.vaultId,
            command.cardId,
            ...command.conflictIds,
            command.conflictIds.length,
          ],
        };
      }
      case 'card-delete': {
        const conflictChanges = plan.changes.filter(
          (
            change,
          ): change is Extract<
            SyncV2JournalChange,
            { readonly kind: 'conflict-tombstone' }
          > => change.kind === 'conflict-tombstone',
        );
        const membership =
          conflictChanges.length === 0
            ? ''
            : ` AND (
              SELECT COUNT(*) FROM vault_conflicts conflict
              WHERE conflict.vault_id = ? AND conflict.card_id = ?
                AND conflict.conflict_id IN (${conflictChanges.map(() => '?').join(', ')})
            ) = ?`;
        return {
          sql: `EXISTS (
              SELECT 1 FROM vault_cards card
              WHERE card.vault_id = ? AND card.card_id = ? AND card.revision = ?
            ) AND (
              SELECT COUNT(*) FROM vault_conflicts conflict
              WHERE conflict.vault_id = ? AND conflict.card_id = ?
            ) = ?${membership}`,
          bindings: [
            this.context.vaultId,
            command.cardId,
            command.expectedRevision,
            this.context.vaultId,
            command.cardId,
            conflictChanges.length,
            ...(conflictChanges.length === 0
              ? []
              : [
                  this.context.vaultId,
                  command.cardId,
                  ...conflictChanges.map((change) => change.conflictId),
                  conflictChanges.length,
                ]),
          ],
        };
      }
      default:
        return assertNever(command, 'Unsupported Sync v2 journal command');
    }
  }

  private prepareIndexChanges(
    command: SyncV2JournalCommit,
    plan: Extract<
      ReturnType<typeof planSyncV2JournalCommit>,
      { readonly kind: 'commit' }
    >,
  ): readonly D1PreparedStatement[] {
    const statements: D1PreparedStatement[] = [];
    switch (command.kind) {
      case 'card-upsert':
        if (command.expectedRevision === null) {
          statements.push(
            this.database
              .prepare(
                `INSERT INTO vault_cards(vault_id, card_id, revision, updated_at)
                 SELECT ?, ?, ?, ? WHERE ${this.pendingGuard('?')}`,
              )
              .bind(
                this.context.vaultId,
                command.cardId,
                command.nextRevision,
                command.updatedAt,
                ...this.pendingInsertBindings(command),
              ),
            this.database
              .prepare(
                `INSERT INTO vault_card_display_ids(
                  vault_id, card_id, official_display_id
                ) SELECT ?, ?, ? WHERE ${this.pendingGuard('?')}`,
              )
              .bind(
                this.context.vaultId,
                command.cardId,
                plan.officialDisplayId,
                ...this.pendingInsertBindings(command),
              ),
          );
        } else {
          statements.push(
            this.database
              .prepare(
                `UPDATE vault_cards
                 SET revision = ?, updated_at = ?
                 WHERE vault_id = ? AND card_id = ? AND revision = ?
                   AND ${this.pendingGuard('vault_cards.vault_id')}`,
              )
              .bind(
                command.nextRevision,
                command.updatedAt,
                this.context.vaultId,
                command.cardId,
                command.expectedRevision,
                ...this.pendingBindings(command),
              ),
          );
        }
        break;
      case 'conflict-upsert':
        statements.push(
          this.database
            .prepare(
              `INSERT INTO vault_conflicts(
                vault_id, conflict_id, card_id, server_revision, created_at
              ) SELECT ?, ?, ?, ?, ? WHERE ${this.pendingGuard('?')}`,
            )
            .bind(
              this.context.vaultId,
              command.conflictId,
              command.cardId,
              command.serverRevision,
              command.createdAt,
              ...this.pendingInsertBindings(command),
            ),
        );
        break;
      case 'resolve-conflicts': {
        const placeholders = command.conflictIds.map(() => '?').join(', ');
        statements.push(
          this.database
            .prepare(
              `UPDATE vault_cards
               SET revision = ?, updated_at = ?
               WHERE vault_id = ? AND card_id = ? AND revision = ?
                 AND ${this.pendingGuard('vault_cards.vault_id')}`,
            )
            .bind(
              command.nextRevision,
              command.updatedAt,
              this.context.vaultId,
              command.cardId,
              command.expectedRevision,
              ...this.pendingBindings(command),
            ),
          this.database
            .prepare(
              `DELETE FROM vault_conflicts
               WHERE vault_id = ? AND card_id = ?
                 AND conflict_id IN (${placeholders})
                 AND ${this.pendingGuard('vault_conflicts.vault_id')}`,
            )
            .bind(
              this.context.vaultId,
              command.cardId,
              ...command.conflictIds,
              ...this.pendingBindings(command),
            ),
        );
        break;
      }
      case 'card-delete':
        statements.push(
          this.database
            .prepare(
              `DELETE FROM vault_cards
               WHERE vault_id = ? AND card_id = ? AND revision = ?
                 AND ${this.pendingGuard('vault_cards.vault_id')}`,
            )
            .bind(
              this.context.vaultId,
              command.cardId,
              command.expectedRevision,
              ...this.pendingBindings(command),
            ),
        );
        break;
      default:
        assertNever(command, 'Unsupported Sync v2 index command');
    }
    if (command.kind !== 'card-delete') {
      statements.push(
        this.database
          .prepare(
            `INSERT INTO vault_mutation_receipts(
              vault_id, mutation_id, card_id, applied_revision, created_at
            ) SELECT ?, ?, ?, ?, ? WHERE ${this.pendingGuard('?')}`,
          )
          .bind(
            this.context.vaultId,
            command.mutationId,
            command.cardId,
            plan.receipt.appliedRevision,
            command.committedAt,
            ...this.pendingInsertBindings(command),
          ),
      );
    }
    return statements;
  }

  private prepareJournalChanges(
    command: SyncV2JournalCommit,
    changes: readonly SyncV2JournalChange[],
  ): readonly D1PreparedStatement[] {
    return changes.map((change) => {
      const row = changeRow(change);
      return this.database
        .prepare(
          `INSERT INTO vault_sync_v2_changes(
            vault_id, sequence, change_kind, card_id, conflict_id,
            revision, official_display_id, occurred_at
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${this.pendingGuard('?')}`,
        )
        .bind(
          this.context.vaultId,
          change.sequence,
          change.kind,
          row.cardId,
          row.conflictId,
          row.revision,
          row.officialDisplayId,
          row.occurredAt,
          ...this.pendingInsertBindings(command),
        );
    });
  }

  private prepareStateAdvance(
    command: SyncV2JournalCommit,
    plan: Extract<
      ReturnType<typeof planSyncV2JournalCommit>,
      { readonly kind: 'commit' }
    >,
  ): D1PreparedStatement {
    return this.database
      .prepare(
        `UPDATE vault_sync_v2_states
         SET next_display_id = ?, next_change_sequence = ?
         WHERE vault_id = ? AND next_display_id = ? AND next_change_sequence = ?
           AND ${this.pendingGuard('vault_sync_v2_states.vault_id')}`,
      )
      .bind(
        plan.nextState.nextDisplayId,
        plan.nextState.nextSequence,
        this.context.vaultId,
        plan.expectedState.nextDisplayId,
        plan.expectedState.nextSequence,
        ...this.pendingBindings(command),
      );
  }

  private prepareCommitCompletion(
    command: SyncV2JournalCommit,
  ): D1PreparedStatement {
    return this.database
      .prepare(
        `UPDATE vault_sync_v2_commits
         SET state = 'committed'
         WHERE vault_id = ? AND mutation_id = ? AND fingerprint = ?
           AND state = 'pending' AND ${routeGuard('vault_sync_v2_commits.vault_id')}`,
      )
      .bind(
        this.context.vaultId,
        command.mutationId,
        command.fingerprint,
        ...this.routeGuardBindings(),
      );
  }

  private pendingGuard(vaultExpression: string): string {
    return `EXISTS (
      SELECT 1 FROM vault_sync_v2_commits pending
      WHERE pending.vault_id = ? AND pending.mutation_id = ?
        AND pending.fingerprint = ? AND pending.state = 'pending'
    ) AND ${routeGuard(vaultExpression)}`;
  }

  private pendingBindings(command: SyncV2JournalCommit): readonly unknown[] {
    return [
      this.context.vaultId,
      command.mutationId,
      command.fingerprint,
      ...this.routeGuardBindings(),
    ];
  }

  private pendingInsertBindings(
    command: SyncV2JournalCommit,
  ): readonly unknown[] {
    return [
      this.context.vaultId,
      command.mutationId,
      command.fingerprint,
      ...this.insertRouteGuardBindings(),
    ];
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

function changeRow(change: SyncV2JournalChange): {
  readonly cardId: CardId;
  readonly conflictId: ConflictId | null;
  readonly revision: number;
  readonly officialDisplayId: number | null;
  readonly occurredAt: number;
} {
  switch (change.kind) {
    case 'card-upsert':
      return {
        cardId: change.cardId,
        conflictId: null,
        revision: change.revision,
        officialDisplayId: change.officialDisplayId,
        occurredAt: change.occurredAt,
      };
    case 'card-tombstone':
      return {
        cardId: change.cardId,
        conflictId: null,
        revision: change.revision,
        officialDisplayId: null,
        occurredAt: change.deletedAt,
      };
    case 'conflict-upsert':
      return {
        cardId: change.cardId,
        conflictId: change.conflictId,
        revision: change.serverRevision,
        officialDisplayId: null,
        occurredAt: change.occurredAt,
      };
    case 'conflict-tombstone':
      return {
        cardId: change.cardId,
        conflictId: change.conflictId,
        revision: change.serverRevision,
        officialDisplayId: null,
        occurredAt: change.deletedAt,
      };
    default:
      return assertNever(change, 'Unsupported Sync v2 journal change');
  }
}

function cardUpsertChange(
  plan: Extract<
    ReturnType<typeof planSyncV2JournalCommit>,
    { readonly kind: 'commit' }
  >,
): Extract<SyncV2JournalChange, { readonly kind: 'card-upsert' }> {
  const change = plan.changes[0];
  if (change?.kind !== 'card-upsert') {
    throw new BoundaryDecodeError('Sync v2 journal commit plan', [
      { path: ['changes', 0], reason: 'expected card upsert' },
    ]);
  }
  return change;
}

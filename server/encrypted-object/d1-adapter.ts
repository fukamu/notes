import {
  arrayDecoder,
  decodeOrThrow,
  objectDecoder,
  safeIntegerDecoder,
} from '../../lib/codec/core';
import type { VaultContext } from '../../lib/domain/identity';
import type { D1DatabaseBinding } from '../../db/d1-types';
import type { CryptoObjectRevision, EnvelopeObject } from '../crypto/core';
import type { IdentityVaultControlPlane } from '../control-plane/public';
import type { VaultContentDirectory } from '../vault-content/public';
import type { VaultPartitionRoute } from '../vault-content/records';
import {
  evaluateEncryptedObjectMetadataPurge,
  type DeleteOutboxEntry,
  type EncryptedObjectMetadata,
  type EncryptedWriteId,
  type OpaqueObjectKey,
  type PendingEncryptedWrite,
} from './core';
import type {
  EncryptedObjectMetadataPurgePort,
  EncryptedObjectMetadataPurgeScope,
  VaultPrivateObjectPurgeScope,
} from './public';
import type {
  EncryptedObjectMetadataDirectory,
  EncryptedObjectMetadataRepository,
  EncryptedObjectRepositoryOpenResult,
  IntentReservationResult,
  MetadataCommitResult,
  DeleteOutboxMutationResult,
  VaultObjectDeleteOutboxDirectory,
  VaultObjectDeleteOutboxOpenResult,
  VaultObjectDeleteOutboxRepository,
} from './ports';
import {
  deleteOutboxRowDecoder,
  encryptedObjectMetadataRowDecoder,
  mapDeleteOutboxRow,
  mapEncryptedObjectMetadataRow,
  mapPendingEncryptedWriteRow,
  pendingEncryptedWriteRowDecoder,
  protectedObjectKeyRowsDecoder,
} from './records';

const maximumDeleteBatch = 100;
const deleteLimitDecoder = safeIntegerDecoder({
  minimum: 1,
  maximum: maximumDeleteBatch,
});
const protectedKeysResultDecoder = objectDecoder(
  { results: protectedObjectKeyRowsDecoder },
  { unknownFields: 'allow' },
);
const deleteOutboxResultDecoder = objectDecoder(
  {
    results: arrayDecoder(deleteOutboxRowDecoder, {
      maxLength: maximumDeleteBatch,
      uniqueBy: (row) => row.object_key,
    }),
  },
  { unknownFields: 'allow' },
);
const purgeInventoryDecoder = objectDecoder(
  {
    route_present: safeIntegerDecoder({ minimum: 0, maximum: 1 }),
    source_rows: safeIntegerDecoder({ minimum: 0 }),
  },
  { unknownFields: 'allow' },
);
const deleteOutboxInventoryDecoder = objectDecoder(
  {
    owner_present: safeIntegerDecoder({ minimum: 0, maximum: 1 }),
    pending_count: safeIntegerDecoder({ minimum: 0 }),
  },
  { unknownFields: 'allow' },
);
const deleteOutboxMutationResultDecoder = objectDecoder(
  {
    meta: objectDecoder(
      { changes: safeIntegerDecoder({ minimum: 0, maximum: 1 }) },
      { unknownFields: 'allow' },
    ),
  },
  { unknownFields: 'allow' },
);

export class D1EncryptedObjectMetadataPurge implements EncryptedObjectMetadataPurgePort {
  constructor(private readonly database: D1DatabaseBinding) {}

  async purgeVaultMetadata(input: {
    readonly scope: EncryptedObjectMetadataPurgeScope;
    readonly requestedAt: number;
  }) {
    const requestedAt = decodeOrThrow(
      safeIntegerDecoder({ minimum: 0 }),
      input.requestedAt,
      'encrypted object metadata purge timestamp',
    );
    const before = await this.readInventory(input.scope);
    if (before.route_present === 0) {
      return evaluateEncryptedObjectMetadataPurge({
        routePresent: false,
        sourceRowsBefore: before.source_rows,
        sourceRowsAfter: before.source_rows,
      });
    }

    await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO vault_object_delete_outbox(
            vault_id, object_key, attempt_count, next_attempt_at, created_at
          )
          SELECT candidates.vault_id, candidates.object_key, 0, ?, ?
          FROM (
            SELECT vault_id, object_key FROM vault_encrypted_objects
            WHERE vault_id = ?
            UNION
            SELECT vault_id, object_key FROM vault_encrypted_write_intents
            WHERE vault_id = ?
          ) candidates
          WHERE EXISTS (
            SELECT 1 FROM vault_partition_mappings route
            WHERE route.account_id = ? AND route.vault_id = ?
              AND route.vault_id = candidates.vault_id
          )
          ON CONFLICT(vault_id, object_key) DO NOTHING`,
        )
        .bind(
          requestedAt,
          requestedAt,
          input.scope.vaultId,
          input.scope.vaultId,
          input.scope.accountId,
          input.scope.vaultId,
        ),
      this.database
        .prepare(
          `DELETE FROM vault_encrypted_objects
           WHERE vault_id = ?
             AND EXISTS (
               SELECT 1 FROM vault_partition_mappings route
               WHERE route.account_id = ? AND route.vault_id = ?
                 AND route.vault_id = vault_encrypted_objects.vault_id
             )
             AND EXISTS (
               SELECT 1 FROM vault_object_delete_outbox pending
               WHERE pending.vault_id = vault_encrypted_objects.vault_id
                 AND pending.object_key = vault_encrypted_objects.object_key
             )`,
        )
        .bind(input.scope.vaultId, input.scope.accountId, input.scope.vaultId),
      this.database
        .prepare(
          `DELETE FROM vault_encrypted_write_intents
           WHERE vault_id = ?
             AND EXISTS (
               SELECT 1 FROM vault_partition_mappings route
               WHERE route.account_id = ? AND route.vault_id = ?
                 AND route.vault_id = vault_encrypted_write_intents.vault_id
             )
             AND EXISTS (
               SELECT 1 FROM vault_object_delete_outbox pending
               WHERE pending.vault_id = vault_encrypted_write_intents.vault_id
                 AND pending.object_key = vault_encrypted_write_intents.object_key
             )`,
        )
        .bind(input.scope.vaultId, input.scope.accountId, input.scope.vaultId),
    ]);

    const after = await this.readInventory(input.scope);
    return evaluateEncryptedObjectMetadataPurge({
      routePresent: before.route_present === 1,
      sourceRowsBefore: before.source_rows,
      sourceRowsAfter: after.source_rows,
    });
  }

  private async readInventory(scope: EncryptedObjectMetadataPurgeScope) {
    const raw: unknown = await this.database
      .prepare(
        `SELECT
          EXISTS(
            SELECT 1 FROM vault_partition_mappings route
            WHERE route.account_id = ? AND route.vault_id = ?
          ) AS route_present,
          (
            (SELECT COUNT(*) FROM vault_encrypted_objects stored
             WHERE stored.vault_id = ?)
            +
            (SELECT COUNT(*) FROM vault_encrypted_write_intents pending
             WHERE pending.vault_id = ?)
          ) AS source_rows`,
      )
      .bind(scope.accountId, scope.vaultId, scope.vaultId, scope.vaultId)
      .first();
    return decodeOrThrow(
      purgeInventoryDecoder,
      raw,
      'D1 encrypted object metadata purge inventory',
    );
  }
}

export class D1VaultObjectDeleteOutboxDirectory implements VaultObjectDeleteOutboxDirectory {
  constructor(
    private readonly database: D1DatabaseBinding,
    private readonly controlPlane: IdentityVaultControlPlane,
  ) {}

  async open(
    scope: VaultPrivateObjectPurgeScope,
  ): Promise<VaultObjectDeleteOutboxOpenResult> {
    const account = await this.controlPlane.findPersonalAccount(
      scope.accountId,
    );
    if (
      account === undefined ||
      account.account.accountId !== scope.accountId ||
      account.vault.vaultId !== scope.vaultId
    ) {
      return { kind: 'owner-mismatch' };
    }
    return {
      kind: 'opened',
      repository: new D1VaultObjectDeleteOutboxRepository(this.database, scope),
    };
  }
}

class D1VaultObjectDeleteOutboxRepository implements VaultObjectDeleteOutboxRepository {
  constructor(
    private readonly database: D1DatabaseBinding,
    private readonly scope: VaultPrivateObjectPurgeScope,
  ) {}

  async countPending(): Promise<number> {
    const raw: unknown = await this.database
      .prepare(
        `SELECT
          EXISTS(
            SELECT 1 FROM personal_vaults owner
            WHERE owner.account_id = ? AND owner.vault_id = ?
          ) AS owner_present,
          (
            SELECT COUNT(*) FROM vault_object_delete_outbox pending
            WHERE pending.vault_id = ?
              AND ${ownerGuard('pending.vault_id')}
          ) AS pending_count`,
      )
      .bind(
        this.scope.accountId,
        this.scope.vaultId,
        this.scope.vaultId,
        ...this.ownerGuardBindings(),
      )
      .first();
    const inventory = decodeOrThrow(
      deleteOutboxInventoryDecoder,
      raw,
      'D1 Vault delete outbox inventory',
    );
    if (inventory.owner_present !== 1) {
      throw new Error('Vault delete outbox owner is unavailable');
    }
    return inventory.pending_count;
  }

  async listReady(input: {
    readonly now: number;
    readonly limit: number;
  }): Promise<readonly DeleteOutboxEntry[]> {
    const limit = decodeOrThrow(
      deleteLimitDecoder,
      input.limit,
      'Vault object delete batch limit',
    );
    const now = decodeOrThrow(
      safeIntegerDecoder({ minimum: 0 }),
      input.now,
      'Vault object delete attempt timestamp',
    );
    const raw: unknown = await this.database
      .prepare(
        `SELECT object_key, attempt_count, next_attempt_at, created_at
         FROM vault_object_delete_outbox pending
         WHERE pending.vault_id = ? AND pending.next_attempt_at <= ?
           AND ${ownerGuard('pending.vault_id')}
         ORDER BY pending.next_attempt_at, pending.object_key LIMIT ?`,
      )
      .bind(this.scope.vaultId, now, ...this.ownerGuardBindings(), limit)
      .all();
    return decodeOrThrow(
      deleteOutboxResultDecoder,
      raw,
      'D1 Vault object delete outbox rows',
    ).results.map(mapDeleteOutboxRow);
  }

  async confirmDelete(
    entry: DeleteOutboxEntry,
  ): Promise<DeleteOutboxMutationResult> {
    const raw: unknown = await this.database
      .prepare(
        `DELETE FROM vault_object_delete_outbox
         WHERE vault_id = ? AND object_key = ? AND attempt_count = ?
           AND ${ownerGuard('vault_object_delete_outbox.vault_id')}`,
      )
      .bind(
        this.scope.vaultId,
        entry.objectKey,
        entry.attemptCount,
        ...this.ownerGuardBindings(),
      )
      .run();
    return this.classifyMutation(entry.objectKey, raw);
  }

  async rescheduleDelete(
    entry: DeleteOutboxEntry,
  ): Promise<DeleteOutboxMutationResult> {
    const raw: unknown = await this.database
      .prepare(
        `UPDATE vault_object_delete_outbox
         SET attempt_count = ?, next_attempt_at = ?
         WHERE vault_id = ? AND object_key = ? AND attempt_count = ?
           AND ${ownerGuard('vault_object_delete_outbox.vault_id')}`,
      )
      .bind(
        entry.attemptCount,
        entry.nextAttemptAt,
        this.scope.vaultId,
        entry.objectKey,
        entry.attemptCount - 1,
        ...this.ownerGuardBindings(),
      )
      .run();
    return this.classifyMutation(entry.objectKey, raw);
  }

  private async classifyMutation(
    objectKey: OpaqueObjectKey,
    raw: unknown,
  ): Promise<DeleteOutboxMutationResult> {
    const result = decodeOrThrow(
      deleteOutboxMutationResultDecoder,
      raw,
      'D1 Vault object delete outbox mutation',
    );
    if (result.meta.changes === 1) return { kind: 'applied' };
    return (await this.find(objectKey)) === undefined
      ? { kind: 'replayed' }
      : { kind: 'conflict' };
  }

  private async find(
    objectKey: OpaqueObjectKey,
  ): Promise<DeleteOutboxEntry | undefined> {
    const raw: unknown = await this.database
      .prepare(
        `SELECT object_key, attempt_count, next_attempt_at, created_at
         FROM vault_object_delete_outbox pending
         WHERE pending.vault_id = ? AND pending.object_key = ?
           AND ${ownerGuard('pending.vault_id')}`,
      )
      .bind(this.scope.vaultId, objectKey, ...this.ownerGuardBindings())
      .first();
    return raw === null
      ? undefined
      : mapDeleteOutboxRow(
          decodeOrThrow(
            deleteOutboxRowDecoder,
            raw,
            'D1 Vault object delete outbox row',
          ),
        );
  }

  private ownerGuardBindings(): readonly [string, string] {
    return [this.scope.accountId, this.scope.vaultId];
  }
}

export class D1EncryptedObjectMetadataDirectory implements EncryptedObjectMetadataDirectory {
  constructor(
    private readonly database: D1DatabaseBinding,
    private readonly vaultContent: VaultContentDirectory,
  ) {}

  async open(
    context: VaultContext,
  ): Promise<EncryptedObjectRepositoryOpenResult> {
    const scope = await this.vaultContent.open(context);
    if (scope.kind === 'not-found') return scope;
    return {
      kind: 'opened',
      route: scope.route,
      repository: new D1ScopedEncryptedObjectMetadataRepository(
        this.database,
        context,
        scope.route,
      ),
    };
  }
}

class D1ScopedEncryptedObjectMetadataRepository implements EncryptedObjectMetadataRepository {
  constructor(
    private readonly database: D1DatabaseBinding,
    private readonly context: VaultContext,
    private readonly route: VaultPartitionRoute,
  ) {}

  async findCurrent(
    object: EnvelopeObject,
  ): Promise<EncryptedObjectMetadata | undefined> {
    const input: unknown = await this.database
      .prepare(
        `SELECT ${metadataColumns}
         FROM vault_encrypted_objects stored
         WHERE stored.vault_id = ? AND stored.object_type = ? AND stored.object_id = ?
           AND ${routeGuard('stored.vault_id')}
         ORDER BY stored.object_revision DESC LIMIT 1`,
      )
      .bind(
        this.context.vaultId,
        object.kind,
        object.objectId,
        ...this.routeGuardBindings(),
      )
      .first();
    return input === null
      ? undefined
      : mapEncryptedObjectMetadataRow(
          decodeOrThrow(
            encryptedObjectMetadataRowDecoder,
            input,
            'D1 encrypted object metadata row',
          ),
        );
  }

  async findRevision(
    object: EnvelopeObject,
    objectRevision: CryptoObjectRevision,
  ): Promise<EncryptedObjectMetadata | undefined> {
    const input: unknown = await this.database
      .prepare(
        `SELECT ${metadataColumns}
         FROM vault_encrypted_objects stored
         WHERE stored.vault_id = ? AND stored.object_type = ?
           AND stored.object_id = ? AND stored.object_revision = ?
           AND ${routeGuard('stored.vault_id')}`,
      )
      .bind(
        this.context.vaultId,
        object.kind,
        object.objectId,
        objectRevision,
        ...this.routeGuardBindings(),
      )
      .first();
    return input === null
      ? undefined
      : mapEncryptedObjectMetadataRow(
          decodeOrThrow(
            encryptedObjectMetadataRowDecoder,
            input,
            'D1 encrypted object revision row',
          ),
        );
  }

  async findByWriteId(
    writeId: EncryptedWriteId,
  ): Promise<EncryptedObjectMetadata | undefined> {
    const input: unknown = await this.database
      .prepare(
        `SELECT ${metadataColumns}
         FROM vault_encrypted_objects stored
         WHERE stored.vault_id = ? AND stored.write_id = ?
           AND ${routeGuard('stored.vault_id')}`,
      )
      .bind(this.context.vaultId, writeId, ...this.routeGuardBindings())
      .first();
    return input === null
      ? undefined
      : mapEncryptedObjectMetadataRow(
          decodeOrThrow(
            encryptedObjectMetadataRowDecoder,
            input,
            'D1 encrypted object idempotency row',
          ),
        );
  }

  async reserveIntent(
    intent: PendingEncryptedWrite,
  ): Promise<IntentReservationResult> {
    const result = await this.database
      .prepare(
        `INSERT INTO vault_encrypted_write_intents(
          vault_id, write_id, object_type, object_id, expected_revision,
          object_revision, object_key, plaintext_bytes, crypto_version,
          dek_version, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ${routeGuard('?')}
        ON CONFLICT DO NOTHING`,
      )
      .bind(
        this.context.vaultId,
        intent.writeId,
        intent.object.kind,
        intent.object.objectId,
        intent.expectedRevision,
        intent.objectRevision,
        intent.objectKey,
        intent.plaintextBytes,
        intent.cryptoVersion,
        intent.dekVersion,
        intent.createdAt,
        ...this.insertRouteGuardBindings(),
      )
      .run();
    const existing = await this.findIntent(intent.writeId);
    if (existing === undefined) return { kind: 'conflict' };
    return result.meta.changes === 1
      ? { kind: 'reserved', intent: existing }
      : { kind: 'existing', intent: existing };
  }

  async commitIntent(input: {
    readonly intent: PendingEncryptedWrite;
    readonly ciphertextBytes: number;
  }): Promise<MetadataCommitResult> {
    const { intent } = input;
    const result = await this.database
      .prepare(
        `INSERT INTO vault_encrypted_objects(
          vault_id, object_type, object_id, object_revision, write_id,
          object_key, plaintext_bytes, ciphertext_bytes, crypto_version,
          dek_version, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ${routeGuard('?')}
          AND EXISTS (
            SELECT 1 FROM vault_encrypted_write_intents pending
            WHERE pending.vault_id = ? AND pending.write_id = ?
              AND pending.object_key = ? AND pending.object_type = ?
              AND pending.object_id = ? AND pending.object_revision = ?
              AND pending.expected_revision IS ?
          )
          AND ? = COALESCE(?, 0) + 1
          AND (
            (? IS NULL AND NOT EXISTS (
              SELECT 1 FROM vault_encrypted_objects current
              WHERE current.vault_id = ? AND current.object_type = ?
                AND current.object_id = ?
            ))
            OR
            (? IS NOT NULL AND (
              SELECT MAX(current.object_revision)
              FROM vault_encrypted_objects current
              WHERE current.vault_id = ? AND current.object_type = ?
                AND current.object_id = ?
            ) = ?)
          )
        ON CONFLICT DO NOTHING`,
      )
      .bind(
        this.context.vaultId,
        intent.object.kind,
        intent.object.objectId,
        intent.objectRevision,
        intent.writeId,
        intent.objectKey,
        intent.plaintextBytes,
        input.ciphertextBytes,
        intent.cryptoVersion,
        intent.dekVersion,
        intent.createdAt,
        ...this.insertRouteGuardBindings(),
        this.context.vaultId,
        intent.writeId,
        intent.objectKey,
        intent.object.kind,
        intent.object.objectId,
        intent.objectRevision,
        intent.expectedRevision,
        intent.objectRevision,
        intent.expectedRevision,
        intent.expectedRevision,
        this.context.vaultId,
        intent.object.kind,
        intent.object.objectId,
        intent.expectedRevision,
        this.context.vaultId,
        intent.object.kind,
        intent.object.objectId,
        intent.expectedRevision,
      )
      .run();
    if (result.meta.changes !== 1) return { kind: 'not-applied' };

    await this.database
      .prepare(
        'DELETE FROM vault_encrypted_write_intents WHERE vault_id = ? AND write_id = ? AND object_key = ?',
      )
      .bind(this.context.vaultId, intent.writeId, intent.objectKey)
      .run();
    return {
      kind: 'applied',
      metadata: {
        object: intent.object,
        objectRevision: intent.objectRevision,
        writeId: intent.writeId,
        objectKey: intent.objectKey,
        plaintextBytes: intent.plaintextBytes,
        ciphertextBytes: input.ciphertextBytes,
        cryptoVersion: intent.cryptoVersion,
        dekVersion: intent.dekVersion,
        createdAt: intent.createdAt,
      },
    };
  }

  async abandonIntent(input: {
    readonly intent: PendingEncryptedWrite;
    readonly requestedAt: number;
  }): Promise<void> {
    await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO vault_object_delete_outbox(
            vault_id, object_key, attempt_count, next_attempt_at, created_at
          )
          SELECT ?, ?, 0, ?, ?
          WHERE ${routeGuard('?')}
            AND EXISTS (
              SELECT 1 FROM vault_encrypted_write_intents pending
              WHERE pending.vault_id = ? AND pending.write_id = ?
                AND pending.object_key = ?
            )
          ON CONFLICT(vault_id, object_key) DO NOTHING`,
        )
        .bind(
          this.context.vaultId,
          input.intent.objectKey,
          input.requestedAt,
          input.requestedAt,
          ...this.insertRouteGuardBindings(),
          this.context.vaultId,
          input.intent.writeId,
          input.intent.objectKey,
        ),
      this.database
        .prepare(
          `DELETE FROM vault_encrypted_write_intents
           WHERE vault_id = ? AND write_id = ? AND object_key = ?
             AND ${routeGuard('vault_encrypted_write_intents.vault_id')}`,
        )
        .bind(
          this.context.vaultId,
          input.intent.writeId,
          input.intent.objectKey,
          ...this.routeGuardBindings(),
        ),
    ]);
  }

  async listProtectedObjectKeys(): Promise<ReadonlySet<OpaqueObjectKey>> {
    const input: unknown = await this.database
      .prepare(
        `SELECT object_key FROM vault_encrypted_objects stored
         WHERE stored.vault_id = ? AND ${routeGuard('stored.vault_id')}
         UNION
         SELECT object_key FROM vault_encrypted_write_intents pending
         WHERE pending.vault_id = ? AND ${routeGuard('pending.vault_id')}`,
      )
      .bind(
        this.context.vaultId,
        ...this.routeGuardBindings(),
        this.context.vaultId,
        ...this.routeGuardBindings(),
      )
      .all();
    const rows = decodeOrThrow(
      protectedKeysResultDecoder,
      input,
      'D1 protected encrypted object keys',
    ).results;
    return new Set(rows.map((row) => row.object_key));
  }

  async enqueueDelete(input: {
    readonly objectKey: OpaqueObjectKey;
    readonly requestedAt: number;
  }): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO vault_object_delete_outbox(
          vault_id, object_key, attempt_count, next_attempt_at, created_at
        )
        SELECT ?, ?, 0, ?, ? WHERE ${routeGuard('?')}
        ON CONFLICT(vault_id, object_key) DO NOTHING`,
      )
      .bind(
        this.context.vaultId,
        input.objectKey,
        input.requestedAt,
        input.requestedAt,
        ...this.insertRouteGuardBindings(),
      )
      .run();
  }

  async listReadyDeletes(input: {
    readonly now: number;
    readonly limit: number;
  }): Promise<readonly DeleteOutboxEntry[]> {
    const limit = decodeOrThrow(
      deleteLimitDecoder,
      input.limit,
      'encrypted object delete batch limit',
    );
    const raw: unknown = await this.database
      .prepare(
        `SELECT object_key, attempt_count, next_attempt_at, created_at
         FROM vault_object_delete_outbox pending
         WHERE pending.vault_id = ? AND pending.next_attempt_at <= ?
           AND ${routeGuard('pending.vault_id')}
         ORDER BY pending.next_attempt_at, pending.object_key LIMIT ?`,
      )
      .bind(
        this.context.vaultId,
        input.now,
        ...this.routeGuardBindings(),
        limit,
      )
      .all();
    return decodeOrThrow(
      deleteOutboxResultDecoder,
      raw,
      'D1 encrypted object delete outbox rows',
    ).results.map(mapDeleteOutboxRow);
  }

  async completeDelete(entry: DeleteOutboxEntry): Promise<void> {
    await this.database
      .prepare(
        `DELETE FROM vault_object_delete_outbox
         WHERE vault_id = ? AND object_key = ? AND attempt_count = ?
           AND ${routeGuard('vault_object_delete_outbox.vault_id')}`,
      )
      .bind(
        this.context.vaultId,
        entry.objectKey,
        entry.attemptCount,
        ...this.routeGuardBindings(),
      )
      .run();
  }

  async rescheduleDelete(entry: DeleteOutboxEntry): Promise<void> {
    await this.database
      .prepare(
        `UPDATE vault_object_delete_outbox
         SET attempt_count = ?, next_attempt_at = ?
         WHERE vault_id = ? AND object_key = ? AND attempt_count = ?
           AND ${routeGuard('vault_object_delete_outbox.vault_id')}`,
      )
      .bind(
        entry.attemptCount,
        entry.nextAttemptAt,
        this.context.vaultId,
        entry.objectKey,
        entry.attemptCount - 1,
        ...this.routeGuardBindings(),
      )
      .run();
  }

  async findIntent(
    writeId: EncryptedWriteId,
  ): Promise<PendingEncryptedWrite | undefined> {
    const input: unknown = await this.database
      .prepare(
        `SELECT ${intentColumns}
         FROM vault_encrypted_write_intents pending
         WHERE pending.vault_id = ? AND pending.write_id = ?
           AND ${routeGuard('pending.vault_id')}`,
      )
      .bind(this.context.vaultId, writeId, ...this.routeGuardBindings())
      .first();
    return input === null
      ? undefined
      : mapPendingEncryptedWriteRow(
          decodeOrThrow(
            pendingEncryptedWriteRowDecoder,
            input,
            'D1 pending encrypted write row',
          ),
        );
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

const metadataColumns = `object_type, object_id, object_revision, write_id,
  object_key, plaintext_bytes, ciphertext_bytes, crypto_version, dek_version,
  created_at`;
const intentColumns = `object_type, object_id, expected_revision,
  object_revision, write_id, object_key, plaintext_bytes, crypto_version,
  dek_version, created_at`;

function routeGuard(vaultExpression: string): string {
  return `EXISTS (
    SELECT 1 FROM vault_partition_mappings route
    WHERE route.account_id = ? AND route.vault_id = ?
      AND route.vault_id = ${vaultExpression}
      AND route.partition_id = ? AND route.routing_revision = ?
  )`;
}

function ownerGuard(vaultExpression: string): string {
  return `EXISTS (
    SELECT 1 FROM personal_vaults owner
    WHERE owner.account_id = ? AND owner.vault_id = ?
      AND owner.vault_id = ${vaultExpression}
  )`;
}

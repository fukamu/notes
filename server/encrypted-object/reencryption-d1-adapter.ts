import {
  BoundaryDecodeError,
  arrayDecoder,
  decodeOrThrow,
  objectDecoder,
  safeIntegerDecoder,
} from '../../lib/codec/core';
import type { VaultContext } from '../../lib/domain/identity';
import type { D1DatabaseBinding } from '../../db/d1-types';
import type { DekVersion } from '../crypto/core';
import type { VaultContentDirectory } from '../vault-content/public';
import type { VaultPartitionRoute } from '../vault-content/records';
import type { EncryptedObjectMetadata } from './core';
import {
  maximumReencryptionBatchSize,
  planEncryptedObjectReencryptionCandidate,
  sameEncryptedObjectMetadata,
  type EncryptedObjectReencryptionInventory,
  type EncryptedObjectReencryptionPosition,
} from './reencryption-core';
import type {
  EncryptedObjectReencryptionCommitResult,
  EncryptedObjectReencryptionDirectory,
  EncryptedObjectReencryptionOpenResult,
  EncryptedObjectReencryptionRepository,
} from './reencryption-ports';
import {
  encryptedObjectMetadataRowDecoder,
  mapEncryptedObjectMetadataRow,
} from './records';

const inventoryDecoder = objectDecoder(
  {
    route_present: safeIntegerDecoder({ minimum: 0, maximum: 1 }),
    older_objects: safeIntegerDecoder({ minimum: 0 }),
    target_objects: safeIntegerDecoder({ minimum: 0 }),
    newer_objects: safeIntegerDecoder({ minimum: 0 }),
    older_write_intents: safeIntegerDecoder({ minimum: 0 }),
    newer_write_intents: safeIntegerDecoder({ minimum: 0 }),
  },
  { unknownFields: 'allow' },
);
const candidateResultDecoder = objectDecoder(
  {
    results: arrayDecoder(encryptedObjectMetadataRowDecoder, {
      maxLength: maximumReencryptionBatchSize,
      uniqueBy: (row) =>
        `${row.object_type}:${row.object_id}:${row.object_revision}`,
    }),
  },
  { unknownFields: 'allow' },
);
const mutationResultDecoder = objectDecoder(
  {
    meta: objectDecoder(
      { changes: safeIntegerDecoder({ minimum: 0, maximum: 1 }) },
      { unknownFields: 'allow' },
    ),
  },
  { unknownFields: 'allow' },
);
const outboxPresenceDecoder = objectDecoder(
  { present: safeIntegerDecoder({ minimum: 0, maximum: 1 }) },
  { unknownFields: 'allow' },
);
const batchLimitDecoder = safeIntegerDecoder({
  minimum: 1,
  maximum: maximumReencryptionBatchSize,
});
const timestampDecoder = safeIntegerDecoder({ minimum: 0 });

export class D1EncryptedObjectReencryptionDirectory implements EncryptedObjectReencryptionDirectory {
  constructor(
    private readonly database: D1DatabaseBinding,
    private readonly vaultContent: VaultContentDirectory,
  ) {}

  async open(
    context: VaultContext,
  ): Promise<EncryptedObjectReencryptionOpenResult> {
    const scope = await this.vaultContent.open(context);
    if (scope.kind === 'not-found') return scope;
    return {
      kind: 'opened',
      route: scope.route,
      repository: new D1ScopedEncryptedObjectReencryptionRepository(
        this.database,
        context,
        scope.route,
      ),
    };
  }
}

class D1ScopedEncryptedObjectReencryptionRepository implements EncryptedObjectReencryptionRepository {
  constructor(
    private readonly database: D1DatabaseBinding,
    private readonly context: VaultContext,
    private readonly route: VaultPartitionRoute,
  ) {}

  async inventory(
    targetVersion: DekVersion,
  ): Promise<EncryptedObjectReencryptionInventory> {
    const raw: unknown = await this.database
      .prepare(
        `SELECT
          EXISTS(
            SELECT 1 FROM vault_partition_mappings route
            WHERE route.account_id = ? AND route.vault_id = ?
              AND route.partition_id = ? AND route.routing_revision = ?
          ) AS route_present,
          (SELECT COUNT(*) FROM vault_encrypted_objects stored
           WHERE stored.vault_id = ? AND stored.dek_version < ?
             AND ${routeGuard('stored.vault_id')}) AS older_objects,
          (SELECT COUNT(*) FROM vault_encrypted_objects stored
           WHERE stored.vault_id = ? AND stored.dek_version = ?
             AND ${routeGuard('stored.vault_id')}) AS target_objects,
          (SELECT COUNT(*) FROM vault_encrypted_objects stored
           WHERE stored.vault_id = ? AND stored.dek_version > ?
             AND ${routeGuard('stored.vault_id')}) AS newer_objects,
          (SELECT COUNT(*) FROM vault_encrypted_write_intents pending
           WHERE pending.vault_id = ? AND pending.dek_version < ?
             AND ${routeGuard('pending.vault_id')}) AS older_write_intents,
          (SELECT COUNT(*) FROM vault_encrypted_write_intents pending
           WHERE pending.vault_id = ? AND pending.dek_version > ?
             AND ${routeGuard('pending.vault_id')}) AS newer_write_intents`,
      )
      .bind(
        ...this.routeGuardBindings(),
        this.context.vaultId,
        targetVersion,
        ...this.routeGuardBindings(),
        this.context.vaultId,
        targetVersion,
        ...this.routeGuardBindings(),
        this.context.vaultId,
        targetVersion,
        ...this.routeGuardBindings(),
        this.context.vaultId,
        targetVersion,
        ...this.routeGuardBindings(),
        this.context.vaultId,
        targetVersion,
        ...this.routeGuardBindings(),
      )
      .first();
    const inventory = decodeOrThrow(
      inventoryDecoder,
      raw,
      'D1 encrypted object re-encryption inventory',
    );
    return {
      routePresent: inventory.route_present === 1,
      olderObjects: inventory.older_objects,
      targetObjects: inventory.target_objects,
      newerObjects: inventory.newer_objects,
      olderWriteIntents: inventory.older_write_intents,
      newerWriteIntents: inventory.newer_write_intents,
    };
  }

  async listCandidates(input: {
    readonly targetVersion: DekVersion;
    readonly after: EncryptedObjectReencryptionPosition | null;
    readonly limit: number;
  }): Promise<readonly EncryptedObjectMetadata[]> {
    const limit = decodeOrThrow(
      batchLimitDecoder,
      input.limit,
      'D1 encrypted object re-encryption batch limit',
    );
    const afterClause =
      input.after === null
        ? ''
        : `AND (
          stored.object_type > ?
          OR (stored.object_type = ? AND stored.object_id > ?)
          OR (stored.object_type = ? AND stored.object_id = ?
            AND stored.object_revision > ?)
        )`;
    const statement = this.database.prepare(
      `SELECT ${metadataColumns}
       FROM vault_encrypted_objects stored
       WHERE stored.vault_id = ? AND stored.dek_version < ?
         AND ${routeGuard('stored.vault_id')}
         ${afterClause}
       ORDER BY stored.object_type, stored.object_id, stored.object_revision
       LIMIT ?`,
    );
    const routeBindings = [
      this.context.vaultId,
      input.targetVersion,
      ...this.routeGuardBindings(),
    ] as const;
    const raw: unknown =
      input.after === null
        ? await statement.bind(...routeBindings, limit).all()
        : await statement
            .bind(
              ...routeBindings,
              input.after.object.kind,
              input.after.object.kind,
              input.after.object.objectId,
              input.after.object.kind,
              input.after.object.objectId,
              input.after.objectRevision,
              limit,
            )
            .all();
    return decodeOrThrow(
      candidateResultDecoder,
      raw,
      'D1 encrypted object re-encryption candidates',
    ).results.map(mapEncryptedObjectMetadataRow);
  }

  async commit(input: {
    readonly expected: EncryptedObjectMetadata;
    readonly replacement: EncryptedObjectMetadata;
    readonly requestedAt: number;
  }): Promise<EncryptedObjectReencryptionCommitResult> {
    const requestedAt = decodeOrThrow(
      timestampDecoder,
      input.requestedAt,
      'D1 encrypted object re-encryption timestamp',
    );
    const candidatePlan = planEncryptedObjectReencryptionCandidate({
      candidate: input.expected,
      targetVersion: input.replacement.dekVersion,
      replacementObjectKey: input.replacement.objectKey,
      replacementCiphertextBytes: input.replacement.ciphertextBytes,
    });
    if (
      candidatePlan.kind === 'rejected' ||
      !sameEncryptedObjectMetadata(candidatePlan.replacement, input.replacement)
    ) {
      const current = await this.findRevision(input.expected);
      return {
        kind: 'conflict',
        ...(current === undefined ? {} : { current }),
      };
    }

    const results = await this.database.batch([
      this.database
        .prepare(
          `UPDATE vault_encrypted_objects
           SET object_key = ?, ciphertext_bytes = ?, dek_version = ?
           WHERE vault_id = ? AND object_type = ? AND object_id = ?
             AND object_revision = ? AND write_id = ? AND object_key = ?
             AND plaintext_bytes = ? AND ciphertext_bytes = ?
             AND crypto_version = ? AND dek_version = ? AND created_at = ?
             AND ${routeGuard('vault_encrypted_objects.vault_id')}`,
        )
        .bind(
          input.replacement.objectKey,
          input.replacement.ciphertextBytes,
          input.replacement.dekVersion,
          this.context.vaultId,
          input.expected.object.kind,
          input.expected.object.objectId,
          input.expected.objectRevision,
          input.expected.writeId,
          input.expected.objectKey,
          input.expected.plaintextBytes,
          input.expected.ciphertextBytes,
          input.expected.cryptoVersion,
          input.expected.dekVersion,
          input.expected.createdAt,
          ...this.routeGuardBindings(),
        ),
      this.database
        .prepare(
          `INSERT INTO vault_object_delete_outbox(
            vault_id, object_key, attempt_count, next_attempt_at, created_at
          )
          SELECT ?, ?, 0, ?, ?
          WHERE ${routeGuard('?')}
            AND EXISTS (
              SELECT 1 FROM vault_encrypted_objects stored
              WHERE stored.vault_id = ? AND stored.object_type = ?
                AND stored.object_id = ? AND stored.object_revision = ?
                AND stored.write_id = ? AND stored.object_key = ?
                AND stored.plaintext_bytes = ?
                AND stored.ciphertext_bytes = ?
                AND stored.crypto_version = ? AND stored.dek_version = ?
                AND stored.created_at = ?
            )
          ON CONFLICT(vault_id, object_key) DO NOTHING`,
        )
        .bind(
          this.context.vaultId,
          input.expected.objectKey,
          requestedAt,
          requestedAt,
          ...this.insertRouteGuardBindings(),
          this.context.vaultId,
          input.replacement.object.kind,
          input.replacement.object.objectId,
          input.replacement.objectRevision,
          input.replacement.writeId,
          input.replacement.objectKey,
          input.replacement.plaintextBytes,
          input.replacement.ciphertextBytes,
          input.replacement.cryptoVersion,
          input.replacement.dekVersion,
          input.replacement.createdAt,
        ),
    ]);
    const update = decodeOrThrow(
      mutationResultDecoder,
      results[0],
      'D1 encrypted object re-encryption update result',
    );
    const current = await this.findRevision(input.expected);
    const outboxPresent = await this.hasOutbox(input.expected.objectKey);
    if (
      current !== undefined &&
      sameEncryptedObjectMetadata(current, input.replacement) &&
      outboxPresent
    ) {
      return update.meta.changes === 1
        ? { kind: 'applied', metadata: current }
        : { kind: 'replayed', metadata: current };
    }
    if (update.meta.changes === 1) {
      throw new BoundaryDecodeError(
        'D1 encrypted object re-encryption commit',
        [
          {
            path: [],
            reason: 'metadata and delete outbox were not committed together',
          },
        ],
      );
    }
    return { kind: 'conflict', ...(current === undefined ? {} : { current }) };
  }

  private async findRevision(
    identity: EncryptedObjectMetadata,
  ): Promise<EncryptedObjectMetadata | undefined> {
    const raw: unknown = await this.database
      .prepare(
        `SELECT ${metadataColumns}
         FROM vault_encrypted_objects stored
         WHERE stored.vault_id = ? AND stored.object_type = ?
           AND stored.object_id = ? AND stored.object_revision = ?
           AND ${routeGuard('stored.vault_id')}`,
      )
      .bind(
        this.context.vaultId,
        identity.object.kind,
        identity.object.objectId,
        identity.objectRevision,
        ...this.routeGuardBindings(),
      )
      .first();
    return raw === null
      ? undefined
      : mapEncryptedObjectMetadataRow(
          decodeOrThrow(
            encryptedObjectMetadataRowDecoder,
            raw,
            'D1 re-encrypted object metadata row',
          ),
        );
  }

  private async hasOutbox(objectKey: EncryptedObjectMetadata['objectKey']) {
    const raw: unknown = await this.database
      .prepare(
        `SELECT EXISTS(
          SELECT 1 FROM vault_object_delete_outbox pending
          WHERE pending.vault_id = ? AND pending.object_key = ?
            AND ${routeGuard('pending.vault_id')}
        ) AS present`,
      )
      .bind(this.context.vaultId, objectKey, ...this.routeGuardBindings())
      .first();
    return (
      decodeOrThrow(
        outboxPresenceDecoder,
        raw,
        'D1 re-encryption delete outbox presence',
      ).present === 1
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

function routeGuard(vaultExpression: string): string {
  return `EXISTS (
    SELECT 1 FROM vault_partition_mappings route
    WHERE route.account_id = ? AND route.vault_id = ?
      AND route.vault_id = ${vaultExpression}
      AND route.partition_id = ? AND route.routing_revision = ?
  )`;
}

import {
  BoundaryDecodeError,
  decodeOrThrow,
  objectDecoder,
} from '../../lib/codec/core';
import { accountIdDecoder, vaultIdDecoder } from '../../lib/domain/identity';
import type { D1DatabaseBinding } from '../../db/d1-types';
import {
  decodeVaultDekKeyring,
  type VaultDekKeyring,
  type VaultDekMetadata,
} from './core';
import {
  sameDekRotationOperation,
  validDekRotationSnapshot,
  validDekRotationTransition,
  type DekRotationOperation,
  type DekRotationScope,
  type DekRotationSnapshot,
  type DekRotationStartPlan,
  type DekRotationTransition,
} from './rotation-core';
import type {
  DekRotationCommitResult,
  DekRotationLoadResult,
  DekRotationRepository,
} from './rotation-ports';
import {
  dekRotationOperationRowDecoder,
  mapDekRotationOperationRow,
  mapVaultDekVersionRow,
  vaultDekVersionRowDecoder,
  vaultDekVersionRowsDecoder,
} from './rotation-records';

const operationColumns = `vault_id, account_id, operation_id, revision,
  source_version, target_version, state, kek_key_reference, wrapped_dek,
  key_created_at, created_at, updated_at, completed_at`;
const versionColumns = `vault_id, dek_version, kek_key_reference, wrapped_dek,
  is_write_key, created_at`;
const qualifiedVersionColumns = `version.vault_id AS vault_id,
  version.dek_version AS dek_version,
  version.kek_key_reference AS kek_key_reference,
  version.wrapped_dek AS wrapped_dek,
  version.is_write_key AS is_write_key,
  version.created_at AS created_at`;
const ownerDecoder = objectDecoder({
  account_id: accountIdDecoder,
  vault_id: vaultIdDecoder,
});

export class D1DekRotationRepository implements DekRotationRepository {
  constructor(private readonly database: D1DatabaseBinding) {}

  async load(scope: DekRotationScope): Promise<DekRotationLoadResult> {
    const rawOwner: unknown = await this.database
      .prepare(
        `SELECT account_id, vault_id FROM personal_vaults
         WHERE account_id = ? AND vault_id = ?`,
      )
      .bind(scope.accountId, scope.vaultId)
      .first();
    if (rawOwner === null) return { kind: 'not-found' };
    decodeOrThrow(ownerDecoder, rawOwner, 'D1 DEK rotation owner');

    const [rawVersions, rawOperation] = await Promise.all([
      this.database
        .prepare(
          `SELECT ${versionColumns} FROM vault_dek_versions
           WHERE vault_id = ? ORDER BY dek_version ASC`,
        )
        .bind(scope.vaultId)
        .all(),
      this.database
        .prepare(
          `SELECT ${operationColumns} FROM vault_dek_rotation_operations
           WHERE account_id = ? AND vault_id = ?`,
        )
        .bind(scope.accountId, scope.vaultId)
        .first(),
    ]);
    const decodedVersions = decodeOrThrow(
      vaultDekVersionRowsDecoder,
      rawVersions,
      'D1 Vault DEK version rows',
    );
    const operation =
      rawOperation === null
        ? undefined
        : mapDekRotationOperationRow(
            decodeOrThrow(
              dekRotationOperationRowDecoder,
              rawOperation,
              'D1 DEK rotation operation row',
            ),
          );
    const writeVersion = writeVersionFor(decodedVersions.results, operation);
    const keyring = decodeVaultDekKeyring({
      vaultId: scope.vaultId,
      writeVersion,
      versions: decodedVersions.results.map(mapVaultDekVersionRow),
    });
    const snapshot: DekRotationSnapshot = {
      keyring,
      ...(operation === undefined ? {} : { operation }),
    };
    if (!validDekRotationSnapshot(snapshot)) {
      throw new BoundaryDecodeError('D1 DEK rotation snapshot', [
        { path: [], reason: 'keyring and operation are inconsistent' },
      ]);
    }
    return { kind: 'found', snapshot };
  }

  async start(
    scope: DekRotationScope,
    plan: Extract<DekRotationStartPlan, { kind: 'accepted' }>,
  ): Promise<DekRotationCommitResult> {
    const next = plan.next;
    if (
      next.accountId !== scope.accountId ||
      next.vaultId !== scope.vaultId ||
      next.state.kind !== 'generating' ||
      next.revision !== 1
    ) {
      return this.conflict(scope);
    }
    if (plan.current !== undefined && plan.current.state.kind !== 'completed') {
      return this.conflict(scope);
    }
    const result =
      plan.current === undefined
        ? await this.database
            .prepare(
              `INSERT INTO vault_dek_rotation_operations(${operationColumns})
               SELECT ?, ?, ?, ?, ?, ?, 'generating', NULL, NULL, NULL, ?, ?, NULL
               WHERE EXISTS (
                 SELECT 1 FROM personal_vaults
                 WHERE account_id = ? AND vault_id = ?
               )
               ON CONFLICT(vault_id) DO NOTHING`,
            )
            .bind(
              next.vaultId,
              next.accountId,
              next.operationId,
              next.revision,
              next.sourceVersion,
              next.targetVersion,
              next.createdAt,
              next.updatedAt,
              scope.accountId,
              scope.vaultId,
            )
            .run()
        : await this.replaceCompleted(scope, plan.current, next);
    return this.afterCommit(scope, next, result.meta.changes);
  }

  async recordGenerated(
    scope: DekRotationScope,
    transition: DekRotationTransition,
  ): Promise<DekRotationCommitResult> {
    if (
      !validDekRotationTransition(transition) ||
      transition.current.state.kind !== 'generating' ||
      transition.next.state.kind !== 'promoting' ||
      !transitionMatchesScope(scope, transition)
    ) {
      return this.conflict(scope);
    }
    const metadata = transition.next.state.metadata;
    const result = await this.database
      .prepare(
        `UPDATE vault_dek_rotation_operations SET
          revision = ?, state = 'promoting', kek_key_reference = ?,
          wrapped_dek = ?, key_created_at = ?, updated_at = ?
         WHERE account_id = ? AND vault_id = ? AND operation_id = ?
           AND revision = ? AND state = 'generating'`,
      )
      .bind(
        transition.next.revision,
        metadata.kekKeyReference,
        metadata.wrappedDek,
        metadata.createdAt,
        transition.next.updatedAt,
        scope.accountId,
        scope.vaultId,
        transition.current.operationId,
        transition.current.revision,
      )
      .run();
    return this.afterCommit(scope, transition.next, result.meta.changes);
  }

  async promote(
    scope: DekRotationScope,
    transition: DekRotationTransition,
  ): Promise<DekRotationCommitResult> {
    if (
      !validDekRotationTransition(transition) ||
      transition.current.state.kind !== 'promoting' ||
      transition.next.state.kind !== 'completed' ||
      !transitionMatchesScope(scope, transition)
    ) {
      return this.conflict(scope);
    }
    const metadata = transition.next.state.metadata;
    await this.database
      .prepare(
        `INSERT INTO vault_dek_versions(${versionColumns})
         SELECT ?, ?, ?, ?, 0, ?
         WHERE EXISTS (
           SELECT 1 FROM personal_vaults
           WHERE account_id = ? AND vault_id = ?
         )
         ON CONFLICT(vault_id, dek_version) DO NOTHING`,
      )
      .bind(
        metadata.vaultId,
        metadata.dekVersion,
        metadata.kekKeyReference,
        metadata.wrappedDek,
        metadata.createdAt,
        scope.accountId,
        scope.vaultId,
      )
      .run();
    const persistedMetadata = await this.findMetadata(
      scope,
      metadata.dekVersion,
    );
    if (
      persistedMetadata === undefined ||
      !sameMetadata(persistedMetadata, metadata)
    ) {
      return this.conflict(scope);
    }
    const result = await this.database
      .prepare(
        `UPDATE vault_dek_rotation_operations SET
          revision = ?, state = 'completed', updated_at = ?, completed_at = ?
         WHERE account_id = ? AND vault_id = ? AND operation_id = ?
           AND revision = ? AND state = 'promoting'
           AND kek_key_reference = ? AND wrapped_dek = ? AND key_created_at = ?`,
      )
      .bind(
        transition.next.revision,
        transition.next.updatedAt,
        transition.next.state.completedAt,
        scope.accountId,
        scope.vaultId,
        transition.current.operationId,
        transition.current.revision,
        metadata.kekKeyReference,
        metadata.wrappedDek,
        metadata.createdAt,
      )
      .run();
    return this.afterCommit(scope, transition.next, result.meta.changes);
  }

  private async replaceCompleted(
    scope: DekRotationScope,
    current: DekRotationOperation,
    next: DekRotationOperation,
  ) {
    return this.database
      .prepare(
        `UPDATE vault_dek_rotation_operations SET
          operation_id = ?, revision = ?, source_version = ?,
          target_version = ?, state = 'generating', kek_key_reference = NULL,
          wrapped_dek = NULL, key_created_at = NULL, created_at = ?,
          updated_at = ?, completed_at = NULL
         WHERE account_id = ? AND vault_id = ? AND operation_id = ?
           AND revision = ? AND state = 'completed'`,
      )
      .bind(
        next.operationId,
        next.revision,
        next.sourceVersion,
        next.targetVersion,
        next.createdAt,
        next.updatedAt,
        scope.accountId,
        scope.vaultId,
        current.operationId,
        current.revision,
      )
      .run();
  }

  private async afterCommit(
    scope: DekRotationScope,
    expected: DekRotationOperation,
    changes: number,
  ): Promise<DekRotationCommitResult> {
    const loaded = await this.load(scope);
    if (loaded.kind === 'not-found') {
      return { kind: 'conflict' };
    }
    const operation = loaded.snapshot.operation;
    if (
      operation !== undefined &&
      sameDekRotationOperation(operation, expected)
    ) {
      return {
        kind: changes === 1 ? 'applied' : 'replayed',
        snapshot: loaded.snapshot,
      };
    }
    return { kind: 'conflict', current: loaded.snapshot };
  }

  private async conflict(
    scope: DekRotationScope,
  ): Promise<DekRotationCommitResult> {
    const loaded = await this.load(scope);
    return {
      kind: 'conflict',
      ...(loaded.kind === 'found' ? { current: loaded.snapshot } : {}),
    };
  }

  private async findMetadata(
    scope: DekRotationScope,
    version: VaultDekMetadata['dekVersion'],
  ): Promise<VaultDekMetadata | undefined> {
    const raw: unknown = await this.database
      .prepare(
        `SELECT ${qualifiedVersionColumns}
         FROM vault_dek_versions version
         JOIN personal_vaults owner ON owner.vault_id = version.vault_id
         WHERE owner.account_id = ? AND owner.vault_id = ?
           AND version.dek_version = ?`,
      )
      .bind(scope.accountId, scope.vaultId, version)
      .first();
    return raw === null
      ? undefined
      : mapVaultDekVersionRow(
          decodeOrThrow(
            vaultDekVersionRowDecoder,
            raw,
            'D1 promoted Vault DEK row',
          ),
        );
  }
}

function writeVersionFor(
  rows: readonly {
    readonly dek_version: VaultDekMetadata['dekVersion'];
    readonly is_write_key: 0 | 1;
  }[],
  operation: DekRotationOperation | undefined,
): VaultDekKeyring['writeVersion'] {
  if (operation !== undefined) {
    return operation.state.kind === 'completed'
      ? operation.targetVersion
      : operation.sourceVersion;
  }
  const writeRows = rows.filter((row) => row.is_write_key === 1);
  if (writeRows.length !== 1) {
    throw new BoundaryDecodeError('D1 Vault DEK write version', [
      { path: [], reason: 'expected exactly one bootstrap write key' },
    ]);
  }
  const write = writeRows[0];
  if (write === undefined) {
    throw new BoundaryDecodeError('D1 Vault DEK write version', [
      { path: [], reason: 'write key is missing' },
    ]);
  }
  return write.dek_version;
}

function transitionMatchesScope(
  scope: DekRotationScope,
  transition: DekRotationTransition,
): boolean {
  return (
    transition.current.accountId === scope.accountId &&
    transition.current.vaultId === scope.vaultId &&
    transition.next.accountId === scope.accountId &&
    transition.next.vaultId === scope.vaultId
  );
}

function sameMetadata(
  left: VaultDekMetadata,
  right: VaultDekMetadata,
): boolean {
  return (
    left.vaultId === right.vaultId &&
    left.dekVersion === right.dekVersion &&
    left.kekKeyReference === right.kekKeyReference &&
    left.wrappedDek === right.wrappedDek &&
    left.createdAt === right.createdAt
  );
}

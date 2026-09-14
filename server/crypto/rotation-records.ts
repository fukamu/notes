import {
  arrayDecoder,
  BoundaryDecodeError,
  literalDecoder,
  nullableDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type InferDecoder,
} from '../../lib/codec/core';
import { accountIdDecoder, vaultIdDecoder } from '../../lib/domain/identity';
import {
  dekVersionDecoder,
  wrappedDataEncryptionKeyDecoder,
  type VaultDekMetadata,
} from './core';
import {
  dekRotationOperationDecoder,
  dekRotationOperationIdDecoder,
  dekRotationRevisionDecoder,
  type DekRotationOperation,
  type DekRotationState,
} from './rotation-core';

const timestampDecoder = safeIntegerDecoder({ minimum: 0 });
const rotationStateDecoder = unionDecoder(
  literalDecoder('generating'),
  literalDecoder('promoting'),
  literalDecoder('completed'),
);

export const dekRotationOperationRowDecoder = objectDecoder({
  vault_id: vaultIdDecoder,
  account_id: accountIdDecoder,
  operation_id: dekRotationOperationIdDecoder,
  revision: dekRotationRevisionDecoder,
  source_version: dekVersionDecoder,
  target_version: dekVersionDecoder,
  state: rotationStateDecoder,
  kek_key_reference: nullableDecoder(
    stringDecoder({ minLength: 1, maxLength: 2_048 }),
  ),
  wrapped_dek: nullableDecoder(wrappedDataEncryptionKeyDecoder),
  key_created_at: nullableDecoder(timestampDecoder),
  created_at: timestampDecoder,
  updated_at: timestampDecoder,
  completed_at: nullableDecoder(timestampDecoder),
});

const writeFlagDecoder = transformDecoder(
  refineDecoder(
    safeIntegerDecoder({ minimum: 0, maximum: 1 }),
    (value) => value === 0 || value === 1,
    'expected a write-key flag',
  ),
  (value): 0 | 1 => (value === 0 ? 0 : 1),
);
export const vaultDekVersionRowDecoder = objectDecoder({
  vault_id: vaultIdDecoder,
  dek_version: dekVersionDecoder,
  kek_key_reference: stringDecoder({ minLength: 1, maxLength: 2_048 }),
  wrapped_dek: wrappedDataEncryptionKeyDecoder,
  is_write_key: writeFlagDecoder,
  created_at: timestampDecoder,
});

export const vaultDekVersionRowsDecoder = objectDecoder(
  {
    results: arrayDecoder(vaultDekVersionRowDecoder, {
      minLength: 1,
      maxLength: 64,
      uniqueBy: (row) => row.dek_version,
    }),
  },
  { unknownFields: 'allow' },
);

export type DekRotationOperationRow = InferDecoder<
  typeof dekRotationOperationRowDecoder
>;
export type VaultDekVersionRow = InferDecoder<typeof vaultDekVersionRowDecoder>;

export function mapDekRotationOperationRow(
  row: DekRotationOperationRow,
): DekRotationOperation {
  const metadata = rotationMetadata(row);
  let state: DekRotationState;
  switch (row.state) {
    case 'generating':
      if (metadata !== undefined || row.completed_at !== null) {
        return invalidRotationRow();
      }
      state = { kind: 'generating' };
      break;
    case 'promoting':
      if (metadata === undefined || row.completed_at !== null) {
        return invalidRotationRow();
      }
      state = { kind: 'promoting', metadata };
      break;
    case 'completed':
      if (metadata === undefined || row.completed_at === null) {
        return invalidRotationRow();
      }
      state = {
        kind: 'completed',
        metadata,
        completedAt: row.completed_at,
      };
      break;
  }
  const decoded = dekRotationOperationDecoder.decode({
    operationId: row.operation_id,
    accountId: row.account_id,
    vaultId: row.vault_id,
    revision: row.revision,
    sourceVersion: row.source_version,
    targetVersion: row.target_version,
    state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  if (!decoded.ok) return invalidRotationRow();
  return decoded.value;
}

export function mapVaultDekVersionRow(
  row: VaultDekVersionRow,
): VaultDekMetadata {
  return {
    vaultId: row.vault_id,
    dekVersion: row.dek_version,
    kekKeyReference: row.kek_key_reference,
    wrappedDek: row.wrapped_dek,
    createdAt: row.created_at,
  };
}

function rotationMetadata(
  row: DekRotationOperationRow,
): VaultDekMetadata | undefined {
  if (
    row.kek_key_reference === null ||
    row.wrapped_dek === null ||
    row.key_created_at === null
  ) {
    if (
      row.kek_key_reference !== null ||
      row.wrapped_dek !== null ||
      row.key_created_at !== null
    ) {
      return invalidRotationRow();
    }
    return undefined;
  }
  return {
    vaultId: row.vault_id,
    dekVersion: row.target_version,
    kekKeyReference: row.kek_key_reference,
    wrappedDek: row.wrapped_dek,
    createdAt: row.key_created_at,
  };
}

function invalidRotationRow(): never {
  throw new BoundaryDecodeError('D1 DEK rotation operation row', [
    { path: ['state'], reason: 'state-specific columns are inconsistent' },
  ]);
}

import {
  arrayDecoder,
  decodeOrThrow,
  objectDecoder,
  safeIntegerDecoder,
} from '../../lib/codec/core';
import type { D1DatabaseBinding } from '../../db/d1-types';
import { evaluateVaultWrappedKeyFinalization } from './core';
import type {
  VaultWrappedKeyFinalizationPort,
  VaultWrappedKeyFinalizationScope,
} from './public';

const countRowDecoder = objectDecoder(
  {
    owner_count: safeIntegerDecoder({ minimum: 0 }),
    account_count: safeIntegerDecoder({ minimum: 0 }),
    vault_count: safeIntegerDecoder({ minimum: 0 }),
    wrapped_key_count: safeIntegerDecoder({ minimum: 0 }),
  },
  { unknownFields: 'allow' },
);
const countResultDecoder = objectDecoder(
  { results: arrayDecoder(countRowDecoder, { minLength: 1, maxLength: 1 }) },
  { unknownFields: 'allow' },
);
const mutationResultDecoder = objectDecoder(
  {
    meta: objectDecoder(
      { changes: safeIntegerDecoder({ minimum: 0 }) },
      { unknownFields: 'allow' },
    ),
  },
  { unknownFields: 'allow' },
);
const remainingRowDecoder = objectDecoder(
  { count: safeIntegerDecoder({ minimum: 0 }) },
  { unknownFields: 'allow' },
);
const remainingResultDecoder = objectDecoder(
  {
    results: arrayDecoder(remainingRowDecoder, {
      minLength: 1,
      maxLength: 1,
    }),
  },
  { unknownFields: 'allow' },
);

export class D1VaultWrappedKeyFinalization implements VaultWrappedKeyFinalizationPort {
  constructor(private readonly database: D1DatabaseBinding) {}

  async finalizeVaultWrappedKeys(scope: VaultWrappedKeyFinalizationScope) {
    const results = await this.database.batch([
      this.database
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM personal_vaults
             WHERE account_id = ? AND vault_id = ?) AS owner_count,
            (SELECT COUNT(*) FROM accounts WHERE account_id = ?) AS account_count,
            (SELECT COUNT(*) FROM personal_vaults WHERE vault_id = ?) AS vault_count,
            (SELECT COUNT(*) FROM vault_dek_versions WHERE vault_id = ?) AS wrapped_key_count`,
        )
        .bind(
          scope.accountId,
          scope.vaultId,
          scope.accountId,
          scope.vaultId,
          scope.vaultId,
        ),
      this.database
        .prepare(
          `DELETE FROM vault_dek_versions
           WHERE vault_id = ?
             AND EXISTS (
               SELECT 1 FROM personal_vaults owner
               WHERE owner.account_id = ? AND owner.vault_id = ?
             )`,
        )
        .bind(scope.vaultId, scope.accountId, scope.vaultId),
      this.database
        .prepare(
          'SELECT COUNT(*) AS count FROM vault_dek_versions WHERE vault_id = ?',
        )
        .bind(scope.vaultId),
    ]);
    const beforeResult = decodeOrThrow(
      countResultDecoder,
      results[0],
      'D1 wrapped key finalization precondition',
    );
    const before = beforeResult.results[0];
    const mutation = decodeOrThrow(
      mutationResultDecoder,
      results[1],
      'D1 wrapped key finalization mutation',
    );
    const remainingResult = decodeOrThrow(
      remainingResultDecoder,
      results[2],
      'D1 wrapped key finalization confirmation',
    );
    const remaining = remainingResult.results[0];
    return evaluateVaultWrappedKeyFinalization({
      before: {
        ownerCount: decodeOrThrow(
          safeIntegerDecoder({ minimum: 0 }),
          before?.owner_count,
          'D1 wrapped key owner count',
        ),
        accountCount: decodeOrThrow(
          safeIntegerDecoder({ minimum: 0 }),
          before?.account_count,
          'D1 wrapped key account count',
        ),
        vaultCount: decodeOrThrow(
          safeIntegerDecoder({ minimum: 0 }),
          before?.vault_count,
          'D1 wrapped key Vault count',
        ),
        wrappedKeyCount: decodeOrThrow(
          safeIntegerDecoder({ minimum: 0 }),
          before?.wrapped_key_count,
          'D1 wrapped key count',
        ),
      },
      deletedCount: mutation.meta.changes,
      remainingCount: decodeOrThrow(
        safeIntegerDecoder({ minimum: 0 }),
        remaining?.count,
        'D1 remaining wrapped key count',
      ),
    });
  }
}

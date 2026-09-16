import {
  arrayDecoder,
  decodeOrThrow,
  objectDecoder,
  safeIntegerDecoder,
} from '../../lib/codec/core';
import type { AccountId, VaultContext } from '../../lib/domain/identity';
import type { D1DatabaseBinding } from '../../db/d1-types';
import type { ActiveSession, RevokedSession } from '../core/session';
import {
  evaluateAccountLiveStateFinalization,
  evaluateAccountSessionRevocation,
  planAccountSessionRevocation,
  planIdentityLink,
  planPersonalAccountProvision,
  planSessionRevocation,
  planSessionStorage,
  type PersonalAccountProvision,
  type AccountSessionRevocationCommand,
  type AccountSessionRevocationResult,
} from './core';
import type {
  ControlPlaneCommandResult,
  IdentityLookup,
  IdentityVaultControlPlane,
  PersonalAccount,
} from './public';
import {
  accountVaultRowDecoder,
  identityRowDecoder,
  mapIdentityRow,
  mapSessionRow,
  sessionRowDecoder,
  type IdentityRecord,
  type SessionTokenHash,
  type StoredSessionRecord,
} from './records';

const countResultDecoder = objectDecoder(
  {
    results: arrayDecoder(
      objectDecoder({ count: safeIntegerDecoder({ minimum: 0 }) }),
      { minLength: 1, maxLength: 1 },
    ),
  },
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

export class D1IdentityVaultControlPlane implements IdentityVaultControlPlane {
  constructor(private readonly database: D1DatabaseBinding) {}

  async findPersonalAccount(
    accountId: AccountId,
  ): Promise<PersonalAccount | undefined> {
    const input: unknown = await this.database
      .prepare(
        `SELECT a.account_id, v.vault_id,
          a.created_at AS account_created_at,
          v.created_at AS vault_created_at
         FROM accounts a
         JOIN personal_vaults v ON v.account_id = a.account_id
         WHERE a.account_id = ?`,
      )
      .bind(accountId)
      .first();
    if (input === null) return undefined;
    const row = decodeOrThrow(
      accountVaultRowDecoder,
      input,
      'D1 personal account row',
    );
    return {
      account: { accountId: row.account_id, createdAt: row.account_created_at },
      vault: {
        vaultId: row.vault_id,
        accountId: row.account_id,
        createdAt: row.vault_created_at,
      },
    };
  }

  async findIdentity(
    lookup: IdentityLookup,
  ): Promise<IdentityRecord | undefined> {
    const input: unknown = await this.database
      .prepare(
        `SELECT identity_id, account_id, provider, issuer, subject, created_at
         FROM identities
         WHERE provider = ? AND issuer = ? AND subject = ?`,
      )
      .bind(lookup.provider, lookup.issuer, lookup.subject)
      .first();
    return input === null
      ? undefined
      : mapIdentityRow(
          decodeOrThrow(identityRowDecoder, input, 'D1 identity row'),
        );
  }

  async findSessionByTokenHash(
    tokenHash: SessionTokenHash,
  ): Promise<StoredSessionRecord | undefined> {
    const input: unknown = await this.database
      .prepare(
        `SELECT session_id, account_id, vault_id, token_hash, session_epoch,
          issued_at, expires_at, revoked_at, revocation_reason
         FROM sessions WHERE token_hash = ?`,
      )
      .bind(tokenHash)
      .first();
    return input === null
      ? undefined
      : mapSessionRow(
          decodeOrThrow(sessionRowDecoder, input, 'D1 session row'),
        );
  }

  async provisionPersonalAccount(
    provision: PersonalAccountProvision,
  ): Promise<ControlPlaneCommandResult> {
    const plan = planPersonalAccountProvision(provision);
    if (plan.kind === 'rejected') return plan;
    await this.database.batch([
      this.database
        .prepare('INSERT INTO accounts(account_id, created_at) VALUES (?, ?)')
        .bind(provision.account.accountId, provision.account.createdAt),
      this.database
        .prepare(
          'INSERT INTO personal_vaults(vault_id, account_id, created_at) VALUES (?, ?, ?)',
        )
        .bind(
          provision.vault.vaultId,
          provision.vault.accountId,
          provision.vault.createdAt,
        ),
      this.database
        .prepare(
          `INSERT INTO identities(
            identity_id, account_id, provider, issuer, subject, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          provision.identity.identityId,
          provision.identity.accountId,
          provision.identity.provider,
          provision.identity.issuer,
          provision.identity.subject,
          provision.identity.createdAt,
        ),
    ]);
    return { kind: 'applied' };
  }

  async linkIdentity(
    context: VaultContext,
    identity: IdentityRecord,
  ): Promise<ControlPlaneCommandResult> {
    const plan = planIdentityLink(context, identity);
    if (plan.kind === 'rejected') return plan;
    await this.database
      .prepare(
        `INSERT INTO identities(
          identity_id, account_id, provider, issuer, subject, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        identity.identityId,
        identity.accountId,
        identity.provider,
        identity.issuer,
        identity.subject,
        identity.createdAt,
      )
      .run();
    return { kind: 'applied' };
  }

  async createSession(input: {
    readonly session: ActiveSession;
    readonly tokenHash: SessionTokenHash;
  }): Promise<ControlPlaneCommandResult> {
    const owner = await this.findPersonalAccount(input.session.accountId);
    if (owner === undefined) {
      return { kind: 'rejected', reason: 'account-mismatch' };
    }
    const plan = planSessionStorage({
      accountId: owner.account.accountId,
      vaultId: owner.vault.vaultId,
      session: input.session,
      tokenHash: input.tokenHash,
    });
    if (plan.kind === 'rejected') return plan;
    await this.database
      .prepare(
        `INSERT INTO sessions(
          session_id, account_id, vault_id, token_hash, session_epoch,
          issued_at, expires_at, revoked_at, revocation_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .bind(
        input.session.sessionId,
        input.session.accountId,
        input.session.vaultId,
        input.tokenHash,
        input.session.sessionEpoch,
        input.session.issuedAt,
        input.session.expiresAt,
      )
      .run();
    return { kind: 'applied' };
  }

  async revokeSession(
    context: VaultContext,
    session: RevokedSession,
  ): Promise<ControlPlaneCommandResult> {
    const plan = planSessionRevocation(context, session);
    if (plan.kind === 'rejected') return plan;
    const result = await this.database
      .prepare(
        `UPDATE sessions SET revoked_at = ?, revocation_reason = ?
         WHERE session_id = ? AND account_id = ? AND vault_id = ?
           AND session_epoch = ? AND revoked_at IS NULL`,
      )
      .bind(
        session.revokedAt,
        session.reason,
        session.sessionId,
        session.accountId,
        session.vaultId,
        session.sessionEpoch,
      )
      .run();
    return result.meta.changes === 1
      ? { kind: 'applied' }
      : { kind: 'rejected', reason: 'session-mismatch' };
  }

  async revokeAccountSessions(
    command: AccountSessionRevocationCommand,
  ): Promise<AccountSessionRevocationResult> {
    const plan = planAccountSessionRevocation(command);
    if (plan.kind === 'rejected') return plan;

    const results = await this.database.batch([
      this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM personal_vaults
           WHERE account_id = ? AND vault_id = ?`,
        )
        .bind(plan.command.accountId, plan.command.vaultId),
      this.database
        .prepare(
          `UPDATE sessions SET revoked_at = ?, revocation_reason = 'security'
           WHERE account_id = ? AND vault_id = ? AND revoked_at IS NULL`,
        )
        .bind(
          plan.command.revokedAt,
          plan.command.accountId,
          plan.command.vaultId,
        ),
      this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM sessions
           WHERE account_id = ? AND vault_id = ? AND revoked_at IS NULL`,
        )
        .bind(plan.command.accountId, plan.command.vaultId),
    ]);
    const mutation = decodeOrThrow(
      mutationResultDecoder,
      results[1],
      'D1 account session revocation result',
    );
    return evaluateAccountSessionRevocation({
      ownerCount: countFromResult(results[0], 'D1 account session owner count'),
      revokedSessionCount: mutation.meta.changes,
      remainingActiveSessionCount: countFromResult(
        results[2],
        'D1 remaining active session count',
      ),
    });
  }

  async finalizeAccountLiveState(scope: {
    readonly accountId: AccountId;
    readonly vaultId: VaultContext['vaultId'];
  }) {
    const results = await this.database.batch([
      liveStateCount(this.database, scope.accountId, scope.vaultId),
      this.database
        .prepare(
          `DELETE FROM sessions
           WHERE account_id = ? AND vault_id = ?
             AND EXISTS (
               SELECT 1 FROM personal_vaults owner
               WHERE owner.account_id = ? AND owner.vault_id = ?
             )`,
        )
        .bind(scope.accountId, scope.vaultId, scope.accountId, scope.vaultId),
      this.database
        .prepare(
          `DELETE FROM identities
           WHERE account_id = ?
             AND EXISTS (
               SELECT 1 FROM personal_vaults owner
               WHERE owner.account_id = ? AND owner.vault_id = ?
             )`,
        )
        .bind(scope.accountId, scope.accountId, scope.vaultId),
      this.database
        .prepare(
          'DELETE FROM personal_vaults WHERE account_id = ? AND vault_id = ?',
        )
        .bind(scope.accountId, scope.vaultId),
      this.database
        .prepare(
          `DELETE FROM accounts
           WHERE account_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM personal_vaults vault
               WHERE vault.account_id = accounts.account_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM identities identity
               WHERE identity.account_id = accounts.account_id
             )`,
        )
        .bind(scope.accountId),
      liveStateCount(this.database, scope.accountId, scope.vaultId),
    ]);
    const deletedAccount = decodeOrThrow(
      mutationResultDecoder,
      results[4],
      'D1 Account live-state finalization mutation',
    );
    return evaluateAccountLiveStateFinalization({
      before: liveStateCounts(
        results[0],
        'D1 Account live-state finalization precondition',
      ),
      deletedAccountCount: deletedAccount.meta.changes,
      after: liveStateCounts(
        results[5],
        'D1 Account live-state finalization confirmation',
      ),
    });
  }
}

function countFromResult(input: unknown, context: string): number {
  const decoded = decodeOrThrow(countResultDecoder, input, context);
  const row = decoded.results[0];
  return decodeOrThrow(safeIntegerDecoder({ minimum: 0 }), row?.count, context);
}

const liveStateCountRowDecoder = objectDecoder(
  {
    owner_count: safeIntegerDecoder({ minimum: 0 }),
    account_count: safeIntegerDecoder({ minimum: 0 }),
    vault_count: safeIntegerDecoder({ minimum: 0 }),
    identity_count: safeIntegerDecoder({ minimum: 0 }),
    session_count: safeIntegerDecoder({ minimum: 0 }),
  },
  { unknownFields: 'allow' },
);

const liveStateCountResultDecoder = objectDecoder(
  {
    results: arrayDecoder(liveStateCountRowDecoder, {
      minLength: 1,
      maxLength: 1,
    }),
  },
  { unknownFields: 'allow' },
);

function liveStateCount(
  database: D1DatabaseBinding,
  accountId: AccountId,
  vaultId: VaultContext['vaultId'],
) {
  return database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM personal_vaults
         WHERE account_id = ? AND vault_id = ?) AS owner_count,
        (SELECT COUNT(*) FROM accounts WHERE account_id = ?) AS account_count,
        (SELECT COUNT(*) FROM personal_vaults WHERE vault_id = ?) AS vault_count,
        (SELECT COUNT(*) FROM identities WHERE account_id = ?) AS identity_count,
        (SELECT COUNT(*) FROM sessions
         WHERE account_id = ? OR vault_id = ?) AS session_count`,
    )
    .bind(
      accountId,
      vaultId,
      accountId,
      vaultId,
      accountId,
      accountId,
      vaultId,
    );
}

function liveStateCounts(input: unknown, context: string) {
  const decoded = decodeOrThrow(liveStateCountResultDecoder, input, context);
  const row = decoded.results[0];
  return {
    ownerCount: decodeOrThrow(
      safeIntegerDecoder({ minimum: 0 }),
      row?.owner_count,
      `${context} owner count`,
    ),
    accountCount: decodeOrThrow(
      safeIntegerDecoder({ minimum: 0 }),
      row?.account_count,
      `${context} Account count`,
    ),
    vaultCount: decodeOrThrow(
      safeIntegerDecoder({ minimum: 0 }),
      row?.vault_count,
      `${context} Vault count`,
    ),
    identityCount: decodeOrThrow(
      safeIntegerDecoder({ minimum: 0 }),
      row?.identity_count,
      `${context} identity count`,
    ),
    sessionCount: decodeOrThrow(
      safeIntegerDecoder({ minimum: 0 }),
      row?.session_count,
      `${context} session count`,
    ),
  };
}

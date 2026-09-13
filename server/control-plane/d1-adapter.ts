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
}

function countFromResult(input: unknown, context: string): number {
  const decoded = decodeOrThrow(countResultDecoder, input, context);
  const row = decoded.results[0];
  return decodeOrThrow(safeIntegerDecoder({ minimum: 0 }), row?.count, context);
}

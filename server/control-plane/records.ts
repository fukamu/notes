import {
  BoundaryDecodeError,
  literalDecoder,
  nullableDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
  type InferDecoder,
} from '../../lib/codec/core';
import {
  accountIdDecoder,
  identityIdDecoder,
  sessionEpochDecoder,
  sessionIdDecoder,
  vaultIdDecoder,
  type AccountId,
  type IdentityId,
  type SessionId,
  type VaultId,
} from '../../lib/domain/identity';
import {
  sessionRecordDecoder,
  type SessionRecord,
  type SessionRevocationReason,
} from '../core/session';

declare const sessionTokenHashBrand: unique symbol;

export type SessionTokenHash = string & {
  readonly [sessionTokenHashBrand]: 'SessionTokenHash';
};

export type IdentityProvider = 'google-oidc' | 'email-otp';

export type AccountRecord = {
  readonly accountId: AccountId;
  readonly createdAt: number;
};

export type PersonalVaultRecord = {
  readonly vaultId: VaultId;
  readonly accountId: AccountId;
  readonly createdAt: number;
};

export type IdentityRecord = {
  readonly identityId: IdentityId;
  readonly accountId: AccountId;
  readonly provider: IdentityProvider;
  readonly issuer: string;
  readonly subject: string;
  readonly createdAt: number;
};

export type StoredSessionRecord = {
  readonly session: SessionRecord;
  readonly tokenHash: SessionTokenHash;
};

const timestampDecoder = safeIntegerDecoder({ minimum: 0 });
const identityProviderDecoder = unionDecoder(
  literalDecoder('google-oidc'),
  literalDecoder('email-otp'),
);
const issuerDecoder = stringDecoder({ minLength: 1, maxLength: 2_048 });
const subjectDecoder = stringDecoder({ minLength: 1, maxLength: 320 });

export const sessionTokenHashDecoder: Decoder<SessionTokenHash> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 43, maxLength: 43 }),
      (value) => /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value),
      'expected an unpadded SHA-256 base64url digest',
    ),
    (value) => value as SessionTokenHash,
  );

export const accountRecordDecoder: Decoder<AccountRecord> = transformDecoder(
  objectDecoder({ accountId: accountIdDecoder, createdAt: timestampDecoder }),
  (record): AccountRecord => record,
);

export const personalVaultRecordDecoder: Decoder<PersonalVaultRecord> =
  transformDecoder(
    objectDecoder({
      vaultId: vaultIdDecoder,
      accountId: accountIdDecoder,
      createdAt: timestampDecoder,
    }),
    (record): PersonalVaultRecord => record,
  );

export const identityRecordDecoder: Decoder<IdentityRecord> = transformDecoder(
  objectDecoder({
    identityId: identityIdDecoder,
    accountId: accountIdDecoder,
    provider: identityProviderDecoder,
    issuer: issuerDecoder,
    subject: subjectDecoder,
    createdAt: timestampDecoder,
  }),
  (record): IdentityRecord => record,
);

export const accountVaultRowDecoder = objectDecoder({
  account_id: accountIdDecoder,
  vault_id: vaultIdDecoder,
  account_created_at: timestampDecoder,
  vault_created_at: timestampDecoder,
});

export const identityRowDecoder = objectDecoder({
  identity_id: identityIdDecoder,
  account_id: accountIdDecoder,
  provider: identityProviderDecoder,
  issuer: issuerDecoder,
  subject: subjectDecoder,
  created_at: timestampDecoder,
});

const revocationReasonDecoder = nullableDecoder(
  unionDecoder(
    literalDecoder('logout'),
    literalDecoder('rotated'),
    literalDecoder('security'),
  ),
);

export const sessionRowDecoder = objectDecoder({
  session_id: sessionIdDecoder,
  account_id: accountIdDecoder,
  vault_id: vaultIdDecoder,
  token_hash: sessionTokenHashDecoder,
  session_epoch: sessionEpochDecoder,
  issued_at: timestampDecoder,
  expires_at: timestampDecoder,
  revoked_at: nullableDecoder(timestampDecoder),
  revocation_reason: revocationReasonDecoder,
});

export type AccountVaultRow = InferDecoder<typeof accountVaultRowDecoder>;
export type IdentityRow = InferDecoder<typeof identityRowDecoder>;
export type SessionRow = InferDecoder<typeof sessionRowDecoder>;

export function mapIdentityRow(row: IdentityRow): IdentityRecord {
  return {
    identityId: row.identity_id,
    accountId: row.account_id,
    provider: row.provider,
    issuer: row.issuer,
    subject: row.subject,
    createdAt: row.created_at,
  };
}

export function mapSessionRow(row: SessionRow): StoredSessionRecord {
  const common = {
    sessionId: row.session_id,
    accountId: row.account_id,
    vaultId: row.vault_id,
    sessionEpoch: row.session_epoch,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
  };
  let candidate: unknown;
  if (row.revoked_at === null && row.revocation_reason === null) {
    candidate = { kind: 'active', ...common };
  } else if (row.revoked_at !== null && row.revocation_reason !== null) {
    const reason: SessionRevocationReason = row.revocation_reason;
    candidate = {
      kind: 'revoked',
      ...common,
      revokedAt: row.revoked_at,
      reason,
    };
  } else {
    return invalidSessionRow(row.session_id, 'incomplete revocation state');
  }
  const decoded = sessionRecordDecoder.decode(candidate);
  if (!decoded.ok) {
    throw new BoundaryDecodeError('D1 session row', decoded.issues);
  }
  return { session: decoded.value, tokenHash: row.token_hash };
}

function invalidSessionRow(sessionId: SessionId, reason: string): never {
  throw new BoundaryDecodeError('D1 session row', [
    { path: ['session_id'], reason: `${reason}: ${sessionId}` },
  ]);
}

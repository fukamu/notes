import { validate as validateUuid, version as uuidVersion } from 'uuid';
import {
  decodeOrThrow,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  type Decoder,
} from '../codec/core';

declare const identityIdentifierBrand: unique symbol;
declare const sessionEpochBrand: unique symbol;
declare const sessionTokenBrand: unique symbol;

type IdentityIdentifier<TName extends string> = string & {
  readonly [identityIdentifierBrand]: TName;
};

export type AccountId = IdentityIdentifier<'AccountId'>;
export type VaultId = IdentityIdentifier<'VaultId'>;
export type SessionId = IdentityIdentifier<'SessionId'>;
export type IdentityId = IdentityIdentifier<'IdentityId'>;
export type SessionEpoch = number & {
  readonly [sessionEpochBrand]: 'SessionEpoch';
};
export type SessionToken = string & {
  readonly [sessionTokenBrand]: 'SessionToken';
};

export type VaultContext = {
  readonly accountId: AccountId;
  readonly vaultId: VaultId;
  readonly sessionId: SessionId;
  readonly sessionEpoch: SessionEpoch;
};

const uuidV7StringDecoder = refineDecoder(
  stringDecoder({ minLength: 36, maxLength: 36 }),
  (value) => validateUuid(value) && uuidVersion(value) === 7,
  'expected UUIDv7',
);

export const accountIdDecoder: Decoder<AccountId> = transformDecoder(
  uuidV7StringDecoder,
  // The shared UUIDv7 check above is the runtime proof for this brand.
  (value) => value as AccountId,
);
export const vaultIdDecoder: Decoder<VaultId> = transformDecoder(
  uuidV7StringDecoder,
  (value) => value as VaultId,
);
export const sessionIdDecoder: Decoder<SessionId> = transformDecoder(
  uuidV7StringDecoder,
  (value) => value as SessionId,
);
export const identityIdDecoder: Decoder<IdentityId> = transformDecoder(
  uuidV7StringDecoder,
  (value) => value as IdentityId,
);

export const sessionEpochDecoder: Decoder<SessionEpoch> = transformDecoder(
  safeIntegerDecoder({ minimum: 1, maximum: 2_147_483_647 }),
  // The integer range check above is the runtime proof for this brand.
  (value) => value as SessionEpoch,
);

export const sessionTokenDecoder: Decoder<SessionToken> = transformDecoder(
  refineDecoder(
    stringDecoder({ minLength: 43, maxLength: 43 }),
    (value) => /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value),
    'expected an unpadded 256-bit base64url token',
  ),
  // The fixed base64url shape above prevents cookie delimiter injection.
  (value) => value as SessionToken,
);

export function parseAccountId(input: unknown): AccountId {
  return decodeOrThrow(accountIdDecoder, input, 'AccountId');
}

export function parseVaultId(input: unknown): VaultId {
  return decodeOrThrow(vaultIdDecoder, input, 'VaultId');
}

export function parseSessionId(input: unknown): SessionId {
  return decodeOrThrow(sessionIdDecoder, input, 'SessionId');
}

export function parseIdentityId(input: unknown): IdentityId {
  return decodeOrThrow(identityIdDecoder, input, 'IdentityId');
}

export function parseSessionEpoch(input: unknown): SessionEpoch {
  return decodeOrThrow(sessionEpochDecoder, input, 'SessionEpoch');
}

export function parseSessionToken(input: unknown): SessionToken {
  return decodeOrThrow(sessionTokenDecoder, input, 'SessionToken');
}

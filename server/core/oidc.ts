import {
  arrayDecoder,
  booleanDecoder,
  literalDecoder,
  objectDecoder,
  optionalDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
} from '../../lib/codec/core';
import {
  accountIdDecoder,
  identityIdDecoder,
  vaultIdDecoder,
  type AccountId,
  type IdentityId,
  type SessionEpoch,
  type SessionId,
  type SessionToken,
  type VaultId,
} from '../../lib/domain/identity';
import {
  oidcAuthorizationCodeDecoder,
  oidcAuthorizationEndpointDecoder,
  oidcClientIdDecoder,
  oidcIssuerDecoder,
  oidcNonceDecoder,
  oidcRedirectUriDecoder,
  oidcStateDecoder,
  oidcSubjectDecoder,
  oidcEmailAddressDecoder,
  pkceCodeVerifierDecoder,
  type OidcAuthorizationCode,
  type OidcAuthorizationEndpoint,
  type OidcClientId,
  type OidcIssuer,
  type OidcNonce,
  type OidcRedirectUri,
  type OidcState,
  type OidcSubject,
  type OidcEmailAddress,
  type PkceCodeChallenge,
  type PkceCodeVerifier,
} from '../../lib/domain/oidc';
import {
  createActiveSession,
  rotateSession,
  type ActiveSession,
  type RotateSessionDecision,
} from './session';

export const OIDC_TRANSACTION_TTL_SECONDS = 600;
export const OIDC_CLOCK_SKEW_SECONDS = 60;

const epochSecondsDecoder = safeIntegerDecoder({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});

export type OidcPurpose =
  | { readonly kind: 'sign-in' }
  | { readonly kind: 'link'; readonly accountId: AccountId };

const oidcPurposeDecoder = unionDecoder(
  objectDecoder({ kind: literalDecoder('sign-in') }),
  objectDecoder({ kind: literalDecoder('link'), accountId: accountIdDecoder }),
);

export type PendingOidcTransaction = {
  readonly state: OidcState;
  readonly nonce: OidcNonce;
  readonly codeVerifier: PkceCodeVerifier;
  readonly redirectUri: OidcRedirectUri;
  readonly purpose: OidcPurpose;
  readonly createdAtEpochSeconds: number;
  readonly expiresAtEpochSeconds: number;
};

const pendingOidcTransactionShapeDecoder = refineDecoder(
  objectDecoder({
    state: oidcStateDecoder,
    nonce: oidcNonceDecoder,
    codeVerifier: pkceCodeVerifierDecoder,
    redirectUri: oidcRedirectUriDecoder,
    purpose: oidcPurposeDecoder,
    createdAtEpochSeconds: epochSecondsDecoder,
    expiresAtEpochSeconds: epochSecondsDecoder,
  }),
  (transaction) =>
    !sameOpaqueValue(transaction.state, transaction.nonce) &&
    transaction.expiresAtEpochSeconds > transaction.createdAtEpochSeconds &&
    transaction.expiresAtEpochSeconds - transaction.createdAtEpochSeconds <=
      OIDC_TRANSACTION_TTL_SECONDS,
  'expected a bounded OIDC transaction with independent state and nonce',
);

export const pendingOidcTransactionDecoder: Decoder<PendingOidcTransaction> =
  transformDecoder(
    pendingOidcTransactionShapeDecoder,
    (transaction): PendingOidcTransaction => transaction,
  );

export type OidcProviderConfiguration = {
  readonly authorizationEndpoint: OidcAuthorizationEndpoint;
  readonly clientId: OidcClientId;
  readonly allowedIssuers: readonly OidcIssuer[];
  readonly redirectUris: readonly OidcRedirectUri[];
};

const oidcProviderConfigurationShapeDecoder = objectDecoder({
  authorizationEndpoint: oidcAuthorizationEndpointDecoder,
  clientId: oidcClientIdDecoder,
  allowedIssuers: arrayDecoder(oidcIssuerDecoder, {
    minLength: 1,
    maxLength: 4,
    uniqueBy: (value) => value,
  }),
  redirectUris: arrayDecoder(oidcRedirectUriDecoder, {
    minLength: 1,
    maxLength: 8,
    uniqueBy: (value) => value,
  }),
});

export const oidcProviderConfigurationDecoder: Decoder<OidcProviderConfiguration> =
  transformDecoder(
    oidcProviderConfigurationShapeDecoder,
    (configuration): OidcProviderConfiguration => configuration,
  );

export type OidcCallback =
  | {
      readonly kind: 'authorization-code';
      readonly state: OidcState;
      readonly code: OidcAuthorizationCode;
    }
  | {
      readonly kind: 'provider-error';
      readonly state: OidcState;
      readonly error: string;
    };

const providerErrorDecoder = refineDecoder(
  stringDecoder({ minLength: 1, maxLength: 256 }),
  (value) => /^[\x21-\x7e]+$/.test(value),
  'expected a visible ASCII provider error code',
);

const oidcCallbackShapeDecoder = refineDecoder(
  objectDecoder(
    {
      state: oidcStateDecoder,
      code: optionalDecoder(oidcAuthorizationCodeDecoder),
      error: optionalDecoder(providerErrorDecoder),
      error_description: optionalDecoder(
        stringDecoder({ minLength: 0, maxLength: 1_024 }),
      ),
    },
    { unknownFields: 'allow' },
  ),
  (callback) =>
    (callback.code === undefined) !== (callback.error === undefined) &&
    (callback.error !== undefined || callback.error_description === undefined),
  'expected exactly one authorization code or provider error',
);

export const oidcCallbackDecoder: Decoder<OidcCallback> = transformDecoder(
  oidcCallbackShapeDecoder,
  (callback): OidcCallback => {
    if (callback.code !== undefined) {
      return {
        kind: 'authorization-code',
        state: callback.state,
        code: callback.code,
      };
    }
    return {
      kind: 'provider-error',
      state: callback.state,
      error: callback.error ?? 'invalid_provider_error',
    };
  },
);

const audienceDecoder = unionDecoder(
  oidcClientIdDecoder,
  arrayDecoder(oidcClientIdDecoder, {
    minLength: 1,
    maxLength: 16,
    uniqueBy: (value) => value,
  }),
);

export type VerifiedOidcClaims = {
  readonly issuer: OidcIssuer;
  readonly subject: OidcSubject;
  readonly audience: OidcClientId | readonly OidcClientId[];
  readonly authorizedParty?: OidcClientId;
  readonly expiresAtEpochSeconds: number;
  readonly issuedAtEpochSeconds: number;
  readonly nonce: OidcNonce;
  readonly email: OidcEmailAddress;
};

const oidcClaimsShapeDecoder = objectDecoder(
  {
    iss: oidcIssuerDecoder,
    sub: oidcSubjectDecoder,
    aud: audienceDecoder,
    azp: optionalDecoder(oidcClientIdDecoder),
    exp: epochSecondsDecoder,
    iat: epochSecondsDecoder,
    nonce: oidcNonceDecoder,
    email: oidcEmailAddressDecoder,
    email_verified: booleanDecoder,
  },
  { unknownFields: 'allow' },
);

export const verifiedOidcClaimsDecoder: Decoder<VerifiedOidcClaims> =
  transformDecoder(
    refineDecoder(
      oidcClaimsShapeDecoder,
      (claims) => claims.email_verified,
      'expected a provider-verified email claim',
    ),
    (claims): VerifiedOidcClaims => ({
      issuer: claims.iss,
      subject: claims.sub,
      audience: claims.aud,
      ...(claims.azp === undefined ? {} : { authorizedParty: claims.azp }),
      expiresAtEpochSeconds: claims.exp,
      issuedAtEpochSeconds: claims.iat,
      nonce: claims.nonce,
      email: claims.email,
    }),
  );

export type CreateOidcTransactionDecision =
  | {
      readonly kind: 'created';
      readonly transaction: PendingOidcTransaction;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-clock'
        | 'redirect-not-allowed'
        | 'state-nonce-reused';
    };

export function createOidcTransaction(input: {
  readonly configuration: OidcProviderConfiguration;
  readonly state: OidcState;
  readonly nonce: OidcNonce;
  readonly codeVerifier: PkceCodeVerifier;
  readonly redirectUri: OidcRedirectUri;
  readonly purpose: OidcPurpose;
  readonly nowEpochSeconds: number;
}): CreateOidcTransactionDecision {
  if (
    !Number.isSafeInteger(input.nowEpochSeconds) ||
    input.nowEpochSeconds < 0 ||
    input.nowEpochSeconds >
      Number.MAX_SAFE_INTEGER - OIDC_TRANSACTION_TTL_SECONDS
  ) {
    return { kind: 'rejected', reason: 'invalid-clock' };
  }
  if (!input.configuration.redirectUris.includes(input.redirectUri)) {
    return { kind: 'rejected', reason: 'redirect-not-allowed' };
  }
  if (
    sameOpaqueValue(input.state, input.nonce) ||
    sameOpaqueValue(input.state, input.codeVerifier)
  ) {
    return { kind: 'rejected', reason: 'state-nonce-reused' };
  }
  return {
    kind: 'created',
    transaction: {
      state: input.state,
      nonce: input.nonce,
      codeVerifier: input.codeVerifier,
      redirectUri: input.redirectUri,
      purpose: input.purpose,
      createdAtEpochSeconds: input.nowEpochSeconds,
      expiresAtEpochSeconds:
        input.nowEpochSeconds + OIDC_TRANSACTION_TTL_SECONDS,
    },
  };
}

function sameOpaqueValue(left: string, right: string): boolean {
  return left === right;
}

export type OidcAuthorizationRequest = {
  readonly authorizationEndpoint: OidcAuthorizationEndpoint;
  readonly responseType: 'code';
  readonly clientId: OidcClientId;
  readonly redirectUri: OidcRedirectUri;
  readonly scope: 'openid email';
  readonly state: OidcState;
  readonly nonce: OidcNonce;
  readonly codeChallenge: PkceCodeChallenge;
  readonly codeChallengeMethod: 'S256';
};

export function createOidcAuthorizationRequest(
  configuration: OidcProviderConfiguration,
  transaction: PendingOidcTransaction,
  codeChallenge: PkceCodeChallenge,
): OidcAuthorizationRequest {
  return {
    authorizationEndpoint: configuration.authorizationEndpoint,
    responseType: 'code',
    clientId: configuration.clientId,
    redirectUri: transaction.redirectUri,
    scope: 'openid email',
    state: transaction.state,
    nonce: transaction.nonce,
    codeChallenge,
    codeChallengeMethod: 'S256',
  };
}

export type OidcTransactionValidation =
  | { readonly kind: 'valid' }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-clock'
        | 'state-mismatch'
        | 'expired-transaction'
        | 'redirect-not-allowed';
    };

export function validateOidcTransaction(
  transaction: PendingOidcTransaction,
  callbackState: OidcState,
  configuration: OidcProviderConfiguration,
  nowEpochSeconds: number,
): OidcTransactionValidation {
  if (!Number.isSafeInteger(nowEpochSeconds) || nowEpochSeconds < 0) {
    return { kind: 'rejected', reason: 'invalid-clock' };
  }
  if (transaction.state !== callbackState) {
    return { kind: 'rejected', reason: 'state-mismatch' };
  }
  if (nowEpochSeconds >= transaction.expiresAtEpochSeconds) {
    return { kind: 'rejected', reason: 'expired-transaction' };
  }
  return configuration.redirectUris.includes(transaction.redirectUri)
    ? { kind: 'valid' }
    : { kind: 'rejected', reason: 'redirect-not-allowed' };
}

export type OidcClaimsValidation =
  | {
      readonly kind: 'valid';
      readonly identityKey: OidcIdentityKey;
      readonly email: OidcEmailAddress;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-clock'
        | 'issuer-mismatch'
        | 'audience-mismatch'
        | 'authorized-party-mismatch'
        | 'expired-token'
        | 'invalid-issued-at'
        | 'nonce-mismatch';
    };

export type OidcIdentityKey = {
  readonly issuer: OidcIssuer;
  readonly subject: OidcSubject;
};

export function validateOidcClaims(
  claims: VerifiedOidcClaims,
  transaction: PendingOidcTransaction,
  configuration: OidcProviderConfiguration,
  nowEpochSeconds: number,
): OidcClaimsValidation {
  if (!Number.isSafeInteger(nowEpochSeconds) || nowEpochSeconds < 0) {
    return { kind: 'rejected', reason: 'invalid-clock' };
  }
  if (!configuration.allowedIssuers.includes(claims.issuer)) {
    return { kind: 'rejected', reason: 'issuer-mismatch' };
  }
  const audiences = Array.isArray(claims.audience)
    ? claims.audience
    : [claims.audience];
  if (!audiences.includes(configuration.clientId)) {
    return { kind: 'rejected', reason: 'audience-mismatch' };
  }
  if (
    (audiences.length > 1 || claims.authorizedParty !== undefined) &&
    claims.authorizedParty !== configuration.clientId
  ) {
    return { kind: 'rejected', reason: 'authorized-party-mismatch' };
  }
  if (nowEpochSeconds >= claims.expiresAtEpochSeconds) {
    return { kind: 'rejected', reason: 'expired-token' };
  }
  if (
    claims.issuedAtEpochSeconds > nowEpochSeconds + OIDC_CLOCK_SKEW_SECONDS ||
    claims.issuedAtEpochSeconds >= claims.expiresAtEpochSeconds
  ) {
    return { kind: 'rejected', reason: 'invalid-issued-at' };
  }
  if (claims.nonce !== transaction.nonce) {
    return { kind: 'rejected', reason: 'nonce-mismatch' };
  }
  return {
    kind: 'valid',
    identityKey: { issuer: claims.issuer, subject: claims.subject },
    email: claims.email,
  };
}

export type OidcIdentityRecord = {
  readonly identityId: IdentityId;
  readonly accountId: AccountId;
  readonly vaultId: VaultId;
  readonly issuer: OidcIssuer;
  readonly subject: OidcSubject;
};

export const oidcIdentityRecordDecoder: Decoder<OidcIdentityRecord> =
  transformDecoder(
    objectDecoder({
      identityId: identityIdDecoder,
      accountId: accountIdDecoder,
      vaultId: vaultIdDecoder,
      issuer: oidcIssuerDecoder,
      subject: oidcSubjectDecoder,
    }),
    (identity): OidcIdentityRecord => identity,
  );

export type OidcIdentityResolution =
  | {
      readonly kind: 'authenticate-existing';
      readonly identity: OidcIdentityRecord;
    }
  | {
      readonly kind: 'provision-account';
      readonly identityKey: OidcIdentityKey;
      readonly email: OidcEmailAddress;
    }
  | {
      readonly kind: 'link-identity';
      readonly accountId: AccountId;
      readonly identityKey: OidcIdentityKey;
      readonly email: OidcEmailAddress;
    }
  | {
      readonly kind: 'already-linked';
      readonly identity: OidcIdentityRecord;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'identity-record-mismatch'
        | 'identity-owned-by-another-account'
        | 'email-collision';
    };

export function decideOidcIdentityResolution(input: {
  readonly purpose: OidcPurpose;
  readonly identityKey: OidcIdentityKey;
  readonly email: OidcEmailAddress;
  readonly existingIdentity?: OidcIdentityRecord;
  readonly verifiedEmailAccountId?: AccountId;
}): OidcIdentityResolution {
  const { existingIdentity, identityKey, purpose, verifiedEmailAccountId } =
    input;
  if (
    existingIdentity &&
    (existingIdentity.issuer !== identityKey.issuer ||
      existingIdentity.subject !== identityKey.subject)
  ) {
    return { kind: 'rejected', reason: 'identity-record-mismatch' };
  }

  if (purpose.kind === 'sign-in') {
    if (existingIdentity) {
      return { kind: 'authenticate-existing', identity: existingIdentity };
    }
    return verifiedEmailAccountId
      ? { kind: 'rejected', reason: 'email-collision' }
      : {
          kind: 'provision-account',
          identityKey,
          email: input.email,
        };
  }

  if (existingIdentity) {
    return existingIdentity.accountId === purpose.accountId
      ? { kind: 'already-linked', identity: existingIdentity }
      : { kind: 'rejected', reason: 'identity-owned-by-another-account' };
  }
  if (
    verifiedEmailAccountId !== undefined &&
    verifiedEmailAccountId !== purpose.accountId
  ) {
    return { kind: 'rejected', reason: 'email-collision' };
  }
  return {
    kind: 'link-identity',
    accountId: purpose.accountId,
    identityKey,
    email: input.email,
  };
}

export type OidcSessionEstablishment =
  | {
      readonly kind: 'created';
      readonly session: ActiveSession;
      readonly token: SessionToken;
    }
  | Extract<RotateSessionDecision, { readonly kind: 'rotated' }>
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'account-switch-requires-logout'
        | 'missing-current-token'
        | 'initial-epoch-must-be-one'
        | 'expired'
        | 'session-id-reused'
        | 'session-token-reused'
        | 'epoch-not-incremented'
        | 'invalid-lifetime';
    };

export function establishOidcSession(input: {
  readonly principal: {
    readonly accountId: AccountId;
    readonly vaultId: VaultId;
  };
  readonly currentSession?: ActiveSession;
  readonly currentToken?: SessionToken;
  readonly nextSessionId: SessionId;
  readonly nextSessionEpoch: SessionEpoch;
  readonly nextToken: SessionToken;
  readonly now: number;
  readonly expiresAt: number;
}): OidcSessionEstablishment {
  if (!input.currentSession) {
    if (input.nextSessionEpoch !== 1) {
      return { kind: 'rejected', reason: 'initial-epoch-must-be-one' };
    }
    const created = createActiveSession({
      sessionId: input.nextSessionId,
      accountId: input.principal.accountId,
      vaultId: input.principal.vaultId,
      sessionEpoch: input.nextSessionEpoch,
      issuedAt: input.now,
      expiresAt: input.expiresAt,
    });
    return created.kind === 'created'
      ? { kind: 'created', session: created.session, token: input.nextToken }
      : created;
  }
  if (
    input.currentSession.accountId !== input.principal.accountId ||
    input.currentSession.vaultId !== input.principal.vaultId
  ) {
    return { kind: 'rejected', reason: 'account-switch-requires-logout' };
  }
  if (!input.currentToken) {
    return { kind: 'rejected', reason: 'missing-current-token' };
  }
  return rotateSession(input.currentSession, {
    nextSessionId: input.nextSessionId,
    nextSessionEpoch: input.nextSessionEpoch,
    currentToken: input.currentToken,
    nextToken: input.nextToken,
    rotatedAt: input.now,
    expiresAt: input.expiresAt,
  });
}

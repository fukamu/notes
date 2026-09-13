import {
  accountIdDecoder,
  type AccountId,
  type VaultContext,
} from '../lib/domain/identity';
import {
  oidcRedirectUriDecoder,
  oidcStateDecoder,
  oidcNonceDecoder,
  pkceCodeChallengeDecoder,
  pkceCodeVerifierDecoder,
  type OidcAuthorizationCode,
  type OidcClientId,
  type OidcRedirectUri,
  type OidcState,
  type OidcEmailAddress,
  type PkceCodeVerifier,
} from '../lib/domain/oidc';
import {
  createOidcAuthorizationRequest,
  createOidcTransaction,
  decideOidcIdentityResolution,
  oidcCallbackDecoder,
  oidcIdentityRecordDecoder,
  oidcProviderConfigurationDecoder,
  pendingOidcTransactionDecoder,
  validateOidcClaims,
  validateOidcTransaction,
  verifiedOidcClaimsDecoder,
  type OidcAuthorizationRequest,
  type OidcIdentityKey,
  type OidcIdentityRecord,
  type OidcIdentityResolution,
  type PendingOidcTransaction,
} from './core/oidc';

export type OidcClockPort = {
  nowEpochSeconds: () => unknown;
};

export type OidcSecretPort = {
  createState: () => Promise<unknown>;
  createNonce: () => Promise<unknown>;
  createCodeVerifier: () => Promise<unknown>;
};

export type PkceChallengePort = {
  deriveS256: (verifier: PkceCodeVerifier) => Promise<unknown>;
};

export type OidcTransactionStore = {
  insertPending: (transaction: PendingOidcTransaction) => Promise<void>;
  /** Atomically returns and consumes a transaction. A second call must miss. */
  consumeByState: (state: OidcState) => Promise<unknown>;
};

export type OidcCodeExchangeInput = {
  readonly code: OidcAuthorizationCode;
  readonly clientId: OidcClientId;
  readonly redirectUri: OidcRedirectUri;
  readonly codeVerifier: PkceCodeVerifier;
};

export type OidcVerifiedClaimsPort = {
  /**
   * Production adapters must exchange the code over TLS and verify the ID
   * token signature, algorithm, key source, and provider metadata before
   * returning claims. The returned external value is decoded again here.
   */
  exchangeCodeForVerifiedClaims: (
    input: OidcCodeExchangeInput,
  ) => Promise<unknown>;
};

export type OidcIdentityDirectory = {
  findByIssuerSubject: (key: OidcIdentityKey) => Promise<unknown>;
  findAccountIdByVerifiedEmail: (email: OidcEmailAddress) => Promise<unknown>;
};

export type OidcStartIntent = 'sign-in' | 'link-current-account';

export type OidcStartResult =
  | {
      readonly kind: 'redirect';
      readonly request: OidcAuthorizationRequest;
    }
  | { readonly kind: 'failed'; readonly error: 'authentication-unavailable' };

export async function startGoogleOidc(input: {
  readonly configuration: unknown;
  readonly redirectUri: unknown;
  readonly intent: OidcStartIntent;
  readonly vaultContext?: VaultContext;
  readonly clock: OidcClockPort;
  readonly secrets: OidcSecretPort;
  readonly pkce: PkceChallengePort;
  readonly transactions: OidcTransactionStore;
}): Promise<OidcStartResult> {
  const configuration = oidcProviderConfigurationDecoder.decode(
    input.configuration,
  );
  const redirectUri = oidcRedirectUriDecoder.decode(input.redirectUri);
  const now = input.clock.nowEpochSeconds();
  if (
    !configuration.ok ||
    !redirectUri.ok ||
    typeof now !== 'number' ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    (input.intent === 'link-current-account' && !input.vaultContext)
  ) {
    return { kind: 'failed', error: 'authentication-unavailable' };
  }

  try {
    const [rawState, rawNonce, rawVerifier] = await Promise.all([
      input.secrets.createState(),
      input.secrets.createNonce(),
      input.secrets.createCodeVerifier(),
    ]);
    const state = oidcStateDecoder.decode(rawState);
    const nonce = oidcNonceDecoder.decode(rawNonce);
    const verifier = pkceCodeVerifierDecoder.decode(rawVerifier);
    if (!state.ok || !nonce.ok || !verifier.ok) {
      return { kind: 'failed', error: 'authentication-unavailable' };
    }
    const purpose = oidcPurposeFromStart(input.intent, input.vaultContext);
    if (!purpose) {
      return { kind: 'failed', error: 'authentication-unavailable' };
    }
    const transaction = createOidcTransaction({
      configuration: configuration.value,
      state: state.value,
      nonce: nonce.value,
      codeVerifier: verifier.value,
      redirectUri: redirectUri.value,
      purpose,
      nowEpochSeconds: now,
    });
    if (transaction.kind === 'rejected') {
      return { kind: 'failed', error: 'authentication-unavailable' };
    }
    const rawChallenge = await input.pkce.deriveS256(verifier.value);
    const challenge = pkceCodeChallengeDecoder.decode(rawChallenge);
    if (!challenge.ok) {
      return { kind: 'failed', error: 'authentication-unavailable' };
    }
    await input.transactions.insertPending(transaction.transaction);
    return {
      kind: 'redirect',
      request: createOidcAuthorizationRequest(
        configuration.value,
        transaction.transaction,
        challenge.value,
      ),
    };
  } catch {
    return { kind: 'failed', error: 'authentication-unavailable' };
  }
}

export type OidcCompletionResult =
  | {
      readonly kind: 'resolved';
      readonly resolution: Exclude<
        OidcIdentityResolution,
        { readonly kind: 'rejected' }
      >;
    }
  | { readonly kind: 'failed'; readonly error: 'authentication-failed' };

export async function completeGoogleOidc(input: {
  readonly callback: unknown;
  readonly configuration: unknown;
  readonly clock: OidcClockPort;
  readonly transactions: OidcTransactionStore;
  readonly provider: OidcVerifiedClaimsPort;
  readonly identities: OidcIdentityDirectory;
}): Promise<OidcCompletionResult> {
  const callback = oidcCallbackDecoder.decode(input.callback);
  const configuration = oidcProviderConfigurationDecoder.decode(
    input.configuration,
  );
  const now = input.clock.nowEpochSeconds();
  if (
    !callback.ok ||
    !configuration.ok ||
    typeof now !== 'number' ||
    !Number.isSafeInteger(now) ||
    now < 0
  ) {
    return authenticationFailed();
  }

  try {
    const rawTransaction = await input.transactions.consumeByState(
      callback.value.state,
    );
    const transaction = pendingOidcTransactionDecoder.decode(rawTransaction);
    if (!transaction.ok) return authenticationFailed();
    const transactionValidation = validateOidcTransaction(
      transaction.value,
      callback.value.state,
      configuration.value,
      now,
    );
    if (
      transactionValidation.kind === 'rejected' ||
      callback.value.kind === 'provider-error'
    ) {
      return authenticationFailed();
    }

    const rawClaims = await input.provider.exchangeCodeForVerifiedClaims({
      code: callback.value.code,
      clientId: configuration.value.clientId,
      redirectUri: transaction.value.redirectUri,
      codeVerifier: transaction.value.codeVerifier,
    });
    const claims = verifiedOidcClaimsDecoder.decode(rawClaims);
    if (!claims.ok) return authenticationFailed();
    const claimsValidation = validateOidcClaims(
      claims.value,
      transaction.value,
      configuration.value,
      now,
    );
    if (claimsValidation.kind === 'rejected') return authenticationFailed();

    const [rawIdentity, rawEmailAccountId] = await Promise.all([
      input.identities.findByIssuerSubject(claimsValidation.identityKey),
      input.identities.findAccountIdByVerifiedEmail(claimsValidation.email),
    ]);
    const existingIdentity = optionalIdentity(rawIdentity);
    const verifiedEmailAccountId = optionalAccountId(rawEmailAccountId);
    if (!existingIdentity.ok || !verifiedEmailAccountId.ok) {
      return authenticationFailed();
    }
    const resolution = decideOidcIdentityResolution({
      purpose: transaction.value.purpose,
      identityKey: claimsValidation.identityKey,
      email: claimsValidation.email,
      ...(existingIdentity.value === undefined
        ? {}
        : { existingIdentity: existingIdentity.value }),
      ...(verifiedEmailAccountId.value === undefined
        ? {}
        : { verifiedEmailAccountId: verifiedEmailAccountId.value }),
    });
    return resolution.kind === 'rejected'
      ? authenticationFailed()
      : { kind: 'resolved', resolution };
  } catch {
    return authenticationFailed();
  }
}

type OptionalDecoded<T> =
  | { readonly ok: true; readonly value: T | undefined }
  | { readonly ok: false };

function optionalIdentity(input: unknown): OptionalDecoded<OidcIdentityRecord> {
  if (input === undefined) return { ok: true, value: undefined };
  const decoded = oidcIdentityRecordDecoder.decode(input);
  return decoded.ok ? { ok: true, value: decoded.value } : { ok: false };
}

function optionalAccountId(input: unknown): OptionalDecoded<AccountId> {
  if (input === undefined) return { ok: true, value: undefined };
  const decoded = accountIdDecoder.decode(input);
  return decoded.ok ? { ok: true, value: decoded.value } : { ok: false };
}

function authenticationFailed(): OidcCompletionResult {
  return { kind: 'failed', error: 'authentication-failed' };
}

function oidcPurposeFromStart(
  intent: OidcStartIntent,
  context: VaultContext | undefined,
):
  | { readonly kind: 'sign-in' }
  | { readonly kind: 'link'; readonly accountId: AccountId }
  | undefined {
  if (intent === 'sign-in') return { kind: 'sign-in' };
  return context ? { kind: 'link', accountId: context.accountId } : undefined;
}

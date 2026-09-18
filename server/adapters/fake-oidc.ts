import type { AccountId } from '../../lib/domain/identity';
import type { OidcEmailAddress, OidcState } from '../../lib/domain/oidc';
import type {
  OidcIdentityKey,
  OidcIdentityRecord,
  PendingOidcTransaction,
} from '../core/oidc';
import type {
  OidcIdentityDirectory,
  OidcCodeExchangeInput,
  OidcSecretPort,
  OidcTransactionStore,
  OidcVerifiedClaimsPort,
} from '../oidc-boundary';

export function createFakeOidcSecrets(input: {
  readonly state: unknown;
  readonly nonce: unknown;
  readonly codeVerifier: unknown;
}): OidcSecretPort {
  return {
    async createState() {
      return input.state;
    },
    async createNonce() {
      return input.nonce;
    },
    async createCodeVerifier() {
      return input.codeVerifier;
    },
  };
}

export type FakeOidcTransactionStore = OidcTransactionStore & {
  readonly remaining: () => number;
};

export function createFakeOidcTransactionStore(): FakeOidcTransactionStore {
  const pending = new Map<OidcState, PendingOidcTransaction>();
  return {
    async insertPending(transaction) {
      if (pending.has(transaction.state)) {
        throw new Error('duplicate fake OIDC state');
      }
      pending.set(transaction.state, transaction);
    },
    async consumeByState(state) {
      const transaction = pending.get(state);
      pending.delete(state);
      return transaction;
    },
    remaining() {
      return pending.size;
    },
  };
}

export type FakeOidcProvider = OidcVerifiedClaimsPort & {
  readonly exchanges: () => readonly OidcCodeExchangeInput[];
};

export function createFakeOidcProvider(
  claimsByCode: ReadonlyMap<string, unknown>,
): FakeOidcProvider {
  const exchanges: OidcCodeExchangeInput[] = [];
  return {
    async exchangeCodeForVerifiedClaims(input) {
      exchanges.push(input);
      const claims = claimsByCode.get(input.code);
      if (claims === undefined) throw new Error('unknown fake code');
      return claims;
    },
    exchanges() {
      return [...exchanges];
    },
  };
}

export function createFakeOidcIdentityDirectory(
  input: {
    readonly identities?: readonly OidcIdentityRecord[];
    readonly emailAccounts?: ReadonlyMap<OidcEmailAddress, AccountId>;
  } = {},
): OidcIdentityDirectory {
  const identities = input.identities ?? [];
  const emailAccounts =
    input.emailAccounts ?? new Map<OidcEmailAddress, AccountId>();
  return {
    async findByIssuerSubject(key: OidcIdentityKey) {
      return identities.find(
        (identity) =>
          identity.issuer === key.issuer && identity.subject === key.subject,
      );
    },
    async findAccountIdByVerifiedEmail(email) {
      return emailAccounts.get(email);
    },
  };
}

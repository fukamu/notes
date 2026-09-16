import type { AccountId } from '../../lib/domain/identity';
import type { EmailOtpAddress } from '../../lib/domain/email-otp';
import {
  reserveEmailOtpRateLimit,
  type EmailOtpChallenge,
  type EmailOtpIdentityRecord,
  type EmailOtpRateLimitBucket,
} from '../core/email-otp';
import type {
  EmailDeliveryPort,
  EmailOtpAbuseKeyPort,
  EmailOtpChallengeStore,
  EmailOtpDeliveryInput,
  EmailOtpHasherPort,
  EmailOtpIdentityDirectory,
  EmailOtpRateLimitKeys,
  EmailOtpRateLimitPort,
  EmailOtpSecretPort,
} from '../email-otp-boundary';

export function createFakeEmailOtpAbuseKeys(
  keys: EmailOtpRateLimitKeys,
): EmailOtpAbuseKeyPort {
  return {
    async deriveKeys(input) {
      return input.accountId === undefined
        ? { address: keys.address, network: keys.network }
        : {
            address: keys.address,
            network: keys.network,
            account: keys.account,
          };
    },
  };
}

export function createFakeEmailOtpSecrets(input: {
  readonly challengeIds: readonly unknown[];
  readonly codes: readonly unknown[];
  readonly salts: readonly unknown[];
}): EmailOtpSecretPort {
  let challengeIndex = 0;
  let codeIndex = 0;
  let saltIndex = 0;
  return {
    async createChallengeId() {
      const result = valueAt(input.challengeIds, challengeIndex);
      challengeIndex += 1;
      return result;
    },
    async createCode() {
      const result = valueAt(input.codes, codeIndex);
      codeIndex += 1;
      return result;
    },
    async createSalt() {
      const result = valueAt(input.salts, saltIndex);
      saltIndex += 1;
      return result;
    },
  };
}

function valueAt(values: readonly unknown[], index: number): unknown {
  if (index >= values.length) throw new Error('fake OTP secret exhausted');
  return values[index];
}

export function createFakeEmailOtpHasher(
  pepper = 'fake-email-otp-pepper-not-for-production',
): EmailOtpHasherPort {
  return {
    async createDigest(input) {
      return sha256Base64Url(
        [pepper, input.challengeId, input.address, input.salt, input.code]
          .map(frame)
          .join(''),
      );
    },
    async matchesDigest(input) {
      const candidate = await sha256Base64Url(
        [pepper, input.challengeId, input.address, input.salt, input.code]
          .map(frame)
          .join(''),
      );
      return constantTimeAsciiEqual(candidate, input.expectedDigest);
    },
  };
}

function frame(value: string): string {
  return `${value.length}:${value}`;
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  const binary = String.fromCharCode(...new Uint8Array(digest));
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function constantTimeAsciiEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const iterations = Math.max(left.length, right.length);
  for (let index = 0; index < iterations; index += 1) {
    difference |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export type FakeEmailOtpChallengeStore = EmailOtpChallengeStore & {
  readonly records: () => readonly EmailOtpChallenge[];
};

export function createFakeEmailOtpChallengeStore(): FakeEmailOtpChallengeStore {
  const records = new Map<string, EmailOtpChallenge>();
  return {
    async insertPending(challenge) {
      if (records.has(challenge.challengeId)) {
        throw new Error('duplicate fake Email OTP challenge');
      }
      records.set(challenge.challengeId, challenge);
    },
    async findById(challengeId) {
      return records.get(challengeId);
    },
    async compareAndSwap(challengeId, expectedVersion, next) {
      const current = records.get(challengeId);
      if (!current || current.version !== expectedVersion) return false;
      records.set(challengeId, next);
      return true;
    },
    records() {
      return [...records.values()];
    },
  };
}

export type FakeEmailDelivery = EmailDeliveryPort & {
  readonly messages: () => readonly EmailOtpDeliveryInput[];
};

export function createFakeEmailDelivery(
  input: {
    readonly fail?: (message: EmailOtpDeliveryInput) => boolean;
  } = {},
): FakeEmailDelivery {
  const messages: EmailOtpDeliveryInput[] = [];
  return {
    async sendOtp(message) {
      if (input.fail?.(message) === true) {
        throw new Error('fake Email OTP delivery failure');
      }
      messages.push(message);
    },
    messages() {
      return [...messages];
    },
  };
}

export type FakeEmailOtpRateLimits = EmailOtpRateLimitPort & {
  readonly count: (kind: keyof EmailOtpRateLimitKeys, key: string) => number;
};

export function createFakeEmailOtpRateLimits(): FakeEmailOtpRateLimits {
  const buckets = new Map<string, EmailOtpRateLimitBucket>();
  return {
    async reserve(keys, nowEpochSeconds) {
      const state = {
        address: getBucket(buckets, 'address', keys.address, nowEpochSeconds),
        network: getBucket(buckets, 'network', keys.network, nowEpochSeconds),
        ...(keys.account === undefined
          ? {}
          : {
              account: getBucket(
                buckets,
                'account',
                keys.account,
                nowEpochSeconds,
              ),
            }),
      };
      const decision = reserveEmailOtpRateLimit(state, nowEpochSeconds);
      if (decision.kind === 'rejected') return false;
      setBucket(buckets, 'address', decision.state.address);
      setBucket(buckets, 'network', decision.state.network);
      if (decision.state.account !== undefined) {
        setBucket(buckets, 'account', decision.state.account);
      }
      return true;
    },
    count(kind, key) {
      return buckets.get(bucketMapKey(kind, key))?.count ?? 0;
    },
  };
}

function getBucket(
  buckets: ReadonlyMap<string, EmailOtpRateLimitBucket>,
  kind: keyof EmailOtpRateLimitKeys,
  key: EmailOtpRateLimitBucket['key'],
  nowEpochSeconds: number,
): EmailOtpRateLimitBucket {
  return (
    buckets.get(bucketMapKey(kind, key)) ?? {
      key,
      count: 0,
      windowStartedAtEpochSeconds: nowEpochSeconds,
    }
  );
}

function setBucket(
  buckets: Map<string, EmailOtpRateLimitBucket>,
  kind: keyof EmailOtpRateLimitKeys,
  bucket: EmailOtpRateLimitBucket,
): void {
  buckets.set(bucketMapKey(kind, bucket.key), bucket);
}

function bucketMapKey(kind: keyof EmailOtpRateLimitKeys, key: string): string {
  return `${kind}:${key}`;
}

export function createFakeEmailOtpIdentityDirectory(
  input: {
    readonly identities?: readonly EmailOtpIdentityRecord[];
    readonly verifiedContacts?: ReadonlyMap<EmailOtpAddress, AccountId>;
  } = {},
): EmailOtpIdentityDirectory {
  const identities = input.identities ?? [];
  const contacts =
    input.verifiedContacts ?? new Map<EmailOtpAddress, AccountId>();
  return {
    async findByAddress(address) {
      return identities.find((identity) => identity.address === address);
    },
    async findAccountIdByVerifiedContact(address) {
      return contacts.get(address);
    },
  };
}

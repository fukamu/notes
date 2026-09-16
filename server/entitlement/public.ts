import {
  decodeOrThrow,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  type Decoder,
} from '../../lib/codec/core';
import type { VaultContext } from '../../lib/domain/identity';
import { validate as validateUuid, version as uuidVersion } from 'uuid';

declare const entitlementIdentifierBrand: unique symbol;
declare const entitlementVersionBrand: unique symbol;
declare const offlineLeaseDurationBrand: unique symbol;

export type OfflineLeaseId = string & {
  readonly [entitlementIdentifierBrand]: 'OfflineLeaseId';
};
export type EntitlementProjectionVersion = number & {
  readonly [entitlementVersionBrand]: 'EntitlementProjectionVersion';
};
export type OfflineLeaseDuration = number & {
  readonly [offlineLeaseDurationBrand]: 'OfflineLeaseDuration';
};

const uuidV7Decoder = refineDecoder(
  stringDecoder({ minLength: 36, maxLength: 36 }),
  (value) => validateUuid(value) && uuidVersion(value) === 7,
  'expected UUIDv7',
);

export const offlineLeaseIdDecoder: Decoder<OfflineLeaseId> = transformDecoder(
  uuidV7Decoder,
  (value) => value as OfflineLeaseId,
);
export const entitlementProjectionVersionDecoder: Decoder<EntitlementProjectionVersion> =
  transformDecoder(
    safeIntegerDecoder({ minimum: 1, maximum: 2_147_483_647 }),
    (value) => value as EntitlementProjectionVersion,
  );
export const offlineLeaseDurationDecoder: Decoder<OfflineLeaseDuration> =
  transformDecoder(
    safeIntegerDecoder({ minimum: 1 }),
    (value) => value as OfflineLeaseDuration,
  );

export function parseOfflineLeaseId(input: unknown): OfflineLeaseId {
  return decodeOrThrow(offlineLeaseIdDecoder, input, 'OfflineLeaseId');
}

export function parseOfflineLeaseDuration(
  input: unknown,
): OfflineLeaseDuration {
  return decodeOrThrow(
    offlineLeaseDurationDecoder,
    input,
    'OfflineLeaseDuration',
  );
}

export type EntitlementCapability =
  | 'notes-read'
  | 'notes-write'
  | 'notes-sync'
  | 'billing-recovery'
  | 'subscription-cancel'
  | 'account-delete'
  | 'support';

export type EntitlementLockReason =
  | 'checkout-incomplete'
  | 'payment-method-required'
  | 'trial-expired'
  | 'paid-period-expired'
  | 'payment-failed'
  | 'payment-action-required'
  | 'cancelled';

export type EntitlementState =
  | {
      readonly kind: 'trial-active';
      readonly validUntil: number;
    }
  | {
      readonly kind: 'paid-active';
      readonly validUntil: number;
    }
  | {
      readonly kind: 'locked';
      readonly reason: EntitlementLockReason;
    };

export type EntitlementDenialReason =
  | EntitlementLockReason
  | 'owner-mismatch'
  | 'subscription-required'
  | 'billing-unavailable'
  | 'entitlement-unavailable'
  | 'invalid-input'
  | 'projection-conflict'
  | 'lease-policy-undecided'
  | 'lease-not-found'
  | 'lease-expired'
  | 'lease-revoked'
  | 'lease-scope-mismatch'
  | 'online-required'
  | 'identifier-conflict';

export type EntitlementDecision =
  | {
      readonly kind: 'allowed';
      readonly capability: EntitlementCapability;
      readonly basis: 'trial' | 'paid' | 'recovery';
      readonly validUntil: number | null;
    }
  | {
      readonly kind: 'denied';
      readonly capability: EntitlementCapability;
      readonly reason: EntitlementDenialReason;
    };

export type PersonalVaultLimits = {
  readonly activeCards: 10_000;
  readonly displayCharactersPerCard: 1_000;
  readonly serializedPlaintextBytesPerCard: 8_192;
  readonly plaintextBytesPerVault: 134_217_728;
};

export const paidPersonalVaultLimits: PersonalVaultLimits = {
  activeCards: 10_000,
  displayCharactersPerCard: 1_000,
  serializedPlaintextBytesPerCard: 8_192,
  plaintextBytesPerVault: 134_217_728,
};

export type EntitlementLimitDecision =
  | {
      readonly kind: 'available';
      readonly limits: PersonalVaultLimits;
      readonly validUntil: number;
    }
  | { readonly kind: 'denied'; readonly reason: EntitlementDenialReason };

export type OfflineLeasePolicy =
  | { readonly kind: 'undecided' }
  | {
      readonly kind: 'configured';
      readonly duration: OfflineLeaseDuration;
    };

export const FUKAMU_OFFLINE_LEASE_DURATION_MS = 24 * 60 * 60 * 1_000;

export const fukamuOfflineLeasePolicy: OfflineLeasePolicy = {
  kind: 'configured',
  duration: parseOfflineLeaseDuration(FUKAMU_OFFLINE_LEASE_DURATION_MS),
};

export type OfflineLease = {
  readonly leaseId: OfflineLeaseId;
  readonly context: VaultContext;
  readonly basis: 'trial' | 'paid';
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
};

export type OfflineLeaseCommandResult =
  | { readonly kind: 'issued'; readonly lease: OfflineLease }
  | { readonly kind: 'replayed'; readonly lease: OfflineLease }
  | { readonly kind: 'denied'; readonly reason: EntitlementDenialReason };

export type EntitlementPort = {
  authorizeCapability(
    context: VaultContext,
    capability: EntitlementCapability,
    checkedAt: number,
  ): Promise<EntitlementDecision>;
  readLimits(
    context: VaultContext,
    checkedAt: number,
  ): Promise<EntitlementLimitDecision>;
  issueOfflineLease(
    context: VaultContext,
    input: { readonly leaseId: OfflineLeaseId; readonly issuedAt: number },
  ): Promise<OfflineLeaseCommandResult>;
  authorizeOfflineCapability(
    context: VaultContext,
    capability: EntitlementCapability,
    leaseId: OfflineLeaseId,
    checkedAt: number,
  ): Promise<EntitlementDecision>;
};

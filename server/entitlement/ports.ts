import type { VaultContext } from '../../lib/domain/identity';
import type { BillingApi } from '../billing/public';
import type { EntitlementProjectionRecord, OfflineLeaseRecord } from './core';
import type { EntitlementProjectionVersion, OfflineLeaseId } from './public';

export type EntitlementOwnershipPort = {
  owns(context: VaultContext): Promise<boolean>;
};

export type ProjectionCommitResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'conflict' };

export type OfflineLeaseCreateResult =
  | { readonly kind: 'issued' }
  | { readonly kind: 'replayed'; readonly lease: OfflineLeaseRecord }
  | { readonly kind: 'identifier-conflict' }
  | { readonly kind: 'projection-conflict' };

export type EntitlementRepository = {
  findProjection(
    context: VaultContext,
  ): Promise<EntitlementProjectionRecord | undefined>;
  commitProjection(input: {
    readonly expectedVersion: EntitlementProjectionVersion | undefined;
    readonly record: EntitlementProjectionRecord;
    readonly revokeActiveLeasesAt: number | null;
  }): Promise<ProjectionCommitResult>;
  findOfflineLease(
    context: VaultContext,
    leaseId: OfflineLeaseId,
  ): Promise<OfflineLeaseRecord | undefined>;
  createOfflineLease(input: {
    readonly expectedProjectionVersion: EntitlementProjectionVersion;
    readonly lease: OfflineLeaseRecord;
  }): Promise<OfflineLeaseCreateResult>;
};

export type EntitlementDependencies = {
  readonly billing: Pick<BillingApi, 'readSubscription'>;
  readonly ownership: EntitlementOwnershipPort;
  readonly repository: EntitlementRepository;
};

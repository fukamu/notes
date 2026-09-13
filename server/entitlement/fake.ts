import type { VaultContext } from '../../lib/domain/identity';
import type { BillingApi } from '../billing/public';
import type { EntitlementProjectionRecord, OfflineLeaseRecord } from './core';
import type {
  EntitlementRepository,
  OfflineLeaseCreateResult,
  ProjectionCommitResult,
} from './ports';
import { createEntitlementPort } from './service';
import type {
  EntitlementPort,
  EntitlementProjectionVersion,
  OfflineLeaseId,
  OfflineLeasePolicy,
} from './public';

export type FakeEntitlementInspection = {
  readonly projections: readonly EntitlementProjectionRecord[];
  readonly offlineLeases: readonly OfflineLeaseRecord[];
};

export class FakeEntitlementRepository implements EntitlementRepository {
  private readonly projections = new Map<string, EntitlementProjectionRecord>();
  private readonly leases = new Map<OfflineLeaseId, OfflineLeaseRecord>();

  async findProjection(
    context: VaultContext,
  ): Promise<EntitlementProjectionRecord | undefined> {
    return this.projections.get(ownerKey(context));
  }

  async commitProjection(input: {
    readonly expectedVersion: EntitlementProjectionVersion | undefined;
    readonly record: EntitlementProjectionRecord;
    readonly revokeActiveLeasesAt: number | null;
  }): Promise<ProjectionCommitResult> {
    const key = ownerKey(input.record);
    const current = this.projections.get(key);
    if (current?.version !== input.expectedVersion) {
      return { kind: 'conflict' };
    }
    const nextLeases = new Map(this.leases);
    if (input.revokeActiveLeasesAt !== null) {
      for (const [leaseId, lease] of nextLeases) {
        if (
          ownerKey(lease.context) === key &&
          lease.revokedAt === null &&
          input.revokeActiveLeasesAt >= lease.issuedAt
        ) {
          nextLeases.set(leaseId, {
            ...lease,
            revokedAt: input.revokeActiveLeasesAt,
          });
        }
      }
    }
    this.projections.set(key, input.record);
    this.leases.clear();
    for (const [leaseId, lease] of nextLeases) {
      this.leases.set(leaseId, lease);
    }
    return { kind: 'applied' };
  }

  async findOfflineLease(
    context: VaultContext,
    leaseId: OfflineLeaseId,
  ): Promise<OfflineLeaseRecord | undefined> {
    const lease = this.leases.get(leaseId);
    return lease !== undefined && ownerKey(lease.context) === ownerKey(context)
      ? lease
      : undefined;
  }

  async createOfflineLease(input: {
    readonly expectedProjectionVersion: EntitlementProjectionVersion;
    readonly lease: OfflineLeaseRecord;
  }): Promise<OfflineLeaseCreateResult> {
    const existing = this.leases.get(input.lease.leaseId);
    if (existing !== undefined) {
      return sameLease(existing, input.lease)
        ? { kind: 'replayed', lease: existing }
        : { kind: 'identifier-conflict' };
    }
    const projection = this.projections.get(ownerKey(input.lease.context));
    if (
      projection === undefined ||
      projection.version !== input.expectedProjectionVersion ||
      projection.sourceSubscriptionId !== input.lease.sourceSubscriptionId ||
      projection.sourceBillingVersion !== input.lease.sourceBillingVersion ||
      projection.state.kind === 'locked'
    ) {
      return { kind: 'projection-conflict' };
    }
    this.leases.set(input.lease.leaseId, input.lease);
    return { kind: 'issued' };
  }

  inspect(): FakeEntitlementInspection {
    return {
      projections: [...this.projections.values()],
      offlineLeases: [...this.leases.values()],
    };
  }
}

export function createFakeEntitlementModule(input: {
  readonly owners: readonly VaultContext[];
  readonly billing: Pick<BillingApi, 'readSubscription'>;
  readonly offlineLeasePolicy: OfflineLeasePolicy;
}): {
  readonly port: EntitlementPort;
  readonly repository: FakeEntitlementRepository;
} {
  const repository = new FakeEntitlementRepository();
  const owners = new Set(input.owners.map(ownerKey));
  return {
    repository,
    port: createEntitlementPort(
      {
        billing: input.billing,
        repository,
        ownership: {
          async owns(context) {
            return owners.has(ownerKey(context));
          },
        },
      },
      input.offlineLeasePolicy,
    ),
  };
}

function ownerKey(
  context: Pick<VaultContext, 'accountId' | 'vaultId'>,
): string {
  return `${context.accountId}\u0000${context.vaultId}`;
}

function sameLease(
  left: OfflineLeaseRecord,
  right: OfflineLeaseRecord,
): boolean {
  return (
    left.leaseId === right.leaseId &&
    ownerKey(left.context) === ownerKey(right.context) &&
    left.context.sessionId === right.context.sessionId &&
    left.context.sessionEpoch === right.context.sessionEpoch &&
    left.sourceSubscriptionId === right.sourceSubscriptionId &&
    left.sourceBillingVersion === right.sourceBillingVersion &&
    left.basis === right.basis &&
    left.issuedAt === right.issuedAt &&
    left.expiresAt === right.expiresAt &&
    left.revokedAt === right.revokedAt
  );
}

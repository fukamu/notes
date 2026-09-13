import { decodeOrThrow } from '../../lib/codec/core';
import type { VaultContext } from '../../lib/domain/identity';
import type { D1DatabaseBinding } from '../../db/d1-types';
import type { BillingApi } from '../billing/public';
import type { IdentityVaultControlPlane } from '../control-plane/public';
import type { EntitlementProjectionRecord, OfflineLeaseRecord } from './core';
import type {
  EntitlementRepository,
  OfflineLeaseCreateResult,
  ProjectionCommitResult,
} from './ports';
import {
  entitlementProjectionRowDecoder,
  mapEntitlementProjectionRow,
  mapOfflineLeaseRow,
  offlineLeaseRowDecoder,
} from './records';
import { createEntitlementPort } from './service';
import type {
  EntitlementPort,
  EntitlementProjectionVersion,
  OfflineLeaseId,
  OfflineLeasePolicy,
} from './public';

const projectionColumns = `account_id, vault_id, version,
  source_subscription_id, source_billing_version, state, valid_until,
  lock_reason, checked_at, created_at, updated_at`;

const leaseColumns = `lease_id, account_id, vault_id, session_id,
  session_epoch, source_subscription_id, source_billing_version, basis,
  issued_at, expires_at, revoked_at, created_at`;

export class D1EntitlementRepository implements EntitlementRepository {
  constructor(private readonly database: D1DatabaseBinding) {}

  async findProjection(
    context: VaultContext,
  ): Promise<EntitlementProjectionRecord | undefined> {
    const input: unknown = await this.database
      .prepare(
        `SELECT ${projectionColumns} FROM entitlement_projections
         WHERE account_id = ? AND vault_id = ?`,
      )
      .bind(context.accountId, context.vaultId)
      .first();
    return input === null
      ? undefined
      : mapEntitlementProjectionRow(
          decodeOrThrow(
            entitlementProjectionRowDecoder,
            input,
            'D1 Entitlement projection row',
          ),
        );
  }

  async commitProjection(input: {
    readonly expectedVersion: EntitlementProjectionVersion | undefined;
    readonly record: EntitlementProjectionRecord;
    readonly revokeActiveLeasesAt: number | null;
  }): Promise<ProjectionCommitResult> {
    const primary =
      input.expectedVersion === undefined
        ? this.database
            .prepare(
              `INSERT INTO entitlement_projections(${projectionColumns})
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(account_id, vault_id) DO NOTHING`,
            )
            .bind(...projectionBindings(input.record))
        : this.database
            .prepare(
              `UPDATE entitlement_projections SET
                version = ?, source_subscription_id = ?,
                source_billing_version = ?, state = ?, valid_until = ?,
                lock_reason = ?, checked_at = ?, updated_at = ?
               WHERE account_id = ? AND vault_id = ? AND version = ?`,
            )
            .bind(
              input.record.version,
              input.record.sourceSubscriptionId,
              input.record.sourceBillingVersion,
              input.record.state.kind,
              stateValidUntil(input.record),
              stateLockReason(input.record),
              input.record.checkedAt,
              input.record.updatedAt,
              input.record.accountId,
              input.record.vaultId,
              input.expectedVersion,
            );
    if (input.revokeActiveLeasesAt === null) {
      const result = await primary.run();
      return result.meta.changes === 1
        ? { kind: 'applied' }
        : { kind: 'conflict' };
    }
    const results = await this.database.batch([
      primary,
      this.database
        .prepare(
          `UPDATE entitlement_offline_leases SET revoked_at = ?
           WHERE account_id = ? AND vault_id = ? AND revoked_at IS NULL
             AND issued_at <= ? AND changes() = 1`,
        )
        .bind(
          input.revokeActiveLeasesAt,
          input.record.accountId,
          input.record.vaultId,
          input.revokeActiveLeasesAt,
        ),
    ]);
    return statementChanges(results, 0) === 1
      ? { kind: 'applied' }
      : { kind: 'conflict' };
  }

  async findOfflineLease(
    context: VaultContext,
    leaseId: OfflineLeaseId,
  ): Promise<OfflineLeaseRecord | undefined> {
    const input: unknown = await this.database
      .prepare(
        `SELECT ${leaseColumns} FROM entitlement_offline_leases
         WHERE lease_id = ? AND account_id = ? AND vault_id = ?`,
      )
      .bind(leaseId, context.accountId, context.vaultId)
      .first();
    return input === null
      ? undefined
      : mapOfflineLeaseRow(
          decodeOrThrow(
            offlineLeaseRowDecoder,
            input,
            'D1 Entitlement offline lease row',
          ),
        );
  }

  async createOfflineLease(input: {
    readonly expectedProjectionVersion: EntitlementProjectionVersion;
    readonly lease: OfflineLeaseRecord;
  }): Promise<OfflineLeaseCreateResult> {
    const result = await this.database
      .prepare(
        `INSERT INTO entitlement_offline_leases(${leaseColumns})
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?
         WHERE EXISTS (
           SELECT 1 FROM entitlement_projections
           WHERE account_id = ? AND vault_id = ? AND version = ?
             AND source_subscription_id = ? AND source_billing_version = ?
             AND state IN ('trial-active', 'paid-active')
             AND valid_until >= ?
         )
         ON CONFLICT(lease_id) DO NOTHING`,
      )
      .bind(
        ...leaseBindings(input.lease),
        input.lease.context.accountId,
        input.lease.context.vaultId,
        input.expectedProjectionVersion,
        input.lease.sourceSubscriptionId,
        input.lease.sourceBillingVersion,
        input.lease.expiresAt,
      )
      .run();
    if (result.meta.changes === 1) return { kind: 'issued' };
    const existing = await this.findOfflineLeaseById(input.lease.leaseId);
    if (existing !== undefined) {
      return sameLease(existing, input.lease)
        ? { kind: 'replayed', lease: existing }
        : { kind: 'identifier-conflict' };
    }
    return { kind: 'projection-conflict' };
  }

  private async findOfflineLeaseById(
    leaseId: OfflineLeaseId,
  ): Promise<OfflineLeaseRecord | undefined> {
    const input: unknown = await this.database
      .prepare(
        `SELECT ${leaseColumns} FROM entitlement_offline_leases
         WHERE lease_id = ?`,
      )
      .bind(leaseId)
      .first();
    return input === null
      ? undefined
      : mapOfflineLeaseRow(
          decodeOrThrow(
            offlineLeaseRowDecoder,
            input,
            'D1 Entitlement offline lease row',
          ),
        );
  }
}

export function createD1EntitlementPort(input: {
  readonly database: D1DatabaseBinding;
  readonly controlPlane: IdentityVaultControlPlane;
  readonly billing: Pick<BillingApi, 'readSubscription'>;
  readonly offlineLeasePolicy: OfflineLeasePolicy;
}): EntitlementPort {
  return createEntitlementPort(
    {
      billing: input.billing,
      repository: new D1EntitlementRepository(input.database),
      ownership: {
        async owns(context) {
          const owner = await input.controlPlane.findPersonalAccount(
            context.accountId,
          );
          return owner?.vault.vaultId === context.vaultId;
        },
      },
    },
    input.offlineLeasePolicy,
  );
}

function projectionBindings(
  record: EntitlementProjectionRecord,
): readonly (string | number | null)[] {
  return [
    record.accountId,
    record.vaultId,
    record.version,
    record.sourceSubscriptionId,
    record.sourceBillingVersion,
    record.state.kind,
    stateValidUntil(record),
    stateLockReason(record),
    record.checkedAt,
    record.createdAt,
    record.updatedAt,
  ];
}

function leaseBindings(
  lease: OfflineLeaseRecord,
): readonly (string | number)[] {
  return [
    lease.leaseId,
    lease.context.accountId,
    lease.context.vaultId,
    lease.context.sessionId,
    lease.context.sessionEpoch,
    lease.sourceSubscriptionId,
    lease.sourceBillingVersion,
    lease.basis,
    lease.issuedAt,
    lease.expiresAt,
    lease.issuedAt,
  ];
}

function stateValidUntil(record: EntitlementProjectionRecord): number | null {
  return record.state.kind === 'locked' ? null : record.state.validUntil;
}

function stateLockReason(record: EntitlementProjectionRecord): string | null {
  return record.state.kind === 'locked' ? record.state.reason : null;
}

function sameLease(
  left: OfflineLeaseRecord,
  right: OfflineLeaseRecord,
): boolean {
  return (
    left.leaseId === right.leaseId &&
    left.context.accountId === right.context.accountId &&
    left.context.vaultId === right.context.vaultId &&
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

function statementChanges(
  statements: readonly D1Result<unknown>[],
  index: number,
): number {
  const result = statements[index];
  if (result === undefined) throw new Error('missing D1 batch result');
  return result.meta.changes;
}

import { decodeOrThrow } from '../../lib/codec/core';
import type { ImmediateSubscriptionCancellationPort } from '../billing/public';
import type {
  AccountLiveStateFinalizationPort,
  AccountSessionRevocationPort,
} from '../control-plane/public';
import type { VaultWrappedKeyFinalizationPort } from '../crypto/public';
import type {
  EncryptedObjectMetadataPurgePort,
  VaultPrivateObjectDeletionBarrierPort,
  VaultPrivateObjectPurgePort,
} from '../encrypted-object/public';
import type { VaultLiveDataPurgePort } from '../vault-content/public';
import { executeCancelSubscriptionStep } from './cancel-subscription';
import {
  planAccountDeletionStart,
  planAccountDeletionStepResult,
  type AccountDeletionRetryPolicy,
  type AccountDeletionStepResult,
} from './core';
import { executeDeletePrivateObjectsStep } from './delete-private-objects';
import { executeDeleteVaultDataStep } from './delete-vault-data';
import { executeFinalizeAccountStep } from './finalize-account';
import {
  accountDeletionPublicStatus,
  planAccountDeletionContinuationStart,
  planAccountDeletionRun,
} from './http-core';
import {
  accountDeletionContinuationSecretDecoder,
  accountDeletionCredentialHashDecoder,
  accountDeletionOperationIdDecoder,
  accountDeletionScope,
  accountDeletionContinuationTokenParts,
  createAccountDeletionContinuationToken,
  type AccountDeletionAccessRepository,
  type AccountDeletionApplication,
  type AccountDeletionApplicationResult,
  type AccountDeletionAuthorizedSnapshot,
  type AccountDeletionContinuationCredentialsPort,
  type AccountDeletionContinuationSecret,
  type AccountDeletionOperationIdGeneratorPort,
  type AccountDeletionSnapshot,
  type AccountDeletionTransition,
} from './public';
import { executeRevokeSessionsStep } from './revoke-sessions';

type AccountDeletionEncryptedObjectPorts = EncryptedObjectMetadataPurgePort &
  VaultPrivateObjectPurgePort &
  VaultPrivateObjectDeletionBarrierPort;

export type AccountDeletionApplicationDependencies = {
  readonly repository: AccountDeletionAccessRepository;
  readonly operationIds: AccountDeletionOperationIdGeneratorPort;
  readonly credentials: AccountDeletionContinuationCredentialsPort;
  readonly continuationLifetimeMs: number;
  readonly leaseDurationMs: number;
  readonly retryPolicy: AccountDeletionRetryPolicy;
  readonly sessions: AccountSessionRevocationPort;
  readonly billing: ImmediateSubscriptionCancellationPort;
  readonly encryptedObjects: AccountDeletionEncryptedObjectPorts;
  readonly vaultContent: VaultLiveDataPurgePort;
  readonly wrappedKeys: VaultWrappedKeyFinalizationPort;
  readonly controlPlane: AccountLiveStateFinalizationPort;
};

export function createAccountDeletionApplication(
  dependencies: AccountDeletionApplicationDependencies,
): AccountDeletionApplication {
  return {
    async start(input) {
      try {
        const expiresAt = addDuration(
          input.requestedAt,
          dependencies.continuationLifetimeMs,
        );
        if (expiresAt === undefined) {
          return { kind: 'rejected', reason: 'unavailable' };
        }
        const operationId = decodeOrThrow(
          accountDeletionOperationIdDecoder,
          dependencies.operationIds.create(),
          'account deletion operation ID',
        );
        const operationPlan = planAccountDeletionStart({
          operationId,
          scope: input.scope,
          requestedAt: input.requestedAt,
        });
        if (operationPlan.kind === 'rejected') {
          return { kind: 'rejected', reason: 'invalid-input' };
        }
        const secret = decodeOrThrow(
          accountDeletionContinuationSecretDecoder,
          await dependencies.credentials.deriveSecret({
            scope: input.scope,
            idempotencyKey: input.idempotencyKey,
          }),
          'account deletion continuation secret',
        );
        const [idempotencyKeyHash, secretHash] = await Promise.all([
          digestCredential(dependencies, input.idempotencyKey),
          digestCredential(dependencies, secret),
        ]);
        const continuationPlan = planAccountDeletionContinuationStart({
          operation: operationPlan.operation,
          idempotencyKeyHash,
          secretHash,
          expiresAt,
        });
        if (continuationPlan.kind === 'rejected') {
          return { kind: 'rejected', reason: 'unavailable' };
        }
        const started = await dependencies.repository.startWithContinuation({
          operation: operationPlan.operation,
          continuation: continuationPlan.continuation,
        });
        if (started.kind === 'rejected') {
          return {
            kind: 'rejected',
            reason:
              started.reason === 'credential-conflict'
                ? 'credential-conflict'
                : 'unavailable',
          };
        }
        return acceptedResult(started, secret);
      } catch {
        return { kind: 'rejected', reason: 'unavailable' };
      }
    },

    async resume(input) {
      try {
        const token = accountDeletionContinuationTokenParts(input.token);
        const secretHash = await digestCredential(dependencies, token.secret);
        const access = await dependencies.repository.consumeContinuation({
          secretHash,
          sequence: token.sequence,
          consumedAt: input.resumedAt,
        });
        if (access.kind === 'rejected') {
          return { kind: 'rejected', reason: 'invalid-capability' };
        }
        const authorized =
          access.kind === 'replayed'
            ? access
            : {
                ...access,
                snapshot: await runOneStep(
                  dependencies,
                  access.snapshot,
                  input.resumedAt,
                ),
              };
        return acceptedResult(authorized, token.secret);
      } catch {
        return { kind: 'rejected', reason: 'unavailable' };
      }
    },
  };
}

async function runOneStep(
  dependencies: AccountDeletionApplicationDependencies,
  snapshot: AccountDeletionSnapshot,
  now: number,
): Promise<AccountDeletionSnapshot> {
  const run = planAccountDeletionRun({
    snapshot,
    now,
    leaseDurationMs: dependencies.leaseDurationMs,
    retryPolicy: dependencies.retryPolicy,
  });
  if (run.kind === 'report') return snapshot;
  if (run.kind === 'rejected') {
    throw new Error(`account deletion run rejected: ${run.reason}`);
  }
  const advanced = await commitTransition(
    dependencies.repository,
    accountDeletionScope(snapshot.operation),
    run.transition,
  );
  if (run.kind === 'advance-state') return advanced;
  if (advanced.operation.state.kind !== 'running') return advanced;

  const result = await executeClaimedStep(dependencies, advanced, now);
  const transition = planAccountDeletionStepResult({
    operation: advanced.operation,
    result,
    retryPolicy: dependencies.retryPolicy,
  });
  if (transition.kind !== 'accepted') {
    throw new Error(`account deletion result rejected: ${transition.kind}`);
  }
  return commitTransition(
    dependencies.repository,
    accountDeletionScope(advanced.operation),
    transition.transition,
  );
}

async function executeClaimedStep(
  dependencies: AccountDeletionApplicationDependencies,
  snapshot: AccountDeletionSnapshot,
  now: number,
): Promise<AccountDeletionStepResult> {
  const state = snapshot.operation.state;
  if (state.kind !== 'running') {
    throw new Error('account deletion step is not running');
  }
  const execution = await (async () => {
    switch (state.step) {
      case 'revoke-sessions':
        return executeRevokeSessionsStep({
          operation: snapshot.operation,
          revokedAt: now,
          sessions: dependencies.sessions,
        });
      case 'cancel-subscription':
        return executeCancelSubscriptionStep({
          snapshot,
          executedAt: now,
          billing: dependencies.billing,
        });
      case 'delete-vault-data':
        return executeDeleteVaultDataStep({
          snapshot,
          executedAt: now,
          encryptedObjects: dependencies.encryptedObjects,
          vaultContent: dependencies.vaultContent,
        });
      case 'delete-private-objects':
        return executeDeletePrivateObjectsStep({
          snapshot,
          executedAt: now,
          encryptedObjects: dependencies.encryptedObjects,
        });
      case 'finalize-account':
        return executeFinalizeAccountStep({
          snapshot,
          executedAt: now,
          privateObjects: dependencies.encryptedObjects,
          wrappedKeys: dependencies.wrappedKeys,
          controlPlane: dependencies.controlPlane,
        });
    }
  })();
  if (execution.kind !== 'executed') {
    throw new Error(`account deletion step rejected: ${execution.reason}`);
  }
  return execution.result;
}

async function commitTransition(
  repository: AccountDeletionAccessRepository,
  scope: ReturnType<typeof accountDeletionScope>,
  transition: AccountDeletionTransition,
): Promise<AccountDeletionSnapshot> {
  const committed = await repository.commit(scope, transition);
  switch (committed.kind) {
    case 'applied':
    case 'replayed':
      return committed.snapshot;
    case 'conflict':
      if (committed.current !== undefined) return committed.current;
      throw new Error('account deletion operation disappeared');
    case 'rejected':
      throw new Error('account deletion transition was rejected');
  }
}

function acceptedResult(
  authorized: AccountDeletionAuthorizedSnapshot,
  secret: AccountDeletionContinuationSecret,
): AccountDeletionApplicationResult {
  const status = accountDeletionPublicStatus(authorized.snapshot);
  switch (status.kind) {
    case 'failed':
    case 'completed':
      return { kind: 'accepted', status };
    case 'in-progress':
    case 'retry-wait':
      return {
        kind: 'accepted',
        status,
        continuationToken: createAccountDeletionContinuationToken(
          secret,
          authorized.continuation.sequence,
        ),
      };
  }
}

async function digestCredential(
  dependencies: Pick<AccountDeletionApplicationDependencies, 'credentials'>,
  value: string,
) {
  return decodeOrThrow(
    accountDeletionCredentialHashDecoder,
    await dependencies.credentials.digest(value),
    'account deletion credential hash',
  );
}

function addDuration(timestamp: number, duration: number): number | undefined {
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    !Number.isSafeInteger(duration) ||
    duration <= 0
  ) {
    return undefined;
  }
  const result = timestamp + duration;
  return Number.isSafeInteger(result) ? result : undefined;
}

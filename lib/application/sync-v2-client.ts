import type {
  CardRecord,
  ConflictRecord,
  PendingMutation,
} from '../domain/types';
import { assertNever } from '../shared/invariant';
import {
  beginSyncV2PageCollection,
  planSyncV2Page,
  type SyncV2PageDecision,
} from '../sync/v2-page-application';
import type {
  SyncV2ReplicaCommitResult,
  SyncV2ReplicaRepository,
} from '../sync/v2-replica';
import {
  encodeSyncV2Request,
  type SyncV2RequestWire,
} from '../sync/v2-protocol';
import type { DeviceId } from '../domain/id';

export type SyncV2Transport<TScope> = {
  readonly scope: TScope;
  send: (request: SyncV2RequestWire) => Promise<unknown>;
};

type PageRejectionReason = Extract<
  SyncV2PageDecision,
  { readonly kind: 'rejected' }
>['reason'];

type CommitRejectionReason = Extract<
  SyncV2ReplicaCommitResult,
  { readonly kind: 'rejected' }
>['reason'];

export type SyncV2ClientResult =
  | {
      readonly kind: 'completed';
      readonly cards: readonly CardRecord[];
      readonly conflicts: readonly ConflictRecord[];
    }
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'rejected';
      readonly reason: PageRejectionReason | CommitRejectionReason;
    };

export type SyncV2CommitExecutionResult =
  | SyncV2ReplicaCommitResult
  | { readonly kind: 'cancelled' };

export type SyncV2CommitExecutor = (
  commit: () => Promise<SyncV2ReplicaCommitResult>,
) => Promise<SyncV2CommitExecutionResult>;

export type SyncV2Client<TScope> = {
  readonly scope: TScope;
  synchronize: (input: {
    readonly deviceId: DeviceId;
    readonly sentMutations: readonly PendingMutation[];
    readonly isCurrent: () => boolean;
    readonly executeCommit: SyncV2CommitExecutor;
  }) => Promise<SyncV2ClientResult>;
};

/** Executes effects around the typed page state machine from sync core. */
export function createSyncV2Client<TScope>(input: {
  readonly scope: TScope;
  readonly transport: SyncV2Transport<TScope>;
  readonly replica: SyncV2ReplicaRepository<TScope>;
}): SyncV2Client<TScope> {
  return {
    scope: input.scope,
    async synchronize(operation) {
      let state = beginSyncV2PageCollection({
        checkpoint: await input.replica.loadCheckpoint(),
        sentMutations: operation.sentMutations,
      });
      if (!operation.isCurrent()) return { kind: 'cancelled' };

      while (true) {
        const requestCursor = state.nextRequestCursor;
        const response = await input.transport.send(
          encodeSyncV2Request({
            deviceId: operation.deviceId,
            cursor: requestCursor,
            mutations: state.sentMutations,
          }),
        );
        if (!operation.isCurrent()) return { kind: 'cancelled' };

        const decision = planSyncV2Page({
          state,
          requestCursor,
          response,
        });
        switch (decision.kind) {
          case 'rejected':
            return { kind: 'rejected', reason: decision.reason };
          case 'continue':
            state = decision.state;
            break;
          case 'ready-to-commit': {
            if (!operation.isCurrent()) return { kind: 'cancelled' };
            const commit = await operation.executeCommit(() =>
              input.replica.applyCommit(decision.plan, state.sentMutations),
            );
            if (!operation.isCurrent()) return { kind: 'cancelled' };
            switch (commit.kind) {
              case 'cancelled':
                return { kind: 'cancelled' };
              case 'applied':
              case 'already-applied':
                return {
                  kind: 'completed',
                  cards: commit.cards,
                  conflicts: commit.conflicts,
                };
              case 'rejected':
                return { kind: 'rejected', reason: commit.reason };
              default:
                return assertNever(commit, 'Unsupported Sync v2 commit result');
            }
          }
          default:
            assertNever(decision, 'Unsupported Sync v2 page decision');
        }
      }
    },
  };
}

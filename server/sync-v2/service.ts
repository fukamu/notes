import { BoundaryDecodeError, decodeOrThrow } from '../../lib/codec/core';
import type { VaultContext } from '../../lib/domain/identity';
import type { PendingMutation } from '../../lib/domain/types';
import { assertNever } from '../../lib/shared/invariant';
import {
  authorizeSyncV2Cursor,
  decodeSyncV2CursorClaims,
  SYNC_V2_CURSOR_VERSION,
} from '../../lib/sync/v2-cursor';
import {
  parseSyncSequence,
  SYNC_V2_LIMITS,
  SYNC_V2_VERSION,
  type SyncV2Change,
  type SyncV2MutationReceipt,
  type SyncV2Request,
} from '../../lib/sync/v2-protocol';
import { parseContentRevision } from '../vault-content/records';
import {
  syncV2MutationFingerprintDecoder,
  type SyncV2JournalReceipt,
  type SyncV2JournalCommit,
  type SyncV2JournalRepository,
  type SyncV2MutationFingerprint,
} from '../vault-content/sync-v2-public';
import {
  canonicalizeSyncV2Mutation,
  hydrateSyncV2JournalChange,
  planSyncV2Mutation,
  sameVaultPartitionRoute,
  syncV2CursorWindow,
  toSyncV2MutationReceipt,
} from './core';
import type {
  SyncV2Application,
  SyncV2ApplicationDependencies,
  SyncV2ApplicationInput,
  SyncV2ApplicationResult,
  SyncV2ContentRepository,
  SyncV2CursorWindow,
  SyncV2MutationPlan,
} from './public';

const maximumJournalCommitAttempts = 3;

export function createSyncV2Application(
  dependencies: SyncV2ApplicationDependencies,
): SyncV2Application {
  return {
    async synchronize(
      input: SyncV2ApplicationInput,
    ): Promise<SyncV2ApplicationResult> {
      const cursor = await resolveCursor(
        dependencies,
        input.context,
        input.request,
      );
      if (cursor.kind === 'rejected') return cursor;

      const [journalScope, contentScope] = await Promise.all([
        dependencies.journals.open(input.context),
        dependencies.contents.open(input.context),
      ]);
      if (
        journalScope.kind === 'not-found' ||
        contentScope.kind === 'not-found' ||
        !sameVaultPartitionRoute(journalScope.route, contentScope.route)
      ) {
        return { kind: 'rejected', reason: 'scope-unavailable' };
      }

      const receipts: SyncV2MutationReceipt[] = [];
      const orderedMutations = [...input.request.mutations].sort(
        (left, right) =>
          left.cardId.localeCompare(right.cardId) ||
          left.mutationId.localeCompare(right.mutationId),
      );
      for (const mutation of orderedMutations) {
        const applied = await applyMutation({
          dependencies,
          journal: journalScope.repository,
          content: contentScope.repository,
          mutation,
          synchronizedAt: input.synchronizedAt,
        });
        if (applied.kind === 'rejected') return applied;
        receipts.push(toSyncV2MutationReceipt(applied.receipt));
      }

      const page = await journalScope.repository.readPage({
        afterSequence: cursor.window.afterSequence,
        highWatermark: cursor.window.highWatermark,
        limit: SYNC_V2_LIMITS.changesPerPage,
      });
      const changes: SyncV2Change[] = [];
      for (const change of page.changes) {
        const hydration = await hydrateChange(contentScope.repository, change);
        if (hydration === undefined) {
          return { kind: 'rejected', reason: 'scope-unavailable' };
        }
        changes.push(hydration);
      }
      const nextCursor = await dependencies.cursors.issue({
        version: SYNC_V2_CURSOR_VERSION,
        vaultId: input.context.vaultId,
        deviceId: input.request.deviceId,
        afterSequence: page.page.afterSequence,
        highWatermark: page.highWatermark,
      });
      return {
        kind: 'synchronized',
        response: {
          version: SYNC_V2_VERSION,
          highWatermark: page.highWatermark,
          changes,
          receipts,
          page: { kind: page.page.kind, nextCursor },
        },
      };
    },
  };
}

type ResolvedCursor =
  | { readonly kind: 'accepted'; readonly window: SyncV2CursorWindow }
  | Extract<SyncV2ApplicationResult, { readonly kind: 'rejected' }>;

async function resolveCursor(
  dependencies: Pick<SyncV2ApplicationDependencies, 'cursors'>,
  context: VaultContext,
  request: SyncV2Request,
): Promise<ResolvedCursor> {
  if (request.cursor === null) {
    return {
      kind: 'accepted',
      window: { afterSequence: parseSyncSequence(0), highWatermark: null },
    };
  }
  const verification = await dependencies.cursors.verify(request.cursor);
  if (verification.kind === 'rejected') {
    return { kind: 'rejected', reason: 'invalid-cursor' };
  }
  try {
    const claims = decodeSyncV2CursorClaims(verification.claims);
    const authorization = authorizeSyncV2Cursor(
      context,
      request.deviceId,
      claims,
    );
    return authorization.kind === 'rejected'
      ? { kind: 'rejected', reason: 'invalid-cursor' }
      : { kind: 'accepted', window: syncV2CursorWindow(claims) };
  } catch (error: unknown) {
    if (error instanceof BoundaryDecodeError) {
      return { kind: 'rejected', reason: 'invalid-cursor' };
    }
    throw error;
  }
}

type AppliedMutation =
  | {
      readonly kind: 'applied';
      readonly receipt: SyncV2JournalReceipt;
    }
  | Extract<SyncV2ApplicationResult, { readonly kind: 'rejected' }>;

async function applyMutation(input: {
  readonly dependencies: Pick<SyncV2ApplicationDependencies, 'fingerprints'>;
  readonly journal: SyncV2JournalRepository;
  readonly content: SyncV2ContentRepository;
  readonly mutation: PendingMutation;
  readonly synchronizedAt: number;
}): Promise<AppliedMutation> {
  const fingerprint = decodeOrThrow(
    syncV2MutationFingerprintDecoder,
    await input.dependencies.fingerprints.digest(
      canonicalizeSyncV2Mutation(input.mutation),
    ),
    'Sync v2 mutation fingerprint',
  );
  const existing = await input.journal.findReceipt(input.mutation.mutationId);
  if (existing !== undefined) {
    return existing.fingerprint === fingerprint
      ? { kind: 'applied', receipt: existing }
      : { kind: 'rejected', reason: 'idempotency-key-reuse' };
  }

  const current = await input.journal.findCard(input.mutation.cardId);
  let plan = planSyncV2Mutation({
    mutation: input.mutation,
    current,
    currentContent: undefined,
  });
  if (plan.kind === 'requires-current-content') {
    const currentContent = await input.content.readCard({
      cardId: input.mutation.cardId,
      revision: plan.revision,
    });
    if (currentContent === undefined) {
      return { kind: 'rejected', reason: 'scope-unavailable' };
    }
    plan = planSyncV2Mutation({
      mutation: input.mutation,
      current,
      currentContent,
    });
  }
  if (plan.kind === 'requires-current-content') {
    return { kind: 'rejected', reason: 'scope-unavailable' };
  }
  if (plan.kind === 'rejected') {
    return { kind: 'rejected', reason: 'mutation-conflict' };
  }

  const written = await writeMutationContent(input, plan);
  if (written.kind === 'not-applied') {
    return {
      kind: 'rejected',
      reason:
        written.reason === 'idempotency-key-reuse'
          ? 'idempotency-key-reuse'
          : 'mutation-conflict',
    };
  }
  const command = journalCommand(
    input.mutation,
    plan,
    fingerprint,
    input.synchronizedAt,
  );
  for (let attempt = 0; attempt < maximumJournalCommitAttempts; attempt += 1) {
    const committed = await input.journal.commit(command);
    if (committed.kind === 'applied' || committed.kind === 'replayed') {
      return { kind: 'applied', receipt: committed.receipt };
    }
    if (
      committed.reason === 'cas-conflict' &&
      attempt + 1 < maximumJournalCommitAttempts
    ) {
      continue;
    }
    return {
      kind: 'rejected',
      reason:
        committed.reason === 'idempotency-key-reuse'
          ? 'idempotency-key-reuse'
          : 'mutation-conflict',
    };
  }
  return { kind: 'rejected', reason: 'mutation-conflict' };
}

function writeMutationContent(
  input: {
    readonly content: SyncV2ContentRepository;
    readonly mutation: PendingMutation;
    readonly synchronizedAt: number;
  },
  plan: Exclude<
    SyncV2MutationPlan,
    { readonly kind: 'requires-current-content' | 'rejected' }
  >,
) {
  switch (plan.kind) {
    case 'write-card':
      return input.content.writeCard({
        cardId: input.mutation.cardId,
        expectedRevision: plan.expectedRevision,
        nextRevision: plan.nextRevision,
        writeId: input.mutation.mutationId,
        content: plan.content,
        writtenAt: input.synchronizedAt,
      });
    case 'write-conflict':
      return input.content.writeConflict({
        conflictId: plan.conflictId,
        writeId: input.mutation.mutationId,
        content: plan.content,
        writtenAt: input.synchronizedAt,
      });
    default:
      return assertNever(plan, 'Unsupported Sync v2 mutation content plan');
  }
}

function journalCommand(
  mutation: PendingMutation,
  plan: Exclude<
    SyncV2MutationPlan,
    { readonly kind: 'requires-current-content' | 'rejected' }
  >,
  fingerprint: SyncV2MutationFingerprint,
  committedAt: number,
): SyncV2JournalCommit {
  switch (plan.kind) {
    case 'write-conflict':
      return {
        kind: 'conflict-upsert',
        mutationId: mutation.mutationId,
        fingerprint,
        conflictId: plan.conflictId,
        cardId: mutation.cardId,
        serverRevision: parseContentRevision(plan.serverRevision),
        createdAt: plan.content.createdAt,
        committedAt,
      };
    case 'write-card': {
      const expectedRevision =
        plan.expectedRevision === null
          ? null
          : parseContentRevision(plan.expectedRevision);
      const nextRevision = parseContentRevision(plan.nextRevision);
      if (mutation.kind === 'resolve') {
        if (expectedRevision === null) {
          throw new BoundaryDecodeError('Sync v2 resolve plan', [
            { path: ['expectedRevision'], reason: 'expected current revision' },
          ]);
        }
        return {
          kind: 'resolve-conflicts',
          mutationId: mutation.mutationId,
          fingerprint,
          cardId: mutation.cardId,
          expectedRevision,
          nextRevision,
          updatedAt: plan.content.updatedAt,
          committedAt,
          conflictIds: mutation.conflictIds,
        };
      }
      return {
        kind: 'card-upsert',
        mutationId: mutation.mutationId,
        fingerprint,
        cardId: mutation.cardId,
        expectedRevision,
        nextRevision,
        updatedAt: plan.content.updatedAt,
        committedAt,
      };
    }
    default:
      return assertNever(plan, 'Unsupported Sync v2 journal plan');
  }
}

async function hydrateChange(
  content: SyncV2ContentRepository,
  change: Parameters<typeof hydrateSyncV2JournalChange>[0],
): Promise<SyncV2Change | undefined> {
  const input =
    change.kind === 'card-upsert'
      ? await content
          .readCard({ cardId: change.cardId, revision: change.revision })
          .then((stored) =>
            stored === undefined
              ? undefined
              : ({ kind: 'card', content: stored } as const),
          )
      : change.kind === 'conflict-upsert'
        ? await content
            .readConflict({ conflictId: change.conflictId })
            .then((stored) =>
              stored === undefined
                ? undefined
                : ({ kind: 'conflict', content: stored } as const),
            )
        : ({ kind: 'none' } as const);
  if (input === undefined) return undefined;
  const plan = hydrateSyncV2JournalChange(change, input);
  return plan.kind === 'hydrated' ? plan.change : undefined;
}

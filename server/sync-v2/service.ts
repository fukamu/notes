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
import type { PersonalVaultLimits } from '../entitlement/public';
import {
  countCardDisplayCharacters,
  parseQuotaByteCount,
  parseVaultQuotaFingerprint,
  quotaTransportLimits,
  type QuotaByteCount,
  type VaultQuotaLedger,
  type VaultQuotaReservationCommand,
} from '../quota/public';
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
import {
  encodeSyncV2StoredCard,
  encodeSyncV2StoredConflict,
} from './content-codec';
import {
  canonicalizeSyncV2CardDeletion,
  evaluateSyncV2QuotaMeasurement,
  syncV2QuotaReconcileAfter,
  toSyncV2VaultQuotaChange,
} from './quota-core';
import type {
  SyncV2Application,
  SyncV2ApplicationDependencies,
  SyncV2ApplicationInput,
  SyncV2ApplicationResult,
  SyncV2CardDeletionInput,
  SyncV2CardDeletionResult,
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

      const [journalScope, contentScope, quotaScope] = await Promise.all([
        dependencies.journals.open(input.context),
        dependencies.contents.open(input.context),
        dependencies.quotas.open(input.context, input.synchronizedAt),
      ]);
      if (
        journalScope.kind === 'not-found' ||
        contentScope.kind === 'not-found' ||
        quotaScope.kind === 'owner-mismatch' ||
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
          quota: quotaScope.ledger,
          mutation,
          synchronizedAt: input.synchronizedAt,
          requestBytes: input.requestBytes,
          limits: input.limits,
          reservationReconcileDelayMs:
            dependencies.quotaPolicy.reservationReconcileDelayMs,
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
    deleteCard(input) {
      return deleteSyncV2Card(dependencies, input);
    },
  };
}

async function deleteSyncV2Card(
  dependencies: SyncV2ApplicationDependencies,
  input: SyncV2CardDeletionInput,
): Promise<SyncV2CardDeletionResult> {
  const [journalScope, contentScope, quotaScope] = await Promise.all([
    dependencies.journals.open(input.context),
    dependencies.contents.open(input.context),
    dependencies.quotas.open(input.context, input.synchronizedAt),
  ]);
  if (
    journalScope.kind === 'not-found' ||
    contentScope.kind === 'not-found' ||
    quotaScope.kind === 'owner-mismatch' ||
    !sameVaultPartitionRoute(journalScope.route, contentScope.route)
  ) {
    return { kind: 'rejected', reason: 'scope-unavailable' };
  }
  const fingerprint = decodeOrThrow(
    syncV2MutationFingerprintDecoder,
    await dependencies.fingerprints.digest(
      canonicalizeSyncV2CardDeletion(input),
    ),
    'Sync v2 card deletion fingerprint',
  );
  const existing = await journalScope.repository.findReceipt(input.mutationId);
  if (existing !== undefined) {
    if (existing.fingerprint !== fingerprint) {
      return { kind: 'rejected', reason: 'idempotency-key-reuse' };
    }
    const finalized = await commitQuotaReservation(
      quotaScope.ledger,
      input.mutationId,
      fingerprint,
      input.limits,
      input.synchronizedAt,
    );
    return finalized.kind === 'committed'
      ? { kind: 'deleted', receipt: toSyncV2MutationReceipt(existing) }
      : finalized;
  }
  const current = await journalScope.repository.findCard(input.cardId);
  if (current === undefined || current.revision !== input.expectedRevision) {
    return { kind: 'rejected', reason: 'mutation-conflict' };
  }
  const currentContent = await contentScope.repository.readCard({
    cardId: input.cardId,
    revision: input.expectedRevision,
  });
  if (currentContent === undefined) {
    return { kind: 'rejected', reason: 'scope-unavailable' };
  }
  const reconcileAfter = syncV2QuotaReconcileAfter(
    input.synchronizedAt,
    dependencies.quotaPolicy.reservationReconcileDelayMs,
  );
  if (reconcileAfter === undefined) {
    return { kind: 'rejected', reason: 'quota-unavailable' };
  }
  const reserved = await quotaScope.ledger.reserve({
    reservationId: input.mutationId,
    fingerprint: parseVaultQuotaFingerprint(fingerprint),
    cardId: input.cardId,
    change: toSyncV2VaultQuotaChange({
      kind: 'card-delete',
      currentPlaintextBytes: parseQuotaByteCount(
        encodeSyncV2StoredCard(currentContent).byteLength,
      ),
    }),
    limits: input.limits,
    requestedAt: input.synchronizedAt,
    reconcileAfter,
  });
  if (reserved.kind === 'rejected') {
    return mapQuotaReservationRejection(reserved.reason);
  }
  if (reserved.reservation.state.kind !== 'reserved') {
    return { kind: 'rejected', reason: 'quota-unavailable' };
  }
  const command: SyncV2JournalCommit = {
    kind: 'card-delete',
    mutationId: input.mutationId,
    fingerprint,
    cardId: input.cardId,
    expectedRevision: input.expectedRevision,
    tombstoneRevision: parseContentRevision(input.expectedRevision + 1),
    deletedAt: input.deletedAt,
    committedAt: input.synchronizedAt,
  };
  for (let attempt = 0; attempt < maximumJournalCommitAttempts; attempt += 1) {
    const committed = await journalScope.repository.commit(command);
    if (committed.kind === 'applied' || committed.kind === 'replayed') {
      const finalized = await commitQuotaReservation(
        quotaScope.ledger,
        input.mutationId,
        fingerprint,
        input.limits,
        input.synchronizedAt,
      );
      return finalized.kind === 'committed'
        ? {
            kind: 'deleted',
            receipt: toSyncV2MutationReceipt(committed.receipt),
          }
        : finalized;
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
  readonly quota: VaultQuotaLedger;
  readonly mutation: PendingMutation;
  readonly synchronizedAt: number;
  readonly requestBytes: QuotaByteCount;
  readonly limits: PersonalVaultLimits;
  readonly reservationReconcileDelayMs: number;
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
    if (existing.fingerprint !== fingerprint) {
      return { kind: 'rejected', reason: 'idempotency-key-reuse' };
    }
    const finalized = await commitQuotaReservation(
      input.quota,
      input.mutation.mutationId,
      fingerprint,
      input.limits,
      input.synchronizedAt,
    );
    return finalized.kind === 'committed'
      ? { kind: 'applied', receipt: existing }
      : finalized;
  }

  const current = await input.journal.findCard(input.mutation.cardId);
  let currentContent: Awaited<ReturnType<SyncV2ContentRepository['readCard']>>;
  let plan = planSyncV2Mutation({
    mutation: input.mutation,
    current,
    currentContent: undefined,
  });
  if (plan.kind === 'requires-current-content') {
    currentContent = await input.content.readCard({
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

  const quotaCommand = prepareQuotaReservation({
    mutation: input.mutation,
    plan,
    currentContent,
    requestBytes: input.requestBytes,
    limits: input.limits,
    requestedAt: input.synchronizedAt,
    reservationReconcileDelayMs: input.reservationReconcileDelayMs,
    fingerprint,
  });
  if (quotaCommand.kind === 'rejected') return quotaCommand;
  const reserved = await input.quota.reserve(quotaCommand.command);
  if (reserved.kind === 'rejected') {
    return mapQuotaReservationRejection(reserved.reason);
  }
  if (reserved.reservation.state.kind !== 'reserved') {
    return { kind: 'rejected', reason: 'quota-unavailable' };
  }

  const written = await writeMutationContent(input, plan);
  if (written.kind === 'not-applied') {
    return {
      kind: 'rejected',
      reason:
        written.reason === 'idempotency-key-reuse'
          ? 'idempotency-key-reuse'
          : written.reason === 'ciphertext-limit'
            ? 'ciphertext-limit'
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
      const finalized = await commitQuotaReservation(
        input.quota,
        input.mutation.mutationId,
        fingerprint,
        input.limits,
        input.synchronizedAt,
      );
      return finalized.kind === 'committed'
        ? { kind: 'applied', receipt: committed.receipt }
        : finalized;
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

function prepareQuotaReservation(input: {
  readonly mutation: PendingMutation;
  readonly plan: Exclude<
    SyncV2MutationPlan,
    { readonly kind: 'requires-current-content' | 'rejected' }
  >;
  readonly currentContent: Awaited<
    ReturnType<SyncV2ContentRepository['readCard']>
  >;
  readonly requestBytes: QuotaByteCount;
  readonly limits: PersonalVaultLimits;
  readonly requestedAt: number;
  readonly reservationReconcileDelayMs: number;
  readonly fingerprint: SyncV2MutationFingerprint;
}):
  | { readonly kind: 'ready'; readonly command: VaultQuotaReservationCommand }
  | Extract<SyncV2ApplicationResult, { readonly kind: 'rejected' }> {
  const display = countCardDisplayCharacters({
    title: input.mutation.title,
    body: input.mutation.body,
  });
  if (display.kind === 'rejected') {
    return { kind: 'rejected', reason: 'display-character-limit' };
  }
  const serialized =
    input.plan.kind === 'write-card'
      ? encodeSyncV2StoredCard(input.plan.content)
      : encodeSyncV2StoredConflict(input.plan.content);
  const nextPlaintextBytes = parseQuotaByteCount(serialized.byteLength);
  const measurement = evaluateSyncV2QuotaMeasurement({
    measurement: {
      displayCharacters: display.characters,
      serializedPlaintextBytes: nextPlaintextBytes,
      requestBytes: input.requestBytes,
    },
    limits: input.limits,
    transportLimits: quotaTransportLimits,
  });
  if (measurement.kind === 'rejected') return measurement;
  const reconcileAfter = syncV2QuotaReconcileAfter(
    input.requestedAt,
    input.reservationReconcileDelayMs,
  );
  if (reconcileAfter === undefined) {
    return { kind: 'rejected', reason: 'quota-unavailable' };
  }
  const currentPlaintextBytes =
    input.currentContent === undefined
      ? undefined
      : parseQuotaByteCount(
          encodeSyncV2StoredCard(input.currentContent).byteLength,
        );
  let change;
  if (input.plan.kind === 'write-conflict') {
    if (currentPlaintextBytes === undefined) {
      return { kind: 'rejected', reason: 'scope-unavailable' };
    }
    change = toSyncV2VaultQuotaChange({
      kind: 'conflict-write',
      currentCardPlaintextBytes: currentPlaintextBytes,
    });
  } else if (input.plan.expectedRevision === null) {
    change = toSyncV2VaultQuotaChange({
      kind: 'card-write',
      currentPlaintextBytes: null,
      nextPlaintextBytes,
    });
  } else {
    if (currentPlaintextBytes === undefined) {
      return { kind: 'rejected', reason: 'scope-unavailable' };
    }
    change = toSyncV2VaultQuotaChange({
      kind: 'card-write',
      currentPlaintextBytes,
      nextPlaintextBytes,
    });
  }
  return {
    kind: 'ready',
    command: {
      reservationId: input.mutation.mutationId,
      fingerprint: parseVaultQuotaFingerprint(input.fingerprint),
      cardId: input.mutation.cardId,
      change,
      limits: input.limits,
      requestedAt: input.requestedAt,
      reconcileAfter,
    },
  };
}

async function commitQuotaReservation(
  quota: VaultQuotaLedger,
  reservationId: PendingMutation['mutationId'],
  fingerprint: SyncV2MutationFingerprint,
  limits: PersonalVaultLimits,
  finalizedAt: number,
): Promise<
  | { readonly kind: 'committed' }
  | Extract<SyncV2ApplicationResult, { readonly kind: 'rejected' }>
> {
  const result = await quota.finalize({
    reservationId,
    fingerprint: parseVaultQuotaFingerprint(fingerprint),
    outcome: 'commit',
    limits,
    finalizedAt,
  });
  if (
    result.kind === 'committed' ||
    (result.kind === 'replayed' &&
      result.reservation.state.kind === 'committed')
  ) {
    return { kind: 'committed' };
  }
  return {
    kind: 'rejected',
    reason:
      result.kind === 'rejected' && result.reason === 'idempotency-key-reuse'
        ? 'idempotency-key-reuse'
        : 'quota-unavailable',
  };
}

function mapQuotaReservationRejection(
  reason: Extract<
    Awaited<ReturnType<VaultQuotaLedger['reserve']>>,
    { readonly kind: 'rejected' }
  >['reason'],
): Extract<SyncV2ApplicationResult, { readonly kind: 'rejected' }> {
  switch (reason) {
    case 'idempotency-key-reuse':
    case 'active-card-limit':
    case 'vault-plaintext-limit':
      return { kind: 'rejected', reason };
    case 'invalid-input':
    case 'cas-conflict':
      return { kind: 'rejected', reason: 'quota-unavailable' };
  }
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

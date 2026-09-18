import type { MutationId, CardId } from '../../lib/domain/id';
import type { PersonalVaultLimits } from '../entitlement/public';
import {
  evaluateQuotaBoundaries,
  parseQuotaByteCount,
  type DisplayCharacterCount,
  type QuotaBoundaryRejectionReason,
  type QuotaByteCount,
  type QuotaTransportLimits,
  type VaultQuotaChange,
} from '../quota/public';

export type SyncV2QuotaOperation =
  | {
      readonly kind: 'card-write';
      readonly currentPlaintextBytes: QuotaByteCount | null;
      readonly nextPlaintextBytes: QuotaByteCount;
    }
  | {
      readonly kind: 'conflict-write';
      readonly currentCardPlaintextBytes: QuotaByteCount;
    }
  | {
      readonly kind: 'card-delete';
      readonly currentPlaintextBytes: QuotaByteCount;
    };

export type SyncV2QuotaMeasurement = {
  readonly displayCharacters: DisplayCharacterCount;
  readonly serializedPlaintextBytes: QuotaByteCount;
  readonly requestBytes: QuotaByteCount;
};

export type SyncV2QuotaMeasurementEvaluation =
  | { readonly kind: 'accepted' }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'request-limit'
        | 'display-character-limit'
        | 'serialized-plaintext-limit';
    };

export function toSyncV2VaultQuotaChange(
  operation: SyncV2QuotaOperation,
): VaultQuotaChange {
  switch (operation.kind) {
    case 'card-write':
      return operation.currentPlaintextBytes === null
        ? {
            kind: 'create',
            nextPlaintextBytes: operation.nextPlaintextBytes,
          }
        : {
            kind: 'update',
            currentPlaintextBytes: operation.currentPlaintextBytes,
            nextPlaintextBytes: operation.nextPlaintextBytes,
          };
    case 'conflict-write':
      return {
        kind: 'update',
        currentPlaintextBytes: operation.currentCardPlaintextBytes,
        nextPlaintextBytes: operation.currentCardPlaintextBytes,
      };
    case 'card-delete':
      return {
        kind: 'delete',
        currentPlaintextBytes: operation.currentPlaintextBytes,
      };
  }
}

export function evaluateSyncV2QuotaMeasurement(input: {
  readonly measurement: SyncV2QuotaMeasurement;
  readonly limits: PersonalVaultLimits;
  readonly transportLimits: QuotaTransportLimits;
}): SyncV2QuotaMeasurementEvaluation {
  const evaluation = evaluateQuotaBoundaries({
    measurement: {
      ...input.measurement,
      ciphertextBytes: zeroBytes,
    },
    limits: input.limits,
    transportLimits: input.transportLimits,
  });
  if (evaluation.kind === 'accepted') return evaluation;
  const reason = firstRelevantReason(evaluation.reasons);
  return reason === undefined
    ? { kind: 'accepted' }
    : { kind: 'rejected', reason };
}

export function syncV2QuotaReconcileAfter(
  requestedAt: number,
  delayMs: number,
): number | undefined {
  if (
    !Number.isSafeInteger(requestedAt) ||
    requestedAt < 0 ||
    !Number.isSafeInteger(delayMs) ||
    delayMs <= 0
  ) {
    return undefined;
  }
  const reconcileAfter = requestedAt + delayMs;
  return Number.isSafeInteger(reconcileAfter) ? reconcileAfter : undefined;
}

export function canonicalizeSyncV2CardDeletion(input: {
  readonly mutationId: MutationId;
  readonly cardId: CardId;
  readonly expectedRevision: number;
  readonly deletedAt: number;
}): string {
  return JSON.stringify([
    'fukamu-sync-v2-card-delete/v1',
    input.mutationId,
    input.cardId,
    input.expectedRevision,
    input.deletedAt,
  ]);
}

function firstRelevantReason(
  reasons: readonly QuotaBoundaryRejectionReason[],
): Exclude<QuotaBoundaryRejectionReason, 'ciphertext-limit'> | undefined {
  for (const reason of reasons) {
    if (reason !== 'ciphertext-limit') return reason;
  }
  return undefined;
}

const zeroBytes = parseQuotaByteCount(0);

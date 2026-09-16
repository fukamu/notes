import {
  decodeOrThrow,
  refineDecoder,
  stringDecoder,
  transformDecoder,
  type Decoder,
} from '../../lib/codec/core';
import type { VaultContext } from '../../lib/domain/identity';
import type { CardId, ConflictId, MutationId } from '../../lib/domain/id';
import type { SyncSequence } from '../../lib/sync/v2-protocol';
import type { ContentRevision, VaultPartitionRoute } from './records';

declare const syncV2MutationFingerprintBrand: unique symbol;

export type SyncV2MutationFingerprint = string & {
  readonly [syncV2MutationFingerprintBrand]: 'SyncV2MutationFingerprint';
};

export const syncV2MutationFingerprintDecoder: Decoder<SyncV2MutationFingerprint> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 43, maxLength: 43 }),
      (value) => /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value),
      'expected an unpadded SHA-256 base64url digest',
    ),
    // The exact SHA-256 base64url guard above is the runtime proof for this
    // nominal type. Remove this cast if TypeScript gains refined string brands.
    (value) => value as SyncV2MutationFingerprint,
  );

export function parseSyncV2MutationFingerprint(
  input: unknown,
): SyncV2MutationFingerprint {
  return decodeOrThrow(
    syncV2MutationFingerprintDecoder,
    input,
    'SyncV2MutationFingerprint',
  );
}

type CommitBase = {
  readonly mutationId: MutationId;
  readonly fingerprint: SyncV2MutationFingerprint;
  readonly committedAt: number;
};

export type SyncV2JournalCommit =
  | (CommitBase & {
      readonly kind: 'card-upsert';
      readonly cardId: CardId;
      readonly expectedRevision: ContentRevision | null;
      readonly nextRevision: ContentRevision;
      readonly updatedAt: number;
    })
  | (CommitBase & {
      readonly kind: 'conflict-upsert';
      readonly conflictId: ConflictId;
      readonly cardId: CardId;
      readonly serverRevision: ContentRevision;
      readonly createdAt: number;
    })
  | (CommitBase & {
      readonly kind: 'resolve-conflicts';
      readonly cardId: CardId;
      readonly expectedRevision: ContentRevision;
      readonly nextRevision: ContentRevision;
      readonly updatedAt: number;
      readonly conflictIds: readonly [ConflictId, ...ConflictId[]];
    })
  | (CommitBase & {
      readonly kind: 'card-delete';
      readonly cardId: CardId;
      readonly expectedRevision: ContentRevision;
      readonly tombstoneRevision: ContentRevision;
      readonly deletedAt: number;
    });

export type SyncV2JournalReceipt = {
  readonly mutationId: MutationId;
  readonly fingerprint: SyncV2MutationFingerprint;
  readonly cardId: CardId;
  readonly appliedRevision: ContentRevision;
  readonly committedAt: number;
};

export type SyncV2CardHead = {
  readonly cardId: CardId;
  readonly officialDisplayId: number;
  readonly revision: ContentRevision;
  readonly updatedAt: number;
};

export type SyncV2JournalChange =
  | {
      readonly kind: 'card-upsert';
      readonly sequence: SyncSequence;
      readonly cardId: CardId;
      readonly officialDisplayId: number;
      readonly revision: ContentRevision;
      readonly occurredAt: number;
    }
  | {
      readonly kind: 'card-tombstone';
      readonly sequence: SyncSequence;
      readonly cardId: CardId;
      readonly revision: ContentRevision;
      readonly deletedAt: number;
    }
  | {
      readonly kind: 'conflict-upsert';
      readonly sequence: SyncSequence;
      readonly conflictId: ConflictId;
      readonly cardId: CardId;
      readonly serverRevision: ContentRevision;
      readonly occurredAt: number;
    }
  | {
      readonly kind: 'conflict-tombstone';
      readonly sequence: SyncSequence;
      readonly conflictId: ConflictId;
      readonly cardId: CardId;
      readonly serverRevision: ContentRevision;
      readonly deletedAt: number;
    };

export type SyncV2JournalCommitResult =
  | {
      readonly kind: 'applied';
      readonly receipt: SyncV2JournalReceipt;
    }
  | {
      readonly kind: 'replayed';
      readonly receipt: SyncV2JournalReceipt;
    }
  | {
      readonly kind: 'not-applied';
      readonly reason:
        | 'idempotency-key-reuse'
        | 'unexpected-card'
        | 'missing-card'
        | 'stale-revision'
        | 'invalid-next-revision'
        | 'unexpected-conflict'
        | 'missing-conflict'
        | 'conflict-card-mismatch'
        | 'invalid-timeline'
        | 'invalid-state'
        | 'cas-conflict';
    };

export type SyncV2JournalPage = {
  readonly highWatermark: SyncSequence;
  readonly changes: readonly SyncV2JournalChange[];
  readonly page:
    | { readonly kind: 'more'; readonly afterSequence: SyncSequence }
    | { readonly kind: 'complete'; readonly afterSequence: SyncSequence };
};

export type SyncV2JournalRepository = {
  findCard(cardId: CardId): Promise<SyncV2CardHead | undefined>;
  findReceipt(
    mutationId: MutationId,
  ): Promise<SyncV2JournalReceipt | undefined>;
  commit(command: SyncV2JournalCommit): Promise<SyncV2JournalCommitResult>;
  readPage(input: {
    readonly afterSequence: SyncSequence;
    readonly highWatermark: SyncSequence | null;
    readonly limit: number;
  }): Promise<SyncV2JournalPage>;
};

export type SyncV2JournalOpenResult =
  | {
      readonly kind: 'opened';
      readonly route: VaultPartitionRoute;
      readonly repository: SyncV2JournalRepository;
    }
  | { readonly kind: 'not-found' };

export type SyncV2JournalDirectory = {
  open(context: VaultContext): Promise<SyncV2JournalOpenResult>;
};

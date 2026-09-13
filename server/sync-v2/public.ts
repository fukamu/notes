import type { VaultContext } from '../../lib/domain/identity';
import type { CardId, ConflictId, MutationId } from '../../lib/domain/id';
import type { BodySegment, PendingMutation } from '../../lib/domain/types';
import type {
  SyncSequence,
  SyncV2Request,
  SyncV2Response,
} from '../../lib/sync/v2-protocol';
import type { SyncV2CursorAuthenticator } from '../../lib/sync/v2-cursor';
import type { VaultPartitionRoute } from '../vault-content/records';
import type {
  SyncV2CardHead,
  SyncV2JournalDirectory,
} from '../vault-content/sync-v2-public';

export type SyncV2StoredCard = {
  readonly title: string;
  readonly body: readonly BodySegment[];
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type SyncV2StoredConflict = {
  readonly localTitle: string;
  readonly localBody: readonly BodySegment[];
  readonly serverTitle: string;
  readonly serverBody: readonly BodySegment[];
  readonly createdAt: number;
};

export type SyncV2ContentWriteResult =
  | { readonly kind: 'stored' | 'replayed' }
  | {
      readonly kind: 'not-applied';
      readonly reason:
        | 'idempotency-key-reuse'
        | 'unexpected-existing-object'
        | 'missing-object'
        | 'stale-revision'
        | 'invalid-next-revision'
        | 'invalid-timeline'
        | 'cas-conflict';
    };

export type SyncV2ContentRepository = {
  readCard(input: {
    readonly cardId: CardId;
    readonly revision: number;
  }): Promise<SyncV2StoredCard | undefined>;
  readConflict(input: {
    readonly conflictId: ConflictId;
  }): Promise<SyncV2StoredConflict | undefined>;
  writeCard(input: {
    readonly cardId: CardId;
    readonly expectedRevision: number | null;
    readonly nextRevision: number;
    readonly writeId: MutationId;
    readonly content: SyncV2StoredCard;
    readonly writtenAt: number;
  }): Promise<SyncV2ContentWriteResult>;
  writeConflict(input: {
    readonly conflictId: ConflictId;
    readonly writeId: MutationId;
    readonly content: SyncV2StoredConflict;
    readonly writtenAt: number;
  }): Promise<SyncV2ContentWriteResult>;
};

export type SyncV2ContentOpenResult =
  | {
      readonly kind: 'opened';
      readonly route: VaultPartitionRoute;
      readonly repository: SyncV2ContentRepository;
    }
  | { readonly kind: 'not-found' };

export type SyncV2ContentDirectory = {
  open(context: VaultContext): Promise<SyncV2ContentOpenResult>;
};

export type SyncV2KeyringPort = {
  read(context: VaultContext): Promise<unknown>;
};

export type SyncV2MutationFingerprintPort = {
  digest(canonicalMutation: string): Promise<unknown>;
};

export type SyncV2ClockPort = {
  now(): unknown;
};

export type SyncV2MutationPlanningInput = {
  readonly mutation: PendingMutation;
  readonly current: SyncV2CardHead | undefined;
  readonly currentContent: SyncV2StoredCard | undefined;
};

export type SyncV2MutationPlan =
  | {
      readonly kind: 'requires-current-content';
      readonly revision: number;
    }
  | {
      readonly kind: 'write-card';
      readonly expectedRevision: number | null;
      readonly nextRevision: number;
      readonly content: SyncV2StoredCard;
    }
  | {
      readonly kind: 'write-conflict';
      readonly conflictId: ConflictId;
      readonly serverRevision: number;
      readonly content: SyncV2StoredConflict;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: 'missing-card' | 'stale-revision' | 'invalid-timeline';
    };

export type SyncV2ApplicationDependencies = {
  readonly journals: SyncV2JournalDirectory;
  readonly contents: SyncV2ContentDirectory;
  readonly cursors: SyncV2CursorAuthenticator;
  readonly fingerprints: SyncV2MutationFingerprintPort;
};

export type SyncV2ApplicationResult =
  | { readonly kind: 'synchronized'; readonly response: SyncV2Response }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-cursor'
        | 'scope-unavailable'
        | 'idempotency-key-reuse'
        | 'mutation-conflict';
    };

export type SyncV2ApplicationInput = {
  readonly context: VaultContext;
  readonly request: SyncV2Request;
  readonly synchronizedAt: number;
};

export type SyncV2Application = {
  synchronize(input: SyncV2ApplicationInput): Promise<SyncV2ApplicationResult>;
};

export type SyncV2CursorWindow = {
  readonly afterSequence: SyncSequence;
  readonly highWatermark: SyncSequence | null;
};

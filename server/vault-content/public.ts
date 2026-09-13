import type { VaultContext } from '../../lib/domain/identity';
import type { CardId, ConflictId, MutationId } from '../../lib/domain/id';
import type {
  ContentRevision,
  PartitionId,
  RoutingRevision,
  VaultCardIndexRecord,
  VaultConflictIndexRecord,
  VaultMutationReceiptRecord,
  VaultPartitionRoute,
} from './records';

export type PartitionAssignment = {
  readonly partitionId: PartitionId;
  readonly updatedAt: number;
};

export type PartitionCompareAndSwap = {
  readonly expectedRoutingRevision: RoutingRevision;
  readonly nextPartitionId: PartitionId;
  readonly updatedAt: number;
};

export type CardCompareAndSwap = {
  readonly cardId: CardId;
  readonly expectedRevision: ContentRevision | null;
  readonly nextRevision: ContentRevision;
  readonly updatedAt: number;
};

export type MutationReceiptWrite = VaultMutationReceiptRecord;
export type ConflictIndexWrite = VaultConflictIndexRecord;

export type ScopedWriteResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'not-applied' };

export type VaultContentRepository = {
  findCard(cardId: CardId): Promise<VaultCardIndexRecord | undefined>;
  listCards(): Promise<readonly VaultCardIndexRecord[]>;
  compareAndSwapCard(command: CardCompareAndSwap): Promise<ScopedWriteResult>;
  deleteCard(
    cardId: CardId,
    expectedRevision: ContentRevision,
  ): Promise<ScopedWriteResult>;
  findMutationReceipt(
    mutationId: MutationId,
  ): Promise<VaultMutationReceiptRecord | undefined>;
  recordMutationReceipt(
    receipt: MutationReceiptWrite,
  ): Promise<ScopedWriteResult>;
  findConflict(
    conflictId: ConflictId,
  ): Promise<VaultConflictIndexRecord | undefined>;
  recordConflict(conflict: ConflictIndexWrite): Promise<ScopedWriteResult>;
  deleteConflict(
    conflictId: ConflictId,
    expectedServerRevision: ContentRevision,
  ): Promise<ScopedWriteResult>;
};

export type VaultRepositoryOpenResult =
  | {
      readonly kind: 'opened';
      readonly route: VaultPartitionRoute;
      readonly repository: VaultContentRepository;
    }
  | { readonly kind: 'not-found' };

export type PartitionCommandResult =
  | { readonly kind: 'applied'; readonly route: VaultPartitionRoute }
  | { readonly kind: 'not-applied' };

export type VaultContentDirectory = {
  assignPartition(
    context: VaultContext,
    assignment: PartitionAssignment,
  ): Promise<PartitionCommandResult>;
  compareAndSwapPartition(
    context: VaultContext,
    command: PartitionCompareAndSwap,
  ): Promise<PartitionCommandResult>;
  open(context: VaultContext): Promise<VaultRepositoryOpenResult>;
};

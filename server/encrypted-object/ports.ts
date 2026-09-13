import type { VaultContext } from '../../lib/domain/identity';
import type { VaultPartitionRoute } from '../vault-content/records';
import type {
  DeleteOutboxEntry,
  EncryptedObjectMetadata,
  EncryptedWriteId,
  OpaqueObjectKey,
  PendingEncryptedWrite,
  PrivateObjectDescriptor,
} from './core';
import type { EnvelopeObject } from '../crypto/core';
import type { CryptoObjectRevision } from '../crypto/core';

export type ImmutableObjectPutResult =
  | { readonly kind: 'stored' }
  | { readonly kind: 'already-present' }
  | { readonly kind: 'conflict' };

export type PrivateObjectStoragePort = {
  get(objectKey: OpaqueObjectKey): Promise<Uint8Array | undefined>;
  putIfAbsent(input: {
    readonly objectKey: OpaqueObjectKey;
    readonly bytes: Uint8Array;
    readonly createdAt: number;
  }): Promise<ImmutableObjectPutResult>;
  delete(objectKey: OpaqueObjectKey): Promise<void>;
  list(): Promise<readonly PrivateObjectDescriptor[]>;
};

export type OpaqueObjectKeyGeneratorPort = {
  createObjectKey(): Promise<unknown>;
};

export type IntentReservationResult =
  | { readonly kind: 'reserved'; readonly intent: PendingEncryptedWrite }
  | { readonly kind: 'existing'; readonly intent: PendingEncryptedWrite }
  | { readonly kind: 'conflict' };

export type MetadataCommitResult =
  | { readonly kind: 'applied'; readonly metadata: EncryptedObjectMetadata }
  | { readonly kind: 'not-applied' };

export type EncryptedObjectMetadataRepository = {
  findCurrent(
    object: EnvelopeObject,
  ): Promise<EncryptedObjectMetadata | undefined>;
  findRevision(
    object: EnvelopeObject,
    objectRevision: CryptoObjectRevision,
  ): Promise<EncryptedObjectMetadata | undefined>;
  findByWriteId(
    writeId: EncryptedWriteId,
  ): Promise<EncryptedObjectMetadata | undefined>;
  findIntent(
    writeId: EncryptedWriteId,
  ): Promise<PendingEncryptedWrite | undefined>;
  reserveIntent(
    intent: PendingEncryptedWrite,
  ): Promise<IntentReservationResult>;
  commitIntent(input: {
    readonly intent: PendingEncryptedWrite;
    readonly ciphertextBytes: number;
  }): Promise<MetadataCommitResult>;
  abandonIntent(input: {
    readonly intent: PendingEncryptedWrite;
    readonly requestedAt: number;
  }): Promise<void>;
  listProtectedObjectKeys(): Promise<ReadonlySet<OpaqueObjectKey>>;
  enqueueDelete(input: {
    readonly objectKey: OpaqueObjectKey;
    readonly requestedAt: number;
  }): Promise<void>;
  listReadyDeletes(input: {
    readonly now: number;
    readonly limit: number;
  }): Promise<readonly DeleteOutboxEntry[]>;
  completeDelete(entry: DeleteOutboxEntry): Promise<void>;
  rescheduleDelete(entry: DeleteOutboxEntry): Promise<void>;
};

export type EncryptedObjectRepositoryOpenResult =
  | {
      readonly kind: 'opened';
      readonly route: VaultPartitionRoute;
      readonly repository: EncryptedObjectMetadataRepository;
    }
  | { readonly kind: 'not-found' };

export type EncryptedObjectMetadataDirectory = {
  open(context: VaultContext): Promise<EncryptedObjectRepositoryOpenResult>;
};

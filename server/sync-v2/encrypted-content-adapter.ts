import { BoundaryDecodeError } from '../../lib/codec/core';
import type { VaultContext } from '../../lib/domain/identity';
import type { MutationId } from '../../lib/domain/id';
import {
  decodeVaultDekKeyring,
  parseCryptoObjectRevision,
} from '../crypto/core';
import type { EnvelopeEncryptionService } from '../crypto/envelope-service';
import type { EncryptedObjectMetadataDirectory } from '../encrypted-object/ports';
import type {
  OpaqueObjectKeyGeneratorPort,
  PrivateObjectStoragePort,
} from '../encrypted-object/ports';
import { parseEncryptedWriteId } from '../encrypted-object/core';
import {
  createEncryptedObjectService,
  type EncryptedObjectService,
  type EncryptedObjectWriteResult,
} from '../encrypted-object/service';
import {
  decodeSyncV2StoredCard,
  decodeSyncV2StoredConflict,
  encodeSyncV2StoredCard,
  encodeSyncV2StoredConflict,
} from './content-codec';
import type {
  SyncV2ContentDirectory,
  SyncV2ContentOpenResult,
  SyncV2ContentRepository,
  SyncV2ContentWriteResult,
  SyncV2KeyringPort,
} from './public';

export class EncryptedSyncV2ContentDirectory implements SyncV2ContentDirectory {
  constructor(
    private readonly metadata: EncryptedObjectMetadataDirectory,
    private readonly objects: PrivateObjectStoragePort,
    private readonly objectKeys: OpaqueObjectKeyGeneratorPort,
    private readonly encryption: EnvelopeEncryptionService,
    private readonly keyrings: SyncV2KeyringPort,
  ) {}

  async open(context: VaultContext): Promise<SyncV2ContentOpenResult> {
    const opened = await this.metadata.open(context);
    if (opened.kind === 'not-found') return opened;
    const keyring = decodeVaultDekKeyring(await this.keyrings.read(context));
    if (keyring.vaultId !== context.vaultId) {
      throw new BoundaryDecodeError('Sync v2 Vault keyring', [
        { path: ['vaultId'], reason: 'does not match authenticated Vault' },
      ]);
    }
    const service = createEncryptedObjectService({
      context,
      metadata: opened.repository,
      objects: this.objects,
      objectKeys: this.objectKeys,
      encryption: this.encryption,
    });
    return {
      kind: 'opened',
      route: opened.route,
      repository: new EncryptedSyncV2ContentRepository(service, keyring),
    };
  }
}

class EncryptedSyncV2ContentRepository implements SyncV2ContentRepository {
  constructor(
    private readonly service: EncryptedObjectService,
    private readonly keyring: ReturnType<typeof decodeVaultDekKeyring>,
  ) {}

  async readCard(input: Parameters<SyncV2ContentRepository['readCard']>[0]) {
    const result = await this.service.readRevision({
      object: { kind: 'card', objectId: input.cardId },
      objectRevision: parseCryptoObjectRevision(input.revision),
      keyring: this.keyring,
    });
    return result.kind === 'not-found'
      ? undefined
      : decodeSyncV2StoredCard(result.plaintext);
  }

  async readConflict(
    input: Parameters<SyncV2ContentRepository['readConflict']>[0],
  ) {
    const result = await this.service.readRevision({
      object: { kind: 'conflict', objectId: input.conflictId },
      objectRevision: parseCryptoObjectRevision(1),
      keyring: this.keyring,
    });
    return result.kind === 'not-found'
      ? undefined
      : decodeSyncV2StoredConflict(result.plaintext);
  }

  async writeCard(
    input: Parameters<SyncV2ContentRepository['writeCard']>[0],
  ): Promise<SyncV2ContentWriteResult> {
    return mapWriteResult(
      await this.service.write({
        object: { kind: 'card', objectId: input.cardId },
        expectedRevision:
          input.expectedRevision === null
            ? null
            : parseCryptoObjectRevision(input.expectedRevision),
        nextRevision: parseCryptoObjectRevision(input.nextRevision),
        writeId: encryptedWriteId(input.writeId),
        plaintext: encodeSyncV2StoredCard(input.content),
        keyring: this.keyring,
        createdAt: input.writtenAt,
      }),
    );
  }

  async writeConflict(
    input: Parameters<SyncV2ContentRepository['writeConflict']>[0],
  ): Promise<SyncV2ContentWriteResult> {
    return mapWriteResult(
      await this.service.write({
        object: { kind: 'conflict', objectId: input.conflictId },
        expectedRevision: null,
        nextRevision: parseCryptoObjectRevision(1),
        writeId: encryptedWriteId(input.writeId),
        plaintext: encodeSyncV2StoredConflict(input.content),
        keyring: this.keyring,
        createdAt: input.writtenAt,
      }),
    );
  }
}

function encryptedWriteId(mutationId: MutationId) {
  return parseEncryptedWriteId(mutationId);
}

function mapWriteResult(
  result: EncryptedObjectWriteResult,
): SyncV2ContentWriteResult {
  switch (result.kind) {
    case 'stored':
    case 'replayed':
      return { kind: result.kind };
    case 'not-applied':
      return result;
  }
}

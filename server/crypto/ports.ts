import type { VaultId } from '../../lib/domain/identity';
import type {
  DekVersion,
  EncryptionNonce,
  SealedPayload,
  VaultDekMetadata,
} from './core';
import type { DataEncryptionKey } from './key-material';

export type KeyManagementPort = {
  generateDataKey(input: {
    readonly vaultId: VaultId;
    readonly dekVersion: DekVersion;
  }): Promise<{
    readonly metadata: VaultDekMetadata;
    readonly key: DataEncryptionKey;
  }>;
  unwrapDataKey(metadata: VaultDekMetadata): Promise<DataEncryptionKey>;
};

export type NonceGeneratorPort = {
  createNonce(): Promise<unknown>;
};

export type NonceReservationPort = {
  reserve(input: {
    readonly vaultId: VaultId;
    readonly dekVersion: DekVersion;
    readonly nonce: EncryptionNonce;
  }): Promise<boolean>;
};

export type Aes256GcmPort = {
  seal(input: {
    readonly key: DataEncryptionKey;
    readonly nonce: EncryptionNonce;
    readonly aad: string;
    readonly plaintext: Uint8Array;
  }): Promise<SealedPayload>;
  open(input: {
    readonly key: DataEncryptionKey;
    readonly nonce: EncryptionNonce;
    readonly aad: string;
    readonly sealedPayload: SealedPayload;
  }): Promise<Uint8Array>;
};

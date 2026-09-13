import type { VaultId } from '../../lib/domain/identity';
import type { DekVersion, VaultDekMetadata } from '../crypto/core';
import { createDataEncryptionKey } from '../crypto/key-material';
import type { KeyManagementPort } from '../crypto/ports';

type FakeKeyRecord = {
  readonly metadata: VaultDekMetadata;
  readonly keyBytes: Uint8Array;
};

export class FakeKeyManagementError extends Error {
  constructor() {
    super('Fake key management operation failed');
    this.name = 'FakeKeyManagementError';
  }
}

export type FakeKeyManagement = KeyManagementPort & {
  readonly metadata: () => readonly VaultDekMetadata[];
};

export function createFakeKeyManagement(input: {
  readonly records: readonly {
    readonly metadata: VaultDekMetadata;
    readonly keyBytes: unknown;
  }[];
  readonly failGenerate?: boolean;
  readonly failUnwrap?: boolean;
}): FakeKeyManagement {
  const records: FakeKeyRecord[] = input.records.map((record) => {
    if (
      !(record.keyBytes instanceof Uint8Array) ||
      record.keyBytes.byteLength !== 32
    ) {
      throw new FakeKeyManagementError();
    }
    return { metadata: record.metadata, keyBytes: record.keyBytes.slice() };
  });
  return {
    async generateDataKey(request) {
      if (input.failGenerate === true) throw new FakeKeyManagementError();
      const record = findGeneratedRecord(
        records,
        request.vaultId,
        request.dekVersion,
      );
      return {
        metadata: record.metadata,
        key: createDataEncryptionKey(record.keyBytes),
      };
    },
    async unwrapDataKey(metadata) {
      if (input.failUnwrap === true) throw new FakeKeyManagementError();
      const record = records.find(
        (candidate) =>
          candidate.metadata.vaultId === metadata.vaultId &&
          candidate.metadata.dekVersion === metadata.dekVersion &&
          candidate.metadata.kekKeyReference === metadata.kekKeyReference &&
          candidate.metadata.wrappedDek === metadata.wrappedDek,
      );
      if (record === undefined) throw new FakeKeyManagementError();
      return createDataEncryptionKey(record.keyBytes);
    },
    metadata() {
      return records.map((record) => record.metadata);
    },
  };
}

function findGeneratedRecord(
  records: readonly FakeKeyRecord[],
  vaultId: VaultId,
  dekVersion: DekVersion,
): FakeKeyRecord {
  const record = records.find(
    (candidate) =>
      candidate.metadata.vaultId === vaultId &&
      candidate.metadata.dekVersion === dekVersion,
  );
  if (record === undefined) throw new FakeKeyManagementError();
  return record;
}

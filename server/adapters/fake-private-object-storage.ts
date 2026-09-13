import type {
  OpaqueObjectKey,
  PrivateObjectDescriptor,
} from '../encrypted-object/core';
import type {
  ImmutableObjectPutResult,
  PrivateObjectStoragePort,
} from '../encrypted-object/ports';

type StoredFakeObject = {
  readonly bytes: Uint8Array;
  readonly createdAt: number;
};

export class FakePrivateObjectStorageError extends Error {
  constructor() {
    super('Fake private object storage operation failed');
    this.name = 'FakePrivateObjectStorageError';
  }
}

export type FakePrivateObjectStorage = PrivateObjectStoragePort & {
  calls(): Readonly<{
    get: number;
    put: number;
    delete: number;
    list: number;
  }>;
  failNext(operation: 'get' | 'put' | 'delete' | 'list'): void;
  failDeleteForTest(objectKey: OpaqueObjectKey): void;
  replaceForTest(objectKey: OpaqueObjectKey, bytes: Uint8Array): void;
};

export function createFakePrivateObjectStorage(
  seed: readonly {
    readonly objectKey: OpaqueObjectKey;
    readonly bytes: Uint8Array;
    readonly createdAt: number;
  }[] = [],
): FakePrivateObjectStorage {
  const objects = new Map<OpaqueObjectKey, StoredFakeObject>(
    seed.map((entry) => [
      entry.objectKey,
      { bytes: entry.bytes.slice(), createdAt: entry.createdAt },
    ]),
  );
  const counts = { get: 0, put: 0, delete: 0, list: 0 };
  const failures = { get: 0, put: 0, delete: 0, list: 0 };
  const deleteFailures = new Set<OpaqueObjectKey>();

  function consumeFailure(operation: keyof typeof failures): void {
    if (failures[operation] === 0) return;
    failures[operation] -= 1;
    throw new FakePrivateObjectStorageError();
  }

  return {
    async get(objectKey) {
      counts.get += 1;
      consumeFailure('get');
      return objects.get(objectKey)?.bytes.slice();
    },
    async putIfAbsent(input): Promise<ImmutableObjectPutResult> {
      counts.put += 1;
      consumeFailure('put');
      const existing = objects.get(input.objectKey);
      if (existing !== undefined) {
        return bytesEqual(existing.bytes, input.bytes)
          ? { kind: 'already-present' }
          : { kind: 'conflict' };
      }
      objects.set(input.objectKey, {
        bytes: input.bytes.slice(),
        createdAt: input.createdAt,
      });
      return { kind: 'stored' };
    },
    async delete(objectKey) {
      counts.delete += 1;
      consumeFailure('delete');
      if (deleteFailures.delete(objectKey)) {
        throw new FakePrivateObjectStorageError();
      }
      return objects.delete(objectKey)
        ? { kind: 'deleted' }
        : { kind: 'not-found' };
    },
    async list(): Promise<readonly PrivateObjectDescriptor[]> {
      counts.list += 1;
      consumeFailure('list');
      return [...objects.entries()]
        .map(([objectKey, stored]) => ({
          objectKey,
          createdAt: stored.createdAt,
        }))
        .sort((left, right) => left.objectKey.localeCompare(right.objectKey));
    },
    calls() {
      return { ...counts };
    },
    failNext(operation) {
      failures[operation] += 1;
    },
    failDeleteForTest(objectKey) {
      deleteFailures.add(objectKey);
    },
    replaceForTest(objectKey, bytes) {
      const existing = objects.get(objectKey);
      if (existing === undefined) throw new FakePrivateObjectStorageError();
      objects.set(objectKey, {
        bytes: bytes.slice(),
        createdAt: existing.createdAt,
      });
    },
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

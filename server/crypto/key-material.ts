import type { DecodeResult } from '../../lib/codec/core';

export type DataEncryptionKey = {
  use<TResult>(
    operation: (bytes: Uint8Array) => Promise<TResult>,
  ): Promise<TResult>;
  destroy(): void;
  readonly destroyed: boolean;
  toString(): string;
  toJSON(): string;
};

export class DestroyedDataEncryptionKeyError extends Error {
  constructor() {
    super('Data encryption key is unavailable');
    this.name = 'DestroyedDataEncryptionKeyError';
  }
}

export function createDataEncryptionKey(input: unknown): DataEncryptionKey {
  const decoded = dataEncryptionKeyBytes(input);
  if (!decoded.ok)
    throw new TypeError('Expected a 32-byte data encryption key');
  return new EphemeralDataEncryptionKey(decoded.value);
}

function dataEncryptionKeyBytes(input: unknown): DecodeResult<Uint8Array> {
  if (!(input instanceof Uint8Array) || input.byteLength !== 32) {
    return {
      ok: false,
      issues: [{ path: [], reason: 'expected 32-byte Uint8Array' }],
    };
  }
  return { ok: true, value: input.slice() };
}

class EphemeralDataEncryptionKey implements DataEncryptionKey {
  #bytes: Uint8Array | undefined;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  get destroyed(): boolean {
    return this.#bytes === undefined;
  }

  async use<TResult>(
    operation: (bytes: Uint8Array) => Promise<TResult>,
  ): Promise<TResult> {
    if (this.#bytes === undefined) throw new DestroyedDataEncryptionKeyError();
    const workingCopy = this.#bytes.slice();
    try {
      return await operation(workingCopy);
    } finally {
      workingCopy.fill(0);
    }
  }

  destroy(): void {
    this.#bytes?.fill(0);
    this.#bytes = undefined;
  }

  toString(): string {
    return '[REDACTED data encryption key]';
  }

  toJSON(): string {
    return '[REDACTED data encryption key]';
  }
}

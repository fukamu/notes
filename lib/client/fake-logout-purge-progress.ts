import {
  inspectLogoutPurgeProgress,
  sameLogoutPurgeGeneration,
} from '@/lib/application/logout-purge';
import type {
  LogoutPurgeProgressClear,
  LogoutPurgeProgressPort,
  LogoutPurgeProgressWrite,
} from '@/lib/application/logout-purge-progress';

export type FakeLogoutPurgeProgressOperation = 'read' | 'write' | 'clear';
export type FakeLogoutPurgeProgressFailure = 'throw' | 'invalid-result';

export type FakeLogoutPurgeProgressPort = LogoutPurgeProgressPort & {
  marker: () => unknown;
  seed: (marker: unknown) => void;
  failNext: (
    operation: FakeLogoutPurgeProgressOperation,
    failure: FakeLogoutPurgeProgressFailure,
  ) => void;
};

/** In-memory test adapter. It must never be wired into production composition. */
export function createFakeLogoutPurgeProgressPort(
  initialMarker?: unknown,
): FakeLogoutPurgeProgressPort {
  let marker = initialMarker;
  const failures = new Map<
    FakeLogoutPurgeProgressOperation,
    FakeLogoutPurgeProgressFailure
  >();

  return {
    async read() {
      const failure = takeFailure(failures, 'read');
      if (failure === 'throw') throw new Error('fake progress read failure');
      if (failure === 'invalid-result') return { invalid: true };
      return marker;
    },
    async write(input) {
      const failure = takeFailure(failures, 'write');
      if (failure === 'throw') throw new Error('fake progress write failure');
      if (failure === 'invalid-result') return 'invalid-result';
      if (!canWrite(marker, input)) return false;
      marker = input.progress;
      return true;
    },
    async clear(input) {
      const failure = takeFailure(failures, 'clear');
      if (failure === 'throw') throw new Error('fake progress clear failure');
      if (failure === 'invalid-result') return 'invalid-result';
      if (!canClear(marker, input)) return false;
      marker = undefined;
      return true;
    },
    marker() {
      return marker;
    },
    seed(value) {
      marker = value;
    },
    failNext(operation, failure) {
      failures.set(operation, failure);
    },
  };
}

function canWrite(marker: unknown, input: LogoutPurgeProgressWrite): boolean {
  switch (input.kind) {
    case 'create':
      return marker === undefined;
    case 'replace': {
      const current = inspectLogoutPurgeProgress(marker);
      return (
        current.kind === 'loaded' &&
        current.progress.revision === input.expectedRevision &&
        sameLogoutPurgeGeneration(current.progress, input.progress)
      );
    }
  }
}

function canClear(marker: unknown, input: LogoutPurgeProgressClear): boolean {
  const current = inspectLogoutPurgeProgress(marker);
  return (
    current.kind === 'loaded' &&
    current.progress.revision === input.expectedRevision &&
    sameLogoutPurgeGeneration(current.progress, input.generation)
  );
}

function takeFailure(
  failures: Map<
    FakeLogoutPurgeProgressOperation,
    FakeLogoutPurgeProgressFailure
  >,
  operation: FakeLogoutPurgeProgressOperation,
): FakeLogoutPurgeProgressFailure | undefined {
  const failure = failures.get(operation);
  failures.delete(operation);
  return failure;
}

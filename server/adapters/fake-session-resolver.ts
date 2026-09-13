import type { SessionToken } from '../../lib/domain/identity';
import type { SessionCredentialResolver } from '../session-boundary';

export type FakeSessionEntry = {
  readonly token: SessionToken;
  readonly record: unknown;
};

/** Test-only adapter. Production storage must resolve a hash, not store tokens. */
export function createFakeSessionResolver(
  entries: readonly FakeSessionEntry[],
): SessionCredentialResolver {
  const records = new Map<SessionToken, unknown>(
    entries.map((entry) => [entry.token, entry.record]),
  );
  return {
    findSessionByToken: async (token) => records.get(token),
  };
}

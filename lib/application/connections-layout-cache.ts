import type { ConnectionsLayoutRunner } from '@/lib/graph/connections-controller';
import { connectionsLayoutGraphKey } from '@/lib/graph/connections-layout-key';

/**
 * Shares in-flight and settled immutable layouts across view re-entry. Rejected
 * work is evicted so a temporary worker failure remains retryable.
 */
export function createBoundedConnectionsLayoutRunner(
  runner: ConnectionsLayoutRunner,
  maximumEntries: number,
): ConnectionsLayoutRunner {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries <= 0) {
    throw new Error('Connections layout cache capacity must be positive');
  }
  const entries = new Map<string, ReturnType<ConnectionsLayoutRunner>>();

  return (graph, metrics) => {
    const key = connectionsLayoutGraphKey(graph, metrics);
    const cached = entries.get(key);
    if (cached) {
      entries.delete(key);
      entries.set(key, cached);
      return cached;
    }

    const pending = Promise.resolve().then(() => runner(graph, metrics));
    entries.set(key, pending);
    while (entries.size > maximumEntries) {
      const oldestKey = entries.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      entries.delete(oldestKey);
    }
    void pending.catch(() => {
      if (entries.get(key) === pending) entries.delete(key);
    });
    return pending;
  };
}

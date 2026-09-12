import ElkConstructor from 'elkjs/lib/elk.bundled.js';
import {
  createConnectionsLayoutRunner,
  DEFAULT_CONNECTIONS_LAYOUT_CONFIGURATION,
  type ConnectionsLayoutConfiguration,
  type ConnectionsLayoutFunction,
} from '@/lib/graph/elk-layout';

/** Main-thread adapter retained for deterministic tests and route benchmarks. */
export function createMainThreadConnectionsLayoutRunner(
  configuration: ConnectionsLayoutConfiguration = DEFAULT_CONNECTIONS_LAYOUT_CONFIGURATION,
): ConnectionsLayoutFunction {
  return createConnectionsLayoutRunner(
    new ElkConstructor({ algorithms: ['layered'] }),
    configuration,
  );
}

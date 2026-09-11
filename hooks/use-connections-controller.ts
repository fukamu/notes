'use client';

import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { ConnectionsPresentationAdapter } from '@/components/connections-presentation';
import type {
  ConnectionsControllerState,
  ConnectionsInputModel,
} from '@/lib/graph/connections-contract';
import {
  createConnectionsController,
  type ConnectionsLayoutRunner,
} from '@/lib/graph/connections-controller';

export function useConnectionsController(
  input: ConnectionsInputModel,
  presentation: ConnectionsPresentationAdapter,
  runner?: ConnectionsLayoutRunner,
): ConnectionsControllerState {
  const [controller] = useState(() =>
    createConnectionsController(input, presentation.layoutMetrics, runner),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );

  useLayoutEffect(() => {
    controller.update(input, presentation.layoutMetrics);
  }, [controller, input, presentation.layoutMetrics]);

  useLayoutEffect(() => () => controller.destroy(), [controller]);

  return state;
}

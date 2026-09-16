'use client';

import {
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ComponentType,
} from 'react';
import type { ConnectionsRendererProps } from '@/components/presentation-contract';
import {
  createFullNetworkLayoutController,
  type FullNetworkLayoutController,
} from '@/lib/application/full-network-layout-controller';
import type { FullNetworkMapSession } from '@/lib/application/full-network-map-session';
import type { NotesScope } from '@/lib/application/notes-runtime';
import { createBrowserFullNetworkLayoutExecution } from '@/lib/client/full-network-layout-worker';
import type {
  ConnectionsInputModel,
  ConnectionsSelectionActions,
} from '@/lib/graph/connections-contract';

type Props = {
  input: ConnectionsInputModel;
  actions: Pick<ConnectionsSelectionActions, 'openCard'>;
  scope: NotesScope;
  session: FullNetworkMapSession;
  Renderer: ComponentType<ConnectionsRendererProps>;
};

function createController(scope: NotesScope): FullNetworkLayoutController {
  return createFullNetworkLayoutController({
    scope,
    execution: createBrowserFullNetworkLayoutExecution(scope),
  });
}

export function ConnectionsAdapter({
  input,
  actions,
  scope,
  session,
  Renderer,
}: Props) {
  const controller = useMemo(() => createController(scope), [scope]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );

  useEffect(() => {
    controller.update(input);
  }, [controller, input]);
  useEffect(() => () => controller.destroy(), [controller]);

  return (
    <Renderer
      state={state}
      actions={actions}
      scope={scope}
      session={session}
      retryLayout={controller.retry}
    />
  );
}

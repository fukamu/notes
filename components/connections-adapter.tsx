'use client';

import type { ComponentType } from 'react';
import type { ConnectionsPresentationAdapter } from '@/components/connections-presentation';
import type { ConnectionsRendererProps } from '@/components/presentation-contract';
import { useConnectionsController } from '@/hooks/use-connections-controller';
import type {
  ConnectionsInputModel,
  ConnectionsSelectionActions,
} from '@/lib/graph/connections-contract';
import type { NotesViewStatePorts } from '@/lib/application/notes-view-state';

type Props = {
  input: ConnectionsInputModel;
  actions: Pick<ConnectionsSelectionActions, 'openCard'>;
  presentation: ConnectionsPresentationAdapter;
  Renderer: ComponentType<ConnectionsRendererProps>;
  cameraPosition: NotesViewStatePorts['connections'];
  navigationPending: boolean;
};

export function ConnectionsAdapter({
  input,
  actions,
  presentation,
  Renderer,
  cameraPosition,
  navigationPending,
}: Props) {
  const model = useConnectionsController(input, presentation);
  return (
    <Renderer
      model={model}
      totalNodeCount={input.nodes.length}
      totalEdgeCount={input.edges.length}
      actions={actions}
      presentation={presentation}
      cameraPosition={cameraPosition}
      navigationPending={navigationPending}
    />
  );
}

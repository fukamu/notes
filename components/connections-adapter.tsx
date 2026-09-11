'use client';

import type { ComponentType } from 'react';
import type { ConnectionsPresentationAdapter } from '@/components/connections-presentation';
import type { ConnectionsRendererProps } from '@/components/presentation-contract';
import { useConnectionsController } from '@/hooks/use-connections-controller';
import type {
  ConnectionsInputModel,
  ConnectionsSelectionActions,
} from '@/lib/graph/connections-contract';

type Props = {
  input: ConnectionsInputModel;
  actions: ConnectionsSelectionActions;
  presentation: ConnectionsPresentationAdapter;
  Renderer: ComponentType<ConnectionsRendererProps>;
};

export function ConnectionsAdapter({
  input,
  actions,
  presentation,
  Renderer,
}: Props) {
  const model = useConnectionsController(input, presentation);
  return (
    <Renderer model={model} actions={actions} presentation={presentation} />
  );
}

'use client';

import { useCallback, useMemo, useState, type ComponentType } from 'react';
import type { ConnectionsPresentationAdapter } from '@/components/connections-presentation';
import type { ConnectionsRendererProps } from '@/components/presentation-contract';
import { useConnectionsController } from '@/hooks/use-connections-controller';
import type {
  ConnectionsInputModel,
  ConnectionsSelectionActions,
} from '@/lib/graph/connections-contract';
import {
  defaultConnectionsStagingPolicy,
  nextConnectionsExpansionPage,
  selectConnectionsStage,
} from '@/lib/graph/connections-staging';

type Props = {
  input: ConnectionsInputModel;
  actions: Pick<ConnectionsSelectionActions, 'openCard'>;
  presentation: ConnectionsPresentationAdapter;
  Renderer: ComponentType<ConnectionsRendererProps>;
};

function ConnectionsAdapterSession({
  input,
  actions,
  presentation,
  Renderer,
}: Props) {
  const [expansionPage, setExpansionPage] = useState(0);

  const selection = useMemo(
    () => selectConnectionsStage(input, { expansionPage }),
    [expansionPage, input],
  );
  const model = useConnectionsController(selection.input, presentation);

  const expand = useCallback(() => {
    if (!selection.canExpand) return;
    setExpansionPage((current) => nextConnectionsExpansionPage(current));
  }, [selection.canExpand]);
  const rendererActions = useMemo<ConnectionsSelectionActions>(
    () => ({
      openCard: actions.openCard,
      expand,
    }),
    [actions.openCard, expand],
  );
  const staging = useMemo(
    () => ({
      focusCardId: selection.focusCardId,
      focusLabel:
        input.nodes.find((node) => node.cardId === selection.focusCardId)
          ?.accessibleName ?? null,
      totalNodeCount: selection.totalNodeCount,
      visibleNodeCount: selection.visibleNodeCount,
      nodeLimit: selection.nodeLimit,
      hiddenReachableNodeCount: selection.hiddenReachableNodeCount,
      nextExpansionCount: Math.min(
        defaultConnectionsStagingPolicy.expansionPageSize,
        selection.hiddenReachableNodeCount,
      ),
      canExpand: selection.canExpand,
      stoppedAtMaximum: selection.stoppedAtMaximum,
    }),
    [input.nodes, selection],
  );
  return (
    <Renderer
      model={model}
      staging={staging}
      actions={rendererActions}
      presentation={presentation}
    />
  );
}

export function ConnectionsAdapter(props: Props) {
  return (
    <ConnectionsAdapterSession key={props.input.currentCardId} {...props} />
  );
}

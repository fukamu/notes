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
  queryConnectionsStageNodes,
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
  const [query, setQuery] = useState('');
  const [focusCardId, setFocusCardId] = useState(input.currentCardId);
  const [expansionPage, setExpansionPage] = useState(0);

  const selection = useMemo(
    () =>
      selectConnectionsStage(input, {
        focusCardId,
        expansionPage,
      }),
    [expansionPage, focusCardId, input],
  );
  const searchResults = useMemo(
    () =>
      queryConnectionsStageNodes(
        input.nodes,
        query,
        defaultConnectionsStagingPolicy.searchResultLimit,
      ),
    [input.nodes, query],
  );
  const model = useConnectionsController(selection.input, presentation);

  const focusCard = useCallback((cardId: typeof input.currentCardId) => {
    setFocusCardId(cardId);
    setExpansionPage(0);
  }, []);
  const focusCurrentCard = useCallback(() => {
    setQuery('');
    setFocusCardId(input.currentCardId);
    setExpansionPage(0);
  }, [input.currentCardId]);
  const expand = useCallback(() => {
    if (!selection.canExpand) return;
    setExpansionPage((current) => nextConnectionsExpansionPage(current));
  }, [selection.canExpand]);
  const rendererActions = useMemo<ConnectionsSelectionActions>(
    () => ({
      openCard: actions.openCard,
      setSearchQuery: setQuery,
      focusCard,
      focusCurrentCard,
      expand,
    }),
    [actions.openCard, expand, focusCard, focusCurrentCard],
  );
  const staging = useMemo(
    () => ({
      query,
      searchResults,
      focusCardId: selection.focusCardId,
      focusLabel:
        input.nodes.find((node) => node.cardId === selection.focusCardId)
          ?.accessibleName ?? null,
      currentCardId: input.currentCardId,
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
    [input.currentCardId, input.nodes, query, searchResults, selection],
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

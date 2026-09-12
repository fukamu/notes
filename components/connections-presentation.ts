import type { ConnectionsLayoutMetrics } from '@/lib/graph/elk-layout';
import type { ConnectionsViewportPadding } from '@/lib/graph/connections-viewport';

export type ConnectionsPresentationAdapter = {
  layoutMetrics: ConnectionsLayoutMetrics;
  viewportPadding: ConnectionsViewportPadding;
  edgeMaximumRadius: number;
};

export const defaultConnectionsPresentation: ConnectionsPresentationAdapter = {
  layoutMetrics: {
    nodeWidth: 216,
    nodeHeight: 80,
    portSize: 2,
    componentSpacing: 96,
    nodeSpacing: 72,
    edgeNodeSpacing: 32,
    layerSpacing: 112,
    edgeLayerSpacing: 40,
    padding: { top: 24, right: 24, bottom: 24, left: 24 },
  },
  viewportPadding: { top: 88, right: 24, bottom: 24, left: 24 },
  edgeMaximumRadius: 16,
};

export type ConnectionsViewportGeometry = {
  width: number;
  height: number;
};

export type ConnectionsNodeGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ConnectionsViewportPadding = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type ConnectionsScrollPosition = {
  left: number;
  top: number;
};

export type ConnectionsCenterRequest = {
  viewport: ConnectionsViewportGeometry | null;
  node: ConnectionsNodeGeometry | null;
  padding: ConnectionsViewportPadding;
};

export function connectionsCenterPosition({
  viewport,
  node,
  padding,
}: ConnectionsCenterRequest): ConnectionsScrollPosition | null {
  if (!viewport || !node || viewport.width <= 0 || viewport.height <= 0)
    return null;
  const horizontalOffset = (padding.right - padding.left) / 2;
  const verticalOffset = (padding.bottom - padding.top) / 2;
  return {
    left: Math.max(
      0,
      node.x + node.width / 2 - viewport.width / 2 + horizontalOffset,
    ),
    top: Math.max(
      0,
      node.y + node.height / 2 - viewport.height / 2 + verticalOffset,
    ),
  };
}

export type ConnectionsCenteringAdapter = {
  currentChanged: (request: ConnectionsCenterRequest) => void;
  viewportResized: (request: ConnectionsCenterRequest) => void;
  destroy: () => void;
};

export function createConnectionsCenteringAdapter(options: {
  schedule: (callback: () => void) => number;
  cancel: (handle: number) => void;
  scrollTo: (position: ConnectionsScrollPosition) => void;
}): ConnectionsCenteringAdapter {
  let pending: number | null = null;
  const center = (request: ConnectionsCenterRequest) => {
    if (pending !== null) options.cancel(pending);
    const position = connectionsCenterPosition(request);
    if (!position) {
      pending = null;
      return;
    }
    pending = options.schedule(() => {
      pending = null;
      options.scrollTo(position);
    });
  };
  return {
    currentChanged: center,
    viewportResized: center,
    destroy: () => {
      if (pending !== null) options.cancel(pending);
      pending = null;
    },
  };
}

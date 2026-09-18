import { describe, expect, it } from 'vitest';
import {
  CONNECTIONS_OVERVIEW_CARD_HEIGHT_PX,
  hitTestConnectionsNode,
  prepareConnectionsVisibility,
  queryConnectionsVisibility,
  resolveConnectionsNodeRenderMode,
  sameConnectionsVisibility,
} from '@/lib/graph/connections-visibility';

const pathOptions = { maximumRadius: 16, nodeClearance: 32 };

describe('connections visibility', () => {
  it('keeps an edge whose endpoints are off-screen but whose route crosses the viewport', () => {
    const prepared = prepareConnectionsVisibility(
      [
        { x: -300, y: 40, width: 100, height: 60 },
        { x: 400, y: 40, width: 100, height: 60 },
      ],
      [
        {
          id: 'crossing',
          sections: [
            {
              id: 'crossing-section',
              startPoint: { x: -200, y: 70 },
              bendPoints: [],
              endPoint: { x: 400, y: 70 },
            },
          ],
        },
      ],
      { x: -320, y: 0, width: 840, height: 140 },
      pathOptions,
    );

    const visible = queryConnectionsVisibility(
      prepared,
      { x: 0, y: 0, scale: 1 },
      { width: 200, height: 140 },
      0,
    );

    expect(visible.nodeIndices).toEqual([]);
    expect(visible.edgeIndices).toEqual([0]);
  });

  it('uses quadratic control-point bounds and visual margins conservatively', () => {
    const prepared = prepareConnectionsVisibility(
      [],
      [
        {
          id: 'rounded',
          sections: [
            {
              id: 'rounded-section',
              startPoint: { x: -100, y: -100 },
              bendPoints: [
                { x: 100, y: -100 },
                { x: 100, y: 100 },
              ],
              endPoint: { x: 300, y: 100 },
            },
          ],
        },
      ],
      { x: -120, y: -120, width: 440, height: 240 },
      pathOptions,
    );

    expect(
      queryConnectionsVisibility(
        prepared,
        { x: -86, y: 86, scale: 1 },
        { width: 28, height: 28 },
        0,
      ).edgeIndices,
    ).toEqual([0]);
  });

  it('returns nodes and edges in original order and compares selections by value', () => {
    const prepared = prepareConnectionsVisibility(
      [
        { x: 200, y: 0, width: 40, height: 40 },
        { x: 0, y: 0, width: 40, height: 40 },
      ],
      [
        {
          id: 'late',
          sections: [
            {
              id: 'late-section',
              startPoint: { x: 200, y: 10 },
              bendPoints: [],
              endPoint: { x: 220, y: 10 },
            },
          ],
        },
        {
          id: 'early',
          sections: [
            {
              id: 'early-section',
              startPoint: { x: 0, y: 20 },
              bendPoints: [],
              endPoint: { x: 220, y: 20 },
            },
          ],
        },
      ],
      { x: 0, y: 0, width: 240, height: 40 },
      pathOptions,
    );
    const visible = queryConnectionsVisibility(
      prepared,
      { x: 0, y: 0, scale: 1 },
      { width: 240, height: 40 },
      0,
    );
    expect(visible.nodeIndices).toEqual([0, 1]);
    expect(visible.edgeIndices).toEqual([0, 1]);
    expect(sameConnectionsVisibility(visible, { ...visible })).toBe(true);
    expect(
      sameConnectionsVisibility(visible, {
        nodeIndices: [1],
        edgeIndices: visible.edgeIndices,
      }),
    ).toBe(false);
  });

  it('includes halo and marker protrusions at the query boundary', () => {
    const prepared = prepareConnectionsVisibility(
      [],
      [
        {
          id: 'marker',
          sections: [
            {
              id: 'marker-section',
              startPoint: { x: 10, y: 10 },
              bendPoints: [],
              endPoint: { x: 20, y: 10 },
            },
          ],
        },
      ],
      { x: 0, y: 0, width: 40, height: 20 },
      pathOptions,
    );
    expect(
      queryConnectionsVisibility(
        prepared,
        { x: -33, y: 0, scale: 1 },
        { width: 1, height: 20 },
        0,
      ).edgeIndices,
    ).toEqual([0]);
  });

  it('switches below the 24px projected card height for different card sizes', () => {
    expect(CONNECTIONS_OVERVIEW_CARD_HEIGHT_PX).toBe(24);
    expect(resolveConnectionsNodeRenderMode(72, 0.35)).toBe('html');
    expect(resolveConnectionsNodeRenderMode(72, 0.32)).toBe('overview-canvas');
    expect(resolveConnectionsNodeRenderMode(72, 24 / 72)).toBe('html');
    expect(resolveConnectionsNodeRenderMode(72, 23.999 / 72)).toBe(
      'overview-canvas',
    );
    expect(resolveConnectionsNodeRenderMode(48, 0.5)).toBe('html');
    expect(resolveConnectionsNodeRenderMode(48, 0.499)).toBe('overview-canvas');
    expect(resolveConnectionsNodeRenderMode(40, 0.6)).toBe('html');
    expect(resolveConnectionsNodeRenderMode(40, 0.599)).toBe('overview-canvas');
  });

  it('keeps HTML rendering for invalid projected-height inputs', () => {
    for (const [nodeHeight, cameraScale] of [
      [0, 1],
      [-1, 1],
      [Number.NaN, 1],
      [Number.POSITIVE_INFINITY, 1],
      [72, 0],
      [72, -1],
      [72, Number.NaN],
      [72, Number.POSITIVE_INFINITY],
    ] as const) {
      expect(resolveConnectionsNodeRenderMode(nodeHeight, cameraScale)).toBe(
        'html',
      );
    }
  });

  it('hit-tests exact card bounds through the node BVH in viewport coordinates', () => {
    const prepared = prepareConnectionsVisibility(
      [
        { x: 20, y: 30, width: 100, height: 60 },
        { x: 200, y: 30, width: 100, height: 60 },
      ],
      [],
      { x: 0, y: 0, width: 320, height: 120 },
      pathOptions,
    );
    const camera = { x: -20, y: 10, scale: 0.5 };

    expect(hitTestConnectionsNode(prepared, camera, { x: 20, y: 40 })).toBe(0);
    expect(
      hitTestConnectionsNode(prepared, camera, { x: 60, y: 40 }),
    ).toBeNull();
    expect(hitTestConnectionsNode(prepared, camera, { x: 105, y: 40 })).toBe(1);
    expect(
      hitTestConnectionsNode(prepared, camera, {
        x: Number.NaN,
        y: 40,
      }),
    ).toBeNull();
  });
});

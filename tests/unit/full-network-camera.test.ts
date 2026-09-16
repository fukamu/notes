import { describe, expect, it } from 'vitest';
import type { CardId } from '@/lib/domain/id';
import type { ConnectionsInputModel } from '@/lib/graph/connections-contract';
import {
  activateFullNetworkNode,
  captureFullNetworkMapSnapshot,
  centerFullNetworkCameraOnCard,
  currentFullNetworkSemanticLevel,
  fitFullNetworkCamera,
  fullNetworkWorldPoint,
  hitTestFullNetworkNode,
  panFullNetworkCamera,
  pinchFullNetworkCamera,
  resizeFullNetworkCamera,
  restoreFullNetworkMapSnapshot,
  zoomFullNetworkCamera,
} from '@/lib/graph/full-network-camera';
import {
  createFullNetworkTopology,
  defaultFullNetworkLayoutConfiguration,
  layoutFullNetworkTopology,
} from '@/lib/graph/full-network-layout';
import { createFullNetworkRenderDataset } from '@/lib/graph/full-network-render-plan';
import { createFullNetworkRouting } from '@/lib/graph/full-network-routing';
import { fixtureCardId } from '@/tests/fixtures/ids';

const ids = Array.from({ length: 8 }, (_, index) =>
  fixtureCardId(`full-network-camera-${index}`),
);

function id(index: number): CardId {
  const value = ids[index];
  if (!value) throw new Error(`Missing fixture node ${index}`);
  return value;
}

function dataset(
  indexes: readonly number[] = ids.map((_, index) => index),
  edges: readonly (readonly [number, number])[] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [4, 5],
  ],
) {
  const nodeIds = indexes.map(id);
  const included = new Set(indexes);
  const currentCardId = nodeIds[0];
  if (!currentCardId) throw new Error('Fixture requires one node');
  const input: ConnectionsInputModel = {
    currentCardId,
    nodes: nodeIds.map((cardId, index) => ({
      cardId,
      displayLabel: `#${index + 1}`,
      title: `Card ${index + 1}`,
      accessibleName: `Card ${index + 1}`,
      current: index === 0,
    })),
    edges: edges
      .filter(
        ([source, target]) => included.has(source) && included.has(target),
      )
      .map(([source, target]) => ({
        sourceCardId: id(source),
        targetCardId: id(target),
        accessibleName: `${source} to ${target}`,
      })),
  };
  const topology = createFullNetworkTopology(input);
  const layout = layoutFullNetworkTopology(topology);
  return createFullNetworkRenderDataset(
    createFullNetworkRouting(
      topology,
      layout,
      defaultFullNetworkLayoutConfiguration,
    ),
  );
}

function screenPointForCard(
  value: ReturnType<typeof dataset>,
  cardId: CardId,
  camera: ReturnType<typeof fitFullNetworkCamera>,
) {
  const index = value.nodeIndexesByCardId.get(cardId);
  if (index === undefined) throw new Error('Fixture node is missing');
  const x = value.routing.layout.x[index];
  const y = value.routing.layout.y[index];
  if (x === undefined || y === undefined) throw new Error('Missing position');
  return {
    x: camera.offsetX + x * camera.scale,
    y: camera.offsetY + y * camera.scale,
  };
}

describe('full-network camera pure policy', () => {
  it('starts fit-all and does not implicitly center the current card', () => {
    const value = dataset();
    const restored = restoreFullNetworkMapSnapshot({
      dataset: value,
      snapshot: null,
      viewportWidth: 900,
      viewportHeight: 600,
    });
    expect(restored.reason).toBe('fit');
    expect(restored.camera).toEqual(fitFullNetworkCamera(value, 900, 600));
    expect(restored.selectedCardId).toBeNull();
  });

  it('pans, zooms and pinches around stable world anchors within map bounds', () => {
    const value = dataset();
    const fit = fitFullNetworkCamera(value, 900, 600);
    const anchor = { x: 450, y: 300 };
    const zoomed = zoomFullNetworkCamera(value, fit, 4, anchor);
    expect(zoomed.scale).toBeGreaterThan(fit.scale);
    expect(zoomed.scale).toBeLessThanOrEqual(8);
    const panned = panFullNetworkCamera(value, zoomed, { x: -80, y: -40 });
    expect(panned.offsetX).toBeLessThanOrEqual(zoomed.offsetX);
    const pinched = pinchFullNetworkCamera(
      value,
      fit,
      [
        { x: 300, y: 300 },
        { x: 500, y: 300 },
      ],
      [
        { x: 250, y: 310 },
        { x: 550, y: 310 },
      ],
    );
    expect(pinched.scale).toBeGreaterThan(fit.scale);
    expect(pinched.scale).toBeLessThanOrEqual(8);
  });

  it('keeps the world center when the viewport resizes', () => {
    const value = dataset();
    const fit = fitFullNetworkCamera(value, 900, 600);
    const zoomed = zoomFullNetworkCamera(value, fit, 3, {
      x: 450,
      y: 300,
    });
    const before = fullNetworkWorldPoint(zoomed, { x: 450, y: 300 });
    const resized = resizeFullNetworkCamera(value, zoomed, 600, 420);
    const after = fullNetworkWorldPoint(resized, { x: 300, y: 210 });
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('hit-tests nodes and advances overview/network taps before detail opens', () => {
    const value = dataset();
    const fit = fitFullNetworkCamera(value, 900, 600);
    const target = id(3);
    const screenPoint = screenPointForCard(value, target, fit);
    expect(hitTestFullNetworkNode(value, fit, screenPoint)).toBe(target);

    const overview = activateFullNetworkNode({
      dataset: value,
      camera: fit,
      cardId: target,
      level: 'overview',
    });
    expect(overview.command.kind).toBe('none');
    expect(overview.selectedCardId).toBe(target);
    expect(overview.camera.scale).toBeGreaterThan(fit.scale);

    const network = activateFullNetworkNode({
      dataset: value,
      camera: overview.camera,
      cardId: target,
      level: 'network',
    });
    expect(currentFullNetworkSemanticLevel(value, network.camera)).toBe(
      'detail',
    );
    expect(network.command.kind).toBe('none');

    const detail = activateFullNetworkNode({
      dataset: value,
      camera: network.camera,
      cardId: target,
      level: 'detail',
    });
    expect(detail.command).toEqual({ kind: 'open-card', cardId: target });
  });

  it('centers only through the explicit current-card operation', () => {
    const value = dataset();
    const fit = fitFullNetworkCamera(value, 900, 600);
    const zoomed = centerFullNetworkCameraOnCard(
      value,
      { ...fit, scale: 8 },
      id(0),
    );
    if (!zoomed) throw new Error('Expected zoomed camera');
    const firstX = value.routing.layout.x[0] ?? 0;
    const firstY = value.routing.layout.y[0] ?? 0;
    let targetIndex = 0;
    let targetDistance = -1;
    for (let index = 0; index < value.overview.nodeCount; index += 1) {
      const x = value.routing.layout.x[index] ?? 0;
      const y = value.routing.layout.y[index] ?? 0;
      const distance = Math.hypot(x - firstX, y - firstY);
      if (distance > targetDistance) {
        targetIndex = index;
        targetDistance = distance;
      }
    }
    const target = value.routing.topology.nodeIds[targetIndex];
    if (!target) throw new Error('Expected target card');
    const before = screenPointForCard(value, target, zoomed);
    const centered = centerFullNetworkCameraOnCard(value, zoomed, target);
    expect(centered).not.toBeNull();
    const point = screenPointForCard(value, target, centered ?? zoomed);
    expect(Math.hypot(point.x - 450, point.y - 300)).toBeLessThan(
      Math.hypot(before.x - 450, before.y - 300),
    );
    expect(centered?.scale).toBeGreaterThanOrEqual(zoomed.scale);
  });

  it('restores exact same-layout camera and selection across card routes', () => {
    const value = dataset();
    const fit = fitFullNetworkCamera(value, 900, 600);
    const camera = centerFullNetworkCameraOnCard(
      value,
      { ...fit, scale: 4 },
      id(5),
    );
    if (!camera) throw new Error('Expected camera');
    const snapshot = captureFullNetworkMapSnapshot(value, camera, id(5));
    const restored = restoreFullNetworkMapSnapshot({
      dataset: value,
      snapshot,
      viewportWidth: 720,
      viewportHeight: 480,
    });
    expect(restored.reason).toBe('exact');
    expect(restored.selectedCardId).toBe(id(5));
    expect(restored.camera.scale).toBe(camera.scale);
  });

  it('uses a surviving card anchor after topology changes and fits if none survive', () => {
    const original = dataset();
    const fit = fitFullNetworkCamera(original, 900, 600);
    const camera = centerFullNetworkCameraOnCard(
      original,
      { ...fit, scale: 4 },
      id(5),
    );
    if (!camera) throw new Error('Expected camera');
    const snapshot = captureFullNetworkMapSnapshot(original, camera, id(5));
    const changed = dataset(
      [1, 2, 3, 4, 5, 6, 7],
      [
        [1, 2],
        [2, 3],
        [4, 5],
        [5, 6],
      ],
    );
    const anchored = restoreFullNetworkMapSnapshot({
      dataset: changed,
      snapshot,
      viewportWidth: 900,
      viewportHeight: 600,
    });
    expect(anchored.reason).toBe('anchor');
    expect(anchored.selectedCardId).toBe(id(5));
    expect(anchored.camera.scale).toBe(camera.scale);
    const anchoredPoint = screenPointForCard(changed, id(5), anchored.camera);
    expect(anchoredPoint.x).toBeGreaterThanOrEqual(0);
    expect(anchoredPoint.x).toBeLessThanOrEqual(900);
    expect(anchoredPoint.y).toBeGreaterThanOrEqual(0);
    expect(anchoredPoint.y).toBeLessThanOrEqual(600);

    const unrelated = dataset([0], []);
    const fallback = restoreFullNetworkMapSnapshot({
      dataset: unrelated,
      snapshot,
      viewportWidth: 900,
      viewportHeight: 600,
    });
    expect(fallback.reason).toBe('fit');
    expect(fallback.selectedCardId).toBeNull();
    expect(fallback.camera).toEqual(fitFullNetworkCamera(unrelated, 900, 600));
  });
});

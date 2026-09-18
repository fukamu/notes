import { describe, expect, it, vi } from 'vitest';
import {
  centerConnectionsCameraOnRect,
  captureConnectionsCameraSnapshot,
  clampConnectionsCamera,
  connectionsCameraContainsRect,
  connectionsCameraTransform,
  connectionsCameraWorldPoint,
  connectionsCameraZoomState,
  createConnectionsCameraFrameAdapter,
  decodeConnectionsCameraScale,
  decodeConnectionsCameraScaleValue,
  DEFAULT_CONNECTIONS_CAMERA_LIMITS,
  ensureConnectionsRectVisible,
  fitConnectionsCamera,
  initialConnectionsCamera,
  panConnectionsCamera,
  pinchConnectionsCamera,
  preserveConnectionsRectAnchor,
  resolveConnectionsCameraLimits,
  resizeConnectionsCamera,
  restoreConnectionsCameraSnapshot,
  restoreConnectionsCameraScale,
  zoomConnectionsCamera,
  type ConnectionsCamera,
  type ConnectionsCameraGeometry,
} from '@/lib/graph/connections-viewport';
import { fixtureCardId } from '@/tests/fixtures/ids';

const geometry: ConnectionsCameraGeometry = {
  viewport: { width: 800, height: 600 },
  world: { x: 0, y: 0, width: 1_000, height: 800 },
  padding: { top: 40, right: 40, bottom: 40, left: 40 },
  limits: { minimumScale: 0.25, maximumScale: 3, maximumFitScale: 1 },
};

function expectCameraClose(
  actual: ConnectionsCamera | null,
  expected: ConnectionsCamera,
) {
  expect(actual).not.toBeNull();
  expect(actual?.x).toBeCloseTo(expected.x);
  expect(actual?.y).toBeCloseTo(expected.y);
  expect(actual?.scale).toBeCloseTo(expected.scale);
}

describe('connections map camera geometry', () => {
  it('uses the shared fallback 10–200% camera range before geometry exists', () => {
    expect(DEFAULT_CONNECTIONS_CAMERA_LIMITS).toEqual({
      minimumScale: 0.1,
      maximumScale: 2,
      maximumFitScale: 1,
    });
  });

  it('derives stable native control state and displayed percent at both limits', () => {
    expect(
      connectionsCameraZoomState(
        { x: 0, y: 0, scale: 0.1 + 5e-8 },
        DEFAULT_CONNECTIONS_CAMERA_LIMITS,
      ),
    ).toEqual({
      percentLabel: '10',
      zoomInDisabled: false,
      zoomOutDisabled: true,
    });
    expect(
      connectionsCameraZoomState(
        { x: 0, y: 0, scale: 2 - 5e-8 },
        DEFAULT_CONNECTIONS_CAMERA_LIMITS,
      ),
    ).toEqual({
      percentLabel: '200',
      zoomInDisabled: true,
      zoomOutDisabled: false,
    });
    expect(
      connectionsCameraZoomState(
        { x: 0, y: 0, scale: 1.234 },
        DEFAULT_CONNECTIONS_CAMERA_LIMITS,
      ),
    ).toEqual({
      percentLabel: '123',
      zoomInDisabled: false,
      zoomOutDisabled: false,
    });
    expect(
      connectionsCameraZoomState(
        { x: 0, y: 0, scale: Number.NaN },
        DEFAULT_CONNECTIONS_CAMERA_LIMITS,
      ),
    ).toBeNull();
  });

  it('shows small positive scales without rounding them to zero percent', () => {
    expect(
      connectionsCameraZoomState(
        { x: 0, y: 0, scale: 0.0055 },
        { minimumScale: 0.001, maximumScale: 2, maximumFitScale: 1 },
      ),
    ).toMatchObject({ percentLabel: '0.55' });
    expect(
      connectionsCameraZoomState(
        { x: 0, y: 0, scale: 0.00001 },
        { minimumScale: 0.000001, maximumScale: 2, maximumFitScale: 1 },
      ),
    ).toMatchObject({ percentLabel: '<0.01' });
  });

  it('decodes finite preferred scales and clamps stored values to camera limits', () => {
    expect(decodeConnectionsCameraScale('1.25', geometry.limits)).toBe(1.25);
    expect(decodeConnectionsCameraScale(0.01, geometry.limits)).toBe(0.25);
    expect(decodeConnectionsCameraScale('99', geometry.limits)).toBe(3);
    for (const value of [
      null,
      '',
      'scale',
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(decodeConnectionsCameraScale(value, geometry.limits)).toBeNull();
    }
  });

  it('decodes positive stored scales before applying geometry limits', () => {
    expect(decodeConnectionsCameraScaleValue('0.0055')).toBe(0.0055);
    expect(decodeConnectionsCameraScaleValue(4)).toBe(4);
    for (const value of [
      0,
      -1,
      '',
      'scale',
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(decodeConnectionsCameraScaleValue(value)).toBeNull();
    }
  });

  it('derives a minimum scale below fit so every large world can be framed', () => {
    const limits = resolveConnectionsCameraLimits(
      { width: 1_280, height: 720 },
      { x: 0, y: 0, width: 80_000, height: 120_000 },
      { top: 24, right: 24, bottom: 24, left: 24 },
    );
    expect(limits).not.toBeNull();
    if (!limits) return;
    const largeGeometry = {
      viewport: { width: 1_280, height: 720 },
      world: { x: 0, y: 0, width: 80_000, height: 120_000 },
      padding: { top: 24, right: 24, bottom: 24, left: 24 },
      limits,
    };
    const fitted = fitConnectionsCamera(largeGeometry);
    expect(fitted?.scale).toBeCloseTo(0.0056);
    expect(limits.minimumScale).toBeCloseTo(0.0028);
    expect(
      fitted &&
        connectionsCameraContainsRect(
          fitted,
          largeGeometry.world,
          largeGeometry,
        ),
    ).toBe(true);
  });

  it('fits the whole world into explicit viewport padding', () => {
    const camera = fitConnectionsCamera(geometry);

    expectCameraClose(camera, { x: 75, y: 40, scale: 0.65 });
    expect(
      camera && connectionsCameraContainsRect(camera, geometry.world, geometry),
    ).toBe(true);
  });

  it('pans in screen coordinates, preserves translation, and clamps only scale', () => {
    expectCameraClose(
      panConnectionsCamera(
        { x: 0, y: 0, scale: 1 },
        { x: 100, y: -300 },
        geometry,
      ),
      { x: 100, y: -300, scale: 1 },
    );
    expectCameraClose(
      clampConnectionsCamera({ x: 999, y: -999, scale: 4 }, geometry),
      { x: 999, y: -999, scale: 3 },
    );
  });

  it('captures and restores the same world center across viewport sizes', () => {
    const cardId = fixtureCardId('camera-snapshot-current');
    const camera = { x: -725, y: 340, scale: 1.25 };
    const snapshot = captureConnectionsCameraSnapshot(
      cardId,
      'layout-a',
      camera,
      geometry,
    );
    expect(snapshot).toEqual({
      currentCardId: cardId,
      layoutKey: 'layout-a',
      scale: 1.25,
      centerWorld: { x: 900, y: -32 },
    });
    if (!snapshot) return;
    const resizedGeometry = {
      ...geometry,
      viewport: { width: 1_000, height: 740 },
    };
    expectCameraClose(
      restoreConnectionsCameraSnapshot(
        snapshot,
        cardId,
        'layout-a',
        resizedGeometry,
      ),
      { x: -625, y: 410, scale: 1.25 },
    );
    expect(
      restoreConnectionsCameraSnapshot(
        snapshot,
        fixtureCardId('camera-snapshot-other'),
        'layout-a',
        resizedGeometry,
      ),
    ).toBeNull();
    expect(
      restoreConnectionsCameraSnapshot(
        snapshot,
        cardId,
        'layout-b',
        resizedGeometry,
      ),
    ).toBeNull();
  });

  it('crosses every former world boundary without snapping for large and small worlds', () => {
    const fitted = fitConnectionsCamera(geometry);
    expect(fitted).not.toBeNull();
    if (!fitted) return;
    const beyondBottomRight = panConnectionsCamera(
      fitted,
      { x: 2_000, y: 2_000 },
      geometry,
    );
    expectCameraClose(beyondBottomRight, {
      x: fitted.x + 2_000,
      y: fitted.y + 2_000,
      scale: fitted.scale,
    });
    expectCameraClose(
      beyondBottomRight &&
        panConnectionsCamera(
          beyondBottomRight,
          { x: -4_000, y: -4_000 },
          geometry,
        ),
      {
        x: fitted.x - 2_000,
        y: fitted.y - 2_000,
        scale: fitted.scale,
      },
    );

    const smallGeometry = {
      ...geometry,
      world: { x: 0, y: 0, width: 100, height: 80 },
    };
    const smallFitted = fitConnectionsCamera(smallGeometry);
    expectCameraClose(smallFitted, { x: 350, y: 260, scale: 1 });
    expectCameraClose(
      smallFitted &&
        panConnectionsCamera(
          smallFitted,
          { x: 1_200, y: -1_100 },
          smallGeometry,
        ),
      { x: 1_550, y: -840, scale: 1 },
    );
  });

  it('keeps an off-world camera anchored through zoom, pinch, and resize', () => {
    const camera = { x: 5_000, y: -4_000, scale: 1 };
    const zoomAnchor = { x: 200, y: 150 };
    const worldBeforeZoom = connectionsCameraWorldPoint(camera, zoomAnchor);
    const zoomed = zoomConnectionsCamera(camera, 2, zoomAnchor, geometry);
    expectCameraClose(zoomed, { x: 9_800, y: -8_150, scale: 2 });
    expect(zoomed && connectionsCameraWorldPoint(zoomed, zoomAnchor)).toEqual(
      worldBeforeZoom,
    );

    const pinchStart = [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
    ] as const;
    const pinchCurrent = [
      { x: 50, y: 150 },
      { x: 350, y: 150 },
    ] as const;
    const pinched = pinchConnectionsCamera(
      camera,
      pinchStart,
      pinchCurrent,
      geometry,
    );
    expectCameraClose(pinched, { x: 7_400, y: -6_000, scale: 1.5 });
    expect(
      pinched && connectionsCameraWorldPoint(pinched, { x: 200, y: 150 }),
    ).toEqual(connectionsCameraWorldPoint(camera, { x: 200, y: 100 }));

    expectCameraClose(
      resizeConnectionsCamera(camera, geometry, {
        ...geometry,
        viewport: { width: 1_000, height: 700 },
      }),
      { x: 5_100, y: -3_950, scale: 1 },
    );
  });

  it('returns from empty space through explicit fit and current-card commands', () => {
    const fitted = fitConnectionsCamera(geometry);
    expect(
      fitted && connectionsCameraContainsRect(fitted, geometry.world, geometry),
    ).toBe(true);

    const current = { x: 450, y: 350, width: 100, height: 100 };
    const centered = centerConnectionsCameraOnRect(
      { x: 20_000, y: -20_000, scale: 1 },
      current,
      geometry,
    );
    expect(
      centered &&
        connectionsCameraContainsRect(centered, current, geometry, 12),
    ).toBe(true);
  });

  it('zooms without moving the anchor world coordinate', () => {
    const fitted = fitConnectionsCamera(geometry);
    expect(fitted).not.toBeNull();
    if (!fitted) return;
    const anchor = { x: 400, y: 300 };
    const before = connectionsCameraWorldPoint(fitted, anchor);
    const zoomed = zoomConnectionsCamera(fitted, 2, anchor, geometry);
    const after = zoomed && connectionsCameraWorldPoint(zoomed, anchor);

    expect(before).not.toBeNull();
    expect(after?.x).toBeCloseTo(before?.x ?? Number.NaN);
    expect(after?.y).toBeCloseTo(before?.y ?? Number.NaN);
    expectCameraClose(zoomed, { x: -250, y: -220, scale: 1.3 });
  });

  it('uses the pinch midpoint as a stable moving world anchor', () => {
    const camera = { x: -100, y: -100, scale: 1 };
    const start = [
      { x: 300, y: 300 },
      { x: 500, y: 300 },
    ] as const;
    const current = [
      { x: 260, y: 320 },
      { x: 560, y: 320 },
    ] as const;
    const pinched = pinchConnectionsCamera(camera, start, current, geometry);

    expectCameraClose(pinched, { x: -340, y: -280, scale: 1.5 });
    expect(
      pinched && connectionsCameraWorldPoint(pinched, { x: 410, y: 320 }),
    ).toEqual({ x: 500, y: 400 });
  });

  it('centers or minimally reveals a node including focus-ring margin', () => {
    const centered = centerConnectionsCameraOnRect(
      { x: 0, y: 0, scale: 1 },
      { x: 450, y: 350, width: 100, height: 100 },
      geometry,
    );
    expectCameraClose(centered, { x: -100, y: -100, scale: 1 });

    const target = { x: 900, y: 700, width: 100, height: 100 };
    const revealed = ensureConnectionsRectVisible(
      { x: 40, y: 40, scale: 1 },
      target,
      geometry,
      12,
    );
    expectCameraClose(revealed, { x: -252, y: -252, scale: 1 });
    expect(
      revealed && connectionsCameraContainsRect(revealed, target, geometry),
    ).toBe(true);

    const oversizedTarget = { x: 300, y: 300, width: 400, height: 200 };
    const zoomedOut = ensureConnectionsRectVisible(
      { x: -500, y: -500, scale: 3 },
      oversizedTarget,
      geometry,
      12,
    );
    expect(zoomedOut?.scale).toBeCloseTo(1.74);
    expect(
      zoomedOut &&
        connectionsCameraContainsRect(zoomedOut, oversizedTarget, geometry, 12),
    ).toBe(true);
  });

  it('preserves the world point at the usable center through resize', () => {
    const nextGeometry = {
      ...geometry,
      viewport: { width: 1_000, height: 700 },
    };
    expectCameraClose(
      resizeConnectionsCamera(
        { x: -100, y: -100, scale: 1 },
        geometry,
        nextGeometry,
      ),
      { x: 0, y: -50, scale: 1 },
    );
  });

  it('preserves a surviving card screen anchor when layout geometry changes', () => {
    const anchored = preserveConnectionsRectAnchor(
      { x: -100, y: -50, scale: 1.5 },
      { x: 300, y: 200, width: 100, height: 60 },
      { x: 600, y: 500, width: 100, height: 60 },
      geometry,
    );
    expectCameraClose(anchored, { x: -550, y: -500, scale: 1.5 });
  });

  it('keeps the current card visible when minimum zoom cannot fit the world', () => {
    const wideGeometry = {
      ...geometry,
      world: { x: 0, y: 0, width: 10_000, height: 1_000 },
      limits: { ...geometry.limits, minimumScale: 0.12 },
    };
    const current = { x: 9_000, y: 400, width: 100, height: 100 };
    const camera = initialConnectionsCamera(wideGeometry, current);

    expect(camera?.scale).toBe(0.12);
    expect(
      camera &&
        connectionsCameraContainsRect(camera, current, wideGeometry, 12),
    ).toBe(true);
  });

  it('restores only preferred scale against current geometry and recenters the current card', () => {
    const fitted = fitConnectionsCamera(geometry);
    expect(fitted).not.toBeNull();
    if (!fitted) return;
    const current = { x: 850, y: 650, width: 100, height: 100 };
    const restored = restoreConnectionsCameraScale(
      fitted,
      1.5,
      geometry,
      current,
    );

    expect(restored?.scale).toBe(1.5);
    expect(restored?.x).not.toBe(fitted.x);
    expect(restored?.y).not.toBe(fitted.y);
    expect(
      restored && connectionsCameraContainsRect(restored, current, geometry),
    ).toBe(true);
    expect(initialConnectionsCamera(geometry, current, '1.5')).toEqual(
      restored,
    );
  });

  it('clamps fit, zoom, pinch, resize and programmatic cameras to 10–200%', () => {
    const boundedGeometry: ConnectionsCameraGeometry = {
      ...geometry,
      world: { x: 0, y: 0, width: 20_000, height: 20_000 },
      limits: DEFAULT_CONNECTIONS_CAMERA_LIMITS,
    };
    expect(fitConnectionsCamera(boundedGeometry)?.scale).toBe(0.1);
    expect(
      clampConnectionsCamera({ x: 0, y: 0, scale: 20 }, boundedGeometry)?.scale,
    ).toBe(2);
    expect(
      zoomConnectionsCamera(
        { x: -1_000, y: -1_000, scale: 1 },
        100,
        { x: 400, y: 300 },
        boundedGeometry,
      )?.scale,
    ).toBe(2);
    expect(
      pinchConnectionsCamera(
        { x: -1_000, y: -1_000, scale: 1 },
        [
          { x: 399, y: 300 },
          { x: 401, y: 300 },
        ],
        [
          { x: -600, y: 300 },
          { x: 1_400, y: 300 },
        ],
        boundedGeometry,
      )?.scale,
    ).toBe(2);
    expect(
      resizeConnectionsCamera(
        { x: -500, y: -500, scale: 0.01 },
        boundedGeometry,
        boundedGeometry,
      )?.scale,
    ).toBe(0.1);
  });

  it('rejects invalid geometry and never serializes non-finite transforms', () => {
    expect(
      fitConnectionsCamera({
        ...geometry,
        world: { ...geometry.world, width: 0 },
      }),
    ).toBeNull();
    expect(
      fitConnectionsCamera({
        ...geometry,
        padding: { ...geometry.padding, left: 900 },
      }),
    ).toBeNull();
    expect(
      zoomConnectionsCamera(
        { x: 0, y: 0, scale: 1 },
        Number.NaN,
        { x: 1, y: 1 },
        geometry,
      ),
    ).toBeNull();
    expect(
      clampConnectionsCamera(
        { x: Number.POSITIVE_INFINITY, y: 0, scale: 1 },
        geometry,
      ),
    ).toBeNull();
    expect(
      connectionsCameraTransform({ x: Number.NaN, y: 0, scale: 1 }),
    ).toBeNull();
    expect(connectionsCameraTransform({ x: 1, y: 2, scale: 0.5 })).toBe(
      'translate3d(1px, 2px, 0) scale(0.5)',
    );
  });
});

describe('connections camera frame adapter', () => {
  it('applies at most once per frame, keeps the latest camera, and disposes', () => {
    const callbacks = new Map<number, () => void>();
    let nextHandle = 0;
    const cancel = vi.fn((handle: number) => callbacks.delete(handle));
    const apply = vi.fn();
    const adapter = createConnectionsCameraFrameAdapter({
      schedule: (callback) => {
        nextHandle += 1;
        callbacks.set(nextHandle, callback);
        return nextHandle;
      },
      cancel,
      apply,
    });

    adapter.queue({ x: 1, y: 2, scale: 1 });
    adapter.queue({ x: 3, y: 4, scale: 2 });
    expect(callbacks).toHaveLength(1);
    callbacks.get(1)?.();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith({ x: 3, y: 4, scale: 2 });

    adapter.queue({ x: 5, y: 6, scale: 2 });
    adapter.destroy();
    expect(cancel).toHaveBeenCalledWith(2);
    callbacks.get(2)?.();
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

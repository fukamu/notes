import type { ConnectionsCamera } from '@/lib/graph/connections-viewport';

export type ConnectionsRasterViewport = Readonly<{
  width: number;
  height: number;
}>;

export type ConnectionsRasterCapture = Readonly<{
  camera: ConnectionsCamera;
  viewport: ConnectionsRasterViewport;
  overscanPx: number;
}>;

export type ConnectionsRasterPlacement = Readonly<{
  covered: boolean;
  scaled: boolean;
  scaleRatio: number;
  x: number;
  y: number;
  width: number;
  height: number;
}>;

const coverageEpsilon = 0.01;
const scaleEpsilon = 1e-9;

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validCamera(camera: ConnectionsCamera): boolean {
  return (
    Number.isFinite(camera.x) &&
    Number.isFinite(camera.y) &&
    finitePositive(camera.scale)
  );
}

export function resolveConnectionsRasterPlacement(
  capture: ConnectionsRasterCapture,
  current: ConnectionsCamera,
): ConnectionsRasterPlacement | null {
  if (
    !validCamera(capture.camera) ||
    !validCamera(current) ||
    !finitePositive(capture.viewport.width) ||
    !finitePositive(capture.viewport.height) ||
    !Number.isFinite(capture.overscanPx) ||
    capture.overscanPx < 0
  ) {
    return null;
  }
  const scaleRatio = current.scale / capture.camera.scale;
  if (!finitePositive(scaleRatio)) return null;
  const surfaceWidth = capture.viewport.width + capture.overscanPx * 2;
  const surfaceHeight = capture.viewport.height + capture.overscanPx * 2;
  const x = current.x - scaleRatio * (capture.camera.x + capture.overscanPx);
  const y = current.y - scaleRatio * (capture.camera.y + capture.overscanPx);
  const width = surfaceWidth * scaleRatio;
  const height = surfaceHeight * scaleRatio;
  return {
    covered:
      x <= coverageEpsilon &&
      y <= coverageEpsilon &&
      x + width >= capture.viewport.width - coverageEpsilon &&
      y + height >= capture.viewport.height - coverageEpsilon,
    scaled: Math.abs(scaleRatio - 1) > scaleEpsilon,
    scaleRatio,
    x,
    y,
    width,
    height,
  };
}

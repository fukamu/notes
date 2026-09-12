import {
  decodeConnectionsCameraScale,
  DEFAULT_CONNECTIONS_CAMERA_LIMITS,
} from '@/lib/graph/connections-viewport';

export const CONNECTIONS_ZOOM_PREFERENCE_KEY =
  'fukamu.connections.zoom-scale.v1';

export type ConnectionsZoomPreferenceStorage = Readonly<{
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}>;

export function readConnectionsZoomPreference(
  storage: ConnectionsZoomPreferenceStorage | null,
): number | null {
  if (!storage) return null;
  try {
    return decodeConnectionsCameraScale(
      storage.getItem(CONNECTIONS_ZOOM_PREFERENCE_KEY),
      DEFAULT_CONNECTIONS_CAMERA_LIMITS,
    );
  } catch {
    return null;
  }
}

export function writeConnectionsZoomPreference(
  storage: ConnectionsZoomPreferenceStorage | null,
  scale: unknown,
): boolean {
  if (!storage) return false;
  const decoded = decodeConnectionsCameraScale(
    scale,
    DEFAULT_CONNECTIONS_CAMERA_LIMITS,
  );
  if (decoded === null) return false;
  try {
    storage.setItem(CONNECTIONS_ZOOM_PREFERENCE_KEY, String(decoded));
    return true;
  } catch {
    return false;
  }
}

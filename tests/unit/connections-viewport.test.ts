import { describe, expect, it, vi } from 'vitest';
import {
  connectionsCenterPosition,
  createConnectionsCenteringAdapter,
  type ConnectionsCenterRequest,
} from '@/lib/graph/connections-viewport';

const request: ConnectionsCenterRequest = {
  viewport: { width: 320, height: 240 },
  node: { x: 400, y: 300, width: 196, height: 72 },
  padding: { top: 8, right: 24, bottom: 16, left: 12 },
};

describe('connections viewport interaction', () => {
  it('centers a node with explicit viewport geometry and padding', () => {
    expect(connectionsCenterPosition(request)).toEqual({
      left: 344,
      top: 220,
    });
    expect(
      connectionsCenterPosition({ ...request, viewport: null }),
    ).toBeNull();
    expect(connectionsCenterPosition({ ...request, node: null })).toBeNull();
    expect(
      connectionsCenterPosition({
        ...request,
        viewport: { width: 0, height: 240 },
      }),
    ).toBeNull();
  });

  it('handles current changes, resize, missing targets and disposal deterministically', () => {
    const callbacks = new Map<number, () => void>();
    let nextHandle = 0;
    const cancel = vi.fn((handle: number) => callbacks.delete(handle));
    const scrollTo = vi.fn();
    const adapter = createConnectionsCenteringAdapter({
      schedule: (callback) => {
        nextHandle += 1;
        callbacks.set(nextHandle, callback);
        return nextHandle;
      },
      cancel,
      scrollTo,
    });

    adapter.currentChanged(request);
    adapter.viewportResized({
      ...request,
      viewport: { width: 640, height: 480 },
    });
    expect(cancel).toHaveBeenCalledWith(1);
    callbacks.get(2)?.();
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 184, top: 100 });

    adapter.currentChanged({ ...request, node: null });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    adapter.viewportResized(request);
    adapter.destroy();
    expect(cancel).toHaveBeenCalledWith(3);
    callbacks.get(3)?.();
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});

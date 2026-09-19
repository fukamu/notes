// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installNotesNavigationPopstateBridge,
  subscribeNotesNavigationPopstate,
} from '@/lib/client/notes-navigation-popstate';

describe('notes navigation popstate bridge', () => {
  const downstream = vi.fn();

  afterEach(() => {
    window.removeEventListener('popstate', downstream);
    downstream.mockReset();
  });

  it('claims only an expected app-owned pop before downstream routers', () => {
    installNotesNavigationPopstateBridge();
    window.addEventListener('popstate', downstream);
    const listener = vi.fn(() => true);
    const unsubscribe = subscribeNotesNavigationPopstate(listener);
    const state = { app: 'expected' };

    window.dispatchEvent(new PopStateEvent('popstate', { state }));
    expect(listener).toHaveBeenCalledWith(state);
    expect(downstream).not.toHaveBeenCalled();

    unsubscribe();
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    expect(downstream).toHaveBeenCalledOnce();
  });

  it('passes an ordinary browser traversal to downstream routers', () => {
    installNotesNavigationPopstateBridge();
    window.addEventListener('popstate', downstream);
    const listener = vi.fn(() => false);
    const unsubscribe = subscribeNotesNavigationPopstate(listener);

    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    expect(listener).toHaveBeenCalledWith(null);
    expect(downstream).toHaveBeenCalledOnce();
    unsubscribe();
  });
});

/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initialForegroundResumeState,
  transitionForegroundResume,
} from '@/lib/application/foreground-resume';
import { subscribeBrowserForegroundResume } from '@/lib/client/browser-foreground-resume';

let visibility: DocumentVisibilityState = 'visible';

Object.defineProperty(document, 'visibilityState', {
  configurable: true,
  get: () => visibility,
});

afterEach(() => {
  visibility = 'visible';
});

describe('foreground resume transition', () => {
  it('notifies only on a background-to-foreground edge', () => {
    expect(initialForegroundResumeState(true)).toBe('foreground');
    expect(initialForegroundResumeState(false)).toBe('background');
    expect(
      transitionForegroundResume('foreground', {
        type: 'visibility-changed',
        visible: true,
      }),
    ).toEqual({ state: 'foreground', notify: false });
    expect(
      transitionForegroundResume('foreground', { type: 'page-hidden' }),
    ).toEqual({ state: 'background', notify: false });
    expect(
      transitionForegroundResume('background', {
        type: 'page-shown',
        visible: true,
      }),
    ).toEqual({ state: 'foreground', notify: true });
  });
});

describe('browser foreground resume adapter', () => {
  it('coalesces hidden-visible-pageshow into one resume notification', () => {
    const onResume = vi.fn();
    const unsubscribe = subscribeBrowserForegroundResume(
      document,
      window,
      onResume,
    );

    window.dispatchEvent(new PageTransitionEvent('pageshow'));
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pageshow'));

    expect(onResume).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('coalesces pagehide-pageshow-visible and removes every listener', () => {
    const onResume = vi.fn();
    const unsubscribe = subscribeBrowserForegroundResume(
      document,
      window,
      onResume,
    );

    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    window.dispatchEvent(
      new PageTransitionEvent('pageshow', { persisted: true }),
    );
    document.dispatchEvent(new Event('visibilitychange'));
    expect(onResume).toHaveBeenCalledOnce();

    unsubscribe();
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    window.dispatchEvent(new PageTransitionEvent('pageshow'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(onResume).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { NotesLocation } from '@/lib/application/navigation';
import {
  notesLocationPathname,
  parseNotesPathname,
} from '@/lib/application/url-navigation';
import {
  createBrowserNotesNavigator,
  decodeNotesNavigationHistoryMetadata,
  NOTES_NAVIGATION_HISTORY_STATE_KEY,
  type NotesBrowserHistoryPort,
} from '@/lib/client/browser-notes-navigator';
import { fixtureCardId } from '@/tests/fixtures/ids';

function fakeBrowserHistory(initialUrl: string, initialState: unknown = null) {
  let entries = [{ url: initialUrl, state: initialState }];
  let index = 0;
  const listeners = new Set<() => void>();
  let replaceCalls = 0;
  const current = () => entries[index] ?? { url: '/', state: null };
  const url = () => new URL(current().url, 'https://notes.example');
  const port: NotesBrowserHistoryPort = {
    getUrl: () => ({
      pathname: url().pathname,
      search: url().search,
      hash: url().hash,
    }),
    getState: () => current().state,
    push: (pathname, state) => {
      entries = [...entries.slice(0, index + 1), { url: pathname, state }];
      index += 1;
    },
    replace: (pathname, state) => {
      entries[index] = { url: pathname, state };
      replaceCalls += 1;
    },
    back: () => move(-1),
    subscribePop: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const move = (offset: number) => {
    const next = index + offset;
    if (next < 0 || next >= entries.length) return;
    index = next;
    for (const listener of listeners) listener();
  };
  return {
    port,
    entries: () => entries.map((entry) => entry.url),
    states: () => entries.map((entry) => entry.state),
    current: () => current().url,
    replaceCalls: () => replaceCalls,
    pushExternal: (pathname: string, state: unknown) =>
      port.push(pathname, state),
    back: () => move(-1),
    forward: () => move(1),
  };
}

describe('notes pathname contract', () => {
  const cardId = fixtureCardId('url-round-trip');
  const locations: NotesLocation[] = [
    { kind: 'empty' },
    { kind: 'card', cardId },
    { kind: 'history', cardId: null },
    { kind: 'history', cardId },
    { kind: 'connections', cardId },
  ];

  it('round-trips every location through one canonical pathname', () => {
    for (const location of locations) {
      const pathname = notesLocationPathname(location);
      expect(parseNotesPathname(pathname)).toEqual({
        kind: 'valid',
        location,
        canonicalPathname: pathname,
      });
    }
  });

  it('recognizes normalizable trailing slash and ID case variants', () => {
    const upper = cardId.toUpperCase();
    expect(parseNotesPathname(`/cards/${upper}/history/`)).toEqual({
      kind: 'valid',
      location: { kind: 'history', cardId },
      canonicalPathname: `/cards/${cardId}/history`,
    });
    expect(parseNotesPathname('/history/')).toEqual({
      kind: 'valid',
      location: { kind: 'history', cardId: null },
      canonicalPathname: '/history',
    });
  });

  it('rejects malformed IDs, escapes, extra segments and unknown paths', () => {
    for (const pathname of [
      'history',
      '/cards/not-a-uuid',
      '/cards/%E0%A4%A',
      `/cards/${cardId}/history/extra`,
      `/cards/${cardId}/unknown`,
      `/cards/${encodeURIComponent(`${cardId}/history`)}`,
      '/unknown',
      '//history',
    ]) {
      expect(parseNotesPathname(pathname)).toEqual({ kind: 'invalid' });
    }
  });
});

describe('browser notes navigator', () => {
  const cardA = fixtureCardId('url-card-a');
  const cardB = fixtureCardId('url-card-b');
  const cardC = fixtureCardId('url-card-c');

  it('has an inert root snapshot during server rendering', () => {
    const navigator = createBrowserNotesNavigator();
    expect(navigator.getLocation()).toEqual({ kind: 'empty' });
    const initialSnapshot = navigator.getSnapshot();
    expect(navigator.getSnapshot()).toBe(initialSnapshot);
    expect(
      navigator.navigate({ type: 'initialize', cardIds: [cardA] }),
    ).toEqual({ kind: 'card', cardId: cardA });
    expect(navigator.getSnapshot()).toMatchObject({
      location: { kind: 'card', cardId: cardA },
      cause: 'initialize',
      pending: false,
    });
  });

  it('commits namespaced initial metadata after subscription and preserves foreign state', () => {
    const browser = fakeBrowserHistory(`/cards/${cardA}`, {
      router: { scroll: 12 },
    });
    const navigator = createBrowserNotesNavigator(browser.port, {
      createRuntimeId: () => 'runtime-a',
    });
    const stopFirst = navigator.subscribe(() => undefined);
    expect(browser.replaceCalls()).toBe(1);
    expect(browser.states()[0]).toEqual({
      router: { scroll: 12 },
      [NOTES_NAVIGATION_HISTORY_STATE_KEY]: {
        version: 1,
        runtimeId: 'runtime-a',
        entryId: 1,
      },
    });

    stopFirst();
    const stopSecond = navigator.subscribe(() => undefined);
    expect(browser.replaceCalls()).toBe(1);
    stopSecond();
  });

  it('decodes only finite positive versioned navigation metadata', () => {
    expect(
      decodeNotesNavigationHistoryMetadata({
        [NOTES_NAVIGATION_HISTORY_STATE_KEY]: {
          version: 1,
          runtimeId: 'runtime-a',
          entryId: 42,
        },
      }),
    ).toEqual({ version: 1, runtimeId: 'runtime-a', entryId: 42 });
    for (const value of [
      null,
      [],
      { [NOTES_NAVIGATION_HISTORY_STATE_KEY]: null },
      {
        [NOTES_NAVIGATION_HISTORY_STATE_KEY]: {
          version: 2,
          runtimeId: 'runtime-a',
          entryId: 1,
        },
      },
      {
        [NOTES_NAVIGATION_HISTORY_STATE_KEY]: {
          version: 1,
          runtimeId: '',
          entryId: 1,
        },
      },
      {
        [NOTES_NAVIGATION_HISTORY_STATE_KEY]: {
          version: 1,
          runtimeId: 'runtime-a',
          entryId: 0,
        },
      },
    ]) {
      expect(decodeNotesNavigationHistoryMetadata(value)).toBeNull();
    }
  });

  it('pushes user destinations and restores all card/view context on pop', () => {
    const browser = fakeBrowserHistory(`/cards/${cardA}`);
    const navigator = createBrowserNotesNavigator(browser.port);
    const listener = vi.fn();
    navigator.subscribe(listener);

    navigator.navigate({ type: 'show-history' });
    navigator.navigate({ type: 'open-card', cardId: cardB });
    navigator.navigate({ type: 'show-connections' });
    navigator.navigate({ type: 'open-card', cardId: cardC });
    expect(browser.entries()).toEqual([
      `/cards/${cardA}`,
      `/cards/${cardA}/history`,
      `/cards/${cardB}`,
      `/cards/${cardB}/connections`,
      `/cards/${cardC}`,
    ]);

    const backward: NotesLocation[] = [];
    for (let count = 0; count < 4; count += 1) {
      browser.back();
      backward.push(navigator.getLocation());
    }
    expect(backward).toEqual([
      { kind: 'connections', cardId: cardB },
      { kind: 'card', cardId: cardB },
      { kind: 'history', cardId: cardA },
      { kind: 'card', cardId: cardA },
    ]);

    const forward: NotesLocation[] = [];
    for (let count = 0; count < 4; count += 1) {
      browser.forward();
      forward.push(navigator.getLocation());
    }
    expect(forward).toEqual([
      { kind: 'history', cardId: cardA },
      { kind: 'card', cardId: cardB },
      { kind: 'connections', cardId: cardB },
      { kind: 'card', cardId: cardC },
    ]);
    expect(browser.entries()).toHaveLength(5);
    expect(listener).toHaveBeenCalledTimes(12);
    expect(navigator.getSnapshot()).toMatchObject({
      activationId: 13,
      cause: 'traverse',
      pending: false,
    });
  });

  it('replaces initialization, correction and the first card from root', () => {
    const browser = fakeBrowserHistory('/bad-path?ignored=true#state');
    const navigator = createBrowserNotesNavigator(browser.port);
    navigator.navigate({ type: 'initialize', cardIds: [cardA, cardB] });
    expect(browser.entries()).toEqual([`/cards/${cardB}`]);

    const emptyBrowser = fakeBrowserHistory('/');
    const emptyNavigator = createBrowserNotesNavigator(emptyBrowser.port);
    emptyNavigator.navigate({ type: 'initialize', cardIds: [] });
    emptyNavigator.navigate({ type: 'open-card', cardId: cardA });
    expect(emptyBrowser.entries()).toEqual([`/cards/${cardA}`]);
  });

  it('does not add history for the same destination or canonicalization', () => {
    const browser = fakeBrowserHistory(
      `/cards/${cardA.toUpperCase()}/history/?source=old#fragment`,
    );
    const navigator = createBrowserNotesNavigator(browser.port);
    const listener = vi.fn();
    navigator.subscribe(listener);
    navigator.navigate({ type: 'reconcile-cards', cardIds: [cardA] });
    expect(browser.entries()).toEqual([`/cards/${cardA}/history`]);

    navigator.navigate({ type: 'show-history' });
    expect(browser.entries()).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('normalizes invalid and noncanonical pop entries without pushing', () => {
    const browser = fakeBrowserHistory(`/cards/${cardA}`);
    const navigator = createBrowserNotesNavigator(browser.port);
    navigator.subscribe(() => undefined);
    browser.pushExternal('/unknown', null);
    browser.back();
    browser.forward();
    expect(navigator.getLocation()).toEqual({ kind: 'empty' });
    expect(browser.entries()).toEqual([`/cards/${cardA}`, '/']);
  });

  it('restores a compact camera snapshot for the exact traversed entry', () => {
    const browser = fakeBrowserHistory(`/cards/${cardA}/connections`);
    const navigator = createBrowserNotesNavigator(browser.port, {
      createRuntimeId: () => 'runtime-camera',
    });
    navigator.subscribe(() => undefined);
    const initial = navigator.getSnapshot();
    const camera = navigator.cameraSession.bind({
      entryId: initial.entryId,
      activationId: initial.activationId,
      currentCardId: cardA,
      cause: initial.cause,
    });
    expect(camera.read('layout-a')).toBeNull();
    camera.write({
      currentCardId: cardA,
      layoutKey: 'layout-a',
      scale: 1.25,
      centerWorld: { x: 320, y: -80 },
    });

    navigator.navigate({ type: 'open-card', cardId: cardB });
    browser.back();
    const restored = navigator.getSnapshot();
    expect(restored).toMatchObject({
      entryId: initial.entryId,
      cause: 'traverse',
      location: { kind: 'connections', cardId: cardA },
    });
    const restoredCamera = () => {
      const current = navigator.getSnapshot();
      return navigator.cameraSession
        .bind({
          entryId: current.entryId,
          activationId: current.activationId,
          currentCardId: cardA,
          cause: current.cause,
        })
        .read('layout-a');
    };
    expect(restoredCamera()).toEqual({
      currentCardId: cardA,
      layoutKey: 'layout-a',
      scale: 1.25,
      centerWorld: { x: 320, y: -80 },
    });
    browser.forward();
    expect(navigator.getLocation()).toEqual({ kind: 'card', cardId: cardB });
    browser.back();
    expect(restoredCamera()).toEqual({
      currentCardId: cardA,
      layoutKey: 'layout-a',
      scale: 1.25,
      centerWorld: { x: 320, y: -80 },
    });
  });

  it('adopts foreign-runtime pop state and rejects stale camera bindings', () => {
    const browser = fakeBrowserHistory(`/cards/${cardA}/connections`);
    const navigator = createBrowserNotesNavigator(browser.port, {
      createRuntimeId: () => 'runtime-current',
    });
    navigator.subscribe(() => undefined);
    const initial = navigator.getSnapshot();
    const stale = navigator.cameraSession.bind({
      entryId: initial.entryId,
      activationId: initial.activationId,
      currentCardId: cardA,
      cause: initial.cause,
    });
    stale.read('layout-a');

    browser.pushExternal(`/cards/${cardB}`, {
      [NOTES_NAVIGATION_HISTORY_STATE_KEY]: {
        version: 1,
        runtimeId: 'runtime-foreign',
        entryId: 99,
      },
    });
    browser.back();
    browser.forward();
    expect(navigator.getSnapshot()).toMatchObject({
      location: { kind: 'card', cardId: cardB },
      cause: 'traverse',
    });
    stale.write({
      currentCardId: cardA,
      layoutKey: 'layout-a',
      scale: 2,
      centerWorld: { x: 1, y: 1 },
    });
    expect(stale.read('layout-a')).toBeNull();
    expect(
      decodeNotesNavigationHistoryMetadata(browser.states()[1]),
    ).toMatchObject({ runtimeId: 'runtime-current' });
  });
});

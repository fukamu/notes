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

function fakeBrowserHistory(
  initialUrl: string,
  initialState: unknown = null,
  options: { autoPopOnBack?: boolean; throwOnBack?: boolean } = {},
) {
  let entries = [{ url: initialUrl, state: initialState }];
  let index = 0;
  const listeners = new Set<(state: unknown) => boolean>();
  let replaceCalls = 0;
  let backCalls = 0;
  let handledPopCalls = 0;
  const pendingMoves: number[] = [];
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
    back: () => {
      backCalls += 1;
      if (options.throwOnBack) throw new Error('history.go failed');
      if (options.autoPopOnBack === false) {
        pendingMoves.push(-1);
      } else {
        move(-1);
      }
    },
    subscribePop: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const move = (offset: number) => {
    const next = index + offset;
    if (next < 0 || next >= entries.length) return;
    index = next;
    for (const listener of listeners) {
      if (listener(current().state)) handledPopCalls += 1;
    }
  };
  return {
    port,
    entries: () => entries.map((entry) => entry.url),
    states: () => entries.map((entry) => entry.state),
    current: () => current().url,
    replaceCalls: () => replaceCalls,
    backCalls: () => backCalls,
    handledPopCalls: () => handledPopCalls,
    completePendingMove: () => {
      const offset = pendingMoves.shift();
      if (offset !== undefined) move(offset);
    },
    pendingMoveCount: () => pendingMoves.length,
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

  it('replaces tabs, pushes opened cards and restores the resulting entries', () => {
    const browser = fakeBrowserHistory(`/cards/${cardA}`);
    const navigator = createBrowserNotesNavigator(browser.port);
    const listener = vi.fn();
    navigator.subscribe(listener);

    navigator.navigate({ type: 'show-history' });
    navigator.navigate({ type: 'open-card', cardId: cardB });
    navigator.navigate({ type: 'show-connections' });
    navigator.navigate({ type: 'open-card', cardId: cardC });
    expect(browser.entries()).toEqual([
      `/cards/${cardA}/history`,
      `/cards/${cardB}/connections`,
      `/cards/${cardC}`,
    ]);

    const backward: NotesLocation[] = [];
    for (let count = 0; count < 2; count += 1) {
      browser.back();
      backward.push(navigator.getLocation());
    }
    expect(backward).toEqual([
      { kind: 'connections', cardId: cardB },
      { kind: 'history', cardId: cardA },
    ]);

    const forward: NotesLocation[] = [];
    for (let count = 0; count < 2; count += 1) {
      browser.forward();
      forward.push(navigator.getLocation());
    }
    expect(forward).toEqual([
      { kind: 'connections', cardId: cardB },
      { kind: 'card', cardId: cardC },
    ]);
    expect(browser.entries()).toHaveLength(3);
    expect(listener).toHaveBeenCalledTimes(8);
    expect(navigator.getSnapshot()).toMatchObject({
      activationId: 9,
      cause: 'traverse',
      pending: false,
    });
  });

  it('keeps each opened card in a readable Back chain', () => {
    const browser = fakeBrowserHistory(`/cards/${cardA}`);
    const navigator = createBrowserNotesNavigator(browser.port);
    navigator.subscribe(() => undefined);

    navigator.navigate({ type: 'open-card', cardId: cardB });
    navigator.navigate({ type: 'open-card', cardId: cardC });
    browser.back();
    expect(navigator.getLocation()).toEqual({ kind: 'card', cardId: cardB });
    browser.back();
    expect(navigator.getLocation()).toEqual({ kind: 'card', cardId: cardA });
  });

  it('applies immediate source reuse to history as well as connections', () => {
    const browser = fakeBrowserHistory(`/cards/${cardA}/history`);
    const navigator = createBrowserNotesNavigator(browser.port);
    navigator.subscribe(() => undefined);

    navigator.navigate({ type: 'open-card', cardId: cardB });
    navigator.navigate({ type: 'show-history' });

    expect(browser.entries()).toEqual([
      `/cards/${cardB}/history`,
      `/cards/${cardB}`,
    ]);
    expect(navigator.getSnapshot()).toMatchObject({
      location: { kind: 'history', cardId: cardB },
      cause: 'tab',
      pending: false,
    });
    browser.forward();
    expect(navigator.getLocation()).toEqual({ kind: 'card', cardId: cardB });
  });

  it('adds the first card to a context-free history entry before reusing that history entry', () => {
    const browser = fakeBrowserHistory('/');
    const navigator = createBrowserNotesNavigator(browser.port);
    navigator.subscribe(() => undefined);
    navigator.navigate({ type: 'show-history' });
    navigator.navigate({ type: 'open-card', cardId: cardA });
    navigator.navigate({ type: 'show-history' });

    expect(browser.entries()).toEqual([
      `/cards/${cardA}/history`,
      `/cards/${cardA}`,
    ]);
    expect(navigator.getLocation()).toEqual({
      kind: 'history',
      cardId: cardA,
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

  it('keeps same-card tab changes in one entry', () => {
    const browser = fakeBrowserHistory(`/cards/${cardA}`);
    const navigator = createBrowserNotesNavigator(browser.port);
    navigator.subscribe(() => undefined);

    navigator.navigate({ type: 'show-history' });
    navigator.navigate({ type: 'show-current-card' });
    navigator.navigate({ type: 'show-connections' });
    navigator.navigate({ type: 'show-current-card' });

    expect(browser.entries()).toEqual([`/cards/${cardA}`]);
    expect(navigator.getSnapshot()).toMatchObject({
      entryId: 1,
      activationId: 5,
      pending: false,
    });
  });

  it('reuses only the immediate previous same-kind entry without rendering its old card', () => {
    const browser = fakeBrowserHistory(`/cards/${cardA}/connections`, null, {
      autoPopOnBack: false,
    });
    const navigator = createBrowserNotesNavigator(browser.port, {
      createRuntimeId: () => 'runtime-return',
    });
    const snapshots: ReturnType<typeof navigator.getSnapshot>[] = [];
    navigator.subscribe(() => snapshots.push(navigator.getSnapshot()));
    navigator.navigate({ type: 'open-card', cardId: cardB });

    expect(navigator.navigate({ type: 'show-connections' })).toEqual({
      kind: 'card',
      cardId: cardB,
    });
    expect(navigator.getSnapshot()).toMatchObject({
      location: { kind: 'card', cardId: cardB },
      pending: true,
    });
    expect(browser.backCalls()).toBe(1);
    expect(browser.pendingMoveCount()).toBe(1);

    navigator.navigate({ type: 'show-history' });
    navigator.navigate({ type: 'open-card', cardId: cardC });
    expect(browser.backCalls()).toBe(1);
    expect(navigator.getLocation()).toEqual({ kind: 'card', cardId: cardB });

    browser.completePendingMove();
    expect(browser.handledPopCalls()).toBe(1);
    expect(browser.entries()).toEqual([
      `/cards/${cardB}/connections`,
      `/cards/${cardB}`,
    ]);
    expect(navigator.getSnapshot()).toMatchObject({
      location: { kind: 'connections', cardId: cardB },
      entryId: 1,
      activationId: 3,
      cause: 'tab',
      pending: false,
    });
    expect(
      snapshots.some(
        (snapshot) =>
          snapshot.location.kind === 'connections' &&
          snapshot.location.cardId === cardA,
      ),
    ).toBe(false);

    browser.forward();
    expect(navigator.getLocation()).toEqual({ kind: 'card', cardId: cardB });
    browser.back();
    expect(navigator.getSnapshot()).toMatchObject({
      location: { kind: 'connections', cardId: cardB },
      cause: 'traverse',
    });
  });

  it('does not search a distant same-kind ancestor', () => {
    const browser = fakeBrowserHistory(`/cards/${cardA}/connections`);
    const navigator = createBrowserNotesNavigator(browser.port);
    navigator.subscribe(() => undefined);

    navigator.navigate({ type: 'open-card', cardId: cardB });
    navigator.navigate({ type: 'open-card', cardId: cardC });
    navigator.navigate({ type: 'show-connections' });

    expect(browser.backCalls()).toBe(0);
    expect(browser.entries()).toEqual([
      `/cards/${cardA}/connections`,
      `/cards/${cardB}`,
      `/cards/${cardC}/connections`,
    ]);
  });

  it('preserves a card source when the card tab replaces a map before Back', () => {
    const browser = fakeBrowserHistory(`/cards/${cardB}`);
    const navigator = createBrowserNotesNavigator(browser.port);
    navigator.subscribe(() => undefined);

    navigator.navigate({ type: 'open-card', cardId: cardC });
    navigator.navigate({ type: 'show-connections' });
    navigator.navigate({ type: 'show-current-card' });
    browser.back();

    expect(browser.entries()).toEqual([`/cards/${cardB}`, `/cards/${cardC}`]);
    expect(navigator.getLocation()).toEqual({ kind: 'card', cardId: cardB });
  });

  it('prunes the known forward branch when a new card opens after Back', () => {
    const browser = fakeBrowserHistory(`/cards/${cardA}/connections`);
    const navigator = createBrowserNotesNavigator(browser.port);
    navigator.subscribe(() => undefined);
    navigator.navigate({ type: 'open-card', cardId: cardB });
    browser.back();
    navigator.navigate({ type: 'open-card', cardId: cardC });

    expect(browser.entries()).toEqual([
      `/cards/${cardA}/connections`,
      `/cards/${cardC}`,
    ]);
    browser.forward();
    expect(navigator.getLocation()).toEqual({ kind: 'card', cardId: cardC });
  });

  it('adopts an unexpected pop during a pending return without forcing another move', () => {
    const browser = fakeBrowserHistory(`/cards/${cardA}/connections`, null, {
      autoPopOnBack: false,
    });
    const navigator = createBrowserNotesNavigator(browser.port);
    navigator.subscribe(() => undefined);
    navigator.navigate({ type: 'open-card', cardId: cardB });
    navigator.navigate({ type: 'show-connections' });

    browser.pushExternal('/history', null);
    browser.back();

    expect(navigator.getSnapshot()).toMatchObject({
      location: { kind: 'card', cardId: cardB },
      cause: 'traverse',
      pending: false,
    });
    expect(browser.backCalls()).toBe(1);
  });

  it('cancels an old return target when reconcile changes the pending source', () => {
    const browser = fakeBrowserHistory(`/cards/${cardA}/connections`, null, {
      autoPopOnBack: false,
    });
    const navigator = createBrowserNotesNavigator(browser.port);
    navigator.subscribe(() => undefined);
    navigator.navigate({ type: 'open-card', cardId: cardB });
    navigator.navigate({ type: 'show-connections' });
    navigator.navigate({ type: 'reconcile-cards', cardIds: [cardA, cardC] });

    expect(navigator.getSnapshot()).toMatchObject({
      location: { kind: 'card', cardId: cardC },
      cause: 'reconcile',
      pending: true,
    });
    browser.completePendingMove();
    expect(navigator.getSnapshot()).toMatchObject({
      location: { kind: 'connections', cardId: cardA },
      cause: 'traverse',
      pending: false,
    });
    expect(browser.entries()[0]).toBe(`/cards/${cardA}/connections`);
  });

  it('falls back to a tab replace when the single history move throws', () => {
    const browser = fakeBrowserHistory(`/cards/${cardA}/connections`, null, {
      throwOnBack: true,
    });
    const navigator = createBrowserNotesNavigator(browser.port);
    navigator.subscribe(() => undefined);
    navigator.navigate({ type: 'open-card', cardId: cardB });
    navigator.navigate({ type: 'show-connections' });

    expect(browser.backCalls()).toBe(1);
    expect(browser.entries()).toEqual([
      `/cards/${cardA}/connections`,
      `/cards/${cardB}/connections`,
    ]);
    expect(navigator.getSnapshot()).toMatchObject({
      location: { kind: 'connections', cardId: cardB },
      cause: 'tab',
      pending: false,
    });
  });

  it('preserves a non-record history state instead of claiming the entry', () => {
    const foreignState = ['router-owned'];
    const browser = fakeBrowserHistory(`/cards/${cardA}`, foreignState);
    const navigator = createBrowserNotesNavigator(browser.port);
    navigator.subscribe(() => undefined);
    navigator.navigate({ type: 'show-history' });

    expect(browser.states()).toEqual([foreignState]);
    expect(browser.entries()).toEqual([`/cards/${cardA}/history`]);
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

  it('keeps same-card camera data on entry reuse and invalidates it across cards', () => {
    const sameBrowser = fakeBrowserHistory(`/cards/${cardB}/connections`);
    const sameNavigator = createBrowserNotesNavigator(sameBrowser.port, {
      createRuntimeId: () => 'runtime-same-camera',
    });
    sameNavigator.subscribe(() => undefined);
    const sameInitial = sameNavigator.getSnapshot();
    const sameCamera = sameNavigator.cameraSession.bind({
      entryId: sameInitial.entryId,
      activationId: sameInitial.activationId,
      currentCardId: cardB,
      cause: sameInitial.cause,
    });
    sameCamera.read('layout-b');
    sameCamera.write({
      currentCardId: cardB,
      layoutKey: 'layout-b',
      scale: 1.6,
      centerWorld: { x: 44, y: -72 },
    });
    sameNavigator.navigate({ type: 'open-card', cardId: cardB });
    sameNavigator.navigate({ type: 'show-connections' });
    const sameReturned = sameNavigator.getSnapshot();
    expect(
      sameNavigator.cameraSession
        .bind({
          entryId: sameReturned.entryId,
          activationId: sameReturned.activationId,
          currentCardId: cardB,
          cause: sameReturned.cause,
        })
        .read('layout-b'),
    ).toMatchObject({
      scale: 1.6,
      centerWorld: { x: 44, y: -72 },
    });

    const changedBrowser = fakeBrowserHistory(`/cards/${cardA}/connections`);
    const changedNavigator = createBrowserNotesNavigator(changedBrowser.port, {
      createRuntimeId: () => 'runtime-changed-camera',
    });
    changedNavigator.subscribe(() => undefined);
    const changedInitial = changedNavigator.getSnapshot();
    const changedCamera = changedNavigator.cameraSession.bind({
      entryId: changedInitial.entryId,
      activationId: changedInitial.activationId,
      currentCardId: cardA,
      cause: changedInitial.cause,
    });
    changedCamera.read('layout-a');
    changedCamera.write({
      currentCardId: cardA,
      layoutKey: 'layout-a',
      scale: 1.3,
      centerWorld: { x: 20, y: 30 },
    });
    changedNavigator.navigate({ type: 'open-card', cardId: cardB });
    changedNavigator.navigate({ type: 'show-connections' });
    const changedReturned = changedNavigator.getSnapshot();
    expect(
      changedNavigator.cameraSession
        .bind({
          entryId: changedReturned.entryId,
          activationId: changedReturned.activationId,
          currentCardId: cardB,
          cause: changedReturned.cause,
        })
        .read('layout-a'),
    ).toBeNull();
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

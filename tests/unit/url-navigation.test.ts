import { describe, expect, it, vi } from 'vitest';
import type { NotesLocation } from '@/lib/application/navigation';
import {
  notesLocationPathname,
  parseNotesPathname,
} from '@/lib/application/url-navigation';
import {
  createBrowserNotesNavigator,
  type NotesBrowserHistoryPort,
} from '@/lib/client/browser-notes-navigator';
import { fixtureCardId } from '@/tests/fixtures/ids';

function fakeBrowserHistory(initialUrl: string) {
  let entries = [initialUrl];
  let index = 0;
  const listeners = new Set<() => void>();
  const url = () => new URL(entries[index] ?? '/', 'https://notes.example');
  const port: NotesBrowserHistoryPort = {
    getUrl: () => ({
      pathname: url().pathname,
      search: url().search,
      hash: url().hash,
    }),
    push: (pathname) => {
      entries = [...entries.slice(0, index + 1), pathname];
      index += 1;
    },
    replace: (pathname) => {
      entries[index] = pathname;
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
    for (const listener of listeners) listener();
  };
  return {
    port,
    entries: () => [...entries],
    current: () => entries[index],
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
    expect(
      navigator.navigate({ type: 'initialize', cardIds: [cardA] }),
    ).toEqual({ kind: 'card', cardId: cardA });
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
    browser.port.push('/unknown');
    browser.back();
    browser.forward();
    expect(navigator.getLocation()).toEqual({ kind: 'empty' });
    expect(browser.entries()).toEqual([`/cards/${cardA}`, '/']);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryNotesNavigator,
  decideNotesHistoryEffect,
  reduceNotesLocation,
  type NotesLocation,
} from '@/lib/application/navigation';
import type { CardId } from '@/lib/domain/id';
import { fixtureCardId } from '@/tests/fixtures/ids';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type ConnectionsLocation = Extract<NotesLocation, { kind: 'connections' }>;
type HistoryLocation = Extract<NotesLocation, { kind: 'history' }>;
type _ConnectionsRequireCardId = Expect<
  Equal<ConnectionsLocation['cardId'], CardId>
>;
type _HistoryAllowsNoContext = Expect<
  Equal<HistoryLocation['cardId'], CardId | null>
>;

describe('notes navigation', () => {
  const first = fixtureCardId('navigation-first');
  const last = fixtureCardId('navigation-last');

  it('initializes empty and populated collections to valid locations', () => {
    expect(
      reduceNotesLocation(
        { kind: 'empty' },
        { type: 'initialize', cardIds: [] },
      ),
    ).toEqual({ kind: 'empty' });
    expect(
      reduceNotesLocation(
        { kind: 'empty' },
        { type: 'initialize', cardIds: [first, last] },
      ),
    ).toEqual({ kind: 'card', cardId: last });
  });

  it('retains optional history context and never creates context-free connections', () => {
    const history: HistoryLocation = { kind: 'history', cardId: null };
    expect(reduceNotesLocation(history, { type: 'show-connections' })).toBe(
      history,
    );
    expect(reduceNotesLocation(history, { type: 'show-current-card' })).toBe(
      history,
    );

    const contextualHistory: HistoryLocation = {
      kind: 'history',
      cardId: first,
    };
    expect(
      reduceNotesLocation(contextualHistory, { type: 'show-connections' }),
    ).toEqual({ kind: 'connections', cardId: first });
  });

  it('reconciles a missing card explicitly without preserving invalid state', () => {
    expect(
      reduceNotesLocation(
        { kind: 'connections', cardId: first },
        { type: 'reconcile-cards', cardIds: [last] },
      ),
    ).toEqual({ kind: 'card', cardId: last });
    expect(
      reduceNotesLocation(
        { kind: 'history', cardId: first },
        { type: 'reconcile-cards', cardIds: [last] },
      ),
    ).toEqual({ kind: 'history', cardId: null });
  });

  it('does not notify for navigation to the same semantic location', () => {
    const navigator = createInMemoryNotesNavigator({
      kind: 'card',
      cardId: first,
    });
    const listener = vi.fn();
    navigator.subscribe(listener);
    const before = navigator.getLocation();
    const beforeSnapshot = navigator.getSnapshot();

    expect(navigator.navigate({ type: 'open-card', cardId: first })).toBe(
      before,
    );
    expect(listener).not.toHaveBeenCalled();
    expect(navigator.getSnapshot()).toBe(beforeSnapshot);

    navigator.navigate({ type: 'show-history' });
    expect(listener).toHaveBeenCalledOnce();
    expect(navigator.getSnapshot()).toMatchObject({
      location: { kind: 'history', cardId: first },
      entryId: 1,
      activationId: 2,
      cause: 'tab',
      pending: false,
    });
  });

  it('decides history effects without reading or mutating browser state', () => {
    const card = { kind: 'card', cardId: first } as const;
    const history = { kind: 'history', cardId: first } as const;
    const connections = { kind: 'connections', cardId: first } as const;

    expect(
      decideNotesHistoryEffect({
        current: card,
        next: card,
        intent: { type: 'show-current-card' },
        previousManagedLocation: connections,
      }),
    ).toEqual({ type: 'noop' });
    expect(
      decideNotesHistoryEffect({
        current: { kind: 'empty' },
        next: card,
        intent: { type: 'open-card', cardId: first },
        previousManagedLocation: null,
      }),
    ).toEqual({ type: 'replace' });
    expect(
      decideNotesHistoryEffect({
        current: history,
        next: card,
        intent: { type: 'open-card', cardId: first },
        previousManagedLocation: null,
      }),
    ).toEqual({ type: 'push' });
    expect(
      decideNotesHistoryEffect({
        current: card,
        next: history,
        intent: { type: 'show-history' },
        previousManagedLocation: history,
      }),
    ).toEqual({ type: 'return-to-previous' });
    expect(
      decideNotesHistoryEffect({
        current: card,
        next: connections,
        intent: { type: 'show-connections' },
        previousManagedLocation: history,
      }),
    ).toEqual({ type: 'replace' });
    expect(
      decideNotesHistoryEffect({
        current: connections,
        next: card,
        intent: { type: 'show-current-card' },
        previousManagedLocation: card,
      }),
    ).toEqual({ type: 'replace' });
  });
});

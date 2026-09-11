import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryNotesNavigator,
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

    expect(navigator.navigate({ type: 'open-card', cardId: first })).toBe(
      before,
    );
    expect(listener).not.toHaveBeenCalled();

    navigator.navigate({ type: 'show-history' });
    expect(listener).toHaveBeenCalledOnce();
  });
});

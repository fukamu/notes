import { describe, expect, it, vi } from 'vitest';
import { createCardLabelResolver } from '@/lib/editor/card-labels';
import { fixtureCardId } from '@/tests/fixtures/ids';

describe('instance-scoped card label resolver', () => {
  it('isolates multiple editor instances and updates display/title labels', () => {
    const cardId = fixtureCardId('label-shared-id');
    const first = createCardLabelResolver([
      { cardId, label: '#1 First title' },
    ]);
    const second = createCardLabelResolver([
      { cardId, label: '仮 #8 Second title' },
    ]);

    expect(first.labelFor(cardId)).toBe('#1 First title');
    expect(second.labelFor(cardId)).toBe('仮 #8 Second title');
    first.replaceLabels([{ cardId, label: '#2 Updated title' }]);
    expect(first.labelFor(cardId)).toBe('#2 Updated title');
    expect(second.labelFor(cardId)).toBe('仮 #8 Second title');
  });

  it('provides a missing-link fallback and releases subscriptions', () => {
    const cardId = fixtureCardId('label-listener');
    const missing = fixtureCardId('label-missing');
    const resolver = createCardLabelResolver([
      { cardId, label: '#1 Listener' },
    ]);
    const listener = vi.fn();
    const unsubscribe = resolver.subscribe(listener);

    expect(resolver.labelFor(missing)).toBe('リンク先なし');
    resolver.replaceLabels([{ cardId, label: '#2 Listener' }]);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    resolver.replaceLabels([{ cardId, label: '#3 Listener' }]);
    expect(listener).toHaveBeenCalledOnce();

    resolver.destroy();
    resolver.replaceLabels([{ cardId, label: '#4 Listener' }]);
    expect(resolver.labelFor(cardId)).toBe('リンク先なし');
    expect(listener).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it } from 'vitest';
import { createNotesViewStatePorts } from '@/lib/client/notes-view-state';
import { fixtureCardId } from '@/tests/fixtures/ids';

describe('runtime notes view state', () => {
  it('keeps one snapshot per view for the current card and rejects another card', () => {
    const currentCardId = fixtureCardId('view-state-current');
    const otherCardId = fixtureCardId('view-state-other');
    const ports = createNotesViewStatePorts(currentCardId);

    ports.body.write({ currentCardId, scrollY: 420 });
    ports.body.write({ currentCardId: otherCardId, scrollY: 900 });
    ports.history.write({
      currentCardId,
      anchorCardId: otherCardId,
      fallbackIndex: 3,
      offsetPx: 17,
    });
    ports.connections.write({
      currentCardId,
      layoutKey: 'layout-a',
      scale: 1.25,
      centerWorld: { x: 40, y: -20 },
    });

    expect(ports.body.read()).toEqual({ currentCardId, scrollY: 420 });
    expect(ports.history.read()).toMatchObject({
      currentCardId,
      anchorCardId: otherCardId,
    });
    expect(ports.connections.read()).toMatchObject({
      currentCardId,
      layoutKey: 'layout-a',
    });
    expect(createNotesViewStatePorts(otherCardId).body.read()).toBeNull();
  });
});

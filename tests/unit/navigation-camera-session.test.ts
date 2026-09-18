import { describe, expect, it } from 'vitest';
import { createNotesCameraSession } from '@/lib/application/navigation-camera-session';
import type { NotesNavigationSnapshot } from '@/lib/application/navigation';
import { fixtureCardId } from '@/tests/fixtures/ids';

describe('navigation camera session', () => {
  const cardA = fixtureCardId('camera-session-a');
  const cardB = fixtureCardId('camera-session-b');

  function fixture() {
    let navigation: NotesNavigationSnapshot = {
      location: { kind: 'connections', cardId: cardA },
      entryId: 1,
      activationId: 1,
      cause: 'initial',
      pending: false,
    };
    const session = createNotesCameraSession(() => navigation);
    const bind = () => {
      if (navigation.location.kind !== 'connections') {
        throw new Error('Camera fixture requires a connections location');
      }
      return session.bind({
        entryId: navigation.entryId,
        activationId: navigation.activationId,
        currentCardId: navigation.location.cardId,
        cause: navigation.cause,
      });
    };
    return {
      session,
      bind,
      move: (next: NotesNavigationSnapshot) => {
        navigation = next;
      },
    };
  }

  it('restores an exact traversed entry and a same-card auxiliary tab snapshot', () => {
    const test = fixture();
    const first = test.bind();
    expect(first.read('layout-a')).toBeNull();
    first.write({
      currentCardId: cardA,
      layoutKey: 'layout-a',
      scale: 1.4,
      centerWorld: { x: 80, y: -35 },
    });

    test.move({
      location: { kind: 'connections', cardId: cardA },
      entryId: 2,
      activationId: 2,
      cause: 'tab',
      pending: false,
    });
    const second = test.bind();
    expect(second.read('layout-a')).toMatchObject({
      currentCardId: cardA,
      scale: 1.4,
      centerWorld: { x: 80, y: -35 },
    });
    second.write({
      currentCardId: cardA,
      layoutKey: 'layout-a',
      scale: 0.8,
      centerWorld: { x: -120, y: 45 },
    });

    test.move({
      location: { kind: 'connections', cardId: cardA },
      entryId: 1,
      activationId: 3,
      cause: 'traverse',
      pending: false,
    });
    expect(test.bind().read('layout-a')).toMatchObject({
      scale: 1.4,
      centerWorld: { x: 80, y: -35 },
    });

    test.move({
      location: { kind: 'connections', cardId: cardA },
      entryId: 2,
      activationId: 4,
      cause: 'traverse',
      pending: false,
    });
    expect(test.bind().read('layout-a')).toMatchObject({
      scale: 0.8,
      centerWorld: { x: -120, y: 45 },
    });
  });

  it('rejects stale bindings and snapshots from an obsolete ready layout', () => {
    const test = fixture();
    const stale = test.bind();
    stale.read('layout-a');
    stale.write({
      currentCardId: cardA,
      layoutKey: 'layout-a',
      scale: 1.2,
      centerWorld: { x: 10, y: 20 },
    });

    test.move({
      location: { kind: 'connections', cardId: cardA },
      entryId: 2,
      activationId: 2,
      cause: 'tab',
      pending: false,
    });
    const current = test.bind();
    expect(current.read('layout-b')).toBeNull();
    stale.write({
      currentCardId: cardA,
      layoutKey: 'layout-a',
      scale: 2,
      centerWorld: { x: 999, y: 999 },
    });

    test.move({
      location: { kind: 'connections', cardId: cardA },
      entryId: 1,
      activationId: 3,
      cause: 'traverse',
      pending: false,
    });
    expect(test.bind().read('layout-b')).toBeNull();
  });

  it('synchronously discards pruned entries and invalidates replacement across cards', () => {
    const test = fixture();
    const first = test.bind();
    first.read('layout-a');
    first.write({
      currentCardId: cardA,
      layoutKey: 'layout-a',
      scale: 1.1,
      centerWorld: { x: 5, y: 6 },
    });
    test.session.discardEntries([1]);

    test.move({
      location: { kind: 'connections', cardId: cardA },
      entryId: 1,
      activationId: 2,
      cause: 'traverse',
      pending: false,
    });
    expect(test.bind().read('layout-a')).toBeNull();

    test.session.replaceEntry(
      1,
      { kind: 'connections', cardId: cardA },
      { kind: 'connections', cardId: cardB },
    );
    test.move({
      location: { kind: 'connections', cardId: cardB },
      entryId: 1,
      activationId: 3,
      cause: 'tab',
      pending: false,
    });
    expect(test.bind().read('layout-a')).toBeNull();
  });
});

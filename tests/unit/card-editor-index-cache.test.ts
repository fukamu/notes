import { describe, expect, it } from 'vitest';
import { createCardEditorIndexCache } from '@/lib/client/card-editor-index-cache';
import type { CardRecord } from '@/lib/domain/types';
import { fixtureCardId } from '@/tests/fixtures/ids';

function card(label: string, displayValue: number): CardRecord {
  return {
    id: fixtureCardId(label),
    displayId: { kind: 'official', value: displayValue },
    title: label,
    body: [],
    createdAt: displayValue,
    updatedAt: displayValue,
    localRevision: 1,
    serverRevision: 1,
  };
}

describe('card editor index cache', () => {
  it('reuses body-only edits, rebuilds metadata, and drops state on clear', () => {
    const current = card('cache-current', 1);
    const candidate = card('cache-candidate', 2);
    const cache = createCardEditorIndexCache();
    const initial = cache.select([current, candidate], current.id);
    const bodyEdited = cache.select(
      [
        current,
        {
          ...candidate,
          body: [{ type: 'text', text: 'body only' }],
          updatedAt: 3,
          localRevision: 2,
        },
      ],
      current.id,
    );
    const renamed = cache.select(
      [current, { ...candidate, title: 'renamed' }],
      current.id,
    );

    expect(bodyEdited).toBe(initial);
    expect(renamed).not.toBe(initial);

    cache.clear();
    expect(cache.select([current, candidate], current.id)).not.toBe(initial);
  });
});

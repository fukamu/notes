import { describe, expect, it } from 'vitest';
import {
  editorDocumentToSegments,
  segmentsToEditorDocument,
} from '@/lib/editor/body-document';
import { isUuidV7 } from '@/lib/domain/id';
import {
  compatibilityIds,
  createCompatibilityFixture,
} from '@/tests/fixtures/compatibility';
import {
  decodeStoredCards,
  decodeStoredConflicts,
  decodeStoredMeta,
  decodeStoredMutations,
  encodeStoredCard,
  encodeStoredConflict,
  encodeStoredMeta,
  encodeStoredMutation,
} from '@/lib/storage/records';

describe('synthetic compatibility fixture', () => {
  it('uses fixed UUIDv7 identifiers and the current serialization shapes', () => {
    const fixture = createCompatibilityFixture();
    for (const id of Object.values(compatibilityIds)) {
      expect(isUuidV7(id)).toBe(true);
    }
    expect(
      editorDocumentToSegments(
        segmentsToEditorDocument(fixture.cards[0]?.body ?? []),
      ),
    ).toEqual(fixture.cards[0]?.body);
    expect(JSON.parse(JSON.stringify(fixture.request))).toEqual(
      fixture.request,
    );
    expect(JSON.parse(JSON.stringify(fixture.response))).toEqual(
      fixture.response,
    );
    expect(decodeStoredCards(fixture.cards.map(encodeStoredCard))).toEqual(
      fixture.cards,
    );
    expect(
      decodeStoredMutations([encodeStoredMutation(fixture.mutation)]),
    ).toEqual([fixture.mutation]);
    expect(
      decodeStoredConflicts([encodeStoredConflict(fixture.conflict)]),
    ).toEqual([fixture.conflict]);
    expect(decodeStoredMeta(encodeStoredMeta(compatibilityIds.device))).toEqual(
      { key: 'deviceId', value: compatibilityIds.device },
    );
  });
});

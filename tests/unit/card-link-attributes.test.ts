import { describe, expect, it } from 'vitest';
import { cardLinkTargetId } from '@/lib/editor/card-link-attributes';
import { compatibilityIds } from '@/tests/fixtures/compatibility';

describe('Tiptap card-link attribute boundary', () => {
  it('accepts only a valid UUIDv7 targetCardId', () => {
    expect(cardLinkTargetId({ targetCardId: compatibilityIds.cardA })).toBe(
      compatibilityIds.cardA,
    );
  });

  it.each([
    null,
    undefined,
    'not-an-object',
    {},
    { targetCardId: null },
    { targetCardId: 7 },
    { targetCardId: 'not-a-uuid' },
    { targetCardId: '01991f20-61d2-4000-8000-000000000001' },
  ])('rejects malformed third-party attributes: %j', (attributes) => {
    expect(cardLinkTargetId(attributes)).toBeUndefined();
  });
});

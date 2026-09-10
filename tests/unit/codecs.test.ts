import { describe, expect, it } from 'vitest';
import { BoundaryDecodeError } from '@/lib/codec/core';
import {
  bodyDecoder,
  cardRecordDecoder,
  pendingMutationDecoder,
  positiveSafeIntegerDecoder,
} from '@/lib/domain/types';
import {
  cardIdDecoder,
  mutationIdDecoder,
  parseMutationId,
} from '@/lib/domain/id';
import {
  decodeSyncRequest,
  decodeSyncResponse,
  encodeSyncRequest,
} from '@/lib/sync/protocol';
import {
  compatibilityIds,
  createCompatibilityFixture,
} from '@/tests/fixtures/compatibility';

function expectFailure(
  decoder: { decode: (input: unknown) => { ok: boolean } },
  input: unknown,
) {
  expect(decoder.decode(input).ok).toBe(false);
}

describe('shared runtime codecs', () => {
  it('decodes the compatibility fixture and preserves wire meaning', () => {
    const fixture = createCompatibilityFixture();
    expect(cardRecordDecoder.decode(fixture.cards[0]).ok).toBe(true);
    expect(pendingMutationDecoder.decode(fixture.mutation).ok).toBe(true);
    expect(decodeSyncRequest(encodeSyncRequest(fixture.request))).toEqual(
      fixture.request,
    );
    expect(decodeSyncResponse(fixture.response, [fixture.mutation])).toEqual(
      fixture.response,
    );
  });

  it('rejects scalar/object mismatches, missing fields, and unknown fields', () => {
    for (const value of [null, 1, 'body', {}])
      expectFailure(bodyDecoder, value);
    const fixture = createCompatibilityFixture();
    const { title: _title, ...missingTitle } = fixture.cards[0] ?? {};
    expectFailure(cardRecordDecoder, missingTitle);
    expectFailure(cardRecordDecoder, {
      ...fixture.cards[0],
      unexpected: true,
    });
  });

  it('rejects invalid UUID versions and malformed body variants', () => {
    expectFailure(cardIdDecoder, '01991f20-61d2-4000-8000-000000000001');
    expectFailure(mutationIdDecoder, 'not-a-uuid');
    expectFailure(bodyDecoder, [{ type: 'unknown' }]);
    expectFailure(bodyDecoder, [{ type: 'link', targetCardId: 'broken' }]);
    expectFailure(bodyDecoder, [{ type: 'text', text: 7 }]);
  });

  it('rejects invalid integers and configured size limits', () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectFailure(positiveSafeIntegerDecoder, value);
    }
    expectFailure(positiveSafeIntegerDecoder, Number.MAX_SAFE_INTEGER + 1);
    expectFailure(bodyDecoder, [{ type: 'text', text: 'x'.repeat(100_001) }]);
  });

  it('makes mutation kind field combinations valid only as a discriminated union', () => {
    const fixture = createCompatibilityFixture();
    expectFailure(pendingMutationDecoder, {
      ...fixture.mutation,
      kind: 'upsert',
      conflictIds: [compatibilityIds.conflict],
    });
    expectFailure(pendingMutationDecoder, {
      ...fixture.mutation,
      kind: 'resolve',
      conflictIds: [],
    });
    expectFailure(pendingMutationDecoder, {
      ...fixture.mutation,
      kind: 'resolve',
      conflictIds: [compatibilityIds.conflict, compatibilityIds.conflict],
    });
  });

  it('reports field paths without embedding the raw payload', () => {
    const secret = 'private-payload-value';
    const result = cardRecordDecoder.decode({ title: secret });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const error = new BoundaryDecodeError('CardRecord', result.issues);
    expect(error.issues.some((issue) => issue.path.includes('id'))).toBe(true);
    expect(error.message).not.toContain(secret);
  });
});

describe('sync cross-field invariants', () => {
  it('rejects duplicate cards, display IDs, conflicts, and acknowledgements', () => {
    const fixture = createCompatibilityFixture();
    const duplicateCard = {
      ...fixture.response,
      cards: [fixture.response.cards[0], fixture.response.cards[0]],
    };
    expect(() => decodeSyncResponse(duplicateCard, [fixture.mutation])).toThrow(
      BoundaryDecodeError,
    );

    const duplicateDisplayId = {
      ...fixture.response,
      cards: fixture.response.cards.map((card) => ({
        ...card,
        officialDisplayId: 1,
      })),
    };
    expect(() =>
      decodeSyncResponse(duplicateDisplayId, [fixture.mutation]),
    ).toThrow(BoundaryDecodeError);

    const duplicateConflict = {
      ...fixture.response,
      conflicts: [fixture.conflict, fixture.conflict],
    };
    expect(() =>
      decodeSyncResponse(duplicateConflict, [fixture.mutation]),
    ).toThrow(BoundaryDecodeError);

    const duplicateAck = {
      ...fixture.response,
      acknowledgedMutationIds: [
        compatibilityIds.mutation,
        compatibilityIds.mutation,
      ],
    };
    expect(() => decodeSyncResponse(duplicateAck, [fixture.mutation])).toThrow(
      BoundaryDecodeError,
    );
  });

  it('rejects acknowledgements that were not sent and broken references', () => {
    const fixture = createCompatibilityFixture();
    const unsent = parseMutationId('01991f20-61d2-7000-8000-000000000099');
    expect(() =>
      decodeSyncResponse(
        { ...fixture.response, acknowledgedMutationIds: [unsent] },
        [fixture.mutation],
      ),
    ).toThrow(BoundaryDecodeError);

    expect(() =>
      decodeSyncResponse(
        { ...fixture.response, cards: [fixture.response.cards[0]] },
        [fixture.mutation],
      ),
    ).toThrow(BoundaryDecodeError);
  });

  it('rejects duplicate mutation IDs in a request', () => {
    const fixture = createCompatibilityFixture();
    expect(() =>
      decodeSyncRequest({
        deviceId: compatibilityIds.device,
        mutations: [fixture.mutation, fixture.mutation],
      }),
    ).toThrow(BoundaryDecodeError);
  });
});

import { describe, expect, it } from 'vitest';
import { BoundaryDecodeError } from '@/lib/codec/core';
import { parseDeviceId } from '@/lib/domain/id';
import {
  authorizeSyncV2Cursor,
  decodeSyncV2CursorClaims,
  SYNC_V2_CURSOR_VERSION,
} from '@/lib/sync/v2-cursor';
import {
  decodeSyncV2Request,
  decodeSyncV2Response,
  encodeSyncV2Request,
  encodeSyncV2Response,
  parseSyncV2Cursor,
  SYNC_V2_VERSION,
} from '@/lib/sync/v2-protocol';
import {
  compatibilityIds,
  createCompatibilityFixture,
} from '@/tests/fixtures/compatibility';
import { vaultContentContext } from '@/tests/fixtures/vault-content';

const firstCursor = parseSyncV2Cursor(
  'sync.v2.page.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
);
const finalCursor = parseSyncV2Cursor(
  'sync.v2.page.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
);

function responseWire() {
  const fixture = createCompatibilityFixture();
  const [card] = fixture.response.cards;
  if (card === undefined) throw new Error('missing compatibility server card');
  return {
    version: SYNC_V2_VERSION,
    highWatermark: 4,
    changes: [
      { kind: 'card-upsert', sequence: 1, card },
      {
        kind: 'conflict-upsert',
        sequence: 2,
        conflict: fixture.conflict,
      },
      {
        kind: 'card-tombstone',
        sequence: 3,
        cardId: compatibilityIds.cardA,
        revision: 3,
        deletedAt: 1_789_000_000_400,
      },
      {
        kind: 'conflict-tombstone',
        sequence: 4,
        conflictId: compatibilityIds.conflict,
        cardId: compatibilityIds.cardA,
        deletedAt: 1_789_000_000_401,
      },
    ],
    receipts: [
      {
        mutationId: compatibilityIds.mutation,
        cardId: compatibilityIds.cardA,
        appliedRevision: 2,
      },
    ],
    page: { kind: 'complete', nextCursor: finalCursor },
  };
}

describe('sync v2 wire codecs', () => {
  it('round-trips the versioned request and every response change variant', () => {
    const fixture = createCompatibilityFixture();
    const requestWire = encodeSyncV2Request({
      deviceId: compatibilityIds.device,
      cursor: firstCursor,
      mutations: [fixture.mutation],
    });
    const decodedRequest = decodeSyncV2Request(requestWire);

    expect(decodedRequest).toEqual({
      version: SYNC_V2_VERSION,
      deviceId: compatibilityIds.device,
      cursor: firstCursor,
      mutations: [fixture.mutation],
    });

    const decodedResponse = decodeSyncV2Response(responseWire(), [
      fixture.mutation,
    ]);
    expect(
      decodeSyncV2Response(encodeSyncV2Response(decodedResponse), [
        fixture.mutation,
      ]),
    ).toEqual(decodedResponse);
    expect(decodedResponse.changes.map((change) => change.kind)).toEqual([
      'card-upsert',
      'conflict-upsert',
      'card-tombstone',
      'conflict-tombstone',
    ]);
  });

  it.each([
    {
      name: 'wrong version',
      mutate: (wire: ReturnType<typeof responseWire>) => ({
        ...wire,
        version: 'sync/v1',
      }),
    },
    {
      name: 'out-of-order sequence',
      mutate: (wire: ReturnType<typeof responseWire>) => ({
        ...wire,
        changes: wire.changes.map((change, index) =>
          index === 1 ? { ...change, sequence: 1 } : change,
        ),
      }),
    },
    {
      name: 'sequence beyond high watermark',
      mutate: (wire: ReturnType<typeof responseWire>) => ({
        ...wire,
        highWatermark: 3,
      }),
    },
    {
      name: 'tenant field supplied by the wire',
      mutate: (wire: ReturnType<typeof responseWire>) => ({
        ...wire,
        vaultId: vaultContentContext('a').vaultId,
      }),
    },
  ])('rejects $name', ({ mutate }) => {
    const fixture = createCompatibilityFixture();
    expect(() =>
      decodeSyncV2Response(mutate(responseWire()), [fixture.mutation]),
    ).toThrow(BoundaryDecodeError);
  });

  it('rejects unsent or card-mismatched receipts', () => {
    const fixture = createCompatibilityFixture();
    expect(() => decodeSyncV2Response(responseWire(), [])).toThrow(
      BoundaryDecodeError,
    );
    expect(() =>
      decodeSyncV2Response(
        {
          ...responseWire(),
          receipts: [
            {
              mutationId: compatibilityIds.mutation,
              cardId: compatibilityIds.cardB,
              appliedRevision: 2,
            },
          ],
        },
        [fixture.mutation],
      ),
    ).toThrow(BoundaryDecodeError);
  });

  it('rejects request tenant fields and non-opaque cursors', () => {
    const fixture = createCompatibilityFixture();
    expect(() =>
      decodeSyncV2Request({
        ...encodeSyncV2Request({
          deviceId: compatibilityIds.device,
          cursor: null,
          mutations: [fixture.mutation],
        }),
        vaultId: vaultContentContext('a').vaultId,
      }),
    ).toThrow(BoundaryDecodeError);
    expect(() => parseSyncV2Cursor('short')).toThrow(BoundaryDecodeError);
  });

  it('rejects revisions above the Sync v2 server maximum before transmission', () => {
    const fixture = createCompatibilityFixture();
    const mutation = {
      ...fixture.mutation,
      baseServerRevision: 2_147_483_648,
    };
    const wire = {
      version: SYNC_V2_VERSION,
      deviceId: compatibilityIds.device,
      cursor: null,
      mutations: [mutation],
    };

    expect(() => decodeSyncV2Request(wire)).toThrow(BoundaryDecodeError);
    expect(() =>
      encodeSyncV2Request({
        deviceId: compatibilityIds.device,
        cursor: null,
        mutations: [mutation],
      }),
    ).toThrow(BoundaryDecodeError);
  });

  it('rejects every response revision above the Sync v2 server maximum', () => {
    const fixture = createCompatibilityFixture();
    const [card] = fixture.response.cards;
    if (card === undefined)
      throw new Error('missing compatibility server card');
    const overflow = 2_147_483_648;
    const base = responseWire();
    const cases = [
      {
        name: 'card upsert',
        wire: {
          ...base,
          highWatermark: 1,
          changes: [
            {
              kind: 'card-upsert',
              sequence: 1,
              card: { ...card, revision: overflow },
            },
          ],
          receipts: [],
        },
      },
      {
        name: 'conflict upsert',
        wire: {
          ...base,
          highWatermark: 1,
          changes: [
            {
              kind: 'conflict-upsert',
              sequence: 1,
              conflict: { ...fixture.conflict, serverRevision: overflow },
            },
          ],
          receipts: [],
        },
      },
      {
        name: 'card tombstone',
        wire: {
          ...base,
          highWatermark: 1,
          changes: [
            {
              kind: 'card-tombstone',
              sequence: 1,
              cardId: compatibilityIds.cardA,
              revision: overflow,
              deletedAt: 1_789_000_000_400,
            },
          ],
          receipts: [],
        },
      },
      {
        name: 'mutation receipt',
        wire: {
          ...base,
          highWatermark: 0,
          changes: [],
          receipts: [
            {
              mutationId: compatibilityIds.mutation,
              cardId: compatibilityIds.cardA,
              appliedRevision: overflow,
            },
          ],
        },
      },
    ];

    for (const testCase of cases) {
      expect(
        () => decodeSyncV2Response(testCase.wire, [fixture.mutation]),
        testCase.name,
      ).toThrow(BoundaryDecodeError);
    }
  });
});

describe('authenticated cursor claims', () => {
  it('authorizes only the session Vault and requesting device', () => {
    const context = vaultContentContext('a');
    const claims = decodeSyncV2CursorClaims({
      version: SYNC_V2_CURSOR_VERSION,
      vaultId: context.vaultId,
      deviceId: compatibilityIds.device,
      afterSequence: 2,
      highWatermark: 4,
    });
    expect(
      authorizeSyncV2Cursor(context, compatibilityIds.device, claims),
    ).toEqual({ kind: 'accepted', afterSequence: 2, highWatermark: 4 });
    expect(
      authorizeSyncV2Cursor(
        vaultContentContext('b'),
        compatibilityIds.device,
        claims,
      ),
    ).toEqual({ kind: 'rejected', reason: 'vault-mismatch' });
    expect(
      authorizeSyncV2Cursor(
        context,
        parseDeviceId('01991f20-61d2-7000-8000-000000000099'),
        claims,
      ),
    ).toEqual({ kind: 'rejected', reason: 'device-mismatch' });
  });

  it('rejects cursor claims that move beyond their fixed snapshot', () => {
    const context = vaultContentContext('a');
    expect(() =>
      decodeSyncV2CursorClaims({
        version: SYNC_V2_CURSOR_VERSION,
        vaultId: context.vaultId,
        deviceId: compatibilityIds.device,
        afterSequence: 5,
        highWatermark: 4,
      }),
    ).toThrow(BoundaryDecodeError);
  });
});

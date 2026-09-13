import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_NOTES_SCOPE } from '@/lib/application/notes-runtime';
import { browserClock } from '@/lib/client/browser-clock';
import { browserConnectivity } from '@/lib/client/browser-connectivity';
import {
  createV1SyncTransport,
  type SyncFetch,
} from '@/lib/client/http-sync-transport';
import {
  editorDocumentToSegments,
  segmentsToEditorDocument,
} from '@/lib/editor/body-document';
import { isUuidV7 } from '@/lib/domain/id';
import type { CardRecord } from '@/lib/domain/types';
import {
  compatibilityIds,
  createCompatibilityFixture,
} from '@/tests/fixtures/compatibility';
import { encodeSyncRequest } from '@/lib/sync/protocol';
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
import { invariant } from '@/lib/shared/invariant';

type HasVaultId = 'vaultId' extends keyof CardRecord ? true : false;
type HasAccountId = 'accountId' extends keyof CardRecord ? true : false;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('synthetic compatibility fixture', () => {
  it('keeps the explicit legacy scope out of card records', () => {
    expect(LEGACY_NOTES_SCOPE).toEqual({
      kind: 'legacy',
      databaseName: 'fukamu-notes',
      syncEndpoint: '/api/sync',
    });

    const cardTenantFields: [HasVaultId, HasAccountId] = [false, false];
    expect(cardTenantFields).toEqual([false, false]);
  });

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
    expect(JSON.stringify(encodeSyncRequest(fixture.request))).toBe(
      '{"deviceId":"01991f20-61d2-7000-8000-000000000004","mutations":[{"mutationId":"01991f20-61d2-7000-8000-000000000005","cardId":"01991f20-61d2-7000-8000-000000000001","baseServerRevision":1,"title":"固定カードA","body":[{"type":"text","text":"固定本文から "},{"type":"link","targetCardId":"01991f20-61d2-7000-8000-000000000002"},{"type":"text","text":" へつなぐ。"}],"createdAt":1789000000000,"updatedAt":1789000000100,"kind":"upsert","conflictIds":[]}]}',
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

  it('preserves the v1 endpoint and exact encoded request body', async () => {
    const fixture = createCompatibilityFixture();
    const wire = encodeSyncRequest(fixture.request);
    let captured:
      | { input: RequestInfo | URL; init: RequestInit | undefined }
      | undefined;
    const fetchRequest: SyncFetch = async (input, init) => {
      captured = { input, init };
      return new Response(JSON.stringify(fixture.response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const result = await createV1SyncTransport(
      LEGACY_NOTES_SCOPE,
      fetchRequest,
    ).send(wire);

    invariant(captured, 'Sync transport did not call fetch');
    expect(captured.input).toBe('/api/sync');
    expect(captured.init).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wire),
    });
    expect(result).toEqual(fixture.response);
  });

  it('rejects non-success HTTP responses before storage sees a body', async () => {
    const fixture = createCompatibilityFixture();
    const fetchRequest: SyncFetch = async () =>
      new Response(null, { status: 503 });
    const transport = createV1SyncTransport(LEGACY_NOTES_SCOPE, fetchRequest);

    await expect(
      transport.send(encodeSyncRequest(fixture.request)),
    ).rejects.toThrow('sync returned 503');
  });

  it('keeps clock and connectivity effects behind browser adapters', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_789_000_000_500);
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal('navigator', { onLine: false });
    vi.stubGlobal('window', { addEventListener, removeEventListener });
    const onOnline = vi.fn();
    const onOffline = vi.fn();

    const unsubscribe = browserConnectivity.subscribe({
      onOnline,
      onOffline,
    });

    expect(browserClock.now()).toBe(1_789_000_000_500);
    expect(browserConnectivity.isOnline()).toBe(false);
    expect(addEventListener).toHaveBeenCalledWith('online', onOnline);
    expect(addEventListener).toHaveBeenCalledWith('offline', onOffline);
    unsubscribe();
    expect(removeEventListener).toHaveBeenCalledWith('online', onOnline);
    expect(removeEventListener).toHaveBeenCalledWith('offline', onOffline);
  });
});

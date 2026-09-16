import { describe, expect, it } from 'vitest';
import type { VaultNotesScope } from '@/lib/application/notes-access';
import {
  createFullNetworkMapSession,
  sameFullNetworkMapSessionScope,
} from '@/lib/application/full-network-map-session';
import type { FullNetworkMapSnapshot } from '@/lib/graph/full-network-camera';
import { fixtureCardId } from '@/tests/fixtures/ids';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const scope: VaultNotesScope = {
  kind: 'vault',
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};

const snapshot: FullNetworkMapSnapshot = {
  version: 1,
  topologyKey: 'topology',
  layoutKey: 'layout',
  camera: {
    offsetX: 1,
    offsetY: 2,
    scale: 3,
    viewportWidth: 800,
    viewportHeight: 600,
  },
  selectedCardId: fixtureCardId('session-selection'),
  anchor: null,
};

describe('scope-bound full-network map session', () => {
  it('keeps camera state only in the owning runtime session and clears it', () => {
    const first = createFullNetworkMapSession(scope);
    const second = createFullNetworkMapSession(scope);
    first.write(snapshot);
    expect(first.read()).toEqual(snapshot);
    expect(second.read()).toBeNull();
    first.clear();
    expect(first.read()).toBeNull();
  });

  it('rejects every Account/Vault/session/epoch scope difference', () => {
    expect(sameFullNetworkMapSessionScope(scope, scope)).toBe(true);
    for (const other of [
      { ...scope, accountId: sessionFixtureIds.otherAccountId },
      { ...scope, vaultId: sessionFixtureIds.otherVaultId },
      { ...scope, sessionId: sessionFixtureIds.nextSessionId },
      { ...scope, sessionEpoch: sessionFixtureIds.nextEpoch },
    ]) {
      expect(sameFullNetworkMapSessionScope(scope, other)).toBe(false);
    }
  });
});

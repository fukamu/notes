import type { D1DatabaseBinding } from '../../db/d1-types';
import type { SyncV2CursorAuthenticator } from '../../lib/sync/v2-cursor';
import { createSyncV2HttpHandler } from '../../app/api/v2/sync/handler';
import type {
  OpaqueObjectKeyGeneratorPort,
  PrivateObjectStoragePort,
} from '../encrypted-object/ports';
import type { EnvelopeEncryptionService } from '../crypto/envelope-service';
import type { SessionTokenHashPort } from '../control-plane/session-resolver';
import { createControlPlaneSessionResolver } from '../control-plane/session-resolver';
import { D1IdentityVaultControlPlane } from '../control-plane/d1-adapter';
import { createD1BillingApi } from '../billing/d1-adapter';
import { createD1EntitlementPort } from '../entitlement/d1-adapter';
import { fukamuOfflineLeasePolicy } from '../entitlement/public';
import { D1VaultQuotaLedgerDirectory } from '../quota/d1-adapter';
import { D1VaultContentDirectory } from '../vault-content/d1-adapter';
import { D1SyncV2JournalDirectory } from '../vault-content/sync-v2-d1-adapter';
import { D1EncryptedObjectMetadataDirectory } from '../encrypted-object/d1-adapter';
import { EncryptedSyncV2ContentDirectory } from '../sync-v2/encrypted-content-adapter';
import { createSyncV2Application } from '../sync-v2/service';
import type {
  SyncV2Application,
  SyncV2ClockPort,
  SyncV2KeyringPort,
  SyncV2MutationFingerprintPort,
} from '../sync-v2/public';

export type D1SyncV2CompositionInput = {
  readonly database: D1DatabaseBinding;
  readonly expectedOrigin: unknown;
  readonly clock: SyncV2ClockPort;
  readonly sessionTokenHashes: SessionTokenHashPort;
  readonly cursors: SyncV2CursorAuthenticator;
  readonly fingerprints: SyncV2MutationFingerprintPort;
  readonly objects: PrivateObjectStoragePort;
  readonly objectKeys: OpaqueObjectKeyGeneratorPort;
  readonly encryption: EnvelopeEncryptionService;
  readonly keyrings: SyncV2KeyringPort;
  readonly quotaReservationReconcileDelayMs: number;
};

export type D1SyncV2Composition = {
  readonly handler: ReturnType<typeof createSyncV2HttpHandler>;
  readonly application: SyncV2Application;
};

export function createD1SyncV2Composition(
  input: D1SyncV2CompositionInput,
): D1SyncV2Composition {
  const controlPlane = new D1IdentityVaultControlPlane(input.database);
  const vaultContent = new D1VaultContentDirectory(
    input.database,
    controlPlane,
  );
  const billing = createD1BillingApi(input.database, controlPlane);
  const entitlement = createD1EntitlementPort({
    database: input.database,
    controlPlane,
    billing,
    offlineLeasePolicy: fukamuOfflineLeasePolicy,
  });
  const journals = new D1SyncV2JournalDirectory(input.database, vaultContent);
  const metadata = new D1EncryptedObjectMetadataDirectory(
    input.database,
    vaultContent,
  );
  const contents = new EncryptedSyncV2ContentDirectory(
    metadata,
    input.objects,
    input.objectKeys,
    input.encryption,
    input.keyrings,
  );
  const quotas = new D1VaultQuotaLedgerDirectory(input.database);
  const application = createSyncV2Application({
    journals,
    contents,
    cursors: input.cursors,
    fingerprints: input.fingerprints,
    quotas,
    quotaPolicy: {
      reservationReconcileDelayMs: input.quotaReservationReconcileDelayMs,
    },
  });
  return {
    application,
    handler: createSyncV2HttpHandler({
      expectedOrigin: input.expectedOrigin,
      clock: input.clock,
      sessions: createControlPlaneSessionResolver({
        controlPlane,
        hashes: input.sessionTokenHashes,
      }),
      entitlement,
      application,
    }),
  };
}

export function createD1SyncV2HttpHandler(input: D1SyncV2CompositionInput) {
  return createD1SyncV2Composition(input).handler;
}

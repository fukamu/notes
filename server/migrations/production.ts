import { identityVaultControlPlaneMigration } from '../control-plane/migration';
import { envelopeEncryptionMetadataMigration } from '../crypto/migration';
import { vaultContentMigration } from '../vault-content/migration';

export const productionMigrationManifest = [
  identityVaultControlPlaneMigration,
  vaultContentMigration,
  envelopeEncryptionMetadataMigration,
] as const;

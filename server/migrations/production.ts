import { billingSubscriptionMigration } from '../billing/migration';
import { identityVaultControlPlaneMigration } from '../control-plane/migration';
import { envelopeEncryptionMetadataMigration } from '../crypto/migration';
import { encryptedObjectRepositoryMigration } from '../encrypted-object/migration';
import { vaultContentMigration } from '../vault-content/migration';

export const productionMigrationManifest = [
  identityVaultControlPlaneMigration,
  vaultContentMigration,
  envelopeEncryptionMetadataMigration,
  encryptedObjectRepositoryMigration,
  billingSubscriptionMigration,
] as const;

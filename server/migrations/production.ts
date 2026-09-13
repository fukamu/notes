import { identityVaultControlPlaneMigration } from '../control-plane/migration';
import { vaultContentMigration } from '../vault-content/migration';

export const productionMigrationManifest = [
  identityVaultControlPlaneMigration,
  vaultContentMigration,
] as const;

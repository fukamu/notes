import { accountDeletionSagaMigration } from '../account-deletion/migration';
import { accountDeletionContinuationMigration } from '../account-deletion/continuation-migration';
import { billingSubscriptionMigration } from '../billing/migration';
import { identityVaultControlPlaneMigration } from '../control-plane/migration';
import { envelopeEncryptionMetadataMigration } from '../crypto/migration';
import { dekRotationMigration } from '../crypto/rotation-migration';
import { encryptedObjectRepositoryMigration } from '../encrypted-object/migration';
import { entitlementMigration } from '../entitlement/migration';
import { contractEvidenceMigration } from '../legal-checkout/migration';
import { productionLaunchGateMigration } from '../launch-gate/migration';
import { privacyRequestJournalMigration } from '../privacy-request/migration';
import { vaultQuotaLedgerMigration } from '../quota/migration';
import { vaultContentMigration } from '../vault-content/migration';
import { syncV2JournalMigration } from '../vault-content/sync-v2-migration';
import { termsConsentLedgerMigration } from '../terms-consent/migration';

export const productionMigrationManifest = [
  identityVaultControlPlaneMigration,
  vaultContentMigration,
  envelopeEncryptionMetadataMigration,
  encryptedObjectRepositoryMigration,
  billingSubscriptionMigration,
  entitlementMigration,
  syncV2JournalMigration,
  accountDeletionSagaMigration,
  accountDeletionContinuationMigration,
  dekRotationMigration,
  vaultQuotaLedgerMigration,
  contractEvidenceMigration,
  privacyRequestJournalMigration,
  termsConsentLedgerMigration,
  productionLaunchGateMigration,
] as const;

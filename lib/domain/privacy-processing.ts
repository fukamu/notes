export const privacyDataCategoryIds = [
  'account-identity',
  'authentication-security',
  'billing-contract',
  'vault-content',
  'device-offline-replica',
  'operational-audit',
] as const;

export type PrivacyDataCategoryId = (typeof privacyDataCategoryIds)[number];

export const privacyProcessingPurposeIds = [
  'identity-and-account',
  'security-and-abuse-prevention',
  'service-delivery-and-sync',
  'billing-and-entitlement',
  'support-and-legal-compliance',
  'deletion-and-recovery',
  'service-reliability',
] as const;

export type PrivacyProcessingPurposeId =
  (typeof privacyProcessingPurposeIds)[number];

export function isPrivacyDataCategoryId(
  input: unknown,
): input is PrivacyDataCategoryId {
  return privacyDataCategoryIds.some((candidate) => candidate === input);
}

export function isPrivacyProcessingPurposeId(
  input: unknown,
): input is PrivacyProcessingPurposeId {
  return privacyProcessingPurposeIds.some((candidate) => candidate === input);
}

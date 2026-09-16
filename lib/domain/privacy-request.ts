export const privacyRequestKinds = [
  'purpose-notification',
  'disclosure',
  'correction',
  'usage-suspension',
  'deletion',
  'third-party-provision-suspension',
] as const;

export type PrivacyRequestKind = (typeof privacyRequestKinds)[number];

export function isPrivacyRequestKind(
  input: unknown,
): input is PrivacyRequestKind {
  return privacyRequestKinds.some((candidate) => candidate === input);
}

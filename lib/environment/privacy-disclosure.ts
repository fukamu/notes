import {
  resolvePrivacyDisclosure,
  type PrivacyDisclosureResolution,
} from '@/lib/application/privacy-disclosure';

export class PrivacyDisclosureConfigurationError extends Error {
  readonly reason: Extract<
    PrivacyDisclosureResolution,
    { kind: 'blocked' }
  >['reason'];

  constructor(
    blocked: Extract<PrivacyDisclosureResolution, { kind: 'blocked' }>,
  ) {
    super(
      `Privacy disclosure configuration is blocked: ${blocked.reason} (${blocked.issues.join('; ')})`,
    );
    this.name = 'PrivacyDisclosureConfigurationError';
    this.reason = blocked.reason;
  }
}

export function privacyDisclosureForCurrentEnvironment() {
  const resolution = resolvePrivacyDisclosure(process.env);
  if (resolution.kind === 'blocked') {
    throw new PrivacyDisclosureConfigurationError(resolution);
  }
  return resolution;
}

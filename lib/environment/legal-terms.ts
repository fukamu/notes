import {
  resolveLegalTermsDisclosure,
  type LegalTermsResolution,
} from '@/lib/application/legal-terms';

export class LegalTermsConfigurationError extends Error {
  readonly reason: Extract<
    LegalTermsResolution,
    { readonly kind: 'blocked' }
  >['reason'];

  constructor(blocked: Extract<LegalTermsResolution, { kind: 'blocked' }>) {
    super(
      `Legal terms configuration is blocked: ${blocked.reason} (${blocked.issues.join('; ')})`,
    );
    this.name = 'LegalTermsConfigurationError';
    this.reason = blocked.reason;
  }
}

export function legalTermsForCurrentEnvironment() {
  const resolution = resolveLegalTermsDisclosure(process.env);
  if (resolution.kind === 'blocked') {
    throw new LegalTermsConfigurationError(resolution);
  }
  return resolution;
}

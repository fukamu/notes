import {
  resolveLegalCommerceDisclosure,
  type LegalCommerceResolution,
} from '@/lib/application/legal-commerce';
import { currentPublicBuildEnvironment } from './public-build';

export class LegalCommerceConfigurationError extends Error {
  readonly reason: Extract<
    LegalCommerceResolution,
    { kind: 'blocked' }
  >['reason'];

  constructor(blocked: Extract<LegalCommerceResolution, { kind: 'blocked' }>) {
    super(
      `Legal commerce configuration is blocked: ${blocked.reason} (${blocked.issues.join('; ')})`,
    );
    this.name = 'LegalCommerceConfigurationError';
    this.reason = blocked.reason;
  }
}

export function commercialDisclosureForCurrentEnvironment() {
  const resolution = resolveLegalCommerceDisclosure(
    currentPublicBuildEnvironment(),
  );
  if (resolution.kind === 'blocked') {
    throw new LegalCommerceConfigurationError(resolution);
  }
  return resolution;
}

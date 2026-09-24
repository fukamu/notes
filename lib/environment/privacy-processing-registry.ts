import {
  resolvePrivacyProcessingRegistry,
  type PrivacyProcessingRegistryResolution,
} from '@/lib/application/privacy-processing-registry';
import { currentPublicBuildEnvironment } from './public-build';

export class PrivacyProcessingRegistryConfigurationError extends Error {
  readonly reason: Extract<
    PrivacyProcessingRegistryResolution,
    { kind: 'blocked' }
  >['reason'];

  constructor(
    blocked: Extract<PrivacyProcessingRegistryResolution, { kind: 'blocked' }>,
  ) {
    super(
      `Privacy processing registry configuration is blocked: ${blocked.reason} (${blocked.issues.join('; ')})`,
    );
    this.name = 'PrivacyProcessingRegistryConfigurationError';
    this.reason = blocked.reason;
  }
}

export function privacyProcessingRegistryForCurrentEnvironment() {
  const resolution = resolvePrivacyProcessingRegistry(
    currentPublicBuildEnvironment(),
  );
  if (resolution.kind === 'blocked') {
    throw new PrivacyProcessingRegistryConfigurationError(resolution);
  }
  return resolution;
}

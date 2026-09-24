export type LaunchGateFacts = {
  readonly publicAccessEnabled: boolean;
  readonly userAllowed: boolean;
};

export type LaunchGateDecision = LaunchGateFacts & {
  readonly canAccess: boolean;
};

export function decideLaunchAccess(facts: LaunchGateFacts): LaunchGateDecision {
  return {
    ...facts,
    canAccess: facts.publicAccessEnabled || facts.userAllowed,
  };
}

export function launchGateIsEnforced(nodeEnvironment: unknown): boolean {
  // Unknown runtime values deliberately behave like production. This keeps a
  // missing or malformed build-time environment from opening the application.
  return nodeEnvironment !== 'development' && nodeEnvironment !== 'test';
}

export function parseLaunchUserId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim();
  if (
    candidate.length < 1 ||
    candidate.length > 256 ||
    candidate !== value ||
    Array.from(candidate).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    return undefined;
  }
  return candidate;
}

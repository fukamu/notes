import {
  arrayDecoder,
  booleanDecoder,
  decodeOrThrow,
  literalDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  unionDecoder,
  type Decoder,
} from '@/lib/codec/core';

export const serverLoadScenarios = [
  'cold-start',
  'normal-poll',
  'hot-vault-partition',
  'response-loss-retry',
] as const;

export type ServerLoadScenario = (typeof serverLoadScenarios)[number];

export type ServerLoadObservation = Readonly<{
  scenario: ServerLoadScenario;
  logicalRequests: number;
  httpAttempts: number;
  successfulResponses: number;
  unavailableResponses: number;
  maximumInFlight: number;
  handlerInstances: number;
  uniqueVaults: number;
  uniquePartitions: number;
  tenantViolations: number;
  applicationCalls: number;
  uniqueMutationCommits: number;
  mutationReplays: number;
  objectReads: number;
  objectWrites: number;
  kmsDecryptions: number;
  kmsEncryptions: number;
  durationMs: number;
  observedHeapDeltaBytes: number;
  observedRssDeltaBytes: number;
}>;

export type ServerLoadArtifact = Readonly<{
  schemaVersion: 1;
  issue: 216;
  branchPoint: string;
  generatedAt: string;
  safety: Readonly<{
    executionMode: 'local-fake';
    remoteTargetUsed: false;
    credentialUsed: false;
  }>;
  environment: Readonly<{
    node: string;
    platform: string;
    release: string;
    cpu: string;
    cpuCount: number;
    totalMemoryBytes: number;
  }>;
  methodology: Readonly<{
    command: string;
    timingPolicy: string;
    memoryPolicy: string;
    failureModel: string;
  }>;
  observations: readonly ServerLoadObservation[];
}>;

export type LocalServerLoadAuthorization =
  | { readonly kind: 'authorized'; readonly executionMode: 'local-fake' }
  | {
      readonly kind: 'rejected';
      readonly reasons: readonly (
        | 'unsupported-mode'
        | 'remote-target-present'
        | 'credential-present'
      )[];
    };

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

export function authorizeLocalServerLoad(input: {
  readonly mode: unknown;
  readonly targetUrl: unknown;
  readonly credential: unknown;
}): LocalServerLoadAuthorization {
  const reasons: Array<
    'unsupported-mode' | 'remote-target-present' | 'credential-present'
  > = [];
  if (present(input.mode) && input.mode !== 'local-fake') {
    reasons.push('unsupported-mode');
  }
  if (present(input.targetUrl)) reasons.push('remote-target-present');
  if (present(input.credential)) reasons.push('credential-present');
  return reasons.length === 0
    ? { kind: 'authorized', executionMode: 'local-fake' }
    : { kind: 'rejected', reasons };
}

export type ServerLoadEvaluation =
  | { readonly kind: 'accepted'; readonly scenario: ServerLoadScenario }
  | {
      readonly kind: 'rejected';
      readonly scenario: ServerLoadScenario;
      readonly violations: readonly string[];
    };

export function evaluateServerLoadObservation(
  observation: ServerLoadObservation,
): ServerLoadEvaluation {
  const violations: string[] = [];
  requireEqual(
    violations,
    'logicalRequests',
    observation.logicalRequests,
    1_000,
  );
  requireEqual(
    violations,
    'maximumInFlight',
    observation.maximumInFlight,
    1_000,
  );
  requireEqual(violations, 'tenantViolations', observation.tenantViolations, 0);

  switch (observation.scenario) {
    case 'cold-start':
      requireNoChangeSuccess(observation, violations);
      requireEqual(
        violations,
        'handlerInstances',
        observation.handlerInstances,
        1_000,
      );
      requireEqual(violations, 'uniqueVaults', observation.uniqueVaults, 1_000);
      break;
    case 'normal-poll':
      requireNoChangeSuccess(observation, violations);
      requireEqual(
        violations,
        'handlerInstances',
        observation.handlerInstances,
        1,
      );
      requireEqual(violations, 'uniqueVaults', observation.uniqueVaults, 1_000);
      requireEqual(
        violations,
        'uniquePartitions',
        observation.uniquePartitions,
        16,
      );
      break;
    case 'hot-vault-partition':
      requireNoChangeSuccess(observation, violations);
      requireEqual(
        violations,
        'handlerInstances',
        observation.handlerInstances,
        1,
      );
      requireEqual(violations, 'uniqueVaults', observation.uniqueVaults, 1);
      requireEqual(
        violations,
        'uniquePartitions',
        observation.uniquePartitions,
        1,
      );
      break;
    case 'response-loss-retry':
      requireEqual(violations, 'httpAttempts', observation.httpAttempts, 2_000);
      requireEqual(
        violations,
        'successfulResponses',
        observation.successfulResponses,
        1_000,
      );
      requireEqual(
        violations,
        'unavailableResponses',
        observation.unavailableResponses,
        1_000,
      );
      requireEqual(
        violations,
        'applicationCalls',
        observation.applicationCalls,
        2_000,
      );
      requireEqual(
        violations,
        'uniqueMutationCommits',
        observation.uniqueMutationCommits,
        1_000,
      );
      requireEqual(
        violations,
        'mutationReplays',
        observation.mutationReplays,
        1_000,
      );
      requireEqual(violations, 'objectReads', observation.objectReads, 0);
      requireEqual(violations, 'objectWrites', observation.objectWrites, 1_000);
      requireEqual(violations, 'kmsDecryptions', observation.kmsDecryptions, 0);
      requireEqual(
        violations,
        'kmsEncryptions',
        observation.kmsEncryptions,
        1_000,
      );
      break;
  }

  return violations.length === 0
    ? { kind: 'accepted', scenario: observation.scenario }
    : { kind: 'rejected', scenario: observation.scenario, violations };
}

function requireNoChangeSuccess(
  observation: ServerLoadObservation,
  violations: string[],
): void {
  requireEqual(violations, 'httpAttempts', observation.httpAttempts, 1_000);
  requireEqual(
    violations,
    'successfulResponses',
    observation.successfulResponses,
    1_000,
  );
  requireEqual(
    violations,
    'unavailableResponses',
    observation.unavailableResponses,
    0,
  );
  requireEqual(
    violations,
    'applicationCalls',
    observation.applicationCalls,
    1_000,
  );
  requireEqual(
    violations,
    'uniqueMutationCommits',
    observation.uniqueMutationCommits,
    0,
  );
  requireEqual(violations, 'mutationReplays', observation.mutationReplays, 0);
  requireEqual(violations, 'objectReads', observation.objectReads, 0);
  requireEqual(violations, 'objectWrites', observation.objectWrites, 0);
  requireEqual(violations, 'kmsDecryptions', observation.kmsDecryptions, 0);
  requireEqual(violations, 'kmsEncryptions', observation.kmsEncryptions, 0);
}

function requireEqual(
  violations: string[],
  field: string,
  actual: number,
  expected: number,
): void {
  if (actual !== expected) {
    violations.push(`${field}: expected ${expected}, observed ${actual}`);
  }
}

const scenarioDecoder = unionDecoder(
  literalDecoder('cold-start'),
  literalDecoder('normal-poll'),
  literalDecoder('hot-vault-partition'),
  literalDecoder('response-loss-retry'),
);
const countDecoder = safeIntegerDecoder({ minimum: 0 });
const durationDecoder = refineDecoder(
  {
    decode(input, path = []) {
      return typeof input === 'number' && Number.isFinite(input)
        ? { ok: true as const, value: input }
        : {
            ok: false as const,
            issues: [{ path, reason: 'expected a finite number' }],
          };
    },
  } satisfies Decoder<number>,
  (value) => value >= 0,
  'expected a non-negative duration',
);
const signedIntegerDecoder = {
  decode(input: unknown, path = []) {
    return typeof input === 'number' && Number.isSafeInteger(input)
      ? { ok: true as const, value: input }
      : {
          ok: false as const,
          issues: [{ path, reason: 'expected a finite safe integer' }],
        };
  },
} satisfies Decoder<number>;

const observationDecoder = objectDecoder({
  scenario: scenarioDecoder,
  logicalRequests: countDecoder,
  httpAttempts: countDecoder,
  successfulResponses: countDecoder,
  unavailableResponses: countDecoder,
  maximumInFlight: countDecoder,
  handlerInstances: countDecoder,
  uniqueVaults: countDecoder,
  uniquePartitions: countDecoder,
  tenantViolations: countDecoder,
  applicationCalls: countDecoder,
  uniqueMutationCommits: countDecoder,
  mutationReplays: countDecoder,
  objectReads: countDecoder,
  objectWrites: countDecoder,
  kmsDecryptions: countDecoder,
  kmsEncryptions: countDecoder,
  durationMs: durationDecoder,
  observedHeapDeltaBytes: signedIntegerDecoder,
  observedRssDeltaBytes: signedIntegerDecoder,
});

const falseDecoder = refineDecoder(
  booleanDecoder,
  (value) => value === false,
  'expected false',
);

const artifactDecoder = objectDecoder({
  schemaVersion: safeIntegerDecoder({ minimum: 1, maximum: 1 }),
  issue: safeIntegerDecoder({ minimum: 216, maximum: 216 }),
  branchPoint: stringDecoder({ minLength: 40, maxLength: 40 }),
  generatedAt: stringDecoder({ minLength: 20, maxLength: 40 }),
  safety: objectDecoder({
    executionMode: literalDecoder('local-fake'),
    remoteTargetUsed: falseDecoder,
    credentialUsed: falseDecoder,
  }),
  environment: objectDecoder({
    node: stringDecoder({ minLength: 1, maxLength: 100 }),
    platform: stringDecoder({ minLength: 1, maxLength: 100 }),
    release: stringDecoder({ minLength: 1, maxLength: 200 }),
    cpu: stringDecoder({ minLength: 1, maxLength: 500 }),
    cpuCount: countDecoder,
    totalMemoryBytes: countDecoder,
  }),
  methodology: objectDecoder({
    command: stringDecoder({ minLength: 1, maxLength: 200 }),
    timingPolicy: stringDecoder({ minLength: 1, maxLength: 1_000 }),
    memoryPolicy: stringDecoder({ minLength: 1, maxLength: 1_000 }),
    failureModel: stringDecoder({ minLength: 1, maxLength: 1_000 }),
  }),
  observations: arrayDecoder(observationDecoder, {
    minLength: serverLoadScenarios.length,
    maxLength: serverLoadScenarios.length,
    uniqueBy: (observation) => observation.scenario,
  }),
});

export function decodeServerLoadArtifact(input: unknown): ServerLoadArtifact {
  const decoded = decodeOrThrow(artifactDecoder, input, 'ServerLoadArtifact');
  return {
    ...decoded,
    schemaVersion: 1,
    issue: 216,
    safety: {
      executionMode: 'local-fake',
      remoteTargetUsed: false,
      credentialUsed: false,
    },
  };
}

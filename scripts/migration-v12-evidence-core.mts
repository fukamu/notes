import { createHash } from 'node:crypto';

export const V12_REFERENCE_REVISION =
  'f423da9932163980485ecc5bc2055b7c8c3b3d8b';
export const V12_RETIREMENT_REVISION =
  'e8936ab90768774371d84b4808c100d546649943';
export const V12_INTEGRATION_BRANCH_POINT =
  'fa33eb8536c309e350c2617642b82ae38a096aa7';
export const V12_RUNNER_VERSION = 'migration-v12-local-v1';

export const V12_SCALES = [100, 1_000, 10_000] as const;
export const V12_BROWSER_SCALES = [100, 10_000] as const;
export const V12_TARGETS = ['reference', 'go'] as const;
export const V12_LEGACY_OPERATIONS = [
  'cold-start',
  'cold-full-sync',
  'warm-full-sync',
  'single-mutation',
  'batch-500',
  'two-device-conflict',
] as const;
export const V12_SYNC_OPERATIONS = [
  'cold-full-sync',
  'warm-full-sync',
  'delta-1',
] as const;
export const V12_BROWSER_OPERATIONS = [
  'initial-ready-full-data',
  'save-ack',
] as const;
export const V12_REVIEWED_LEGACY_OPERATIONS = [
  'warm-full-sync',
  'single-mutation',
  'batch-500',
  'two-device-conflict',
] as const;
export const V12_SOURCE_PATHS = [
  'contracts/migration-v12-fixture.json',
  'scripts/migration-benchmark-core.mts',
  'scripts/migration-v12-evidence-core.mts',
  'scripts/migration-v12-reference-observer.mts',
  'scripts/migration-v12-legacy-collector.mts',
  'scripts/benchmark-migration-v12.mts',
  'backend/cmd/v12legacybenchmark/main.go',
  'backend/tests/integration/sync_v2_v12_performance_test.go',
  'backend/tests/integration/sync_v2_load_test.go',
  'backend/internal/adapters/postgres/database.go',
  'backend/internal/adapters/postgres/database_test.go',
  'backend/internal/adapters/postgres/legacy_sync.go',
  'backend/internal/adapters/postgres/quota.go',
  'backend/internal/adapters/postgres/sync_v2_journal.go',
  'backend/internal/adapters/postgres/transaction.go',
  'backend/internal/httpapi/handler.go',
  'backend/internal/syncv2/application.go',
  'backend/cmd/notes/main.go',
  'backend/cmd/notesctl/main.go',
  'backend/internal/config/config.go',
  'backend/internal/localfixture/model.go',
  'backend/internal/adapters/postgres/local_fixture.go',
  'app/(notes)/notes-route-runtime.tsx',
  'components/authenticated-notes-bootstrap.tsx',
  'components/session-notes-app.tsx',
  'components/notes-app.tsx',
  'components/notes-presentation.tsx',
  'lib/application/notes-database-scope.ts',
  'lib/client/http-session-context.ts',
  'lib/client/http-sync-transport.ts',
  'lib/client/notes-store.tsx',
  'lib/client/vault-notes-runtime.ts',
  'lib/storage/indexed-db.ts',
] as const;

export type V12Target = (typeof V12_TARGETS)[number];
export type V12LegacyOperation = (typeof V12_LEGACY_OPERATIONS)[number];
export type V12SyncOperation = (typeof V12_SYNC_OPERATIONS)[number];
export type V12BrowserOperation = (typeof V12_BROWSER_OPERATIONS)[number];

export type V12Observation = Readonly<{
  operation: V12LegacyOperation;
  durationMilliseconds: number;
  status: number;
  responseBytes: number;
  queryCount: number;
  rssBytes: number;
  pssBytes: number;
  responseDigest: string;
}>;

export type V12LegacyRun = Readonly<{
  target: V12Target;
  scale: number;
  run: number;
  storeIdentity: string;
  processIdentity: string;
  queryObservationIdentity: string;
  queryObservationTarget: V12Target;
  queryObservationScale: number;
  queryObservationRun: number;
  queryObservationStoreIdentity: string;
  queryObservationProcessIdentity: string;
  queryObservationStartTicks: number;
  queryResponseDigests: readonly Readonly<{
    operation: Exclude<V12LegacyOperation, 'cold-start'>;
    responseDigest: string;
  }>[];
  processStartTicks: number;
  initialCards: number;
  beforeBatchCards: number;
  afterBatchCards: number;
  batchDistinctCards: number;
  batchAcknowledged: number;
  observations: readonly V12Observation[];
  finalDigests: Readonly<{
    cards: string;
    acknowledgements: string;
    conflicts: string;
  }>;
}>;

export type V12Summary<Operation extends string> = Readonly<{
  target: V12Target | 'sync-v2-go';
  scale: number;
  operation: Operation;
  sampleCount: number;
  p50Milliseconds: number;
  p95Milliseconds: number;
  errorCount: number;
  errorRate: number;
}>;

export type V12Evidence = Readonly<{
  schemaVersion: number;
  evidenceKind: string;
  identity: Readonly<{
    issue: number;
    measuredAt: string;
    runnableReferenceRevision: string;
    frozenRetirementRevision: string;
    integrationBranchPoint: string;
    measuredGoRevision: string;
    measuredGoTreeObjectId: string;
    runnerVersion: string;
    referenceHandlerSha256: string;
    referenceObserverSha256: string;
    referencePatchedHandlerSha256: string;
    runtimeArtifacts: Readonly<{
      goNotesBinarySha256: string;
      goNotesctlBinarySha256: string;
      goQueryCompanionBinarySha256: string;
      goFrontendBuildSha256: string;
      referenceFrontendBuildSha256: string;
      referenceQueryBuildSha256: string;
    }>;
    sourceDigests: readonly Readonly<{ path: string; sha256: string }>[];
  }>;
  host: Readonly<{
    os: string;
    architecture: string;
    kernel: string;
    cpuModel: string;
    logicalCpus: number;
    nodeVersion: string;
    npmVersion: string;
    wranglerVersion: string;
    miniflareVersion: string;
    chromiumVersion: string;
    goVersion: string;
    postgresqlVersion: string;
    totalMemoryBytes: number;
  }>;
  safety: Readonly<{
    executionMode: string;
    databaseIsolation: string;
    externalAdapters: string;
    remoteTargetUsed: boolean;
    credentialMaterialRecorded: boolean;
    sqlArgumentsRecorded: boolean;
    cardContentRecorded: boolean;
    localColdDefinition: string;
    productionCapacityClaim: boolean;
  }>;
  legacy: Readonly<{
    scales: readonly number[];
    runsPerCell: number;
    warmupsBeforeWarmFull: number;
    batchSize: number;
    querySources: Readonly<{
      reference: string;
      go: string;
    }>;
    memoryScope: string;
    runs: readonly V12LegacyRun[];
    summaries: readonly V12Summary<V12LegacyOperation>[];
    parity: readonly Readonly<{
      scale: number;
      run: number;
      cardsDigest: string;
      acknowledgementsDigest: string;
      conflictsDigest: string;
      matches: boolean;
    }>[];
    reviewEnvelope: Readonly<{
      kind: string;
      maximumRatio: number;
      maximumAdditiveMilliseconds: number;
      evaluations: readonly Readonly<{
        scale: number;
        operation: (typeof V12_REVIEWED_LEGACY_OPERATIONS)[number];
        referenceP95Milliseconds: number;
        goP95Milliseconds: number;
        allowedGoP95Milliseconds: number;
        outcome: string;
        explanation: string;
      }>[];
    }>;
  }>;
  browser: Readonly<{
    engine: string;
    headless: boolean;
    harness: string;
    backendProtocols: Readonly<{ reference: string; go: string }>;
    protocolParityClaim: boolean;
    scales: readonly number[];
    runsPerCell: number;
    runs: readonly Readonly<{
      target: V12Target;
      scale: number;
      run: number;
      storeIdentity: string;
      processIdentity: string;
      processStartTicks: number;
      uiRuntimeIdentity: string;
      browserContextIdentity: string;
      fullDataCardCount: number;
      syncPageEntryCounts: readonly number[];
      sessionContextStatus: number;
      beforeCardCount: number;
      afterCardCount: number;
      beforeRevision: number;
      afterRevision: number;
      pendingMutationsAfter: number;
      outgoingBatchPresentAfter: boolean;
      receiptOrAcknowledgementCount: number;
      cardIdentityDigest: string;
      orderedNetworkDigest: string;
      networkObservations: readonly Readonly<{
        phase: 'initial' | 'save';
        path: string;
        status: number;
        responseDigest: string;
      }>[];
      responseOverridesInstalled: boolean;
      externalNetworkGuardInstalled: boolean;
      uiReady: boolean;
      editedExistingCard: boolean;
      saveAcknowledged: boolean;
      observations: readonly Readonly<{
        operation: V12BrowserOperation;
        durationMilliseconds: number;
        status: number;
        responseDigest: string;
      }>[];
    }>[];
    summaries: readonly V12Summary<V12BrowserOperation>[];
    reviewEnvelope: Readonly<{
      kind: string;
      maximumRatio: number;
      maximumAdditiveMilliseconds: number;
      evaluations: readonly Readonly<{
        scale: number;
        operation: V12BrowserOperation;
        referenceP95Milliseconds: number;
        goP95Milliseconds: number;
        allowedGoP95Milliseconds: number;
        outcome: string;
        explanation: string;
      }>[];
    }>;
  }>;
  syncV2: Readonly<{
    entries: number;
    pageSize: number;
    pageCount: number;
    deltaEntries: number;
    runsPerScenario: number;
    warmupsBeforeWarmFull: number;
    poolLimit: number;
    querySource: string;
    memoryScope: string;
    runs: readonly Readonly<{
      run: number;
      storeIdentity: string;
      observations: readonly Readonly<{
        operation: V12SyncOperation;
        durationMilliseconds: number;
        status: number;
        responseBytes: number;
        queryCount: number;
        rssBytes: number;
        pssBytes: number;
        responseDigest: string;
      }>[];
      traversal: Readonly<{
        coldPageEntryCounts: readonly number[];
        warmPageEntryCounts: readonly number[];
        coldUniqueEntries: number;
        warmUniqueEntries: number;
        duplicateEntries: number;
        missingEntries: number;
        fixedHighWatermark: boolean;
        deltaChanges: number;
        coldDigest: string;
        warmDigest: string;
        deltaDigest: string;
      }>;
    }>[];
    summaries: readonly V12Summary<V12SyncOperation>[];
    concurrency: readonly Readonly<{
      run: number;
      storeIdentity: string;
      requests: number;
      barrierParticipants: number;
      independentVaults: number;
      independentSessions: number;
      independentDevices: number;
      poolLimit: number;
      applicationSerializationShim: boolean;
      maximumHTTPConcurrency: number;
      admittedApplicationConcurrency: number;
      maximumApplicationConcurrency: number;
      maximumDatabaseConcurrency: number;
      tenantScopeViolations: number;
      errorCount: number;
      durableCommits: number;
      durableCards: number;
      encryptedMetadataRows: number;
      quotaCommittedReservations: number;
      objectWrites: number;
      encryptions: number;
      durationMilliseconds: number;
      rssBytes: number;
      pssBytes: number;
      observations: readonly Readonly<{
        requestIndex: number;
        durationMilliseconds: number;
        status: number;
        responseBytes: number;
        queryCount: number;
      }>[];
    }>[];
    concurrencySummary: V12Summary<'concurrent-100'>;
    requestLatencySummary: V12Summary<'concurrent-request'>;
  }>;
}>;

export type V12SyncFragment = Readonly<{
  runs: V12Evidence['syncV2']['runs'];
  concurrency: V12Evidence['syncV2']['concurrency'];
}>;

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function nearestRank(
  values: readonly number[],
  fraction: number,
): number {
  if (values.length === 0 || fraction <= 0 || fraction > 1) {
    throw new Error('nearest-rank requires samples and a fraction in (0, 1]');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const selected = sorted[Math.ceil(sorted.length * fraction) - 1];
  if (selected === undefined) throw new Error('nearest-rank sample missing');
  return roundedMilliseconds(selected);
}

export function summarizeV12Samples<Operation extends string>(
  target: V12Target | 'sync-v2-go',
  scale: number,
  operation: Operation,
  samples: readonly Readonly<{
    durationMilliseconds: number;
    status: number;
  }>[],
): V12Summary<Operation> {
  if (samples.length === 0) throw new Error('summary requires samples');
  const durations = samples.map((sample) => sample.durationMilliseconds);
  const errorCount = samples.filter((sample) => sample.status !== 200).length;
  return {
    target,
    scale,
    operation,
    sampleCount: samples.length,
    p50Milliseconds: nearestRank(durations, 0.5),
    p95Milliseconds: nearestRank(durations, 0.95),
    errorCount,
    errorRate: errorCount / samples.length,
  };
}

export function classifyV12ProvisionalReview(
  goP95Milliseconds: number,
  allowedGoP95Milliseconds: number,
): Readonly<{
  outcome: 'within-guideline' | 'review-needed';
  explanation: string;
}> {
  return goP95Milliseconds <= allowedGoP95Milliseconds
    ? { outcome: 'within-guideline', explanation: '' }
    : {
        outcome: 'review-needed',
        explanation:
          'Measured p95 exceeds the provisional local review guideline; inspect run variance and user impact before deciding whether remediation is needed.',
      };
}

export function decodeV12Evidence(candidate: unknown): V12Evidence {
  const root = exactRecord(candidate, 'evidence', [
    'schemaVersion',
    'evidenceKind',
    'identity',
    'host',
    'safety',
    'legacy',
    'browser',
    'syncV2',
  ]);
  const evidence: V12Evidence = {
    schemaVersion: integer(root.schemaVersion, 'schemaVersion', 1),
    evidenceKind: text(root.evidenceKind, 'evidenceKind', 64),
    identity: decodeIdentity(root.identity),
    host: decodeHost(root.host),
    safety: decodeSafety(root.safety),
    legacy: decodeLegacy(root.legacy),
    browser: decodeBrowser(root.browser),
    syncV2: decodeSyncV2(root.syncV2),
  };
  verifyV12Evidence(evidence);
  return evidence;
}

export function decodeV12SyncFragment(candidate: unknown): V12SyncFragment {
  const record = exactRecord(candidate, 'syncV2Fragment', [
    'schemaVersion',
    'runs',
    'concurrency',
  ]);
  expectEqual(
    integer(record.schemaVersion, 'syncV2Fragment.schemaVersion', 1),
    1,
    'syncV2Fragment.schemaVersion',
  );
  return {
    runs: array(record.runs, 'syncV2Fragment.runs').map(decodeSyncV2Run),
    concurrency: array(record.concurrency, 'syncV2Fragment.concurrency').map(
      decodeConcurrency,
    ),
  };
}

export function verifyV12Evidence(evidence: V12Evidence): void {
  expectEqual(evidence.schemaVersion, 1, 'schemaVersion');
  expectEqual(evidence.evidenceKind, 'local-v12-performance', 'evidenceKind');
  expectEqual(evidence.identity.issue, 525, 'identity.issue');
  expectEqual(
    evidence.identity.runnableReferenceRevision,
    V12_REFERENCE_REVISION,
    'identity.runnableReferenceRevision',
  );
  expectEqual(
    evidence.identity.frozenRetirementRevision,
    V12_RETIREMENT_REVISION,
    'identity.frozenRetirementRevision',
  );
  expectEqual(
    evidence.identity.integrationBranchPoint,
    V12_INTEGRATION_BRANCH_POINT,
    'identity.integrationBranchPoint',
  );
  if (evidence.identity.measuredGoRevision === V12_INTEGRATION_BRANCH_POINT) {
    throw new Error(
      'identity.measuredGoRevision must identify the committed measurement implementation',
    );
  }
  expectEqual(
    evidence.identity.runnerVersion,
    V12_RUNNER_VERSION,
    'identity.runnerVersion',
  );
  verifySourceDigests(evidence.identity.sourceDigests);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(
      evidence.identity.measuredAt,
    )
  ) {
    throw new Error('identity.measuredAt must be a UTC ISO instant');
  }
  verifySafety(evidence);
  verifyLegacy(evidence.legacy);
  verifyBrowser(evidence.browser);
  verifySyncV2(evidence.syncV2);
  rejectSensitiveStrings(evidence);
}

export function verifyV12SourceContent(
  evidence: V12Evidence,
  sourceContent: ReadonlyMap<string, string | Uint8Array>,
): void {
  verifySourceDigests(evidence.identity.sourceDigests);
  for (const [index, sourcePath] of V12_SOURCE_PATHS.entries()) {
    const recorded = evidence.identity.sourceDigests[index];
    const content = sourceContent.get(sourcePath);
    if (recorded === undefined || content === undefined) {
      throw new Error(`missing source content for ${sourcePath}`);
    }
    const actual = sha256Hex(content);
    if (actual !== recorded.sha256) {
      throw new Error(
        `${sourcePath} digest is ${actual}, expected ${recorded.sha256}; remeasure instead of relabelling stale evidence`,
      );
    }
  }
  if (sourceContent.size !== V12_SOURCE_PATHS.length) {
    throw new Error('source content contains an unknown or duplicate path');
  }
}

export type V12GitProvenanceReader = Readonly<{
  commitExists: (revision: string) => Promise<boolean>;
  isAncestor: (ancestor: string, descendant: string) => Promise<boolean>;
  readBlob: (revision: string, sourcePath: string) => Promise<Uint8Array>;
  treeObjectId: (revision: string) => Promise<string>;
}>;

export async function verifyV12GitProvenance(
  evidence: V12Evidence,
  currentHead: string,
  reader: V12GitProvenanceReader,
): Promise<void> {
  const measured = evidence.identity.measuredGoRevision;
  if (!(await reader.commitExists(measured))) {
    throw new Error(
      'identity.measuredGoRevision does not resolve to a local commit',
    );
  }
  if (!(await reader.commitExists(currentHead))) {
    throw new Error('current HEAD does not resolve to a local commit');
  }
  if (
    !(await reader.isAncestor(
      evidence.identity.integrationBranchPoint,
      measured,
    ))
  ) {
    throw new Error(
      'integration branch point is not an ancestor of measuredGoRevision',
    );
  }
  if (!(await reader.isAncestor(measured, currentHead))) {
    throw new Error('measuredGoRevision is not an ancestor of current HEAD');
  }
  if (
    (await reader.treeObjectId(measured)) !==
    evidence.identity.measuredGoTreeObjectId
  ) {
    throw new Error(
      'identity.measuredGoTreeObjectId does not match measuredGoRevision',
    );
  }
  for (const [index, sourcePath] of V12_SOURCE_PATHS.entries()) {
    const recorded = evidence.identity.sourceDigests[index];
    if (recorded === undefined || recorded.path !== sourcePath) {
      throw new Error(
        `measured revision source binding missing for ${sourcePath}`,
      );
    }
    let content: Uint8Array;
    try {
      content = await reader.readBlob(measured, sourcePath);
    } catch {
      throw new Error(
        `measured revision lacks evidence producer ${sourcePath}`,
      );
    }
    const actual = sha256Hex(content);
    if (actual !== recorded.sha256) {
      throw new Error(
        `${sourcePath} at measuredGoRevision is ${actual}, expected ${recorded.sha256}; remeasure from a committed producer tree`,
      );
    }
  }
}

function decodeIdentity(value: unknown): V12Evidence['identity'] {
  const record = exactRecord(value, 'identity', [
    'issue',
    'measuredAt',
    'runnableReferenceRevision',
    'frozenRetirementRevision',
    'integrationBranchPoint',
    'measuredGoRevision',
    'measuredGoTreeObjectId',
    'runnerVersion',
    'referenceHandlerSha256',
    'referenceObserverSha256',
    'referencePatchedHandlerSha256',
    'runtimeArtifacts',
    'sourceDigests',
  ]);
  const runtimeArtifacts = exactRecord(
    record.runtimeArtifacts,
    'identity.runtimeArtifacts',
    [
      'goNotesBinarySha256',
      'goNotesctlBinarySha256',
      'goQueryCompanionBinarySha256',
      'goFrontendBuildSha256',
      'referenceFrontendBuildSha256',
      'referenceQueryBuildSha256',
    ],
  );
  return {
    issue: integer(record.issue, 'identity.issue', 1),
    measuredAt: text(record.measuredAt, 'identity.measuredAt', 64),
    runnableReferenceRevision: digest(
      record.runnableReferenceRevision,
      'identity.runnableReferenceRevision',
      40,
    ),
    frozenRetirementRevision: digest(
      record.frozenRetirementRevision,
      'identity.frozenRetirementRevision',
      40,
    ),
    integrationBranchPoint: digest(
      record.integrationBranchPoint,
      'identity.integrationBranchPoint',
      40,
    ),
    measuredGoRevision: digest(
      record.measuredGoRevision,
      'identity.measuredGoRevision',
      40,
    ),
    measuredGoTreeObjectId: digest(
      record.measuredGoTreeObjectId,
      'identity.measuredGoTreeObjectId',
      40,
    ),
    runnerVersion: text(record.runnerVersion, 'identity.runnerVersion', 64),
    referenceHandlerSha256: digest(
      record.referenceHandlerSha256,
      'identity.referenceHandlerSha256',
      64,
    ),
    referenceObserverSha256: digest(
      record.referenceObserverSha256,
      'identity.referenceObserverSha256',
      64,
    ),
    referencePatchedHandlerSha256: digest(
      record.referencePatchedHandlerSha256,
      'identity.referencePatchedHandlerSha256',
      64,
    ),
    runtimeArtifacts: {
      goNotesBinarySha256: digest(
        runtimeArtifacts.goNotesBinarySha256,
        'identity.runtimeArtifacts.goNotesBinarySha256',
        64,
      ),
      goNotesctlBinarySha256: digest(
        runtimeArtifacts.goNotesctlBinarySha256,
        'identity.runtimeArtifacts.goNotesctlBinarySha256',
        64,
      ),
      goQueryCompanionBinarySha256: digest(
        runtimeArtifacts.goQueryCompanionBinarySha256,
        'identity.runtimeArtifacts.goQueryCompanionBinarySha256',
        64,
      ),
      goFrontendBuildSha256: digest(
        runtimeArtifacts.goFrontendBuildSha256,
        'identity.runtimeArtifacts.goFrontendBuildSha256',
        64,
      ),
      referenceFrontendBuildSha256: digest(
        runtimeArtifacts.referenceFrontendBuildSha256,
        'identity.runtimeArtifacts.referenceFrontendBuildSha256',
        64,
      ),
      referenceQueryBuildSha256: digest(
        runtimeArtifacts.referenceQueryBuildSha256,
        'identity.runtimeArtifacts.referenceQueryBuildSha256',
        64,
      ),
    },
    sourceDigests: array(record.sourceDigests, 'identity.sourceDigests').map(
      (entry, index) => {
        const item = exactRecord(entry, `identity.sourceDigests[${index}]`, [
          'path',
          'sha256',
        ]);
        return {
          path: text(item.path, `identity.sourceDigests[${index}].path`, 256),
          sha256: digest(
            item.sha256,
            `identity.sourceDigests[${index}].sha256`,
            64,
          ),
        };
      },
    ),
  };
}

function decodeHost(value: unknown): V12Evidence['host'] {
  const record = exactRecord(value, 'host', [
    'os',
    'architecture',
    'kernel',
    'cpuModel',
    'logicalCpus',
    'nodeVersion',
    'npmVersion',
    'wranglerVersion',
    'miniflareVersion',
    'chromiumVersion',
    'goVersion',
    'postgresqlVersion',
    'totalMemoryBytes',
  ]);
  return {
    os: text(record.os, 'host.os', 64),
    architecture: text(record.architecture, 'host.architecture', 64),
    kernel: text(record.kernel, 'host.kernel', 128),
    cpuModel: text(record.cpuModel, 'host.cpuModel', 256),
    logicalCpus: integer(record.logicalCpus, 'host.logicalCpus', 1),
    nodeVersion: text(record.nodeVersion, 'host.nodeVersion', 64),
    npmVersion: text(record.npmVersion, 'host.npmVersion', 64),
    wranglerVersion: text(record.wranglerVersion, 'host.wranglerVersion', 64),
    miniflareVersion: text(
      record.miniflareVersion,
      'host.miniflareVersion',
      64,
    ),
    chromiumVersion: text(record.chromiumVersion, 'host.chromiumVersion', 128),
    goVersion: text(record.goVersion, 'host.goVersion', 64),
    postgresqlVersion: text(
      record.postgresqlVersion,
      'host.postgresqlVersion',
      64,
    ),
    totalMemoryBytes: integer(
      record.totalMemoryBytes,
      'host.totalMemoryBytes',
      1,
    ),
  };
}

function decodeSafety(value: unknown): V12Evidence['safety'] {
  const record = exactRecord(value, 'safety', [
    'executionMode',
    'databaseIsolation',
    'externalAdapters',
    'remoteTargetUsed',
    'credentialMaterialRecorded',
    'sqlArgumentsRecorded',
    'cardContentRecorded',
    'localColdDefinition',
    'productionCapacityClaim',
  ]);
  return {
    executionMode: text(record.executionMode, 'safety.executionMode', 128),
    databaseIsolation: text(
      record.databaseIsolation,
      'safety.databaseIsolation',
      128,
    ),
    externalAdapters: text(
      record.externalAdapters,
      'safety.externalAdapters',
      128,
    ),
    remoteTargetUsed: boolean(
      record.remoteTargetUsed,
      'safety.remoteTargetUsed',
    ),
    credentialMaterialRecorded: boolean(
      record.credentialMaterialRecorded,
      'safety.credentialMaterialRecorded',
    ),
    sqlArgumentsRecorded: boolean(
      record.sqlArgumentsRecorded,
      'safety.sqlArgumentsRecorded',
    ),
    cardContentRecorded: boolean(
      record.cardContentRecorded,
      'safety.cardContentRecorded',
    ),
    localColdDefinition: text(
      record.localColdDefinition,
      'safety.localColdDefinition',
      256,
    ),
    productionCapacityClaim: boolean(
      record.productionCapacityClaim,
      'safety.productionCapacityClaim',
    ),
  };
}

function decodeLegacy(value: unknown): V12Evidence['legacy'] {
  const record = exactRecord(value, 'legacy', [
    'scales',
    'runsPerCell',
    'warmupsBeforeWarmFull',
    'batchSize',
    'querySources',
    'memoryScope',
    'runs',
    'summaries',
    'parity',
    'reviewEnvelope',
  ]);
  const querySources = exactRecord(record.querySources, 'legacy.querySources', [
    'reference',
    'go',
  ]);
  return {
    scales: array(record.scales, 'legacy.scales').map((entry, index) =>
      integer(entry, `legacy.scales[${index}]`, 1),
    ),
    runsPerCell: integer(record.runsPerCell, 'legacy.runsPerCell', 1),
    warmupsBeforeWarmFull: integer(
      record.warmupsBeforeWarmFull,
      'legacy.warmupsBeforeWarmFull',
      0,
    ),
    batchSize: integer(record.batchSize, 'legacy.batchSize', 1),
    querySources: {
      reference: text(
        querySources.reference,
        'legacy.querySources.reference',
        128,
      ),
      go: text(querySources.go, 'legacy.querySources.go', 128),
    },
    memoryScope: text(record.memoryScope, 'legacy.memoryScope', 128),
    runs: array(record.runs, 'legacy.runs').map(decodeLegacyRun),
    summaries: array(record.summaries, 'legacy.summaries').map((entry, index) =>
      decodeSummary(entry, `legacy.summaries[${index}]`, V12_LEGACY_OPERATIONS),
    ),
    parity: array(record.parity, 'legacy.parity').map((entry, index) => {
      const item = exactRecord(entry, `legacy.parity[${index}]`, [
        'scale',
        'run',
        'cardsDigest',
        'acknowledgementsDigest',
        'conflictsDigest',
        'matches',
      ]);
      return {
        scale: integer(item.scale, `legacy.parity[${index}].scale`, 1),
        run: integer(item.run, `legacy.parity[${index}].run`, 1),
        cardsDigest: digest(
          item.cardsDigest,
          `legacy.parity[${index}].cardsDigest`,
          64,
        ),
        acknowledgementsDigest: digest(
          item.acknowledgementsDigest,
          `legacy.parity[${index}].acknowledgementsDigest`,
          64,
        ),
        conflictsDigest: digest(
          item.conflictsDigest,
          `legacy.parity[${index}].conflictsDigest`,
          64,
        ),
        matches: boolean(item.matches, `legacy.parity[${index}].matches`),
      };
    }),
    reviewEnvelope: decodeReviewEnvelope(record.reviewEnvelope),
  };
}

function decodeLegacyRun(value: unknown, index: number): V12LegacyRun {
  const name = `legacy.runs[${index}]`;
  const record = exactRecord(value, name, [
    'target',
    'scale',
    'run',
    'storeIdentity',
    'processIdentity',
    'queryObservationIdentity',
    'queryObservationTarget',
    'queryObservationScale',
    'queryObservationRun',
    'queryObservationStoreIdentity',
    'queryObservationProcessIdentity',
    'queryObservationStartTicks',
    'queryResponseDigests',
    'processStartTicks',
    'initialCards',
    'beforeBatchCards',
    'afterBatchCards',
    'batchDistinctCards',
    'batchAcknowledged',
    'observations',
    'finalDigests',
  ]);
  const finalDigests = exactRecord(
    record.finalDigests,
    `${name}.finalDigests`,
    ['cards', 'acknowledgements', 'conflicts'],
  );
  return {
    target: enumeration(record.target, `${name}.target`, V12_TARGETS),
    scale: integer(record.scale, `${name}.scale`, 1),
    run: integer(record.run, `${name}.run`, 1),
    storeIdentity: identifier(record.storeIdentity, `${name}.storeIdentity`),
    processIdentity: identifier(
      record.processIdentity,
      `${name}.processIdentity`,
    ),
    queryObservationIdentity: identifier(
      record.queryObservationIdentity,
      `${name}.queryObservationIdentity`,
    ),
    queryObservationTarget: enumeration(
      record.queryObservationTarget,
      `${name}.queryObservationTarget`,
      V12_TARGETS,
    ),
    queryObservationScale: integer(
      record.queryObservationScale,
      `${name}.queryObservationScale`,
      1,
    ),
    queryObservationRun: integer(
      record.queryObservationRun,
      `${name}.queryObservationRun`,
      1,
    ),
    queryObservationStoreIdentity: identifier(
      record.queryObservationStoreIdentity,
      `${name}.queryObservationStoreIdentity`,
    ),
    queryObservationProcessIdentity: identifier(
      record.queryObservationProcessIdentity,
      `${name}.queryObservationProcessIdentity`,
    ),
    queryObservationStartTicks: integer(
      record.queryObservationStartTicks,
      `${name}.queryObservationStartTicks`,
      1,
    ),
    queryResponseDigests: array(
      record.queryResponseDigests,
      `${name}.queryResponseDigests`,
    ).map((entry, digestIndex) => {
      const digestName = `${name}.queryResponseDigests[${digestIndex}]`;
      const item = exactRecord(entry, digestName, [
        'operation',
        'responseDigest',
      ]);
      return {
        operation: enumeration(item.operation, `${digestName}.operation`, [
          'cold-full-sync',
          'warm-full-sync',
          'single-mutation',
          'batch-500',
          'two-device-conflict',
        ] as const),
        responseDigest: digest(
          item.responseDigest,
          `${digestName}.responseDigest`,
          64,
        ),
      };
    }),
    processStartTicks: integer(
      record.processStartTicks,
      `${name}.processStartTicks`,
      1,
    ),
    initialCards: integer(record.initialCards, `${name}.initialCards`, 0),
    beforeBatchCards: integer(
      record.beforeBatchCards,
      `${name}.beforeBatchCards`,
      0,
    ),
    afterBatchCards: integer(
      record.afterBatchCards,
      `${name}.afterBatchCards`,
      0,
    ),
    batchDistinctCards: integer(
      record.batchDistinctCards,
      `${name}.batchDistinctCards`,
      0,
    ),
    batchAcknowledged: integer(
      record.batchAcknowledged,
      `${name}.batchAcknowledged`,
      0,
    ),
    observations: array(record.observations, `${name}.observations`).map(
      (entry, observationIndex) =>
        decodeObservation(
          entry,
          `${name}.observations[${observationIndex}]`,
          V12_LEGACY_OPERATIONS,
        ),
    ),
    finalDigests: {
      cards: digest(finalDigests.cards, `${name}.finalDigests.cards`, 64),
      acknowledgements: digest(
        finalDigests.acknowledgements,
        `${name}.finalDigests.acknowledgements`,
        64,
      ),
      conflicts: digest(
        finalDigests.conflicts,
        `${name}.finalDigests.conflicts`,
        64,
      ),
    },
  };
}

function decodeObservation<Operation extends string>(
  value: unknown,
  name: string,
  operations: readonly Operation[],
): Readonly<{
  operation: Operation;
  durationMilliseconds: number;
  status: number;
  responseBytes: number;
  queryCount: number;
  rssBytes: number;
  pssBytes: number;
  responseDigest: string;
}> {
  const record = exactRecord(value, name, [
    'operation',
    'durationMilliseconds',
    'status',
    'responseBytes',
    'queryCount',
    'rssBytes',
    'pssBytes',
    'responseDigest',
  ]);
  return {
    operation: enumeration(record.operation, `${name}.operation`, operations),
    durationMilliseconds: finite(
      record.durationMilliseconds,
      `${name}.durationMilliseconds`,
      true,
    ),
    status: integer(record.status, `${name}.status`, 100),
    responseBytes: integer(record.responseBytes, `${name}.responseBytes`, 0),
    queryCount: integer(record.queryCount, `${name}.queryCount`, 0),
    rssBytes: integer(record.rssBytes, `${name}.rssBytes`, 1),
    pssBytes: integer(record.pssBytes, `${name}.pssBytes`, 1),
    responseDigest: digest(record.responseDigest, `${name}.responseDigest`, 64),
  };
}

function decodeSummary<Operation extends string>(
  value: unknown,
  name: string,
  operations: readonly Operation[],
): V12Summary<Operation> {
  const record = exactRecord(value, name, [
    'target',
    'scale',
    'operation',
    'sampleCount',
    'p50Milliseconds',
    'p95Milliseconds',
    'errorCount',
    'errorRate',
  ]);
  return {
    target: enumeration(record.target, `${name}.target`, [
      ...V12_TARGETS,
      'sync-v2-go',
    ]),
    scale: integer(record.scale, `${name}.scale`, 1),
    operation: enumeration(record.operation, `${name}.operation`, operations),
    sampleCount: integer(record.sampleCount, `${name}.sampleCount`, 1),
    p50Milliseconds: finite(
      record.p50Milliseconds,
      `${name}.p50Milliseconds`,
      true,
    ),
    p95Milliseconds: finite(
      record.p95Milliseconds,
      `${name}.p95Milliseconds`,
      true,
    ),
    errorCount: integer(record.errorCount, `${name}.errorCount`, 0),
    errorRate: finite(record.errorRate, `${name}.errorRate`, false),
  };
}

function decodeReviewEnvelope(
  value: unknown,
): V12Evidence['legacy']['reviewEnvelope'] {
  const record = exactRecord(value, 'legacy.reviewEnvelope', [
    'kind',
    'maximumRatio',
    'maximumAdditiveMilliseconds',
    'evaluations',
  ]);
  return {
    kind: text(record.kind, 'legacy.reviewEnvelope.kind', 128),
    maximumRatio: finite(
      record.maximumRatio,
      'legacy.reviewEnvelope.maximumRatio',
      true,
    ),
    maximumAdditiveMilliseconds: finite(
      record.maximumAdditiveMilliseconds,
      'legacy.reviewEnvelope.maximumAdditiveMilliseconds',
      false,
    ),
    evaluations: array(
      record.evaluations,
      'legacy.reviewEnvelope.evaluations',
    ).map((entry, index) => {
      const name = `legacy.reviewEnvelope.evaluations[${index}]`;
      const item = exactRecord(entry, name, [
        'scale',
        'operation',
        'referenceP95Milliseconds',
        'goP95Milliseconds',
        'allowedGoP95Milliseconds',
        'outcome',
        'explanation',
      ]);
      return {
        scale: integer(item.scale, `${name}.scale`, 1),
        operation: enumeration(
          item.operation,
          `${name}.operation`,
          V12_REVIEWED_LEGACY_OPERATIONS,
        ),
        referenceP95Milliseconds: finite(
          item.referenceP95Milliseconds,
          `${name}.referenceP95Milliseconds`,
          true,
        ),
        goP95Milliseconds: finite(
          item.goP95Milliseconds,
          `${name}.goP95Milliseconds`,
          true,
        ),
        allowedGoP95Milliseconds: finite(
          item.allowedGoP95Milliseconds,
          `${name}.allowedGoP95Milliseconds`,
          true,
        ),
        outcome: text(item.outcome, `${name}.outcome`, 64),
        explanation: text(item.explanation, `${name}.explanation`, 1_024, true),
      };
    }),
  };
}

function decodeBrowser(value: unknown): V12Evidence['browser'] {
  const record = exactRecord(value, 'browser', [
    'engine',
    'headless',
    'harness',
    'backendProtocols',
    'protocolParityClaim',
    'scales',
    'runsPerCell',
    'runs',
    'summaries',
    'reviewEnvelope',
  ]);
  const protocols = exactRecord(
    record.backendProtocols,
    'browser.backendProtocols',
    ['reference', 'go'],
  );
  const review = exactRecord(record.reviewEnvelope, 'browser.reviewEnvelope', [
    'kind',
    'maximumRatio',
    'maximumAdditiveMilliseconds',
    'evaluations',
  ]);
  return {
    engine: text(record.engine, 'browser.engine', 64),
    headless: boolean(record.headless, 'browser.headless'),
    harness: text(record.harness, 'browser.harness', 128),
    backendProtocols: {
      reference: text(
        protocols.reference,
        'browser.backendProtocols.reference',
        128,
      ),
      go: text(protocols.go, 'browser.backendProtocols.go', 128),
    },
    protocolParityClaim: boolean(
      record.protocolParityClaim,
      'browser.protocolParityClaim',
    ),
    scales: countArray(record.scales, 'browser.scales'),
    runsPerCell: integer(record.runsPerCell, 'browser.runsPerCell', 1),
    runs: array(record.runs, 'browser.runs').map((entry, index) => {
      const name = `browser.runs[${index}]`;
      const item = exactRecord(entry, name, [
        'target',
        'scale',
        'run',
        'storeIdentity',
        'processIdentity',
        'processStartTicks',
        'uiRuntimeIdentity',
        'browserContextIdentity',
        'fullDataCardCount',
        'syncPageEntryCounts',
        'sessionContextStatus',
        'beforeCardCount',
        'afterCardCount',
        'beforeRevision',
        'afterRevision',
        'pendingMutationsAfter',
        'outgoingBatchPresentAfter',
        'receiptOrAcknowledgementCount',
        'cardIdentityDigest',
        'orderedNetworkDigest',
        'networkObservations',
        'responseOverridesInstalled',
        'externalNetworkGuardInstalled',
        'uiReady',
        'editedExistingCard',
        'saveAcknowledged',
        'observations',
      ]);
      return {
        target: enumeration(item.target, `${name}.target`, V12_TARGETS),
        scale: integer(item.scale, `${name}.scale`, 1),
        run: integer(item.run, `${name}.run`, 1),
        storeIdentity: identifier(item.storeIdentity, `${name}.storeIdentity`),
        processIdentity: identifier(
          item.processIdentity,
          `${name}.processIdentity`,
        ),
        processStartTicks: integer(
          item.processStartTicks,
          `${name}.processStartTicks`,
          1,
        ),
        uiRuntimeIdentity: identifier(
          item.uiRuntimeIdentity,
          `${name}.uiRuntimeIdentity`,
        ),
        browserContextIdentity: identifier(
          item.browserContextIdentity,
          `${name}.browserContextIdentity`,
        ),
        fullDataCardCount: integer(
          item.fullDataCardCount,
          `${name}.fullDataCardCount`,
          1,
        ),
        syncPageEntryCounts: countArray(
          item.syncPageEntryCounts,
          `${name}.syncPageEntryCounts`,
        ),
        sessionContextStatus: integer(
          item.sessionContextStatus,
          `${name}.sessionContextStatus`,
          0,
        ),
        beforeCardCount: integer(
          item.beforeCardCount,
          `${name}.beforeCardCount`,
          1,
        ),
        afterCardCount: integer(
          item.afterCardCount,
          `${name}.afterCardCount`,
          1,
        ),
        beforeRevision: integer(
          item.beforeRevision,
          `${name}.beforeRevision`,
          1,
        ),
        afterRevision: integer(item.afterRevision, `${name}.afterRevision`, 1),
        pendingMutationsAfter: integer(
          item.pendingMutationsAfter,
          `${name}.pendingMutationsAfter`,
          0,
        ),
        outgoingBatchPresentAfter: boolean(
          item.outgoingBatchPresentAfter,
          `${name}.outgoingBatchPresentAfter`,
        ),
        receiptOrAcknowledgementCount: integer(
          item.receiptOrAcknowledgementCount,
          `${name}.receiptOrAcknowledgementCount`,
          0,
        ),
        cardIdentityDigest: digest(
          item.cardIdentityDigest,
          `${name}.cardIdentityDigest`,
          64,
        ),
        orderedNetworkDigest: digest(
          item.orderedNetworkDigest,
          `${name}.orderedNetworkDigest`,
          64,
        ),
        networkObservations: array(
          item.networkObservations,
          `${name}.networkObservations`,
        ).map((observation, networkIndex) => {
          const networkName = `${name}.networkObservations[${networkIndex}]`;
          const raw = exactRecord(observation, networkName, [
            'phase',
            'path',
            'status',
            'responseDigest',
          ]);
          return {
            phase: enumeration(raw.phase, `${networkName}.phase`, [
              'initial',
              'save',
            ] as const),
            path: text(raw.path, `${networkName}.path`, 128),
            status: integer(raw.status, `${networkName}.status`, 100),
            responseDigest: digest(
              raw.responseDigest,
              `${networkName}.responseDigest`,
              64,
            ),
          };
        }),
        responseOverridesInstalled: boolean(
          item.responseOverridesInstalled,
          `${name}.responseOverridesInstalled`,
        ),
        externalNetworkGuardInstalled: boolean(
          item.externalNetworkGuardInstalled,
          `${name}.externalNetworkGuardInstalled`,
        ),
        uiReady: boolean(item.uiReady, `${name}.uiReady`),
        editedExistingCard: boolean(
          item.editedExistingCard,
          `${name}.editedExistingCard`,
        ),
        saveAcknowledged: boolean(
          item.saveAcknowledged,
          `${name}.saveAcknowledged`,
        ),
        observations: array(item.observations, `${name}.observations`).map(
          (observation, observationIndex) => {
            const observationName = `${name}.observations[${observationIndex}]`;
            const raw = exactRecord(observation, observationName, [
              'operation',
              'durationMilliseconds',
              'status',
              'responseDigest',
            ]);
            return {
              operation: enumeration(
                raw.operation,
                `${observationName}.operation`,
                V12_BROWSER_OPERATIONS,
              ),
              durationMilliseconds: finite(
                raw.durationMilliseconds,
                `${observationName}.durationMilliseconds`,
                true,
              ),
              status: integer(raw.status, `${observationName}.status`, 100),
              responseDigest: digest(
                raw.responseDigest,
                `${observationName}.responseDigest`,
                64,
              ),
            };
          },
        ),
      };
    }),
    summaries: array(record.summaries, 'browser.summaries').map(
      (entry, index) =>
        decodeSummary(
          entry,
          `browser.summaries[${index}]`,
          V12_BROWSER_OPERATIONS,
        ),
    ),
    reviewEnvelope: {
      kind: text(review.kind, 'browser.reviewEnvelope.kind', 128),
      maximumRatio: finite(
        review.maximumRatio,
        'browser.reviewEnvelope.maximumRatio',
        true,
      ),
      maximumAdditiveMilliseconds: finite(
        review.maximumAdditiveMilliseconds,
        'browser.reviewEnvelope.maximumAdditiveMilliseconds',
        false,
      ),
      evaluations: array(
        review.evaluations,
        'browser.reviewEnvelope.evaluations',
      ).map((entry, index) => {
        const name = `browser.reviewEnvelope.evaluations[${index}]`;
        const item = exactRecord(entry, name, [
          'scale',
          'operation',
          'referenceP95Milliseconds',
          'goP95Milliseconds',
          'allowedGoP95Milliseconds',
          'outcome',
          'explanation',
        ]);
        return {
          scale: integer(item.scale, `${name}.scale`, 1),
          operation: enumeration(
            item.operation,
            `${name}.operation`,
            V12_BROWSER_OPERATIONS,
          ),
          referenceP95Milliseconds: finite(
            item.referenceP95Milliseconds,
            `${name}.referenceP95Milliseconds`,
            true,
          ),
          goP95Milliseconds: finite(
            item.goP95Milliseconds,
            `${name}.goP95Milliseconds`,
            true,
          ),
          allowedGoP95Milliseconds: finite(
            item.allowedGoP95Milliseconds,
            `${name}.allowedGoP95Milliseconds`,
            true,
          ),
          outcome: text(item.outcome, `${name}.outcome`, 64),
          explanation: text(
            item.explanation,
            `${name}.explanation`,
            1_024,
            true,
          ),
        };
      }),
    },
  };
}

function decodeSyncV2(value: unknown): V12Evidence['syncV2'] {
  const record = exactRecord(value, 'syncV2', [
    'entries',
    'pageSize',
    'pageCount',
    'deltaEntries',
    'runsPerScenario',
    'warmupsBeforeWarmFull',
    'poolLimit',
    'querySource',
    'memoryScope',
    'runs',
    'summaries',
    'concurrency',
    'concurrencySummary',
    'requestLatencySummary',
  ]);
  return {
    entries: integer(record.entries, 'syncV2.entries', 1),
    pageSize: integer(record.pageSize, 'syncV2.pageSize', 1),
    pageCount: integer(record.pageCount, 'syncV2.pageCount', 1),
    deltaEntries: integer(record.deltaEntries, 'syncV2.deltaEntries', 1),
    runsPerScenario: integer(
      record.runsPerScenario,
      'syncV2.runsPerScenario',
      1,
    ),
    warmupsBeforeWarmFull: integer(
      record.warmupsBeforeWarmFull,
      'syncV2.warmupsBeforeWarmFull',
      0,
    ),
    poolLimit: integer(record.poolLimit, 'syncV2.poolLimit', 1),
    querySource: text(record.querySource, 'syncV2.querySource', 128),
    memoryScope: text(record.memoryScope, 'syncV2.memoryScope', 128),
    runs: array(record.runs, 'syncV2.runs').map(decodeSyncV2Run),
    summaries: array(record.summaries, 'syncV2.summaries').map((entry, index) =>
      decodeSummary(entry, `syncV2.summaries[${index}]`, V12_SYNC_OPERATIONS),
    ),
    concurrency: array(record.concurrency, 'syncV2.concurrency').map(
      decodeConcurrency,
    ),
    concurrencySummary: decodeSummary(
      record.concurrencySummary,
      'syncV2.concurrencySummary',
      ['concurrent-100'] as const,
    ),
    requestLatencySummary: decodeSummary(
      record.requestLatencySummary,
      'syncV2.requestLatencySummary',
      ['concurrent-request'] as const,
    ),
  };
}

function decodeSyncV2Run(
  value: unknown,
  index: number,
): V12Evidence['syncV2']['runs'][number] {
  const name = `syncV2.runs[${index}]`;
  const record = exactRecord(value, name, [
    'run',
    'storeIdentity',
    'observations',
    'traversal',
  ]);
  const traversal = exactRecord(record.traversal, `${name}.traversal`, [
    'coldPageEntryCounts',
    'warmPageEntryCounts',
    'coldUniqueEntries',
    'warmUniqueEntries',
    'duplicateEntries',
    'missingEntries',
    'fixedHighWatermark',
    'deltaChanges',
    'coldDigest',
    'warmDigest',
    'deltaDigest',
  ]);
  return {
    run: integer(record.run, `${name}.run`, 1),
    storeIdentity: identifier(record.storeIdentity, `${name}.storeIdentity`),
    observations: array(record.observations, `${name}.observations`).map(
      (entry, observationIndex) =>
        decodeObservation(
          entry,
          `${name}.observations[${observationIndex}]`,
          V12_SYNC_OPERATIONS,
        ),
    ),
    traversal: {
      coldPageEntryCounts: countArray(
        traversal.coldPageEntryCounts,
        `${name}.traversal.coldPageEntryCounts`,
      ),
      warmPageEntryCounts: countArray(
        traversal.warmPageEntryCounts,
        `${name}.traversal.warmPageEntryCounts`,
      ),
      coldUniqueEntries: integer(
        traversal.coldUniqueEntries,
        `${name}.traversal.coldUniqueEntries`,
        0,
      ),
      warmUniqueEntries: integer(
        traversal.warmUniqueEntries,
        `${name}.traversal.warmUniqueEntries`,
        0,
      ),
      duplicateEntries: integer(
        traversal.duplicateEntries,
        `${name}.traversal.duplicateEntries`,
        0,
      ),
      missingEntries: integer(
        traversal.missingEntries,
        `${name}.traversal.missingEntries`,
        0,
      ),
      fixedHighWatermark: boolean(
        traversal.fixedHighWatermark,
        `${name}.traversal.fixedHighWatermark`,
      ),
      deltaChanges: integer(
        traversal.deltaChanges,
        `${name}.traversal.deltaChanges`,
        0,
      ),
      coldDigest: digest(
        traversal.coldDigest,
        `${name}.traversal.coldDigest`,
        64,
      ),
      warmDigest: digest(
        traversal.warmDigest,
        `${name}.traversal.warmDigest`,
        64,
      ),
      deltaDigest: digest(
        traversal.deltaDigest,
        `${name}.traversal.deltaDigest`,
        64,
      ),
    },
  };
}

function decodeConcurrency(
  value: unknown,
  index: number,
): V12Evidence['syncV2']['concurrency'][number] {
  const name = `syncV2.concurrency[${index}]`;
  const record = exactRecord(value, name, [
    'run',
    'storeIdentity',
    'requests',
    'barrierParticipants',
    'independentVaults',
    'independentSessions',
    'independentDevices',
    'poolLimit',
    'applicationSerializationShim',
    'maximumHTTPConcurrency',
    'admittedApplicationConcurrency',
    'maximumApplicationConcurrency',
    'maximumDatabaseConcurrency',
    'tenantScopeViolations',
    'errorCount',
    'durableCommits',
    'durableCards',
    'encryptedMetadataRows',
    'quotaCommittedReservations',
    'objectWrites',
    'encryptions',
    'durationMilliseconds',
    'rssBytes',
    'pssBytes',
    'observations',
  ]);
  return {
    run: integer(record.run, `${name}.run`, 1),
    storeIdentity: identifier(record.storeIdentity, `${name}.storeIdentity`),
    requests: integer(record.requests, `${name}.requests`, 1),
    barrierParticipants: integer(
      record.barrierParticipants,
      `${name}.barrierParticipants`,
      1,
    ),
    independentVaults: integer(
      record.independentVaults,
      `${name}.independentVaults`,
      1,
    ),
    independentSessions: integer(
      record.independentSessions,
      `${name}.independentSessions`,
      1,
    ),
    independentDevices: integer(
      record.independentDevices,
      `${name}.independentDevices`,
      1,
    ),
    poolLimit: integer(record.poolLimit, `${name}.poolLimit`, 1),
    applicationSerializationShim: boolean(
      record.applicationSerializationShim,
      `${name}.applicationSerializationShim`,
    ),
    maximumHTTPConcurrency: integer(
      record.maximumHTTPConcurrency,
      `${name}.maximumHTTPConcurrency`,
      1,
    ),
    admittedApplicationConcurrency: integer(
      record.admittedApplicationConcurrency,
      `${name}.admittedApplicationConcurrency`,
      1,
    ),
    maximumApplicationConcurrency: integer(
      record.maximumApplicationConcurrency,
      `${name}.maximumApplicationConcurrency`,
      1,
    ),
    maximumDatabaseConcurrency: integer(
      record.maximumDatabaseConcurrency,
      `${name}.maximumDatabaseConcurrency`,
      1,
    ),
    tenantScopeViolations: integer(
      record.tenantScopeViolations,
      `${name}.tenantScopeViolations`,
      0,
    ),
    errorCount: integer(record.errorCount, `${name}.errorCount`, 0),
    durableCommits: integer(record.durableCommits, `${name}.durableCommits`, 0),
    durableCards: integer(record.durableCards, `${name}.durableCards`, 0),
    encryptedMetadataRows: integer(
      record.encryptedMetadataRows,
      `${name}.encryptedMetadataRows`,
      0,
    ),
    quotaCommittedReservations: integer(
      record.quotaCommittedReservations,
      `${name}.quotaCommittedReservations`,
      0,
    ),
    objectWrites: integer(record.objectWrites, `${name}.objectWrites`, 0),
    encryptions: integer(record.encryptions, `${name}.encryptions`, 0),
    durationMilliseconds: finite(
      record.durationMilliseconds,
      `${name}.durationMilliseconds`,
      true,
    ),
    rssBytes: integer(record.rssBytes, `${name}.rssBytes`, 1),
    pssBytes: integer(record.pssBytes, `${name}.pssBytes`, 1),
    observations: array(record.observations, `${name}.observations`).map(
      (entry, observationIndex) => {
        const observationName = `${name}.observations[${observationIndex}]`;
        const item = exactRecord(entry, observationName, [
          'requestIndex',
          'durationMilliseconds',
          'status',
          'responseBytes',
          'queryCount',
        ]);
        return {
          requestIndex: integer(
            item.requestIndex,
            `${observationName}.requestIndex`,
            0,
          ),
          durationMilliseconds: finite(
            item.durationMilliseconds,
            `${observationName}.durationMilliseconds`,
            true,
          ),
          status: integer(item.status, `${observationName}.status`, 100),
          responseBytes: integer(
            item.responseBytes,
            `${observationName}.responseBytes`,
            0,
          ),
          queryCount: integer(
            item.queryCount,
            `${observationName}.queryCount`,
            0,
          ),
        };
      },
    ),
  };
}

function verifySourceDigests(
  entries: V12Evidence['identity']['sourceDigests'],
): void {
  if (entries.length !== V12_SOURCE_PATHS.length) {
    throw new Error(
      'identity.sourceDigests must cover every runner source exactly once',
    );
  }
  for (const [index, expected] of V12_SOURCE_PATHS.entries()) {
    expectEqual(
      entries[index]?.path,
      expected,
      `identity.sourceDigests[${index}].path`,
    );
  }
  unique(
    entries.map((entry) => entry.path),
    'identity.sourceDigests paths',
  );
}

function verifySafety(evidence: V12Evidence): void {
  expectEqual(evidence.host.os, 'linux', 'host.os');
  const expected = {
    executionMode: 'local-loopback-disposable-only',
    databaseIsolation: 'separate-target-owned-fresh-logical-stores',
    externalAdapters:
      'no-remote-provider-local-d1-postgresql-and-private-directory-adapters',
    remoteTargetUsed: false,
    credentialMaterialRecorded: false,
    sqlArgumentsRecorded: false,
    cardContentRecorded: false,
    localColdDefinition:
      'fresh-application-process-and-logical-store-os-cache-uncontrolled',
    productionCapacityClaim: false,
  } as const;
  for (const key of Object.keys(expected)) {
    if (key === 'executionMode')
      expectEqual(
        evidence.safety.executionMode,
        expected.executionMode,
        `safety.${key}`,
      );
    else if (key === 'databaseIsolation')
      expectEqual(
        evidence.safety.databaseIsolation,
        expected.databaseIsolation,
        `safety.${key}`,
      );
    else if (key === 'externalAdapters')
      expectEqual(
        evidence.safety.externalAdapters,
        expected.externalAdapters,
        `safety.${key}`,
      );
    else if (key === 'remoteTargetUsed')
      expectEqual(
        evidence.safety.remoteTargetUsed,
        expected.remoteTargetUsed,
        `safety.${key}`,
      );
    else if (key === 'credentialMaterialRecorded')
      expectEqual(
        evidence.safety.credentialMaterialRecorded,
        expected.credentialMaterialRecorded,
        `safety.${key}`,
      );
    else if (key === 'sqlArgumentsRecorded')
      expectEqual(
        evidence.safety.sqlArgumentsRecorded,
        expected.sqlArgumentsRecorded,
        `safety.${key}`,
      );
    else if (key === 'cardContentRecorded')
      expectEqual(
        evidence.safety.cardContentRecorded,
        expected.cardContentRecorded,
        `safety.${key}`,
      );
    else if (key === 'localColdDefinition')
      expectEqual(
        evidence.safety.localColdDefinition,
        expected.localColdDefinition,
        `safety.${key}`,
      );
    else if (key === 'productionCapacityClaim')
      expectEqual(
        evidence.safety.productionCapacityClaim,
        expected.productionCapacityClaim,
        `safety.${key}`,
      );
  }
}

function verifyLegacy(legacy: V12Evidence['legacy']): void {
  exactSequence(legacy.scales, V12_SCALES, 'legacy.scales');
  expectEqual(legacy.runsPerCell, 5, 'legacy.runsPerCell');
  if (legacy.warmupsBeforeWarmFull < 3)
    throw new Error('legacy warm full requires at least three warmups');
  expectEqual(legacy.batchSize, 500, 'legacy.batchSize');
  expectEqual(
    legacy.querySources.reference,
    'instrumented-d1-statement-observer',
    'legacy.querySources.reference',
  );
  expectEqual(
    legacy.querySources.go,
    'instrumented-pgx-query-and-batch-tracer',
    'legacy.querySources.go',
  );
  expectEqual(
    legacy.memoryScope,
    'linux-process-group-smaps-rollup-rss-pss-bytes',
    'legacy.memoryScope',
  );

  const expectedRunCount =
    V12_TARGETS.length * V12_SCALES.length * legacy.runsPerCell;
  if (legacy.runs.length !== expectedRunCount)
    throw new Error(`legacy.runs must contain ${expectedRunCount} cells`);
  const storeIdentities: string[] = [];
  const processIdentities: string[] = [];
  const queryObservationIdentities: string[] = [];
  const queryStoreIdentities: string[] = [];
  const queryProcessIdentities: string[] = [];
  let cursor = 0;
  for (const target of V12_TARGETS) {
    for (const scale of V12_SCALES) {
      for (let run = 1; run <= legacy.runsPerCell; run += 1) {
        const entry = legacy.runs[cursor];
        if (entry === undefined) throw new Error('legacy run missing');
        expectEqual(entry.target, target, `legacy.runs[${cursor}].target`);
        expectEqual(entry.scale, scale, `legacy.runs[${cursor}].scale`);
        expectEqual(entry.run, run, `legacy.runs[${cursor}].run`);
        expectEqual(
          entry.initialCards,
          scale,
          `legacy.runs[${cursor}].initialCards`,
        );
        expectEqual(
          entry.beforeBatchCards,
          scale,
          `legacy.runs[${cursor}].beforeBatchCards`,
        );
        expectEqual(
          entry.afterBatchCards,
          scale + 500,
          `legacy.runs[${cursor}].afterBatchCards`,
        );
        expectEqual(
          entry.batchDistinctCards,
          500,
          `legacy.runs[${cursor}].batchDistinctCards`,
        );
        expectEqual(
          entry.batchAcknowledged,
          500,
          `legacy.runs[${cursor}].batchAcknowledged`,
        );
        verifyObservations(
          entry.observations,
          V12_LEGACY_OPERATIONS,
          `legacy.runs[${cursor}]`,
        );
        verifyLegacyQueryObservations(entry, cursor);
        storeIdentities.push(entry.storeIdentity);
        processIdentities.push(entry.processIdentity);
        queryObservationIdentities.push(entry.queryObservationIdentity);
        queryStoreIdentities.push(entry.queryObservationStoreIdentity);
        queryProcessIdentities.push(entry.queryObservationProcessIdentity);
        cursor += 1;
      }
    }
  }
  unique(storeIdentities, 'legacy store identities');
  unique(processIdentities, 'legacy process identities');
  unique(queryObservationIdentities, 'legacy query observation identities');
  unique(queryStoreIdentities, 'legacy query store identities');
  unique(queryProcessIdentities, 'legacy query process identities');

  verifyLegacySummaries(legacy);
  verifyLegacyParity(legacy);
  verifyReviewEnvelope(legacy);
}

function verifyLegacyQueryObservations(
  entry: V12LegacyRun,
  index: number,
): void {
  expectEqual(
    entry.queryObservationTarget,
    entry.target,
    `legacy.runs[${index}] query target`,
  );
  expectEqual(
    entry.queryObservationScale,
    entry.scale,
    `legacy.runs[${index}] query scale`,
  );
  expectEqual(
    entry.queryObservationRun,
    entry.run,
    `legacy.runs[${index}] query run`,
  );
  if (entry.queryObservationStoreIdentity === entry.storeIdentity) {
    throw new Error(
      `legacy.runs[${index}] query companion must use a separate store`,
    );
  }
  if (entry.queryObservationProcessIdentity === entry.processIdentity) {
    throw new Error(
      `legacy.runs[${index}] query companion must be identified separately from the timed process`,
    );
  }
  const operations = V12_LEGACY_OPERATIONS.filter(
    (operation): operation is Exclude<V12LegacyOperation, 'cold-start'> =>
      operation !== 'cold-start',
  );
  if (entry.queryResponseDigests.length !== operations.length) {
    throw new Error(
      `legacy.runs[${index}] query companion response matrix is incomplete`,
    );
  }
  for (const [digestIndex, operation] of operations.entries()) {
    const queryDigest = entry.queryResponseDigests[digestIndex];
    const timed = entry.observations.find(
      (observation) => observation.operation === operation,
    );
    if (queryDigest === undefined || timed === undefined)
      throw new Error('legacy query response binding source missing');
    expectEqual(
      queryDigest.operation,
      operation,
      `legacy.runs[${index}].queryResponseDigests[${digestIndex}].operation`,
    );
    expectEqual(
      queryDigest.responseDigest,
      timed.responseDigest,
      `legacy.runs[${index}] query/timed response digest ${operation}`,
    );
  }
}

function verifyObservations<Operation extends string>(
  observations: readonly Readonly<{
    operation: Operation;
    durationMilliseconds: number;
    status: number;
    responseBytes: number;
    queryCount: number;
    rssBytes: number;
    pssBytes: number;
    responseDigest: string;
  }>[],
  operations: readonly Operation[],
  name: string,
): void {
  if (observations.length !== operations.length)
    throw new Error(`${name} operation count is incomplete`);
  for (const [index, operation] of operations.entries()) {
    const observation = observations[index];
    if (observation === undefined)
      throw new Error(`${name} observation missing`);
    expectEqual(
      observation.operation,
      operation,
      `${name}.observations[${index}].operation`,
    );
    expectEqual(observation.status, 200, `${name}.${operation}.status`);
    if (observation.pssBytes > observation.rssBytes)
      throw new Error(`${name}.${operation} PSS exceeds RSS`);
    if (operation === 'cold-start') {
      expectEqual(observation.queryCount, 0, `${name}.${operation}.queryCount`);
      expectEqual(
        observation.responseBytes,
        0,
        `${name}.${operation}.responseBytes`,
      );
      expectEqual(
        observation.responseDigest,
        sha256Hex(''),
        `${name}.${operation}.responseDigest`,
      );
    } else if (
      observation.responseBytes === 0 ||
      observation.queryCount === 0
    ) {
      throw new Error(
        `${name}.${operation} requires response bytes and observed queries`,
      );
    }
  }
}

function verifyLegacySummaries(legacy: V12Evidence['legacy']): void {
  const expectedCount =
    V12_TARGETS.length * V12_SCALES.length * V12_LEGACY_OPERATIONS.length;
  if (legacy.summaries.length !== expectedCount)
    throw new Error('legacy summary matrix is incomplete');
  let cursor = 0;
  for (const target of V12_TARGETS) {
    for (const scale of V12_SCALES) {
      for (const operation of V12_LEGACY_OPERATIONS) {
        const stored = legacy.summaries[cursor];
        if (stored === undefined) throw new Error('legacy summary missing');
        const samples = legacy.runs
          .filter((run) => run.target === target && run.scale === scale)
          .map((run) => {
            const observation = run.observations.find(
              (entry) => entry.operation === operation,
            );
            if (observation === undefined)
              throw new Error('legacy summary source missing');
            return observation;
          });
        const computed = summarizeV12Samples(target, scale, operation, samples);
        exactJSON(stored, computed, `legacy.summaries[${cursor}]`);
        cursor += 1;
      }
    }
  }
}

function verifyLegacyParity(legacy: V12Evidence['legacy']): void {
  if (legacy.parity.length !== V12_SCALES.length * legacy.runsPerCell) {
    throw new Error('legacy parity matrix is incomplete');
  }
  let cursor = 0;
  for (const scale of V12_SCALES) {
    for (let run = 1; run <= legacy.runsPerCell; run += 1) {
      const parity = legacy.parity[cursor];
      const reference = legacy.runs.find(
        (entry) =>
          entry.target === 'reference' &&
          entry.scale === scale &&
          entry.run === run,
      );
      const go = legacy.runs.find(
        (entry) =>
          entry.target === 'go' && entry.scale === scale && entry.run === run,
      );
      if (parity === undefined || reference === undefined || go === undefined)
        throw new Error('legacy parity source missing');
      expectEqual(parity.scale, scale, `legacy.parity[${cursor}].scale`);
      expectEqual(parity.run, run, `legacy.parity[${cursor}].run`);
      expectEqual(parity.matches, true, `legacy.parity[${cursor}].matches`);
      expectEqual(
        reference.finalDigests.cards,
        go.finalDigests.cards,
        `legacy parity cards ${scale}/${run}`,
      );
      expectEqual(
        reference.finalDigests.acknowledgements,
        go.finalDigests.acknowledgements,
        `legacy parity acknowledgements ${scale}/${run}`,
      );
      expectEqual(
        reference.finalDigests.conflicts,
        go.finalDigests.conflicts,
        `legacy parity conflicts ${scale}/${run}`,
      );
      expectEqual(
        parity.cardsDigest,
        reference.finalDigests.cards,
        `legacy.parity[${cursor}].cardsDigest`,
      );
      expectEqual(
        parity.acknowledgementsDigest,
        reference.finalDigests.acknowledgements,
        `legacy.parity[${cursor}].acknowledgementsDigest`,
      );
      expectEqual(
        parity.conflictsDigest,
        reference.finalDigests.conflicts,
        `legacy.parity[${cursor}].conflictsDigest`,
      );
      for (const operation of V12_LEGACY_OPERATIONS) {
        const referenceObservation = reference.observations.find(
          (entry) => entry.operation === operation,
        );
        const goObservation = go.observations.find(
          (entry) => entry.operation === operation,
        );
        if (referenceObservation === undefined || goObservation === undefined)
          throw new Error('legacy operation parity source missing');
        expectEqual(
          referenceObservation.responseDigest,
          goObservation.responseDigest,
          `legacy normalized response parity ${scale}/${run}/${operation}`,
        );
      }
      cursor += 1;
    }
  }
}

function verifyReviewEnvelope(legacy: V12Evidence['legacy']): void {
  const envelope = legacy.reviewEnvelope;
  expectEqual(
    envelope.kind,
    'reference-relative-warm-p95-review-v1',
    'legacy.reviewEnvelope.kind',
  );
  expectEqual(envelope.maximumRatio, 1.2, 'legacy.reviewEnvelope.maximumRatio');
  expectEqual(
    envelope.maximumAdditiveMilliseconds,
    10,
    'legacy.reviewEnvelope.maximumAdditiveMilliseconds',
  );
  if (
    envelope.evaluations.length !==
    V12_SCALES.length * V12_REVIEWED_LEGACY_OPERATIONS.length
  ) {
    throw new Error('review envelope scale/operation matrix is incomplete');
  }
  let cursor = 0;
  for (const scale of V12_SCALES) {
    for (const operation of V12_REVIEWED_LEGACY_OPERATIONS) {
      const evaluation = envelope.evaluations[cursor];
      const reference = legacy.summaries.find(
        (summary) =>
          summary.target === 'reference' &&
          summary.scale === scale &&
          summary.operation === operation,
      );
      const go = legacy.summaries.find(
        (summary) =>
          summary.target === 'go' &&
          summary.scale === scale &&
          summary.operation === operation,
      );
      if (
        evaluation === undefined ||
        reference === undefined ||
        go === undefined
      )
        throw new Error('review envelope source missing');
      const allowed = roundedMilliseconds(
        reference.p95Milliseconds +
          Math.max(reference.p95Milliseconds * 0.2, 10),
      );
      expectEqual(
        evaluation.scale,
        scale,
        `legacy.reviewEnvelope.evaluations[${cursor}].scale`,
      );
      expectEqual(
        evaluation.operation,
        operation,
        `legacy.reviewEnvelope.evaluations[${cursor}].operation`,
      );
      expectEqual(
        evaluation.referenceP95Milliseconds,
        reference.p95Milliseconds,
        `legacy review reference ${scale}/${operation}`,
      );
      expectEqual(
        evaluation.goP95Milliseconds,
        go.p95Milliseconds,
        `legacy review Go ${scale}/${operation}`,
      );
      expectEqual(
        evaluation.allowedGoP95Milliseconds,
        allowed,
        `legacy review allowance ${scale}/${operation}`,
      );
      const assessment = classifyV12ProvisionalReview(
        go.p95Milliseconds,
        allowed,
      );
      expectEqual(
        evaluation.outcome,
        assessment.outcome,
        `legacy review outcome ${scale}/${operation}`,
      );
      expectEqual(
        evaluation.explanation,
        assessment.explanation,
        `legacy review explanation ${scale}/${operation}`,
      );
      cursor += 1;
    }
  }
}

function verifyBrowser(browser: V12Evidence['browser']): void {
  expectEqual(browser.engine, 'chromium', 'browser.engine');
  expectEqual(browser.headless, true, 'browser.headless');
  expectEqual(
    browser.harness,
    'native-connected-ui-user-perceived-regression',
    'browser.harness',
  );
  expectEqual(
    browser.backendProtocols.reference,
    'legacy-sync-v1-d1',
    'browser.backendProtocols.reference',
  );
  expectEqual(
    browser.backendProtocols.go,
    'session-context-sync-v2-postgresql-local-fixture',
    'browser.backendProtocols.go',
  );
  expectEqual(
    browser.protocolParityClaim,
    false,
    'browser.protocolParityClaim',
  );
  exactSequence(browser.scales, V12_BROWSER_SCALES, 'browser.scales');
  expectEqual(browser.runsPerCell, 5, 'browser.runsPerCell');
  const expectedRuns =
    V12_TARGETS.length * V12_BROWSER_SCALES.length * browser.runsPerCell;
  if (browser.runs.length !== expectedRuns)
    throw new Error(`browser.runs must contain ${expectedRuns} cells`);
  const stores: string[] = [];
  const processes: string[] = [];
  const runtimes: string[] = [];
  const contexts: string[] = [];
  let cursor = 0;
  for (const target of V12_TARGETS) {
    for (const scale of V12_BROWSER_SCALES) {
      for (let run = 1; run <= browser.runsPerCell; run += 1) {
        const entry = browser.runs[cursor];
        if (entry === undefined) throw new Error('browser run missing');
        expectEqual(entry.target, target, `browser.runs[${cursor}].target`);
        expectEqual(entry.scale, scale, `browser.runs[${cursor}].scale`);
        expectEqual(entry.run, run, `browser.runs[${cursor}].run`);
        expectEqual(
          entry.fullDataCardCount,
          scale,
          `browser.runs[${cursor}].fullDataCardCount`,
        );
        const expectedPages =
          target === 'reference'
            ? [scale]
            : Array.from({ length: Math.ceil(scale / 500) }, (_, pageIndex) =>
                Math.min(500, scale - pageIndex * 500),
              );
        exactSequence(
          entry.syncPageEntryCounts,
          expectedPages,
          `browser.runs[${cursor}].syncPageEntryCounts`,
        );
        expectEqual(
          entry.sessionContextStatus,
          target === 'go' ? 200 : 0,
          `browser.runs[${cursor}].sessionContextStatus`,
        );
        expectEqual(
          entry.beforeCardCount,
          scale,
          `browser.runs[${cursor}].beforeCardCount`,
        );
        expectEqual(
          entry.afterCardCount,
          scale,
          `browser.runs[${cursor}].afterCardCount`,
        );
        expectEqual(
          entry.beforeRevision,
          1,
          `browser.runs[${cursor}].beforeRevision`,
        );
        expectEqual(
          entry.afterRevision,
          2,
          `browser.runs[${cursor}].afterRevision`,
        );
        expectEqual(
          entry.pendingMutationsAfter,
          0,
          `browser.runs[${cursor}].pendingMutationsAfter`,
        );
        expectEqual(
          entry.outgoingBatchPresentAfter,
          false,
          `browser.runs[${cursor}].outgoingBatchPresentAfter`,
        );
        expectEqual(
          entry.receiptOrAcknowledgementCount,
          1,
          `browser.runs[${cursor}].receiptOrAcknowledgementCount`,
        );
        expectEqual(
          entry.responseOverridesInstalled,
          false,
          `browser.runs[${cursor}].responseOverridesInstalled`,
        );
        expectEqual(
          entry.externalNetworkGuardInstalled,
          true,
          `browser.runs[${cursor}].externalNetworkGuardInstalled`,
        );
        expectEqual(
          entry.orderedNetworkDigest,
          sha256Hex(JSON.stringify(entry.networkObservations)),
          `browser.runs[${cursor}].orderedNetworkDigest`,
        );
        const syncPath = target === 'reference' ? '/api/sync' : '/api/v2/sync';
        if (
          !entry.networkObservations.some(
            (observation) =>
              observation.phase === 'initial' && observation.path === syncPath,
          ) ||
          !entry.networkObservations.some(
            (observation) =>
              observation.phase === 'save' && observation.path === syncPath,
          )
        ) {
          throw new Error(
            `browser.runs[${cursor}] lacks native initial/save network observations`,
          );
        }
        if (
          entry.networkObservations.some(
            (observation) => observation.status !== 200,
          )
        ) {
          throw new Error(
            `browser.runs[${cursor}] contains a failed native network observation`,
          );
        }
        const sessionObservations = entry.networkObservations.filter(
          (observation) => observation.path === '/api/session-context',
        );
        if (
          (target === 'go' && sessionObservations.length === 0) ||
          (target === 'reference' && sessionObservations.length !== 0)
        ) {
          throw new Error(
            `browser.runs[${cursor}] has an invalid session-context observation set`,
          );
        }
        expectEqual(entry.uiReady, true, `browser.runs[${cursor}].uiReady`);
        expectEqual(
          entry.editedExistingCard,
          true,
          `browser.runs[${cursor}].editedExistingCard`,
        );
        expectEqual(
          entry.saveAcknowledged,
          true,
          `browser.runs[${cursor}].saveAcknowledged`,
        );
        if (entry.observations.length !== V12_BROWSER_OPERATIONS.length)
          throw new Error(
            `browser.runs[${cursor}] operation count is incomplete`,
          );
        for (const [
          observationIndex,
          operation,
        ] of V12_BROWSER_OPERATIONS.entries()) {
          const observation = entry.observations[observationIndex];
          if (observation === undefined)
            throw new Error('browser observation missing');
          expectEqual(
            observation.operation,
            operation,
            `browser.runs[${cursor}].observations[${observationIndex}].operation`,
          );
          expectEqual(
            observation.status,
            200,
            `browser.runs[${cursor}].${operation}.status`,
          );
        }
        stores.push(entry.storeIdentity);
        processes.push(entry.processIdentity);
        runtimes.push(entry.uiRuntimeIdentity);
        contexts.push(entry.browserContextIdentity);
        cursor += 1;
      }
    }
  }
  unique(stores, 'browser store identities');
  unique(processes, 'browser process identities');
  unique(runtimes, 'browser UI runtime identities');
  unique(contexts, 'browser context identities');
  for (const scale of V12_BROWSER_SCALES) {
    for (let run = 1; run <= browser.runsPerCell; run += 1) {
      const reference = browser.runs.find(
        (entry) =>
          entry.target === 'reference' &&
          entry.scale === scale &&
          entry.run === run,
      );
      const go = browser.runs.find(
        (entry) =>
          entry.target === 'go' && entry.scale === scale && entry.run === run,
      );
      if (reference === undefined || go === undefined)
        throw new Error('browser semantic parity source missing');
      expectEqual(
        reference.cardIdentityDigest,
        go.cardIdentityDigest,
        `browser same-card identity ${scale}/${run}`,
      );
      for (const operation of V12_BROWSER_OPERATIONS) {
        const referenceObservation = reference.observations.find(
          (entry) => entry.operation === operation,
        );
        const goObservation = go.observations.find(
          (entry) => entry.operation === operation,
        );
        if (referenceObservation === undefined || goObservation === undefined)
          throw new Error('browser operation parity source missing');
        expectEqual(
          referenceObservation.responseDigest,
          goObservation.responseDigest,
          `browser normalized state parity ${scale}/${run}/${operation}`,
        );
      }
    }
  }

  const expectedSummaryCount =
    V12_TARGETS.length *
    V12_BROWSER_SCALES.length *
    V12_BROWSER_OPERATIONS.length;
  if (browser.summaries.length !== expectedSummaryCount)
    throw new Error('browser summary matrix is incomplete');
  cursor = 0;
  for (const target of V12_TARGETS) {
    for (const scale of V12_BROWSER_SCALES) {
      for (const operation of V12_BROWSER_OPERATIONS) {
        const stored = browser.summaries[cursor];
        if (stored === undefined) throw new Error('browser summary missing');
        const samples = browser.runs
          .filter((entry) => entry.target === target && entry.scale === scale)
          .map((entry) => {
            const observation = entry.observations.find(
              (candidate) => candidate.operation === operation,
            );
            if (observation === undefined)
              throw new Error('browser summary source missing');
            return observation;
          });
        exactJSON(
          stored,
          summarizeV12Samples(target, scale, operation, samples),
          `browser.summaries[${cursor}]`,
        );
        cursor += 1;
      }
    }
  }

  const envelope = browser.reviewEnvelope;
  expectEqual(
    envelope.kind,
    'native-ui-reference-relative-p95-review-v1',
    'browser.reviewEnvelope.kind',
  );
  expectEqual(
    envelope.maximumRatio,
    1.2,
    'browser.reviewEnvelope.maximumRatio',
  );
  expectEqual(
    envelope.maximumAdditiveMilliseconds,
    50,
    'browser.reviewEnvelope.maximumAdditiveMilliseconds',
  );
  if (
    envelope.evaluations.length !==
    V12_BROWSER_SCALES.length * V12_BROWSER_OPERATIONS.length
  ) {
    throw new Error('browser review envelope matrix is incomplete');
  }
  cursor = 0;
  for (const scale of V12_BROWSER_SCALES) {
    for (const operation of V12_BROWSER_OPERATIONS) {
      const evaluation = envelope.evaluations[cursor];
      const reference = browser.summaries.find(
        (summary) =>
          summary.target === 'reference' &&
          summary.scale === scale &&
          summary.operation === operation,
      );
      const go = browser.summaries.find(
        (summary) =>
          summary.target === 'go' &&
          summary.scale === scale &&
          summary.operation === operation,
      );
      if (
        evaluation === undefined ||
        reference === undefined ||
        go === undefined
      )
        throw new Error('browser review source missing');
      const allowed = roundedMilliseconds(
        reference.p95Milliseconds +
          Math.max(reference.p95Milliseconds * 0.2, 50),
      );
      expectEqual(
        evaluation.scale,
        scale,
        `browser.reviewEnvelope.evaluations[${cursor}].scale`,
      );
      expectEqual(
        evaluation.operation,
        operation,
        `browser.reviewEnvelope.evaluations[${cursor}].operation`,
      );
      expectEqual(
        evaluation.referenceP95Milliseconds,
        reference.p95Milliseconds,
        `browser review reference ${scale}/${operation}`,
      );
      expectEqual(
        evaluation.goP95Milliseconds,
        go.p95Milliseconds,
        `browser review Go ${scale}/${operation}`,
      );
      expectEqual(
        evaluation.allowedGoP95Milliseconds,
        allowed,
        `browser review allowance ${scale}/${operation}`,
      );
      const assessment = classifyV12ProvisionalReview(
        go.p95Milliseconds,
        allowed,
      );
      expectEqual(
        evaluation.outcome,
        assessment.outcome,
        `browser review outcome ${scale}/${operation}`,
      );
      expectEqual(
        evaluation.explanation,
        assessment.explanation,
        `browser review explanation ${scale}/${operation}`,
      );
      cursor += 1;
    }
  }
}

function verifySyncV2(syncV2: V12Evidence['syncV2']): void {
  expectEqual(syncV2.entries, 10_000, 'syncV2.entries');
  expectEqual(syncV2.pageSize, 500, 'syncV2.pageSize');
  expectEqual(syncV2.pageCount, 20, 'syncV2.pageCount');
  expectEqual(syncV2.deltaEntries, 1, 'syncV2.deltaEntries');
  expectEqual(syncV2.runsPerScenario, 5, 'syncV2.runsPerScenario');
  if (syncV2.warmupsBeforeWarmFull < 3)
    throw new Error('Sync v2 warm full requires at least three warmups');
  expectEqual(syncV2.poolLimit, 16, 'syncV2.poolLimit');
  expectEqual(
    syncV2.querySource,
    'instrumented-pgx-query-and-batch-tracer',
    'syncV2.querySource',
  );
  expectEqual(
    syncV2.memoryScope,
    'linux-process-smaps-rollup-rss-pss-bytes',
    'syncV2.memoryScope',
  );
  if (syncV2.runs.length !== syncV2.runsPerScenario)
    throw new Error('Sync v2 run matrix is incomplete');
  unique(
    syncV2.runs.map((run) => run.storeIdentity),
    'Sync v2 store identities',
  );
  for (let index = 0; index < syncV2.runsPerScenario; index += 1) {
    const run = syncV2.runs[index];
    if (run === undefined) throw new Error('Sync v2 run missing');
    expectEqual(run.run, index + 1, `syncV2.runs[${index}].run`);
    verifyObservations(
      run.observations,
      V12_SYNC_OPERATIONS,
      `syncV2.runs[${index}]`,
    );
    exactSequence(
      run.traversal.coldPageEntryCounts,
      Array(20).fill(500),
      `syncV2.runs[${index}].cold pages`,
    );
    exactSequence(
      run.traversal.warmPageEntryCounts,
      Array(20).fill(500),
      `syncV2.runs[${index}].warm pages`,
    );
    expectEqual(
      run.traversal.coldUniqueEntries,
      10_000,
      `syncV2.runs[${index}].coldUniqueEntries`,
    );
    expectEqual(
      run.traversal.warmUniqueEntries,
      10_000,
      `syncV2.runs[${index}].warmUniqueEntries`,
    );
    expectEqual(
      run.traversal.duplicateEntries,
      0,
      `syncV2.runs[${index}].duplicateEntries`,
    );
    expectEqual(
      run.traversal.missingEntries,
      0,
      `syncV2.runs[${index}].missingEntries`,
    );
    expectEqual(
      run.traversal.fixedHighWatermark,
      true,
      `syncV2.runs[${index}].fixedHighWatermark`,
    );
    expectEqual(
      run.traversal.deltaChanges,
      1,
      `syncV2.runs[${index}].deltaChanges`,
    );
    expectEqual(
      run.traversal.coldDigest,
      run.traversal.warmDigest,
      `syncV2.runs[${index}] cold/warm digest`,
    );
  }
  verifySyncSummaries(syncV2);
  if (syncV2.concurrency.length !== syncV2.runsPerScenario) {
    throw new Error('Sync v2 concurrency requires five fresh-store runs');
  }
  unique(
    syncV2.concurrency.map((run) => run.storeIdentity),
    'Sync v2 concurrency store identities',
  );
  for (const [index, concurrency] of syncV2.concurrency.entries()) {
    expectEqual(concurrency.run, index + 1, `syncV2.concurrency[${index}].run`);
    verifyConcurrency(concurrency, index);
  }
  const concurrencySamples = syncV2.concurrency.map((run) => ({
    durationMilliseconds: run.durationMilliseconds,
    status: run.errorCount === 0 ? 200 : 500,
  }));
  exactJSON(
    syncV2.concurrencySummary,
    summarizeV12Samples(
      'sync-v2-go',
      100,
      'concurrent-100',
      concurrencySamples,
    ),
    'syncV2.concurrencySummary',
  );
  const requestSamples = syncV2.concurrency.flatMap((run) =>
    run.observations.map((observation) => ({
      durationMilliseconds: observation.durationMilliseconds,
      status: observation.status,
    })),
  );
  exactJSON(
    syncV2.requestLatencySummary,
    summarizeV12Samples(
      'sync-v2-go',
      100,
      'concurrent-request',
      requestSamples,
    ),
    'syncV2.requestLatencySummary',
  );
}

function verifySyncSummaries(syncV2: V12Evidence['syncV2']): void {
  if (syncV2.summaries.length !== V12_SYNC_OPERATIONS.length)
    throw new Error('Sync v2 summaries are incomplete');
  for (const [index, operation] of V12_SYNC_OPERATIONS.entries()) {
    const stored = syncV2.summaries[index];
    if (stored === undefined) throw new Error('Sync v2 summary missing');
    const samples = syncV2.runs.map((run) => {
      const observation = run.observations.find(
        (entry) => entry.operation === operation,
      );
      if (observation === undefined)
        throw new Error('Sync v2 summary source missing');
      return observation;
    });
    const computed = summarizeV12Samples(
      'sync-v2-go',
      10_000,
      operation,
      samples,
    );
    exactJSON(stored, computed, `syncV2.summaries[${index}]`);
  }
}

function verifyConcurrency(
  concurrency: V12Evidence['syncV2']['concurrency'][number],
  runIndex: number,
): void {
  const prefix = `syncV2.concurrency[${runIndex}]`;
  for (const [name, value] of [
    ['requests', concurrency.requests],
    ['barrierParticipants', concurrency.barrierParticipants],
    ['independentVaults', concurrency.independentVaults],
    ['independentSessions', concurrency.independentSessions],
    ['independentDevices', concurrency.independentDevices],
    ['maximumHTTPConcurrency', concurrency.maximumHTTPConcurrency],
    [
      'admittedApplicationConcurrency',
      concurrency.admittedApplicationConcurrency,
    ],
  ] as const) {
    expectEqual(value, 100, `${prefix}.${name}`);
  }
  expectEqual(concurrency.poolLimit, 16, `${prefix}.poolLimit`);
  expectEqual(
    concurrency.applicationSerializationShim,
    false,
    `${prefix}.applicationSerializationShim`,
  );
  if (
    concurrency.maximumApplicationConcurrency < 2 ||
    concurrency.maximumApplicationConcurrency > 100
  ) {
    throw new Error(
      `${prefix}.maximumApplicationConcurrency must prove overlapping inner application work`,
    );
  }
  if (
    concurrency.maximumDatabaseConcurrency < 1 ||
    concurrency.maximumDatabaseConcurrency > 16
  ) {
    throw new Error(
      `${prefix}.maximumDatabaseConcurrency must be within the real pool limit`,
    );
  }
  expectEqual(
    concurrency.tenantScopeViolations,
    0,
    `${prefix}.tenantScopeViolations`,
  );
  expectEqual(concurrency.errorCount, 0, `${prefix}.errorCount`);
  for (const [name, value] of [
    ['durableCommits', concurrency.durableCommits],
    ['durableCards', concurrency.durableCards],
    ['encryptedMetadataRows', concurrency.encryptedMetadataRows],
    ['quotaCommittedReservations', concurrency.quotaCommittedReservations],
    ['objectWrites', concurrency.objectWrites],
    ['encryptions', concurrency.encryptions],
  ] as const) {
    expectEqual(value, 100, `${prefix}.${name}`);
  }
  if (concurrency.pssBytes > concurrency.rssBytes)
    throw new Error('Sync v2 concurrency PSS exceeds RSS');
  if (concurrency.observations.length !== 100)
    throw new Error('Sync v2 concurrency requires 100 raw observations');
  for (const [index, observation] of concurrency.observations.entries()) {
    expectEqual(
      observation.requestIndex,
      index,
      `${prefix}.observations[${index}].requestIndex`,
    );
    expectEqual(
      observation.status,
      200,
      `${prefix}.observations[${index}].status`,
    );
    if (observation.responseBytes === 0 || observation.queryCount === 0) {
      throw new Error(
        `Sync v2 concurrency observation ${index} lacks response/query evidence`,
      );
    }
  }
}

function rejectSensitiveStrings(evidence: V12Evidence): void {
  const serialized = JSON.stringify(evidence);
  const rejected = [
    /postgres(?:ql)?:\/\//iu,
    /https?:\/\//iu,
    /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/iu,
    /(?:password|secret|authorization|cookie|session-token|identity-assertion)\s*[:=]/iu,
  ];
  for (const pattern of rejected) {
    if (pattern.test(serialized))
      throw new Error(
        `evidence contains forbidden material matching ${pattern.source}`,
      );
  }
}

function exactRecord(
  value: unknown,
  name: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  const record = Object.fromEntries(Object.entries(value));
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${name} has missing or unknown fields`);
  return record;
}

function array(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function countArray(value: unknown, name: string): readonly number[] {
  return array(value, name).map((entry, index) =>
    integer(entry, `${name}[${index}]`, 0),
  );
}

function text(
  value: unknown,
  name: string,
  maximum: number,
  empty = false,
): string {
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    (!empty && value.length === 0) ||
    containsControlCharacter(value)
  ) {
    throw new Error(`${name} must be a bounded printable string`);
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) return true;
  }
  return false;
}

function identifier(value: unknown, name: string): string {
  const result = text(value, name, 128);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(result))
    throw new Error(`${name} must be a safe identifier`);
  return result;
}

function digest(value: unknown, name: string, length: 40 | 64): string {
  if (
    typeof value !== 'string' ||
    !new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(value)
  )
    throw new Error(`${name} must be a lowercase hexadecimal digest`);
  return value;
}

function integer(value: unknown, name: string, minimum: number): number {
  if (
    !Number.isSafeInteger(value) ||
    typeof value !== 'number' ||
    value < minimum
  )
    throw new Error(`${name} must be a safe integer >= ${minimum}`);
  return value;
}

function finite(value: unknown, name: string, positive: boolean): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (positive ? value <= 0 : value < 0)
  )
    throw new Error(
      `${name} must be a finite ${positive ? 'positive' : 'non-negative'} number`,
    );
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

function enumeration<Value extends string>(
  value: unknown,
  name: string,
  values: readonly Value[],
): Value {
  if (typeof value !== 'string')
    throw new Error(`${name} must be an allowed string`);
  for (const allowed of values) if (value === allowed) return allowed;
  throw new Error(`${name} must be an allowed string`);
}

function unique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length)
    throw new Error(`${name} must be unique`);
}

function exactSequence<Value>(
  actual: readonly Value[],
  expected: readonly Value[],
  name: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${name} has unexpected order or values`);
}

function exactJSON(actual: unknown, expected: unknown, name: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${name} does not match recomputed evidence`);
}

function expectEqual(actual: unknown, expected: unknown, name: string): void {
  if (actual !== expected)
    throw new Error(
      `${name} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
}

function roundedMilliseconds(value: number): number {
  return Number(value.toFixed(3));
}

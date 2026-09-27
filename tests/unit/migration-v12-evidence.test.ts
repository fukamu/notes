import { describe, expect, it } from 'vitest';
import {
  classifyV12ProvisionalReview,
  decodeV12Evidence,
  nearestRank,
  sha256Hex,
  summarizeV12Samples,
  verifyV12GitProvenance,
  verifyV12SourceContent,
  V12_BROWSER_SCALES,
  V12_INTEGRATION_BRANCH_POINT,
  V12_BROWSER_OPERATIONS,
  V12_LEGACY_OPERATIONS,
  V12_REFERENCE_REVISION,
  V12_REVIEWED_LEGACY_OPERATIONS,
  V12_RETIREMENT_REVISION,
  V12_RUNNER_VERSION,
  V12_SCALES,
  V12_SOURCE_PATHS,
  V12_SYNC_OPERATIONS,
  V12_TARGETS,
} from '../../scripts/migration-v12-evidence-core.mts';

describe('V12 local performance evidence', () => {
  it('strictly decodes the complete deterministic matrix', () => {
    const evidence = validEvidence();
    expect(decodeV12Evidence(evidence)).toEqual(evidence);
  });

  it('uses nearest-rank p50 and p95 without dropping raw samples', () => {
    expect(nearestRank([9, 1, 5, 3, 7], 0.5)).toBe(5);
    expect(nearestRank([9, 1, 5, 3, 7], 0.95)).toBe(9);
    expect(
      summarizeV12Samples('go', 100, 'warm-full-sync', [
        { durationMilliseconds: 1.1114, status: 200 },
        { durationMilliseconds: 2.2224, status: 200 },
        { durationMilliseconds: 3.3334, status: 500 },
        { durationMilliseconds: 4.4444, status: 200 },
        { durationMilliseconds: 5.5554, status: 200 },
      ]),
    ).toEqual({
      target: 'go',
      scale: 100,
      operation: 'warm-full-sync',
      sampleCount: 5,
      p50Milliseconds: 3.333,
      p95Milliseconds: 5.555,
      errorCount: 1,
      errorRate: 0.2,
    });
  });

  it('records provisional-envelope excess as review evidence, not a hard failure', () => {
    expect(classifyV12ProvisionalReview(120, 100)).toEqual({
      outcome: 'review-needed',
      explanation:
        'Measured p95 exceeds the provisional local review guideline; inspect run variance and user impact before deciding whether remediation is needed.',
    });
    expect(classifyV12ProvisionalReview(100, 100)).toEqual({
      outcome: 'within-guideline',
      explanation: '',
    });
  });

  it('rejects missing, unknown, duplicate, and reused matrix identities', () => {
    const unknown = validEvidence();
    Object.assign(required(unknown.legacy.runs[0], 'first legacy run'), {
      unexpected: true,
    });
    expect(() => decodeV12Evidence(unknown)).toThrow(
      'missing or unknown fields',
    );

    const missing = validEvidence();
    missing.legacy.runs.pop();
    expect(() => decodeV12Evidence(missing)).toThrow(
      'legacy.runs must contain 30 cells',
    );

    const duplicate = validEvidence();
    required(duplicate.legacy.runs[1], 'second legacy run').storeIdentity =
      required(duplicate.legacy.runs[0], 'first legacy run').storeIdentity;
    expect(() => decodeV12Evidence(duplicate)).toThrow(
      'legacy store identities must be unique',
    );

    const reusedProcess = validEvidence();
    required(
      reusedProcess.legacy.runs[1],
      'second legacy run',
    ).processIdentity = required(
      reusedProcess.legacy.runs[0],
      'first legacy run',
    ).processIdentity;
    expect(() => decodeV12Evidence(reusedProcess)).toThrow(
      'legacy process identities must be unique',
    );
  });

  it('rejects tampered raw summaries, parity, and batch cardinality', () => {
    const summary = validEvidence();
    const firstSummary = required(
      summary.legacy.summaries[0],
      'first legacy summary',
    );
    Object.assign(firstSummary, {
      p95Milliseconds: firstSummary.p95Milliseconds + 0.001,
    });
    expect(() => decodeV12Evidence(summary)).toThrow(
      'does not match recomputed evidence',
    );

    const parity = validEvidence();
    required(parity.legacy.runs[15], 'Go parity run').finalDigests.cards =
      sha256Hex('tampered');
    expect(() => decodeV12Evidence(parity)).toThrow('legacy parity cards');

    const batch = validEvidence();
    required(batch.legacy.runs[0], 'first legacy run').batchDistinctCards = 499;
    expect(() => decodeV12Evidence(batch)).toThrow('batchDistinctCards');
  });

  it('rejects incomplete page traversal and serialized concurrency', () => {
    const page = validEvidence();
    required(
      page.syncV2.runs[0],
      'first sync run',
    ).traversal.coldPageEntryCounts[19] = 499;
    expect(() => decodeV12Evidence(page)).toThrow('cold pages');

    const concurrency = validEvidence();
    required(
      concurrency.syncV2.concurrency[0],
      'first concurrency run',
    ).maximumApplicationConcurrency = 1;
    expect(() => decodeV12Evidence(concurrency)).toThrow(
      'maximumApplicationConcurrency',
    );

    const shim = validEvidence();
    required(
      shim.syncV2.concurrency[0],
      'first concurrency run',
    ).applicationSerializationShim = true;
    expect(() => decodeV12Evidence(shim)).toThrow(
      'applicationSerializationShim',
    );
  });

  it('rejects detached query, browser, and durable concurrency evidence', () => {
    const queryDigest = validEvidence();
    required(
      required(queryDigest.legacy.runs[0], 'first legacy run')
        .queryResponseDigests[0],
      'first query response digest',
    ).responseDigest = sha256Hex('detached-query-response');
    expect(() => decodeV12Evidence(queryDigest)).toThrow(
      'query/timed response digest',
    );

    const queryStore = validEvidence();
    required(
      queryStore.legacy.runs[1],
      'second legacy run',
    ).queryObservationStoreIdentity = required(
      queryStore.legacy.runs[0],
      'first legacy run',
    ).queryObservationStoreIdentity;
    expect(() => decodeV12Evidence(queryStore)).toThrow(
      'legacy query store identities must be unique',
    );

    const browserState = validEvidence();
    required(
      required(
        browserState.browser.runs[V12_BROWSER_SCALES.length * 5],
        'Go browser run',
      ).observations[0],
      'browser observation',
    ).responseDigest = sha256Hex('detached-browser-state');
    expect(() => decodeV12Evidence(browserState)).toThrow(
      'browser normalized state parity',
    );

    const browserRuntime = validEvidence();
    required(
      browserRuntime.browser.runs[1],
      'second browser run',
    ).uiRuntimeIdentity = required(
      browserRuntime.browser.runs[0],
      'first browser run',
    ).uiRuntimeIdentity;
    expect(() => decodeV12Evidence(browserRuntime)).toThrow(
      'browser UI runtime identities must be unique',
    );

    const browserNetwork = validEvidence();
    required(
      required(browserNetwork.browser.runs[0], 'first browser run')
        .networkObservations[0],
      'first browser network observation',
    ).responseDigest = sha256Hex('tampered-network');
    expect(() => decodeV12Evidence(browserNetwork)).toThrow(
      'orderedNetworkDigest',
    );

    const durable = validEvidence();
    required(
      durable.syncV2.concurrency[0],
      'first concurrency run',
    ).durableCards = 99;
    expect(() => decodeV12Evidence(durable)).toThrow('durableCards');

    const requestSummary = validEvidence();
    requestSummary.syncV2.requestLatencySummary = {
      ...requestSummary.syncV2.requestLatencySummary,
      p95Milliseconds:
        requestSummary.syncV2.requestLatencySummary.p95Milliseconds + 1,
    };
    expect(() => decodeV12Evidence(requestSummary)).toThrow(
      'requestLatencySummary',
    );
  });

  it('rejects remote targets, credentials, and identity material in evidence strings', () => {
    for (const forbidden of [
      'https://remote.example',
      'postgres://user:value@127.0.0.1/database',
      'password: recorded-value',
    ]) {
      const evidence = validEvidence();
      evidence.host.cpuModel = forbidden;
      expect(() => decodeV12Evidence(evidence)).toThrow('forbidden material');
    }
  });

  it('rejects stale runner, fixture, and source digests', () => {
    const sourceContent = new Map<string, string>(
      V12_SOURCE_PATHS.map((sourcePath) => [
        sourcePath,
        `content:${sourcePath}`,
      ]),
    );
    const evidence = validEvidence(sourceContent);
    const decoded = decodeV12Evidence(evidence);
    expect(() => verifyV12SourceContent(decoded, sourceContent)).not.toThrow();

    const stale = new Map(sourceContent);
    stale.set(V12_SOURCE_PATHS[0], 'changed fixture');
    expect(() => verifyV12SourceContent(decoded, stale)).toThrow(
      'remeasure instead of relabelling stale evidence',
    );

    const unknown = new Map(sourceContent);
    unknown.set('scripts/unknown-observer.mts', 'unknown');
    expect(() => verifyV12SourceContent(decoded, unknown)).toThrow(
      'unknown or duplicate path',
    );
  });

  it('binds producer blobs to a real measured commit and its ancestry', async () => {
    const sourceContent = new Map<string, string>(
      V12_SOURCE_PATHS.map((sourcePath) => [
        sourcePath,
        `content:${sourcePath}`,
      ]),
    );
    const evidence = decodeV12Evidence(validEvidence(sourceContent));
    const currentHead = '2222222222222222222222222222222222222222';
    const measured = evidence.identity.measuredGoRevision;
    const reader = {
      commitExists: async (revision: string) =>
        revision === measured || revision === currentHead,
      isAncestor: async (ancestor: string, descendant: string) =>
        (ancestor === V12_INTEGRATION_BRANCH_POINT &&
          descendant === measured) ||
        (ancestor === measured && descendant === currentHead),
      treeObjectId: async () => evidence.identity.measuredGoTreeObjectId,
      readBlob: async (_revision: string, sourcePath: string) =>
        new TextEncoder().encode(
          required(sourceContent.get(sourcePath), 'source content'),
        ),
    };
    await expect(
      verifyV12GitProvenance(evidence, currentHead, reader),
    ).resolves.toBeUndefined();

    await expect(
      verifyV12GitProvenance(evidence, currentHead, {
        ...reader,
        commitExists: async () => false,
      }),
    ).rejects.toThrow('does not resolve to a local commit');

    await expect(
      verifyV12GitProvenance(evidence, currentHead, {
        ...reader,
        isAncestor: async () => false,
      }),
    ).rejects.toThrow('not an ancestor');

    await expect(
      verifyV12GitProvenance(evidence, currentHead, {
        ...reader,
        readBlob: async () => new TextEncoder().encode('tampered'),
      }),
    ).rejects.toThrow('remeasure from a committed producer tree');
  });
});

function validEvidence(
  sourceContent: ReadonlyMap<string, string> = new Map<string, string>(
    V12_SOURCE_PATHS.map((sourcePath) => [sourcePath, `content:${sourcePath}`]),
  ),
) {
  const legacyRuns = V12_TARGETS.flatMap((target) =>
    V12_SCALES.flatMap((scale) =>
      Array.from({ length: 5 }, (_, runIndex) => {
        const run = runIndex + 1;
        const final = {
          cards: sha256Hex(`${scale}/${run}/cards`),
          acknowledgements: sha256Hex(`${scale}/${run}/acknowledgements`),
          conflicts: sha256Hex(`${scale}/${run}/conflicts`),
        };
        return {
          target,
          scale,
          run,
          storeIdentity: `${target}-s${scale}-r${run}-store`,
          processIdentity: `${target}-s${scale}-r${run}-process`,
          queryObservationIdentity: `${target}-s${scale}-r${run}-query-observation`,
          queryObservationTarget: target,
          queryObservationScale: scale,
          queryObservationRun: run,
          queryObservationStoreIdentity: `${target}-s${scale}-r${run}-query-store`,
          queryObservationProcessIdentity: `${target}-s${scale}-r${run}-query-process`,
          queryObservationStartTicks:
            40_000_000 + scale * 10 + run + (target === 'go' ? 1_000_000 : 0),
          processStartTicks:
            10_000_000 + scale * 10 + run + (target === 'go' ? 1_000_000 : 0),
          queryResponseDigests: V12_LEGACY_OPERATIONS.filter(
            (operation) => operation !== 'cold-start',
          ).map((operation) => ({
            operation,
            responseDigest: sha256Hex(`${scale}/${run}/${operation}`),
          })),
          initialCards: scale,
          beforeBatchCards: scale,
          afterBatchCards: scale + 500,
          batchDistinctCards: 500,
          batchAcknowledged: 500,
          observations: V12_LEGACY_OPERATIONS.map(
            (operation, operationIndex) => ({
              operation,
              durationMilliseconds:
                (target === 'reference' ? 10 : 5) +
                scale / 10_000 +
                runIndex +
                operationIndex / 10,
              status: 200,
              responseBytes:
                operation === 'cold-start' ? 0 : scale + operationIndex + 1,
              queryCount: queryCountForFixture(target, operation),
              rssBytes: 100_000_000 + scale + operationIndex,
              pssBytes: 90_000_000 + scale + operationIndex,
              responseDigest: sha256Hex(
                operation === 'cold-start'
                  ? ''
                  : `${scale}/${run}/${operation}`,
              ),
            }),
          ),
          finalDigests: final,
        };
      }),
    ),
  );
  const legacySummaries = V12_TARGETS.flatMap((target) =>
    V12_SCALES.flatMap((scale) =>
      V12_LEGACY_OPERATIONS.map((operation) =>
        summarizeV12Samples(
          target,
          scale,
          operation,
          legacyRuns
            .filter((run) => run.target === target && run.scale === scale)
            .map((run) =>
              required(
                run.observations.find((entry) => entry.operation === operation),
                'legacy summary observation',
              ),
            ),
        ),
      ),
    ),
  );
  const legacyParity = V12_SCALES.flatMap((scale) =>
    Array.from({ length: 5 }, (_, runIndex) => {
      const run = runIndex + 1;
      return {
        scale,
        run,
        cardsDigest: sha256Hex(`${scale}/${run}/cards`),
        acknowledgementsDigest: sha256Hex(`${scale}/${run}/acknowledgements`),
        conflictsDigest: sha256Hex(`${scale}/${run}/conflicts`),
        matches: true,
      };
    }),
  );
  const browserRuns = V12_TARGETS.flatMap((target) =>
    V12_BROWSER_SCALES.flatMap((scale) =>
      Array.from({ length: 5 }, (_, runIndex) => {
        const run = runIndex + 1;
        const syncPath = target === 'reference' ? '/api/sync' : '/api/v2/sync';
        const networkObservations = [
          ...(target === 'go'
            ? [
                {
                  phase: 'initial' as const,
                  path: '/api/session-context',
                  status: 200,
                  responseDigest: sha256Hex(`browser-session/${scale}/${run}`),
                },
              ]
            : []),
          {
            phase: 'initial' as const,
            path: syncPath,
            status: 200,
            responseDigest: sha256Hex(
              `browser-initial-network/${target}/${scale}/${run}`,
            ),
          },
          {
            phase: 'save' as const,
            path: syncPath,
            status: 200,
            responseDigest: sha256Hex(
              `browser-save-network/${target}/${scale}/${run}`,
            ),
          },
        ];
        return {
          target,
          scale,
          run,
          storeIdentity: `browser-${target}-s${scale}-r${run}-store`,
          processIdentity: `browser-${target}-s${scale}-r${run}-process`,
          processStartTicks:
            30_000_000 + scale * 10 + run + (target === 'go' ? 1_000_000 : 0),
          uiRuntimeIdentity: `browser-${target}-s${scale}-r${run}-ui-runtime`,
          browserContextIdentity: `browser-${target}-s${scale}-r${run}-context`,
          fullDataCardCount: scale,
          syncPageEntryCounts:
            target === 'reference'
              ? [scale]
              : Array.from({ length: Math.ceil(scale / 500) }, (_, pageIndex) =>
                  Math.min(500, scale - pageIndex * 500),
                ),
          sessionContextStatus: target === 'go' ? 200 : 0,
          beforeCardCount: scale,
          afterCardCount: scale,
          beforeRevision: 1,
          afterRevision: 2,
          pendingMutationsAfter: 0,
          outgoingBatchPresentAfter: false,
          receiptOrAcknowledgementCount: 1,
          cardIdentityDigest: sha256Hex(`browser-card/${scale}/${run}`),
          orderedNetworkDigest: sha256Hex(JSON.stringify(networkObservations)),
          networkObservations,
          responseOverridesInstalled: false,
          externalNetworkGuardInstalled: true,
          uiReady: true,
          editedExistingCard: true,
          saveAcknowledged: true,
          observations: V12_BROWSER_OPERATIONS.map(
            (operation, operationIndex) => ({
              operation,
              durationMilliseconds:
                (target === 'reference' ? 100 : 90) +
                scale / 1_000 +
                runIndex +
                operationIndex,
              status: 200,
              responseDigest: sha256Hex(`browser/${scale}/${run}/${operation}`),
            }),
          ),
        };
      }),
    ),
  );
  const browserSummaries = V12_TARGETS.flatMap((target) =>
    V12_BROWSER_SCALES.flatMap((scale) =>
      V12_BROWSER_OPERATIONS.map((operation) =>
        summarizeV12Samples(
          target,
          scale,
          operation,
          browserRuns
            .filter((run) => run.target === target && run.scale === scale)
            .map((run) =>
              required(
                run.observations.find((entry) => entry.operation === operation),
                'browser summary observation',
              ),
            ),
        ),
      ),
    ),
  );
  const syncRuns = Array.from({ length: 5 }, (_, runIndex) => ({
    run: runIndex + 1,
    storeIdentity: `sync-v2-r${runIndex + 1}-store`,
    observations: V12_SYNC_OPERATIONS.map((operation, operationIndex) => ({
      operation,
      durationMilliseconds: 20 + runIndex + operationIndex / 10,
      status: 200,
      responseBytes: 1_000 + operationIndex,
      queryCount: 20 + operationIndex,
      rssBytes: 200_000_000 + operationIndex,
      pssBytes: 180_000_000 + operationIndex,
      responseDigest: sha256Hex(`sync/${runIndex}/${operation}`),
    })),
    traversal: {
      coldPageEntryCounts: Array(20).fill(500),
      warmPageEntryCounts: Array(20).fill(500),
      coldUniqueEntries: 10_000,
      warmUniqueEntries: 10_000,
      duplicateEntries: 0,
      missingEntries: 0,
      fixedHighWatermark: true,
      deltaChanges: 1,
      coldDigest: sha256Hex(`sync/${runIndex}/full`),
      warmDigest: sha256Hex(`sync/${runIndex}/full`),
      deltaDigest: sha256Hex(`sync/${runIndex}/delta`),
    },
  }));
  const syncSummaries = V12_SYNC_OPERATIONS.map((operation) =>
    summarizeV12Samples(
      'sync-v2-go',
      10_000,
      operation,
      syncRuns.map((run) =>
        required(
          run.observations.find((entry) => entry.operation === operation),
          'Sync summary observation',
        ),
      ),
    ),
  );
  const reviewEvaluations = V12_SCALES.flatMap((scale) =>
    V12_REVIEWED_LEGACY_OPERATIONS.map((operation) => {
      const reference = required(
        legacySummaries.find(
          (summary) =>
            summary.target === 'reference' &&
            summary.scale === scale &&
            summary.operation === operation,
        ),
        'reference legacy summary',
      );
      const go = required(
        legacySummaries.find(
          (summary) =>
            summary.target === 'go' &&
            summary.scale === scale &&
            summary.operation === operation,
        ),
        'Go legacy summary',
      );
      return {
        scale,
        operation,
        referenceP95Milliseconds: reference.p95Milliseconds,
        goP95Milliseconds: go.p95Milliseconds,
        allowedGoP95Milliseconds: Number(
          (
            reference.p95Milliseconds +
            Math.max(reference.p95Milliseconds * 0.2, 10)
          ).toFixed(3),
        ),
        ...classifyV12ProvisionalReview(
          go.p95Milliseconds,
          Number(
            (
              reference.p95Milliseconds +
              Math.max(reference.p95Milliseconds * 0.2, 10)
            ).toFixed(3),
          ),
        ),
      };
    }),
  );
  const browserReviewEvaluations = V12_BROWSER_SCALES.flatMap((scale) =>
    V12_BROWSER_OPERATIONS.map((operation) => {
      const reference = required(
        browserSummaries.find(
          (summary) =>
            summary.target === 'reference' &&
            summary.scale === scale &&
            summary.operation === operation,
        ),
        'reference browser summary',
      );
      const go = required(
        browserSummaries.find(
          (summary) =>
            summary.target === 'go' &&
            summary.scale === scale &&
            summary.operation === operation,
        ),
        'Go browser summary',
      );
      return {
        scale,
        operation,
        referenceP95Milliseconds: reference.p95Milliseconds,
        goP95Milliseconds: go.p95Milliseconds,
        allowedGoP95Milliseconds: Number(
          (
            reference.p95Milliseconds +
            Math.max(reference.p95Milliseconds * 0.2, 50)
          ).toFixed(3),
        ),
        ...classifyV12ProvisionalReview(
          go.p95Milliseconds,
          Number(
            (
              reference.p95Milliseconds +
              Math.max(reference.p95Milliseconds * 0.2, 50)
            ).toFixed(3),
          ),
        ),
      };
    }),
  );
  const concurrencyRuns = Array.from({ length: 5 }, (_, runIndex) => ({
    run: runIndex + 1,
    storeIdentity: `sync-v2-concurrency-r${runIndex + 1}-store`,
    requests: 100,
    barrierParticipants: 100,
    independentVaults: 100,
    independentSessions: 100,
    independentDevices: 100,
    poolLimit: 16,
    applicationSerializationShim: false,
    maximumHTTPConcurrency: 100,
    admittedApplicationConcurrency: 100,
    maximumApplicationConcurrency: 80,
    maximumDatabaseConcurrency: 16,
    tenantScopeViolations: 0,
    errorCount: 0,
    durableCommits: 100,
    durableCards: 100,
    encryptedMetadataRows: 100,
    quotaCommittedReservations: 100,
    objectWrites: 100,
    encryptions: 100,
    durationMilliseconds: 50 + runIndex,
    rssBytes: 250_000_000 + runIndex,
    pssBytes: 225_000_000 + runIndex,
    observations: Array.from({ length: 100 }, (_, requestIndex) => ({
      requestIndex,
      durationMilliseconds: 10 + requestIndex / 100,
      status: 200,
      responseBytes: 100,
      queryCount: 5,
    })),
  }));
  return {
    schemaVersion: 1,
    evidenceKind: 'local-v12-performance',
    identity: {
      issue: 525,
      measuredAt: '2026-09-27T00:00:00.000Z',
      runnableReferenceRevision: V12_REFERENCE_REVISION,
      frozenRetirementRevision: V12_RETIREMENT_REVISION,
      integrationBranchPoint: V12_INTEGRATION_BRANCH_POINT,
      measuredGoRevision: '1111111111111111111111111111111111111111',
      measuredGoTreeObjectId: '3333333333333333333333333333333333333333',
      runnerVersion: V12_RUNNER_VERSION,
      referenceHandlerSha256: sha256Hex('reference-handler'),
      referenceObserverSha256: sha256Hex('reference-observer'),
      referencePatchedHandlerSha256: sha256Hex('reference-patched-handler'),
      runtimeArtifacts: {
        goNotesBinarySha256: sha256Hex('go-notes'),
        goNotesctlBinarySha256: sha256Hex('go-notesctl'),
        goQueryCompanionBinarySha256: sha256Hex('go-query-companion'),
        goFrontendBuildSha256: sha256Hex('go-frontend'),
        referenceFrontendBuildSha256: sha256Hex('reference-frontend'),
        referenceQueryBuildSha256: sha256Hex('reference-query'),
      },
      sourceDigests: V12_SOURCE_PATHS.map((sourcePath) => ({
        path: sourcePath,
        sha256: sha256Hex(sourceContent.get(sourcePath) ?? ''),
      })),
    },
    host: {
      os: 'linux',
      architecture: 'x64',
      kernel: 'fixture-kernel',
      cpuModel: 'fixture-cpu',
      logicalCpus: 8,
      nodeVersion: 'v24.0.0',
      npmVersion: '11.0.0',
      wranglerVersion: '4.0.0',
      miniflareVersion: '4.0.0',
      chromiumVersion: 'Chromium 140.0.0.0',
      goVersion: 'go1.27.0',
      postgresqlVersion: 'PostgreSQL 18.0',
      totalMemoryBytes: 16_000_000_000,
    },
    safety: {
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
    },
    legacy: {
      scales: [...V12_SCALES],
      runsPerCell: 5,
      warmupsBeforeWarmFull: 3,
      batchSize: 500,
      querySources: {
        reference: 'instrumented-d1-statement-observer',
        go: 'instrumented-pgx-query-and-batch-tracer',
      },
      memoryScope: 'linux-process-group-smaps-rollup-rss-pss-bytes',
      runs: legacyRuns,
      summaries: legacySummaries,
      parity: legacyParity,
      reviewEnvelope: {
        kind: 'reference-relative-warm-p95-review-v1',
        maximumRatio: 1.2,
        maximumAdditiveMilliseconds: 10,
        evaluations: reviewEvaluations,
      },
    },
    browser: {
      engine: 'chromium',
      headless: true,
      harness: 'native-connected-ui-user-perceived-regression',
      backendProtocols: {
        reference: 'legacy-sync-v1-d1',
        go: 'session-context-sync-v2-postgresql-local-fixture',
      },
      protocolParityClaim: false,
      scales: [...V12_BROWSER_SCALES],
      runsPerCell: 5,
      runs: browserRuns,
      summaries: browserSummaries,
      reviewEnvelope: {
        kind: 'native-ui-reference-relative-p95-review-v1',
        maximumRatio: 1.2,
        maximumAdditiveMilliseconds: 50,
        evaluations: browserReviewEvaluations,
      },
    },
    syncV2: {
      entries: 10_000,
      pageSize: 500,
      pageCount: 20,
      deltaEntries: 1,
      runsPerScenario: 5,
      warmupsBeforeWarmFull: 3,
      poolLimit: 16,
      querySource: 'instrumented-pgx-query-and-batch-tracer',
      memoryScope: 'linux-process-smaps-rollup-rss-pss-bytes',
      runs: syncRuns,
      summaries: syncSummaries,
      concurrency: concurrencyRuns,
      concurrencySummary: summarizeV12Samples(
        'sync-v2-go',
        100,
        'concurrent-100',
        concurrencyRuns.map((run) => ({
          durationMilliseconds: run.durationMilliseconds,
          status: 200,
        })),
      ),
      requestLatencySummary: summarizeV12Samples(
        'sync-v2-go',
        100,
        'concurrent-request',
        concurrencyRuns.flatMap((run) =>
          run.observations.map((observation) => ({
            durationMilliseconds: observation.durationMilliseconds,
            status: observation.status,
          })),
        ),
      ),
    },
  };
}

function queryCountForFixture(
  target: (typeof V12_TARGETS)[number],
  operation: (typeof V12_LEGACY_OPERATIONS)[number],
): number {
  if (operation === 'cold-start') return 0;
  const index = V12_LEGACY_OPERATIONS.indexOf(operation);
  return (target === 'reference' ? 10 : 20) + index;
}

function required<Value>(value: Value | undefined, name: string): Value {
  if (value === undefined) throw new Error(`${name} is missing`);
  return value;
}

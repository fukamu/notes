import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  createSyncV2HttpHandler,
  type SyncV2HttpDependencies,
} from '@/app/api/v2/sync/handler';
import {
  parseAccountId,
  parseSessionEpoch,
  parseSessionId,
  parseSessionToken,
  parseVaultId,
  type SessionToken,
} from '@/lib/domain/identity';
import { parseDeviceId, type DeviceId } from '@/lib/domain/id';
import type { PendingMutation } from '@/lib/domain/types';
import {
  encodeSyncV2Request,
  parseSyncSequence,
  parseSyncV2Cursor,
} from '@/lib/sync/v2-protocol';
import { createActiveSession, type ActiveSession } from '@/server/core/session';
import { paidPersonalVaultLimits } from '@/server/entitlement/public';
import type { SyncV2ApplicationInput } from '@/server/sync-v2/public';
import {
  authorizeLocalServerLoad,
  decodeServerLoadArtifact,
  evaluateServerLoadObservation,
  serverLoadScenarios,
  type ServerLoadArtifact,
  type ServerLoadObservation,
  type ServerLoadScenario,
} from '@/tests/benchmarks/server-load-support';
import { fixtureCardId, fixtureMutationId } from '@/tests/fixtures/ids';

const branchPoint = '78a77aadbcc29aa628f25be287ece307acebf70d';
const expectedOrigin = 'https://local-fake.invalid';
const synchronizedAt = 1_500;
const logicalRequestCount = 1_000;
const simulatedPartitions = 16;
const nextCursor = parseSyncV2Cursor(
  'sync.v2.load.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
);

type LoadUser = Readonly<{
  token: SessionToken;
  cookie: string;
  session: ActiveSession;
  deviceId: DeviceId;
}>;

type MutableLoadState = {
  applicationCalls: number;
  tenantViolations: number;
  objectReads: number;
  objectWrites: number;
  kmsDecryptions: number;
  kmsEncryptions: number;
  mutationReplays: number;
  readonly committedMutations: Set<string>;
  readonly vaults: Set<string>;
  readonly partitions: Set<number>;
};

type HttpCounters = {
  attempts: number;
  successes: number;
  unavailable: number;
  inFlight: number;
  maximumInFlight: number;
  handlerInstances: number;
};

function uuidV7(namespace: number, index: number): string {
  const tail = (namespace + index).toString(16).padStart(12, '0');
  return `01991f20-61d2-7000-8000-${tail}`;
}

function tokenFor(index: number): SessionToken {
  const middle = index.toString(36).padStart(6, '0');
  return parseSessionToken(`${'A'.repeat(36)}${middle}A`);
}

function loadUsers(): readonly LoadUser[] {
  return Array.from({ length: logicalRequestCount }, (_, index) => {
    const accountId = parseAccountId(uuidV7(0x100_000, index));
    const vaultId = parseVaultId(uuidV7(0x200_000, index));
    const sessionId = parseSessionId(uuidV7(0x300_000, index));
    const deviceId = parseDeviceId(uuidV7(0x400_000, index));
    const created = createActiveSession({
      sessionId,
      accountId,
      vaultId,
      sessionEpoch: parseSessionEpoch(1),
      issuedAt: 1_000,
      expiresAt: 2_000,
    });
    if (created.kind === 'rejected') {
      throw new Error('Server load fixture produced an invalid session');
    }
    const token = tokenFor(index);
    return {
      token,
      cookie: `__Host-fukamu_session=${token}`,
      session: created.session,
      deviceId,
    };
  });
}

function emptyState(): MutableLoadState {
  return {
    applicationCalls: 0,
    tenantViolations: 0,
    objectReads: 0,
    objectWrites: 0,
    kmsDecryptions: 0,
    kmsEncryptions: 0,
    mutationReplays: 0,
    committedMutations: new Set(),
    vaults: new Set(),
    partitions: new Set(),
  };
}

function emptyHttpCounters(): HttpCounters {
  return {
    attempts: 0,
    successes: 0,
    unavailable: 0,
    inFlight: 0,
    maximumInFlight: 0,
    handlerInstances: 0,
  };
}

function partitionForVault(vaultId: string): number {
  return Number.parseInt(vaultId.slice(-3), 16) % simulatedPartitions;
}

function loadDependencies(
  users: readonly LoadUser[],
  state: MutableLoadState,
  failureModel: 'none' | 'response-loss-after-commit',
): SyncV2HttpDependencies {
  const sessionsByToken = new Map(
    users.map((user) => [user.token, user.session]),
  );
  const expectedVaultByDevice = new Map(
    users.map((user) => [user.deviceId, user.session.vaultId]),
  );
  return {
    expectedOrigin,
    clock: { now: () => synchronizedAt },
    sessions: {
      findSessionByToken: async (token) => sessionsByToken.get(token),
    },
    entitlement: {
      authorizeCapability: async (_context, capability) => ({
        kind: 'allowed',
        capability,
        basis: 'paid',
        validUntil: 2_000,
      }),
      readLimits: async () => ({
        kind: 'available',
        limits: paidPersonalVaultLimits,
        validUntil: 2_000,
      }),
    },
    application: {
      synchronize: async (input) =>
        synchronizeLoadRequest(
          input,
          state,
          expectedVaultByDevice,
          failureModel,
        ),
    },
  };
}

async function synchronizeLoadRequest(
  input: SyncV2ApplicationInput,
  state: MutableLoadState,
  expectedVaultByDevice: ReadonlyMap<string, string>,
  failureModel: 'none' | 'response-loss-after-commit',
) {
  state.applicationCalls += 1;
  state.vaults.add(input.context.vaultId);
  state.partitions.add(partitionForVault(input.context.vaultId));
  if (
    expectedVaultByDevice.get(input.request.deviceId) !== input.context.vaultId
  ) {
    state.tenantViolations += 1;
  }

  const receipts = [];
  for (const mutation of input.request.mutations) {
    if (!state.committedMutations.has(mutation.mutationId)) {
      state.committedMutations.add(mutation.mutationId);
      state.objectWrites += 1;
      state.kmsEncryptions += 1;
      if (failureModel === 'response-loss-after-commit') {
        throw new Error('synthetic response loss after durable commit');
      }
    } else {
      state.mutationReplays += 1;
    }
    receipts.push({
      mutationId: mutation.mutationId,
      cardId: mutation.cardId,
      appliedRevision: 1,
    });
  }

  return {
    kind: 'synchronized' as const,
    response: {
      version: 'sync/v2' as const,
      highWatermark: parseSyncSequence(0),
      changes: [],
      receipts,
      page: { kind: 'complete' as const, nextCursor },
    },
  };
}

function syncRequest(
  user: LoadUser,
  mutations: readonly PendingMutation[],
): Request {
  return new Request(`${expectedOrigin}/api/v2/sync`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: user.cookie,
      origin: expectedOrigin,
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify(
      encodeSyncV2Request({
        deviceId: user.deviceId,
        cursor: null,
        mutations,
      }),
    ),
  });
}

function loadMutation(index: number): PendingMutation {
  return {
    kind: 'upsert',
    mutationId: fixtureMutationId(`server-load-${index}`),
    cardId: fixtureCardId(`server-load-${index}`),
    baseServerRevision: null,
    title: `Load card ${index}`,
    body: [{ type: 'text', text: 'synthetic local-only content' }],
    createdAt: 1_100,
    updatedAt: 1_100,
    conflictIds: [],
  };
}

async function runWave(input: {
  readonly users: readonly LoadUser[];
  readonly handlerFor: (
    index: number,
  ) => ReturnType<typeof createSyncV2HttpHandler>;
  readonly mutationsFor: (index: number) => readonly PendingMutation[];
  readonly counters: HttpCounters;
}): Promise<void> {
  await Promise.all(
    input.users.map(async (user, index) => {
      input.counters.attempts += 1;
      input.counters.inFlight += 1;
      input.counters.maximumInFlight = Math.max(
        input.counters.maximumInFlight,
        input.counters.inFlight,
      );
      try {
        const response = await input.handlerFor(index)(
          syncRequest(user, input.mutationsFor(index)),
        );
        await response.arrayBuffer();
        if (response.status === 200) input.counters.successes += 1;
        else if (response.status === 503) input.counters.unavailable += 1;
        else
          throw new Error(`Unexpected server load status ${response.status}`);
      } finally {
        input.counters.inFlight -= 1;
      }
    }),
  );
}

function firstUser(users: readonly LoadUser[]): LoadUser {
  const user = users[0];
  if (user === undefined) throw new Error('Server load fixture is empty');
  return user;
}

async function runScenario(
  scenario: ServerLoadScenario,
  allUsers: readonly LoadUser[],
): Promise<ServerLoadObservation> {
  const state = emptyState();
  const counters = emptyHttpCounters();
  const scenarioUsers =
    scenario === 'hot-vault-partition'
      ? Array.from({ length: logicalRequestCount }, () => firstUser(allUsers))
      : allUsers;
  const failureModel =
    scenario === 'response-loss-retry' ? 'response-loss-after-commit' : 'none';
  const dependencies = loadDependencies(allUsers, state, failureModel);
  const sharedHandler =
    scenario === 'cold-start'
      ? undefined
      : createSyncV2HttpHandler(dependencies);
  if (sharedHandler !== undefined) counters.handlerInstances = 1;
  const handlerFor = () => {
    if (sharedHandler !== undefined) return sharedHandler;
    counters.handlerInstances += 1;
    return createSyncV2HttpHandler(dependencies);
  };
  const mutationsFor =
    scenario === 'response-loss-retry'
      ? (index: number) => [loadMutation(index)]
      : () => [];

  const memoryBefore = process.memoryUsage();
  const started = performance.now();
  await runWave({
    users: scenarioUsers,
    handlerFor,
    mutationsFor,
    counters,
  });
  if (scenario === 'response-loss-retry') {
    await runWave({
      users: scenarioUsers,
      handlerFor,
      mutationsFor,
      counters,
    });
  }
  const durationMs = performance.now() - started;
  const memoryAfter = process.memoryUsage();

  return {
    scenario,
    logicalRequests: logicalRequestCount,
    httpAttempts: counters.attempts,
    successfulResponses: counters.successes,
    unavailableResponses: counters.unavailable,
    maximumInFlight: counters.maximumInFlight,
    handlerInstances: counters.handlerInstances,
    uniqueVaults: state.vaults.size,
    uniquePartitions: state.partitions.size,
    tenantViolations: state.tenantViolations,
    applicationCalls: state.applicationCalls,
    uniqueMutationCommits: state.committedMutations.size,
    mutationReplays: state.mutationReplays,
    objectReads: state.objectReads,
    objectWrites: state.objectWrites,
    kmsDecryptions: state.kmsDecryptions,
    kmsEncryptions: state.kmsEncryptions,
    durationMs: Number(durationMs.toFixed(3)),
    observedHeapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
    observedRssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
  };
}

describe('local 1,000-concurrent server load artifact', () => {
  it('verifies correctness and records observational host measurements', async () => {
    const authorization = authorizeLocalServerLoad({
      mode: process.env.FUKAMU_SERVER_LOAD_MODE,
      targetUrl: process.env.FUKAMU_SERVER_LOAD_TARGET_URL,
      credential: process.env.FUKAMU_SERVER_LOAD_CREDENTIAL,
    });
    if (authorization.kind === 'rejected') {
      throw new Error(
        `Local server load refused: ${authorization.reasons.join(', ')}`,
      );
    }

    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const users = loadUsers();
    const observations: ServerLoadObservation[] = [];
    try {
      for (const scenario of serverLoadScenarios) {
        observations.push(await runScenario(scenario, users));
      }
    } finally {
      consoleError.mockRestore();
    }

    for (const observation of observations) {
      expect(evaluateServerLoadObservation(observation)).toEqual({
        kind: 'accepted',
        scenario: observation.scenario,
      });
    }

    const artifact: ServerLoadArtifact = {
      schemaVersion: 1,
      issue: 216,
      branchPoint,
      generatedAt: new Date().toISOString(),
      safety: {
        executionMode: authorization.executionMode,
        remoteTargetUsed: false,
        credentialUsed: false,
      },
      environment: {
        node: process.version,
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model ?? 'unknown',
        cpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
      },
      methodology: {
        command: 'npm run benchmark:server-load',
        timingPolicy:
          'Durations are observations only. This Issue adds no absolute wall-clock CI gate.',
        memoryPolicy:
          'Heap and RSS deltas are observations only because garbage collection and host load are nondeterministic.',
        failureModel:
          'The first mutation attempt commits once and loses its response; retry must replay without a second object write or KMS encryption.',
      },
      observations,
    };
    decodeServerLoadArtifact(artifact);
    await mkdir('docs/benchmarks', { recursive: true });
    await writeFile(
      'docs/benchmarks/server-load-local.json',
      `${JSON.stringify(artifact, null, 2)}\n`,
      'utf8',
    );
  });
});

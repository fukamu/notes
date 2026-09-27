/// <reference lib="dom" />

import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { chromium, type Page, type Response } from 'playwright';
import {
  sha256Hex,
  type V12LegacyRun,
  type V12Observation,
  type V12Target,
} from './migration-v12-evidence-core.mts';
import { isLegacySyncResponse } from './migration-benchmark-core.mts';

const queryCountHeader = 'x-fukamu-v12-query-count';
const sampleIDHeader = 'x-fukamu-v12-sample-id';

export type V12QueryCounts = Readonly<{
  coldFullSync: number;
  warmFullSync: number;
  singleMutation: number;
  batch500: number;
  twoDeviceConflict: number;
}>;

export type V12QueryEvidence = Readonly<{
  target: V12Target;
  scale: number;
  run: number;
  observationIdentity: string;
  storeIdentity: string;
  processIdentity: string;
  processStartTicks: number;
  counts: V12QueryCounts;
  responseDigests: V12LegacyRun['queryResponseDigests'];
}>;

export type V12BrowserRun = Readonly<{
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
    operation: 'initial-ready-full-data' | 'save-ack';
    durationMilliseconds: number;
    status: number;
    responseDigest: string;
  }>[];
}>;

export async function collectLegacyHTTPRun(
  input: Readonly<{
    target: V12Target;
    scale: number;
    run: number;
    baseUrl: URL;
    headers: Readonly<Record<string, string>>;
    storeWitness: string;
    runtimeArtifactSha256: string;
    processGroupId: number;
    coldStartMilliseconds: number;
    queryEvidence: V12QueryEvidence;
  }>,
): Promise<V12LegacyRun> {
  const initialMemory = await readProcessGroup(input.processGroupId);
  const observations: V12Observation[] = [
    {
      operation: 'cold-start',
      durationMilliseconds: rounded(input.coldStartMilliseconds),
      status: 200,
      responseBytes: 0,
      queryCount: 0,
      rssBytes: initialMemory.rssBytes,
      pssBytes: initialMemory.pssBytes,
      responseDigest: sha256Hex(''),
    },
  ];
  const sequence = await executeSequence(input, async (operation, requests) => {
    const started = performance.now();
    const responses: RawResponse[] = [];
    for (const request of requests) {
      responses.push(
        await rawRequest(
          input.baseUrl,
          input.headers,
          request.body,
          request.sampleId,
        ),
      );
    }
    const duration = performance.now() - started;
    const memory = await readProcessGroup(input.processGroupId);
    const queryCount = queryCountFor(operation, input.queryEvidence.counts);
    return { duration, responses, memory, queryCount };
  });
  observations.push(...sequence.observations);
  return {
    target: input.target,
    scale: input.scale,
    run: input.run,
    storeIdentity: storeIdentity(input.storeWitness),
    processIdentity: processIdentity(
      `${input.target}-s${input.scale}-r${input.run}`,
      input.processGroupId,
      initialMemory.leaderStartTicks,
      input.runtimeArtifactSha256,
    ),
    queryObservationIdentity: input.queryEvidence.observationIdentity,
    queryObservationTarget: input.queryEvidence.target,
    queryObservationScale: input.queryEvidence.scale,
    queryObservationRun: input.queryEvidence.run,
    queryObservationStoreIdentity: input.queryEvidence.storeIdentity,
    queryObservationProcessIdentity: input.queryEvidence.processIdentity,
    queryObservationStartTicks: input.queryEvidence.processStartTicks,
    queryResponseDigests: input.queryEvidence.responseDigests,
    processStartTicks: initialMemory.leaderStartTicks,
    initialCards: input.scale,
    beforeBatchCards: input.scale,
    afterBatchCards: input.scale + 500,
    batchDistinctCards: 500,
    batchAcknowledged: sequence.batchAcknowledged,
    observations,
    finalDigests: sequence.finalDigests,
  };
}

export async function collectLegacyQueryEvidence(
  input: Readonly<{
    target: V12Target;
    scale: number;
    run: number;
    baseUrl: URL;
    headers: Readonly<Record<string, string>>;
    storeWitness: string;
    runtimeArtifactSha256: string;
    processGroupId: number;
  }>,
): Promise<V12QueryEvidence> {
  const counts = new Map<string, number>();
  const process = await readProcessGroup(input.processGroupId);
  const sequence = await executeSequence(input, async (operation, requests) => {
    const responses: RawResponse[] = [];
    for (const request of requests) {
      responses.push(
        await rawRequest(
          input.baseUrl,
          input.headers,
          request.body,
          request.sampleId,
        ),
      );
    }
    const count = responses.reduce(
      (total, response) => total + queryCount(response),
      0,
    );
    counts.set(operation, count);
    return {
      duration: 0.001,
      responses,
      memory: { rssBytes: 1, pssBytes: 1, leaderStartTicks: 1 },
      queryCount: count,
    };
  });
  return {
    target: input.target,
    scale: input.scale,
    run: input.run,
    observationIdentity: `${input.target}-s${input.scale}-r${input.run}-query-pgid-${input.processGroupId}-ticks-${process.leaderStartTicks}`,
    storeIdentity: storeIdentity(input.storeWitness),
    processIdentity: processIdentity(
      `${input.target}-query-s${input.scale}-r${input.run}`,
      input.processGroupId,
      process.leaderStartTicks,
      input.runtimeArtifactSha256,
    ),
    processStartTicks: process.leaderStartTicks,
    counts: {
      coldFullSync: requiredCount(counts, 'cold-full-sync'),
      warmFullSync: requiredCount(counts, 'warm-full-sync'),
      singleMutation: requiredCount(counts, 'single-mutation'),
      batch500: requiredCount(counts, 'batch-500'),
      twoDeviceConflict: requiredCount(counts, 'two-device-conflict'),
    },
    responseDigests: sequence.observations.map((observation) => {
      if (observation.operation === 'cold-start') {
        throw new Error(
          'query companion sequence unexpectedly contains cold-start',
        );
      }
      return {
        operation: observation.operation,
        responseDigest: observation.responseDigest,
      };
    }),
  };
}

export async function collectBrowserRun(
  input: Readonly<{
    target: V12Target;
    scale: number;
    run: number;
    baseUrl: URL;
    headers: Readonly<Record<string, string>>;
    sessionCookie?: Readonly<{ name: string; value: string }>;
    storeWitness: string;
    runtimeArtifactSha256: string;
    processGroupId: number;
    databaseName: string;
    cardId: string;
    initialTitle: string;
    initialBodyText: string;
    editedTitle: string;
  }>,
): Promise<V12BrowserRun> {
  assertLoopbackURL(input.baseUrl);
  if (
    (input.target === 'go' &&
      input.sessionCookie?.name !== '__Host-fukamu_session') ||
    (input.target === 'reference' && input.sessionCookie !== undefined)
  ) {
    throw new Error(
      'browser session cookie does not match the native target contract',
    );
  }
  if (input.target === 'go' && input.baseUrl.hostname !== 'localhost') {
    throw new Error(
      'Go native browser target must use localhost for the __Host cookie contract',
    );
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      extraHTTPHeaders: input.headers,
    });
    try {
      let blockedRemoteRequest = false;
      await context.route('**/*', async (route) => {
        const requested = new URL(route.request().url());
        if (
          (requested.protocol === 'http:' || requested.protocol === 'https:') &&
          !isLoopbackHost(requested.hostname)
        ) {
          blockedRemoteRequest = true;
          await route.abort('blockedbyclient');
          return;
        }
        await route.continue();
      });
      if (input.sessionCookie !== undefined) {
        await context.addCookies([
          {
            name: input.sessionCookie.name,
            value: input.sessionCookie.value,
            domain: 'localhost',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'Strict',
          },
        ]);
      }
      const page = await context.newPage();
      const network = new BrowserNetworkCapture(input.target);
      network.attach(page);
      const initialStarted = performance.now();
      const navigation = await page.goto(
        new URL(`/cards/${input.cardId}`, input.baseUrl).href,
        {
          waitUntil: 'domcontentloaded',
          timeout: 600_000,
        },
      );
      if (navigation?.status() !== 200) {
        throw new Error(
          `browser navigation returned ${navigation?.status() ?? 0}`,
        );
      }
      await waitForBrowserReady(page, input);
      await network.settle();
      if (blockedRemoteRequest)
        throw new Error('native browser attempted a non-loopback request');
      const initialDuration = performance.now() - initialStarted;
      const before = await readBrowserDatabaseState(
        page,
        input.databaseName,
        input.cardId,
      );
      assertBrowserState(
        before,
        input.scale,
        1,
        input.initialTitle,
        input.initialBodyText,
        false,
        'initial',
      );

      network.beginSave();
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url() ===
            new URL(
              input.target === 'reference' ? '/api/sync' : '/api/v2/sync',
              input.baseUrl,
            ).href &&
          response.request().method() === 'POST' &&
          (response.request().postData() ?? '').includes(input.editedTitle),
        { timeout: 600_000 },
      );
      const saveStarted = performance.now();
      await page.getByTestId('card-title').fill(input.editedTitle);
      const saveResponse = await responsePromise;
      if (saveResponse.status() !== 200) {
        throw new Error(`browser save returned ${saveResponse.status()}`);
      }
      await waitForSaved(page);
      const saveDuration = performance.now() - saveStarted;
      const after = await readBrowserDatabaseState(
        page,
        input.databaseName,
        input.cardId,
      );
      assertBrowserState(
        after,
        input.scale,
        2,
        input.editedTitle,
        input.initialBodyText,
        false,
        'saved',
      );
      await assertVisibleCard(page, input, input.editedTitle);
      const receiptCount = await responseReceiptCount(
        saveResponse,
        input.target,
      );
      if (receiptCount !== 1)
        throw new Error(
          'browser save response lacks one receipt/acknowledgement',
        );
      await network.settle();
      if (blockedRemoteRequest)
        throw new Error('native browser attempted a non-loopback request');
      const process = await readProcessGroup(input.processGroupId);
      const uiRuntimeIdentity = await readUIRuntimeIdentity(page);
      const initialDigest = sha256Hex(
        canonicalJSON(browserStateDigest(before)),
      );
      const saveDigest = sha256Hex(canonicalJSON(browserStateDigest(after)));
      return {
        target: input.target,
        scale: input.scale,
        run: input.run,
        storeIdentity: storeIdentity(input.storeWitness),
        processIdentity: processIdentity(
          `browser-${input.target}-s${input.scale}-r${input.run}`,
          input.processGroupId,
          process.leaderStartTicks,
          input.runtimeArtifactSha256,
        ),
        processStartTicks: process.leaderStartTicks,
        uiRuntimeIdentity,
        browserContextIdentity: `chromium-${randomUUID()}`,
        fullDataCardCount: input.scale,
        syncPageEntryCounts: network.initialPageEntryCounts(),
        sessionContextStatus: network.sessionContextStatus(),
        beforeCardCount: before.cardCount,
        afterCardCount: after.cardCount,
        beforeRevision: before.serverRevision,
        afterRevision: after.serverRevision,
        pendingMutationsAfter: after.pendingMutations,
        outgoingBatchPresentAfter: after.outgoingBatchPresent,
        receiptOrAcknowledgementCount: receiptCount,
        cardIdentityDigest: sha256Hex(
          canonicalJSON({
            cardId: input.cardId,
            displayKind: before.displayKind,
            displayValue: before.displayValue,
          }),
        ),
        orderedNetworkDigest: network.digest(),
        networkObservations: network.observations(),
        responseOverridesInstalled: false,
        externalNetworkGuardInstalled: true,
        uiReady: true,
        editedExistingCard: true,
        saveAcknowledged: true,
        observations: [
          {
            operation: 'initial-ready-full-data',
            durationMilliseconds: rounded(initialDuration),
            status: 200,
            responseDigest: initialDigest,
          },
          {
            operation: 'save-ack',
            durationMilliseconds: rounded(saveDuration),
            status: 200,
            responseDigest: saveDigest,
          },
        ],
      };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

function assertLoopbackURL(value: URL): void {
  if (
    (value.protocol !== 'http:' && value.protocol !== 'https:') ||
    !isLoopbackHost(value.hostname) ||
    value.username !== '' ||
    value.password !== ''
  ) {
    throw new Error('browser target must be credential-free loopback HTTP(S)');
  }
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

type BrowserDatabaseState = Readonly<{
  cardCount: number;
  cardId: string;
  title: string;
  bodyText: string;
  displayKind: string;
  displayValue: number;
  serverRevision: number;
  pendingMutations: number;
  outgoingBatchPresent: boolean;
}>;

class BrowserNetworkCapture {
  private phase: 'initial' | 'save' = 'initial';
  private readonly pending = new Set<Promise<void>>();
  private readonly failures: Error[] = [];
  private readonly entries: Array<
    | Readonly<{
        phase: 'initial' | 'save';
        path: string;
        status: number;
        responseDigest: string;
      }>
    | undefined
  > = [];
  private readonly initialPages: number[] = [];
  private sessionStatus = 0;
  private referenceInitialRecorded = false;
  private goInitialComplete = false;

  constructor(private readonly target: V12Target) {}

  attach(page: Page): void {
    page.on('response', (response) => {
      const url = new URL(response.url());
      const syncPath =
        this.target === 'reference' ? '/api/sync' : '/api/v2/sync';
      if (
        url.pathname !== '/api/session-context' &&
        (url.pathname !== syncPath || response.request().method() !== 'POST')
      )
        return;
      const index = this.entries.length;
      this.entries.push(undefined);
      const capture = this.capture(response, index).catch((error: unknown) => {
        this.failures.push(
          error instanceof Error
            ? error
            : new Error('unknown browser network capture failure'),
        );
      });
      this.pending.add(capture);
      void capture.finally(() => this.pending.delete(capture));
    });
  }

  beginSave(): void {
    this.phase = 'save';
  }

  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending);
    if (this.failures.length > 0)
      throw new AggregateError(this.failures, 'browser network capture failed');
  }

  initialPageEntryCounts(): readonly number[] {
    if (this.initialPages.length === 0)
      throw new Error('browser initial sync pages were not observed');
    return [...this.initialPages];
  }

  sessionContextStatus(): number {
    if (this.target === 'go' && this.sessionStatus !== 200) {
      throw new Error(
        'Go browser run lacks a successful session-context response',
      );
    }
    return this.sessionStatus;
  }

  digest(): string {
    return sha256Hex(JSON.stringify(this.observations()));
  }

  observations(): readonly Readonly<{
    phase: 'initial' | 'save';
    path: string;
    status: number;
    responseDigest: string;
  }>[] {
    return this.entries.map((entry) => {
      if (entry === undefined)
        throw new Error('browser network observation did not settle');
      return entry;
    });
  }

  private async capture(response: Response, index: number): Promise<void> {
    const url = new URL(response.url());
    if (url.pathname === '/api/session-context') {
      this.sessionStatus = response.status();
      this.entries[index] = {
        phase: this.phase,
        path: url.pathname,
        status: response.status(),
        responseDigest: sha256Hex(new Uint8Array(await response.body())),
      };
      return;
    }
    const syncPath = this.target === 'reference' ? '/api/sync' : '/api/v2/sync';
    if (url.pathname !== syncPath || response.request().method() !== 'POST')
      return;
    const body = new Uint8Array(await response.body());
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (this.phase === 'initial') {
      if (this.target === 'reference' && !this.referenceInitialRecorded) {
        this.initialPages.push(responseArrayLength(parsed, 'cards'));
        this.referenceInitialRecorded = true;
      } else if (this.target === 'go' && !this.goInitialComplete) {
        const requestBody: unknown = JSON.parse(
          response.request().postData() ?? 'null',
        );
        const requestCursor = recordField(requestBody, 'cursor');
        if (
          this.initialPages.length === 0
            ? requestCursor !== null
            : typeof requestCursor !== 'string'
        ) {
          throw new Error('Go initial browser sync cursor chain is invalid');
        }
        this.initialPages.push(responseArrayLength(parsed, 'changes'));
        this.goInitialComplete =
          recordField(recordField(parsed, 'page'), 'kind') === 'complete';
      }
    }
    this.entries[index] = {
      phase: this.phase,
      path: url.pathname,
      status: response.status(),
      responseDigest: sha256Hex(body),
    };
  }
}

function responseArrayLength(value: unknown, key: string): number {
  const candidate = recordField(value, key);
  if (!Array.isArray(candidate))
    throw new Error(`browser sync response lacks ${key}`);
  return candidate.length;
}

function recordField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('browser protocol value is not an object');
  }
  return Reflect.get(value, key);
}

async function responseReceiptCount(
  response: Response,
  target: V12Target,
): Promise<number> {
  const parsed: unknown = JSON.parse((await response.body()).toString('utf8'));
  return responseArrayLength(
    parsed,
    target === 'reference' ? 'acknowledgedMutationIds' : 'receipts',
  );
}

async function readBrowserDatabaseState(
  page: Page,
  databaseName: string,
  cardId: string,
): Promise<BrowserDatabaseState> {
  const candidate: unknown = await page.evaluate(
    async ({ name, id }) => {
      const databases = await indexedDB.databases();
      if (!databases.some((database) => database.name === name)) {
        throw new Error('native notes database does not exist yet');
      }
      return new Promise((resolve, reject) => {
        const opening = indexedDB.open(name);
        opening.addEventListener('error', () => reject(opening.error), {
          once: true,
        });
        opening.addEventListener(
          'success',
          () => {
            const database = opening.result;
            try {
              if (
                !database.objectStoreNames.contains('cards') ||
                !database.objectStoreNames.contains('mutations')
              ) {
                throw new Error(
                  'native notes database stores do not exist yet',
                );
              }
              const storeNames = ['cards', 'mutations'];
              if (database.objectStoreNames.contains('sync-v2'))
                storeNames.push('sync-v2');
              const transaction = database.transaction(storeNames, 'readonly');
              const cards = transaction.objectStore('cards');
              const cardRequest = cards.get(id);
              const countRequest = cards.count();
              const mutationRequest = transaction
                .objectStore('mutations')
                .count();
              const outgoingRequest = database.objectStoreNames.contains(
                'sync-v2',
              )
                ? transaction.objectStore('sync-v2').get('outgoing')
                : undefined;
              transaction.addEventListener(
                'complete',
                () => {
                  database.close();
                  const card: unknown = cardRequest.result;
                  const outgoing: unknown = outgoingRequest?.result;
                  resolve({
                    cardCount: countRequest.result,
                    card,
                    pendingMutations: mutationRequest.result,
                    outgoingBatchPresent: outgoing !== undefined,
                  });
                },
                { once: true },
              );
              transaction.addEventListener(
                'abort',
                () => {
                  database.close();
                  reject(transaction.error);
                },
                { once: true },
              );
              transaction.addEventListener(
                'error',
                () => {
                  database.close();
                  reject(transaction.error);
                },
                { once: true },
              );
            } catch (error) {
              database.close();
              reject(error);
            }
          },
          { once: true },
        );
      });
    },
    { name: databaseName, id: cardId },
  );
  return decodeBrowserDatabaseState(candidate, cardId);
}

function decodeBrowserDatabaseState(
  value: unknown,
  expectedCardId: string,
): BrowserDatabaseState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('browser database state is not an object');
  }
  const cardCount = safeInteger(
    Reflect.get(value, 'cardCount'),
    'browser card count',
    1,
  );
  const pendingMutations = safeInteger(
    Reflect.get(value, 'pendingMutations'),
    'browser pending mutations',
    0,
  );
  const outgoingBatchPresent: unknown = Reflect.get(
    value,
    'outgoingBatchPresent',
  );
  const card: unknown = Reflect.get(value, 'card');
  if (card === null || typeof card !== 'object' || Array.isArray(card))
    throw new Error('browser active card is missing');
  const display: unknown = Reflect.get(card, 'displayId');
  if (display === null || typeof display !== 'object' || Array.isArray(display))
    throw new Error('browser display ID is missing');
  const body: unknown = Reflect.get(card, 'body');
  if (!Array.isArray(body)) throw new Error('browser card body is missing');
  const bodyText = body
    .map((segment) => {
      if (
        segment === null ||
        typeof segment !== 'object' ||
        Array.isArray(segment)
      )
        throw new Error('browser body segment is invalid');
      const text: unknown = Reflect.get(segment, 'text');
      return typeof text === 'string' ? text : '';
    })
    .join('');
  const cardId: unknown = Reflect.get(card, 'id');
  const title: unknown = Reflect.get(card, 'title');
  const displayKind: unknown = Reflect.get(display, 'kind');
  if (
    cardId !== expectedCardId ||
    typeof title !== 'string' ||
    typeof displayKind !== 'string' ||
    typeof outgoingBatchPresent !== 'boolean'
  ) {
    throw new Error('browser database card fields are invalid');
  }
  return {
    cardCount,
    cardId,
    title,
    bodyText,
    displayKind,
    displayValue: safeInteger(
      Reflect.get(display, 'value'),
      'browser display value',
      1,
    ),
    serverRevision: safeInteger(
      Reflect.get(card, 'serverRevision'),
      'browser server revision',
      1,
    ),
    pendingMutations,
    outgoingBatchPresent,
  };
}

function safeInteger(value: unknown, label: string, minimum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

async function readUIRuntimeIdentity(page: Page): Promise<string> {
  const candidate: unknown = await page.evaluate(() => {
    const state: unknown = window.history.state;
    if (state === null || typeof state !== 'object' || Array.isArray(state))
      return null;
    const metadata: unknown = Reflect.get(state, '__fukamuNotesNavigationV1');
    if (
      metadata === null ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata)
    )
      return null;
    const runtimeId: unknown = Reflect.get(metadata, 'runtimeId');
    return typeof runtimeId === 'string' ? runtimeId : null;
  });
  if (
    typeof candidate !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(candidate)
  ) {
    throw new Error('native UI history state lacks a safe runtime identity');
  }
  return candidate;
}

function processIdentity(
  prefix: string,
  processGroupId: number,
  startTicks: number,
  runtimeArtifactSha256: string,
): string {
  if (!/^[a-f0-9]{64}$/u.test(runtimeArtifactSha256))
    throw new Error('runtime artifact digest is invalid');
  return `${prefix}-pgid-${processGroupId}-ticks-${startTicks}-artifact-${runtimeArtifactSha256.slice(0, 16)}`;
}

function storeIdentity(witness: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{15,127}$/u.test(witness))
    throw new Error('fresh store witness is invalid');
  return `store-${sha256Hex(witness)}`;
}

function assertBrowserState(
  state: BrowserDatabaseState,
  scale: number,
  revision: number,
  title: string,
  bodyText: string,
  outgoing: boolean,
  label: string,
): void {
  if (
    state.cardCount !== scale ||
    state.serverRevision !== revision ||
    state.title !== title ||
    state.bodyText !== bodyText ||
    state.pendingMutations !== 0 ||
    state.outgoingBatchPresent !== outgoing ||
    state.displayKind !== 'official' ||
    state.displayValue !== scale
  ) {
    throw new Error(
      `${label} browser database state does not match the native UI contract`,
    );
  }
}

function browserStateDigest(state: BrowserDatabaseState): unknown {
  return {
    cardCount: state.cardCount,
    cardId: state.cardId,
    title: state.title,
    bodyText: state.bodyText,
    displayKind: state.displayKind,
    displayValue: state.displayValue,
    serverRevision: state.serverRevision,
    pendingMutations: state.pendingMutations,
    outgoingBatchPresent: state.outgoingBatchPresent,
  };
}

type RawResponse = Readonly<{
  status: number;
  body: Uint8Array;
  headers: Headers;
  sampleId: string;
}>;

type Operation = Exclude<V12Observation['operation'], 'cold-start'>;

async function executeSequence(
  input: Readonly<{
    target: V12Target;
    scale: number;
    run: number;
    baseUrl: URL;
    headers: Readonly<Record<string, string>>;
  }>,
  execute: (
    operation: Operation,
    requests: readonly Readonly<{ body: unknown; sampleId: string }>[],
  ) => Promise<
    Readonly<{
      duration: number;
      responses: readonly RawResponse[];
      memory: Readonly<{
        rssBytes: number;
        pssBytes: number;
        leaderStartTicks: number;
      }>;
      queryCount: number;
    }>
  >,
): Promise<
  Readonly<{
    observations: readonly V12Observation[];
    batchAcknowledged: number;
    finalDigests: V12LegacyRun['finalDigests'];
  }>
> {
  const observations: V12Observation[] = [];
  const emptyRequest = { deviceId: fixtureUUID(0x90_0000, 0), mutations: [] };
  const cold = await execute('cold-full-sync', [
    sample(input, 'cold-full-sync', 0, emptyRequest),
  ]);
  const coldResponse = singleDecoded(cold.responses, 'cold full sync');
  assertCardCount(coldResponse, input.scale, 'cold full sync');
  observations.push(toObservation('cold-full-sync', cold, coldResponse));

  for (let index = 0; index < 3; index += 1) {
    const warmup = await rawRequest(
      input.baseUrl,
      input.headers,
      emptyRequest,
      sampleID(input, 'warmup', index),
    );
    assertCardCount(
      decodeResponse(warmup.body),
      input.scale,
      `warmup ${index + 1}`,
    );
  }
  const warm = await execute('warm-full-sync', [
    sample(input, 'warm-full-sync', 0, emptyRequest),
  ]);
  const warmResponse = singleDecoded(warm.responses, 'warm full sync');
  assertCardCount(warmResponse, input.scale, 'warm full sync');
  observations.push(toObservation('warm-full-sync', warm, warmResponse));

  const single = await execute('single-mutation', [
    sample(input, 'single-mutation', 0, {
      deviceId: fixtureUUID(0x90_0000, 0),
      mutations: [singleMutation()],
    }),
  ]);
  const singleResponse = singleDecoded(single.responses, 'single mutation');
  assertCardCount(singleResponse, input.scale, 'single mutation');
  assertAcknowledgements(singleResponse, 1, 'single mutation');
  observations.push(toObservation('single-mutation', single, singleResponse));

  const batchMutations = newCardBatch();
  if (new Set(batchMutations.map((mutation) => mutation.cardId)).size !== 500) {
    throw new Error('batch fixture does not contain 500 distinct cards');
  }
  const batch = await execute('batch-500', [
    sample(input, 'batch-500', 0, {
      deviceId: fixtureUUID(0x90_0000, 0),
      mutations: batchMutations,
    }),
  ]);
  const batchResponse = singleDecoded(batch.responses, 'batch 500');
  assertCardCount(batchResponse, input.scale + 500, 'batch 500');
  assertAcknowledgements(batchResponse, 500, 'batch 500');
  observations.push(toObservation('batch-500', batch, batchResponse));

  const conflict = await execute('two-device-conflict', [
    sample(input, 'two-device-conflict', 0, {
      deviceId: fixtureUUID(0x90_0000, 0),
      mutations: [deviceAMutation()],
    }),
    sample(input, 'two-device-conflict', 1, {
      deviceId: fixtureUUID(0x91_0000, 0),
      mutations: [staleDeviceBMutation()],
    }),
  ]);
  if (conflict.responses.length !== 2)
    throw new Error('two-device conflict response pair missing');
  const deviceAResponse = decodeResponse(
    conflict.responses[0]?.body ?? new Uint8Array(),
  );
  const staleResponse = decodeResponse(
    conflict.responses[1]?.body ?? new Uint8Array(),
  );
  assertCardCount(deviceAResponse, input.scale + 500, 'device A update');
  assertCardCount(staleResponse, input.scale + 500, 'stale device B conflict');
  assertAcknowledgements(deviceAResponse, 1, 'device A update');
  assertAcknowledgements(staleResponse, 1, 'stale device B conflict');
  if (staleResponse.conflicts.length !== 1)
    throw new Error('stale device B must produce one conflict');
  observations.push(
    toObservation(
      'two-device-conflict',
      conflict,
      staleResponse,
      canonicalJSON([
        normalizedResponseValue(deviceAResponse),
        normalizedResponseValue(staleResponse),
      ]),
    ),
  );

  return {
    observations,
    batchAcknowledged: batchResponse.acknowledgedMutationIds.length,
    finalDigests: {
      cards: sha256Hex(canonicalJSON(staleResponse.cards)),
      acknowledgements: sha256Hex(
        canonicalJSON(staleResponse.acknowledgedMutationIds),
      ),
      conflicts: sha256Hex(canonicalJSON(staleResponse.conflicts)),
    },
  };
}

function sample(
  input: Readonly<{ target: V12Target; scale: number; run: number }>,
  operation: string,
  index: number,
  body: unknown,
) {
  return { body, sampleId: sampleID(input, operation, index) };
}

function sampleID(
  input: Readonly<{ target: V12Target; scale: number; run: number }>,
  operation: string,
  index: number,
): string {
  return `${input.target}.s${input.scale}.r${input.run}.${operation}.${index}`;
}

async function rawRequest(
  baseUrl: URL,
  headers: Readonly<Record<string, string>>,
  body: unknown,
  sampleId: string,
): Promise<RawResponse> {
  const requestHeaders = new Headers(headers);
  requestHeaders.set(sampleIDHeader, sampleId);
  const response = await fetch(new URL('/api/sync', baseUrl), {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  const responseBody = new Uint8Array(await response.arrayBuffer());
  if (response.status !== 200)
    throw new Error(`benchmark request returned ${response.status}`);
  const echoed = response.headers.get(sampleIDHeader);
  if (response.headers.has(queryCountHeader) && echoed !== sampleId) {
    throw new Error(
      'query observer did not bind the response to the sample ID',
    );
  }
  return {
    status: response.status,
    body: responseBody,
    headers: response.headers,
    sampleId,
  };
}

function toObservation(
  operation: Operation,
  measurement: Readonly<{
    duration: number;
    responses: readonly RawResponse[];
    memory: Readonly<{ rssBytes: number; pssBytes: number }>;
    queryCount: number;
  }>,
  response: LegacyResponse,
  normalized = normalizedResponse(response),
): V12Observation {
  return {
    operation,
    durationMilliseconds: rounded(measurement.duration),
    status: 200,
    responseBytes: measurement.responses.reduce(
      (total, entry) => total + entry.body.byteLength,
      0,
    ),
    queryCount: measurement.queryCount,
    rssBytes: measurement.memory.rssBytes,
    pssBytes: measurement.memory.pssBytes,
    responseDigest: sha256Hex(normalized),
  };
}

function queryCount(response: RawResponse): number {
  const source = response.headers.get(queryCountHeader);
  const value = Number(source);
  if (!/^[1-9][0-9]*$/u.test(source ?? '') || !Number.isSafeInteger(value)) {
    throw new Error(`sample ${response.sampleId} lacks an actual query count`);
  }
  return value;
}

function queryCountFor(
  operation: Operation,
  counts: V12QueryCounts | undefined,
): number {
  if (counts === undefined)
    throw new Error('owned Go query companion evidence is missing');
  if (operation === 'cold-full-sync') return counts.coldFullSync;
  if (operation === 'warm-full-sync') return counts.warmFullSync;
  if (operation === 'single-mutation') return counts.singleMutation;
  if (operation === 'batch-500') return counts.batch500;
  return counts.twoDeviceConflict;
}

function requiredCount(
  counts: ReadonlyMap<string, number>,
  name: string,
): number {
  const value = counts.get(name);
  if (value === undefined) throw new Error(`query count ${name} missing`);
  return value;
}

type LegacyMutation = Readonly<{
  mutationId: string;
  cardId: string;
  baseServerRevision: number | null;
  title: string;
  body: readonly Readonly<{ type: 'text'; text: string }>[];
  createdAt: number;
  updatedAt: number;
  kind: 'upsert';
  conflictIds: readonly [];
}>;

type LegacyResponse = Readonly<{
  cards: readonly unknown[];
  conflicts: readonly unknown[];
  acknowledgedMutationIds: readonly unknown[];
}>;

function decodeResponse(body: Uint8Array): LegacyResponse {
  const candidate: unknown = JSON.parse(new TextDecoder().decode(body));
  if (!isLegacySyncResponse(candidate))
    throw new Error('response does not match legacy sync');
  return candidate;
}

function singleDecoded(
  responses: readonly RawResponse[],
  label: string,
): LegacyResponse {
  if (responses.length !== 1 || responses[0] === undefined)
    throw new Error(`${label} response missing`);
  return decodeResponse(responses[0].body);
}

function singleMutation(): LegacyMutation {
  return mutation(0x40_0000, 0x10_0000, 0, 1, 'v12-single-update', 20_000);
}

function newCardBatch(): readonly LegacyMutation[] {
  return Array.from({ length: 500 }, (_, index) =>
    mutation(
      0x50_0000,
      0x20_0000,
      index,
      null,
      `v12-batch-${index.toString().padStart(3, '0')}`,
      30_000 + index,
    ),
  );
}

function deviceAMutation(): LegacyMutation {
  return mutation(0x60_0000, 0x10_0000, 1, 1, 'v12-device-a', 40_000);
}

function staleDeviceBMutation(): LegacyMutation {
  return mutation(0x70_0000, 0x10_0000, 1, 1, 'v12-stale-device-b', 40_001);
}

function mutation(
  mutationNamespace: number,
  cardNamespace: number,
  index: number,
  baseServerRevision: number | null,
  title: string,
  updatedOffset: number,
): LegacyMutation {
  return {
    mutationId: fixtureUUID(mutationNamespace, index),
    cardId: fixtureUUID(cardNamespace, index),
    baseServerRevision,
    title,
    body: [{ type: 'text', text: `deterministic-v12-${index}` }],
    createdAt: 1_789_000_000_000 + index,
    updatedAt: 1_789_000_000_000 + updatedOffset,
    kind: 'upsert',
    conflictIds: [],
  };
}

export function fixtureUUID(namespace: number, index: number): string {
  return `01991f20-61d2-7000-8000-${(namespace + index).toString(16).padStart(12, '0')}`;
}

export function initialFixtureCard(index: number): Readonly<{
  cardId: string;
  mutationId: string;
  title: string;
  bodyText: string;
  createdAt: number;
}> {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 10_000) {
    throw new Error('initial V12 fixture card index is invalid');
  }
  return {
    cardId: fixtureUUID(0x10_0000, index),
    mutationId: fixtureUUID(0x30_0000, index),
    title: `v12-card-${index.toString().padStart(5, '0')}`,
    bodyText: `deterministic-v12-${index}`,
    createdAt: 1_789_000_000_000 + index,
  };
}

function normalizedResponse(response: LegacyResponse): string {
  return canonicalJSON(normalizedResponseValue(response));
}

function normalizedResponseValue(response: LegacyResponse): unknown {
  return {
    cards: response.cards,
    conflicts: response.conflicts,
    acknowledgedMutationIds: response.acknowledgedMutationIds,
  };
}

function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJSON(entry)}`)
    .join(',')}}`;
}

function assertCardCount(
  response: LegacyResponse,
  expected: number,
  label: string,
): void {
  if (response.cards.length !== expected)
    throw new Error(`${label} card count mismatch`);
}

function assertAcknowledgements(
  response: LegacyResponse,
  expected: number,
  label: string,
): void {
  if (response.acknowledgedMutationIds.length !== expected)
    throw new Error(`${label} acknowledgement count mismatch`);
}

async function waitForBrowserReady(
  page: Page,
  input: Readonly<{
    scale: number;
    databaseName: string;
    cardId: string;
    initialTitle: string;
    initialBodyText: string;
  }>,
): Promise<void> {
  const deadline = performance.now() + 600_000;
  while (performance.now() < deadline) {
    try {
      const state = await readBrowserDatabaseState(
        page,
        input.databaseName,
        input.cardId,
      );
      assertBrowserState(
        state,
        input.scale,
        1,
        input.initialTitle,
        input.initialBodyText,
        false,
        'initial',
      );
      await assertVisibleCard(page, input, input.initialTitle);
      await waitForSaved(page);
      return;
    } catch {
      // Native UI, IndexedDB, and all sync pages must converge before readiness.
    }
    await page.waitForTimeout(25);
  }
  throw new Error(
    'Chromium did not expose the full synchronized card set in the UI',
  );
}

async function waitForSaved(page: Page): Promise<void> {
  const deadline = performance.now() + 600_000;
  while (performance.now() < deadline) {
    if (
      (
        await page
          .getByTestId('save-sync-status')
          .textContent()
          .catch(() => '')
      )?.trim() === '保存済み'
    )
      return;
    await page.waitForTimeout(25);
  }
  throw new Error('Chromium did not reach the saved UI state');
}

async function assertVisibleCard(
  page: Page,
  input: Readonly<{ scale: number; initialBodyText: string }>,
  title: string,
): Promise<void> {
  const newCardVisible = await page.getByTestId('new-card').isVisible();
  const visibleTitle = await page.getByTestId('card-title').inputValue();
  const display = page.getByTestId('display-id');
  const displayKind = await display.getAttribute('data-kind');
  const displayValue = await display.getAttribute('data-value');
  const body = (await page.locator('.ProseMirror').textContent())?.trim() ?? '';
  if (
    !newCardVisible ||
    visibleTitle !== title ||
    displayKind !== 'official' ||
    displayValue !== String(input.scale) ||
    body !== input.initialBodyText
  ) {
    throw new Error(
      'visible native card does not match the seeded active card',
    );
  }
}

async function readProcessGroup(processGroupId: number): Promise<
  Readonly<{
    rssBytes: number;
    pssBytes: number;
    leaderStartTicks: number;
  }>
> {
  const leader = await readProcessStat(processGroupId);
  if (leader.processGroupId !== processGroupId)
    throw new Error('process group ID must identify its leader');
  let rssBytes = 0;
  let pssBytes = 0;
  let members = 0;
  for (const entry of await readdir('/proc')) {
    if (!/^[1-9][0-9]*$/u.test(entry)) continue;
    try {
      const pid = Number(entry);
      const process = await readProcessStat(pid);
      if (process.processGroupId !== processGroupId) continue;
      const memory = await readSmapsRollup(pid);
      rssBytes += memory.rssBytes;
      pssBytes += memory.pssBytes;
      members += 1;
    } catch {
      // Non-leader children may exit while /proc is enumerated.
    }
  }
  if (members === 0 || rssBytes <= 0 || pssBytes <= 0)
    throw new Error('process group memory unavailable');
  return { rssBytes, pssBytes, leaderStartTicks: leader.startTicks };
}

async function readProcessStat(
  pid: number,
): Promise<Readonly<{ processGroupId: number; startTicks: number }>> {
  const value = await readFile(`/proc/${pid}/stat`, 'utf8');
  const closing = value.lastIndexOf(')');
  if (closing < 0) throw new Error('invalid /proc stat');
  const fields = value
    .slice(closing + 2)
    .trim()
    .split(/\s+/u);
  const processGroupId = Number(fields[2]);
  const startTicks = Number(fields[19]);
  if (
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 0 ||
    !Number.isSafeInteger(startTicks) ||
    startTicks <= 0
  ) {
    throw new Error('invalid /proc process identity');
  }
  return { processGroupId, startTicks };
}

async function readSmapsRollup(
  pid: number,
): Promise<Readonly<{ rssBytes: number; pssBytes: number }>> {
  const value = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
  const rss = /^Rss:\s+([0-9]+) kB$/mu.exec(value)?.[1];
  const pss = /^Pss:\s+([0-9]+) kB$/mu.exec(value)?.[1];
  if (rss === undefined || pss === undefined)
    throw new Error('invalid smaps_rollup');
  return { rssBytes: Number(rss) * 1_024, pssBytes: Number(pss) * 1_024 };
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

export function fixtureSeedSQL(scale: number): string {
  if (![100, 1_000, 10_000].includes(scale))
    throw new Error('unsupported fixture scale');
  const statements = ['BEGIN;'];
  for (let offset = 0; offset < scale; offset += 100) {
    const cards: string[] = [];
    const mutations: string[] = [];
    for (
      let index = offset;
      index < Math.min(scale, offset + 100);
      index += 1
    ) {
      const fixture = initialFixtureCard(index);
      cards.push(
        `('${fixture.cardId}',${index + 1},'${fixture.title}','[{"type":"text","text":"${fixture.bodyText}"}]',1,${fixture.createdAt},${fixture.createdAt},'${fixture.mutationId}')`,
      );
      mutations.push(
        `('${fixture.mutationId}','${fixture.cardId}',${fixture.createdAt})`,
      );
    }
    statements.push(
      `INSERT INTO cards(id,display_id,title,body_json,revision,created_at,updated_at,last_mutation_id) VALUES ${cards.join(',')};`,
    );
    statements.push(
      `INSERT INTO card_mutations(id,card_id,created_at) VALUES ${mutations.join(',')};`,
    );
  }
  statements.push(
    `UPDATE sync_state SET next_display_id=${scale + 1} WHERE singleton=1;`,
    'COMMIT;',
  );
  return `${statements.join('\n')}\n`;
}

export function fixtureSeedDigest(scale: number): string {
  return createHash('sha256').update(fixtureSeedSQL(scale)).digest('hex');
}

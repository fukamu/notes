import { cpus, platform, release, totalmem } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { build } from 'vite';
import { decodeBrowserWorkerFeasibilityCaseResult } from '@/tests/benchmarks/connections-browser-worker-feasibility-support';

const shouldMeasure = process.env.CONNECTIONS_HYBRID_WORKER_FEASIBILITY === '1';
const timeoutMs = 30_000;
const fixtureNames = [
  'boundary-257-mixed',
  'representative-1000-e3000-mixed',
  'product-10000-existing',
  'connected-10000-e20000',
] as const;
const branchPoint = '957e596d4a63af46d0017d13478e347101088061';

type CorridorTiming = Readonly<{
  requestId: number;
  generation: number;
  roundTripMs: number;
  workerLayoutMs: number;
  responseDecodeMs: number;
  transferAndSchedulingMs: number;
}>;

function field(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null) return undefined;
  return Reflect.get(input, key);
}

function finite(input: unknown, label: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
    throw new TypeError(`${label} must be finite and non-negative`);
  }
  return input;
}

function safeInteger(input: unknown, label: string): number {
  const value = finite(input, label);
  if (!Number.isSafeInteger(value))
    throw new TypeError(`${label} must be an integer`);
  return value;
}

function decodeCorridorTiming(input: unknown): CorridorTiming {
  return {
    requestId: safeInteger(field(input, 'requestId'), 'timing.requestId'),
    generation: safeInteger(field(input, 'generation'), 'timing.generation'),
    roundTripMs: finite(field(input, 'roundTripMs'), 'timing.roundTripMs'),
    workerLayoutMs: finite(
      field(input, 'workerLayoutMs'),
      'timing.workerLayoutMs',
    ),
    responseDecodeMs: finite(
      field(input, 'responseDecodeMs'),
      'timing.responseDecodeMs',
    ),
    transferAndSchedulingMs: finite(
      field(input, 'transferAndSchedulingMs'),
      'timing.transferAndSchedulingMs',
    ),
  };
}

test.describe.configure({ mode: 'serial' });

test('records full-network hybrid product Worker geometry in Chromium', async ({
  browser,
  page,
}, testInfo) => {
  test.skip(
    !shouldMeasure || testInfo.project.name !== 'chromium',
    'Issue #318 measurement runs only through its explicit Chromium command',
  );
  test.setTimeout(150_000);
  await page.goto('/');
  await installHarness(page);
  const results = [];
  for (const fixtureName of fixtureNames) {
    const raw: unknown = await page.evaluate(
      async ({ name, caseTimeoutMs }) => {
        const harness: unknown = Reflect.get(
          window,
          '__fukamuConnectionsHybridWorker',
        );
        if (typeof harness !== 'object' || harness === null) {
          throw new Error('connections hybrid Worker harness is missing');
        }
        const run: unknown = Reflect.get(harness, 'run');
        if (typeof run !== 'function') {
          throw new Error('connections hybrid Worker runner is missing');
        }
        const result: unknown = Reflect.apply(run, harness, [
          name,
          caseTimeoutMs,
        ]);
        return result;
      },
      { name: fixtureName, caseTimeoutMs: timeoutMs },
    );
    const result = decodeBrowserWorkerFeasibilityCaseResult(raw);
    expect(result.outcome, result.failure ?? undefined).toBe('completed');
    const timing = decodeCorridorTiming(field(raw, 'corridorTiming'));
    const curvePreparationMs = finite(
      field(raw, 'curvePreparationMs'),
      'curvePreparationMs',
    );
    expect(result.geometry).not.toBeNull();
    expect(result.geometry?.nodes).toBe(result.input.nodes);
    expect(result.geometry?.edges).toBe(result.input.edges);
    expect(result.geometry?.ports).toBe(result.input.edges * 2);
    expect(result.identity).toEqual({
      nodeIdsMatched: true,
      directedEdgesMatched: true,
    });
    expect(result.worker.isResetAfter).toBe(true);
    expect(timing.workerLayoutMs).toBeLessThanOrEqual(timing.roundTripMs);
    results.push({ ...result, corridorTiming: timing, curvePreparationMs });
    console.info(`connections-hybrid-worker ${JSON.stringify(results.at(-1))}`);
  }

  const artifact = {
    schemaVersion: 1,
    issue: 318,
    parentIssue: 304,
    branchPoint,
    generatedAt: new Date().toISOString(),
    environment: {
      browser: browser.version(),
      project: testInfo.project.name,
      userAgent: await page.evaluate(() => navigator.userAgent),
      viewport: page.viewportSize(),
      devicePixelRatio: await page.evaluate(() => window.devicePixelRatio),
      node: process.version,
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model ?? 'unknown',
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      layoutPolicy: 'ELK through 256/1024; corridor otherwise; lane spacing 8',
    },
    methodology: {
      timeoutMs,
      timeoutMeaning:
        'Per-case research guard; timeout is incomplete geometry and never a pass.',
      productPath:
        'Every graph is passed to createConnectionsLayoutWorkerManager with the production browser hybrid executor and production corridor Worker URL.',
      timing:
        'workerLayoutMs is measured inside the corridor Worker; responseDecodeMs validates returned geometry; transferAndSchedulingMs is the non-negative round-trip remainder; curvePreparationMs runs the production curve generator after layout.',
      scope:
        'This proves product Worker geometry only. It does not include React commit, SVG/HTML paint, camera interaction, or full-network UI cutover.',
    },
    results,
  };
  await mkdir('docs/benchmarks', { recursive: true });
  await writeFile(
    'docs/benchmarks/connections-hybrid-worker-feasibility.json',
    `${JSON.stringify(artifact, null, 2)}\n`,
    'utf8',
  );
  await testInfo.attach('connections-hybrid-worker-feasibility.json', {
    body: Buffer.from(JSON.stringify(artifact, null, 2)),
    contentType: 'application/json',
  });
});

let harnessSource: Promise<string> | undefined;

async function installHarness(page: Page): Promise<void> {
  harnessSource ??= buildHarness();
  await page.addScriptTag({ content: await harnessSource });
}

async function buildHarness(): Promise<string> {
  const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { '@': repositoryRoot } },
    build: {
      write: false,
      target: 'es2022',
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      lib: {
        entry: fileURLToPath(
          new URL(
            './fixtures/connections-hybrid-worker-harness.ts',
            import.meta.url,
          ),
        ),
        name: 'FukamuConnectionsHybridWorker',
        formats: ['iife'],
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if (!('output' in output)) continue;
    for (const item of output.output) {
      if (item.type === 'chunk') return item.code;
    }
  }
  throw new Error('connections hybrid Worker harness bundle is missing');
}

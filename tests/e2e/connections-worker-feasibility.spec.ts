import { cpus, platform, release, totalmem } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { build } from 'vite';
import { decodeBrowserWorkerFeasibilityCaseResult } from '@/tests/benchmarks/connections-browser-worker-feasibility-support';

const shouldMeasure =
  process.env.CONNECTIONS_BROWSER_WORKER_FEASIBILITY === '1';
const timeoutMs = 30_000;
const fixtureNames = [
  'representative-1000-e3000-mixed',
  'product-10000-existing',
  'connected-10000-e20000',
] as const;
const branchPoint = '084e9d789eb7a6c77e7ea27ddc579dac459ec75d';

test.describe.configure({ mode: 'serial' });

test('records full-network ELK feasibility in the Chromium Worker', async ({
  browser,
  page,
}, testInfo) => {
  test.skip(
    !shouldMeasure || testInfo.project.name !== 'chromium',
    'Issue #310 measurement runs only through its explicit Chromium command',
  );
  test.setTimeout(150_000);
  await page.goto('/');
  await installHarness(page);
  const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
  const results = [];
  for (const fixtureName of fixtureNames) {
    const raw: unknown = await page.evaluate(
      async ({ name, caseTimeoutMs }) => {
        const harness: unknown = Reflect.get(
          window,
          '__fukamuConnectionsWorkerFeasibility',
        );
        if (typeof harness !== 'object' || harness === null) {
          throw new Error('connections Worker feasibility harness is missing');
        }
        const run: unknown = Reflect.get(harness, 'run');
        if (typeof run !== 'function') {
          throw new Error('connections Worker feasibility runner is missing');
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
    results.push(result);
    console.info(`connections-browser-worker ${JSON.stringify(result)}`);
    expect(result.input.nodes).toBe(
      fixtureName === 'representative-1000-e3000-mixed' ? 1_000 : 10_000,
    );
    expect(result.input.edges).toBeGreaterThan(0);
    expect(result.worker.isResetAfter).toBe(true);
    if (result.outcome === 'completed') {
      expect(result.geometry).not.toBeNull();
      expect(result.geometry?.nodes).toBe(result.input.nodes);
      expect(result.geometry?.edges).toBe(result.input.edges);
      expect(result.identity).toEqual({
        nodeIdsMatched: true,
        directedEdgesMatched: true,
      });
    } else {
      expect(result.geometry).toBeNull();
      expect(result.identity).toEqual({
        nodeIdsMatched: false,
        directedEdgesMatched: false,
      });
    }
  }

  const artifact = {
    schemaVersion: 1,
    issue: 310,
    parentIssue: 304,
    branchPoint,
    generatedAt: new Date().toISOString(),
    environment: {
      browser: browser.version(),
      project: testInfo.project.name,
      userAgent: await page.evaluate(() => navigator.userAgent),
      viewport: page.viewportSize(),
      devicePixelRatio,
      node: process.version,
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model ?? 'unknown',
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      elkjs: '0.12.0',
      layoutConfiguration:
        'production Worker, FREE + ORTHOGONAL + separateConnectedComponents + thoroughness 7',
    },
    methodology: {
      timeoutMs,
      timeoutMeaning:
        'Per-case research guard. A timeout is incomplete geometry and never a pass.',
      fixtureIdentity:
        'The fixed-seed phase-0 fixture generators are bundled into Chromium and the complete graph is passed directly to the production Worker runner.',
      successValidation:
        'Every node ID and directed edge endpoint must match in input order; decoded geometry, sections, points, and generated paths must be finite.',
      memory:
        'performance.memory is observational and may be null; worker reset is verified after every case.',
      nodeComparison:
        'This browser artifact does not replace the phase-0 Node result. It measures the same full membership under the production Chromium Worker boundary.',
    },
    results,
  };
  await mkdir('docs/benchmarks', { recursive: true });
  await writeFile(
    'docs/benchmarks/connections-browser-worker-feasibility.json',
    `${JSON.stringify(artifact, null, 2)}\n`,
    'utf8',
  );
  const body = Buffer.from(JSON.stringify(artifact, null, 2));
  await testInfo.attach('connections-browser-worker-feasibility.json', {
    body,
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
            './fixtures/connections-worker-feasibility-harness.ts',
            import.meta.url,
          ),
        ),
        name: 'FukamuConnectionsWorkerFeasibility',
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
  throw new Error('connections Worker feasibility harness bundle is missing');
}

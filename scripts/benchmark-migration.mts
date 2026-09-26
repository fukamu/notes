import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  benchmarkRequestHeaders,
  decodeBenchmarkFixture,
  isLegacySyncResponse,
  liveBenchmarkTarget,
  parseBenchmarkOptions,
  percentile,
  validateBenchmarkOptions,
} from './migration-benchmark-core.mts';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = parseBenchmarkOptions(process.argv.slice(2));

if (options.help) {
  process.stdout.write(
    `Usage: npm run benchmark:migration -- [options]\n\nOptions:\n  --target=reference|go   Required implementation label\n  --base-url=URL          Required for a live run; loopback HTTP only\n  --store-id=ID           Required unique disposable-store label for a live run\n  --warmup=N              Warm-up requests (default 3)\n  --samples=N             Measured requests, at least 5 (default 5)\n  --dry-run               Validate inputs and print conditions only\n  --help                  Show this help\n\nLive reference auth reads MIGRATION_BENCHMARK_REFERENCE_SUBJECT.\nLive Go auth reads MIGRATION_BENCHMARK_GO_ASSERTION. Values are never printed.\n`,
  );
  process.exit(0);
}

validateBenchmarkOptions(options);

const fixturePath = resolve(
  repositoryRoot,
  'contracts/fixtures/sync/legacy-v1.json',
);
const fixture: unknown = JSON.parse(await readFile(fixturePath, 'utf8'));
const { request, setupRequests } = decodeBenchmarkFixture(fixture);
const conditions = {
  schemaVersion: 2,
  target: options.target,
  fixture: 'contracts/fixtures/sync/legacy-v1.json',
  setupRequests: setupRequests.length,
  measuredOperation: 'idempotent-sync-replay',
  warmup: options.warmup,
  samples: options.samples,
  database: 'isolated-target-owned',
  storeId: options.storeId ?? 'dry-run-not-allocated',
  authentication:
    options.target === 'reference'
      ? 'legacy-loopback-header'
      : 'local-signed-loopback-assertion',
  identityMaterial: 'redacted',
  externalEffects: 'forbidden',
};

if (options.dryRun) {
  process.stdout.write(`${JSON.stringify({ kind: 'dry-run', conditions })}\n`);
  process.exit(0);
}
const { baseUrl } = liveBenchmarkTarget(options);
const endpoint = new URL('/api/sync', baseUrl);
const headers = benchmarkRequestHeaders(options.target, baseUrl.origin, {
  referenceSubject: process.env.MIGRATION_BENCHMARK_REFERENCE_SUBJECT,
  goAssertion: process.env.MIGRATION_BENCHMARK_GO_ASSERTION,
});
for (const setupRequest of setupRequests) {
  await sample(endpoint, setupRequest, headers);
}
for (let index = 0; index < options.warmup; index += 1) {
  await sample(endpoint, request, headers);
}
const durations: number[] = [];
for (let index = 0; index < options.samples; index += 1) {
  durations.push(await sample(endpoint, request, headers));
}
durations.sort((left, right) => left - right);
process.stdout.write(
  `${JSON.stringify({
    kind: 'measurement',
    conditions,
    result: {
      p50Milliseconds: percentile(durations, 0.5),
      p95Milliseconds: percentile(durations, 0.95),
      minimumMilliseconds: Number((durations[0] ?? 0).toFixed(3)),
      maximumMilliseconds: Number(
        (durations[durations.length - 1] ?? 0).toFixed(3),
      ),
      errors: 0,
    },
  })}\n`,
);

async function sample(
  endpoint: URL,
  request: unknown,
  headers: Readonly<Record<string, string>>,
): Promise<number> {
  const startedAt = performance.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
    redirect: 'manual',
  });
  if (response.status !== 200) {
    throw new Error(`benchmark request returned ${response.status}`);
  }
  const responseBody: unknown = await response.json();
  if (!isLegacySyncResponse(responseBody)) {
    throw new Error('benchmark response does not match the legacy sync shape');
  }
  return performance.now() - startedAt;
}

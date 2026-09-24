import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = parseOptions(process.argv.slice(2));

if (options.help) {
  process.stdout.write(
    `Usage: npm run benchmark:migration -- [options]\n\nOptions:\n  --target=reference|go   Required implementation label\n  --base-url=URL          Required for a live run; loopback HTTP only\n  --warmup=N              Warm-up requests (default 3)\n  --samples=N             Measured requests, at least 5 (default 5)\n  --dry-run               Validate inputs and print conditions only\n  --help                  Show this help\n`,
  );
  process.exit(0);
}

if (options.target !== 'reference' && options.target !== 'go') {
  throw new Error('--target must be reference or go');
}
if (options.samples < 5) throw new Error('--samples must be at least 5');

const fixturePath = resolve(
  repositoryRoot,
  'contracts/fixtures/sync/legacy-v1.json',
);
/** @type {unknown} */
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
if (!isRecord(fixture) || !Object.hasOwn(fixture, 'request')) {
  throw new Error('legacy benchmark fixture is missing request');
}
const request = fixture.request;
const conditions = {
  schemaVersion: 1,
  target: options.target,
  fixture: 'contracts/fixtures/sync/legacy-v1.json',
  warmup: options.warmup,
  samples: options.samples,
  database: 'isolated-target-owned',
  externalEffects: 'forbidden',
};

if (options.dryRun) {
  process.stdout.write(`${JSON.stringify({ kind: 'dry-run', conditions })}\n`);
  process.exit(0);
}
if (!options.baseUrl)
  throw new Error('--base-url is required without --dry-run');
const baseUrl = new URL(options.baseUrl);
if (
  baseUrl.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname)
) {
  throw new Error(
    '--base-url must be loopback HTTP; remote and production targets are forbidden',
  );
}
const endpoint = new URL('/api/sync', baseUrl);
for (let index = 0; index < options.warmup; index += 1)
  await sample(endpoint, request);
/** @type {number[]} */
const durations = [];
for (let index = 0; index < options.samples; index += 1) {
  durations.push(await sample(endpoint, request));
}
durations.sort((left, right) => left - right);
process.stdout.write(
  `${JSON.stringify({
    kind: 'measurement',
    conditions,
    result: {
      p50Milliseconds: percentile(durations, 0.5),
      p95Milliseconds: percentile(durations, 0.95),
      errors: 0,
    },
  })}\n`,
);

/**
 * @param {URL} endpoint
 * @param {unknown} request
 */
async function sample(endpoint, request) {
  const startedAt = performance.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok)
    throw new Error(`benchmark request returned ${response.status}`);
  await response.arrayBuffer();
  return performance.now() - startedAt;
}

/**
 * @param {number[]} values
 * @param {number} fraction
 */
function percentile(values, fraction) {
  const index = Math.max(0, Math.ceil(values.length * fraction) - 1);
  const selected = values[index];
  if (selected === undefined) throw new Error('cannot sample empty results');
  return Number(selected.toFixed(3));
}

/**
 * @typedef {object} BenchmarkOptions
 * @property {string | undefined} target
 * @property {string | undefined} baseUrl
 * @property {number} warmup
 * @property {number} samples
 * @property {boolean} dryRun
 * @property {boolean} help
 */

/**
 * @param {string[]} arguments_
 * @returns {BenchmarkOptions}
 */
function parseOptions(arguments_) {
  /** @type {BenchmarkOptions} */
  const result = {
    target: undefined,
    baseUrl: undefined,
    warmup: 3,
    samples: 5,
    dryRun: false,
    help: false,
  };
  for (const argument of arguments_) {
    if (argument === '--dry-run') result.dryRun = true;
    else if (argument === '--help') result.help = true;
    else if (argument.startsWith('--target='))
      result.target = argument.slice(9);
    else if (argument.startsWith('--base-url='))
      result.baseUrl = argument.slice(11);
    else if (argument.startsWith('--warmup='))
      result.warmup = count(argument.slice(9), 'warmup');
    else if (argument.startsWith('--samples='))
      result.samples = count(argument.slice(10), 'samples');
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

/**
 * @param {string} source
 * @param {string} name
 */
function count(source, name) {
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`--${name} must be a non-negative safe integer`);
  return value;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

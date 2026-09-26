export type BenchmarkTarget = 'reference' | 'go';

export type BenchmarkOptions = Readonly<{
  target: BenchmarkTarget | undefined;
  baseUrl: string | undefined;
  storeId: string | undefined;
  warmup: number;
  samples: number;
  dryRun: boolean;
  help: boolean;
}>;

export type ReadyBenchmarkOptions = BenchmarkOptions &
  Readonly<{ target: BenchmarkTarget }>;

export function parseBenchmarkOptions(
  arguments_: readonly string[],
): BenchmarkOptions {
  let target: BenchmarkTarget | undefined;
  let baseUrl: string | undefined;
  let storeId: string | undefined;
  let warmup = 3;
  let samples = 5;
  let dryRun = false;
  let help = false;
  for (const argument of arguments_) {
    if (argument === '--dry-run') dryRun = true;
    else if (argument === '--help') help = true;
    else if (argument.startsWith('--target=')) {
      const value = argument.slice(9);
      if (value !== 'reference' && value !== 'go') {
        throw new Error('--target must be reference or go');
      }
      target = value;
    } else if (argument.startsWith('--base-url=')) {
      baseUrl = argument.slice(11);
    } else if (argument.startsWith('--store-id=')) {
      const value = argument.slice(11);
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)) {
        throw new Error('--store-id is invalid');
      }
      storeId = value;
    } else if (argument.startsWith('--warmup=')) {
      warmup = count(argument.slice(9), 'warmup');
    } else if (argument.startsWith('--samples=')) {
      samples = count(argument.slice(10), 'samples');
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { target, baseUrl, storeId, warmup, samples, dryRun, help };
}

export function validateBenchmarkOptions(
  options: BenchmarkOptions,
): asserts options is ReadyBenchmarkOptions {
  if (options.target === undefined) {
    throw new Error('--target must be reference or go');
  }
  if (options.warmup < 1) throw new Error('--warmup must be at least 1');
  if (options.samples < 5) throw new Error('--samples must be at least 5');
}

export function liveBenchmarkTarget(options: ReadyBenchmarkOptions): Readonly<{
  baseUrl: URL;
  storeId: string;
}> {
  if (options.baseUrl === undefined) {
    throw new Error('--base-url is required without --dry-run');
  }
  if (options.storeId === undefined) {
    throw new Error('--store-id is required without --dry-run');
  }
  return { baseUrl: loopbackURL(options.baseUrl), storeId: options.storeId };
}

export function decodeBenchmarkFixture(candidate: unknown): Readonly<{
  setupRequests: readonly unknown[];
  request: unknown;
}> {
  if (
    !isRecord(candidate) ||
    !Array.isArray(candidate.setupRequests) ||
    candidate.setupRequests.length === 0 ||
    !Object.hasOwn(candidate, 'request')
  ) {
    throw new Error('legacy benchmark fixture is missing setup or request');
  }
  return { setupRequests: candidate.setupRequests, request: candidate.request };
}

export function benchmarkRequestHeaders(
  target: BenchmarkTarget,
  origin: string,
  identity: Readonly<{
    referenceSubject: unknown;
    goAssertion: unknown;
  }>,
): Readonly<Record<string, string>> {
  if (target === 'reference') {
    const subject = identity.referenceSubject;
    if (
      typeof subject !== 'string' ||
      !/^[\u0021-\u002b\u002d-\u007e]{1,256}$/u.test(subject)
    ) {
      throw new Error(
        'MIGRATION_BENCHMARK_REFERENCE_SUBJECT is required and invalid',
      );
    }
    return {
      'Content-Type': 'application/json',
      Origin: origin,
      'oai-authenticated-user-id': subject,
    };
  }
  const assertion = identity.goAssertion;
  if (
    typeof assertion !== 'string' ||
    assertion.length > 8_192 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(assertion)
  ) {
    throw new Error('MIGRATION_BENCHMARK_GO_ASSERTION is required and invalid');
  }
  return {
    'Content-Type': 'application/json',
    Origin: origin,
    'X-Fukamu-Local-Identity-Assertion': assertion,
  };
}

export function isLegacySyncResponse(
  candidate: unknown,
): candidate is Readonly<{
  cards: readonly unknown[];
  conflicts: readonly unknown[];
  acknowledgedMutationIds: readonly unknown[];
}> {
  return (
    isRecord(candidate) &&
    Array.isArray(candidate.cards) &&
    Array.isArray(candidate.conflicts) &&
    Array.isArray(candidate.acknowledgedMutationIds)
  );
}

export function percentile(
  values: readonly number[],
  fraction: number,
): number {
  const index = Math.max(0, Math.ceil(values.length * fraction) - 1);
  const selected = values[index];
  if (selected === undefined) throw new Error('cannot sample empty results');
  return Number(selected.toFixed(3));
}

function loopbackURL(source: string): URL {
  const value = new URL(source);
  if (
    value.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname) ||
    value.username.length !== 0 ||
    value.password.length !== 0 ||
    value.pathname !== '/' ||
    value.search.length !== 0 ||
    value.hash.length !== 0
  ) {
    throw new Error(
      '--base-url must be a root loopback HTTP URL without credentials',
    );
  }
  return value;
}

function count(source: string, name: string): number {
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative safe integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

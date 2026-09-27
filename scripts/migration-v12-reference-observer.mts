import { createHash } from 'node:crypto';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { V12_REFERENCE_REVISION } from './migration-v12-evidence-core.mts';

const referenceHandlerPath = 'app/api/sync/handler.ts';
const observerPath = 'server/v12-query-observer.ts';
export const V12_REFERENCE_HANDLER_SHA256 =
  'b9a3156c5a0035472ea3d67945ba143990c6037866c543e500ed245e6478aa90';
export const V12_REFERENCE_PATCHED_HANDLER_SHA256 =
  '729b964e3d9b31edfd2139f21034513417aec3fcb6ad24c4e2ccb13d6d6871e4';

const observerSource = `type Counter = { count: number };

class ObservedStatement implements D1PreparedStatement {
  constructor(
    private readonly inner: D1PreparedStatement,
    private readonly counter: Counter,
  ) {}

  unwrap(): D1PreparedStatement {
    return this.inner;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new ObservedStatement(this.inner.bind(...values), this.counter);
  }

  first<T = unknown>(columnName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    this.counter.count += 1;
    return columnName === undefined
      ? this.inner.first<T>()
      : this.inner.first<T>(columnName);
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.counter.count += 1;
    return this.inner.run<T>();
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.counter.count += 1;
    return this.inner.all<T>();
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  raw<T = unknown[]>(
    options?: { columnNames?: boolean },
  ): Promise<T[] | [string[], ...T[]]> {
    this.counter.count += 1;
    if (options?.columnNames === true) {
      return this.inner.raw<T>({ columnNames: true });
    }
    return options?.columnNames === false
      ? this.inner.raw<T>({ columnNames: false })
      : this.inner.raw<T>();
  }
}

class ObservedDatabase implements D1Database {
  constructor(
    private readonly inner: D1Database,
    private readonly counter: Counter,
  ) {}

  prepare(query: string): D1PreparedStatement {
    return new ObservedStatement(this.inner.prepare(query), this.counter);
  }

  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const inner = statements.map((statement) => {
      if (!(statement instanceof ObservedStatement)) {
        throw new Error('V12 observer received an unowned D1 statement');
      }
      return statement.unwrap();
    });
    this.counter.count += inner.length;
    return this.inner.batch<T>(inner);
  }

  exec(query: string): Promise<D1ExecResult> {
    this.counter.count += 1;
    return this.inner.exec(query);
  }

  withSession(
    _constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint,
  ): D1DatabaseSession {
    throw new Error('V12 observer does not permit uncounted D1 sessions');
  }

  dump(): Promise<ArrayBuffer> {
    throw new Error('V12 observer does not permit D1 dumps');
  }
}

export function observeV12Environment(
  environment: unknown,
  sampleId: string | null,
): Readonly<{
  environment: unknown;
  sampleId: string;
  queryCount: () => number;
}> {
  if (
    environment === null ||
    typeof environment !== 'object' ||
    sampleId === null ||
    !/^[a-z0-9][a-z0-9.-]{0,127}$/.test(sampleId)
  ) {
    throw new Error('invalid V12 observer boundary');
  }
  const database: unknown = Reflect.get(environment, 'DB');
  if (
    database === null ||
    typeof database !== 'object' ||
    typeof Reflect.get(database, 'prepare') !== 'function' ||
    typeof Reflect.get(database, 'batch') !== 'function'
  ) {
    throw new Error('invalid V12 D1 binding');
  }
  const counter: Counter = { count: 0 };
  const observed = new ObservedDatabase(database as D1Database, counter);
  return {
    environment: new Proxy(environment, {
      get(target, property, receiver) {
        return property === 'DB'
          ? observed
          : Reflect.get(target, property, receiver);
      },
    }),
    sampleId,
    queryCount: () => counter.count,
  };
}
`;

export const V12_REFERENCE_OBSERVER_SHA256 = sha256(observerSource);

export type InstalledReferenceObserver = Readonly<{
  patchedHandlerSha256: string;
  observerSha256: string;
  restore: () => Promise<void>;
}>;

/**
 * Restores only the exact observer patch owned by this runner. This recovery
 * exists for an interrupted measurement process; unknown reference changes
 * are never overwritten.
 */
export async function recoverOwnedReferenceObserver(
  worktree: string,
): Promise<void> {
  const root = path.resolve(worktree);
  const head = (await command(root, ['git', 'rev-parse', 'HEAD'])).trim();
  if (head !== V12_REFERENCE_REVISION) {
    throw new Error('reference worktree is not the exact runnable revision');
  }
  const handler = path.join(root, referenceHandlerPath);
  const observer = path.join(root, observerPath);
  const handlerDigest = sha256(await readFile(handler));
  let observerDigest: string | undefined;
  try {
    observerDigest = sha256(await readFile(observer));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  if (
    handlerDigest === V12_REFERENCE_HANDLER_SHA256 &&
    observerDigest === undefined
  ) {
    return;
  }
  if (
    handlerDigest !== V12_REFERENCE_PATCHED_HANDLER_SHA256 ||
    observerDigest !== V12_REFERENCE_OBSERVER_SHA256
  ) {
    throw new Error(
      'reference worktree contains unknown changes; owned recovery refused',
    );
  }
  const original = await command(root, [
    'git',
    'show',
    `${V12_REFERENCE_REVISION}:${referenceHandlerPath}`,
  ]);
  if (sha256(original) !== V12_REFERENCE_HANDLER_SHA256) {
    throw new Error('reference HEAD blob does not match the pinned handler');
  }
  const errors = await restoreReferenceFiles(root, handler, observer, original);
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'owned reference observer recovery failed',
    );
  }
}

export async function installReferenceObserver(
  worktree: string,
): Promise<InstalledReferenceObserver> {
  const root = path.resolve(worktree);
  const head = (await command(root, ['git', 'rev-parse', 'HEAD'])).trim();
  if (head !== V12_REFERENCE_REVISION) {
    throw new Error('reference worktree is not the exact runnable revision');
  }
  const status = await command(root, ['git', 'status', '--short']);
  if (status !== '') throw new Error('reference worktree has tracked changes');
  const handler = path.join(root, referenceHandlerPath);
  const observer = path.join(root, observerPath);
  const original = await readFile(handler, 'utf8');
  if (sha256(original) !== V12_REFERENCE_HANDLER_SHA256) {
    throw new Error(
      'reference handler content does not match the exact revision',
    );
  }
  try {
    await stat(observer);
    throw new Error('reference observer path already exists');
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('ENOENT')) {
      throw error;
    }
  }
  const patched = patchHandler(original);
  if (sha256(patched) !== V12_REFERENCE_PATCHED_HANDLER_SHA256) {
    throw new Error('reference handler observer patch is not source-bound');
  }
  try {
    await writeFile(observer, observerSource, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(handler, patched, 'utf8');
  } catch (installationError) {
    const cleanupErrors = await restoreReferenceFiles(
      root,
      handler,
      observer,
      original,
    );
    throw new AggregateError(
      [installationError, ...cleanupErrors],
      'reference observer installation failed and was rolled back',
    );
  }
  let restored = false;
  return {
    patchedHandlerSha256: sha256(patched),
    observerSha256: V12_REFERENCE_OBSERVER_SHA256,
    restore: async () => {
      if (restored) return;
      restored = true;
      const errors = await restoreReferenceFiles(
        root,
        handler,
        observer,
        original,
      );
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          'reference observer restoration failed',
        );
      }
    },
  };
}

async function restoreReferenceFiles(
  root: string,
  handler: string,
  observer: string,
  original: string,
): Promise<Error[]> {
  const errors: Error[] = [];
  try {
    await writeFile(handler, original, 'utf8');
  } catch (error) {
    errors.push(asError(error, 'restore reference handler'));
  }
  try {
    await unlink(observer);
  } catch (error) {
    if (!isMissingFile(error))
      errors.push(asError(error, 'remove reference observer'));
  }
  try {
    const restoredDigest = sha256(await readFile(handler));
    if (restoredDigest !== V12_REFERENCE_HANDLER_SHA256) {
      errors.push(new Error('reference handler restoration digest mismatch'));
    }
  } catch (error) {
    errors.push(asError(error, 'verify reference handler restoration'));
  }
  try {
    const status = await command(root, ['git', 'status', '--short']);
    if (status !== '')
      errors.push(
        new Error('reference worktree is not clean after restoration'),
      );
  } catch (error) {
    errors.push(asError(error, 'verify reference worktree restoration'));
  }
  return errors;
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    Reflect.get(error, 'code') === 'ENOENT'
  );
}

function asError(error: unknown, label: string): Error {
  return error instanceof Error
    ? error
    : new Error(`${label}: unknown failure`);
}

function patchHandler(original: string): string {
  const withImport = replaceExactlyOnce(
    original,
    "import { buildRuntimeMode } from '@/server/launch-gate/runtime';\n",
    "import { buildRuntimeMode } from '@/server/launch-gate/runtime';\n" +
      "import { observeV12Environment } from '@/server/v12-query-observer';\n",
  );
  const withObserver = replaceExactlyOnce(
    withImport,
    '): Promise<Response> {\n  const launchGateResponse = await enforceLaunchGate(\n    request,\n    environment,\n',
    "): Promise<Response> {\n  const observation = observeV12Environment(\n    environment,\n    request.headers.get('x-fukamu-v12-sample-id'),\n  );\n  const launchGateResponse = await enforceLaunchGate(\n    request,\n    observation.environment,\n",
  );
  const withDatabase = replaceExactlyOnce(
    withObserver,
    '    const database = getD1Binding(environment);\n',
    '    const database = getD1Binding(observation.environment);\n',
  );
  return replaceExactlyOnce(
    withDatabase,
    "      headers: { 'Cache-Control': 'no-store' },\n",
    '      headers: {\n' +
      "        'Cache-Control': 'no-store',\n" +
      "        'X-Fukamu-V12-Query-Count': String(observation.queryCount()),\n" +
      "        'X-Fukamu-V12-Sample-Id': observation.sampleId,\n" +
      '      },\n',
  );
}

function replaceExactlyOnce(
  source: string,
  expected: string,
  replacement: string,
): string {
  const first = source.indexOf(expected);
  if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error('reference observer patch anchor is missing or ambiguous');
  }
  return (
    source.slice(0, first) + replacement + source.slice(first + expected.length)
  );
}

async function command(
  cwd: string,
  arguments_: readonly string[],
): Promise<string> {
  const [executable, ...argumentsTail] = arguments_;
  if (executable === undefined) throw new Error('missing command');
  const child = spawn(executable, argumentsTail, {
    cwd,
    env: safeChildEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: Uint8Array[] = [];
  const errors: Uint8Array[] = [];
  child.stdout?.on('data', (chunk: Uint8Array) => output.push(chunk));
  child.stderr?.on('data', (chunk: Uint8Array) => errors.push(chunk));
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve(status ?? 1));
  });
  if (code !== 0) {
    throw new Error(
      `reference observer command failed (${code}): ${Buffer.concat(errors).toString('utf8').slice(0, 500)}`,
    );
  }
  return Buffer.concat(output).toString('utf8');
}

function safeChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL']) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.WRANGLER_SEND_METRICS = 'false';
  environment.NO_PROXY = '127.0.0.1,localhost,::1';
  environment.no_proxy = environment.NO_PROXY;
  return environment;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

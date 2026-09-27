import { spawn, type ChildProcess } from 'node:child_process';
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  classifyV12ProvisionalReview,
  decodeV12Evidence,
  decodeV12SyncFragment,
  sha256Hex,
  summarizeV12Samples,
  verifyV12GitProvenance,
  verifyV12SourceContent,
  V12_BROWSER_SCALES,
  V12_BROWSER_OPERATIONS,
  V12_INTEGRATION_BRANCH_POINT,
  V12_LEGACY_OPERATIONS,
  V12_REFERENCE_REVISION,
  V12_RETIREMENT_REVISION,
  V12_REVIEWED_LEGACY_OPERATIONS,
  V12_RUNNER_VERSION,
  V12_SCALES,
  V12_SOURCE_PATHS,
  V12_SYNC_OPERATIONS,
  V12_TARGETS,
  type V12BrowserOperation,
  type V12Evidence,
  type V12LegacyOperation,
  type V12LegacyRun,
  type V12Target,
} from './migration-v12-evidence-core.mts';
import {
  collectBrowserRun,
  collectLegacyHTTPRun,
  collectLegacyQueryEvidence,
  fixtureSeedDigest,
  fixtureSeedSQL,
  fixtureUUID,
  initialFixtureCard,
  type V12BrowserRun,
  type V12QueryEvidence,
} from './migration-v12-legacy-collector.mts';
import {
  installReferenceObserver,
  recoverOwnedReferenceObserver,
  V12_REFERENCE_HANDLER_SHA256,
  V12_REFERENCE_OBSERVER_SHA256,
  V12_REFERENCE_PATCHED_HANDLER_SHA256,
} from './migration-v12-reference-observer.mts';

const confirmationName = 'FUKAMU_V12_PERFORMANCE_CONFIRM';
const requiredConfirmation = 'local-disposable-only';
const databaseEnvironment = 'NOTES_TEST_DATABASE_URL';
const referenceRoot = '/tmp/notes-v12-reference-f423';
const outputRelativePath = 'docs/benchmarks/migration-v12-local.json';
const ownedPrefix = 'fukamu-v12-';
const ownedMarkerName = '.fukamu-v12-owned';
const ownedMarkerValue = 'fukamu-notes-v12-owned-v1\n';
const benchmarkSubject = 'fukamu-notes-v12-local';
const localIssuer = 'https://v12.local.invalid';
const localAudience = 'fukamu-notes-v12';
const localAssertionHeader = 'X-Fukamu-Local-Identity-Assertion';
const referenceIdentityHeader = 'oai-authenticated-user-id';
const runsPerCell = 5;
const maximumCommandOutputBytes = 2 * 1024 * 1024;
const fixtureAccountID = '01999c20-9e33-7000-8000-000000000001';
const fixtureVaultID = '01999c20-9e33-7000-8000-000000000002';
const fixtureSessionID = '01999c20-9e33-7000-8000-000000000003';
const fixtureSessionEpoch = '1';

type OwnedPaths = Readonly<{
  root: string;
  home: string;
  xdg: string;
  goCache: string;
  binaries: string;
  goFrontend: string;
  referenceFrontend: string;
  referenceQuery: string;
  notesBinary: string;
  notesctlBinary: string;
  queryCompanionBinary: string;
  syncOutput: string;
}>;

type RuntimeArtifacts = V12Evidence['identity']['runtimeArtifacts'];

type IdentityMaterial = Readonly<{
  privateKey: KeyObject;
  publicKey: string;
  issuer: string;
  audience: string;
}>;

type FixtureSecrets = Readonly<{
  sessionToken: string;
  cursorKey: string;
  deletionKey: string;
}>;

type RunningServer = Readonly<{
  child: ChildProcess;
  processGroupId: number;
  baseUrl: URL;
  coldStartMilliseconds: number;
  stop: () => Promise<void>;
}>;

type CommandOptions = Readonly<{
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMilliseconds?: number;
  label: string;
}>;

type BuiltRuntime = Readonly<{
  paths: OwnedPaths;
  artifacts: RuntimeArtifacts;
  referenceWrangler: string;
  identity: IdentityMaterial;
  goModuleCache: string;
}>;

type D1Store = Readonly<{
  persistDirectory: string;
  witness: string;
}>;

type GoBrowserFixture = Readonly<{
  environment: NodeJS.ProcessEnv;
  secrets: FixtureSecrets;
  storeWitness: string;
  databaseName: string;
}>;

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

assertInvocationBoundary();
const databaseURL = requiredDatabaseURL();
await runOwnedBenchmark(databaseURL);

function assertInvocationBoundary(): void {
  if (process.argv.length !== 2) {
    throw new Error('V12 benchmark accepts no command-line arguments');
  }
  if (process.env[confirmationName] !== requiredConfirmation) {
    throw new Error(
      `${confirmationName}=${requiredConfirmation} is required before any local mutation`,
    );
  }
  if (platform() !== 'linux') {
    throw new Error('V12 benchmark requires Linux /proc measurement');
  }
}

function requiredDatabaseURL(): string {
  const source = process.env[databaseEnvironment];
  if (source === undefined || !isExactDisposableDatabaseURL(source)) {
    throw new Error(
      'NOTES_TEST_DATABASE_URL must identify the exact loopback disposable fukamu_notes_go_test database',
    );
  }
  return source;
}

function isExactDisposableDatabaseURL(source: string): boolean {
  let candidate: URL;
  try {
    candidate = new URL(source);
  } catch {
    return false;
  }
  const loopback =
    candidate.hostname === 'localhost' ||
    candidate.hostname === '127.0.0.1' ||
    candidate.hostname === '[::1]' ||
    candidate.hostname === '::1';
  const keys = [...candidate.searchParams.keys()];
  return (
    (candidate.protocol === 'postgres:' ||
      candidate.protocol === 'postgresql:') &&
    loopback &&
    candidate.pathname === '/fukamu_notes_go_test' &&
    candidate.hash === '' &&
    keys.every((key) => key === 'sslmode') &&
    candidate.searchParams.getAll('sslmode').length <= 1
  );
}

async function runOwnedBenchmark(databaseURL: string): Promise<void> {
  const outputPath = path.join(repositoryRoot, outputRelativePath);
  await assertMissing(outputPath, 'V12 evidence output already exists');
  const measuredRevision = await verifyCommittedInputs();
  await recoverOwnedReferenceObserver(referenceRoot);
  await verifyReferenceWorktree();

  const paths = await createOwnedPaths();
  const cleanupServers = new Set<() => Promise<void>>();
  let failure: unknown;
  let interrupted: NodeJS.Signals | undefined;
  const interrupt = (signal: NodeJS.Signals) => {
    interrupted = signal;
    for (const cleanup of cleanupServers) void cleanup();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const runtime = await buildRuntime(paths);
    const host = await collectHostIdentity(runtime, databaseURL);
    const legacyRuns = await collectLegacyMatrix(
      runtime,
      databaseURL,
      cleanupServers,
    );
    const browserRuns = await collectBrowserMatrix(
      runtime,
      databaseURL,
      cleanupServers,
    );
    const syncFragment = await collectSyncV2Evidence(runtime, databaseURL);
    const evidence = await assembleEvidence(
      measuredRevision,
      runtime,
      host,
      legacyRuns,
      browserRuns,
      syncFragment,
    );
    await assertRuntimeArtifactsUnchanged(runtime);
    await writeVerifiedEvidence(outputPath, evidence, measuredRevision);
  } catch (error) {
    failure = error;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    for (const cleanup of [...cleanupServers].reverse()) {
      try {
        await cleanup();
      } catch (cleanupError) {
        failure ??= cleanupError;
      }
    }
    try {
      await recoverOwnedReferenceObserver(referenceRoot);
      await verifyReferenceWorktree();
    } catch (cleanupError) {
      failure ??= cleanupError;
    }
    try {
      await removeOwnedPaths(paths);
    } catch (cleanupError) {
      failure ??= cleanupError;
    }
  }
  if (interrupted !== undefined) {
    throw new Error(`V12 benchmark interrupted by ${interrupted}`);
  }
  if (failure !== undefined) throw failure;
}

async function verifyCommittedInputs(): Promise<string> {
  const top = (
    await gitText(repositoryRoot, ['rev-parse', '--show-toplevel'])
  ).trim();
  if ((await realpath(top)) !== (await realpath(repositoryRoot))) {
    throw new Error('V12 runner must execute from its committed repository');
  }
  const head = (await gitText(repositoryRoot, ['rev-parse', 'HEAD'])).trim();
  if (!/^[a-f0-9]{40}$/u.test(head) || head === V12_INTEGRATION_BRANCH_POINT) {
    throw new Error(
      'V12 measurement requires committed implementation commit A',
    );
  }
  if (
    !(await gitSucceeded(repositoryRoot, [
      'merge-base',
      '--is-ancestor',
      V12_INTEGRATION_BRANCH_POINT,
      head,
    ]))
  ) {
    throw new Error('V12 integration branch point is not an ancestor of HEAD');
  }
  const status = await gitText(repositoryRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  if (status !== '') {
    throw new Error('V12 measurement requires a clean committed worktree');
  }
  for (const sourcePath of V12_SOURCE_PATHS) {
    const working = await readFile(path.join(repositoryRoot, sourcePath));
    const committed = await gitBytes(repositoryRoot, [
      'show',
      `${head}:${sourcePath}`,
    ]);
    if (sha256Hex(working) !== sha256Hex(committed)) {
      throw new Error(`committed producer mismatch: ${sourcePath}`);
    }
  }
  return head;
}

async function verifyReferenceWorktree(): Promise<void> {
  if ((await realpath(referenceRoot)) !== referenceRoot) {
    throw new Error('reference worktree path must resolve exactly');
  }
  const head = (await gitText(referenceRoot, ['rev-parse', 'HEAD'])).trim();
  const status = await gitText(referenceRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  if (head !== V12_REFERENCE_REVISION || status !== '') {
    throw new Error('exact f423 reference worktree must be detached and clean');
  }
  const branch = (
    await gitText(
      referenceRoot,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      true,
    )
  ).trim();
  if (branch !== '') {
    throw new Error('reference worktree must remain detached');
  }
  const handler = await readFile(
    path.join(referenceRoot, 'app/api/sync/handler.ts'),
  );
  if (sha256Hex(handler) !== V12_REFERENCE_HANDLER_SHA256) {
    throw new Error('exact reference handler digest mismatch');
  }
}

async function createOwnedPaths(): Promise<OwnedPaths> {
  const root = await mkdtemp(path.join(tmpdir(), ownedPrefix));
  await chmod(root, 0o700);
  await writeFile(path.join(root, ownedMarkerName), ownedMarkerValue, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  const home = path.join(root, 'home');
  const xdg = path.join(root, 'xdg');
  const goCache = path.join(root, 'go-cache');
  const binaries = path.join(root, 'bin');
  for (const directory of [home, xdg, goCache, binaries]) {
    await mkdir(directory, { mode: 0o700 });
  }
  return {
    root,
    home,
    xdg,
    goCache,
    binaries,
    goFrontend: path.join(root, 'go-frontend'),
    referenceFrontend: path.join(root, 'reference-native'),
    referenceQuery: path.join(root, 'reference-query'),
    notesBinary: path.join(binaries, 'notes'),
    notesctlBinary: path.join(binaries, 'notesctl'),
    queryCompanionBinary: path.join(binaries, 'v12legacybenchmark'),
    syncOutput: path.join(root, 'migration-v12-sync-v2.json'),
  };
}

async function removeOwnedPaths(paths: OwnedPaths): Promise<void> {
  const root = paths.root;
  if (
    path.dirname(root) !== tmpdir() ||
    !path.basename(root).startsWith(ownedPrefix)
  ) {
    throw new Error('refusing to clean an unexpected V12 path');
  }
  const owner = process.getuid?.();
  const rootStat = await lstat(root);
  const markerPath = path.join(root, ownedMarkerName);
  const markerStat = await lstat(markerPath);
  if (
    owner === undefined ||
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    rootStat.uid !== owner ||
    (rootStat.mode & 0o7777) !== 0o700 ||
    !markerStat.isFile() ||
    markerStat.isSymbolicLink() ||
    markerStat.uid !== owner ||
    markerStat.nlink !== 1 ||
    (markerStat.mode & 0o7777) !== 0o600 ||
    (await readFile(markerPath, 'utf8')) !== ownedMarkerValue
  ) {
    throw new Error('refusing to clean an unowned V12 directory');
  }
  await rm(root, { recursive: true, force: false });
}

async function buildRuntime(paths: OwnedPaths): Promise<BuiltRuntime> {
  const baseEnvironment = isolatedEnvironment(paths);
  const goModuleCache = (
    await commandText('go', ['env', 'GOMODCACHE'], {
      cwd: repositoryRoot,
      environment: environmentWithHostHome(baseEnvironment),
      label: 'resolve local Go module cache',
    })
  ).trim();
  if (goModuleCache === '' || !path.isAbsolute(goModuleCache)) {
    throw new Error('Go module cache path is unavailable');
  }
  const goEnvironment = {
    ...baseEnvironment,
    GOCACHE: paths.goCache,
    GOMODCACHE: goModuleCache,
    GOTOOLCHAIN: 'auto',
    GOPROXY: 'off',
    GOSUMDB: 'off',
    CGO_ENABLED: '0',
  };
  await commandText('npm', ['run', 'build:frontend'], {
    cwd: repositoryRoot,
    environment: baseEnvironment,
    timeoutMilliseconds: 20 * 60_000,
    label: 'build committed Go frontend',
  });
  await copyExactTree(
    path.join(repositoryRoot, 'dist/frontend'),
    paths.goFrontend,
  );
  await Promise.all([
    buildGoBinary(goEnvironment, paths.notesBinary, './cmd/notes'),
    buildGoBinary(goEnvironment, paths.notesctlBinary, './cmd/notesctl'),
    buildGoBinary(
      goEnvironment,
      paths.queryCompanionBinary,
      './cmd/v12legacybenchmark',
    ),
  ]);

  const referenceWrangler = path.join(
    referenceRoot,
    'node_modules/.bin/wrangler',
  );
  await requireRegularExecutable(referenceWrangler, 'reference Wrangler');
  await buildReferenceTrees(paths, baseEnvironment);

  const { privateKey } = generateKeyPairSync('ed25519');
  const publicDER = createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki',
  });
  const identity: IdentityMaterial = {
    privateKey,
    publicKey: publicDER.subarray(publicDER.length - 32).toString('base64url'),
    issuer: localIssuer,
    audience: localAudience,
  };
  const artifacts: RuntimeArtifacts = {
    goNotesBinarySha256: await fileSha256(paths.notesBinary),
    goNotesctlBinarySha256: await fileSha256(paths.notesctlBinary),
    goQueryCompanionBinarySha256: await fileSha256(paths.queryCompanionBinary),
    goFrontendBuildSha256: await treeSha256(paths.goFrontend),
    referenceFrontendBuildSha256: await treeSha256(paths.referenceFrontend),
    referenceQueryBuildSha256: await treeSha256(paths.referenceQuery),
  };
  return {
    paths,
    artifacts,
    referenceWrangler,
    identity,
    goModuleCache,
  };
}

async function buildGoBinary(
  environment: NodeJS.ProcessEnv,
  output: string,
  target: string,
): Promise<void> {
  await commandText('go', ['build', '-trimpath', '-o', output, target], {
    cwd: path.join(repositoryRoot, 'backend'),
    environment,
    timeoutMilliseconds: 20 * 60_000,
    label: `build ${path.basename(output)}`,
  });
  await chmod(output, 0o700);
  await requireRegularExecutable(output, path.basename(output));
}

async function buildReferenceTrees(
  paths: OwnedPaths,
  baseEnvironment: NodeJS.ProcessEnv,
): Promise<void> {
  const environment = referenceEnvironment(paths, baseEnvironment);
  const dist = path.join(referenceRoot, 'dist');
  await rm(dist, { recursive: true, force: true });
  await commandText('npm', ['run', 'build'], {
    cwd: referenceRoot,
    environment,
    timeoutMilliseconds: 20 * 60_000,
    label: 'build exact uninstrumented reference',
  });
  await copyExactTree(dist, paths.referenceFrontend);

  const observer = await installReferenceObserver(referenceRoot);
  try {
    await rm(dist, { recursive: true, force: true });
    await commandText('npm', ['run', 'typecheck:api'], {
      cwd: referenceRoot,
      environment,
      timeoutMilliseconds: 10 * 60_000,
      label: 'typecheck exact reference query observer',
    });
    await commandText('npm', ['run', 'build'], {
      cwd: referenceRoot,
      environment,
      timeoutMilliseconds: 20 * 60_000,
      label: 'build exact instrumented reference query companion',
    });
    await copyExactTree(dist, paths.referenceQuery);
    if (
      observer.patchedHandlerSha256 !== V12_REFERENCE_PATCHED_HANDLER_SHA256 ||
      observer.observerSha256 !== V12_REFERENCE_OBSERVER_SHA256
    ) {
      throw new Error('reference observer build identity mismatch');
    }
  } finally {
    await observer.restore();
  }
  await verifyReferenceWorktree();
}

async function collectLegacyMatrix(
  runtime: BuiltRuntime,
  databaseURL: string,
  cleanupServers: Set<() => Promise<void>>,
): Promise<readonly V12LegacyRun[]> {
  const entries: V12LegacyRun[] = [];
  for (const scale of V12_SCALES) {
    for (let run = 1; run <= runsPerCell; run += 1) {
      entries.push(
        await collectReferenceLegacyCell(runtime, scale, run, cleanupServers),
      );
      entries.push(
        await collectGoLegacyCell(
          runtime,
          databaseURL,
          scale,
          run,
          cleanupServers,
        ),
      );
    }
  }
  return canonicalTargetRuns(entries);
}

async function collectReferenceLegacyCell(
  runtime: BuiltRuntime,
  scale: number,
  run: number,
  cleanupServers: Set<() => Promise<void>>,
): Promise<V12LegacyRun> {
  const headers = {
    'Content-Type': 'application/json',
    [referenceIdentityHeader]: benchmarkSubject,
  };
  const queryStore = await prepareReferenceStore(
    runtime,
    runtime.paths.referenceQuery,
    'legacy-query',
    scale,
    run,
  );
  const queryPort = await reserveLoopbackPort();
  const queryServer = await startReferenceServer(
    runtime,
    runtime.paths.referenceQuery,
    queryStore.persistDirectory,
    queryPort,
    'reference legacy query companion',
  );
  cleanupServers.add(queryServer.stop);
  let queryEvidence: V12QueryEvidence;
  try {
    queryEvidence = await collectLegacyQueryEvidence({
      target: 'reference',
      scale,
      run,
      baseUrl: queryServer.baseUrl,
      headers,
      storeWitness: queryStore.witness,
      runtimeArtifactSha256: runtime.artifacts.referenceQueryBuildSha256,
      processGroupId: queryServer.processGroupId,
    });
  } finally {
    cleanupServers.delete(queryServer.stop);
    await queryServer.stop();
  }

  const timedStore = await prepareReferenceStore(
    runtime,
    runtime.paths.referenceFrontend,
    'legacy-timed',
    scale,
    run,
  );
  const timedPort = await reserveLoopbackPort();
  const timedServer = await startReferenceServer(
    runtime,
    runtime.paths.referenceFrontend,
    timedStore.persistDirectory,
    timedPort,
    'reference legacy timed runtime',
  );
  cleanupServers.add(timedServer.stop);
  try {
    return await collectLegacyHTTPRun({
      target: 'reference',
      scale,
      run,
      baseUrl: timedServer.baseUrl,
      headers,
      storeWitness: timedStore.witness,
      runtimeArtifactSha256: runtime.artifacts.referenceFrontendBuildSha256,
      processGroupId: timedServer.processGroupId,
      coldStartMilliseconds: timedServer.coldStartMilliseconds,
      queryEvidence,
    });
  } finally {
    cleanupServers.delete(timedServer.stop);
    await timedServer.stop();
  }
}

async function collectGoLegacyCell(
  runtime: BuiltRuntime,
  databaseURL: string,
  scale: number,
  run: number,
  cleanupServers: Set<() => Promise<void>>,
): Promise<V12LegacyRun> {
  const assertion = createAssertion(runtime.identity, benchmarkSubject);
  const queryEnvironment = goQueryEnvironment(
    runtime,
    databaseURL,
    runtime.paths.goFrontend,
  );
  await prepareGoLegacyStore(runtime, queryEnvironment, scale);
  const queryWitness = await goStoreWitness(runtime, queryEnvironment);
  const queryPort = await reserveLoopbackPort();
  const queryServer = await startGoQueryServer(
    runtime,
    queryEnvironment,
    queryPort,
  );
  cleanupServers.add(queryServer.stop);
  let queryEvidence: V12QueryEvidence;
  try {
    queryEvidence = await collectLegacyQueryEvidence({
      target: 'go',
      scale,
      run,
      baseUrl: queryServer.baseUrl,
      headers: goLegacyHeaders(queryServer.baseUrl, assertion),
      storeWitness: queryWitness,
      runtimeArtifactSha256: runtime.artifacts.goQueryCompanionBinarySha256,
      processGroupId: queryServer.processGroupId,
    });
  } finally {
    cleanupServers.delete(queryServer.stop);
    await queryServer.stop();
  }

  const timedEnvironment = goQueryEnvironment(
    runtime,
    databaseURL,
    runtime.paths.goFrontend,
  );
  await prepareGoLegacyStore(runtime, timedEnvironment, scale);
  const timedWitness = await goStoreWitness(runtime, timedEnvironment);
  const timedPort = await reserveLoopbackPort();
  const timedServer = await startActualGoServer(
    runtime,
    goLegacyServerEnvironment(
      runtime,
      databaseURL,
      timedPort,
      runtime.paths.goFrontend,
    ),
    timedPort,
    'Go legacy timed runtime',
  );
  cleanupServers.add(timedServer.stop);
  try {
    return await collectLegacyHTTPRun({
      target: 'go',
      scale,
      run,
      baseUrl: timedServer.baseUrl,
      headers: goLegacyHeaders(timedServer.baseUrl, assertion),
      storeWitness: timedWitness,
      runtimeArtifactSha256: runtime.artifacts.goNotesBinarySha256,
      processGroupId: timedServer.processGroupId,
      coldStartMilliseconds: timedServer.coldStartMilliseconds,
      queryEvidence,
    });
  } finally {
    cleanupServers.delete(timedServer.stop);
    await timedServer.stop();
  }
}

function goLegacyHeaders(
  baseUrl: URL,
  assertion: string,
): Readonly<Record<string, string>> {
  return {
    'Content-Type': 'application/json',
    Origin: baseUrl.origin,
    [localAssertionHeader]: assertion,
  };
}

async function prepareGoLegacyStore(
  runtime: BuiltRuntime,
  environment: NodeJS.ProcessEnv,
  scale: number,
): Promise<void> {
  await commandText(
    runtime.paths.queryCompanionBinary,
    ['prepare', `--scale=${scale}`],
    {
      cwd: repositoryRoot,
      environment,
      timeoutMilliseconds: 5 * 60_000,
      label: 'prepare fresh Go legacy store',
    },
  );
}

async function goStoreWitness(
  runtime: BuiltRuntime,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const witness = (
    await commandText(runtime.paths.queryCompanionBinary, ['store-witness'], {
      cwd: repositoryRoot,
      environment,
      label: 'read fresh Go store witness',
    })
  ).trim();
  if (
    !/^postgres-database-oid-[0-9]+-public-oid-[0-9]+-migration-[0-9]+$/u.test(
      witness,
    )
  ) {
    throw new Error(
      'Go store witness does not identify actual database/schema state',
    );
  }
  return witness;
}

async function startGoQueryServer(
  runtime: BuiltRuntime,
  environment: NodeJS.ProcessEnv,
  port: number,
): Promise<RunningServer> {
  return startServer({
    executable: runtime.paths.queryCompanionBinary,
    arguments: [
      'serve',
      `--address=127.0.0.1:${port}`,
      `--static-directory=${runtime.paths.goFrontend}`,
    ],
    cwd: repositoryRoot,
    environment,
    hostname: '127.0.0.1',
    port,
    label: 'Go legacy query companion',
  });
}

async function startActualGoServer(
  runtime: BuiltRuntime,
  environment: NodeJS.ProcessEnv,
  port: number,
  label: string,
  hostname = '127.0.0.1',
): Promise<RunningServer> {
  return startServer({
    executable: runtime.paths.notesBinary,
    arguments: [],
    cwd: repositoryRoot,
    environment,
    hostname,
    port,
    label,
  });
}

async function prepareReferenceStore(
  runtime: BuiltRuntime,
  buildDirectory: string,
  lane: string,
  scale: number,
  run: number,
): Promise<D1Store> {
  const persistDirectory = path.join(
    runtime.paths.root,
    `d1-${lane}-s${scale}-r${run}-${randomUUID()}`,
  );
  await mkdir(persistDirectory, { mode: 0o700 });
  const sqlDirectory = path.join(
    runtime.paths.root,
    `sql-${lane}-s${scale}-r${run}-${randomUUID()}`,
  );
  await mkdir(sqlDirectory, { mode: 0o700 });
  const syncState = await writeOwnedSQL(
    sqlDirectory,
    'sync-state.sql',
    'INSERT INTO sync_state(singleton, next_display_id) VALUES (1, 1);\n',
  );
  const allowlist = await writeOwnedSQL(
    sqlDirectory,
    'allowlist.sql',
    `INSERT INTO launch_allowed_users(user_id, created_at) VALUES ('${benchmarkSubject}', 1);\n`,
  );
  const seed = await writeOwnedSQL(
    sqlDirectory,
    'fixture.sql',
    fixtureSeedSQL(scale),
  );
  const files = [
    path.join(referenceRoot, 'drizzle/0000_sticky_gamora.sql'),
    path.join(referenceRoot, 'drizzle/0001_amazing_cannonball.sql'),
    syncState,
    path.join(referenceRoot, 'drizzle/0017_production_launch_gate.sql'),
    allowlist,
    seed,
  ];
  for (const file of files) {
    await executeReferenceSQL(
      runtime,
      buildDirectory,
      persistDirectory,
      file,
      false,
    );
  }
  const inspection = await writeOwnedSQL(
    sqlDirectory,
    'inspect.sql',
    'SELECT COUNT(*) AS card_count FROM cards;\n' +
      'SELECT next_display_id AS next_display_id FROM sync_state WHERE singleton = 1;\n' +
      'SELECT COUNT(*) AS allowed_count FROM launch_allowed_users;\n',
  );
  const output = await executeReferenceSQL(
    runtime,
    buildDirectory,
    persistDirectory,
    inspection,
    true,
  );
  const parsed: unknown = JSON.parse(output);
  if (
    nestedNumber(parsed, 'card_count') !== scale ||
    nestedNumber(parsed, 'next_display_id') !== scale + 1 ||
    nestedNumber(parsed, 'allowed_count') !== 1
  ) {
    throw new Error('fresh reference D1 store verification failed');
  }
  const sqlite = await singleSQLiteFile(persistDirectory);
  const sqliteStat = await lstat(sqlite);
  const witness = [
    'd1',
    `device-${sqliteStat.dev}`,
    `inode-${sqliteStat.ino}`,
    `cards-${scale}`,
    `fixture-${fixtureSeedDigest(scale)}`,
  ].join('-');
  return { persistDirectory, witness };
}

async function executeReferenceSQL(
  runtime: BuiltRuntime,
  buildDirectory: string,
  persistDirectory: string,
  sqlFile: string,
  json: boolean,
): Promise<string> {
  const arguments_ = [
    'd1',
    'execute',
    'DB',
    '--local',
    '--persist-to',
    persistDirectory,
    '--config',
    path.join(buildDirectory, 'server/wrangler.json'),
    '--file',
    sqlFile,
    '--yes',
  ];
  if (json) arguments_.push('--json');
  return commandText(runtime.referenceWrangler, arguments_, {
    cwd: referenceRoot,
    environment: referenceEnvironment(
      runtime.paths,
      isolatedEnvironment(runtime.paths),
    ),
    timeoutMilliseconds: 5 * 60_000,
    label: 'execute isolated local D1 SQL file',
  });
}

async function startReferenceServer(
  runtime: BuiltRuntime,
  buildDirectory: string,
  persistDirectory: string,
  port: number,
  label: string,
): Promise<RunningServer> {
  return startServer({
    executable: runtime.referenceWrangler,
    arguments: [
      'dev',
      '--config',
      path.join(buildDirectory, 'server/wrangler.json'),
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--persist-to',
      persistDirectory,
    ],
    cwd: referenceRoot,
    environment: referenceEnvironment(
      runtime.paths,
      isolatedEnvironment(runtime.paths),
    ),
    hostname: '127.0.0.1',
    port,
    label,
  });
}

async function collectBrowserMatrix(
  runtime: BuiltRuntime,
  databaseURL: string,
  cleanupServers: Set<() => Promise<void>>,
): Promise<readonly V12BrowserRun[]> {
  const entries: V12BrowserRun[] = [];
  for (const scale of V12_BROWSER_SCALES) {
    for (let run = 1; run <= runsPerCell; run += 1) {
      entries.push(
        await collectReferenceBrowserCell(runtime, scale, run, cleanupServers),
      );
      entries.push(
        await collectGoBrowserCell(
          runtime,
          databaseURL,
          scale,
          run,
          cleanupServers,
        ),
      );
    }
  }
  return canonicalTargetRuns(entries);
}

async function collectReferenceBrowserCell(
  runtime: BuiltRuntime,
  scale: number,
  run: number,
  cleanupServers: Set<() => Promise<void>>,
): Promise<V12BrowserRun> {
  const store = await prepareReferenceStore(
    runtime,
    runtime.paths.referenceFrontend,
    'browser',
    scale,
    run,
  );
  const port = await reserveLoopbackPort();
  const server = await startReferenceServer(
    runtime,
    runtime.paths.referenceFrontend,
    store.persistDirectory,
    port,
    'reference native browser runtime',
  );
  cleanupServers.add(server.stop);
  const card = initialFixtureCard(scale - 1);
  try {
    return await collectBrowserRun({
      target: 'reference',
      scale,
      run,
      baseUrl: server.baseUrl,
      headers: { [referenceIdentityHeader]: benchmarkSubject },
      storeWitness: store.witness,
      runtimeArtifactSha256: runtime.artifacts.referenceFrontendBuildSha256,
      processGroupId: server.processGroupId,
      databaseName: 'fukamu-notes',
      cardId: card.cardId,
      initialTitle: card.title,
      initialBodyText: card.bodyText,
      editedTitle: browserEditedTitle(scale, run),
    });
  } finally {
    cleanupServers.delete(server.stop);
    await server.stop();
  }
}

async function collectGoBrowserCell(
  runtime: BuiltRuntime,
  databaseURL: string,
  scale: number,
  run: number,
  cleanupServers: Set<() => Promise<void>>,
): Promise<V12BrowserRun> {
  const fixtureRoot = path.join(
    runtime.paths.root,
    `go-browser-fixture-s${scale}-r${run}-${randomUUID()}`,
  );
  await mkdir(fixtureRoot, { mode: 0o700 });
  const seedPort = await reserveLoopbackPort();
  const fixture = await prepareGoBrowserFixture(
    runtime,
    databaseURL,
    fixtureRoot,
    seedPort,
  );
  const seedServer = await startActualGoServer(
    runtime,
    fixture.environment,
    seedPort,
    'Go native browser seed runtime',
  );
  cleanupServers.add(seedServer.stop);
  try {
    await seedGoBrowserCards(seedServer.baseUrl, fixture.secrets, scale);
  } finally {
    cleanupServers.delete(seedServer.stop);
    await seedServer.stop();
  }

  const measuredPort = await reserveLoopbackPort();
  const measuredEnvironment = goBrowserServerEnvironment(
    runtime,
    databaseURL,
    fixtureRoot,
    fixture.secrets,
    measuredPort,
  );
  const server = await startActualGoServer(
    runtime,
    measuredEnvironment,
    measuredPort,
    'Go native browser measured runtime',
    'localhost',
  );
  cleanupServers.add(server.stop);
  const card = initialFixtureCard(scale - 1);
  try {
    return await collectBrowserRun({
      target: 'go',
      scale,
      run,
      baseUrl: server.baseUrl,
      headers: {
        [localAssertionHeader]: createAssertion(
          runtime.identity,
          benchmarkSubject,
        ),
      },
      sessionCookie: {
        name: '__Host-fukamu_session',
        value: fixture.secrets.sessionToken,
      },
      storeWitness: fixture.storeWitness,
      runtimeArtifactSha256: runtime.artifacts.goNotesBinarySha256,
      processGroupId: server.processGroupId,
      databaseName: fixture.databaseName,
      cardId: card.cardId,
      initialTitle: card.title,
      initialBodyText: card.bodyText,
      editedTitle: browserEditedTitle(scale, run),
    });
  } finally {
    cleanupServers.delete(server.stop);
    await server.stop();
  }
}

async function prepareGoBrowserFixture(
  runtime: BuiltRuntime,
  databaseURL: string,
  fixtureRoot: string,
  port: number,
): Promise<GoBrowserFixture> {
  const secrets = fixtureSecrets();
  const environment = goBrowserServerEnvironment(
    runtime,
    databaseURL,
    fixtureRoot,
    secrets,
    port,
  );
  await commandText(
    runtime.paths.notesctlBinary,
    [
      'prepare-e2e',
      '--environment=test',
      `--allowed-subject=${benchmarkSubject}`,
    ],
    {
      cwd: repositoryRoot,
      environment,
      timeoutMilliseconds: 5 * 60_000,
      label: 'prepare exact Go native browser fixture',
    },
  );
  const storeWitness = await goStoreWitness(runtime, {
    ...isolatedEnvironment(runtime.paths),
    NOTES_TEST_DATABASE_URL: databaseURL,
  });
  return {
    environment,
    secrets,
    storeWitness,
    databaseName: `fukamu-notes:v1:vault:${fixtureAccountID}:${fixtureVaultID}`,
  };
}

async function seedGoBrowserCards(
  baseUrl: URL,
  secrets: FixtureSecrets,
  scale: number,
): Promise<void> {
  const deviceID = fixtureUUID(0xb0_0000, 0);
  for (let offset = 0; offset < scale; offset += 500) {
    const count = Math.min(500, scale - offset);
    const fixtures = Array.from({ length: count }, (_, index) =>
      initialFixtureCard(offset + index),
    );
    const response = await fetch(new URL('/api/v2/sync', baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: baseUrl.origin.replace('127.0.0.1', 'localhost'),
        'Sec-Fetch-Site': 'same-origin',
        Cookie: `__Host-fukamu_session=${secrets.sessionToken}`,
      },
      body: JSON.stringify({
        version: 'sync/v2',
        deviceId: deviceID,
        cursor: null,
        mutations: fixtures.map((fixture) => ({
          mutationId: fixture.mutationId,
          cardId: fixture.cardId,
          baseServerRevision: null,
          title: fixture.title,
          body: [{ type: 'text', text: fixture.bodyText }],
          createdAt: fixture.createdAt,
          updatedAt: fixture.createdAt,
          kind: 'upsert',
          conflictIds: [],
        })),
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(5 * 60_000),
    });
    const candidate: unknown = await response.json();
    verifySeedResponse(candidate, fixtures, response.status);
  }
}

function verifySeedResponse(
  candidate: unknown,
  fixtures: readonly ReturnType<typeof initialFixtureCard>[],
  status: number,
): void {
  if (
    status !== 200 ||
    candidate === null ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    Reflect.get(candidate, 'version') !== 'sync/v2'
  ) {
    throw new Error('Go native browser seed request failed');
  }
  const receipts: unknown = Reflect.get(candidate, 'receipts');
  if (!Array.isArray(receipts) || receipts.length !== fixtures.length) {
    throw new Error('Go native browser seed receipt count mismatch');
  }
  const expected = new Map(
    fixtures.map((fixture) => [fixture.mutationId, fixture.cardId]),
  );
  const seen = new Set<string>();
  for (const receipt of receipts) {
    if (
      receipt === null ||
      typeof receipt !== 'object' ||
      Array.isArray(receipt)
    ) {
      throw new Error('Go native browser seed receipt is invalid');
    }
    const mutationID: unknown = Reflect.get(receipt, 'mutationId');
    const cardID: unknown = Reflect.get(receipt, 'cardId');
    const revision: unknown = Reflect.get(receipt, 'appliedRevision');
    if (
      typeof mutationID !== 'string' ||
      typeof cardID !== 'string' ||
      expected.get(mutationID) !== cardID ||
      revision !== 1 ||
      seen.has(mutationID)
    ) {
      throw new Error('Go native browser seed receipt binding mismatch');
    }
    seen.add(mutationID);
  }
  if (seen.size !== fixtures.length) {
    throw new Error('Go native browser seed receipts are incomplete');
  }
}

function browserEditedTitle(scale: number, run: number): string {
  return `v12-browser-edited-s${scale}-r${run}`;
}

async function collectSyncV2Evidence(
  runtime: BuiltRuntime,
  databaseURL: string,
) {
  await assertMissing(
    runtime.paths.syncOutput,
    'Sync v2 fragment output already exists',
  );
  const environment = {
    ...isolatedEnvironment(runtime.paths),
    GOCACHE: runtime.paths.goCache,
    GOMODCACHE: runtime.goModuleCache,
    GOTOOLCHAIN: 'auto',
    GOPROXY: 'off',
    GOSUMDB: 'off',
    CGO_ENABLED: '0',
    NOTES_TEST_DATABASE_URL: databaseURL,
    FUKAMU_V12_PERFORMANCE_MODE: 'local-go-postgres',
    FUKAMU_V12_SYNC_OUTPUT: runtime.paths.syncOutput,
  };
  await commandText(
    'go',
    [
      'test',
      '-p=1',
      '-tags=integration,v12benchmark',
      './tests/integration',
      '-run',
      '^TestSyncV2V12PerformanceEvidence$',
      '-count=1',
      '-v',
    ],
    {
      cwd: path.join(repositoryRoot, 'backend'),
      environment,
      timeoutMilliseconds: 95 * 60_000,
      label: 'run opt-in Sync v2 V12 evidence lane',
    },
  );
  const candidate: unknown = JSON.parse(
    await readFile(runtime.paths.syncOutput, 'utf8'),
  );
  return decodeV12SyncFragment(candidate);
}

async function collectHostIdentity(
  runtime: BuiltRuntime,
  databaseURL: string,
): Promise<V12Evidence['host']> {
  const baseEnvironment = isolatedEnvironment(runtime.paths);
  const chromiumBrowser = await chromium.launch({ headless: true });
  let chromiumVersion: string;
  try {
    chromiumVersion = chromiumBrowser.version();
  } finally {
    await chromiumBrowser.close();
  }
  const postgresEnvironment = {
    ...baseEnvironment,
    NOTES_TEST_DATABASE_URL: databaseURL,
  };
  const processors = cpus();
  const firstProcessor = processors[0];
  if (firstProcessor === undefined) throw new Error('host CPU is unavailable');
  const miniflarePackage: unknown = JSON.parse(
    await readFile(
      path.join(referenceRoot, 'node_modules/miniflare/package.json'),
      'utf8',
    ),
  );
  const miniflareVersion = packageVersion(miniflarePackage, 'Miniflare');
  return {
    os: platform(),
    architecture: arch(),
    kernel: release(),
    cpuModel: firstProcessor.model,
    logicalCpus: processors.length,
    nodeVersion: process.version,
    npmVersion: (
      await commandText('npm', ['--version'], {
        cwd: repositoryRoot,
        environment: baseEnvironment,
        label: 'read npm version',
      })
    ).trim(),
    wranglerVersion: (
      await commandText(runtime.referenceWrangler, ['--version'], {
        cwd: referenceRoot,
        environment: referenceEnvironment(runtime.paths, baseEnvironment),
        label: 'read Wrangler version',
      })
    ).trim(),
    miniflareVersion,
    chromiumVersion,
    goVersion: (
      await commandText('go', ['version'], {
        cwd: repositoryRoot,
        environment: {
          ...baseEnvironment,
          GOTOOLCHAIN: 'auto',
        },
        label: 'read Go version',
      })
    ).trim(),
    postgresqlVersion: (
      await commandText(
        runtime.paths.queryCompanionBinary,
        ['postgres-version'],
        {
          cwd: repositoryRoot,
          environment: postgresEnvironment,
          label: 'read local PostgreSQL version',
        },
      )
    ).trim(),
    totalMemoryBytes: totalmem(),
  };
}

async function assembleEvidence(
  measuredRevision: string,
  runtime: BuiltRuntime,
  host: V12Evidence['host'],
  legacyRuns: readonly V12LegacyRun[],
  browserRuns: readonly V12BrowserRun[],
  syncFragment: ReturnType<typeof decodeV12SyncFragment>,
): Promise<V12Evidence> {
  const sourceDigests = await Promise.all(
    V12_SOURCE_PATHS.map(async (sourcePath) => ({
      path: sourcePath,
      sha256: sha256Hex(
        await gitBytes(repositoryRoot, [
          'show',
          `${measuredRevision}:${sourcePath}`,
        ]),
      ),
    })),
  );
  const measuredGoTreeObjectId = (
    await gitText(repositoryRoot, ['rev-parse', `${measuredRevision}^{tree}`])
  ).trim();
  const legacySummaries = V12_TARGETS.flatMap((target) =>
    V12_SCALES.flatMap((scale) =>
      V12_LEGACY_OPERATIONS.map((operation) =>
        summarizeV12Samples(
          target,
          scale,
          operation,
          observationsForLegacy(legacyRuns, target, scale, operation),
        ),
      ),
    ),
  );
  const browserSummaries = V12_TARGETS.flatMap((target) =>
    V12_BROWSER_SCALES.flatMap((scale) =>
      V12_BROWSER_OPERATIONS.map((operation) =>
        summarizeV12Samples(
          target,
          scale,
          operation,
          observationsForBrowser(browserRuns, target, scale, operation),
        ),
      ),
    ),
  );
  const syncSummaries = V12_SYNC_OPERATIONS.map((operation) =>
    summarizeV12Samples(
      'sync-v2-go',
      10_000,
      operation,
      syncFragment.runs.map((run) =>
        requiredObservation(run.observations, operation),
      ),
    ),
  );
  const concurrencySummary = summarizeV12Samples(
    'sync-v2-go',
    100,
    'concurrent-100',
    syncFragment.concurrency.map((run) => ({
      durationMilliseconds: run.durationMilliseconds,
      status: run.errorCount === 0 ? 200 : 500,
    })),
  );
  const requestLatencySummary = summarizeV12Samples(
    'sync-v2-go',
    100,
    'concurrent-request',
    syncFragment.concurrency.flatMap((run) => run.observations),
  );
  const candidate: unknown = {
    schemaVersion: 1,
    evidenceKind: 'local-v12-performance',
    identity: {
      issue: 525,
      measuredAt: new Date().toISOString(),
      runnableReferenceRevision: V12_REFERENCE_REVISION,
      frozenRetirementRevision: V12_RETIREMENT_REVISION,
      integrationBranchPoint: V12_INTEGRATION_BRANCH_POINT,
      measuredGoRevision: measuredRevision,
      measuredGoTreeObjectId,
      runnerVersion: V12_RUNNER_VERSION,
      referenceHandlerSha256: V12_REFERENCE_HANDLER_SHA256,
      referenceObserverSha256: V12_REFERENCE_OBSERVER_SHA256,
      referencePatchedHandlerSha256: V12_REFERENCE_PATCHED_HANDLER_SHA256,
      runtimeArtifacts: runtime.artifacts,
      sourceDigests,
    },
    host,
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
      scales: V12_SCALES,
      runsPerCell,
      warmupsBeforeWarmFull: 3,
      batchSize: 500,
      querySources: {
        reference: 'instrumented-d1-statement-observer',
        go: 'instrumented-pgx-query-and-batch-tracer',
      },
      memoryScope: 'linux-process-group-smaps-rollup-rss-pss-bytes',
      runs: legacyRuns,
      summaries: legacySummaries,
      parity: legacyParity(legacyRuns),
      reviewEnvelope: {
        kind: 'reference-relative-warm-p95-review-v1',
        maximumRatio: 1.2,
        maximumAdditiveMilliseconds: 10,
        evaluations: reviewEvaluations(
          legacySummaries,
          V12_SCALES,
          V12_REVIEWED_LEGACY_OPERATIONS,
          10,
        ),
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
      scales: V12_BROWSER_SCALES,
      runsPerCell,
      runs: browserRuns,
      summaries: browserSummaries,
      reviewEnvelope: {
        kind: 'native-ui-reference-relative-p95-review-v1',
        maximumRatio: 1.2,
        maximumAdditiveMilliseconds: 50,
        evaluations: reviewEvaluations(
          browserSummaries,
          V12_BROWSER_SCALES,
          V12_BROWSER_OPERATIONS,
          50,
        ),
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
      runs: syncFragment.runs,
      summaries: syncSummaries,
      concurrency: syncFragment.concurrency,
      concurrencySummary,
      requestLatencySummary,
    },
  };
  return decodeV12Evidence(candidate);
}

function observationsForLegacy(
  runs: readonly V12LegacyRun[],
  target: V12Target,
  scale: number,
  operation: V12LegacyOperation,
) {
  return runs
    .filter((run) => run.target === target && run.scale === scale)
    .map((run) => requiredObservation(run.observations, operation));
}

function observationsForBrowser(
  runs: readonly V12BrowserRun[],
  target: V12Target,
  scale: number,
  operation: V12BrowserOperation,
) {
  return runs
    .filter((run) => run.target === target && run.scale === scale)
    .map((run) => requiredObservation(run.observations, operation));
}

function requiredObservation<Operation extends string>(
  observations: readonly Readonly<{
    operation: Operation;
    durationMilliseconds: number;
    status: number;
  }>[],
  operation: Operation,
) {
  const found = observations.find((entry) => entry.operation === operation);
  if (found === undefined) throw new Error(`observation missing: ${operation}`);
  return found;
}

function legacyParity(runs: readonly V12LegacyRun[]) {
  return V12_SCALES.flatMap((scale) =>
    Array.from({ length: runsPerCell }, (_, index) => {
      const run = index + 1;
      const reference = requiredLegacyRun(runs, 'reference', scale, run);
      const go = requiredLegacyRun(runs, 'go', scale, run);
      const matches =
        reference.finalDigests.cards === go.finalDigests.cards &&
        reference.finalDigests.acknowledgements ===
          go.finalDigests.acknowledgements &&
        reference.finalDigests.conflicts === go.finalDigests.conflicts;
      return {
        scale,
        run,
        cardsDigest: reference.finalDigests.cards,
        acknowledgementsDigest: reference.finalDigests.acknowledgements,
        conflictsDigest: reference.finalDigests.conflicts,
        matches,
      };
    }),
  );
}

function requiredLegacyRun(
  runs: readonly V12LegacyRun[],
  target: V12Target,
  scale: number,
  run: number,
): V12LegacyRun {
  const found = runs.find(
    (entry) =>
      entry.target === target && entry.scale === scale && entry.run === run,
  );
  if (found === undefined) throw new Error('legacy parity run missing');
  return found;
}

function reviewEvaluations<Operation extends string>(
  summaries: readonly Readonly<{
    target: V12Target | 'sync-v2-go';
    scale: number;
    operation: Operation;
    p95Milliseconds: number;
  }>[],
  scales: readonly number[],
  operations: readonly Operation[],
  additive: number,
) {
  return scales.flatMap((scale) =>
    operations.map((operation) => {
      const reference = summaries.find(
        (summary) =>
          summary.target === 'reference' &&
          summary.scale === scale &&
          summary.operation === operation,
      );
      const go = summaries.find(
        (summary) =>
          summary.target === 'go' &&
          summary.scale === scale &&
          summary.operation === operation,
      );
      if (reference === undefined || go === undefined) {
        throw new Error('review envelope source missing');
      }
      const allowed = roundMilliseconds(
        reference.p95Milliseconds +
          Math.max(reference.p95Milliseconds * 0.2, additive),
      );
      const assessment = classifyV12ProvisionalReview(
        go.p95Milliseconds,
        allowed,
      );
      return {
        scale,
        operation,
        referenceP95Milliseconds: reference.p95Milliseconds,
        goP95Milliseconds: go.p95Milliseconds,
        allowedGoP95Milliseconds: allowed,
        ...assessment,
      };
    }),
  );
}

function isolatedEnvironment(paths: OwnedPaths): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    'PATH',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'PLAYWRIGHT_BROWSERS_PATH',
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  const denyProxy = 'http://127.0.0.1:9';
  environment.HOME = paths.home;
  environment.XDG_CONFIG_HOME = paths.xdg;
  environment.XDG_CACHE_HOME = path.join(paths.root, 'xdg-cache');
  environment.CI = 'true';
  environment.HTTP_PROXY = denyProxy;
  environment.HTTPS_PROXY = denyProxy;
  environment.ALL_PROXY = denyProxy;
  environment.http_proxy = denyProxy;
  environment.https_proxy = denyProxy;
  environment.all_proxy = denyProxy;
  environment.NO_PROXY = '127.0.0.1,localhost,::1';
  environment.no_proxy = environment.NO_PROXY;
  environment.npm_config_registry = denyProxy;
  environment.npm_config_audit = 'false';
  environment.npm_config_fund = 'false';
  environment.npm_config_update_notifier = 'false';
  environment.npm_config_cache = path.join(paths.root, 'npm-cache');
  return environment;
}

function environmentWithHostHome(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const hostHome = process.env.HOME;
  return hostHome === undefined
    ? { ...environment }
    : { ...environment, HOME: hostHome };
}

function referenceEnvironment(
  paths: OwnedPaths,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...base,
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.xdg,
    WRANGLER_SEND_METRICS: 'false',
    WRANGLER_WRITE_LOGS: 'false',
    WRANGLER_LOG_PATH: path.join(paths.root, 'wrangler.log'),
    MINIFLARE_REGISTRY_PATH: path.join(paths.root, 'miniflare-registry.json'),
  };
}

function goQueryEnvironment(
  runtime: BuiltRuntime,
  databaseURL: string,
  _staticDirectory: string,
): NodeJS.ProcessEnv {
  return {
    ...isolatedEnvironment(runtime.paths),
    NOTES_TEST_DATABASE_URL: databaseURL,
    FUKAMU_V12_LOCAL_AUTH_PUBLIC_KEY: runtime.identity.publicKey,
    FUKAMU_V12_LOCAL_AUTH_ISSUER: runtime.identity.issuer,
    FUKAMU_V12_LOCAL_AUTH_AUDIENCE: runtime.identity.audience,
  };
}

function goLegacyServerEnvironment(
  runtime: BuiltRuntime,
  databaseURL: string,
  port: number,
  staticDirectory: string,
): NodeJS.ProcessEnv {
  return {
    ...isolatedEnvironment(runtime.paths),
    NOTES_ENVIRONMENT: 'test',
    NOTES_APPLICATION_PROFILE: 'disabled',
    NOTES_DATABASE_URL: databaseURL,
    NOTES_HTTP_ADDR: `127.0.0.1:${port}`,
    NOTES_STATIC_DIR: staticDirectory,
    NOTES_PRIVATE_AUTH_MODE: 'local-signed',
    NOTES_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    NOTES_LOCAL_AUTH_ISSUER: runtime.identity.issuer,
    NOTES_LOCAL_AUTH_AUDIENCE: runtime.identity.audience,
    NOTES_LOCAL_AUTH_PUBLIC_KEY: runtime.identity.publicKey,
    NOTES_LEGACY_OWNER_SUBJECT: benchmarkSubject,
    NOTES_DATABASE_MAX_CONNECTIONS: '4',
    NOTES_BODY_LIMIT_BYTES: '4000000',
    NOTES_SHUTDOWN_TIMEOUT: '2s',
    NOTES_LOG_LEVEL: 'info',
  };
}

function goBrowserServerEnvironment(
  runtime: BuiltRuntime,
  databaseURL: string,
  fixtureRoot: string,
  secrets: FixtureSecrets,
  port: number,
): NodeJS.ProcessEnv {
  return {
    ...isolatedEnvironment(runtime.paths),
    NOTES_ENVIRONMENT: 'test',
    NOTES_APPLICATION_PROFILE: 'local-fixture',
    NOTES_DATABASE_URL: databaseURL,
    NOTES_HTTP_ADDR: `127.0.0.1:${port}`,
    NOTES_STATIC_DIR: runtime.paths.goFrontend,
    NOTES_PRIVATE_AUTH_MODE: 'local-signed',
    NOTES_PUBLIC_ORIGIN: `http://localhost:${port}`,
    NOTES_LOCAL_AUTH_ISSUER: runtime.identity.issuer,
    NOTES_LOCAL_AUTH_AUDIENCE: runtime.identity.audience,
    NOTES_LOCAL_AUTH_PUBLIC_KEY: runtime.identity.publicKey,
    NOTES_LEGACY_OWNER_SUBJECT: benchmarkSubject,
    NOTES_DATABASE_MAX_CONNECTIONS: '4',
    NOTES_BODY_LIMIT_BYTES: '4000000',
    NOTES_SHUTDOWN_TIMEOUT: '2s',
    NOTES_LOG_LEVEL: 'info',
    NOTES_LOCAL_FIXTURE_ROOT: fixtureRoot,
    NOTES_LOCAL_FIXTURE_ACCOUNT_ID: fixtureAccountID,
    NOTES_LOCAL_FIXTURE_VAULT_ID: fixtureVaultID,
    NOTES_LOCAL_FIXTURE_SESSION_ID: fixtureSessionID,
    NOTES_LOCAL_FIXTURE_SESSION_EPOCH: fixtureSessionEpoch,
    NOTES_LOCAL_FIXTURE_SESSION_TOKEN: secrets.sessionToken,
    NOTES_LOCAL_FIXTURE_CURSOR_HMAC_KEY: secrets.cursorKey,
    NOTES_LOCAL_FIXTURE_DELETION_HMAC_KEY: secrets.deletionKey,
    NOTES_LOCAL_FIXTURE_LEGAL_EVIDENCE_POLICY: 'undecided',
  };
}

function fixtureSecrets(): FixtureSecrets {
  const sessionToken = randomBytes(32).toString('base64url');
  const cursorKey = randomBytes(32).toString('base64url');
  let deletionKey = randomBytes(32).toString('base64url');
  while (deletionKey === cursorKey || deletionKey === sessionToken) {
    deletionKey = randomBytes(32).toString('base64url');
  }
  return { sessionToken, cursorKey, deletionKey };
}

function createAssertion(identity: IdentityMaterial, subject: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: identity.issuer,
      aud: identity.audience,
      sub: subject,
      iat: now - 5,
      exp: now + 9 * 60,
    }),
  ).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const signature = sign(null, Buffer.from(unsigned), identity.privateKey);
  return `${unsigned}.${signature.toString('base64url')}`;
}

async function startServer(
  input: Readonly<{
    executable: string;
    arguments: readonly string[];
    cwd: string;
    environment: NodeJS.ProcessEnv;
    hostname: string;
    port: number;
    label: string;
  }>,
): Promise<RunningServer> {
  await assertPortUnused(input.port);
  const started = performance.now();
  const child = spawn(input.executable, input.arguments, {
    cwd: input.cwd,
    env: input.environment,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.pid === undefined) {
    child.kill('SIGKILL');
    throw new Error(`${input.label} did not expose a process group leader`);
  }
  const processGroupId = child.pid;
  const output = boundedDrain(child.stdout);
  const errors = boundedDrain(child.stderr);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await stopProcessGroup(child, processGroupId, input.label);
    output.clear();
    errors.clear();
  };
  try {
    const statIdentity = await readProcessIdentity(processGroupId);
    if (statIdentity.processGroupId !== processGroupId) {
      throw new Error(`${input.label} is not a process-group leader`);
    }
    const baseUrl = new URL(`http://${input.hostname}:${input.port}`);
    await waitForStaticReadiness(baseUrl, child, input.label);
    return {
      child,
      processGroupId,
      baseUrl,
      coldStartMilliseconds: roundMilliseconds(performance.now() - started),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

function boundedDrain(stream: NodeJS.ReadableStream): Readonly<{
  clear: () => void;
}> {
  let retained = 0;
  const listener = (chunk: Uint8Array) => {
    retained = Math.min(maximumCommandOutputBytes, retained + chunk.byteLength);
  };
  stream.on('data', listener);
  return {
    clear: () => {
      stream.off('data', listener);
      retained = 0;
    },
  };
}

async function waitForStaticReadiness(
  baseUrl: URL,
  child: ChildProcess,
  label: string,
): Promise<void> {
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label} exited before static readiness`);
    }
    try {
      const response = await fetch(new URL('/pricing', baseUrl), {
        redirect: 'manual',
        signal: AbortSignal.timeout(2_000),
      });
      const body = await response.text();
      if (
        response.status === 200 &&
        response.headers.get('content-type')?.includes('text/html') === true &&
        /<!doctype html/iu.test(body) &&
        /<\/html>/iu.test(body)
      ) {
        return;
      }
    } catch {
      // Readiness is bounded and never calls a mutating API.
    }
    await delay(25);
  }
  throw new Error(`${label} did not reach static readiness`);
}

async function stopProcessGroup(
  child: ChildProcess,
  processGroupId: number,
  label: string,
): Promise<void> {
  sendProcessGroupSignal(processGroupId, 'SIGTERM');
  await Promise.race([childClosed(child), delay(10_000)]);
  if (await processGroupExists(processGroupId)) {
    sendProcessGroupSignal(processGroupId, 'SIGKILL');
    await Promise.race([childClosed(child), delay(5_000)]);
  }
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (!(await processGroupExists(processGroupId))) return;
    await delay(25);
  }
  throw new Error(`${label} process group did not terminate`);
}

function sendProcessGroupSignal(
  processGroupId: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (!isProcessMissing(error)) throw error;
  }
}

async function processGroupExists(processGroupId: number): Promise<boolean> {
  for (const entry of await readdir('/proc')) {
    if (!/^[1-9][0-9]*$/u.test(entry)) continue;
    try {
      const identity = await readProcessIdentity(Number(entry));
      if (identity.processGroupId === processGroupId) return true;
    } catch {
      // Processes may leave /proc while it is enumerated.
    }
  }
  return false;
}

async function readProcessIdentity(
  pid: number,
): Promise<Readonly<{ processGroupId: number; startTicks: number }>> {
  const source = await readFile(`/proc/${pid}/stat`, 'utf8');
  const closing = source.lastIndexOf(')');
  if (closing < 0) throw new Error('invalid /proc stat record');
  const fields = source
    .slice(closing + 2)
    .trim()
    .split(/\s+/u);
  const processGroupId = Number(fields[2]);
  const startTicks = Number(fields[19]);
  if (
    !Number.isSafeInteger(processGroupId) ||
    processGroupId < 1 ||
    !Number.isSafeInteger(startTicks) ||
    startTicks < 1
  ) {
    throw new Error('invalid /proc process identity');
  }
  return { processGroupId, startTicks };
}

function childClosed(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => child.once('close', () => resolve()));
}

function isProcessMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    Reflect.get(error, 'code') === 'ESRCH'
  );
}

async function writeVerifiedEvidence(
  outputPath: string,
  evidence: V12Evidence,
  measuredRevision: string,
): Promise<void> {
  const sourceContent = new Map<string, Uint8Array>();
  for (const sourcePath of V12_SOURCE_PATHS) {
    sourceContent.set(
      sourcePath,
      await readFile(path.join(repositoryRoot, sourcePath)),
    );
  }
  verifyV12SourceContent(evidence, sourceContent);
  await verifyV12GitProvenance(evidence, measuredRevision, {
    commitExists: async (revision) =>
      gitSucceeded(repositoryRoot, ['cat-file', '-e', `${revision}^{commit}`]),
    isAncestor: async (ancestor, descendant) =>
      gitSucceeded(repositoryRoot, [
        'merge-base',
        '--is-ancestor',
        ancestor,
        descendant,
      ]),
    treeObjectId: async (revision) =>
      (
        await gitText(repositoryRoot, ['rev-parse', `${revision}^{tree}`])
      ).trim(),
    readBlob: async (revision, sourcePath) =>
      gitBytes(repositoryRoot, ['show', `${revision}:${sourcePath}`]),
  });
  const decoded = decodeV12Evidence(
    JSON.parse(`${JSON.stringify(evidence)}\n`) as unknown,
  );
  if (JSON.stringify(decoded) !== JSON.stringify(evidence)) {
    throw new Error('V12 evidence changed during final decode');
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await assertMissing(outputPath, 'V12 evidence output already exists');
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.migration-v12-local.${process.pid}.${randomUUID()}.tmp`,
  );
  const file = await open(temporaryPath, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(evidence, undefined, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporaryPath, outputPath);
    const directory = await open(path.dirname(outputPath), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  process.stdout.write(
    `V12 local evidence written after ${evidence.legacy.runs.length} legacy and ${evidence.browser.runs.length} browser cells.\n`,
  );
}

async function assertRuntimeArtifactsUnchanged(
  runtime: BuiltRuntime,
): Promise<void> {
  const current: RuntimeArtifacts = {
    goNotesBinarySha256: await fileSha256(runtime.paths.notesBinary),
    goNotesctlBinarySha256: await fileSha256(runtime.paths.notesctlBinary),
    goQueryCompanionBinarySha256: await fileSha256(
      runtime.paths.queryCompanionBinary,
    ),
    goFrontendBuildSha256: await treeSha256(runtime.paths.goFrontend),
    referenceFrontendBuildSha256: await treeSha256(
      runtime.paths.referenceFrontend,
    ),
    referenceQueryBuildSha256: await treeSha256(runtime.paths.referenceQuery),
  };
  if (JSON.stringify(current) !== JSON.stringify(runtime.artifacts)) {
    throw new Error('a launched runtime artifact changed during measurement');
  }
}

async function copyExactTree(
  source: string,
  destination: string,
): Promise<void> {
  await treeSha256(source);
  await assertMissing(destination, 'immutable runtime copy already exists');
  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: false,
  });
  const sourceDigest = await treeSha256(source);
  const copiedDigest = await treeSha256(destination);
  if (sourceDigest !== copiedDigest) {
    throw new Error('immutable runtime tree copy digest mismatch');
  }
}

async function treeSha256(root: string): Promise<string> {
  const digest = createHash('sha256');
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new Error(`runtime tree contains a symlink: ${relative}`);
      }
      if (info.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!info.isFile()) {
        throw new Error(
          `runtime tree contains a non-regular file: ${relative}`,
        );
      }
      digest.update(relative);
      digest.update('\0');
      digest.update(await readFile(absolute));
      digest.update('\0');
    }
  };
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('runtime tree root must be a real directory');
  }
  await visit(root);
  return digest.digest('hex');
}

async function fileSha256(file: string): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error('runtime artifact must be a single regular file');
  }
  return sha256Hex(await readFile(file));
}

async function requireRegularExecutable(
  file: string,
  label: string,
): Promise<void> {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (info.mode & 0o100) === 0
  ) {
    throw new Error(`${label} must be a regular executable`);
  }
}

async function writeOwnedSQL(
  directory: string,
  name: string,
  source: string,
): Promise<string> {
  if (!/^[a-z][a-z0-9-]*\.sql$/u.test(name)) {
    throw new Error('owned SQL filename is invalid');
  }
  const target = path.join(directory, name);
  await writeFile(target, source, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return target;
}

async function singleSQLiteFile(root: string): Promise<string> {
  const matches: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new Error('D1 store contains a symlink');
      }
      if (info.isDirectory()) await visit(absolute);
      else if (info.isFile() && /\.sqlite(?:3)?$/u.test(entry.name))
        matches.push(absolute);
      else if (!info.isFile())
        throw new Error('D1 store contains a non-regular entry');
    }
  };
  await visit(root);
  if (matches.length !== 1 || !matches[0]) {
    throw new Error('fresh D1 store must contain exactly one SQLite database');
  }
  return matches[0];
}

function nestedNumber(value: unknown, key: string): number | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = nestedNumber(entry, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  const direct: unknown = Reflect.get(value, key);
  if (typeof direct === 'number' && Number.isSafeInteger(direct)) return direct;
  for (const entry of Object.values(value)) {
    const found = nestedNumber(entry, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function packageVersion(value: unknown, label: string): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} package metadata is invalid`);
  }
  const version: unknown = Reflect.get(value, 'version');
  if (
    typeof version !== 'string' ||
    version.length < 1 ||
    version.length > 64 ||
    !/^[0-9A-Za-z.+-]+$/u.test(version)
  ) {
    throw new Error(`${label} package version is invalid`);
  }
  return version;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('loopback port reservation failed');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (port < 10_000 || port > 60_000) {
    return reserveLoopbackPort();
  }
  return port;
}

async function assertPortUnused(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function assertMissing(target: string, message: string): Promise<void> {
  try {
    await lstat(target);
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      Reflect.get(error, 'code') === 'ENOENT'
    ) {
      return;
    }
    throw error;
  }
  throw new Error(message);
}

function canonicalTargetRuns<
  Run extends Readonly<{ target: V12Target; scale: number; run: number }>,
>(runs: readonly Run[]): readonly Run[] {
  const targetIndex = new Map(
    V12_TARGETS.map((target, index) => [target, index]),
  );
  return [...runs].sort((left, right) => {
    const leftTarget = targetIndex.get(left.target);
    const rightTarget = targetIndex.get(right.target);
    if (leftTarget === undefined || rightTarget === undefined) {
      throw new Error('unknown V12 target');
    }
    return (
      leftTarget - rightTarget ||
      left.scale - right.scale ||
      left.run - right.run
    );
  });
}

function roundMilliseconds(value: number): number {
  return Number(value.toFixed(3));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function commandText(
  executable: string,
  arguments_: readonly string[],
  options: CommandOptions,
): Promise<string> {
  const result = await runCommand(executable, arguments_, options, false);
  return new TextDecoder().decode(result.stdout);
}

async function runCommand(
  executable: string,
  arguments_: readonly string[],
  options: CommandOptions,
  allowFailure: boolean,
): Promise<Readonly<{ code: number; stdout: Uint8Array }>> {
  const child = spawn(executable, arguments_, {
    cwd: options.cwd,
    env: options.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflow = false;
  child.stdout.on('data', (chunk: Uint8Array) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes <= maximumCommandOutputBytes) stdout.push(chunk);
    else overflow = true;
  });
  child.stderr.on('data', (chunk: Uint8Array) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes <= maximumCommandOutputBytes) stderr.push(chunk);
    else overflow = true;
  });
  const timeout = options.timeoutMilliseconds ?? 120_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeout);
  const outcome = await new Promise<
    Readonly<{ code: number | null; signal: NodeJS.Signals | null }>
  >((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  const code = outcome.code ?? 1;
  if (
    timedOut ||
    overflow ||
    outcome.signal !== null ||
    (!allowFailure && code !== 0)
  ) {
    // Child stderr may contain local credentials or card content. Never echo it.
    throw new Error(
      `${options.label} failed (exit=${code}, signal=${outcome.signal ?? 'none'}, timeout=${timedOut}, bounded=${!overflow})`,
    );
  }
  return { code, stdout: Buffer.concat(stdout) };
}

async function gitText(
  cwd: string,
  arguments_: readonly string[],
  allowFailure = false,
): Promise<string> {
  const result = await gitCommand(cwd, arguments_, allowFailure);
  return new TextDecoder().decode(result.stdout);
}

async function gitBytes(
  cwd: string,
  arguments_: readonly string[],
): Promise<Uint8Array> {
  return (await gitCommand(cwd, arguments_, false)).stdout;
}

async function gitSucceeded(
  cwd: string,
  arguments_: readonly string[],
): Promise<boolean> {
  return (await gitCommand(cwd, arguments_, true)).code === 0;
}

async function gitCommand(
  cwd: string,
  arguments_: readonly string[],
  allowFailure: boolean,
): Promise<Readonly<{ code: number; stdout: Uint8Array }>> {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL']) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_TERMINAL_PROMPT = '0';
  return runCommand(
    'git',
    arguments_,
    { cwd, environment, label: `git ${arguments_[0] ?? 'command'}` },
    allowFailure,
  );
}

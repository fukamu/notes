import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RELEASE_ARTIFACT_SCHEMA_VERSION,
  RELEASE_ARTIFACT_VERIFIER_VERSION,
  EXPECTED_PRODUCTION_DISABLED_ROUTES,
  createSpdxDocument,
  decodeImageInspection,
  decodeNpmProductionDependencies,
  decodeSavedImageLayers,
  parseGoBuildDependencies,
  parseLatestMigrationVersion,
  validateImageInspection,
  validateLayerTypes,
  validateReleaseManifest,
  validateRuntimePaths,
  validateSpdxDocument,
  type ReleaseManifest,
} from './release-artifact-core.mts';

const maximumCommandOutputBytes = 128 * 1024 * 1024;
const sourceRevision = resolveSourceRevision();
const token = randomUUID().replaceAll('-', '');
const imageReference = `fukamu-notes-release-verify:${sourceRevision.slice(0, 12)}-${token}`;
const temporaryDirectory = await mkdtemp(
  path.join(tmpdir(), 'fukamu-notes-release-verify-'),
);
let imageBuilt = false;
let builtImageID: string | undefined;
const cleanupContainers = new Set<string>();
let verificationFailure: unknown;

try {
  await verifyReleaseArtifact();
} catch (error: unknown) {
  verificationFailure = error;
} finally {
  let cleanupFailure: unknown;
  for (const name of cleanupContainers) {
    try {
      runText('docker', ['container', 'rm', '--force', name]);
    } catch (error: unknown) {
      cleanupFailure ??= error;
    }
  }
  // The unique tag is used only as a cleanup fallback if Docker completed
  // the build but failed to produce a validated iidfile.
  if (imageBuilt) {
    try {
      runText('docker', ['image', 'rm', builtImageID ?? imageReference]);
    } catch (error: unknown) {
      cleanupFailure ??= error;
    }
  }
  try {
    await rm(temporaryDirectory, { recursive: true, force: true });
  } catch (error: unknown) {
    cleanupFailure ??= error;
  }
  verificationFailure ??= cleanupFailure;
}

if (verificationFailure !== undefined) throw verificationFailure;

async function verifyReleaseArtifact(): Promise<void> {
  console.log(`Building disposable release image for ${sourceRevision}`);
  const imageIDFile = path.join(temporaryDirectory, 'image.id');
  runVisible('docker', [
    'build',
    '--file',
    'deploy/Dockerfile',
    '--build-arg',
    `NOTES_SOURCE_REVISION=${sourceRevision}`,
    '--iidfile',
    imageIDFile,
    '--tag',
    imageReference,
    '.',
  ]);
  imageBuilt = true;

  const imageID = (await readFile(imageIDFile, 'utf8')).trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageID)) {
    throw new Error('docker build did not produce an immutable image ID');
  }
  builtImageID = imageID;

  const inspectionCandidate: unknown = JSON.parse(
    runText('docker', ['image', 'inspect', imageID]),
  );
  const inspection = decodeImageInspection(inspectionCandidate);
  validateImageInspection(inspection, sourceRevision);
  if (inspection.imageID !== imageID) {
    throw new Error('release inspection did not retain the built image ID');
  }

  const imageArchive = path.join(temporaryDirectory, 'image.tar');
  runText('docker', ['image', 'save', '--output', imageArchive, imageID]);
  const savedManifestCandidate: unknown = JSON.parse(
    runText('tar', ['-xOf', imageArchive, 'manifest.json']),
  );
  const layers = decodeSavedImageLayers(savedManifestCandidate);
  const layerDirectory = path.join(temporaryDirectory, 'layers');
  await mkdir(layerDirectory);
  runText('tar', [
    '--extract',
    '--file',
    imageArchive,
    '--directory',
    layerDirectory,
    ...layers,
  ]);
  const runtimePaths: string[] = [];
  for (const layer of layers) {
    const layerArchive = path.join(layerDirectory, layer);
    const verboseEntries = commandLines(
      runText('tar', ['--list', '--verbose', '--file', layerArchive]),
    );
    validateLayerTypes(verboseEntries);
    runtimePaths.push(
      ...commandLines(runText('tar', ['--list', '--file', layerArchive])),
    );
  }
  validateRuntimePaths(runtimePaths);

  const extractionContainer = `fukamu-notes-release-verify-${token}-extract`;
  const extractionContainerID = runText('docker', [
    'container',
    'create',
    '--name',
    extractionContainer,
    '--network',
    'none',
    imageID,
  ]).trim();
  cleanupContainers.add(extractionContainer);
  if (!/^[a-f0-9]{64}$/u.test(extractionContainerID)) {
    throw new Error('docker did not return an exact extraction container ID');
  }
  cleanupContainers.delete(extractionContainer);
  cleanupContainers.add(extractionContainerID);

  const extractedDirectory = path.join(temporaryDirectory, 'extracted');
  await mkdir(extractedDirectory);
  const notesBinary = path.join(extractedDirectory, 'notes');
  const frontendDirectory = path.join(extractedDirectory, 'static');
  runText('docker', [
    'container',
    'cp',
    `${extractionContainerID}:/notes`,
    notesBinary,
  ]);
  runText('docker', [
    'container',
    'cp',
    `${extractionContainerID}:/app/static`,
    frontendDirectory,
  ]);
  runText('docker', ['container', 'rm', extractionContainerID]);
  cleanupContainers.delete(extractionContainerID);
  await chmod(notesBinary, 0o700);

  const binary = await fileEvidence(notesBinary);
  const frontend = await treeEvidence(frontendDirectory);
  const goDependencies = parseGoBuildDependencies(
    runText('go', ['version', '-m', notesBinary]),
  );
  const packageLockCandidate: unknown = JSON.parse(
    await readFile('package-lock.json', 'utf8'),
  );
  const npmDependencies = decodeNpmProductionDependencies(packageLockCandidate);
  const schemaMigrationVersion = parseLatestMigrationVersion(
    await readFile('backend/migrations/migrations.go', 'utf8'),
  );

  const { verifiedRoutes, lifecycle: loopbackSmoke } =
    await runExtractedBinaryLoopbackSmoke(notesBinary, frontendDirectory);
  const networkNoneLifecycles: ReleaseManifest['networkNoneLifecycles'][number][] =
    [];
  for (let cycle = 1; cycle <= 2; cycle += 1) {
    networkNoneLifecycles.push(await runNetworkNoneLifecycle(imageID, cycle));
  }

  const manifest: ReleaseManifest = {
    schemaVersion: RELEASE_ARTIFACT_SCHEMA_VERSION,
    verifierVersion: RELEASE_ARTIFACT_VERIFIER_VERSION,
    sourceRevision,
    imageID: inspection.imageID,
    imageReference,
    schemaMigrationVersion,
    runtimeUser: inspection.user,
    entrypoint: inspection.entrypoint,
    notesBinary: binary,
    frontend,
    verifiedRoutes,
    loopbackSmoke,
    networkNoneLifecycles,
    productionTransition: {
      status: 'not-performed',
      reason: 'explicit-production-approval-required',
    },
  };
  validateReleaseManifest(manifest);
  const sbom = createSpdxDocument(
    sourceRevision,
    inspection.imageID,
    new Date().toISOString(),
    [...goDependencies, ...npmDependencies],
  );
  validateSpdxDocument(sbom);

  const outputDirectory = path.resolve('dist/release');
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(outputDirectory, 'manifest.json'),
      `${JSON.stringify(manifest, undefined, 2)}\n`,
    ),
    writeFile(
      path.join(outputDirectory, 'sbom.spdx.json'),
      `${JSON.stringify(sbom, undefined, 2)}\n`,
    ),
  ]);
  console.log(
    `Release artifact verified: ${runtimePaths.length} layer entries, ${frontend.files} frontend files, ${goDependencies.length + npmDependencies.length} dependency records`,
  );
}

function resolveSourceRevision(): string {
  const candidate =
    process.env.GITHUB_SHA ?? runText('git', ['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/u.test(candidate)) {
    throw new Error(
      'release source revision must be a full lowercase Git commit SHA',
    );
  }
  return candidate;
}

function runVisible(command: string, arguments_: readonly string[]): void {
  const result = spawnSync(command, arguments_, {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with exit status ${String(result.status)}`,
    );
  }
}

function runText(command: string, arguments_: readonly string[]): string {
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: maximumCommandOutputBytes,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const diagnostic = `${result.stderr}\n${result.stdout}`
      .trim()
      .slice(0, 4_000);
    throw new Error(
      `${command} failed with exit status ${String(result.status)}${diagnostic.length > 0 ? `: ${diagnostic}` : ''}`,
    );
  }
  return result.stdout;
}

function runCombinedText(
  command: string,
  arguments_: readonly string[],
): string {
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: maximumCommandOutputBytes,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with exit status ${String(result.status)}`,
    );
  }
  return `${result.stdout}\n${result.stderr}`;
}

function commandLines(output: string): readonly string[] {
  return output.split(/\r?\n/u).filter((line) => line.length > 0);
}

async function fileEvidence(
  filename: string,
): Promise<Readonly<{ sha256: string; bytes: number }>> {
  const contents = await readFile(filename);
  if (contents.length < 1) throw new Error('release binary is empty');
  return {
    sha256: createHash('sha256').update(contents).digest('hex'),
    bytes: contents.length,
  };
}

async function treeEvidence(
  root: string,
): Promise<Readonly<{ sha256: string; files: number; bytes: number }>> {
  const files = await regularFiles(root);
  if (files.length < 1) throw new Error('release frontend is empty');
  const hash = createHash('sha256');
  let bytes = 0;
  for (const filename of files) {
    const relative = path.relative(root, filename).split(path.sep).join('/');
    const contents = await readFile(filename);
    bytes += contents.length;
    hash.update(relative);
    hash.update('\0');
    hash.update(contents);
    hash.update('\0');
  }
  if (bytes < 1) throw new Error('release frontend contains no bytes');
  return { sha256: hash.digest('hex'), files: files.length, bytes };
}

async function regularFiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const filename = path.join(root, entry.name);
    if (entry.isSymbolicLink())
      throw new Error('release frontend contains a symbolic link');
    if (entry.isDirectory()) files.push(...(await regularFiles(filename)));
    else if (entry.isFile()) files.push(filename);
    else throw new Error('release frontend contains a non-regular entry');
  }
  return files.sort();
}

async function waitForHealth(
  port: number,
  process: ChildProcessWithoutNullStreams,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null || process.signalCode !== null) {
      throw new Error('release loopback process exited before health');
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      const body = await response.text();
      if (response.status === 200 && body === '{"status":"ok"}\n') return;
    } catch {
      // A fresh process may not have bound its loopback port yet.
    }
    await delay(100);
  }
  throw new Error('release loopback process did not become healthy');
}

async function verifyRoutes(
  port: number,
  frontendDirectory: string,
): Promise<ReleaseManifest['verifiedRoutes']> {
  const notesHTML = await readFile(path.join(frontendDirectory, 'index.html'));
  const pricingHTML = await readFile(
    path.join(frontendDirectory, 'pricing', 'index.html'),
  );
  const evidence: ReleaseManifest['verifiedRoutes'][number][] = [];
  for (const check of EXPECTED_PRODUCTION_DISABLED_ROUTES) {
    const request: RequestInit = {
      method: check.method,
      redirect: 'manual',
      signal: AbortSignal.timeout(3_000),
    };
    if (check.method === 'POST') {
      request.body = '{}';
      request.headers = { 'Content-Type': 'application/json' };
    }
    const requestTarget =
      check.path === '/api/not-a-release-route'
        ? `${check.path}?token=release-route-query-canary`
        : check.path;
    const response = await fetch(
      `http://127.0.0.1:${port}${requestTarget}`,
      request,
    );
    const body = Buffer.from(await response.arrayBuffer());
    const expectedBody = releaseRouteBody(
      check.bodyKind,
      notesHTML,
      pricingHTML,
    );
    if (
      response.status !== check.status ||
      !body.equals(expectedBody) ||
      response.headers.get('content-type') !== check.contentType ||
      response.headers.get('cache-control') !== check.cacheControl ||
      (response.headers.get('vary') ?? '') !== check.vary
    ) {
      throw new Error(
        `release route ${check.method} ${check.path} returned an unexpected response`,
      );
    }
    if (check.contentType === 'application/json; charset=utf-8') {
      if (response.headers.get('x-content-type-options') !== 'nosniff') {
        throw new Error(
          `release route ${check.method} ${check.path} omitted JSON security headers`,
        );
      }
    } else {
      validateReleaseHTMLHeaders(response, check.path);
    }
    evidence.push({
      method: check.method,
      path: check.path,
      status: response.status,
      bodyKind: check.bodyKind,
      bodySha256: createHash('sha256').update(body).digest('hex'),
      contentType: check.contentType,
      cacheControl: check.cacheControl,
      vary: check.vary,
    });
  }
  return evidence;
}

function releaseRouteBody(
  kind: (typeof EXPECTED_PRODUCTION_DISABLED_ROUTES)[number]['bodyKind'],
  notesHTML: Buffer,
  pricingHTML: Buffer,
): Buffer {
  switch (kind) {
    case 'health-ok':
      return Buffer.from('{"status":"ok"}\n');
    case 'not-ready':
      return Buffer.from('{"status":"not_ready"}\n');
    case 'notes-html':
      return notesHTML;
    case 'pricing-html':
      return pricingHTML;
    case 'not-found-code':
      return Buffer.from('{"code":"not_found"}\n');
    case 'launch-unavailable':
      return Buffer.from('{"error":"launch-gate-unavailable"}\n');
    case 'unavailable':
      return Buffer.from('{"error":"unavailable"}\n');
  }
}

function validateReleaseHTMLHeaders(
  response: Response,
  requestPath: string,
): void {
  const expected = new Map<string, string>([
    [
      'content-security-policy',
      "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:",
    ],
    ['permissions-policy', 'camera=(), geolocation=(), microphone=()'],
    ['referrer-policy', 'no-referrer'],
    ['x-content-type-options', 'nosniff'],
    ['cross-origin-opener-policy', 'same-origin'],
    ['x-frame-options', 'DENY'],
  ]);
  for (const [name, value] of expected) {
    if (response.headers.get(name) !== value) {
      throw new Error(
        `release static route ${requestPath} omitted security headers`,
      );
    }
  }
}

async function runExtractedBinaryLoopbackSmoke(
  notesBinary: string,
  frontendDirectory: string,
): Promise<
  Readonly<{
    verifiedRoutes: ReleaseManifest['verifiedRoutes'];
    lifecycle: ReleaseManifest['loopbackSmoke'];
  }>
> {
  const port = await reserveLoopbackPort();
  const logs = createBoundedLogCollector();
  const child = spawn(notesBinary, [], {
    env: releaseProcessEnvironment(port, frontendDirectory),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();
  child.stdout.on('data', logs.append);
  child.stderr.on('data', logs.append);
  const exited = childExit(child);
  let verifiedRoutes: ReleaseManifest['verifiedRoutes'];
  try {
    await waitForHealth(port, child);
    verifiedRoutes = await verifyRoutes(port, frontendDirectory);
  } catch (error: unknown) {
    child.kill('SIGKILL');
    await exited;
    throw error;
  }
  if (!child.kill('SIGTERM')) {
    child.kill('SIGKILL');
    await exited;
    throw new Error('release loopback process rejected SIGTERM');
  }
  const result = await waitForChildExit(child, exited);
  const text = logs.value();
  assertReleaseLifecycleLogs(text, [
    notesBinary,
    frontendDirectory,
    temporaryDirectory,
    'release-route-query-canary',
  ]);
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(
      'release loopback process did not exit cleanly after SIGTERM',
    );
  }
  return {
    verifiedRoutes,
    lifecycle: {
      runtime: 'extracted-image-binary',
      bindAddress: '127.0.0.1',
      exitCode: result.code,
      signal: 'SIGTERM',
      gracefulShutdown: true,
      logsSha256: createHash('sha256').update(text).digest('hex'),
    },
  };
}

async function runNetworkNoneLifecycle(
  imageID: string,
  cycle: number,
): Promise<ReleaseManifest['networkNoneLifecycles'][number]> {
  const name = `fukamu-notes-release-verify-${token}-none-${String(cycle)}`;
  const containerID = runText('docker', [
    'container',
    'create',
    '--name',
    name,
    '--network',
    'none',
    imageID,
  ]).trim();
  cleanupContainers.add(name);
  if (!/^[a-f0-9]{64}$/u.test(containerID)) {
    throw new Error('docker did not return an exact container ID');
  }
  cleanupContainers.delete(name);
  cleanupContainers.add(containerID);
  const networkMode = runText('docker', [
    'container',
    'inspect',
    '--format',
    '{{.HostConfig.NetworkMode}}',
    containerID,
  ]).trim();
  const boundImageID = runText('docker', [
    'container',
    'inspect',
    '--format',
    '{{.Image}}',
    containerID,
  ]).trim();
  const portBindings = runText('docker', [
    'container',
    'inspect',
    '--format',
    '{{json .HostConfig.PortBindings}}',
    containerID,
  ]).trim();
  if (
    networkMode !== 'none' ||
    boundImageID !== imageID ||
    (portBindings !== 'null' && portBindings !== '{}')
  ) {
    throw new Error('release network-none container isolation is invalid');
  }
  runText('docker', ['container', 'start', containerID]);
  await waitForContainerStartup(containerID);
  runText('docker', [
    'container',
    'stop',
    '--signal',
    'SIGTERM',
    '--time',
    '15',
    containerID,
  ]);
  const exitCode = runText('docker', [
    'container',
    'inspect',
    '--format',
    '{{.State.ExitCode}}',
    containerID,
  ]).trim();
  const text = runCombinedText('docker', ['container', 'logs', containerID]);
  assertReleaseLifecycleLogs(text, [imageReference, temporaryDirectory]);
  if (exitCode !== '0') {
    throw new Error('release network-none container did not exit cleanly');
  }
  return {
    containerID,
    imageID,
    networkMode: 'none',
    exitCode: 0,
    signal: 'SIGTERM',
    gracefulShutdown: true,
    logsSha256: createHash('sha256').update(text).digest('hex'),
  };
}

async function waitForContainerStartup(name: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const logs = runCombinedText('docker', ['container', 'logs', name]);
    if (logs.includes('"msg":"server starting"')) return;
    const running = runText('docker', [
      'container',
      'inspect',
      '--format',
      '{{.State.Running}}',
      name,
    ]).trim();
    if (running !== 'true') {
      throw new Error('release network-none container exited before startup');
    }
    await delay(100);
  }
  throw new Error('release network-none container did not start');
}

function releaseProcessEnvironment(
  port: number,
  frontendDirectory: string,
): NodeJS.ProcessEnv {
  return {
    NOTES_ENVIRONMENT: 'production',
    NOTES_HTTP_ADDR: `127.0.0.1:${String(port)}`,
    NOTES_STATIC_DIR: frontendDirectory,
    NOTES_BODY_LIMIT_BYTES: '4000000',
    NOTES_SHUTDOWN_TIMEOUT: '10s',
    NOTES_LOG_LEVEL: 'info',
  };
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('failed to reserve a loopback port');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
  return address.port;
}

function createBoundedLogCollector(): Readonly<{
  append: (chunk: Buffer | string) => void;
  value: () => string;
}> {
  let content = '';
  let exceeded = false;
  const append = (chunk: Buffer | string): void => {
    if (exceeded) return;
    content += chunk.toString();
    if (Buffer.byteLength(content) > maximumCommandOutputBytes) {
      exceeded = true;
      content = '';
    }
  };
  return {
    append,
    value: () => {
      if (exceeded) {
        throw new Error('release process log output exceeded the safety limit');
      }
      return content;
    },
  };
}

function childExit(
  child: ChildProcessWithoutNullStreams,
): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    // `close` follows process exit only after stdout/stderr have drained.
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  exited: Promise<
    Readonly<{ code: number | null; signal: NodeJS.Signals | null }>
  >,
): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error('release loopback process did not drain after SIGTERM'),
            ),
          15_000,
        );
      }),
    ]);
  } catch (error: unknown) {
    child.kill('SIGKILL');
    await exited;
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function assertReleaseLifecycleLogs(
  logs: string,
  forbidden: readonly string[],
): void {
  if (
    !logs.includes('"msg":"server starting"') ||
    !logs.includes('"msg":"server stopped"') ||
    !logs.includes('"reason":"shutdown"')
  ) {
    throw new Error('release lifecycle logs are incomplete');
  }
  for (const value of forbidden) {
    if (value.length > 0 && logs.includes(value)) {
      throw new Error('release lifecycle logs contain forbidden context');
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

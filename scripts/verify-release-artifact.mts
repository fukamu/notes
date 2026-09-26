import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RELEASE_ARTIFACT_SCHEMA_VERSION,
  RELEASE_ARTIFACT_VERIFIER_VERSION,
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
const routeChecks = [
  { method: 'GET', path: '/healthz', status: 200, body: '"status":"ok"' },
  { method: 'GET', path: '/readyz', status: 503, body: '"status":"not_ready"' },
  { method: 'GET', path: '/', status: 200, body: '<div id="root">' },
  { method: 'GET', path: '/pricing', status: 200, body: '<!doctype html>' },
  {
    method: 'GET',
    path: '/cards/release-verification/history',
    status: 200,
    body: '<div id="root">',
  },
  {
    method: 'GET',
    path: '/not-a-release-route',
    status: 404,
    body: '"not_found"',
  },
  {
    method: 'GET',
    path: '/api/not-a-release-route',
    status: 404,
    body: '"not_found"',
  },
  {
    method: 'POST',
    path: '/api/v2/sync',
    status: 503,
    body: '"launch-gate-unavailable"',
  },
  {
    method: 'POST',
    path: '/api/account/deletion',
    status: 503,
    body: '"unavailable"',
  },
] as const;

const sourceRevision = resolveSourceRevision();
const token = randomUUID().replaceAll('-', '');
const imageReference = `fukamu-notes-release-verify:${sourceRevision.slice(0, 12)}-${token}`;
const containerName = `fukamu-notes-release-verify-${token}`;
const temporaryDirectory = await mkdtemp(
  path.join(tmpdir(), 'fukamu-notes-release-verify-'),
);
let imageBuilt = false;
let containerCreated = false;
let verificationFailure: unknown;

try {
  await verifyReleaseArtifact();
} catch (error: unknown) {
  verificationFailure = error;
} finally {
  try {
    if (containerCreated)
      runText('docker', ['container', 'rm', '--force', containerName]);
    if (imageBuilt) runText('docker', ['image', 'rm', imageReference]);
    await rm(temporaryDirectory, { recursive: true, force: true });
  } catch (error: unknown) {
    if (verificationFailure === undefined) verificationFailure = error;
  }
}

if (verificationFailure !== undefined) throw verificationFailure;

async function verifyReleaseArtifact(): Promise<void> {
  console.log(`Building disposable release image for ${sourceRevision}`);
  runVisible('docker', [
    'build',
    '--file',
    'deploy/Dockerfile',
    '--build-arg',
    `NOTES_SOURCE_REVISION=${sourceRevision}`,
    '--tag',
    imageReference,
    '.',
  ]);
  imageBuilt = true;

  const inspectionCandidate: unknown = JSON.parse(
    runText('docker', ['image', 'inspect', imageReference]),
  );
  const inspection = decodeImageInspection(inspectionCandidate);
  validateImageInspection(inspection, sourceRevision);

  const imageArchive = path.join(temporaryDirectory, 'image.tar');
  runText('docker', [
    'image',
    'save',
    '--output',
    imageArchive,
    imageReference,
  ]);
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

  runText('docker', [
    'container',
    'create',
    '--name',
    containerName,
    '--publish',
    '127.0.0.1::8080',
    imageReference,
  ]);
  containerCreated = true;

  const extractedDirectory = path.join(temporaryDirectory, 'extracted');
  await mkdir(extractedDirectory);
  const notesBinary = path.join(extractedDirectory, 'notes');
  const frontendDirectory = path.join(extractedDirectory, 'static');
  runText('docker', [
    'container',
    'cp',
    `${containerName}:/notes`,
    notesBinary,
  ]);
  runText('docker', [
    'container',
    'cp',
    `${containerName}:/app/static`,
    frontendDirectory,
  ]);

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

  runText('docker', ['container', 'start', containerName]);
  const port = await waitForContainerPort(containerName);
  await waitForHealth(port);
  const verifiedRoutes = await verifyRoutes(port);

  runText('docker', [
    'container',
    'stop',
    '--signal',
    'SIGTERM',
    '--time',
    '15',
    containerName,
  ]);
  const exitCode = runText('docker', [
    'container',
    'inspect',
    '--format',
    '{{.State.ExitCode}}',
    containerName,
  ]).trim();
  const logs = runCombinedText('docker', ['container', 'logs', containerName]);
  if (
    exitCode !== '0' ||
    !logs.includes('server stopped') ||
    !logs.includes('shutdown')
  ) {
    throw new Error(
      'release container did not complete a graceful SIGTERM shutdown',
    );
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

async function waitForContainerPort(name: string): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const output = runText('docker', [
      'container',
      'port',
      name,
      '8080/tcp',
    ]).trim();
    const match = /^127\.0\.0\.1:(\d{1,5})$/u.exec(output);
    const port = match?.[1] === undefined ? 0 : Number(match[1]);
    if (Number.isSafeInteger(port) && port >= 1 && port <= 65_535) return port;
    await delay(100);
  }
  throw new Error('release container did not publish its loopback port');
}

async function waitForHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) return;
    } catch {
      // A fresh container may not have bound its port yet.
    }
    await delay(100);
  }
  throw new Error('release container did not become healthy');
}

async function verifyRoutes(
  port: number,
): Promise<ReleaseManifest['verifiedRoutes']> {
  const evidence: { method: string; path: string; status: number }[] = [];
  for (const check of routeChecks) {
    const request: RequestInit = {
      method: check.method,
      redirect: 'manual',
      signal: AbortSignal.timeout(3_000),
    };
    if (check.method === 'POST') {
      request.body = '{}';
      request.headers = { 'Content-Type': 'application/json' };
    }
    const response = await fetch(
      `http://127.0.0.1:${port}${check.path}`,
      request,
    );
    const body = await response.text();
    if (response.status !== check.status || !body.includes(check.body)) {
      throw new Error(
        `release route ${check.method} ${check.path} returned an unexpected response`,
      );
    }
    evidence.push({
      method: check.method,
      path: check.path,
      status: response.status,
    });
  }
  return evidence;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

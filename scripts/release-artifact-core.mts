import { createHash } from 'node:crypto';
import path from 'node:path';

export const RELEASE_ARTIFACT_SCHEMA_VERSION = 2;
export const RELEASE_ARTIFACT_VERIFIER_VERSION = 2;

const sha256Pattern = /^[a-f0-9]{64}$/u;
const imageIDPattern = /^sha256:[a-f0-9]{64}$/u;
const revisionPattern = /^[a-f0-9]{40}$/u;
const savedLayerPattern =
  /^(?:[a-f0-9]{64}\/layer\.tar|blobs\/sha256\/[a-f0-9]{64})$/u;

export type ImageInspection = Readonly<{
  imageID: string;
  user: string;
  entrypoint: readonly string[];
  command: readonly string[];
  environment: readonly string[];
  labels: Readonly<Record<string, string>>;
}>;

export type ReleaseManifest = Readonly<{
  schemaVersion: number;
  verifierVersion: number;
  sourceRevision: string;
  imageID: string;
  imageReference: string;
  schemaMigrationVersion: number;
  runtimeUser: string;
  entrypoint: readonly string[];
  notesBinary: Readonly<{ sha256: string; bytes: number }>;
  frontend: Readonly<{
    sha256: string;
    files: number;
    bytes: number;
  }>;
  verifiedRoutes: readonly Readonly<{
    method: string;
    path: string;
    status: number;
    bodyKind: string;
    bodySha256: string;
    contentType: string;
    cacheControl: string;
    vary: string;
  }>[];
  loopbackSmoke: Readonly<{
    runtime: string;
    bindAddress: string;
    exitCode: number;
    signal: string;
    gracefulShutdown: boolean;
    logsSha256: string;
  }>;
  networkNoneLifecycles: readonly Readonly<{
    containerID: string;
    imageID: string;
    networkMode: string;
    exitCode: number;
    signal: string;
    gracefulShutdown: boolean;
    logsSha256: string;
  }>[];
  productionTransition: Readonly<{
    status: string;
    reason: string;
  }>;
}>;

type ExpectedReleaseRoute = Readonly<{
  method: 'GET' | 'POST';
  path: string;
  status: number;
  bodyKind:
    | 'health-ok'
    | 'not-ready'
    | 'notes-html'
    | 'pricing-html'
    | 'not-found-code'
    | 'launch-unavailable'
    | 'unavailable';
  contentType: string;
  cacheControl: string;
  vary: string;
}>;

const jsonContentType = 'application/json; charset=utf-8';
const privateVary = 'Cookie, X-Fukamu-Local-Identity-Assertion';

export const EXPECTED_PRODUCTION_DISABLED_ROUTES: readonly ExpectedReleaseRoute[] =
  [
    {
      method: 'GET',
      path: '/healthz',
      status: 200,
      bodyKind: 'health-ok',
      contentType: jsonContentType,
      cacheControl: 'no-store',
      vary: '',
    },
    {
      method: 'GET',
      path: '/readyz',
      status: 503,
      bodyKind: 'not-ready',
      contentType: jsonContentType,
      cacheControl: 'no-store',
      vary: '',
    },
    {
      method: 'GET',
      path: '/',
      status: 200,
      bodyKind: 'notes-html',
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'no-store',
      vary: '',
    },
    {
      method: 'GET',
      path: '/pricing',
      status: 200,
      bodyKind: 'pricing-html',
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'no-store',
      vary: '',
    },
    {
      method: 'GET',
      path: '/cards/release-verification/history',
      status: 200,
      bodyKind: 'notes-html',
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'no-store',
      vary: '',
    },
    {
      method: 'GET',
      path: '/not-a-release-route',
      status: 404,
      bodyKind: 'not-found-code',
      contentType: jsonContentType,
      cacheControl: 'no-store',
      vary: '',
    },
    {
      method: 'GET',
      path: '/api/not-a-release-route',
      status: 404,
      bodyKind: 'not-found-code',
      contentType: jsonContentType,
      cacheControl: 'no-store',
      vary: '',
    },
    {
      method: 'GET',
      path: '/api/launch-status',
      status: 503,
      bodyKind: 'launch-unavailable',
      contentType: jsonContentType,
      cacheControl: 'private, no-store',
      vary: privateVary,
    },
    {
      method: 'POST',
      path: '/api/sync',
      status: 404,
      bodyKind: 'not-found-code',
      contentType: jsonContentType,
      cacheControl: 'no-store',
      vary: '',
    },
    {
      method: 'POST',
      path: '/api/v2/sync',
      status: 503,
      bodyKind: 'launch-unavailable',
      contentType: jsonContentType,
      cacheControl: 'private, no-store',
      vary: privateVary,
    },
    {
      method: 'GET',
      path: '/api/session-context',
      status: 503,
      bodyKind: 'launch-unavailable',
      contentType: jsonContentType,
      cacheControl: 'private, no-store',
      vary: privateVary,
    },
    {
      method: 'GET',
      path: '/api/billing/checkout',
      status: 503,
      bodyKind: 'launch-unavailable',
      contentType: jsonContentType,
      cacheControl: 'private, no-store',
      vary: privateVary,
    },
    {
      method: 'POST',
      path: '/api/billing/checkout',
      status: 503,
      bodyKind: 'launch-unavailable',
      contentType: jsonContentType,
      cacheControl: 'private, no-store',
      vary: privateVary,
    },
    {
      method: 'GET',
      path: '/api/account/terms-consent',
      status: 503,
      bodyKind: 'launch-unavailable',
      contentType: jsonContentType,
      cacheControl: 'private, no-store',
      vary: privateVary,
    },
    {
      method: 'POST',
      path: '/api/account/terms-consent',
      status: 503,
      bodyKind: 'launch-unavailable',
      contentType: jsonContentType,
      cacheControl: 'private, no-store',
      vary: privateVary,
    },
    {
      method: 'POST',
      path: '/api/billing/cancel',
      status: 503,
      bodyKind: 'unavailable',
      contentType: jsonContentType,
      cacheControl: 'no-store',
      vary: '',
    },
    {
      method: 'POST',
      path: '/api/account/deletion',
      status: 503,
      bodyKind: 'unavailable',
      contentType: jsonContentType,
      cacheControl: 'no-store',
      vary: '',
    },
    {
      method: 'POST',
      path: '/api/account/deletion/status',
      status: 503,
      bodyKind: 'unavailable',
      contentType: jsonContentType,
      cacheControl: 'no-store',
      vary: '',
    },
    {
      method: 'POST',
      path: '/api/account/privacy-requests',
      status: 503,
      bodyKind: 'unavailable',
      contentType: jsonContentType,
      cacheControl: 'no-store',
      vary: '',
    },
    {
      method: 'POST',
      path: '/api/account/privacy-requests/status',
      status: 503,
      bodyKind: 'unavailable',
      contentType: jsonContentType,
      cacheControl: 'no-store',
      vary: '',
    },
  ] as const;

export type DependencyPackage = Readonly<{
  ecosystem: 'golang' | 'npm';
  name: string;
  version: string;
  license: string;
}>;

export function decodeImageInspection(candidate: unknown): ImageInspection {
  if (!Array.isArray(candidate) || candidate.length !== 1) {
    throw new TypeError('release image inspection must contain one image');
  }
  const image = record(candidate[0], 'release image inspection');
  const config = record(image.Config, 'release image config');
  const imageID = boundedString(image.Id, 'release image id', 80);
  if (!imageIDPattern.test(imageID)) {
    throw new TypeError('release image id is invalid');
  }
  const user = boundedString(config.User, 'release image user', 64);
  const entrypoint = stringArray(config.Entrypoint, 'release image entrypoint');
  const command =
    config.Cmd === null || config.Cmd === undefined
      ? []
      : stringArray(config.Cmd, 'release image command');
  const environment = stringArray(config.Env, 'release image environment');
  const labels = stringRecord(config.Labels, 'release image labels');
  return { imageID, user, entrypoint, command, environment, labels };
}

export function validateImageInspection(
  inspection: ImageInspection,
  sourceRevision: string,
): void {
  if (!revisionPattern.test(sourceRevision)) {
    throw new TypeError('release source revision is invalid');
  }
  if (inspection.user !== '65532:65532') {
    throw new TypeError('release image must use the fixed non-root identity');
  }
  if (
    inspection.entrypoint.length !== 1 ||
    inspection.entrypoint[0] !== '/notes' ||
    inspection.command.length !== 0
  ) {
    throw new TypeError('release image entrypoint is invalid');
  }
  const requiredEnvironment = new Set([
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'NOTES_ENVIRONMENT=production',
    'NOTES_HTTP_ADDR=0.0.0.0:8080',
    'NOTES_STATIC_DIR=/app/static',
    'NOTES_BODY_LIMIT_BYTES=4000000',
    'NOTES_SHUTDOWN_TIMEOUT=10s',
    'NOTES_LOG_LEVEL=info',
  ]);
  for (const value of inspection.environment) {
    if (/SECRET|TOKEN|PASSWORD|PRIVATE_KEY|DATABASE_URL/iu.test(value)) {
      throw new TypeError(
        'release image environment contains a secret-bearing key',
      );
    }
  }
  for (const value of requiredEnvironment) {
    if (!inspection.environment.includes(value)) {
      throw new TypeError('release image environment is incomplete');
    }
  }
  if (
    inspection.environment.length !== requiredEnvironment.size ||
    inspection.environment.some((value) => !requiredEnvironment.has(value))
  ) {
    throw new TypeError(
      'release image environment contains an unexpected default',
    );
  }
  if (
    inspection.labels['org.opencontainers.image.source'] !==
      'https://github.com/fukamu/notes' ||
    inspection.labels['org.opencontainers.image.revision'] !== sourceRevision ||
    inspection.labels['org.opencontainers.image.title'] !== 'FUKAMU Notes'
  ) {
    throw new TypeError('release image provenance labels are invalid');
  }
}

export function decodeSavedImageLayers(candidate: unknown): readonly string[] {
  if (!Array.isArray(candidate) || candidate.length !== 1) {
    throw new TypeError('saved release image must contain one manifest');
  }
  const manifest = record(candidate[0], 'saved release image manifest');
  if (!Array.isArray(manifest.Layers) || manifest.Layers.length < 1) {
    throw new TypeError('saved release image layers are missing');
  }
  return manifest.Layers.map((value) => {
    const layer = boundedString(value, 'saved release image layer', 160);
    if (!savedLayerPattern.test(layer)) {
      throw new TypeError('saved release image layer path is unsafe');
    }
    return layer;
  });
}

export function validateLayerTypes(lines: readonly string[]): void {
  if (lines.length === 0) {
    throw new TypeError('release image layer is empty');
  }
  for (const line of lines) {
    if (line.length === 0 || (line[0] !== '-' && line[0] !== 'd')) {
      throw new TypeError('release image layer contains a non-regular entry');
    }
  }
}

export function validateRuntimePaths(
  rawPaths: readonly string[],
): readonly string[] {
  const paths = new Set<string>();
  for (const rawPath of rawPaths) {
    const candidate = rawPath.replace(/^\.\//u, '').replace(/\/$/u, '');
    if (
      candidate.length === 0 ||
      candidate.includes('\0') ||
      candidate.startsWith('/') ||
      candidate.split('/').includes('..') ||
      path.posix.normalize(candidate) !== candidate
    ) {
      throw new TypeError('release image contains an unsafe path');
    }
    if (
      candidate !== 'notes' &&
      candidate !== 'app' &&
      candidate !== 'app/static' &&
      candidate !== 'etc' &&
      candidate !== 'etc/ssl' &&
      candidate !== 'etc/ssl/certs' &&
      candidate !== 'etc/ssl/certs/ca-certificates.crt' &&
      !candidate.startsWith('app/static/')
    ) {
      throw new TypeError('release image contains unexpected runtime content');
    }
    if (
      /(?:^|\/)(?:node|npm|npx|node_modules|server|db)(?:$|\/)/iu.test(
        candidate,
      ) ||
      candidate.startsWith('app/api/') ||
      /\.(?:ts|tsx|mts|cts|sql)$/iu.test(candidate)
    ) {
      throw new TypeError(
        'release image contains a legacy server runtime artifact',
      );
    }
    paths.add(candidate);
  }
  for (const required of [
    'notes',
    'app/static/index.html',
    'app/static/sw.js',
    'app/static/manifest.webmanifest',
    'etc/ssl/certs/ca-certificates.crt',
  ]) {
    if (!paths.has(required)) {
      throw new TypeError('release image is missing required runtime content');
    }
  }
  if (
    ![...paths].some((value) => /^app\/static\/assets\/[^/]+\.js$/u.test(value))
  ) {
    throw new TypeError('release image is missing a bundled frontend asset');
  }
  return [...paths].sort();
}

export function parseGoBuildDependencies(
  output: string,
): readonly DependencyPackage[] {
  const packages = new Map<string, DependencyPackage>();
  for (const line of output.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    if (fields[0] !== 'dep' || fields.length < 3) continue;
    const name = fields[1];
    const version = fields[2];
    if (
      name === undefined ||
      version === undefined ||
      !validPackageValue(name) ||
      !validPackageValue(version)
    ) {
      throw new TypeError('Go build dependency is invalid');
    }
    packages.set(`golang:${name}@${version}`, {
      ecosystem: 'golang',
      name,
      version,
      license: 'NOASSERTION',
    });
  }
  return [...packages.values()].sort(compareDependency);
}

export function decodeNpmProductionDependencies(
  candidate: unknown,
): readonly DependencyPackage[] {
  const root = record(candidate, 'package lock');
  const packages = record(root.packages, 'package lock packages');
  const result = new Map<string, DependencyPackage>();
  for (const [packagePath, rawPackage] of Object.entries(packages)) {
    if (!packagePath.includes('node_modules/')) continue;
    const packageRecord = record(rawPackage, 'package lock package');
    if (packageRecord.dev === true) continue;
    const marker = packagePath.lastIndexOf('node_modules/');
    const name = packagePath.slice(marker + 'node_modules/'.length);
    const version = boundedString(
      packageRecord.version,
      'npm package version',
      128,
    );
    const license =
      typeof packageRecord.license === 'string' &&
      validPackageValue(packageRecord.license)
        ? packageRecord.license
        : 'NOASSERTION';
    if (!validPackageValue(name) || name.includes('/node_modules/')) {
      throw new TypeError('npm package name is invalid');
    }
    result.set(`npm:${name}@${version}`, {
      ecosystem: 'npm',
      name,
      version,
      license,
    });
  }
  return [...result.values()].sort(compareDependency);
}

export function parseLatestMigrationVersion(source: string): number {
  const match = /^const LatestVersion int64 = (\d+)$/mu.exec(source);
  if (match === null || match[1] === undefined) {
    throw new TypeError('latest migration version declaration is missing');
  }
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError('latest migration version is invalid');
  }
  return version;
}

export function validateReleaseManifest(candidate: unknown): ReleaseManifest {
  const manifest = record(candidate, 'release manifest');
  exactKeys(manifest, 'release manifest', [
    'schemaVersion',
    'verifierVersion',
    'sourceRevision',
    'imageID',
    'imageReference',
    'schemaMigrationVersion',
    'runtimeUser',
    'entrypoint',
    'notesBinary',
    'frontend',
    'verifiedRoutes',
    'loopbackSmoke',
    'networkNoneLifecycles',
    'productionTransition',
  ]);
  const schemaVersion = safeInteger(
    manifest.schemaVersion,
    'release manifest schema version',
  );
  const verifierVersion = safeInteger(
    manifest.verifierVersion,
    'release verifier version',
  );
  const sourceRevision = boundedString(
    manifest.sourceRevision,
    'release source revision',
    40,
  );
  const imageID = boundedString(manifest.imageID, 'release image id', 80);
  const imageReference = boundedString(
    manifest.imageReference,
    'release image reference',
    160,
  );
  const schemaMigrationVersion = safeInteger(
    manifest.schemaMigrationVersion,
    'release migration version',
  );
  const runtimeUser = boundedString(
    manifest.runtimeUser,
    'release runtime user',
    64,
  );
  const entrypoint = stringArray(
    manifest.entrypoint,
    'release manifest entrypoint',
  );
  const notesBinaryRecord = record(
    manifest.notesBinary,
    'release notes binary',
  );
  const frontendRecord = record(manifest.frontend, 'release frontend');
  exactKeys(notesBinaryRecord, 'release notes binary', ['sha256', 'bytes']);
  exactKeys(frontendRecord, 'release frontend', ['sha256', 'files', 'bytes']);
  const notesBinary = {
    sha256: digest(notesBinaryRecord.sha256, 'release binary digest'),
    bytes: positiveInteger(notesBinaryRecord.bytes, 'release binary bytes'),
  };
  const frontend = {
    sha256: digest(frontendRecord.sha256, 'release frontend digest'),
    files: positiveInteger(frontendRecord.files, 'release frontend files'),
    bytes: positiveInteger(frontendRecord.bytes, 'release frontend bytes'),
  };
  if (!Array.isArray(manifest.verifiedRoutes)) {
    throw new TypeError('release verified routes are incomplete');
  }
  const verifiedRoutes = manifest.verifiedRoutes.map((rawRoute) => {
    const route = record(rawRoute, 'release verified route');
    exactKeys(route, 'release verified route', [
      'method',
      'path',
      'status',
      'bodyKind',
      'bodySha256',
      'contentType',
      'cacheControl',
      'vary',
    ]);
    const method = boundedString(route.method, 'release route method', 16);
    const routePath = boundedString(route.path, 'release route path', 256);
    const status = safeInteger(route.status, 'release route status');
    const bodyKind = boundedString(
      route.bodyKind,
      'release route body kind',
      64,
    );
    const bodySha256 = digest(route.bodySha256, 'release route body digest');
    const contentType = boundedString(
      route.contentType,
      'release route content type',
      128,
    );
    const cacheControl = boundedString(
      route.cacheControl,
      'release route cache control',
      128,
    );
    if (typeof route.vary !== 'string' || route.vary.length > 128) {
      throw new TypeError('release route vary header is invalid');
    }
    const vary = route.vary;
    if (
      !/^(?:GET|POST)$/u.test(method) ||
      !routePath.startsWith('/') ||
      status < 100 ||
      status > 599
    ) {
      throw new TypeError('release verified route is invalid');
    }
    return {
      method,
      path: routePath,
      status,
      bodyKind,
      bodySha256,
      contentType,
      cacheControl,
      vary,
    };
  });
  validateProductionDisabledRouteEvidence(verifiedRoutes);

  const loopbackRecord = record(
    manifest.loopbackSmoke,
    'release loopback smoke',
  );
  exactKeys(loopbackRecord, 'release loopback smoke', [
    'runtime',
    'bindAddress',
    'exitCode',
    'signal',
    'gracefulShutdown',
    'logsSha256',
  ]);
  const loopbackSmoke = {
    runtime: boundedString(
      loopbackRecord.runtime,
      'release loopback runtime',
      64,
    ),
    bindAddress: boundedString(
      loopbackRecord.bindAddress,
      'release loopback address',
      64,
    ),
    exitCode: safeInteger(
      loopbackRecord.exitCode,
      'release loopback exit code',
    ),
    signal: boundedString(loopbackRecord.signal, 'release loopback signal', 32),
    gracefulShutdown: exactBoolean(
      loopbackRecord.gracefulShutdown,
      'release loopback graceful shutdown',
    ),
    logsSha256: digest(
      loopbackRecord.logsSha256,
      'release loopback logs digest',
    ),
  };
  if (
    loopbackSmoke.runtime !== 'extracted-image-binary' ||
    loopbackSmoke.bindAddress !== '127.0.0.1' ||
    loopbackSmoke.exitCode !== 0 ||
    loopbackSmoke.signal !== 'SIGTERM' ||
    loopbackSmoke.gracefulShutdown !== true
  ) {
    throw new TypeError('release loopback smoke is invalid');
  }

  if (
    !Array.isArray(manifest.networkNoneLifecycles) ||
    manifest.networkNoneLifecycles.length !== 2
  ) {
    throw new TypeError(
      'release network-none lifecycle evidence is incomplete',
    );
  }
  const networkNoneLifecycles = manifest.networkNoneLifecycles.map(
    (rawLifecycle) => {
      const lifecycle = record(rawLifecycle, 'release network-none lifecycle');
      exactKeys(lifecycle, 'release network-none lifecycle', [
        'containerID',
        'imageID',
        'networkMode',
        'exitCode',
        'signal',
        'gracefulShutdown',
        'logsSha256',
      ]);
      const parsed = {
        containerID: boundedString(
          lifecycle.containerID,
          'release lifecycle container id',
          64,
        ),
        imageID: boundedString(
          lifecycle.imageID,
          'release lifecycle image id',
          80,
        ),
        networkMode: boundedString(
          lifecycle.networkMode,
          'release lifecycle network mode',
          32,
        ),
        exitCode: safeInteger(
          lifecycle.exitCode,
          'release lifecycle exit code',
        ),
        signal: boundedString(lifecycle.signal, 'release lifecycle signal', 32),
        gracefulShutdown: exactBoolean(
          lifecycle.gracefulShutdown,
          'release lifecycle graceful shutdown',
        ),
        logsSha256: digest(
          lifecycle.logsSha256,
          'release lifecycle logs digest',
        ),
      };
      if (
        !/^[a-f0-9]{64}$/u.test(parsed.containerID) ||
        parsed.imageID !== imageID ||
        parsed.networkMode !== 'none' ||
        parsed.exitCode !== 0 ||
        parsed.signal !== 'SIGTERM' ||
        parsed.gracefulShutdown !== true
      ) {
        throw new TypeError('release network-none lifecycle is invalid');
      }
      return parsed;
    },
  );
  if (
    networkNoneLifecycles[0]?.containerID ===
      networkNoneLifecycles[1]?.containerID ||
    networkNoneLifecycles[0]?.logsSha256 ===
      networkNoneLifecycles[1]?.logsSha256
  ) {
    throw new TypeError(
      'release network-none containers and logs must be distinct',
    );
  }

  const transitionRecord = record(
    manifest.productionTransition,
    'release production transition',
  );
  exactKeys(transitionRecord, 'release production transition', [
    'status',
    'reason',
  ]);
  const productionTransition = {
    status: boundedString(
      transitionRecord.status,
      'release production transition status',
      64,
    ),
    reason: boundedString(
      transitionRecord.reason,
      'release production transition reason',
      128,
    ),
  };
  if (
    productionTransition.status !== 'not-performed' ||
    productionTransition.reason !== 'explicit-production-approval-required'
  ) {
    throw new TypeError('release production transition evidence is invalid');
  }
  if (
    schemaVersion !== RELEASE_ARTIFACT_SCHEMA_VERSION ||
    verifierVersion !== RELEASE_ARTIFACT_VERIFIER_VERSION ||
    !revisionPattern.test(sourceRevision) ||
    !imageIDPattern.test(imageID) ||
    !/^fukamu-notes-release-verify:[a-z0-9-]+$/u.test(imageReference) ||
    schemaMigrationVersion < 1 ||
    runtimeUser !== '65532:65532' ||
    entrypoint.length !== 1 ||
    entrypoint[0] !== '/notes'
  ) {
    throw new TypeError('release manifest identity is invalid');
  }
  return {
    schemaVersion,
    verifierVersion,
    sourceRevision,
    imageID,
    imageReference,
    schemaMigrationVersion,
    runtimeUser,
    entrypoint,
    notesBinary,
    frontend,
    verifiedRoutes,
    loopbackSmoke,
    networkNoneLifecycles,
    productionTransition,
  };
}

function validateProductionDisabledRouteEvidence(
  routes: readonly ReleaseManifest['verifiedRoutes'][number][],
): void {
  if (routes.length !== EXPECTED_PRODUCTION_DISABLED_ROUTES.length) {
    throw new TypeError('release verified routes are incomplete');
  }
  const seen = new Set<string>();
  const byKey = new Map(
    EXPECTED_PRODUCTION_DISABLED_ROUTES.map((route) => [
      `${route.method} ${route.path}`,
      route,
    ]),
  );
  let notesDigest = '';
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    const expected = byKey.get(key);
    if (expected === undefined || seen.has(key)) {
      throw new TypeError('release verified route set is invalid');
    }
    seen.add(key);
    if (
      route.status !== expected.status ||
      route.bodyKind !== expected.bodyKind ||
      route.contentType !== expected.contentType ||
      route.cacheControl !== expected.cacheControl ||
      route.vary !== expected.vary
    ) {
      throw new TypeError('release verified route result is invalid');
    }
    const fixedBody = fixedReleaseBody(expected.bodyKind);
    if (fixedBody !== undefined && route.bodySha256 !== sha256Text(fixedBody)) {
      throw new TypeError('release verified route body is invalid');
    }
    if (expected.bodyKind === 'notes-html') {
      if (notesDigest === '') notesDigest = route.bodySha256;
      else if (notesDigest !== route.bodySha256) {
        throw new TypeError('release notes fallback body is inconsistent');
      }
    }
  }
}

function fixedReleaseBody(bodyKind: string): string | undefined {
  switch (bodyKind) {
    case 'health-ok':
      return '{"status":"ok"}\n';
    case 'not-ready':
      return '{"status":"not_ready"}\n';
    case 'not-found-code':
      return '{"code":"not_found"}\n';
    case 'launch-unavailable':
      return '{"error":"launch-gate-unavailable"}\n';
    case 'unavailable':
      return '{"error":"unavailable"}\n';
    default:
      return undefined;
  }
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createSpdxDocument(
  sourceRevision: string,
  imageID: string,
  createdAt: string,
  packages: readonly DependencyPackage[],
): Readonly<Record<string, unknown>> {
  if (
    !revisionPattern.test(sourceRevision) ||
    !imageIDPattern.test(imageID) ||
    !isRfc3339Timestamp(createdAt)
  ) {
    throw new TypeError('SPDX provenance is invalid');
  }
  const unique = new Map<string, DependencyPackage>();
  for (const dependency of packages) {
    if (
      (dependency.ecosystem !== 'golang' && dependency.ecosystem !== 'npm') ||
      !validPackageValue(dependency.name) ||
      !validPackageValue(dependency.version) ||
      !validPackageValue(dependency.license)
    ) {
      throw new TypeError('SPDX dependency is invalid');
    }
    unique.set(
      `${dependency.ecosystem}:${dependency.name}@${dependency.version}`,
      dependency,
    );
  }
  const sorted = [...unique.values()].sort(compareDependency);
  const spdxPackages = [
    {
      SPDXID: 'SPDXRef-Package-FukamuNotes',
      name: 'fukamu-notes',
      versionInfo: sourceRevision,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'NOASSERTION',
      supplier: 'NOASSERTION',
    },
    ...sorted.map((dependency, index) => ({
      SPDXID: `SPDXRef-Package-${dependency.ecosystem}-${index + 1}`,
      name: dependency.name,
      versionInfo: dependency.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: dependency.license,
      supplier: 'NOASSERTION',
      externalRefs: [
        {
          referenceCategory: 'PACKAGE-MANAGER',
          referenceType: 'purl',
          referenceLocator: packageURL(dependency),
        },
      ],
    })),
  ];
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: 'fukamu-notes-runtime',
    documentNamespace: `https://github.com/fukamu/notes/releases/sbom/${imageID.slice('sha256:'.length)}`,
    creationInfo: {
      creators: ['Tool: fukamu-notes-release-verifier-2'],
      created: createdAt,
    },
    documentDescribes: ['SPDXRef-Package-FukamuNotes'],
    packages: spdxPackages,
    relationships: sorted.map((dependency, index) => ({
      spdxElementId: 'SPDXRef-Package-FukamuNotes',
      relationshipType: 'DEPENDS_ON',
      relatedSpdxElement: `SPDXRef-Package-${dependency.ecosystem}-${index + 1}`,
    })),
  };
}

export function validateSpdxDocument(candidate: unknown): void {
  const document = record(candidate, 'SPDX document');
  const creationInfo = record(
    document.creationInfo,
    'SPDX creation information',
  );
  if (
    document.spdxVersion !== 'SPDX-2.3' ||
    document.dataLicense !== 'CC0-1.0' ||
    document.SPDXID !== 'SPDXRef-DOCUMENT' ||
    !Array.isArray(document.packages) ||
    document.packages.length < 1 ||
    !Array.isArray(document.relationships) ||
    !Array.isArray(creationInfo.creators) ||
    creationInfo.creators.length !== 1 ||
    creationInfo.creators[0] !== 'Tool: fukamu-notes-release-verifier-2' ||
    typeof creationInfo.created !== 'string' ||
    !isRfc3339Timestamp(creationInfo.created)
  ) {
    throw new TypeError('SPDX document is invalid');
  }
  for (const rawPackage of document.packages) {
    const packageRecord = record(rawPackage, 'SPDX package');
    boundedString(packageRecord.SPDXID, 'SPDX package identifier', 160);
    boundedString(packageRecord.name, 'SPDX package name', 256);
    boundedString(packageRecord.versionInfo, 'SPDX package version', 256);
  }
}

function packageURL(dependency: DependencyPackage): string {
  const ecosystem = dependency.ecosystem === 'golang' ? 'golang' : 'npm';
  const name = dependency.name
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `pkg:${ecosystem}/${name}@${encodeURIComponent(dependency.version)}`;
}

function compareDependency(
  left: DependencyPackage,
  right: DependencyPackage,
): number {
  return `${left.ecosystem}:${left.name}@${left.version}`.localeCompare(
    `${right.ecosystem}:${right.name}@${right.version}`,
  );
}

function validPackageValue(value: string): boolean {
  return (
    value.length > 0 && value.length <= 512 && !containsControlCharacter(value)
  );
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127))
      return true;
  }
  return false;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  label: string,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new TypeError(`${label} contains unexpected fields`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRfc3339Timestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function stringRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, string>> {
  const input = record(value, label);
  const result: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(input)) {
    result[key] = boundedString(candidate, `${label} value`, 512);
  }
  return result;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((candidate) =>
    boundedString(candidate, `${label} value`, 1_024),
  );
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes('\0') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = safeInteger(value, label);
  if (parsed < 1) throw new TypeError(`${label} must be positive`);
  return parsed;
}

function exactBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} is invalid`);
  return value;
}

function digest(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 64);
  if (!sha256Pattern.test(parsed)) throw new TypeError(`${label} is invalid`);
  return parsed;
}

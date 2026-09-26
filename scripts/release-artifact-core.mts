import path from 'node:path';

export const RELEASE_ARTIFACT_SCHEMA_VERSION = 1;
export const RELEASE_ARTIFACT_VERIFIER_VERSION = 1;

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
  }>[];
}>;

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
  const notesBinary = {
    sha256: digest(notesBinaryRecord.sha256, 'release binary digest'),
    bytes: positiveInteger(notesBinaryRecord.bytes, 'release binary bytes'),
  };
  const frontend = {
    sha256: digest(frontendRecord.sha256, 'release frontend digest'),
    files: positiveInteger(frontendRecord.files, 'release frontend files'),
    bytes: positiveInteger(frontendRecord.bytes, 'release frontend bytes'),
  };
  if (
    !Array.isArray(manifest.verifiedRoutes) ||
    manifest.verifiedRoutes.length < 6
  ) {
    throw new TypeError('release verified routes are incomplete');
  }
  const verifiedRoutes = manifest.verifiedRoutes.map((rawRoute) => {
    const route = record(rawRoute, 'release verified route');
    const method = boundedString(route.method, 'release route method', 16);
    const routePath = boundedString(route.path, 'release route path', 256);
    const status = safeInteger(route.status, 'release route status');
    if (
      !/^(?:GET|HEAD|POST)$/u.test(method) ||
      !routePath.startsWith('/') ||
      status < 100 ||
      status > 599
    ) {
      throw new TypeError('release verified route is invalid');
    }
    return { method, path: routePath, status };
  });
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
  };
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
      creators: ['Tool: fukamu-notes-release-verifier-1'],
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
    creationInfo.creators[0] !== 'Tool: fukamu-notes-release-verifier-1' ||
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

function digest(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 64);
  if (!sha256Pattern.test(parsed)) throw new TypeError(`${label} is invalid`);
  return parsed;
}

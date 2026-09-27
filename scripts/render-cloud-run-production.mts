import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type SecretReference = Readonly<{ name: string; version: string }>;

type ProductionValues = Readonly<{
  projectId: string;
  projectNumber: string;
  region: string;
  serviceName: string;
  operationsJobName: string;
  runtimeServiceAccount: string;
  operationsServiceAccount: string;
  runtimeImageDigest: string;
  operationsImageDigest: string;
  publicOrigin: string;
  oidcClientId: string;
  gcsBucket: string;
  kmsKeyVersion: string;
  secrets: Readonly<{
    runtimeDatabaseUrl: SecretReference;
    operationsDatabaseUrl: SecretReference;
    oidcClientSecret: SecretReference;
    cursorHmacKey: SecretReference;
  }>;
}>;

type Arguments = Readonly<{
  valuesPath: string;
  outputDirectory?: string;
  checkOnly: boolean;
}>;

const dnsLabelPattern = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const args = decodeArguments(process.argv.slice(2));
const rawValues: unknown = JSON.parse(await readFile(args.valuesPath, 'utf8'));
const values = decodeProductionValues(rawValues);
const replacements = replacementValues(values);
const templates = [
  ['runtime.service.yaml.tmpl', 'runtime.service.yaml'],
  ['operations.job.yaml.tmpl', 'operations.job.yaml'],
] as const;

const rendered = await Promise.all(
  templates.map(async ([templateName, outputName]) => {
    const template = await readFile(
      path.join(repositoryRoot, 'deploy', 'cloud-run', templateName),
      'utf8',
    );
    return [outputName, render(template, replacements)] as const;
  }),
);

if (args.checkOnly) {
  process.stdout.write(
    `${JSON.stringify({ outcome: 'valid', files: rendered.map(([name]) => name) })}\n`,
  );
} else {
  const outputDirectory = args.outputDirectory;
  if (outputDirectory === undefined) {
    throw new Error('--output is required unless --check is used');
  }
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  for (const [name, source] of rendered) {
    await writeFile(path.join(outputDirectory, name), source, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  }
  process.stdout.write(
    `${JSON.stringify({ outcome: 'rendered', outputDirectory, files: rendered.map(([name]) => name) })}\n`,
  );
}

function decodeArguments(input: readonly string[]): Arguments {
  let valuesPath: string | undefined;
  let outputDirectory: string | undefined;
  let checkOnly = false;
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];
    if (value === '--check') {
      checkOnly = true;
      continue;
    }
    if (value === '--values' || value === '--output') {
      const next = input[index + 1];
      if (next === undefined || next === '' || next.startsWith('--')) {
        throw new Error(`${value} requires one value`);
      }
      if (value === '--values') {
        if (valuesPath !== undefined) throw new Error('--values is duplicated');
        valuesPath = next;
      } else {
        if (outputDirectory !== undefined)
          throw new Error('--output is duplicated');
        outputDirectory = next;
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${value ?? '<missing>'}`);
  }
  if (valuesPath === undefined) throw new Error('--values is required');
  if (checkOnly && outputDirectory !== undefined) {
    throw new Error('--check cannot be combined with --output');
  }
  return outputDirectory === undefined
    ? { valuesPath, checkOnly }
    : { valuesPath, outputDirectory, checkOnly };
}

function decodeProductionValues(value: unknown): ProductionValues {
  const rootKeys = [
    'projectId',
    'projectNumber',
    'region',
    'serviceName',
    'operationsJobName',
    'runtimeServiceAccount',
    'operationsServiceAccount',
    'runtimeImageDigest',
    'operationsImageDigest',
    'publicOrigin',
    'oidcClientId',
    'gcsBucket',
    'kmsKeyVersion',
    'secrets',
  ] as const;
  const record = exactRecord(value, rootKeys, 'production values');
  const projectId = boundedString(
    record,
    'projectId',
    /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u,
  );
  const projectNumber = boundedString(
    record,
    'projectNumber',
    /^[0-9]{6,20}$/u,
  );
  const region = boundedString(record, 'region', /^[a-z]+-[a-z]+[0-9]$/u);
  const serviceName = boundedString(record, 'serviceName', dnsLabelPattern);
  const operationsJobName = boundedString(
    record,
    'operationsJobName',
    dnsLabelPattern,
  );
  if (serviceName === operationsJobName) {
    throw new Error('serviceName and operationsJobName must differ');
  }
  const runtimeServiceAccount = serviceAccount(
    record,
    'runtimeServiceAccount',
    projectId,
  );
  const operationsServiceAccount = serviceAccount(
    record,
    'operationsServiceAccount',
    projectId,
  );
  if (runtimeServiceAccount === operationsServiceAccount) {
    throw new Error('runtime and operations service accounts must differ');
  }
  const runtimeImageDigest = imageDigest(
    record,
    'runtimeImageDigest',
    projectId,
    region,
  );
  const operationsImageDigest = imageDigest(
    record,
    'operationsImageDigest',
    projectId,
    region,
  );
  if (runtimeImageDigest === operationsImageDigest) {
    throw new Error('runtime and operations images must differ');
  }
  const publicOrigin = httpsOrigin(record, 'publicOrigin');
  const oidcClientId = boundedString(
    record,
    'oidcClientId',
    /^[A-Za-z0-9._-]{6,240}\.apps\.googleusercontent\.com$/u,
  );
  const gcsBucket = boundedString(
    record,
    'gcsBucket',
    /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/u,
  );
  const kmsKeyVersion = boundedString(
    record,
    'kmsKeyVersion',
    new RegExp(
      `^projects/${escapePattern(projectId)}/locations/${escapePattern(region)}/keyRings/[A-Za-z0-9_-]{1,63}/cryptoKeys/[A-Za-z0-9_-]{1,63}/cryptoKeyVersions/[1-9][0-9]*$`,
      'u',
    ),
  );
  const secretKeys = [
    'runtimeDatabaseUrl',
    'operationsDatabaseUrl',
    'oidcClientSecret',
    'cursorHmacKey',
  ] as const;
  const secretsRecord = exactRecord(record.secrets, secretKeys, 'secrets');
  const secrets = {
    runtimeDatabaseUrl: secretReference(
      secretsRecord.runtimeDatabaseUrl,
      'runtimeDatabaseUrl',
    ),
    operationsDatabaseUrl: secretReference(
      secretsRecord.operationsDatabaseUrl,
      'operationsDatabaseUrl',
    ),
    oidcClientSecret: secretReference(
      secretsRecord.oidcClientSecret,
      'oidcClientSecret',
    ),
    cursorHmacKey: secretReference(
      secretsRecord.cursorHmacKey,
      'cursorHmacKey',
    ),
  };
  if (secrets.runtimeDatabaseUrl.name === secrets.operationsDatabaseUrl.name) {
    throw new Error('runtime and operations database secrets must differ');
  }
  return {
    projectId,
    projectNumber,
    region,
    serviceName,
    operationsJobName,
    runtimeServiceAccount,
    operationsServiceAccount,
    runtimeImageDigest,
    operationsImageDigest,
    publicOrigin,
    oidcClientId,
    gcsBucket,
    kmsKeyVersion,
    secrets,
  };
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const wantedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== wantedKeys.length ||
    actualKeys.some((key, index) => key !== wantedKeys[index])
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  const result: Record<string, unknown> = {};
  for (const key of expectedKeys) result[key] = Reflect.get(value, key);
  return result;
}

function boundedString(
  record: Record<string, unknown>,
  key: string,
  pattern: RegExp,
): string {
  const value = record[key];
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !pattern.test(value)
  ) {
    throw new Error(`${key} is invalid`);
  }
  return value;
}

function serviceAccount(
  record: Record<string, unknown>,
  key: string,
  projectId: string,
): string {
  return boundedString(
    record,
    key,
    new RegExp(
      `^[a-z][a-z0-9-]{4,29}@${escapePattern(projectId)}\\.iam\\.gserviceaccount\\.com$`,
      'u',
    ),
  );
}

function imageDigest(
  record: Record<string, unknown>,
  key: string,
  projectId: string,
  region: string,
): string {
  return boundedString(
    record,
    key,
    new RegExp(
      `^${escapePattern(region)}-docker\\.pkg\\.dev/${escapePattern(projectId)}/[a-z0-9][a-z0-9._-]{1,254}/[a-z0-9][a-z0-9._/-]{0,254}@sha256:[0-9a-f]{64}$`,
      'u',
    ),
  );
}

function httpsOrigin(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length > 2048)
    throw new Error(`${key} is invalid`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} is invalid`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin !== value
  ) {
    throw new Error(`${key} must be an exact HTTPS origin`);
  }
  return value;
}

function secretReference(value: unknown, label: string): SecretReference {
  const record = exactRecord(value, ['name', 'version'], label);
  const name = boundedString(
    record,
    'name',
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/u,
  );
  const version = boundedString(record, 'version', /^[1-9][0-9]*$/u);
  return { name, version };
}

function replacementValues(
  values: ProductionValues,
): ReadonlyMap<string, string> {
  return new Map([
    ['PROJECT_NUMBER', values.projectNumber],
    ['REGION', values.region],
    ['SERVICE_NAME', values.serviceName],
    ['OPERATIONS_JOB_NAME', values.operationsJobName],
    ['RUNTIME_SERVICE_ACCOUNT', values.runtimeServiceAccount],
    ['OPERATIONS_SERVICE_ACCOUNT', values.operationsServiceAccount],
    ['RUNTIME_IMAGE_DIGEST', values.runtimeImageDigest],
    ['OPERATIONS_IMAGE_DIGEST', values.operationsImageDigest],
    ['PUBLIC_ORIGIN', values.publicOrigin],
    ['OIDC_CLIENT_ID', values.oidcClientId],
    ['GCS_BUCKET', values.gcsBucket],
    ['KMS_KEY_VERSION', values.kmsKeyVersion],
    ['RUNTIME_DATABASE_SECRET_NAME', values.secrets.runtimeDatabaseUrl.name],
    [
      'RUNTIME_DATABASE_SECRET_VERSION',
      values.secrets.runtimeDatabaseUrl.version,
    ],
    [
      'OPERATIONS_DATABASE_SECRET_NAME',
      values.secrets.operationsDatabaseUrl.name,
    ],
    [
      'OPERATIONS_DATABASE_SECRET_VERSION',
      values.secrets.operationsDatabaseUrl.version,
    ],
    ['OIDC_SECRET_NAME', values.secrets.oidcClientSecret.name],
    ['OIDC_SECRET_VERSION', values.secrets.oidcClientSecret.version],
    ['CURSOR_SECRET_NAME', values.secrets.cursorHmacKey.name],
    ['CURSOR_SECRET_VERSION', values.secrets.cursorHmacKey.version],
  ]);
}

function render(
  template: string,
  replacements: ReadonlyMap<string, string>,
): string {
  const templateTokens = [...template.matchAll(/@@([A-Z0-9_]+)@@/gu)].map(
    (match) => match[1],
  );
  const unknown = templateTokens.filter(
    (token): token is string => token !== undefined && !replacements.has(token),
  );
  if (unknown.length > 0)
    throw new Error(`unknown template token: ${unknown.join(',')}`);
  let rendered = template;
  for (const [token, value] of replacements) {
    rendered = rendered.replaceAll(`@@${token}@@`, value);
  }
  if (/@@[A-Z0-9_]+@@/u.test(rendered))
    throw new Error('unresolved template token');
  for (const forbidden of [
    ':latest',
    'key: "latest"',
    'local-fixture',
    'local-signed',
    'NOTES_LOCAL_',
    'NOTES_GCP_KMS_ACCESS_TOKEN',
  ]) {
    if (rendered.includes(forbidden))
      throw new Error(`rendered manifest contains ${forbidden}`);
  }
  return rendered;
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

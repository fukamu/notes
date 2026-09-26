import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specPath = resolve(repositoryRoot, 'contracts/openapi.yaml');
const fixtureRoot = resolve(repositoryRoot, 'contracts/fixtures');
/** @type {Set<string>} */
const requiredProfiles = new Set([
  'account-handler-contracts',
  'billing-handler-current-main',
  'entitlement-offline-lease-v1',
  'envelope-aes-256-gcm-v1',
  'legacy-sync-v1',
  'legacy-sync-v1-rejections',
  'session-core',
  'sync-v2-handler',
  'terms-consent-v1',
]);

const spec = await readFile(specPath, 'utf8');
for (const marker of [
  'openapi: 3.0.3',
  'f423da9932163980485ecc5bc2055b7c8c3b3d8b',
  '/api/sync:',
  '/api/v2/sync:',
  '/api/session-context:',
  '/api/billing/checkout:',
  '/api/account/deletion:',
  'x-fukamu-state: disconnected',
  'x-fukamu-state: connected-local-fixture-production-closed',
  'x-handler-contract: sync-v2',
  'SyncV2Mutation:',
  'propertyName: kind',
  "upsert: '#/components/schemas/SyncV2UpsertMutation'",
  "resolve: '#/components/schemas/SyncV2ResolveMutation'",
  'x-handler-contract: authenticated-session-context',
  'x-handler-contract: billing-cancellation-period-end',
  'x-go-handler: backend/internal/httpapi/billing_cancellation.go',
]) {
  if (!spec.includes(marker))
    throw new Error(`OpenAPI marker missing: ${marker}`);
}

const syncV2Mutation = componentSchema(spec, 'SyncV2Mutation');
const syncV2Upsert = componentSchema(spec, 'SyncV2UpsertMutation');
const syncV2Resolve = componentSchema(spec, 'SyncV2ResolveMutation');
const syncV2Request = componentSchema(spec, 'SyncV2Request');
const legacyServerCard = componentSchema(spec, 'ServerCard');
const legacyConflict = componentSchema(spec, 'Conflict');
const syncV2ServerCard = componentSchema(spec, 'SyncV2ServerCard');
const syncV2Conflict = componentSchema(spec, 'SyncV2Conflict');
const syncV2Change = componentSchema(spec, 'SyncV2Change');
const syncV2Receipt = componentSchema(spec, 'SyncV2MutationReceipt');
assertMarkers('SyncV2Mutation', syncV2Mutation, [
  '#/components/schemas/SyncV2UpsertMutation',
  '#/components/schemas/SyncV2ResolveMutation',
  'propertyName: kind',
]);
assertMarkers('SyncV2UpsertMutation', syncV2Upsert, [
  'additionalProperties: false',
  'nullable: true',
  'minimum: 1',
  'maximum: 2147483647',
  'enum: [upsert]',
  'maxItems: 0',
]);
assertMarkers('SyncV2ResolveMutation', syncV2Resolve, [
  'additionalProperties: false',
  'minimum: 1',
  'maximum: 2147483647',
  'enum: [resolve]',
  'minItems: 1',
  'maxItems: 500',
  'uniqueItems: true',
]);
if (syncV2Resolve.includes('nullable: true')) {
  throw new Error(
    'SyncV2ResolveMutation baseServerRevision must not be nullable',
  );
}
assertMarkers('SyncV2Request', syncV2Request, [
  'mutationId values must be unique within the request',
  "items: { $ref: '#/components/schemas/SyncV2Mutation' }",
]);
assertMarkers('legacy ServerCard', legacyServerCard, [
  'revision: { type: integer, minimum: 1, maximum: 9007199254740991 }',
]);
assertMarkers('legacy Conflict', legacyConflict, [
  'serverRevision: { type: integer, minimum: 1, maximum: 9007199254740991 }',
]);
assertMarkers('SyncV2ServerCard', syncV2ServerCard, [
  'revision: { type: integer, minimum: 1, maximum: 2147483647 }',
]);
assertMarkers('SyncV2Conflict', syncV2Conflict, [
  'serverRevision: { type: integer, minimum: 1, maximum: 2147483647 }',
]);
assertMarkers('SyncV2Change', syncV2Change, [
  "card: { $ref: '#/components/schemas/SyncV2ServerCard' }",
  "conflict: { $ref: '#/components/schemas/SyncV2Conflict' }",
  'revision: { type: integer, minimum: 1, maximum: 2147483647 }',
]);
assertMarkers('SyncV2MutationReceipt', syncV2Receipt, [
  '{ type: integer, minimum: 1, maximum: 2147483647 }',
]);

const files = await jsonFiles(fixtureRoot);
if (files.length === 0) throw new Error('No migration contract fixtures found');
/** @type {Set<string>} */
const profiles = new Set();
/** @type {{ path: string, sha256: string }[]} */
const digests = [];
for (const path of files) {
  const bytes = await readFile(path);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`${relative(repositoryRoot, path)} must not contain a BOM`);
  }
  const source = bytes.toString('utf8');
  /** @type {unknown} */
  const value = JSON.parse(source);
  if (!isRecord(value) || typeof value.profile !== 'string') {
    throw new Error(`${relative(repositoryRoot, path)} must declare profile`);
  }
  if (profiles.has(value.profile)) {
    throw new Error(`Duplicate fixture profile: ${value.profile}`);
  }
  profiles.add(value.profile);
  digests.push({
    path: relative(repositoryRoot, path),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
for (const profile of requiredProfiles) {
  if (!profiles.has(profile))
    throw new Error(`Fixture profile missing: ${profile}`);
}

process.stdout.write(
  `${JSON.stringify({
    openapi: '3.0.3',
    specSha256: createHash('sha256').update(spec).digest('hex'),
    fixtures: digests,
  })}\n`,
);

/**
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function jsonFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  /** @type {string[][]} */
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) return jsonFiles(path);
      return entry.isFile() && entry.name.endsWith('.json') ? [path] : [];
    }),
  );
  return nested.flat().sort();
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
function componentSchema(source, name) {
  const schemasStart = source.indexOf('\n  schemas:\n');
  if (schemasStart < 0) throw new Error('OpenAPI components.schemas missing');
  const marker = `    ${name}:\n`;
  const start = source.indexOf(marker, schemasStart);
  if (start < 0) throw new Error(`OpenAPI component missing: ${name}`);
  const remainder = source.slice(start + marker.length);
  const next = remainder.search(/^    [A-Za-z0-9_-]+:\n/m);
  return next < 0 ? remainder : remainder.slice(0, next);
}

/**
 * @param {string} name
 * @param {string} source
 * @param {readonly string[]} markers
 */
function assertMarkers(name, source, markers) {
  for (const marker of markers) {
    if (!source.includes(marker)) {
      throw new Error(`OpenAPI ${name} invariant missing: ${marker}`);
    }
  }
}

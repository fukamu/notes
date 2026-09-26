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
  '/api/billing/checkout:',
  '/api/account/deletion:',
  'x-fukamu-state: disconnected',
  'x-handler-contract: billing-cancellation-period-end',
  'x-go-handler: backend/internal/httpapi/billing_cancellation.go',
]) {
  if (!spec.includes(marker))
    throw new Error(`OpenAPI marker missing: ${marker}`);
}

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

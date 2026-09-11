import { readFile } from 'node:fs/promises';

const bindingName = 'DB';

/**
 * @param {URL} url
 * @returns {Promise<unknown>}
 */
async function readJson(url) {
  const source = await readFile(url, 'utf8');
  const value = /** @type {unknown} */ (JSON.parse(source));
  return value;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const hosting = await readJson(
  new URL('../.openai/hosting.json', import.meta.url),
);
if (!isRecord(hosting) || hosting.d1 !== bindingName) {
  throw new Error('Sites D1 binding must be DB');
}

const declarations = await readFile(
  new URL('../db/env.d.ts', import.meta.url),
  'utf8',
);
const accessor = await readFile(
  new URL('../db/environment.ts', import.meta.url),
  'utf8',
);
if (!declarations.includes(`${bindingName}: D1Database`)) {
  throw new Error('Cloudflare environment declaration is missing DB');
}
if (!accessor.includes(`D1_BINDING_NAME = '${bindingName}'`)) {
  throw new Error('Runtime D1 accessor binding differs from Sites config');
}

try {
  const wrangler = await readJson(
    new URL('../dist/server/wrangler.json', import.meta.url),
  );
  if (!isRecord(wrangler) || !Array.isArray(wrangler.d1_databases)) {
    throw new Error('Built Wrangler config has no D1 bindings');
  }
  const bindings = wrangler.d1_databases.filter(isRecord);
  if (bindings.length !== 1 || bindings[0]?.binding !== bindingName) {
    throw new Error('Built Wrangler D1 binding differs from Sites config');
  }
} catch (error) {
  if (!isRecord(error) || error.code !== 'ENOENT') throw error;
}

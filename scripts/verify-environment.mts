import { readFile } from 'node:fs/promises';

const publicRoutes = [
  'account/billing',
  'account/privacy',
  'account/terms',
  'checkout',
  'company',
  'legal/commercial-transactions',
  'legal/external-transmission',
  'legal/privacy',
  'legal/terms',
  'pricing',
];

const index = await readFile(
  new URL('../dist/frontend/index.html', import.meta.url),
  'utf8',
);
if (
  !index.includes('<div id="root">') ||
  !index.includes('/assets/') ||
  index.includes('/_next/') ||
  index.includes('__FUKAMU_')
) {
  throw new Error(
    'Static notes shell is incomplete or contains legacy runtime assets',
  );
}

for (const route of publicRoutes) {
  const html = await readFile(
    new URL(`../dist/frontend/${route}/index.html`, import.meta.url),
    'utf8',
  );
  if (
    !html.startsWith('<!doctype html>') ||
    !html.includes('<div id="root"><div') ||
    html.includes('__FUKAMU_')
  ) {
    throw new Error(`Public route ${route} was not prerendered`);
  }
}

const packageSource = await readFile(
  new URL('../package.json', import.meta.url),
  'utf8',
);
const parsedPackage: unknown = JSON.parse(packageSource);
const scripts = decodeScripts(parsedPackage);
if (
  !scripts.build.includes('build:frontend') ||
  scripts.build.includes('vinext build') ||
  scripts.start.includes('wrangler')
) {
  throw new Error(
    'Build/start scripts still depend on the request-time TypeScript runtime',
  );
}

function decodeScripts(
  value: unknown,
): Readonly<{ build: string; start: string }> {
  const scripts =
    value !== null && typeof value === 'object'
      ? getUnknown(value, 'scripts')
      : undefined;
  const build =
    scripts !== null && typeof scripts === 'object'
      ? getUnknown(scripts, 'build')
      : undefined;
  const start =
    scripts !== null && typeof scripts === 'object'
      ? getUnknown(scripts, 'start')
      : undefined;
  if (typeof build !== 'string' || typeof start !== 'string') {
    throw new Error('package.json does not expose string build/start scripts');
  }
  return { build, start };
}

function getUnknown(value: object, property: string): unknown {
  const result: unknown = Reflect.get(value, property);
  return result;
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type PrerenderedRoute = Readonly<{
  pathname: string;
  title: string;
  description: string;
  markup: string;
}>;

type ServerEntry = Readonly<{
  publicRoutePaths(): unknown;
  prerender(pathname: string): unknown;
}>;

const outputRoot = path.resolve('dist/frontend');
const template = await readFile(path.join(outputRoot, 'index.html'), 'utf8');
const imported: unknown = await import(
  pathToFileURL(path.resolve('dist/frontend-server/entry-server.js')).href
);
const serverEntry = decodeServerEntry(imported);
const publicPaths = decodePublicPaths(serverEntry.publicRoutePaths());

for (const pathname of ['/', ...publicPaths]) {
  const rendered = decodePrerenderedRoute(serverEntry.prerender(pathname));
  if (rendered.pathname !== pathname) {
    throw new Error(`Prerendered pathname mismatch for ${pathname}`);
  }
  const html = template
    .replaceAll('__FUKAMU_TITLE__', escapeAttribute(rendered.title))
    .replaceAll('__FUKAMU_DESCRIPTION__', escapeAttribute(rendered.description))
    .replace('<!--FUKAMU_APP-->', rendered.markup);
  const output =
    pathname === '/'
      ? path.join(outputRoot, 'index.html')
      : path.join(outputRoot, pathname.slice(1), 'index.html');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, html);
}

function decodeServerEntry(value: unknown): ServerEntry {
  const publicRoutePaths =
    value !== null && typeof value === 'object'
      ? getUnknown(value, 'publicRoutePaths')
      : undefined;
  const prerender =
    value !== null && typeof value === 'object'
      ? getUnknown(value, 'prerender')
      : undefined;
  if (
    value === null ||
    typeof value !== 'object' ||
    !isUnknownCallable(publicRoutePaths) ||
    !isUnknownCallable(prerender)
  ) {
    throw new Error('SSR build does not expose the prerender contract');
  }
  return {
    publicRoutePaths: () => {
      const result: unknown = publicRoutePaths();
      return result;
    },
    prerender: (pathname) => {
      const result: unknown = prerender(pathname);
      return result;
    },
  };
}

function decodePublicPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('SSR build returned invalid public route paths');
  }
  const paths: string[] = [];
  for (const rawPath of value) {
    const pathValue: unknown = rawPath;
    if (
      typeof pathValue !== 'string' ||
      !pathValue.startsWith('/') ||
      pathValue === '/' ||
      pathValue.endsWith('/')
    ) {
      throw new Error('SSR build returned invalid public route paths');
    }
    paths.push(pathValue);
  }
  return paths;
}

function decodePrerenderedRoute(value: unknown): PrerenderedRoute {
  const pathname =
    value !== null && typeof value === 'object'
      ? getUnknown(value, 'pathname')
      : undefined;
  const title =
    value !== null && typeof value === 'object'
      ? getUnknown(value, 'title')
      : undefined;
  const description =
    value !== null && typeof value === 'object'
      ? getUnknown(value, 'description')
      : undefined;
  const markup =
    value !== null && typeof value === 'object'
      ? getUnknown(value, 'markup')
      : undefined;
  if (
    typeof pathname !== 'string' ||
    typeof title !== 'string' ||
    typeof description !== 'string' ||
    typeof markup !== 'string'
  ) {
    throw new Error('SSR build returned an invalid prerendered route');
  }
  return { pathname, title, description, markup };
}

function getUnknown(value: object, property: string): unknown {
  const result: unknown = Reflect.get(value, property);
  return result;
}

function isUnknownCallable(
  value: unknown,
): value is (...arguments_: unknown[]) => unknown {
  return typeof value === 'function';
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

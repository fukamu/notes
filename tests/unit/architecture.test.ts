import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const roots = ['app', 'components', 'db', 'lib', 'service-worker'];

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(fullPath);
      return /\.(?:ts|tsx|sql)$/.test(entry.name) ? [fullPath] : [];
    }),
  );
  return nested.flat();
}

describe('one-way link architecture', () => {
  it('has no reverse-link API, type, persistence, or UI', async () => {
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/backlink|incoming[_-]?link/i.test(source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });
});

describe('trust-boundary architecture', () => {
  it('does not reintroduce unchecked boundary casts or blanket escapes', async () => {
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const forbidden = [
      /JSON\.parse\([^)]*\)\s+as\s/,
      /await\s+[^;]+\.json\(\)\s+as\s/,
      /\.(?:first|all)<[^>]+>/,
      /\benv\.DB\b/,
      /\bas\s+unknown\s+as\b/,
      /@ts-(?:ignore|expect-error)/,
      /(?:eslint|oxlint)-disable/,
      /\bas\s+(?:SyncRequest|SyncResponse|ServerCard|CardRecord|PendingMutation|ConflictRecord)\b/,
    ];
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (forbidden.some((pattern) => pattern.test(source))) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  it('routes each external boundary through its decoder or guarded adapter', async () => {
    const expectations = [
      ['app/api/sync/handler.ts', 'decodeSyncRequest(await readJson(request))'],
      [
        'app/api/sync/handler.ts',
        'decodeSyncResponse(candidate, input.mutations)',
      ],
      ['db/d1-records.ts', 'parsed = JSON.parse(value)'],
      ['db/d1-sync.ts', 'const input: unknown = await database'],
      ['db/environment.ts', 'getD1Binding(environment: unknown)'],
      ['lib/storage/indexed-db.ts', 'decodeStoredCard'],
      ['lib/storage/indexed-db.ts', 'decodeStoredMutation'],
      ['lib/storage/indexed-db.ts', 'decodeStoredConflict'],
      ['service-worker/sw.ts', 'cacheUrlsFromMessage(event.data)'],
      ['lib/editor/card-link-attributes.ts', 'cardLinkAttributesDecoder'],
    ] as const;
    for (const [file, marker] of expectations) {
      await expect(readFile(file, 'utf8')).resolves.toContain(marker);
    }
  });

  it('enforces every required unsafe rule as an error across all lint targets', async () => {
    const config = await readFile('.oxlintrc.json', 'utf8');
    const requiredRules = [
      'typescript/no-unsafe-assignment',
      'typescript/no-unsafe-argument',
      'typescript/no-unsafe-call',
      'typescript/no-unsafe-member-access',
      'typescript/no-unsafe-return',
      'typescript/no-unnecessary-type-assertion',
      'typescript/no-non-null-assertion',
      'typescript/switch-exhaustiveness-check',
    ];
    for (const rule of requiredRules) {
      expect(config).toContain(`"${rule}": "error"`);
    }

    const packageSource = await readFile('package.json', 'utf8');
    for (const target of ['app', 'api', 'service-worker', 'tooling', 'test']) {
      expect(packageSource).toContain(`lint:${target}`);
    }
  });
});

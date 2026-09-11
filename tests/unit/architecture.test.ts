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

describe('application and presentation architecture', () => {
  it('keeps location and view selection out of the data store', async () => {
    const source = await readFile('lib/client/notes-store.tsx', 'utf8');
    for (const forbidden of [
      'currentCardId',
      'currentCard:',
      'selectCard',
      'setView',
      'NotesView',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('limits store consumption to the composition connector', async () => {
    const files = await sourceFiles('components');
    const violations: string[] = [];
    for (const file of files) {
      if (file === 'components/notes-app.tsx') continue;
      const source = await readFile(file, 'utf8');
      if (/notes-store|useNotesDataStore/.test(source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it('keeps application selectors and controllers independent of renderers', async () => {
    const files = await sourceFiles('lib/application');
    const violations: string[] = [];
    const rendererDependency =
      /(?:react|lucide|tailwind|className|components\/|document\.|window\.|HTMLElement|SVG)/;
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (rendererDependency.test(source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it('keeps the default presentation behind model/actions props', async () => {
    const source = await readFile('components/notes-presentation.tsx', 'utf8');
    expect(source).toContain('model: NotesPresentationModel');
    expect(source).toContain('actions: NotesPresentationActions');
    expect(source).not.toMatch(/notes-store|indexed-db|fetch\(|\/api\//);
    expect(source).toContain('aria-label="表示切り替え"');
    expect(source).toContain('aria-current=');
    expect(source).toContain('aria-label="カード編集"');
  });
});

describe('headless card editor architecture', () => {
  it('keeps editor state and Tiptap lifecycle free of renderer and data infrastructure', async () => {
    const files = [
      'lib/editor/card-editor-state.ts',
      'lib/editor/use-card-editor.ts',
    ];
    const forbidden =
      /(?:@\/components|lucide|tailwind|fukamu-editor|card-link-capsule|notes-store|indexed-db|service-worker|lib\/sync|\/api\/)/;
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      expect(source, file).not.toMatch(forbidden);
    }
  });

  it('constructs the default renderer from typed model and commands only', async () => {
    const source = await readFile('components/body-editor.tsx', 'utf8');
    expect(source).toContain('model: CardEditorModel');
    expect(source).toContain('commands: CardEditorCommands');
    expect(source).not.toMatch(
      /useEditor|StarterKit|CardRecord|notes-store|indexed-db|linkCandidates/,
    );
  });

  it('dispatches card links directly without parent selectors or synthetic clicks', async () => {
    const extension = await readFile(
      'lib/editor/card-link-extension.ts',
      'utf8',
    );
    const presentation = await readFile(
      'components/notes-presentation.tsx',
      'utf8',
    );
    expect(extension).toContain('openCard(targetCardId)');
    expect(extension).not.toMatch(
      /closest\(|parentElement|\.click\(|dispatchEvent|new MouseEvent/,
    );
    expect(presentation).not.toContain('key={card.id}');
  });

  it('separates editor structural hooks from the default visual theme', async () => {
    const css = await readFile('app/globals.css', 'utf8');
    const renderer = await readFile('components/body-editor.tsx', 'utf8');
    expect(css).toContain('.card-editor-structure');
    expect(css).toContain('.card-link-structure');
    expect(css).toContain('.fukamu-editor');
    expect(css).toContain('.card-link-capsule');
    expect(renderer).toContain('card-editor-structure fukamu-editor');
    expect(renderer).toContain('card-link-structure card-link-capsule');
  });
});

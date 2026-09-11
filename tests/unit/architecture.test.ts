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

  it('isolates URL semantics from the browser History API adapter', async () => {
    const codec = await readFile('lib/application/url-navigation.ts', 'utf8');
    const browser = await readFile(
      'lib/client/browser-notes-navigator.ts',
      'utf8',
    );
    const connector = await readFile(
      'lib/client/use-notes-application.ts',
      'utf8',
    );
    const store = await readFile('lib/client/notes-store.tsx', 'utf8');

    expect(codec).toContain('parseNotesPathname');
    expect(codec).toContain('notesLocationPathname');
    expect(codec).not.toMatch(/window\.|history\.|popstate|react/);
    expect(browser).toContain('window.history.pushState');
    expect(browser).toContain('window.history.replaceState');
    expect(browser).toContain("window.addEventListener('popstate'");
    expect(browser).not.toMatch(/notes-store|indexed-db|fetch\(|react/);
    expect(connector).toContain('createBrowserNotesNavigator');
    expect(store).not.toMatch(/pushState|replaceState|popstate|pathname/);
  });

  it('exposes only the documented deep application routes', async () => {
    await expect(readFile('app/(notes)/layout.tsx', 'utf8')).resolves.toContain(
      '<NotesApp />',
    );
    for (const route of [
      'app/(notes)/page.tsx',
      'app/(notes)/history/page.tsx',
      'app/(notes)/cards/[cardId]/page.tsx',
      'app/(notes)/cards/[cardId]/history/page.tsx',
      'app/(notes)/cards/[cardId]/connections/page.tsx',
    ]) {
      await expect(readFile(route, 'utf8')).resolves.toContain('return null');
    }
  });

  it('keeps the default presentation behind model/actions props', async () => {
    const source = await readFile('components/notes-presentation.tsx', 'utf8');
    expect(source).toContain('NotesPresentationProps');
    expect(source).toContain('model,');
    expect(source).toContain('actions,');
    expect(source).toContain('features.renderCardEditor');
    expect(source).toContain('features.renderConnections');
    expect(source).not.toMatch(/notes-store|indexed-db|fetch\(|\/api\//);
    expect(source).not.toMatch(/BodyEditorAdapter|ConnectionsAdapter/);
    expect(source).toContain('aria-label="表示切り替え"');
    expect(source).toContain('aria-current=');
    expect(source).toContain('aria-label="カード編集"');
  });
});

describe('swappable presentation architecture', () => {
  it('keeps connections state and geometry controllers renderer-neutral', async () => {
    const files = [
      'lib/graph/connections-contract.ts',
      'lib/graph/connections-controller.ts',
      'lib/graph/elk-layout.ts',
      'lib/graph/connections-viewport.ts',
    ];
    const forbidden =
      /(?:@\/components|lucide|tailwind|className|document\.|window\.|HTMLElement|SVG(?:Path|Element)|marker|halo|--primary)/;
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      expect(source, file).not.toMatch(forbidden);
    }
  });

  it('joins feature adapters and concrete renderers only at the composition root', async () => {
    const files = await sourceFiles('components');
    const violations: string[] = [];
    for (const file of files) {
      if (file === 'components/notes-app.tsx') continue;
      const source = await readFile(file, 'utf8');
      const importsFeatureAdapter =
        /from ['"]@\/components\/(?:body-editor-adapter|connections-adapter)['"]/.test(
          source,
        );
      const importsConcreteRenderer =
        /from ['"]@\/components\/(?:body-editor|connections-view|notes-presentation)['"]/.test(
          source,
        );
      if (importsFeatureAdapter && importsConcreteRenderer) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);

    const root = await readFile('components/notes-app.tsx', 'utf8');
    for (const dependency of [
      'BodyEditorAdapter',
      'ConnectionsAdapter',
      'NotesPresentation',
      'BodyEditor',
      'ConnectionsView',
    ]) {
      expect(root).toContain(dependency);
    }
  });

  it('keeps every presentation module away from data infrastructure', async () => {
    const files = await sourceFiles('components');
    const violations: string[] = [];
    const infrastructure =
      /(?:from ['"][^'"]*(?:indexed-db|notes-store|lib\/storage|lib\/sync|\/offline|service-worker|app\/api|\/db\/)|fetch\()/;
    for (const file of files) {
      if (file === 'components/notes-app.tsx') continue;
      const source = await readFile(file, 'utf8');
      if (infrastructure.test(source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it('uses one typed card-selection action for ready and fallback connections', async () => {
    const renderer = await readFile('components/connections-view.tsx', 'utf8');
    expect(renderer.match(/actions\.openCard/g)).toHaveLength(2);
    expect(renderer).not.toMatch(/CardRecord|formatDisplayId|visibleTitle/);
  });

  it('keeps renderer-specific SVG assertions out of functional E2E', async () => {
    const e2e = await readFile('tests/e2e/notes.spec.ts', 'utf8');
    expect(e2e).not.toMatch(
      /marker-end|getTotalLength|connection-edge-section|SVGPathElement|data-source-port|data-target-port/,
    );
    expect(e2e).toContain('カード間の一方向リンク一覧');
    expect(e2e).toContain("toHaveAttribute('aria-current', 'true')");
  });

  it('uses semantic warning tokens instead of a fixed conflict palette', async () => {
    const conflict = await readFile('components/conflict-notice.tsx', 'utf8');
    const css = await readFile('app/globals.css', 'utf8');
    expect(conflict).not.toMatch(/amber|bg-white|text-white/);
    expect(css).toContain('--warning-bg');
    expect(css).toContain('.conflict-notice');
  });

  it('keeps the alternate fixture independent and behaviorally exercised', async () => {
    const fixture = await readFile(
      'tests/fixtures/alternate-presentation.ts',
      'utf8',
    );
    expect(fixture).not.toMatch(
      /(?:notes-store|indexed-db|lib\/storage|lib\/sync|offline|service-worker|\/api\/|fetch\(|notes-presentation|body-editor['"]|connections-view)/,
    );
    for (const contract of [
      'createAlternatePresentationProbe',
      'createAlternateCardEditorProbe',
      'createAlternateConnectionsProbe',
      'satisfies NotesAppConfiguration',
    ]) {
      expect(fixture).toContain(contract);
    }
  });

  it('documents every parent requirement and the #6/#7 follow-on seams', async () => {
    const audit = await readFile('docs/presentation-boundary-audit.md', 'utf8');
    for (let requirement = 1; requirement <= 29; requirement += 1) {
      expect(audit).toMatch(new RegExp(`\\|\\s+${requirement}\\s+\\|`));
    }
    expect(audit).toContain(
      '#6 adds the URL/History API implementation of `NotesNavigator`',
    );
    expect(audit).toContain('#7 audits `FUKAMU Notes`/`Notes*`');

    const contracts = await readFile(
      'docs/application-presentation.md',
      'utf8',
    );
    expect(contracts).not.toContain('Temporary adapter exceptions');
    expect(contracts).toContain('NotesAppConfiguration');
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
    expect(source).toContain('CardEditorRendererProps');
    expect(source).toContain('{ model, commands }');
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

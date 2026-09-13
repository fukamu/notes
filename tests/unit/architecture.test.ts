import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const roots = ['app', 'components', 'db', 'lib', 'server', 'service-worker'];

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
      ['lib/storage/indexed-db.ts', 'planSyncResponseApplication'],
      ['lib/client/notes-store.tsx', 'reconcileVisibleCardsAfterSync'],
      ['service-worker/sw.ts', 'workerCommandFromMessage(event.data)'],
      ['server/session-boundary.ts', 'sessionRecordDecoder.decode(candidate)'],
      ['server/oidc-boundary.ts', 'oidcCallbackDecoder.decode(input.callback)'],
      [
        'server/oidc-boundary.ts',
        'pendingOidcTransactionDecoder.decode(rawTransaction)',
      ],
      [
        'server/oidc-boundary.ts',
        'verifiedOidcClaimsDecoder.decode(rawClaims)',
      ],
      ['server/email-otp-boundary.ts', 'emailOtpChallengeDecoder.decode('],
      ['server/email-otp-boundary.ts', 'emailOtpDigestDecoder.decode('],
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

describe('pure-core dependency direction', () => {
  const coreRoots = [
    'lib/domain',
    'lib/sync',
    'lib/application',
    'server/core',
  ];

  it('keeps core imports independent of concrete effect adapters', async () => {
    const files = (await Promise.all(coreRoots.map(sourceFiles))).flat();
    const concreteEffectDependency =
      /from ['"]@\/(?:app|components|db|service-worker)\/|from ['"]@\/lib\/(?:client|storage)\/|from ['"]@\/server\/adapters\//;
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (concreteEffectDependency.test(source)) violations.push(file);
    }

    expect(violations).toEqual([]);
  });

  it('keeps direct runtime effects out of core', async () => {
    const files = (await Promise.all(coreRoots.map(sourceFiles))).flat();
    const directEffect =
      /\b(?:fetch|indexedDB)\s*\(|\b(?:window|document|localStorage|sessionStorage)\.|\bnavigator\.(?:onLine|serviceWorker)|\b(?:Date\.now|Math\.random|crypto\.|uuidv7\s*\()|\bprocess\.env\b|\bconsole\./;
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (directEffect.test(source)) violations.push(file);
    }

    expect(violations).toEqual([]);
  });

  it('keeps UUID generation in the outer client adapter', async () => {
    const domainIds = await readFile('lib/domain/id.ts', 'utf8');
    const generator = await readFile('lib/client/id-generator.ts', 'utf8');

    expect(domainIds).not.toMatch(/uuidv7|create(?:Card|Mutation|Device)Id/);
    expect(generator).toContain('v7 as uuidv7');
    expect(generator).toContain('parseCardId(uuidv7())');
  });

  it('keeps OIDC effects behind ports and derives link ownership from VaultContext', async () => {
    const [core, boundary, webAdapter] = await Promise.all([
      readFile('server/core/oidc.ts', 'utf8'),
      readFile('server/oidc-boundary.ts', 'utf8'),
      readFile('server/adapters/web-oidc.ts', 'utf8'),
    ]);

    expect(core).toContain('decideOidcIdentityResolution');
    expect(core).toContain('establishOidcSession');
    expect(core).not.toMatch(/crypto\.|fetch\(|process\.env|server\/adapters/);
    expect(boundary).toContain('input.vaultContext');
    expect(boundary).not.toMatch(/request\.(?:json|text|formData)\(/);
    expect(webAdapter).toContain('crypto.subtle.digest');
    expect(webAdapter).toContain("'SHA-256'");
  });

  it('keeps Email OTP effects behind ports and never accepts abuse keys from request input', async () => {
    const [core, boundary, fakeAdapter] = await Promise.all([
      readFile('server/core/email-otp.ts', 'utf8'),
      readFile('server/email-otp-boundary.ts', 'utf8'),
      readFile('server/adapters/fake-email-otp.ts', 'utf8'),
    ]);

    expect(core).toContain('verifyEmailOtpChallenge');
    expect(core).toContain('reserveEmailOtpRateLimit');
    expect(core).not.toMatch(/crypto\.|fetch\(|process\.env|server\/adapters/);
    expect(boundary).toContain('input.abuseKeys.deriveKeys');
    expect(boundary).toContain('input.vaultContext');
    expect(boundary).not.toContain('input.rateLimitKeys');
    expect(boundary).not.toMatch(/request\.(?:json|text|formData)\(/);
    expect(fakeAdapter).not.toMatch(/console\.|fetch\(/);
  });

  it('derives Vault database namespaces in pure core and confines IndexedDB to its adapter', async () => {
    const [scope, storage, records, testConfig] = await Promise.all([
      readFile('lib/application/notes-database-scope.ts', 'utf8'),
      readFile('lib/storage/indexed-db.ts', 'utf8'),
      readFile('lib/domain/types.ts', 'utf8'),
      readFile('vitest.config.ts', 'utf8'),
    ]);

    expect(scope).toContain('vaultNotesDatabaseName');
    expect(scope).toContain('DeleteNotesDatabaseResult');
    expect(scope).toContain("case 'legacy':");
    expect(scope).toContain("case 'vault':");
    expect(scope).toContain("{ readonly kind: 'blocked' }");
    expect(scope).not.toMatch(/indexedDB|IDBDatabase|window\.|sessionStorage/);
    expect(storage).toContain('new Map<NotesDatabaseName');
    expect(storage).toContain('DeleteNotesDatabaseResult');
    expect(storage).not.toContain('let databasePromise');
    expect(records).not.toMatch(/accountId|vaultId/);
    expect(testConfig).toContain("'lib/application/notes-database-scope.ts'");
  });

  it('keeps stale operation decisions pure and checks sync authority before repository apply', async () => {
    const [lifecycle, store, testConfig] = await Promise.all([
      readFile('lib/application/notes-operation-lifecycle.ts', 'utf8'),
      readFile('lib/client/notes-store.tsx', 'utf8'),
      readFile('vitest.config.ts', 'utf8'),
    ]);
    const applyIndex = store.indexOf(
      'const merged = await ports.repository.applySyncResponse',
    );
    const guardIndex = store.lastIndexOf(
      'operationIsCurrent(operationLifecycleRef.current, operationToken)',
      applyIndex,
    );

    expect(lifecycle).toContain('decideNotesOperationContinuation');
    expect(lifecycle).toContain("reason: 'scope-changed'");
    expect(lifecycle).toContain("reason: 'operation-epoch-changed'");
    expect(lifecycle).not.toMatch(
      /Promise|react|fetch|indexedDB|window\.|Date\.now|Math\.random|console\./,
    );
    expect(applyIndex).toBeGreaterThan(0);
    expect(guardIndex).toBeGreaterThan(0);
    expect(guardIndex).toBeLessThan(applyIndex);
    expect(testConfig).toContain(
      "'lib/application/notes-operation-lifecycle.ts'",
    );
    expect(testConfig).toContain("'lib/client/notes-store.tsx'");
  });

  it('keeps logout purge decisions pure and production composition independent of its fake progress port', async () => {
    const [core, progress, fake, testConfig] = await Promise.all([
      readFile('lib/application/logout-purge.ts', 'utf8'),
      readFile('lib/application/logout-purge-progress.ts', 'utf8'),
      readFile('lib/client/fake-logout-purge-progress.ts', 'utf8'),
      readFile('vitest.config.ts', 'utf8'),
    ]);
    const productionRoots = ['app', 'components', 'lib/client'];
    const productionFiles = (
      await Promise.all(productionRoots.map(sourceFiles))
    ).flat();
    const fakeConsumers: string[] = [];
    for (const file of productionFiles) {
      if (file === 'lib/client/fake-logout-purge-progress.ts') continue;
      const source = await readFile(file, 'utf8');
      if (source.includes('fake-logout-purge-progress')) {
        fakeConsumers.push(file);
      }
    }

    expect(core).toContain('transitionLogoutPurge');
    expect(core).toContain('decideNotesRuntimePurgeGate');
    expect(core).toContain('logoutPurgeProgressDecoder');
    expect(core).not.toMatch(
      /Promise|BroadcastChannel|indexedDB|caches\.|serviceWorker|new Worker|window\.|document\.|Date\.now|Math\.random|console\./,
    );
    expect(core).not.toMatch(
      /CardRecord|PendingMutation|ConflictRecord|SessionToken/,
    );
    expect(progress).toContain('LogoutPurgeProgressPort');
    expect(progress).toContain('Promise<unknown>');
    expect(fake).toContain('must never be wired into production composition');
    expect(fakeConsumers).toEqual([]);
    expect(testConfig).toContain("'lib/application/logout-purge.ts'");
    expect(testConfig).toContain("'lib/application/logout-purge-progress.ts'");
    expect(testConfig).toContain("'lib/client/fake-logout-purge-progress.ts'");
  });
});

describe('application and presentation architecture', () => {
  it('uses one typed lifecycle as the initialization source of truth', async () => {
    const lifecycle = await readFile(
      'lib/application/initialization-lifecycle.ts',
      'utf8',
    );
    const store = await readFile('lib/client/notes-store.tsx', 'utf8');
    const connector = await readFile(
      'lib/client/use-notes-application.ts',
      'utf8',
    );

    expect(lifecycle).toContain('NotesInitializationLifecycle');
    expect(lifecycle).toContain('transitionNotesInitialization');
    expect(lifecycle).toContain('assertNever');
    expect(store).toContain('useState<NotesInitializationLifecycle>');
    expect(store).not.toMatch(/setInitialized|setInitialSyncComplete/);
    expect(connector).toContain('isInitialSyncComplete(store.initialization)');
  });

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

  it('injects data effects through runtime ports at the composition root', async () => {
    const [ports, store, composition] = await Promise.all([
      readFile('lib/application/notes-runtime.ts', 'utf8'),
      readFile('lib/client/notes-store.tsx', 'utf8'),
      readFile('lib/client/legacy-notes-runtime.ts', 'utf8'),
    ]);

    for (const contract of [
      'NotesRepository',
      'SyncTransport',
      'Clock',
      'IdGenerator',
      'ConnectivityPort',
      'OfflineAppPort',
    ]) {
      expect(ports).toContain(`type ${contract}`);
    }
    expect(store).not.toMatch(
      /indexed-db|id-generator|Date\.now|navigator\.|fetch\(/,
    );
    expect(composition).toContain('LEGACY_NOTES_SCOPE');
    expect(composition).toContain('createIndexedDbNotesRepository');
    expect(composition).toContain('createV1SyncTransport');
    expect(composition).toContain('browserOfflineApp');
  });

  it('exposes only the documented deep application routes', async () => {
    await expect(readFile('app/(notes)/layout.tsx', 'utf8')).resolves.toContain(
      '<LegacyNotesApp />',
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

  it('gates vault runtime construction on authenticated session context', async () => {
    const [gate, app, boundary, requestAdapter] = await Promise.all([
      readFile('components/session-notes-app.tsx', 'utf8'),
      readFile('components/notes-app.tsx', 'utf8'),
      readFile('server/session-boundary.ts', 'utf8'),
      readFile('server/adapters/web-session.ts', 'utf8'),
    ]);

    expect(gate).toContain('planNotesRuntimeLaunch(access)');
    expect(gate).toContain("case 'do-not-start':");
    expect(gate).toContain('createRuntimePorts(context)');
    expect(gate).toContain('scopeMatchesVaultContext');
    expect(app).toContain('function LegacyNotesApp');
    expect(boundary).not.toMatch(/request\.(?:json|text|formData)\(/);
    expect(requestAdapter).toContain("request.headers.get('cookie')");
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

  it('keeps camera geometry pure and browser gesture effects in the hook adapter', async () => {
    const camera = await readFile('lib/graph/connections-viewport.ts', 'utf8');
    const hook = await readFile('hooks/use-connections-viewport.ts', 'utf8');
    const preference = await readFile(
      'lib/client/connections-zoom-preference.ts',
      'utf8',
    );

    expect(camera).toContain('fitConnectionsCamera');
    expect(camera).toContain('pinchConnectionsCamera');
    expect(camera).toContain('ensureConnectionsRectVisible');
    expect(camera).not.toMatch(
      /(?:react|window\.|document\.|PointerEvent|ResizeObserver|HTMLElement)/,
    );
    for (const boundary of [
      'PointerEvent',
      'ResizeObserver',
      'requestAnimationFrame',
      'setPointerCapture',
      'world.style.transform',
    ]) {
      expect(hook).toContain(boundary);
    }
    expect(hook).not.toMatch(/useState|setCamera/);
    expect(hook).toContain('readConnectionsZoomPreference');
    expect(hook).toContain('writeConnectionsZoomPreference');
    expect(preference).toContain('decodeConnectionsCameraScale');
    expect(preference).toContain('storage.getItem');
    expect(preference).toContain('storage.setItem');
  });

  it('keeps curve math pure and recomputes SVG paths only with layout geometry', async () => {
    const path = await readFile('lib/graph/connections-path.ts', 'utf8');
    const renderer = await readFile('components/connections-view.tsx', 'utf8');

    expect(path).toContain('normalizeConnectionsOrthogonalPoints');
    expect(path).toContain('createConnectionsSvgPath');
    expect(path).toContain('`Q ${coordinate');
    expect(path).not.toMatch(
      /(?:react|window\.|document\.|PointerEvent|HTMLElement|SVGPathElement|--primary|--card)/,
    );
    expect(renderer).toContain('const ConnectionsEdgeLayer = memo(');
    expect(renderer).toContain('previous.layoutKey === next.layoutKey');
    expect(renderer).toContain('strokeWidth="8"');
    expect(renderer).toContain("'url(#connection-edge-arrow)'");
    expect(renderer).toContain('aria-label="カード間の一方向リンク一覧"');
  });

  it('isolates the ELK Web Worker and keeps the main-thread engine out of production', async () => {
    const layout = await readFile('lib/graph/elk-layout.ts', 'utf8');
    const controller = await readFile(
      'lib/graph/connections-controller.ts',
      'utf8',
    );
    const hook = await readFile('hooks/use-connections-controller.ts', 'utf8');
    const worker = await readFile(
      'lib/client/connections-layout-worker.ts',
      'utf8',
    );
    const mainThread = await readFile(
      'lib/client/connections-layout-main-thread.ts',
      'utf8',
    );
    const offline = await readFile('lib/client/offline.ts', 'utf8');

    expect(layout).not.toMatch(/elk\.bundled|new Worker|new ElkConstructor/);
    expect(controller).not.toMatch(/connections-layout-worker|elk\.bundled/);
    expect(hook).toContain('layoutConnectionsGraphInWorker');
    expect(worker).toContain('new Worker(connectionsLayoutWorkerUrl)');
    expect(worker).toContain('createBoundedConnectionsLayoutRunner');
    expect(mainThread).toContain('elkjs/lib/elk.bundled.js');
    expect(offline).toContain('connectionsLayoutWorkerUrl');

    const productionFiles = [
      ...(await sourceFiles('app')),
      ...(await sourceFiles('components')),
      ...(await sourceFiles('hooks')),
      ...(await sourceFiles('lib')),
    ].filter((file) => file !== 'lib/client/connections-layout-main-thread.ts');
    const importsMainThreadAdapter: string[] = [];
    for (const file of productionFiles) {
      const source = await readFile(file, 'utf8');
      if (source.includes('connections-layout-main-thread')) {
        importsMainThreadAdapter.push(file);
      }
    }
    expect(importsMainThreadAdapter).toEqual([]);
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

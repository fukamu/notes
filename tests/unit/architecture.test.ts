import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const roots = ['app', 'components', 'frontend', 'lib', 'service-worker'];

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(fullPath);
      return /\.(?:ts|tsx)$/.test(entry.name) ? [fullPath] : [];
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

describe('static frontend delivery architecture', () => {
  it('keeps request-time page delivery on Go and legacy RSC runtimes out of the build', async () => {
    const [packageSource, dockerfile, frontendConfig, goStatic] =
      await Promise.all([
        readFile('package.json', 'utf8'),
        readFile('deploy/Dockerfile', 'utf8'),
        readFile('vite.frontend.config.ts', 'utf8'),
        readFile('backend/internal/httpapi/static.go', 'utf8'),
      ]);
    const packageJson: unknown = JSON.parse(packageSource);
    if (!isRecord(packageJson) || !isRecord(packageJson.scripts)) {
      throw new Error('package.json scripts are invalid');
    }
    expect(packageJson.scripts.build).toContain('build:frontend');
    expect(packageJson.scripts.start).toBe('go -C backend run ./cmd/notes');
    for (const dependenciesKey of ['dependencies', 'devDependencies']) {
      const dependencies = Reflect.get(packageJson, dependenciesKey);
      if (!isRecord(dependencies)) continue;
      for (const removed of [
        'vinext',
        'react-server-dom-webpack',
        '@vitejs/plugin-rsc',
        '@openai/sites-vite-plugin',
        '@cloudflare/vite-plugin',
        '@cloudflare/workers-types',
        'drizzle-kit',
        'drizzle-orm',
        'miniflare',
        'wrangler',
      ]) {
        expect(dependencies).not.toHaveProperty(removed);
      }
    }
    expect(frontendConfig).toContain("outDir: '../dist/frontend'");
    expect(dockerfile).toContain('/source/dist/frontend/ /app/static/');
    expect(goStatic).toContain('notesCardRoute');
    expect(`${packageSource}\n${dockerfile}\n${frontendConfig}`).not.toContain(
      '/_next/',
    );
  });
});

describe('browser contract dependency direction', () => {
  it('keeps browser code independent of legacy backend modules', async () => {
    const browserRoots = [
      'app/(notes)',
      'app/(public)',
      'components',
      'frontend',
      'hooks',
      'lib',
      'service-worker',
    ];
    const files = (await Promise.all(browserRoots.map(sourceFiles))).flat();
    const legacyBackendImport =
      /(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)['"]@\/(?:app\/api|db|server)(?:\/|['"])/u;
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (legacyBackendImport.test(source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

describe('trust-boundary architecture', () => {
  it('does not reintroduce unchecked boundary casts or blanket escapes', async () => {
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const forbidden = [
      /JSON\.parse\([^)]*\)\s+as\s/,
      /await\s+[^;]+\.json\(\)\s+as\s/,
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
      ['lib/storage/indexed-db.ts', 'decodeStoredCards'],
      ['lib/storage/indexed-db.ts', 'decodeStoredMutations'],
      ['lib/storage/indexed-db.ts', 'decodeStoredConflicts'],
      ['lib/storage/indexed-db.ts', 'decodeStoredSyncV2Checkpoint'],
      ['lib/storage/indexed-db.ts', 'planSyncResponseApplication'],
      ['lib/storage/indexed-db.ts', 'planSyncV2ReplicaCommit'],
      ['lib/client/notes-store.tsx', 'reconcileVisibleCardsAfterSync'],
      [
        'lib/client/http-account-deletion.ts',
        'accountDeletionWireStatusDecoder.decode',
      ],
      ['lib/client/http-billing-ui.ts', 'checkoutResponseDecoder.decode'],
      ['lib/client/http-privacy-request.ts', 'responseDecoder.decode'],
      ['lib/client/terms-consent-ui.ts', 'statusResponseDecoder.decode'],
      ['service-worker/sw.ts', 'workerCommandFromMessage(event.data)'],
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
    for (const target of ['app', 'service-worker', 'tooling', 'test']) {
      expect(packageSource).toContain(`lint:${target}`);
    }
    expect(packageSource).toMatch(/"lint:app": "[^"]*\bfrontend\b/);
  });
});

describe('pure-core dependency direction', () => {
  const coreRoots = ['lib/domain', 'lib/sync', 'lib/application'];

  it('keeps core imports independent of concrete effect adapters', async () => {
    const files = (await Promise.all(coreRoots.map(sourceFiles))).flat();
    const concreteEffectDependency =
      /from ['"]@\/(?:app|components|frontend|service-worker)\/|from ['"]@\/lib\/(?:client|storage)\//;
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
    const applyIndex = store.indexOf('ports.repository.applySyncResponse');
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

  it('keeps logout coordination decisions pure and browser effects in one adapter', async () => {
    const [core, runtime, browser, sessionApp, store, testConfig] =
      await Promise.all([
        readFile('lib/application/logout-coordination.ts', 'utf8'),
        readFile('lib/application/logout-runtime-coordination.ts', 'utf8'),
        readFile('lib/client/browser-logout-coordination.ts', 'utf8'),
        readFile('components/session-notes-app.tsx', 'utf8'),
        readFile('lib/client/notes-store.tsx', 'utf8'),
        readFile('vitest.config.ts', 'utf8'),
      ]);

    expect(core).toContain('transitionLogoutPeerRuntime');
    expect(core).toContain('logoutCoordinationMessageDecoder');
    expect(core).not.toMatch(
      /Promise|BroadcastChannel|navigator\.|indexedDB|caches\.|new Worker|window\.|document\.|crypto\.|Date\.now|Math\.random|console\./,
    );
    expect(core).not.toMatch(
      /CardRecord|PendingMutation|ConflictRecord|SessionToken/,
    );
    expect(runtime).toContain('LogoutCoordinationPlatformPort');
    expect(runtime).toContain('createLogoutRuntimeFence');
    expect(runtime).not.toMatch(
      /new BroadcastChannel|navigator\.locks|crypto\.randomUUID|window\.|document\./,
    );
    expect(browser).toContain('new BroadcastChannel(name)');
    expect(browser).toContain('navigator.locks');
    expect(browser).toContain('crypto.randomUUID()');
    expect(sessionApp).toMatch(/runtimeFence\s*\.enter/);
    expect(sessionApp).toContain("current.kind === 'entered'");
    expect(sessionApp).toContain('runtimeFenced={runtimeFenced}');
    expect(store).toContain('useLayoutEffect(() =>');
    expect(store).toContain('stopNotesOperationLifecycle');
    for (const path of [
      'lib/application/logout-coordination.ts',
      'lib/application/logout-runtime-coordination.ts',
      'lib/client/browser-logout-coordination.ts',
    ]) {
      expect(testConfig).toContain(`'${path}'`);
    }
  });

  it('keeps logout purge sequencing provider-neutral and browser deletion effects in adapters', async () => {
    const [runner, browser, progress, serviceWorker, graphWorker, testConfig] =
      await Promise.all([
        readFile('lib/application/logout-purge-runner.ts', 'utf8'),
        readFile('lib/client/browser-logout-purge.ts', 'utf8'),
        readFile('lib/client/browser-logout-purge-progress.ts', 'utf8'),
        readFile('lib/client/browser-service-worker-purge.ts', 'utf8'),
        readFile('lib/client/connections-layout-worker.ts', 'utf8'),
        readFile('vitest.config.ts', 'utf8'),
      ]);

    expect(runner).toContain('createLogoutPurgeRunner');
    expect(runner).toContain('applyLogoutPurgeEvent');
    expect(runner).not.toMatch(
      /indexedDB|caches\.|serviceWorker|new Worker|BroadcastChannel|navigator\.|window\.|document\./,
    );
    expect(browser).toContain('createBrowserLogoutPurgeService');
    expect(browser).toContain('verifyNotesDatabaseDeleted');
    expect(browser).not.toContain('fake-logout-purge-progress');
    expect(progress).toContain('createBrowserLogoutPurgeProgressPort');
    expect(progress).toContain('transaction');
    expect(serviceWorker).toContain('LOGOUT_CACHE_PURGE_RESULT');
    expect(graphWorker).toContain('terminateWorker');
    expect(graphWorker).toContain('resetConnectionsLayoutWorker');
    for (const path of [
      'lib/application/logout-purge-runner.ts',
      'lib/client/browser-logout-purge-progress.ts',
      'lib/client/browser-logout-purge.ts',
      'lib/client/browser-service-worker-purge.ts',
      'lib/client/connections-layout-worker.ts',
    ]) {
      expect(testConfig).toContain(`'${path}'`);
    }
  });

  it('keeps account deletion handoff decisions pure and covered', async () => {
    const [core, runner, testConfig] = await Promise.all([
      readFile('lib/application/account-deletion-handoff.ts', 'utf8'),
      readFile('lib/application/account-deletion-runner.ts', 'utf8'),
      readFile('vitest.config.ts', 'utf8'),
    ]);

    expect(core).toContain('planAccountDeletionStartAccepted');
    expect(core).toContain('accountDeletionUiReducer');
    expect(core).toContain('accountDeletionHandoffDecoder');
    expect(core).not.toMatch(
      /fetch\(|indexedDB|window\.|document\.|crypto\.|Date\.now|Math\.random|console\./,
    );
    expect(runner).toContain('input.logoutPurge.run');
    expect(runner).not.toMatch(
      /fetch\(|indexedDB|window\.|document\.|crypto\.|Date\.now|Math\.random|console\./,
    );
    for (const path of [
      'lib/application/account-deletion-handoff.ts',
      'lib/application/account-deletion-runner.ts',
    ]) {
      expect(testConfig).toContain(`'${path}'`);
    }
  });

  it('keeps account deletion browser effects in explicit covered adapters', async () => {
    const [browser, progress, controlDatabase, http, testConfig] =
      await Promise.all([
        readFile('lib/client/browser-account-deletion.ts', 'utf8'),
        readFile('lib/client/browser-account-deletion-progress.ts', 'utf8'),
        readFile('lib/client/browser-control-database.ts', 'utf8'),
        readFile('lib/client/http-account-deletion.ts', 'utf8'),
        readFile('vitest.config.ts', 'utf8'),
      ]);

    expect(browser).toContain('crypto.getRandomValues');
    expect(browser).toContain('Date.now()');
    expect(progress).toContain('ACCOUNT_DELETION_CONTROL_STORE');
    expect(progress).toContain('sameAccountDeletionGeneration');
    expect(controlDatabase).toContain('LOGOUT_PURGE_CONTROL_STORE');
    expect(controlDatabase).toContain('ACCOUNT_DELETION_CONTROL_STORE');
    expect(http).toContain('accountDeletionWireStatusDecoder.decode');
    expect(http).not.toMatch(/accountId|vaultId/);
    for (const path of [
      'lib/client/browser-account-deletion-progress.ts',
      'lib/client/browser-account-deletion.ts',
      'lib/client/browser-control-database.ts',
      'lib/client/http-account-deletion.ts',
    ]) {
      expect(testConfig).toContain(`'${path}'`);
    }
  });

  it('keeps account deletion UI outside the legacy route and under coverage', async () => {
    const [boundary, sessionApp, notesApp, testConfig] = await Promise.all([
      readFile('components/account-deletion-boundary.tsx', 'utf8'),
      readFile('components/session-notes-app.tsx', 'utf8'),
      readFile('components/notes-app.tsx', 'utf8'),
      readFile('vitest.config.ts', 'utf8'),
    ]);

    expect(boundary).toContain('accountDeletionUiReducer');
    expect(boundary).toContain('AlertDialog');
    expect(boundary).not.toMatch(/fetch\(|indexedDB|caches\.|serviceWorker/);
    expect(sessionApp).toContain('AccountDeletionBoundary');
    expect(notesApp).not.toMatch(/accountDeletion|AccountDeletion/);
    expect(testConfig).toContain(`'components/account-deletion-boundary.tsx'`);
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
    const popstate = await readFile(
      'lib/client/notes-navigation-popstate.ts',
      'utf8',
    );
    const instrumentation = await readFile('instrumentation-client.ts', 'utf8');
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
    expect(browser).toContain('subscribeNotesNavigationPopstate');
    expect(browser).not.toMatch(/notes-store|indexed-db|fetch\(|react/);
    expect(popstate).toContain('window.addEventListener');
    expect(popstate).toContain("'popstate'");
    expect(popstate).not.toMatch(/notes-store|indexed-db|fetch\(|react/);
    expect(instrumentation).toContain('installNotesNavigationPopstateBridge');
    expect(connector).toContain('createBrowserNotesNavigator');
    expect(store).not.toMatch(/pushState|replaceState|popstate|pathname/);
  });

  it('injects data effects through runtime ports at the composition root', async () => {
    const [ports, store, legacyComposition, vaultComposition] =
      await Promise.all([
        readFile('lib/application/notes-runtime.ts', 'utf8'),
        readFile('lib/client/notes-store.tsx', 'utf8'),
        readFile('lib/client/legacy-notes-runtime.ts', 'utf8'),
        readFile('lib/client/vault-notes-runtime.ts', 'utf8'),
      ]);

    for (const contract of [
      'NotesRepository',
      'SyncTransport',
      'NotesSyncRuntime',
      'Clock',
      'IdGenerator',
      'ConnectivityPort',
      'ForegroundResumePort',
      'OfflineAppPort',
    ]) {
      expect(ports).toContain(`type ${contract}`);
    }
    expect(store).not.toMatch(
      /indexed-db|id-generator|Date\.now|navigator\.|fetch\(/,
    );
    expect(legacyComposition).toContain('LEGACY_NOTES_SCOPE');
    expect(legacyComposition).toContain('createIndexedDbNotesRepository');
    expect(legacyComposition).toContain('createV1SyncTransport');
    expect(legacyComposition).toContain('browserOfflineApp');
    expect(legacyComposition).toContain('browserForegroundResume');
    expect(vaultComposition).toContain('vaultNotesScope(context)');
    expect(vaultComposition).toContain(
      'createIndexedDbSyncV2ReplicaRepository',
    );
    expect(vaultComposition).toContain('createV2SyncTransport');
    expect(vaultComposition).toContain('createSyncV2Client');
    expect(vaultComposition).toContain('browserForegroundResume');
  });

  it('keeps Sync v2 replica decisions pure and IndexedDB behind its scoped port', async () => {
    const [core, client, adapter] = await Promise.all([
      readFile('lib/sync/v2-replica.ts', 'utf8'),
      readFile('lib/application/sync-v2-client.ts', 'utf8'),
      readFile('lib/storage/indexed-db.ts', 'utf8'),
    ]);

    expect(core).toContain('type SyncV2ReplicaRepository');
    expect(core).toContain('planSyncV2ReplicaCommit');
    expect(core).not.toMatch(/indexedDB|IDBDatabase|IDBTransaction/);
    expect(client).toContain('type SyncV2Transport');
    expect(client).toContain('planSyncV2Page');
    expect(client).not.toMatch(/fetch\(|indexedDB|IDBDatabase/);
    expect(adapter).toContain('createIndexedDbSyncV2ReplicaRepository');
    expect(adapter).toContain(
      "['cards', 'mutations', 'conflicts', SYNC_V2_STORE_NAME]",
    );
    expect(adapter).toContain('encodeStoredSyncV2Checkpoint');
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

  it('gates vault runtime construction on authenticated Go session context', async () => {
    const [gate, app, boundary, legalHandler] = await Promise.all([
      readFile('components/session-notes-app.tsx', 'utf8'),
      readFile('components/notes-app.tsx', 'utf8'),
      readFile('backend/internal/identity/boundary.go', 'utf8'),
      readFile('backend/internal/httpapi/legal.go', 'utf8'),
    ]);

    expect(gate).toContain('planNotesRuntimeLaunch(access)');
    expect(gate).toContain("case 'do-not-start':");
    expect(gate).toContain('createRuntimePorts(context)');
    expect(gate).toContain('scopeMatchesVaultContext');
    expect(app).toContain('function LegacyNotesApp');
    expect(boundary).toContain('func DeriveVaultContext(');
    expect(boundary).toContain('CookieHeaders');
    expect(legalHandler).toContain('identity.DeriveVaultContext(');
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
      'lib/graph/connections-canvas.ts',
      'lib/graph/connections-viewport.ts',
    ];
    const forbidden =
      /(?:@\/components|lucide|tailwind|className|document\.|window\.|HTMLElement|SVG(?:Path|Element)|CanvasRenderingContext2D|HTMLCanvasElement|Path2D|marker|halo|--primary)/;
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      expect(source, file).not.toMatch(forbidden);
    }
    const visibility = await readFile(
      'lib/graph/connections-visibility.ts',
      'utf8',
    );
    expect(visibility).not.toMatch(
      /(?:react|window\.|document\.|Worker|HTMLElement|performance\.)/,
    );
  });

  it('passes the complete connections graph to the worker-facing controller boundary', async () => {
    const contract = await readFile(
      'lib/graph/connections-contract.ts',
      'utf8',
    );
    const adapter = await readFile(
      'components/connections-adapter.tsx',
      'utf8',
    );
    const view = await readFile('components/connections-view.tsx', 'utf8');

    expect(contract).not.toContain('setSearchQuery');
    expect(contract).not.toContain('searchResults');
    expect(adapter).not.toContain('selectConnectionsStage');
    expect(adapter).not.toContain('key={props.input.currentCardId}');
    expect(view).not.toContain('connections-search');
    expect(adapter).toContain('useConnectionsController(input, presentation)');
    expect(adapter).toContain('totalNodeCount={input.nodes.length}');
    expect(adapter).toContain('totalEdgeCount={input.edges.length}');
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
    expect(hook).not.toMatch(/setCamera/);
    expect(hook).toContain('setVisibilityState');
    expect(hook).toContain('readConnectionsZoomPreference');
    expect(hook).toContain('writeConnectionsZoomPreference');
    expect(preference).toContain('decodeConnectionsCameraScale');
    expect(preference).toContain('storage.getItem');
    expect(preference).toContain('storage.setItem');
  });

  it('keeps curve and arrow math pure and prepares Canvas paths only from layout geometry', async () => {
    const path = await readFile('lib/graph/connections-path.ts', 'utf8');
    const canvas = await readFile('lib/graph/connections-canvas.ts', 'utf8');
    const renderer = await readFile(
      'lib/client/connections-canvas-renderer.ts',
      'utf8',
    );
    const cardRenderer = await readFile(
      'lib/client/connections-card-canvas-renderer.ts',
      'utf8',
    );
    const rasterPlacement = await readFile(
      'lib/graph/connections-raster-cache.ts',
      'utf8',
    );
    const rasterCache = await readFile(
      'lib/client/connections-canvas-raster-cache.ts',
      'utf8',
    );
    const view = await readFile('components/connections-view.tsx', 'utf8');

    expect(path).toContain('normalizeConnectionsOrthogonalPoints');
    expect(path).toContain('createConnectionsSvgPath');
    expect(path).toContain('`Q ${coordinate');
    expect(path).not.toMatch(
      /(?:react|window\.|document\.|PointerEvent|HTMLElement|SVGPathElement|--primary|--card)/,
    );
    expect(canvas).toContain('createConnectionsCanvasArrow');
    expect(canvas).not.toMatch(
      /(?:react|window\.|document\.|Path2D|CanvasRenderingContext2D|HTMLCanvasElement)/,
    );
    expect(renderer).toContain('createConnectionsCanvasEdgeRenderer');
    expect(renderer).toContain('new Path2D(section.d)');
    expect(renderer).toContain('context.stroke(section.path)');
    expect(renderer).toContain('context.fill(section.arrow)');
    expect(cardRenderer).toContain('createConnectionsCanvasCardRenderer');
    expect(cardRenderer).toContain('context.roundRect(');
    expect(cardRenderer).not.toMatch(/(?:react|document\.|PointerEvent)/);
    expect(rasterPlacement).toContain('resolveConnectionsRasterPlacement');
    expect(rasterPlacement).not.toMatch(
      /(?:react|window\.|document\.|HTMLCanvasElement|CanvasRenderingContext2D|performance\.)/,
    );
    expect(rasterCache).toContain("document.createElement('canvas')");
    expect(rasterCache).toContain('destinationContext.drawImage(');
    expect(rasterCache).toContain('back ?? createCanvas()');
    expect(renderer).toContain("mode?: 'direct' | 'bounded-cache'");
    expect(cardRenderer).toContain("mode?: 'direct' | 'bounded-cache'");
    expect(view).toContain('data-testid="connections-edge-canvas"');
    expect(view).not.toContain('ConnectionsSemanticLists');
    expect(view).toContain('data-testid="connections-card-canvas"');
    expect(view).toContain('htmlNodeIndices.map');
    expect(view).not.toContain('model.nodes.map');
    expect(view).not.toContain('<svg');
    expect(view).not.toContain('カード間の一方向リンク一覧');
  });

  it('isolates both layout Web Workers and keeps layout engines off the main thread', async () => {
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
    expect(worker).toContain('new Worker(connectionsCorridorWorkerUrl');
    expect(worker).toContain('createBoundedConnectionsLayoutRunner');
    expect(worker).toContain('createConnectionsLayoutScheduler');
    expect(mainThread).toContain('elkjs/lib/elk.bundled.js');
    expect(offline).toContain('connectionsLayoutWorkerUrl');
    expect(offline).toContain('connectionsCorridorWorkerUrl');

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
    expect(renderer.match(/actions\.openCard/g)).toHaveLength(1);
    expect(renderer).not.toMatch(/CardRecord|formatDisplayId|visibleTitle/);
  });

  it('keeps renderer-specific SVG assertions out of functional E2E', async () => {
    const e2e = await readFile('tests/e2e/notes.spec.ts', 'utf8');
    expect(e2e).not.toMatch(
      /marker-end|getTotalLength|connection-edge-section|SVGPathElement|data-source-port|data-target-port/,
    );
    expect(e2e).toContain("data-total-edge-count', '8'");
    expect(e2e).not.toContain('検索された参照一覧');
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

describe('history preview lookup architecture', () => {
  it('builds one pure lookup per history or conflict selector invocation', async () => {
    const lookup = await readFile(
      'lib/application/card-body-text-lookup.ts',
      'utf8',
    );
    const viewModels = await readFile('lib/application/view-models.ts', 'utf8');
    const controller = await readFile(
      'lib/application/notes-controller.ts',
      'utf8',
    );
    const coverage = await readFile('vitest.config.ts', 'utf8');

    expect(lookup).not.toMatch(
      /(?:React|window|document|indexedDB|fetch\(|Date\.|Math\.random|crypto\.|process\.|console\.)/,
    );
    expect(viewModels).not.toContain("from '@/lib/domain/body'");
    expect(viewModels.match(/createCardBodyTextLookup\(cards\)/g)).toHaveLength(
      2,
    );
    expect(viewModels).toContain(
      'bodyToPlainTextFromLookup(card.body, bodyTextLookup)',
    );
    expect(controller).toContain('selectConflictViewModels(');
    expect(coverage).toContain('lib/application/card-body-text-lookup.ts');
  });
});

describe('headless card editor architecture', () => {
  it('keeps candidate indexing pure and its cache instance-scoped', async () => {
    const index = await readFile(
      'lib/application/card-editor-index.ts',
      'utf8',
    );
    const cache = await readFile(
      'lib/client/card-editor-index-cache.ts',
      'utf8',
    );
    const hook = await readFile('lib/client/use-notes-application.ts', 'utf8');
    const coverage = await readFile('vitest.config.ts', 'utf8');

    expect(index).not.toMatch(
      /(?:React|window|document|indexedDB|fetch\(|Date\.|Math\.random|crypto\.|process\.|console\.)/,
    );
    expect(cache).toContain('@/lib/application/card-editor-index');
    expect(cache).not.toMatch(/^(?:const|let)\s+current\s*=/mu);
    expect(hook).toContain('useState(createCardEditorIndexCache)');
    expect(hook).toContain('cardEditorIndexCache.clear()');
    expect(coverage).toContain('lib/application/card-editor-index.ts');
    expect(coverage).toContain('lib/client/card-editor-index-cache.ts');
  });

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

describe('legal commerce disclosure architecture', () => {
  it('keeps production values fail-closed and legal pages outside the Notes UI', async () => {
    const [
      core,
      adapter,
      script,
      packageSource,
      coverage,
      notes,
      documentation,
    ] = await Promise.all([
      readFile('lib/application/legal-commerce.ts', 'utf8'),
      readFile('lib/environment/legal-commerce.ts', 'utf8'),
      readFile('scripts/verify-legal-commerce.mjs', 'utf8'),
      readFile('package.json', 'utf8'),
      readFile('vitest.config.ts', 'utf8'),
      readFile('components/notes-presentation.tsx', 'utf8'),
      readFile('docs/legal-commerce-disclosure.md', 'utf8'),
    ]);

    expect(core).toContain('decodeLegalCommerceDisclosure');
    expect(core).toContain('resolveLegalCommerceDisclosure');
    expect(core).not.toMatch(
      /process\.env|fetch\(|indexedDB|window\.|document\.|localStorage|console\./,
    );
    expect(adapter).toContain('currentPublicBuildEnvironment()');
    expect(adapter).not.toContain('process.env');
    expect(script).toContain('resolveLegalCommerceDisclosure(process.env)');
    expect(packageSource).toContain('npm run check:legal-commerce');
    expect(packageSource).toContain("'app/(public)'");
    expect(coverage).toContain("'lib/application/legal-commerce.ts'");
    expect(notes).not.toMatch(/legal-fixture|commercial-transactions|特商法/);
    expect(documentation).toContain('do not mount the Notes application');
    expect(documentation).toContain('fails before a deployable build exists');
  });
});

describe('legal terms disclosure architecture', () => {
  it('keeps terms decisions pure, production fail-closed, and content outside Notes', async () => {
    const [core, adapter, script, packageSource, coverage, page, notes, docs] =
      await Promise.all([
        readFile('lib/application/legal-terms.ts', 'utf8'),
        readFile('lib/environment/legal-terms.ts', 'utf8'),
        readFile('scripts/verify-legal-terms.mjs', 'utf8'),
        readFile('package.json', 'utf8'),
        readFile('vitest.config.ts', 'utf8'),
        readFile('app/(public)/legal/terms/page.tsx', 'utf8'),
        readFile('components/notes-presentation.tsx', 'utf8'),
        readFile('docs/legal-terms.md', 'utf8'),
      ]);

    expect(core).toContain('decodeLegalTermsDisclosure');
    expect(core).toContain('evaluateLegalTermsConsistency');
    expect(core).not.toMatch(
      /process\.env|fetch\(|indexedDB|window\.|document\.|localStorage|console\.|Promise/,
    );
    expect(adapter).toContain('currentPublicBuildEnvironment()');
    expect(adapter).not.toContain('process.env');
    expect(script).toContain('evaluateLegalTermsConsistency');
    expect(packageSource).toContain('npm run check:legal-terms');
    expect(coverage).toContain("'lib/application/legal-terms.ts'");
    expect(page).toContain('title="利用規約"');
    expect(page).not.toMatch(/対象年齢|18歳以上/);
    expect(core).not.toMatch(/対象年齢|18歳以上/);
    expect(notes).not.toMatch(/legal\/terms|利用規約/);
    expect(docs).toContain('does not mount the Notes');
    expect(docs).toContain('FUKAMU_LEGAL_TERMS_JSON');
  });
});

describe('terms consent presentation architecture', () => {
  it('keeps consent on dedicated checkout/account routes and correlates evidence without tenant input', async () => {
    const [
      core,
      client,
      checkout,
      account,
      accountPage,
      termsService,
      checkoutService,
      notes,
      coverage,
      documentation,
    ] = await Promise.all([
      readFile('lib/application/terms-consent-ui.ts', 'utf8'),
      readFile('lib/client/terms-consent-ui.ts', 'utf8'),
      readFile('components/billing-checkout-boundary.tsx', 'utf8'),
      readFile('components/terms-consent-boundary.tsx', 'utf8'),
      readFile('app/(public)/account/terms/page.tsx', 'utf8'),
      readFile('backend/internal/legal/terms_service.go', 'utf8'),
      readFile('backend/internal/legal/contract_checkout.go', 'utf8'),
      readFile('components/notes-presentation.tsx', 'utf8'),
      readFile('vitest.config.ts', 'utf8'),
      readFile('docs/terms-consent-ui.md', 'utf8'),
    ]);

    expect(core).toContain('termsConsentUiReducer');
    expect(core).not.toMatch(
      /Promise|fetch\(|indexedDB|window\.|document\.|localStorage|sessionStorage|Date\.now|uuidv7|console\./,
    );
    expect(client).toContain('termsConsentSubmissionIdDecoder.decode');
    expect(client).toContain("credentials: 'same-origin'");
    expect(client).not.toMatch(/accountId|vaultId/);
    expect(checkout).toContain(
      'submissionId: createBillingCheckoutSubmissionId()',
    );
    expect(checkout).toContain(
      'termsSubmissionId: createTermsConsentSubmissionId()',
    );
    expect(checkout).toContain('submissionId: review.termsSubmissionId');
    expect(checkout).toContain("subject: 'subscription'");
    expect(checkout).toContain("subject: 'terms'");
    expect(account).toContain('createLocalTermsConsentUiTransport');
    expect(accountPage).toContain('TermsConsentBoundary');
    expect(termsService).toContain(
      'func (service *TermsConsentService) VerifyCheckout(',
    );
    expect(checkoutService).toContain('application.terms.VerifyCheckout(');
    expect(
      checkoutService.indexOf('application.terms.VerifyCheckout('),
    ).toBeLessThan(checkoutService.indexOf('application.evidence.Confirm('));
    expect(notes).not.toMatch(/terms-consent|account\/terms|利用規約/);
    for (const path of [
      'components/billing-checkout-boundary.tsx',
      'components/terms-consent-boundary.tsx',
      'lib/application/terms-consent-ui.ts',
      'lib/client/terms-consent-ui.ts',
    ]) {
      expect(coverage).toContain(`'${path}'`);
    }
    expect(documentation).toContain('/account/terms');
    expect(documentation).toContain('通常の Notes UI には追加しない');
  });

  it('keeps browser legal contract decoders independent from server modules', async () => {
    const [termsClient, billingClient, termsContract, checkoutContract] =
      await Promise.all([
        readFile('lib/client/terms-consent-ui.ts', 'utf8'),
        readFile('lib/client/http-billing-ui.ts', 'utf8'),
        readFile('lib/contracts/terms-consent.ts', 'utf8'),
        readFile('lib/contracts/contract-checkout.ts', 'utf8'),
      ]);

    expect(termsClient).toContain('@/lib/contracts/terms-consent');
    expect(billingClient).toContain('@/lib/contracts/contract-checkout');
    for (const source of [termsClient, billingClient]) {
      expect(source).not.toMatch(
        /@\/server\/(?:terms-consent|legal-checkout)\//,
      );
    }
    for (const source of [termsContract, checkoutContract]) {
      expect(source).not.toMatch(/@\/server\/|\.\.\/\.\.\/server\//);
    }
  });
});

describe('local Go commerce runtime architecture', () => {
  it('keeps commerce fixture-only, no-network, remote-first, and production-closed', async () => {
    const [
      main,
      server,
      handler,
      provider,
      checkoutBoundary,
      accountBoundary,
      termsClient,
      billingClient,
      fixtureContract,
    ] = await Promise.all([
      readFile('backend/cmd/notes/main.go', 'utf8'),
      readFile('backend/internal/httpapi/server.go', 'utf8'),
      readFile('backend/internal/httpapi/handler.go', 'utf8'),
      readFile('backend/internal/adapters/localcommerce/provider.go', 'utf8'),
      readFile('components/billing-checkout-boundary.tsx', 'utf8'),
      readFile('components/billing-account-boundary.tsx', 'utf8'),
      readFile('lib/client/terms-consent-ui.ts', 'utf8'),
      readFile('lib/client/http-billing-ui.ts', 'utf8'),
      readFile('contracts/fixtures/legal/local-commerce-runtime.json', 'utf8'),
    ]);

    const localCompositionStart = main.indexOf(
      'if configuration.LocalFixture != nil',
    );
    const localCompositionEnd = main.indexOf(
      'composition.private = &httpapi.PrivateRuntime',
      localCompositionStart,
    );
    const localComposition = main.slice(
      localCompositionStart,
      localCompositionEnd,
    );
    expect(localCompositionStart).toBeGreaterThan(-1);
    expect(localCompositionEnd).toBeGreaterThan(localCompositionStart);
    expect(localComposition).toContain('localcommerceadapter.NewProvider');
    expect(localComposition).toContain('composition.legal =');
    expect(localComposition).toContain('composition.billingCancellation =');
    expect(main).toContain(
      'configuration.Environment == config.EnvironmentProduction',
    );
    expect(main).not.toMatch(/adapters\/stripe|stripeadapter\.New/);
    expect(provider).not.toMatch(
      /net\/http|http\.Client|stripe-go|adapters\/stripe|\.Exec\(|\.Append\(/,
    );
    expect(server).toContain('LegalRuntime:');
    expect(server).toContain('BillingCancellationRuntime:');
    expect(handler).toContain('billingCancellationRoute(options)');
    expect(termsClient).toContain(
      "result.kind === 'not-found' ? fallback.loadStatus() : result",
    );
    expect(checkoutBoundary).toContain("remote.kind === 'not-found'");
    expect(accountBoundary).toContain("case 'not-found':");
    expect(billingClient).toContain("literalDecoder('local-confirmed')");
    expect(billingClient).toContain("literalDecoder('cancellation-scheduled')");
    expect(fixtureContract).toContain(
      'local-test-data-not-production-approval',
    );
  });
});

describe('privacy disclosure architecture', () => {
  it('keeps production values fail-closed and the policy outside the Notes UI', async () => {
    const [
      core,
      adapter,
      script,
      packageSource,
      coverage,
      notes,
      page,
      documentation,
    ] = await Promise.all([
      readFile('lib/application/privacy-disclosure.ts', 'utf8'),
      readFile('lib/environment/privacy-disclosure.ts', 'utf8'),
      readFile('scripts/verify-privacy-disclosure.mjs', 'utf8'),
      readFile('package.json', 'utf8'),
      readFile('vitest.config.ts', 'utf8'),
      readFile('components/notes-presentation.tsx', 'utf8'),
      readFile('app/(public)/legal/privacy/page.tsx', 'utf8'),
      readFile('docs/privacy-disclosure.md', 'utf8'),
    ]);

    expect(core).toContain('decodePrivacyDisclosure');
    expect(core).toContain('resolvePrivacyDisclosure');
    expect(core).not.toMatch(
      /process\.env|fetch\(|indexedDB|window\.|document\.|localStorage|console\./,
    );
    expect(adapter).toContain('currentPublicBuildEnvironment()');
    expect(adapter).not.toContain('process.env');
    expect(script).toContain('resolvePrivacyDisclosure(process.env)');
    expect(packageSource).toContain('npm run check:privacy-disclosure');
    expect(packageSource).toContain("'app/(public)'");
    expect(coverage).toContain("'lib/application/privacy-disclosure.ts'");
    expect(page).toContain('title="個人情報保護方針"');
    expect(notes).not.toMatch(/legal\/privacy|個人情報保護方針/);
    expect(documentation).toContain('does not mount the Notes');
    expect(documentation).toContain('fails before');
  });
});

describe('privacy request UI architecture', () => {
  it('keeps the request UI on a dedicated route with a pure core and scoped adapters', async () => {
    const [
      core,
      http,
      local,
      boundary,
      page,
      notes,
      privacyPage,
      documentation,
      coverage,
    ] = await Promise.all([
      readFile('lib/application/privacy-request-ui.ts', 'utf8'),
      readFile('lib/client/http-privacy-request.ts', 'utf8'),
      readFile('lib/client/local-privacy-request.ts', 'utf8'),
      readFile('components/privacy-request-boundary.tsx', 'utf8'),
      readFile('app/(public)/account/privacy/page.tsx', 'utf8'),
      readFile('components/notes-presentation.tsx', 'utf8'),
      readFile('app/(public)/legal/privacy/page.tsx', 'utf8'),
      readFile('docs/privacy-disclosure.md', 'utf8'),
      readFile('vitest.config.ts', 'utf8'),
    ]);

    expect(core).toContain('privacyRequestUiReducer');
    expect(core).toContain('privacyRequestStatusPresentation');
    expect(core).not.toMatch(
      /Promise|fetch\(|indexedDB|window\.|document\.|localStorage|sessionStorage|Date\.now|uuidv7|console\./,
    );
    expect(http).toContain('responseDecoder.decode');
    expect(http).toContain("credentials: 'same-origin'");
    expect(http).not.toMatch(/accountId|vaultId/);
    expect(local).not.toMatch(
      /fetch\(|indexedDB|localStorage|sessionStorage|console\./,
    );
    expect(boundary).toContain('AlertDialog');
    expect(boundary).toContain("source === 'local-fixture'");
    expect(page).toContain('PrivacyRequestBoundary');
    expect(privacyPage).toContain('href="/account/privacy"');
    expect(notes).not.toMatch(/privacyRequest|PrivacyRequest|account\/privacy/);
    expect(documentation).toContain('in-memory only');
    for (const path of [
      'components/privacy-request-boundary.tsx',
      'lib/application/privacy-request-ui.ts',
      'lib/client/http-privacy-request.ts',
      'lib/client/local-privacy-request.ts',
    ]) {
      expect(coverage).toContain(`'${path}'`);
    }
  });
});

describe('privacy processing registry architecture', () => {
  it('keeps inventory decisions typed, provider-neutral, and fail-closed', async () => {
    const [
      domain,
      core,
      adapter,
      script,
      packageSource,
      coverage,
      documentation,
    ] = await Promise.all([
      readFile('lib/domain/privacy-processing.ts', 'utf8'),
      readFile('lib/application/privacy-processing-registry.ts', 'utf8'),
      readFile('lib/environment/privacy-processing-registry.ts', 'utf8'),
      readFile('scripts/verify-privacy-processing-registry.mjs', 'utf8'),
      readFile('package.json', 'utf8'),
      readFile('vitest.config.ts', 'utf8'),
      readFile('docs/privacy-processing-registry.md', 'utf8'),
    ]);

    expect(domain).toContain("'vault-content'");
    expect(domain).toContain("'device-offline-replica'");
    expect(core).toContain('evaluatePrivacyProcessingConsistency');
    expect(core).toContain("kind: 'decision-required'");
    expect(core).not.toMatch(
      /process\.env|fetch\(|indexedDB|window\.|document\.|localStorage|console\./,
    );
    expect(adapter).toContain('currentPublicBuildEnvironment()');
    expect(adapter).not.toContain('process.env');
    expect(script).toContain('evaluatePrivacyProcessingConsistency');
    expect(packageSource).toContain(
      'npm run check:privacy-processing-registry',
    );
    expect(coverage).toContain(
      "'lib/application/privacy-processing-registry.ts'",
    );
    expect(documentation).toContain('does not add AccountId or VaultId');
    expect(documentation).toContain(
      'no PostgreSQL/object-storage/KMS/Stripe operation',
    );
  });
});

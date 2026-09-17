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
      ['lib/storage/indexed-db.ts', 'decodeStoredSyncV2Checkpoint'],
      ['lib/storage/indexed-db.ts', 'planSyncResponseApplication'],
      ['lib/storage/indexed-db.ts', 'planSyncV2ReplicaCommit'],
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
      [
        'app/api/account/terms-consent/handler.ts',
        'termsConsentCommandDecoder.decode(body.value)',
      ],
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
  const coreFiles = [
    'server/account-deletion/core.ts',
    'server/account-deletion/delete-vault-data-core.ts',
    'server/account-deletion/finalize-account-core.ts',
    'server/account-deletion/http-core.ts',
    'server/billing/cancellation-core.ts',
    'server/billing/core.ts',
    'server/crypto/core.ts',
    'server/crypto/rotation-core.ts',
    'server/encrypted-object/core.ts',
    'server/encrypted-object/recovery-core.ts',
    'server/encrypted-object/reencryption-core.ts',
    'server/entitlement/core.ts',
    'server/legal-checkout/checkout-core.ts',
    'server/legal-checkout/core.ts',
    'server/privacy-request/application-core.ts',
    'server/privacy-request/core.ts',
    'server/operations/core.ts',
    'server/quota/core.ts',
    'server/quota/ledger-core.ts',
    'server/sync-v2/core.ts',
    'server/sync-v2/quota-core.ts',
    'server/signup-admission/core.ts',
    'server/terms-consent/application-core.ts',
    'server/terms-consent/core.ts',
  ];

  it('keeps core imports independent of concrete effect adapters', async () => {
    const files = [
      ...(await Promise.all(coreRoots.map(sourceFiles))).flat(),
      ...coreFiles,
    ];
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
    const files = [
      ...(await Promise.all(coreRoots.map(sourceFiles))).flat(),
      ...coreFiles,
    ];
    const directEffect =
      /\b(?:fetch|indexedDB)\s*\(|\b(?:window|document|localStorage|sessionStorage)\.|\bnavigator\.(?:onLine|serviceWorker)|\b(?:Date\.now|Math\.random|crypto\.|uuidv7\s*\()|\bprocess\.env\b|\bconsole\./;
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (directEffect.test(source)) violations.push(file);
    }

    expect(violations).toEqual([]);
  });

  it('keeps GCP Cloud KMS behind the provider-neutral key management port', async () => {
    const [ports, envelopeService, rotationService, gcpAdapter] =
      await Promise.all([
        readFile('server/crypto/ports.ts', 'utf8'),
        readFile('server/crypto/envelope-service.ts', 'utf8'),
        readFile('server/crypto/rotation-service.ts', 'utf8'),
        readFile('server/adapters/gcp-cloud-kms.ts', 'utf8'),
      ]);

    expect(ports).not.toMatch(/GCP|Google|cloudkms/iu);
    expect(envelopeService).not.toMatch(/gcp-cloud-kms|cloudkms/iu);
    expect(rotationService).not.toMatch(/gcp-cloud-kms|cloudkms/iu);
    expect(gcpAdapter).toContain('import type { KeyManagementPort }');
    expect(gcpAdapter).not.toMatch(
      /fake-key-management|console\.|process\.env/u,
    );
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

describe('Identity/Vault control-plane ownership', () => {
  it('keeps private schema, records, migrations, and D1 mutations inside their owner modules', async () => {
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const violations: string[] = [];
    for (const file of files) {
      if (
        file.startsWith('server/control-plane/') ||
        file === 'server/composition/sync-v2.ts' ||
        file.startsWith('server/migrations/')
      ) {
        continue;
      }
      const source = await readFile(file, 'utf8');
      if (
        /server\/control-plane\/(?:core|d1-adapter|d1-schema|migration|records)/.test(
          source,
        ) ||
        /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:accounts|personal_vaults|identities|sessions)\b/i.test(
          source,
        )
      ) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps Account-wide session revocation and finalization pure, public, and tenant-scoped', async () => {
    const [core, publicContract, adapter] = await Promise.all([
      readFile('server/control-plane/core.ts', 'utf8'),
      readFile('server/control-plane/public.ts', 'utf8'),
      readFile('server/control-plane/d1-adapter.ts', 'utf8'),
    ]);
    expect(core).toContain('planAccountSessionRevocation');
    expect(core).toContain('evaluateAccountSessionRevocation');
    expect(core).toContain('evaluateAccountLiveStateFinalization');
    expect(core).not.toMatch(/D1Database|\.prepare\(|Date\.now|fetch\(/);
    expect(publicContract).toContain('type AccountSessionRevocationPort');
    expect(publicContract).toContain('type AccountLiveStateFinalizationPort');
    expect(publicContract).not.toMatch(/D1Database/);
    expect(adapter).toContain('revokeAccountSessions');
    expect(adapter).toContain('plan.command.accountId');
    expect(adapter).toContain('plan.command.vaultId');
    expect(adapter).toContain("revocation_reason = 'security'");
    expect(adapter).toContain('finalizeAccountLiveState');
    expect(adapter).toContain('DELETE FROM identities');
    expect(adapter).toContain('DELETE FROM personal_vaults');
    expect(adapter).toContain('DELETE FROM accounts');
  });

  it('keeps migration planning pure and request handlers free of schema DDL', async () => {
    const [core, runner, sync, handler] = await Promise.all([
      readFile('server/migrations/core.ts', 'utf8'),
      readFile('server/migrations/d1-runner.ts', 'utf8'),
      readFile('db/d1-sync.ts', 'utf8'),
      readFile('app/api/sync/handler.ts', 'utf8'),
    ]);
    expect(core).not.toMatch(
      /D1Database|\.prepare\(|Date\.now|crypto\.|fetch\(/,
    );
    expect(runner).toContain('planMigrations');
    expect(sync).not.toMatch(/CREATE\s+(?:TABLE|INDEX)|ensureSyncSchema/i);
    expect(handler).not.toMatch(/CREATE\s+(?:TABLE|INDEX)|ensureSyncSchema/i);
  });
});

function wrappedKeyBoundaryViolation(file: string, source: string): boolean {
  if (
    file.startsWith('server/crypto/') ||
    file.startsWith('server/migrations/')
  ) {
    return false;
  }
  return (
    /server\/crypto\/(?:d1-finalization|d1-schema|migration)/.test(source) ||
    /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+vault_dek_versions\b/i.test(
      source,
    )
  );
}

describe('Wrapped DEK metadata finalization ownership', () => {
  it('keeps wrapped-key mutations inside crypto and exposes a provider-neutral port', async () => {
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (wrappedKeyBoundaryViolation(file, source)) violations.push(file);
    }
    expect(violations).toEqual([]);

    const [core, publicContract, adapter] = await Promise.all([
      readFile('server/crypto/core.ts', 'utf8'),
      readFile('server/crypto/public.ts', 'utf8'),
      readFile('server/crypto/d1-finalization.ts', 'utf8'),
    ]);
    expect(core).toContain('evaluateVaultWrappedKeyFinalization');
    expect(core).not.toMatch(
      /D1Database|\.prepare\(|Date\.now|fetch\(|Promise/,
    );
    expect(publicContract).toContain('type VaultWrappedKeyFinalizationPort');
    expect(publicContract).not.toMatch(/D1Database|KMS|R2Bucket/);
    expect(adapter).toContain('DELETE FROM vault_dek_versions');
    expect(adapter).toContain('personal_vaults owner');
    expect(adapter).toContain('scope.accountId');
    expect(adapter).toContain('scope.vaultId');
  });

  it('keeps DEK rotation decisions pure and KMS/D1 effects in explicit adapters', async () => {
    const [core, service, adapter, publicContract, testConfig] =
      await Promise.all([
        readFile('server/crypto/rotation-core.ts', 'utf8'),
        readFile('server/crypto/rotation-service.ts', 'utf8'),
        readFile('server/crypto/rotation-d1-adapter.ts', 'utf8'),
        readFile('server/crypto/public.ts', 'utf8'),
        readFile('vitest.config.ts', 'utf8'),
      ]);

    expect(core).toContain('planDekRotationStart');
    expect(core).toContain('planDekRotationGenerated');
    expect(core).toContain('planDekRotationPromotion');
    expect(core).not.toMatch(
      /D1Database|\.prepare\(|Promise|Date\.now|crypto\.|fetch\(|process\.env/,
    );
    expect(service).toContain('keyManagement.generateDataKey');
    expect(service).toContain('generated.key.destroy()');
    expect(adapter).toContain('class D1DekRotationRepository');
    expect(adapter).toContain('scope.accountId');
    expect(adapter).toContain('scope.vaultId');
    expect(publicContract).toContain('createDekRotationService');
    expect(publicContract).not.toMatch(/D1Database|\.prepare\(/);
    expect(testConfig).toContain("'server/**/*.ts'");
  });
});

function accountDeletionBoundaryViolation(
  file: string,
  source: string,
): boolean {
  if (
    file.startsWith('server/account-deletion/') ||
    file.startsWith('server/migrations/')
  ) {
    return false;
  }
  return (
    /server\/account-deletion\/(?:application|cancel-subscription|continuation-migration|core|d1-adapter|d1-schema|delete-private-objects|delete-private-objects-core|delete-vault-data|delete-vault-data-core|finalize-account|finalize-account-core|http-core|migration|records|revoke-sessions|web-credentials)/.test(
      source,
    ) ||
    /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:account_deletion_operations|account_deletion_step_receipts|account_deletion_continuations)\b/i.test(
      source,
    )
  );
}

describe('Account deletion saga ownership', () => {
  it('keeps private state, D1 mutations, and migrations inside their owner module', async () => {
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (accountDeletionBoundaryViolation(file, source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it('keeps sequencing pure, persistence scope-bound, and provider effects out of the foundation', async () => {
    const [
      core,
      publicContract,
      adapter,
      schema,
      migration,
      revokeSessions,
      cancelSubscription,
      deleteVaultDataCore,
      deleteVaultData,
      deletePrivateObjectsCore,
      deletePrivateObjects,
      finalizeAccountCore,
      finalizeAccount,
      testConfig,
    ] = await Promise.all([
      readFile('server/account-deletion/core.ts', 'utf8'),
      readFile('server/account-deletion/public.ts', 'utf8'),
      readFile('server/account-deletion/d1-adapter.ts', 'utf8'),
      readFile('server/account-deletion/d1-schema.ts', 'utf8'),
      readFile('server/account-deletion/migration.ts', 'utf8'),
      readFile('server/account-deletion/revoke-sessions.ts', 'utf8'),
      readFile('server/account-deletion/cancel-subscription.ts', 'utf8'),
      readFile('server/account-deletion/delete-vault-data-core.ts', 'utf8'),
      readFile('server/account-deletion/delete-vault-data.ts', 'utf8'),
      readFile(
        'server/account-deletion/delete-private-objects-core.ts',
        'utf8',
      ),
      readFile('server/account-deletion/delete-private-objects.ts', 'utf8'),
      readFile('server/account-deletion/finalize-account-core.ts', 'utf8'),
      readFile('server/account-deletion/finalize-account.ts', 'utf8'),
      readFile('vitest.config.ts', 'utf8'),
    ]);
    expect(core).toContain('planAccountDeletionStepClaim');
    expect(core).toContain('planAccountDeletionStepResult');
    expect(core).toContain('planAccountDeletionExpiredLeaseRecovery');
    expect(core).not.toMatch(
      /D1Database|\.prepare\(|Date\.now|crypto\.|fetch\(|Promise|R2|KMS|Stripe|indexedDB|window\.|document\./,
    );
    expect(publicContract).toContain('type AccountDeletionRepository');
    expect(publicContract).not.toMatch(/D1Database|R2Bucket|Stripe/);
    expect(adapter).toContain('scope.accountId');
    expect(adapter).toContain('scope.vaultId');
    expect(adapter).toContain('isValidAccountDeletionTransition');
    expect(schema).not.toMatch(/accounts\.accountId|personalVaults/);
    expect(migration).not.toMatch(
      /title|body_json|plaintext|ciphertext|stripe/i,
    );
    expect(revokeSessions).toContain('../control-plane/public');
    expect(revokeSessions).not.toMatch(
      /control-plane\/(?:core|d1-adapter|d1-schema|migration|records)|D1Database|\.prepare\(|Date\.now/,
    );
    expect(cancelSubscription).toContain('../billing/public');
    expect(cancelSubscription).not.toMatch(
      /billing\/(?:cancellation-core|cancellation-service|core|d1-adapter|d1-schema|fake|fake-cancellation|migration|ports|records|service)|D1Database|\.prepare\(|Date\.now|Stripe|fetch\(/,
    );
    expect(deleteVaultDataCore).toContain('planDeleteVaultDataStep');
    expect(deleteVaultDataCore).not.toMatch(
      /D1Database|\.prepare\(|Date\.now|crypto\.|fetch\(|Promise|R2|KMS|Stripe/,
    );
    expect(deleteVaultData).toContain('../encrypted-object/public');
    expect(deleteVaultData).toContain('../vault-content/public');
    expect(deleteVaultData).not.toMatch(
      /(?:encrypted-object|vault-content)\/(?:core|d1-adapter|d1-schema|migration|ports|records|service)|D1Database|\.prepare\(|Date\.now|R2|KMS|Stripe|fetch\(/,
    );
    expect(deletePrivateObjectsCore).toContain('planDeletePrivateObjectsStep');
    expect(deletePrivateObjectsCore).not.toMatch(
      /D1Database|\.prepare\(|Date\.now|crypto\.|fetch\(|Promise|R2|KMS|Stripe/,
    );
    expect(deletePrivateObjects).toContain('../encrypted-object/public');
    expect(deletePrivateObjects).not.toMatch(
      /encrypted-object\/(?:core|d1-adapter|d1-schema|delete-vault-objects|migration|ports|records|service)|D1Database|\.prepare\(|Date\.now|R2|KMS|Stripe|fetch\(/,
    );
    expect(finalizeAccountCore).toContain('planFinalizeAccountStep');
    expect(finalizeAccountCore).toContain(
      'evaluatePrivateObjectReconfirmation',
    );
    expect(finalizeAccountCore).not.toMatch(
      /D1Database|\.prepare\(|Date\.now|crypto\.|fetch\(|Promise|R2|KMS|Stripe/,
    );
    expect(finalizeAccount).toContain('../encrypted-object/public');
    expect(finalizeAccount).toContain('../crypto/public');
    expect(finalizeAccount).toContain('../control-plane/public');
    expect(finalizeAccount).not.toMatch(
      /(?:encrypted-object|crypto|control-plane)\/(?:core|d1-adapter|d1-finalization|d1-schema|migration|ports|records)|D1Database|\.prepare\(|Date\.now|R2|KMS|Stripe|fetch\(/,
    );
    expect(testConfig).toContain("'server/**/*.ts'");
  });

  it('keeps authenticated deletion HTTP decisions pure and production routes fail closed', async () => {
    const [core, application, handler, credentials, startRoute, statusRoute] =
      await Promise.all([
        readFile('server/account-deletion/http-core.ts', 'utf8'),
        readFile('server/account-deletion/application.ts', 'utf8'),
        readFile('app/api/account/deletion/handler.ts', 'utf8'),
        readFile('server/account-deletion/web-credentials.ts', 'utf8'),
        readFile('app/api/account/deletion/route.ts', 'utf8'),
        readFile('app/api/account/deletion/status/route.ts', 'utf8'),
      ]);
    expect(core).toContain('planAccountDeletionContinuationConsume');
    expect(core).toContain('planAccountDeletionRun');
    expect(core).not.toMatch(
      /D1Database|\.prepare\(|Date\.now|crypto\.|fetch\(|Promise|Request|Response/,
    );
    expect(application).toContain('executeRevokeSessionsStep');
    expect(application).toContain("case 'revoke-sessions':");
    expect(application).not.toMatch(/D1Database|\.prepare\(|Date\.now|fetch\(/);
    expect(handler).toContain('deriveVaultContext');
    expect(handler).toContain('accountDeletionStartRequestDecoder.decode');
    expect(handler).not.toMatch(
      /entitlement|accountId:\s*decoded|vaultId:\s*decoded/,
    );
    expect(credentials).toContain('crypto.subtle.sign(');
    expect(credentials).toContain('crypto.subtle.digest(');
    for (const route of [startRoute, statusRoute]) {
      expect(route).toContain('return unavailable(503)');
      expect(route).not.toMatch(/\/fake|createFake|allowAll/);
    }
  });

  it('keeps privacy request HTTP scope session-derived and provider routes fail closed', async () => {
    const [core, application, handler, fake, startRoute, statusRoute] =
      await Promise.all([
        readFile('server/privacy-request/application-core.ts', 'utf8'),
        readFile('server/privacy-request/application.ts', 'utf8'),
        readFile('app/api/account/privacy-requests/handler.ts', 'utf8'),
        readFile('server/privacy-request/fake.ts', 'utf8'),
        readFile('app/api/account/privacy-requests/route.ts', 'utf8'),
        readFile('app/api/account/privacy-requests/status/route.ts', 'utf8'),
      ]);
    expect(core).toContain('privacyRequestSubmitCommandDecoder');
    expect(core).toContain('privacyRequestPublicStatus');
    expect(core).not.toMatch(
      /D1Database|\.prepare\(|Promise|Date\.now|crypto\.|fetch\(|\b(?:Request|Response)\b/,
    );
    expect(application).toContain('startExistingAccountDeletionSaga');
    expect(application).not.toMatch(
      /D1Database|\.prepare\(|Date\.now|fetch\(|account-deletion\/(?:core|d1-adapter|migration)/,
    );
    expect(handler).toContain('deriveVaultContext');
    expect(handler).toContain('privacyRequestScope(session.context)');
    expect(handler).toContain('privacyRequestSubmitCommandDecoder.decode');
    expect(handler).not.toMatch(
      /entitlement|accountId:\s*decoded|vaultId:\s*decoded/,
    );
    expect(fake).not.toMatch(/D1Database|process\.env|fetch\(/);
    for (const route of [startRoute, statusRoute]) {
      expect(route).toContain("mode.mode === 'legacy-test' ? 404 : 503");
      expect(route).not.toMatch(/privacy-request\/fake|createFake|allowAll/);
    }
  });
});

describe('Vault-scoped server repository ownership', () => {
  it('keeps Vault content tables and D1 mutations inside their owner module', async () => {
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const violations: string[] = [];
    for (const file of files) {
      if (
        file.startsWith('server/vault-content/') ||
        file === 'server/composition/sync-v2.ts' ||
        file.startsWith('server/migrations/')
      ) {
        continue;
      }
      const source = await readFile(file, 'utf8');
      if (
        /server\/vault-content\/(?:core|d1-adapter|d1-schema|migration|records)/.test(
          source,
        ) ||
        /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:vault_partition_mappings|vault_cards|vault_mutation_receipts|vault_conflicts|vault_sync_v2_states|vault_card_display_ids|vault_sync_v2_commits|vault_sync_v2_changes)\b/i.test(
          source,
        )
      ) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps routing and CAS plans pure and content operations scope-bound', async () => {
    const [core, publicContract, adapter, records] = await Promise.all([
      readFile('server/vault-content/core.ts', 'utf8'),
      readFile('server/vault-content/public.ts', 'utf8'),
      readFile('server/vault-content/d1-adapter.ts', 'utf8'),
      readFile('server/vault-content/records.ts', 'utf8'),
    ]);
    expect(core).not.toMatch(
      /D1Database|\.prepare\(|Date\.now|crypto\.|fetch\(|Promise/,
    );
    expect(publicContract).toContain('open(context: VaultContext)');
    expect(publicContract).toContain('type VaultContentRepository');
    expect(publicContract).toContain('type VaultLiveDataPurgePort');
    expect(publicContract).not.toMatch(
      /findCard\([^)]*(?:VaultId|VaultContext)|compareAndSwapCard\([^)]*(?:VaultId|VaultContext)|deleteCard\([^)]*(?:VaultId|VaultContext)/,
    );
    expect(adapter).toContain('class D1ScopedVaultContentRepository');
    expect(adapter).toContain('this.context.vaultId');
    expect(adapter).toContain('this.route.routingRevision');
    expect(adapter).toContain('purgeVaultLiveData');
    expect(adapter).toContain('NOT EXISTS');
    expect(adapter).not.toMatch(
      /DELETE\s+FROM\s+(?:vault_encrypted_objects|vault_encrypted_write_intents)/i,
    );
    expect(adapter).toContain("return { kind: 'not-found' }");
    expect(records).toContain('partitionRouteRowDecoder');
    expect(records).toContain('mapMutationReceiptRow');
  });

  it('keeps Sync v2 journal planning pure and payload storage outside its D1 contract', async () => {
    const [core, publicContract, adapter, schema, testConfig] =
      await Promise.all([
        readFile('server/vault-content/sync-v2-core.ts', 'utf8'),
        readFile('server/vault-content/sync-v2-public.ts', 'utf8'),
        readFile('server/vault-content/sync-v2-d1-adapter.ts', 'utf8'),
        readFile('server/vault-content/sync-v2-d1-schema.ts', 'utf8'),
        readFile('vitest.config.ts', 'utf8'),
      ]);
    expect(core).toContain('planSyncV2JournalCommit');
    expect(core).not.toMatch(
      /D1Database|\.prepare\(|Date\.now|crypto\.|fetch\(|Promise/,
    );
    expect(publicContract).toContain('type SyncV2JournalRepository');
    expect(publicContract).not.toMatch(
      /D1Database|R2|KMS|KeyManagement|EncryptedObjectService|title|body/,
    );
    expect(adapter).toContain('class D1ScopedSyncV2JournalRepository');
    expect(adapter).toContain('this.context.vaultId');
    expect(adapter).toContain('this.route.routingRevision');
    expect(adapter).not.toMatch(
      /encrypted-object|KeyManagement|R2|KMS|plaintext|ciphertext/,
    );
    expect(schema).toContain('vaultSyncV2Changes');
    expect(testConfig).toContain("'server/**/*.ts'");
  });
});

function encryptedObjectBoundaryViolation(
  file: string,
  source: string,
): boolean {
  if (
    file.startsWith('server/encrypted-object/') ||
    file.startsWith('server/migrations/')
  ) {
    return false;
  }
  return (
    /server\/encrypted-object\/(?:core|d1-adapter|d1-schema|migration|ports|records|service)/.test(
      source,
    ) ||
    /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:vault_encrypted_objects|vault_encrypted_write_intents|vault_object_delete_outbox)\b/i.test(
      source,
    )
  );
}

describe('Encrypted object metadata ownership', () => {
  it('keeps metadata and outbox mutations inside the encrypted-object module', async () => {
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (encryptedObjectBoundaryViolation(file, source)) violations.push(file);
    }
    expect(violations).toEqual([]);
    expect(
      encryptedObjectBoundaryViolation(
        'server/account-deletion/delete-vault-data.ts',
        'DELETE FROM vault_encrypted_objects WHERE vault_id = ?',
      ),
    ).toBe(true);
  });

  it('exposes only provider-neutral purge ports and keeps D1/storage effects inside the owner module', async () => {
    const [core, publicContract, adapter, deletionService] = await Promise.all([
      readFile('server/encrypted-object/core.ts', 'utf8'),
      readFile('server/encrypted-object/public.ts', 'utf8'),
      readFile('server/encrypted-object/d1-adapter.ts', 'utf8'),
      readFile('server/encrypted-object/delete-vault-objects.ts', 'utf8'),
    ]);
    expect(core).toContain('evaluateEncryptedObjectMetadataPurge');
    expect(core).toContain('evaluateVaultPrivateObjectPurge');
    expect(core).toContain('evaluateVaultPrivateObjectDeletionBarrier');
    expect(core).toContain('planVaultPrivateObjectPurgeAttempt');
    expect(core).not.toMatch(
      /D1Database|\.prepare\(|Date\.now|fetch\(|Promise|R2Bucket|KMS/,
    );
    expect(publicContract).toContain('type EncryptedObjectMetadataPurgePort');
    expect(publicContract).toContain('type VaultPrivateObjectPurgePort');
    expect(publicContract).toContain(
      'type VaultPrivateObjectDeletionBarrierPort',
    );
    expect(publicContract).not.toMatch(/D1Database|R2Bucket|Stripe|objectKey/);
    expect(adapter).toContain('D1EncryptedObjectMetadataPurge');
    expect(adapter).toContain('INSERT INTO vault_object_delete_outbox');
    expect(adapter).toContain('DELETE FROM vault_encrypted_objects');
    expect(adapter).toContain('DELETE FROM vault_encrypted_write_intents');
    expect(adapter).toContain('D1VaultObjectDeleteOutboxDirectory');
    expect(adapter).toContain('D1VaultPrivateObjectDeletionBarrier');
    expect(adapter).toContain('personal_vaults owner');
    expect(deletionService).toContain('createVaultPrivateObjectPurge');
    expect(deletionService).toContain(
      'command.scope.accountId === input.scope.accountId',
    );
    expect(deletionService).toContain('input.objects.delete');
    expect(deletionService).not.toMatch(
      /D1Database|\.prepare\(|Date\.now|R2Bucket|fetch\(/,
    );
  });
});

function billingBoundaryViolation(file: string, source: string): boolean {
  if (
    file.startsWith('server/billing/') ||
    file === 'server/composition/sync-v2.ts' ||
    file.startsWith('server/migrations/')
  ) {
    return false;
  }
  return (
    /(?:(?:@\/)?server\/billing|(?:\.\.?\/)+billing)\/(?:cancellation-core|cancellation-service|core|d1-adapter|d1-schema|fake|fake-cancellation|migration|ports|records|service)/.test(
      source,
    ) ||
    /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:billing_subscriptions|billing_checkout_intents|billing_provider_event_receipts|billing_reconciliation_checkpoints)\b/i.test(
      source,
    )
  );
}

function quotaLedgerBoundaryViolation(file: string, source: string): boolean {
  if (
    file.startsWith('server/quota/') ||
    file === 'server/composition/sync-v2.ts' ||
    file.startsWith('server/migrations/')
  ) {
    return false;
  }
  return (
    /(?:(?:@\/)?server\/quota|(?:\.\.?\/)+quota)\/(?:d1-adapter|d1-schema|migration|records)/.test(
      source,
    ) ||
    /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:vault_quota_usage|vault_quota_reservations)\b/i.test(
      source,
    )
  );
}

describe('Vault quota ledger module ownership', () => {
  it('keeps D1 internals and table mutations inside the quota module', async () => {
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (quotaLedgerBoundaryViolation(file, source)) violations.push(file);
    }
    expect(violations).toEqual([]);

    const [core, publicContract, adapter] = await Promise.all([
      readFile('server/quota/ledger-core.ts', 'utf8'),
      readFile('server/quota/public.ts', 'utf8'),
      readFile('server/quota/d1-adapter.ts', 'utf8'),
    ]);
    expect(core).not.toMatch(
      /D1Database|\.prepare\(|Promise|Date\.now|crypto\.|fetch\(|process\.env/,
    );
    expect(publicContract).not.toMatch(/D1Database|\.prepare\(/);
    expect(adapter).toContain('this.scope.accountId');
    expect(adapter).toContain('this.scope.vaultId');
    expect(adapter).not.toMatch(/CREATE\s+(?:TABLE|INDEX|TRIGGER)/i);
  });
});

describe('Billing module ownership', () => {
  it('keeps Billing internals and table mutations inside their owner module', async () => {
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (billingBoundaryViolation(file, source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it('detects representative private imports and direct writes without leaving a violation', () => {
    expect(
      billingBoundaryViolation(
        'server/entitlement/read.ts',
        "import type { BillingSubscriptionRecord } from '../billing/records'",
      ),
    ).toBe(true);
    expect(
      billingBoundaryViolation(
        'app/api/billing/handler.ts',
        "UPDATE billing_subscriptions SET status = 'active'",
      ),
    ).toBe(true);
    expect(
      billingBoundaryViolation(
        'server/entitlement/read.ts',
        "import type { BillingApi } from '../billing/public'",
      ),
    ).toBe(false);
  });

  it('exposes provider-neutral facts while keeping effects in explicit adapters', async () => {
    const [
      core,
      cancellationCore,
      publicContract,
      service,
      cancellationService,
      adapter,
      fake,
      fakeCancellation,
      testConfig,
    ] = await Promise.all([
      readFile('server/billing/core.ts', 'utf8'),
      readFile('server/billing/cancellation-core.ts', 'utf8'),
      readFile('server/billing/public.ts', 'utf8'),
      readFile('server/billing/service.ts', 'utf8'),
      readFile('server/billing/cancellation-service.ts', 'utf8'),
      readFile('server/billing/d1-adapter.ts', 'utf8'),
      readFile('server/billing/fake.ts', 'utf8'),
      readFile('server/billing/fake-cancellation.ts', 'utf8'),
      readFile('vitest.config.ts', 'utf8'),
    ]);
    expect(core).toContain('planVerifiedProviderFact');
    expect(core).toContain('planReconciliationSnapshot');
    expect(core).not.toMatch(
      /D1Database|\.prepare\(|Date\.now|crypto\.|fetch\(|Promise/,
    );
    expect(cancellationCore).toContain('planSubscriptionCancellation');
    expect(cancellationCore).toContain(
      'evaluateProviderSubscriptionCancellation',
    );
    expect(cancellationCore).not.toMatch(
      /D1Database|\.prepare\(|Date\.now|crypto\.|fetch\(|Promise|Stripe/,
    );
    expect(publicContract).toContain('type BillingApi');
    expect(publicContract).toContain('type SubscriptionCancellationPort');
    expect(publicContract).toContain('invoice-payment-action-required');
    expect(publicContract).not.toMatch(
      /Stripe|D1Database|BillingSubscriptionRow/,
    );
    expect(service).toContain('createBillingApi');
    expect(service).not.toMatch(/\.prepare\(|process\.env|fetch\(/);
    expect(cancellationService).toContain('createSubscriptionCancellationPort');
    expect(cancellationService).not.toMatch(
      /\.prepare\(|process\.env|Stripe|Date\.now/,
    );
    expect(adapter).toContain('createD1BillingApi');
    expect(adapter).toContain('controlPlane.findPersonalAccount');
    expect(fake).toContain('createFakeBillingModule');
    expect(fake).not.toMatch(/process\.env|D1Database|fetch\(/);
    expect(fakeCancellation).toContain(
      'createFakeSubscriptionCancellationProvider',
    );
    expect(fakeCancellation).not.toMatch(
      /process\.env|D1Database|fetch\(|Stripe/,
    );
    expect(testConfig).toContain("'server/**/*.ts'");
  });
});

function legalCheckoutBoundaryViolation(file: string, source: string): boolean {
  if (
    file.startsWith('server/legal-checkout/') ||
    file.startsWith('server/migrations/')
  ) {
    return false;
  }
  return (
    /(?:(?:@\/)?server\/legal-checkout|(?:\.\.?\/)+legal-checkout)\/(?:checkout-core|checkout-service|core|d1-adapter|d1-schema|fake|migration|records|service|web-crypto-hash)/.test(
      source,
    ) ||
    /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+contract_evidence\b/i.test(source)
  );
}

function appendOnlyLegalEvidenceMutationViolation(source: string): boolean {
  return (
    /\bUPDATE\s+(?:contract_evidence|terms_consent_evidence)\s+SET\b/i.test(
      source,
    ) ||
    /\bDELETE\s+FROM\s+(?:contract_evidence|terms_consent_evidence)\b/i.test(
      source,
    )
  );
}

describe('Legal evidence append-only boundary', () => {
  it('rejects direct UPDATE or DELETE statements across application source', async () => {
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (appendOnlyLegalEvidenceMutationViolation(source)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  it('detects representative mutations and keeps repositories append/read-only', async () => {
    expect(
      appendOnlyLegalEvidenceMutationViolation(
        'UPDATE contract_evidence SET confirmed_at = 1',
      ),
    ).toBe(true);
    expect(
      appendOnlyLegalEvidenceMutationViolation(
        'DELETE FROM terms_consent_evidence WHERE account_id = ?',
      ),
    ).toBe(true);
    expect(
      appendOnlyLegalEvidenceMutationViolation(
        'INSERT INTO contract_evidence(account_id) VALUES (?)',
      ),
    ).toBe(false);

    const [contractPublic, contractAdapter, termsPublic, termsAdapter] =
      await Promise.all([
        readFile('server/legal-checkout/public.ts', 'utf8'),
        readFile('server/legal-checkout/d1-adapter.ts', 'utf8'),
        readFile('server/terms-consent/public.ts', 'utf8'),
        readFile('server/terms-consent/d1-adapter.ts', 'utf8'),
      ]);
    for (const repositoryContract of [contractPublic, termsPublic]) {
      expect(repositoryContract).not.toMatch(
        /\b(?:update|delete|remove|replace|upsert)\s*\(/i,
      );
    }
    for (const adapter of [contractAdapter, termsAdapter]) {
      expect(appendOnlyLegalEvidenceMutationViolation(adapter)).toBe(false);
      expect(adapter).toMatch(/INSERT\s+INTO/i);
      expect(adapter).toMatch(/SELECT\s+/i);
    }
  });
});

describe('Contract evidence module ownership', () => {
  it('keeps private persistence and hashing adapters inside their owner module', async () => {
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (legalCheckoutBoundaryViolation(file, source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it('detects private imports and direct writes while allowing the public contract', () => {
    expect(
      legalCheckoutBoundaryViolation(
        'app/api/billing/checkout.ts',
        "import { createContractEvidenceService } from '../../../server/legal-checkout/service'",
      ),
    ).toBe(true);
    expect(
      legalCheckoutBoundaryViolation(
        'app/api/billing/checkout.ts',
        'INSERT INTO contract_evidence(account_id) VALUES (?)',
      ),
    ).toBe(true);
    expect(
      legalCheckoutBoundaryViolation(
        'app/api/billing/checkout.ts',
        "import type { ContractEvidenceService } from '../../../server/legal-checkout/public'",
      ),
    ).toBe(false);
  });

  it('derives authoritative terms in pure core and scopes append-only evidence by Vault', async () => {
    const [
      core,
      checkoutCore,
      publicContract,
      service,
      checkoutService,
      adapter,
      fake,
      hasher,
      production,
    ] = await Promise.all([
      readFile('server/legal-checkout/core.ts', 'utf8'),
      readFile('server/legal-checkout/checkout-core.ts', 'utf8'),
      readFile('server/legal-checkout/public.ts', 'utf8'),
      readFile('server/legal-checkout/service.ts', 'utf8'),
      readFile('server/legal-checkout/checkout-service.ts', 'utf8'),
      readFile('server/legal-checkout/d1-adapter.ts', 'utf8'),
      readFile('server/legal-checkout/fake.ts', 'utf8'),
      readFile('server/legal-checkout/web-crypto-hash.ts', 'utf8'),
      readFile('server/migrations/production.ts', 'utf8'),
    ]);
    expect(core).toContain('planContractOffer');
    expect(core).toContain('planContractEvidence');
    expect(core).not.toMatch(
      /D1Database|\.prepare\(|Promise|Date\.now|crypto\.|fetch\(|process\.env/,
    );
    expect(checkoutCore).toContain('planContractHostedCheckout');
    expect(checkoutCore).not.toMatch(
      /D1Database|\.prepare\(|Promise|Date\.now|crypto\.|fetch\(|process\.env/,
    );
    expect(publicContract).toContain('type ContractEvidenceService');
    expect(publicContract).toContain('type ContractEvidenceRepository');
    expect(publicContract).not.toMatch(/D1Database|Stripe|Checkout\.Session/);
    expect(service).not.toMatch(
      /D1Database|\.prepare\(|Date\.now|fetch\(|process\.env/,
    );
    expect(checkoutService).toContain('createContractCheckoutApplication');
    expect(checkoutService).not.toMatch(
      /D1Database|\.prepare\(|Date\.now|fetch\(|process\.env|stripe\/(?:core|service|ports)/,
    );
    expect(adapter).toContain('record.scope.accountId');
    expect(adapter).toContain('record.scope.vaultId');
    expect(adapter).toContain('WHERE account_id = ? AND vault_id = ?');
    expect(adapter).not.toMatch(/CREATE\s+(?:TABLE|INDEX|TRIGGER)/i);
    expect(fake).not.toMatch(/D1Database|process\.env|fetch\(/);
    expect(hasher).toContain('subtle.digest(');
    expect(hasher).toContain("'SHA-256'");
    expect(production).toContain('contractEvidenceMigration');
  });

  it('keeps authenticated billing HTTP adapters scope-derived and production routes fail closed', async () => {
    const [checkout, cancellation, checkoutRoute, cancellationRoute] =
      await Promise.all([
        readFile('app/api/billing/checkout/handler.ts', 'utf8'),
        readFile('app/api/billing/cancel/handler.ts', 'utf8'),
        readFile('app/api/billing/checkout/route.ts', 'utf8'),
        readFile('app/api/billing/cancel/route.ts', 'utf8'),
      ]);
    expect(checkout).toContain('deriveVaultContext');
    expect(checkout).toContain('contractConfirmationCommandDecoder');
    expect(checkout).toContain('context: session.context');
    expect(checkout).not.toMatch(
      /legal-checkout\/(?:checkout-service|core|d1-adapter|records)|stripe\/(?:core|service|ports)/,
    );
    expect(cancellation).toContain('deriveVaultContext');
    expect(cancellation).toContain('accountId: session.context.accountId');
    expect(cancellation).toContain('vaultId: session.context.vaultId');
    expect(cancellation).not.toMatch(
      /entitlement\/|billing\/(?:cancellation-service|core|d1-adapter|records)/,
    );
    for (const route of [checkoutRoute, cancellationRoute]) {
      expect(route).toContain("mode.mode === 'legacy-test' ? 404 : 503");
      expect(route).not.toMatch(/\/fake|createFake|allowAll/);
    }
  });
});

function entitlementBoundaryViolation(file: string, source: string): boolean {
  if (
    file.startsWith('server/entitlement/') ||
    file === 'server/composition/sync-v2.ts' ||
    file.startsWith('server/migrations/')
  ) {
    return false;
  }
  return (
    /(?:(?:@\/)?server\/entitlement|(?:\.\.?\/)+entitlement)\/(?:core|d1-adapter|d1-schema|fake|migration|ports|records|service)/.test(
      source,
    ) ||
    /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:entitlement_projections|entitlement_offline_leases)\b/i.test(
      source,
    )
  );
}

describe('Entitlement module ownership', () => {
  it('keeps Entitlement internals and table mutations inside their owner module', async () => {
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (entitlementBoundaryViolation(file, source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it('detects representative private imports and direct writes', () => {
    expect(
      entitlementBoundaryViolation(
        'server/vault-content/access.ts',
        "import type { EntitlementProjectionRecord } from '../entitlement/core'",
      ),
    ).toBe(true);
    expect(
      entitlementBoundaryViolation(
        'app/api/v2/sync/handler.ts',
        "UPDATE entitlement_projections SET state = 'paid-active'",
      ),
    ).toBe(true);
    expect(
      entitlementBoundaryViolation(
        'server/vault-content/access.ts',
        "import type { EntitlementPort } from '../entitlement/public'",
      ),
    ).toBe(false);
  });

  it('exposes a read-only provider-neutral contract and no production fake fallback', async () => {
    const [core, publicContract, service, adapter, fake, testConfig] =
      await Promise.all([
        readFile('server/entitlement/core.ts', 'utf8'),
        readFile('server/entitlement/public.ts', 'utf8'),
        readFile('server/entitlement/service.ts', 'utf8'),
        readFile('server/entitlement/d1-adapter.ts', 'utf8'),
        readFile('server/entitlement/fake.ts', 'utf8'),
        readFile('vitest.config.ts', 'utf8'),
      ]);
    expect(core).toContain('evaluateSubscriptionFacts');
    expect(core).toContain('planOfflineLease');
    expect(core).not.toMatch(
      /D1Database|\.prepare\(|Date\.now|crypto\.|fetch\(|Promise/,
    );
    expect(publicContract).toContain('type EntitlementPort');
    expect(publicContract).toContain("'lease-policy-undecided'");
    expect(publicContract).not.toMatch(
      /Stripe|D1Database|BillingApi|BillingSubscriptionId|BillingVersion|EntitlementProjectionRecord/,
    );
    expect(service).toContain('dependencies.billing.readSubscription(context)');
    expect(service).toContain("offlineLeasePolicy.kind === 'undecided'");
    expect(adapter).toContain('createD1EntitlementPort');
    expect(adapter).toContain('controlPlane.findPersonalAccount');
    expect(fake).toContain('createFakeEntitlementModule');
    expect(fake).not.toMatch(/process\.env|D1Database|fetch\(/);
    expect(testConfig).toContain("'server/**/*.ts'");

    const productionFiles = (await Promise.all(roots.map(sourceFiles))).flat();
    const fakeConsumers: string[] = [];
    for (const file of productionFiles) {
      if (file === 'server/entitlement/fake.ts') continue;
      const source = await readFile(file, 'utf8');
      if (/entitlement\/fake/.test(source)) fakeConsumers.push(file);
    }
    expect(fakeConsumers).toEqual([]);
  });
});

describe('authenticated Sync v2 composition', () => {
  it('keeps decisions pure, handlers on public ports, and concrete wiring in one root', async () => {
    const [
      core,
      quotaCore,
      service,
      publicContract,
      handler,
      composition,
      route,
    ] = await Promise.all([
      readFile('server/sync-v2/core.ts', 'utf8'),
      readFile('server/sync-v2/quota-core.ts', 'utf8'),
      readFile('server/sync-v2/service.ts', 'utf8'),
      readFile('server/sync-v2/public.ts', 'utf8'),
      readFile('app/api/v2/sync/handler.ts', 'utf8'),
      readFile('server/composition/sync-v2.ts', 'utf8'),
      readFile('app/api/v2/sync/route.ts', 'utf8'),
    ]);
    expect(core).toContain('planSyncV2Mutation');
    expect(core).not.toMatch(
      /D1Database|\.prepare\(|Date\.now|crypto\.|fetch\(|Promise|TextEncoder|TextDecoder/,
    );
    expect(quotaCore).toContain('toSyncV2VaultQuotaChange');
    expect(quotaCore).not.toMatch(
      /D1Database|\.prepare\(|Date\.now|crypto\.|fetch\(|Promise|TextEncoder|TextDecoder/,
    );
    expect(service).toContain('createSyncV2Application');
    expect(service).toContain('authorizeSyncV2Cursor');
    expect(service).not.toMatch(
      /billing\/|stripe\/|entitlement\/(?:core|d1-adapter|records|service)/,
    );
    expect(publicContract).toContain('type SyncV2ContentDirectory');
    expect(publicContract).not.toMatch(/D1Database|R2Bucket|Stripe/);
    expect(handler).toContain("'notes-sync'");
    expect(handler).toContain('readLimits');
    expect(handler).toContain('entitlement/public');
    expect(handler).not.toMatch(
      /billing\/|stripe\/|entitlement\/(?:core|d1-adapter|records|service)/,
    );
    expect(composition).toContain('createD1SyncV2HttpHandler');
    expect(composition).toContain('D1SyncV2JournalDirectory');
    expect(composition).toContain('EncryptedSyncV2ContentDirectory');
    expect(composition).toContain('D1VaultQuotaLedgerDirectory');
    expect(composition).toContain(
      'offlineLeasePolicy: fukamuOfflineLeasePolicy',
    );
    expect(composition).not.toContain(
      "offlineLeasePolicy: { kind: 'undecided' }",
    );
    expect(composition).not.toMatch(/\/fake|allowAll|\.prepare\(/);
    expect(route).toContain('return unavailable(503)');
    expect(route).not.toMatch(/\/fake|createFake|allowAll/);
  });
});

function stripeBoundaryViolation(file: string, source: string): boolean {
  if (file.startsWith('server/stripe/')) return false;
  return /(?:(?:@\/)?server\/stripe|(?:\.\.?\/)+stripe)\/(?:core|fake|ports|service|webhook-signature)/.test(
    source,
  );
}

describe('Stripe provider adapter boundary', () => {
  it('keeps provider internals inside the adapter module', async () => {
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (stripeBoundaryViolation(file, source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it('detects private provider imports while allowing its public port', () => {
    expect(
      stripeBoundaryViolation(
        'app/api/billing/webhook.ts',
        "import { decodeStripeEventPlan } from '../../../server/stripe/core'",
      ),
    ).toBe(true);
    expect(
      stripeBoundaryViolation(
        'app/api/billing/webhook.ts',
        "import type { StripeBillingAdapter } from '../../../server/stripe/public'",
      ),
    ).toBe(false);
  });

  it('depends only on Billing public facts and keeps pure decisions free of effects', async () => {
    const [core, publicContract, service, verifier, fake, testConfig] =
      await Promise.all([
        readFile('server/stripe/core.ts', 'utf8'),
        readFile('server/stripe/public.ts', 'utf8'),
        readFile('server/stripe/service.ts', 'utf8'),
        readFile('server/stripe/webhook-signature.ts', 'utf8'),
        readFile('server/stripe/fake.ts', 'utf8'),
        readFile('vitest.config.ts', 'utf8'),
      ]);
    const stripeSources = [core, publicContract, service, verifier, fake].join(
      '\n',
    );
    expect(stripeSources).not.toMatch(
      /billing\/(?:core|d1-adapter|d1-schema|fake|migration|ports|records|service)/,
    );
    expect(core).toContain('planStripeCheckout');
    expect(core).toContain("['submit_type', 'subscribe']");
    expect(core).toContain("'metadata[contract_offer_hash]'");
    expect(core).toContain("'custom_text[submit][message]'");
    expect(core).toContain('decodeStripeEventPlan');
    expect(core).toContain('decodeStripeReconciliationSnapshot');
    expect(core).not.toMatch(
      /D1Database|\.prepare\(|Date\.now|crypto\.|fetch\(|Promise/,
    );
    expect(publicContract).toContain('type StripeBillingAdapter');
    expect(publicContract).not.toMatch(/Stripe\.Event|Stripe\.Subscription/);
    expect(service).toContain('billing.ingestVerifiedProviderFact');
    expect(service).toContain('billing.reconcileVerifiedSnapshot');
    expect(service).not.toMatch(/process\.env|fetch\(|\.prepare\(/);
    expect(verifier).toContain('crypto.subtle.verify');
    expect(verifier).toContain('input.rawBody');
    expect(fake).not.toMatch(/process\.env|fetch\(|D1Database/);
    expect(testConfig).toContain("'server/**/*.ts'");

    const productionFiles = (await Promise.all(roots.map(sourceFiles))).flat();
    const fakeConsumers: string[] = [];
    for (const file of productionFiles) {
      if (file === 'server/stripe/fake.ts') continue;
      const source = await readFile(file, 'utf8');
      if (/stripe\/fake/.test(source)) fakeConsumers.push(file);
    }
    expect(fakeConsumers).toEqual([]);
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
    expect(vaultComposition).toContain('vaultNotesScope(context)');
    expect(vaultComposition).toContain(
      'createIndexedDbSyncV2ReplicaRepository',
    );
    expect(vaultComposition).toContain('createV2SyncTransport');
    expect(vaultComposition).toContain('createSyncV2Client');
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

describe('provider-neutral telemetry architecture', () => {
  it('keeps vocabulary and alert decisions pure and provider adapters outside the core', async () => {
    const [core, publicContract, fake, handler, coverage, documentation] =
      await Promise.all([
        readFile('server/telemetry/core.ts', 'utf8'),
        readFile('server/telemetry/public.ts', 'utf8'),
        readFile('server/telemetry/fake.ts', 'utf8'),
        readFile('app/api/v2/sync/handler.ts', 'utf8'),
        readFile('vitest.config.ts', 'utf8'),
        readFile('docs/telemetry-and-alerts.md', 'utf8'),
      ]);

    expect(core).toContain('planTelemetryEvent');
    expect(core).toContain('telemetryMetricsForEvent');
    expect(core).toContain('planTelemetryAlert');
    expect(core).toContain("threshold: { kind: 'decision-required' }");
    expect(core).not.toMatch(
      /D1Database|R2Bucket|fetch\(|Date\.|performance\.|process\.|console\.|Promise/,
    );
    expect(publicContract).toContain('type TelemetrySink');
    expect(publicContract).toContain('recordTelemetrySafely');
    expect(publicContract).not.toMatch(
      /Cloudflare|Datadog|Stripe\.|D1Database/,
    );
    expect(handler).toContain('recordTelemetrySafely');
    expect(handler).toContain("operation: 'sync-v2'");
    expect(fake).not.toMatch(/process\.env|fetch\(|D1Database|R2Bucket/);
    expect(coverage).toContain("'server/**/*.ts'");
    expect(documentation).toContain('No production monitoring account');
    expect(documentation).toContain('threshold: decision-required');

    const productionFiles = (await Promise.all(roots.map(sourceFiles))).flat();
    const fakeConsumers: string[] = [];
    for (const file of productionFiles) {
      if (file === 'server/telemetry/fake.ts') continue;
      const source = await readFile(file, 'utf8');
      if (/telemetry\/fake/.test(source)) fakeConsumers.push(file);
    }
    expect(fakeConsumers).toEqual([]);
  });
});

describe('provider-neutral operations architecture', () => {
  it('keeps the launch gate pure and prevents runbook text from becoming execution authority', async () => {
    const [core, runbook, coverage] = await Promise.all([
      readFile('server/operations/core.ts', 'utf8'),
      readFile('docs/production-operations-runbook.md', 'utf8'),
      readFile('vitest.config.ts', 'utf8'),
    ]);

    expect(core).toContain('planEnvironmentAction');
    expect(core).toContain('evaluateLaunchGate');
    expect(core).toContain('decodeLaunchGateEvidence');
    expect(core).toContain('explicit-production-operation-approval-required');
    expect(core).not.toMatch(
      /D1Database|R2Bucket|fetch\(|Date\.|performance\.|process\.|console\.|Promise/,
    );
    expect(runbook).toContain(
      'A passing gate is evidence of readiness, never authority',
    );
    expect(runbook).toContain('Data deletion and key destruction are outside');
    expect(coverage).toContain("'server/**/*.ts'");
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
    expect(adapter).toContain('process.env');
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
    expect(adapter).toContain('process.env');
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

describe('terms consent server gate architecture', () => {
  it('keeps policy decisions pure, request ownership session-derived, and Notes UI unchanged', async () => {
    const [core, handler, route, termsPage, notes, coverage, documentation] =
      await Promise.all([
        readFile('server/terms-consent/application-core.ts', 'utf8'),
        readFile('app/api/account/terms-consent/handler.ts', 'utf8'),
        readFile('app/api/account/terms-consent/route.ts', 'utf8'),
        readFile('app/(public)/legal/terms/page.tsx', 'utf8'),
        readFile('components/notes-presentation.tsx', 'utf8'),
        readFile('vitest.config.ts', 'utf8'),
        readFile('docs/terms-consent-server-gate.md', 'utf8'),
      ]);

    expect(core).toContain('decideTermsConsentStatus');
    expect(core).toContain("reason: 'classification-required'");
    expect(core).not.toMatch(
      /Promise|fetch\(|Date\.|crypto\.|process\.|console\.|D1Database|Request|Response/,
    );
    expect(handler).toContain('deriveVaultContext');
    expect(handler).toContain('termsConsentCommandDecoder.decode(body.value)');
    expect(handler).not.toMatch(/body\.value\.(?:accountId|vaultId)/);
    expect(route).toContain("mode.mode === 'legacy-test' ? 404 : 503");
    expect(termsPage).toContain('title="利用規約"');
    expect(notes).not.toMatch(/terms-consent|legal\/terms|利用規約/);
    expect(coverage).toContain("'app/api/account/terms-consent/handler.ts'");
    expect(documentation).toContain('通常の Notes UI には表示を追加しない');
    expect(documentation).toContain('/legal/terms');
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
      verifier,
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
      readFile('server/terms-consent/checkout-verifier.ts', 'utf8'),
      readFile('server/legal-checkout/checkout-service.ts', 'utf8'),
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
    expect(checkout).toContain('submissionId: review.submissionId');
    expect(checkout).toContain("subject: 'subscription'");
    expect(checkout).toContain("subject: 'terms'");
    expect(account).toContain('createLocalTermsConsentUiTransport');
    expect(accountPage).toContain('TermsConsentBoundary');
    expect(verifier).toContain('findBySubmission');
    expect(checkoutService).toContain('dependencies.terms.verify');
    expect(checkoutService.indexOf('dependencies.terms.verify')).toBeLessThan(
      checkoutService.indexOf('dependencies.evidence.confirm'),
    );
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
});

describe('signup terms admission architecture', () => {
  it('gates both verified providers before provisioning and keeps legal UI outside Notes', async () => {
    const [core, application, oidc, otp, termsHandler, notes, documentation] =
      await Promise.all([
        readFile('server/signup-admission/core.ts', 'utf8'),
        readFile('server/signup-admission/application.ts', 'utf8'),
        readFile('server/oidc-boundary.ts', 'utf8'),
        readFile('server/email-otp-boundary.ts', 'utf8'),
        readFile('app/api/account/terms-consent/handler.ts', 'utf8'),
        readFile('components/notes-presentation.tsx', 'utf8'),
        readFile('docs/signup-terms-admission.md', 'utf8'),
      ]);

    expect(core).toContain('planSignupAdmission');
    expect(core).toContain('signupReceiptMatchesPlan');
    expect(core).not.toMatch(
      /Promise|fetch\(|Date\.|crypto\.|process\.|console\.|D1Database|Request|Response/,
    );
    expect(application).toContain('termsConsentCommandDecoder.decode');
    expect(application).toContain('dependencies.terms.accept');
    expect(application.indexOf('dependencies.terms.accept')).toBeLessThan(
      application.indexOf('dependencies.provisioning.finalize'),
    );
    expect(oidc).toContain("kind: 'google'");
    expect(oidc).toContain('input.signupAdmission.admit');
    expect(otp).toContain("kind: 'email-otp'");
    expect(otp).toContain('input.signupAdmission.admit');
    expect(termsHandler).toContain('deriveVaultContext');
    expect(application).not.toMatch(/input\.(?:accountId|vaultId|sessionId)/);
    expect(notes).not.toMatch(
      /terms-consent|account\/terms|legal\/terms|利用規約/,
    );
    expect(documentation).toContain('/legal/terms');
    expect(documentation).toContain('通常の Notes UI には追加しない');
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
    expect(adapter).toContain('process.env');
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
    expect(adapter).toContain('process.env');
    expect(script).toContain('evaluatePrivacyProcessingConsistency');
    expect(packageSource).toContain(
      'npm run check:privacy-processing-registry',
    );
    expect(coverage).toContain(
      "'lib/application/privacy-processing-registry.ts'",
    );
    expect(documentation).toContain('does not add AccountId or VaultId');
    expect(documentation).toContain('no D1/R2/KMS/Stripe operation');
  });
});

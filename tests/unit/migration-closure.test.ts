import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  decodeMigrationClosure,
  reachableNpmScripts,
  validateEvidenceFileIdentity,
  validateExecutableEvidenceGate,
  validateExecutableEvidenceSource,
  validateLegacyCoverage,
} from '../../scripts/migration-closure-core.mts';

const retiredPath = (suffix: string) => ['server', suffix].join('/');

async function manifestCandidate(): Promise<unknown> {
  return JSON.parse(
    await readFile('contracts/go-migration-closure.json', 'utf8'),
  );
}

function clone(candidate: unknown): unknown {
  return structuredClone(candidate);
}

function object(candidate: unknown): Record<string, unknown> {
  if (!isRecord(candidate)) {
    throw new TypeError('test fixture is not an object');
  }
  return candidate;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return (
    candidate !== null &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate)
  );
}

function list(candidate: unknown): unknown[] {
  if (!Array.isArray(candidate)) {
    throw new TypeError('test fixture is not an array');
  }
  return candidate;
}

function identified(entries: unknown[], id: string): Record<string, unknown> {
  const entry = entries.find(
    (candidate) => Reflect.get(object(candidate), 'id') === id,
  );
  if (entry === undefined) throw new TypeError(`missing test fixture ${id}`);
  return object(entry);
}

describe('Go migration closure evidence', () => {
  it('accepts the checked-in F01-F28 and V01-V12 inventory', async () => {
    const closure = decodeMigrationClosure(await manifestCandidate());

    expect(closure.features).toHaveLength(28);
    expect(closure.verifications).toHaveLength(12);
    expect(
      closure.features.filter(({ migration }) => migration === 'migrated'),
    ).toHaveLength(27);
    expect(closure.features.find(({ id }) => id === 'F22')).toMatchObject({
      migration: 'migrated',
      dependencies: [],
    });
    expect(closure.features.find(({ id }) => id === 'F12')).toMatchObject({
      state: 'A/B/C',
      migration: 'migrated',
    });
    const accountDeletion = closure.features.find(({ id }) => id === 'F23');
    expect(accountDeletion).toMatchObject({
      state: 'A/B',
      migration: 'migrated',
    });
    expect(accountDeletion?.verification).toEqual(
      expect.arrayContaining(['V04', 'V08', 'V10']),
    );
    const privacyRequest = closure.features.find(({ id }) => id === 'F24');
    expect(privacyRequest).toMatchObject({
      state: 'A/B',
      migration: 'migrated',
    });
    expect(privacyRequest?.verification).toEqual(
      expect.arrayContaining(['V01', 'V03', 'V04', 'V08', 'V10']),
    );
    expect(privacyRequest?.goEvidence).toEqual(
      expect.arrayContaining([
        'backend/cmd/notes/main.go',
        'backend/internal/adapters/privacyunavailable/provider.go',
        'backend/internal/httpapi/privacy_request.go',
      ]),
    );
    expect(closure.features.find(({ id }) => id === 'F28')).toMatchObject({
      migration: 'intentionally-absent',
    });
    const performanceComparison = closure.verifications.find(
      ({ id }) => id === 'V12',
    );
    expect(performanceComparison).toMatchObject({ status: 'in-progress' });
    expect(performanceComparison?.note).toContain('100/1,000/10,000-card');
    expect(closure.verifications.find(({ id }) => id === 'V11')).toMatchObject({
      status: 'complete',
    });
    expect(closure.verifications.find(({ id }) => id === 'V09')).toMatchObject({
      status: 'approval-pending',
    });
    expect(closure.retirement.phase).toBe('retired');
    expect(closure.profiles.map(({ id }) => id)).toEqual([
      'local-private-legacy',
      'local-fixture-undecided',
      'local-fixture-delete-live-evidence',
      'production-disabled',
    ]);
    expect(
      closure.profiles.every(({ features }) => features.length === 28),
    ).toBe(true);
    expect(
      closure.profiles
        .find(({ id }) => id === 'production-disabled')
        ?.features.filter(({ state }) => state === 'connected')
        .map(({ id }) => id),
    ).toEqual(['F01']);
    expect(
      closure.profiles.map(({ id, features }) => ({
        profile: id,
        state: features.find(({ id: featureID }) => featureID === 'F26')?.state,
      })),
    ).toEqual([
      { profile: 'local-private-legacy', state: 'partially-connected' },
      { profile: 'local-fixture-undecided', state: 'partially-connected' },
      {
        profile: 'local-fixture-delete-live-evidence',
        state: 'partially-connected',
      },
      { profile: 'production-disabled', state: 'partially-connected' },
    ]);
    expect(closure.productionTransition).toMatchObject({
      deployment: 'not-performed',
      databaseMigration: 'not-performed',
      trafficCutover: 'not-performed',
      externalResources: 'not-performed',
      approval: 'pending',
    });
  });

  it('rejects v2, unknown keys, missing profiles, and duplicate feature rows', async () => {
    const oldVersion = clone(await manifestCandidate());
    Reflect.set(object(oldVersion), 'schemaVersion', 2);
    expect(() => decodeMigrationClosure(oldVersion)).toThrow(
      'schema version is unsupported',
    );

    const unknown = clone(await manifestCandidate());
    Reflect.set(object(unknown), 'unreviewed', true);
    expect(() => decodeMigrationClosure(unknown)).toThrow('unknown key');

    const missingProfile = clone(await manifestCandidate());
    list(Reflect.get(object(missingProfile), 'profiles')).pop();
    expect(() => decodeMigrationClosure(missingProfile)).toThrow(
      'runtime profile evidence is incomplete',
    );

    const duplicateFeature = clone(await manifestCandidate());
    const profile = identified(
      list(Reflect.get(object(duplicateFeature), 'profiles')),
      'local-private-legacy',
    );
    const runtimeFeatures = list(Reflect.get(profile, 'features'));
    runtimeFeatures.push(identified(runtimeFeatures, 'F01'));
    expect(() => decodeMigrationClosure(duplicateFeature)).toThrow(
      'runtime profile feature id must be unique',
    );
  });

  it('binds every feature row to same-profile named evidence without orphans', async () => {
    const crossProfile = clone(await manifestCandidate());
    const crossEvidence = identified(
      list(Reflect.get(object(crossProfile), 'executableEvidence')),
      'E01',
    );
    Reflect.set(crossEvidence, 'profile', 'production-disabled');
    expect(() => decodeMigrationClosure(crossProfile)).toThrow(
      'cross-profile evidence',
    );

    const orphan = clone(await manifestCandidate());
    const orphanEvidence = list(
      Reflect.get(object(orphan), 'executableEvidence'),
    );
    const additional = clone(identified(orphanEvidence, 'E05'));
    Reflect.set(object(additional), 'id', 'E99');
    Reflect.set(object(additional), 'path', 'scripts/orphan-verifier.mts');
    Reflect.set(object(additional), 'name', 'verify:orphan');
    Reflect.set(object(additional), 'gate', 'verify:orphan');
    Reflect.set(object(additional), 'selector', 'scripts/orphan-verifier.mts');
    orphanEvidence.push(additional);
    expect(() => decodeMigrationClosure(orphan)).toThrow(
      'not assigned to a runtime feature',
    );

    const movedBrowserEvidence = clone(await manifestCandidate());
    const destructive = identified(
      list(Reflect.get(object(movedBrowserEvidence), 'profiles')),
      'local-fixture-delete-live-evidence',
    );
    const destructiveFeatures = list(Reflect.get(destructive, 'features'));
    Reflect.set(identified(destructiveFeatures, 'F23'), 'evidence', ['E03']);
    Reflect.set(identified(destructiveFeatures, 'F01'), 'evidence', [
      'E03',
      'E04',
    ]);
    expect(() => decodeMigrationClosure(movedBrowserEvidence)).toThrow(
      'feature evidence is inaccurate',
    );

    const duplicateAnchor = clone(await manifestCandidate());
    const evidence = list(
      Reflect.get(object(duplicateAnchor), 'executableEvidence'),
    );
    const duplicate = clone(identified(evidence, 'E01'));
    Reflect.set(object(duplicate), 'id', 'E99');
    evidence.push(duplicate);
    const privateProfile = identified(
      list(Reflect.get(object(duplicateAnchor), 'profiles')),
      'local-private-legacy',
    );
    const privateFeature = identified(
      list(Reflect.get(privateProfile, 'features')),
      'F01',
    );
    Reflect.set(privateFeature, 'evidence', ['E01', 'E99']);
    expect(() => decodeMigrationClosure(duplicateAnchor)).toThrow(
      'executable evidence anchor must be unique',
    );
  });

  it('rejects runtime state drift from the exact four-profile truth matrix', async () => {
    for (const mutation of [
      ['local-fixture-undecided', 'F23', 'connected'],
      ['local-fixture-undecided', 'F03', 'connected'],
      ['local-private-legacy', 'F28', 'connected'],
      ['production-disabled', 'F27', 'connected'],
      ['local-private-legacy', 'F26', 'not-connected'],
      ['production-disabled', 'F26', 'not-connected'],
      ['production-disabled', 'F12', 'closed'],
      ['production-disabled', 'F18', 'not-connected'],
    ] as const) {
      const candidate = clone(await manifestCandidate());
      const profile = identified(
        list(Reflect.get(object(candidate), 'profiles')),
        mutation[0],
      );
      const feature = identified(
        list(Reflect.get(profile, 'features')),
        mutation[1],
      );
      Reflect.set(feature, 'state', mutation[2]);
      expect(() => decodeMigrationClosure(candidate)).toThrow(
        `feature state is inaccurate: ${mutation[0]}/${mutation[1]}`,
      );
    }
  });

  it('rejects missing or duplicated feature evidence', async () => {
    const missing = clone(await manifestCandidate());
    const missingFeatures = list(Reflect.get(object(missing), 'features'));
    missingFeatures.pop();
    expect(() => decodeMigrationClosure(missing)).toThrow(
      'feature evidence is incomplete',
    );

    const duplicate = clone(await manifestCandidate());
    const duplicateFeatures = list(Reflect.get(object(duplicate), 'features'));
    duplicateFeatures.push(identified(duplicateFeatures, 'F01'));
    expect(() => decodeMigrationClosure(duplicate)).toThrow(
      'feature id must be unique',
    );
  });

  it('requires implementation evidence and an explicit blocker owner', async () => {
    const missingGoEvidence = clone(await manifestCandidate());
    const migrated = identified(
      list(Reflect.get(object(missingGoEvidence), 'features')),
      'F01',
    );
    Reflect.set(migrated, 'goEvidence', []);
    expect(() => decodeMigrationClosure(missingGoEvidence)).toThrow(
      'migrated feature requires Go evidence',
    );

    const missingDependency = clone(await manifestCandidate());
    const blocked = identified(
      list(Reflect.get(object(missingDependency), 'features')),
      'F01',
    );
    Reflect.set(blocked, 'migration', 'blocked-existing-work');
    Reflect.set(blocked, 'dependencies', []);
    expect(() => decodeMigrationClosure(missingDependency)).toThrow(
      'blocked feature requires a dependency',
    );
  });

  it('requires pending verification notes and safe evidence paths', async () => {
    const missingNote = clone(await manifestCandidate());
    const pending = identified(
      list(Reflect.get(object(missingNote), 'verifications')),
      'V09',
    );
    Reflect.deleteProperty(pending, 'note');
    expect(() => decodeMigrationClosure(missingNote)).toThrow(
      'incomplete verification requires a note',
    );

    const unsafe = clone(await manifestCandidate());
    const retirement = object(Reflect.get(object(unsafe), 'retirement'));
    const firstTree = object(list(Reflect.get(retirement, 'sourceTrees'))[0]);
    Reflect.set(firstTree, 'path', '../server');
    expect(() => decodeMigrationClosure(unsafe)).toThrow('unsafe');
  });

  it('binds retirement evidence to the recorded revision', async () => {
    const mismatched = clone(await manifestCandidate());
    const retirement = object(Reflect.get(object(mismatched), 'retirement'));
    Reflect.set(retirement, 'sourceRevision', 'a'.repeat(40));

    expect(() => decodeMigrationClosure(mismatched)).toThrow(
      'retirement revision does not match the baseline',
    );
  });

  it('requires completed V11 evidence before declaring retirement', async () => {
    const incomplete = clone(await manifestCandidate());
    const verification = identified(
      list(Reflect.get(object(incomplete), 'verifications')),
      'V11',
    );
    Reflect.set(verification, 'status', 'in-progress');
    Reflect.set(verification, 'note', 'synthetic incomplete retirement');

    expect(() => decodeMigrationClosure(incomplete)).toThrow(
      'retired phase requires complete V11 verification',
    );
  });

  it('assigns every legacy source to exactly one retirement group', () => {
    const groups = [
      { id: 'one', features: ['F01'], legacyPrefixes: [retiredPath('one/')] },
      { id: 'two', features: ['F02'], legacyPrefixes: [retiredPath('two/')] },
    ] as const;

    expect(() =>
      validateLegacyCoverage(
        [retiredPath('one/a.ts'), retiredPath('two/b.ts')],
        groups,
      ),
    ).not.toThrow();
    expect(() =>
      validateLegacyCoverage([retiredPath('unowned.ts')], groups),
    ).toThrow('not recorded');
    expect(() =>
      validateLegacyCoverage(
        [retiredPath('one/a.ts')],
        [
          ...groups,
          {
            id: 'overlap',
            features: ['F03'],
            legacyPrefixes: [retiredPath('')],
          },
        ],
      ),
    ).toThrow('multiple retirement owners');
  });

  it('runs closure verification in the shared gate and uses the typed runner', async () => {
    const packageCandidate: unknown = JSON.parse(
      await readFile('package.json', 'utf8'),
    );
    const scripts = object(Reflect.get(object(packageCandidate), 'scripts'));

    expect(Reflect.get(scripts, 'verify:migration-closure')).toBe(
      'node --experimental-strip-types scripts/verify-migration-closure.mts',
    );
    expect(Reflect.get(scripts, 'benchmark:migration')).toBe(
      'node --experimental-strip-types scripts/benchmark-migration.mts',
    );
    expect(Reflect.get(scripts, 'verify')).toContain(
      'npm run contracts:check && npm run verify:migration-closure',
    );
  });

  it('binds named evidence to exact symbols, titles, and reachable selectors', async () => {
    const closure = decodeMigrationClosure(await manifestCandidate());
    const goEvidence = closure.executableEvidence.find(
      ({ id }) => id === 'E01',
    );
    const browserEvidence = closure.executableEvidence.find(
      ({ id }) => id === 'E04',
    );
    const releaseEvidence = closure.executableEvidence.find(
      ({ id }) => id === 'E05',
    );
    if (
      goEvidence === undefined ||
      browserEvidence === undefined ||
      releaseEvidence === undefined
    ) {
      throw new TypeError('test evidence is incomplete');
    }
    const scripts = {
      verify:
        'npm run go:test:integration && FUKAMU_E2E_USE_PREBUILT=1 FUKAMU_DELETION_E2E_CONFIRM=delete-live-evidence npm run test:e2e:deletion-live && npm run verify:release',
      'go:test:integration':
        'NOTES_TEST_DATABASE_URL=${NOTES_TEST_DATABASE_URL:-postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable} go -C backend test -p=1 -tags=integration ./tests/integration/... ./cmd/notes ./cmd/notesctl',
      'test:e2e:deletion-live':
        'node --experimental-strip-types scripts/run-deletion-live-e2e.mts playwright.deletion-live.config.ts',
      'verify:release':
        'node --experimental-strip-types scripts/verify-release-artifact.mts',
    };
    expect(reachableNpmScripts(scripts, 'verify')).toEqual(
      new Set([
        'verify',
        'go:test:integration',
        'test:e2e:deletion-live',
        'verify:release',
      ]),
    );
    for (const masked of [
      'echo npm run verify:release',
      'true || npm run verify:release',
      'npm run verify:release | cat',
      'npm run verify:release; true',
    ]) {
      expect(() =>
        reachableNpmScripts({ ...scripts, verify: masked }, 'verify'),
      ).toThrow();
    }
    expect(() =>
      validateExecutableEvidenceSource(
        goEvidence,
        '\nfunc TestWholeRuntimeLocalPrivateLegacy(t *testing.T) {}\n',
        scripts,
      ),
    ).not.toThrow();
    expect(() =>
      validateExecutableEvidenceSource(
        goEvidence,
        '\nfunc TestRenamed(t *testing.T) {}\n',
        scripts,
      ),
    ).toThrow('renamed or removed');
    for (const inertOldAnchor of [
      '// func TestWholeRuntimeLocalPrivateLegacy(t *testing.T) {}',
      '/* func TestWholeRuntimeLocalPrivateLegacy(t *testing.T) {} */',
      'var old = `func TestWholeRuntimeLocalPrivateLegacy(t *testing.T) {}`',
      'var old = "func TestWholeRuntimeLocalPrivateLegacy(t *testing.T) {}"',
    ]) {
      expect(() =>
        validateExecutableEvidenceSource(
          goEvidence,
          `${inertOldAnchor}\nfunc TestRenamed(t *testing.T) {}`,
          scripts,
        ),
      ).toThrow('renamed or removed');
    }
    for (const skipped of [
      '\nfunc TestWholeRuntimeLocalPrivateLegacy(t *testing.T) { t.Skip() }\n',
      '\nfunc TestWholeRuntimeLocalPrivateLegacy(t *testing.T) { t.SkipNow() }\n',
    ]) {
      expect(() =>
        validateExecutableEvidenceSource(goEvidence, skipped, scripts),
      ).toThrow('must not be skipped');
    }
    expect(() =>
      validateExecutableEvidenceSource(
        browserEvidence,
        "test('live disposable account deletion survives an actual Go restart', async () => {})",
        scripts,
      ),
    ).not.toThrow();
    expect(() =>
      validateExecutableEvidenceSource(
        browserEvidence,
        "test.skip('live disposable account deletion survives an actual Go restart', async () => {})",
        scripts,
      ),
    ).toThrow('must not be skipped or focused');
    expect(() =>
      validateExecutableEvidenceSource(
        browserEvidence,
        "test.only('live disposable account deletion survives an actual Go restart', async () => {})",
        scripts,
      ),
    ).toThrow('must not be skipped or focused');
    for (const inertOldAnchor of [
      "// test('live disposable account deletion survives an actual Go restart', async () => {})",
      "/* test('live disposable account deletion survives an actual Go restart', async () => {}) */",
      'const old = "test(\\\'live disposable account deletion survives an actual Go restart\\\', async () => {})"',
    ]) {
      expect(() =>
        validateExecutableEvidenceSource(
          browserEvidence,
          `${inertOldAnchor}\ntest('renamed destructive evidence', async () => {})`,
          scripts,
        ),
      ).toThrow('renamed or removed');
    }
    for (const skipped of [
      "test.describe.skip('group', () => { test('live disposable account deletion survives an actual Go restart', async () => {}) })",
      "test.describe.only('group', () => { test('live disposable account deletion survives an actual Go restart', async () => {}) })",
      "test('live disposable account deletion survives an actual Go restart', async () => { test.skip() })",
      "test('live disposable account deletion survives an actual Go restart', async () => { test.fixme() })",
      "test('live disposable account deletion survives an actual Go restart', async () => { test.fail() })",
    ]) {
      expect(() =>
        validateExecutableEvidenceSource(browserEvidence, skipped, scripts),
      ).toThrow('must not be skipped or focused');
    }
    expect(() =>
      validateExecutableEvidenceGate(goEvidence, scripts),
    ).not.toThrow();
    expect(() =>
      validateExecutableEvidenceGate(browserEvidence, scripts, {
        'playwright.deletion-live.config.ts':
          "export default { testDir: './tests/e2e-live-deletion' }",
        'scripts/run-deletion-live-e2e.mts':
          "const config = 'playwright.deletion-live.config.ts'",
      }),
    ).not.toThrow();
    expect(() =>
      validateExecutableEvidenceSource(
        releaseEvidence,
        'const RELEASE_ARTIFACT_VERIFIER_VERSION = 2;',
        scripts,
      ),
    ).not.toThrow();
    expect(() =>
      validateExecutableEvidenceGate(releaseEvidence, scripts),
    ).not.toThrow();
    expect(() =>
      validateExecutableEvidenceGate(releaseEvidence, {
        ...scripts,
        'verify:release': 'true',
      }),
    ).toThrow('exact gate');
    for (const suffix of [' || true', '; true', ' | cat', ' &']) {
      expect(() =>
        validateExecutableEvidenceGate(releaseEvidence, {
          ...scripts,
          'verify:release': `node --experimental-strip-types scripts/verify-release-artifact.mts${suffix}`,
        }),
      ).toThrow('exact gate');
    }
    expect(() =>
      validateExecutableEvidenceGate(releaseEvidence, {
        ...scripts,
        'verify:release': 'node scripts/other-release-verifier.mts',
      }),
    ).toThrow('exact gate');
    expect(() =>
      validateExecutableEvidenceGate(
        {
          ...releaseEvidence,
          path: 'scripts/other-release-verifier.mts',
          selector: 'scripts/other-release-verifier.mts',
        },
        scripts,
      ),
    ).toThrow('exact gate');
    expect(() =>
      validateExecutableEvidenceGate(goEvidence, {
        ...scripts,
        'go:test:integration': `true || ${String(scripts['go:test:integration'])}`,
      }),
    ).toThrow('does not execute');
    expect(() =>
      validateExecutableEvidenceGate(browserEvidence, {
        ...scripts,
        'test:e2e:deletion-live': `true || ${String(scripts['test:e2e:deletion-live'])}`,
      }),
    ).toThrow('does not execute');
    for (const suffix of [' || true', '; true', ' | cat', ' &']) {
      expect(() =>
        validateExecutableEvidenceGate(goEvidence, {
          ...scripts,
          'go:test:integration': `${String(scripts['go:test:integration'])}${suffix}`,
        }),
      ).toThrow('does not execute');
      expect(() =>
        validateExecutableEvidenceGate(browserEvidence, {
          ...scripts,
          'test:e2e:deletion-live': `${String(scripts['test:e2e:deletion-live'])}${suffix}`,
        }),
      ).toThrow('does not execute');
    }
  });

  it('rejects untracked, symlinked, or non-regular evidence', () => {
    expect(() =>
      validateEvidenceFileIdentity({
        tracked: true,
        regularFile: true,
        symbolicLink: false,
      }),
    ).not.toThrow();
    expect(() =>
      validateEvidenceFileIdentity({
        tracked: false,
        regularFile: true,
        symbolicLink: false,
      }),
    ).toThrow('tracked by Git');
    expect(() =>
      validateEvidenceFileIdentity({
        tracked: true,
        regularFile: true,
        symbolicLink: true,
      }),
    ).toThrow('non-symlink');
  });
});

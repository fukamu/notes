import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  decodeMigrationClosure,
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
    expect(closure.features.find(({ id }) => id === 'F28')).toMatchObject({
      migration: 'intentionally-absent',
    });
    expect(closure.verifications.find(({ id }) => id === 'V12')).toMatchObject({
      status: 'complete',
    });
    expect(closure.verifications.find(({ id }) => id === 'V11')).toMatchObject({
      status: 'complete',
    });
    expect(closure.verifications.find(({ id }) => id === 'V09')).toMatchObject({
      status: 'approval-pending',
    });
    expect(closure.retirement.phase).toBe('retired');
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
});

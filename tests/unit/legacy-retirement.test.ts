import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  decodeLegacyTestRetirementLedger,
  legacyTestCorpusDigest,
  selectLegacyTestCorpus,
  validateExecutableEvidence,
  validateLedgerClosure,
  validateReferenceCorpus,
  validateRetiredTree,
} from '../../scripts/legacy-retirement-core.mts';
import { decodeMigrationClosure } from '../../scripts/migration-closure-core.mts';

const legacyImport = ['@/', 'server/example'].join('');
const legacyHostName = ['Mini', 'flare'].join('');
const legacySourceRevision = 'a'.repeat(40);
const corpusRevision = 'b'.repeat(40);
const goEvidence = 'backend/internal/example/example_test.go';

async function ledgerCandidate(): Promise<unknown> {
  return JSON.parse(
    await readFile('contracts/legacy-test-retirement.json', 'utf8'),
  );
}

function smallLedgerCandidate(
  input: {
    readonly legacyPath?: string;
    readonly content?: string;
    readonly disposition?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const legacyPath = input.legacyPath ?? 'tests/unit/example.test.ts';
  const content = input.content ?? `import '${legacyImport}'`;
  const legacySha256 = createHash('sha256').update(content).digest('hex');
  const entry = {
    legacyPath,
    legacySha256,
    featureIds: ['F01'],
    disposition: input.disposition ?? {
      kind: 'go-replacement',
      evidence: [goEvidence],
    },
  };
  return {
    schemaVersion: 1,
    selectionVersion: 1,
    legacySourceRevision,
    testCorpusRevision: corpusRevision,
    files: 1,
    sha256: legacyTestCorpusDigest([entry]),
    entries: [entry],
  };
}

function clone(candidate: unknown): unknown {
  return structuredClone(candidate);
}

function object(candidate: unknown): Record<string, unknown> {
  if (!isRecord(candidate)) throw new TypeError('fixture is not an object');
  return candidate;
}

function list(candidate: unknown): unknown[] {
  if (!Array.isArray(candidate)) throw new TypeError('fixture is not a list');
  return candidate;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return (
    candidate !== null &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate)
  );
}

function closureBinding(
  phase: 'reference-present' | 'retired' = 'reference-present',
) {
  return {
    phase,
    sourceRevision: legacySourceRevision,
    testCorpusRevision: corpusRevision,
    files: 1,
    sha256: decodeLegacyTestRetirementLedger(smallLedgerCandidate()).sha256,
    features: [{ id: 'F01', migration: 'migrated' as const }],
  };
}

describe('legacy TypeScript test retirement ledger', () => {
  it('accounts for the frozen corpus exactly once with no historical-only loss', async () => {
    const ledger = decodeLegacyTestRetirementLedger(await ledgerCandidate());
    const closureCandidate: unknown = JSON.parse(
      await readFile('contracts/go-migration-closure.json', 'utf8'),
    );
    const closure = decodeMigrationClosure(closureCandidate);

    expect(ledger).toMatchObject({
      legacySourceRevision: 'e8936ab90768774371d84b4808c100d546649943',
      testCorpusRevision: 'af743246f14f7e0b96accf1ed7e1a1201fc3aaaf',
      files: 138,
      sha256:
        '7c28cbe1db282adc1d5349f06ab37964f2b224d4ee3dbc9acad8664e0de50531',
    });
    expect(
      ledger.entries.filter(
        ({ disposition }) => disposition.kind === 'retained-frontend',
      ),
    ).toHaveLength(11);
    expect(
      ledger.entries.filter(
        ({ disposition }) => disposition.kind === 'go-replacement',
      ),
    ).toHaveLength(127);
    expect(
      ledger.entries.filter(
        ({ disposition }) => disposition.kind === 'historical-only',
      ),
    ).toHaveLength(0);
    expect(() =>
      validateLedgerClosure(ledger, {
        phase: closure.retirement.phase,
        sourceRevision: closure.retirement.sourceRevision,
        testCorpusRevision: closure.retirement.legacyTestCorpus.revision,
        files: closure.retirement.legacyTestCorpus.files,
        sha256: closure.retirement.legacyTestCorpus.sha256,
        features: closure.features,
      }),
    ).not.toThrow();
  });

  it('keeps Go parity evidence on retained tests that also covered the legacy backend', async () => {
    const ledger = decodeLegacyTestRetirementLedger(await ledgerCandidate());
    const entries = new Map(
      ledger.entries.map((entry) => [entry.legacyPath, entry]),
    );
    const expected = new Map<string, readonly string[]>([
      [
        'tests/contracts/migration-fixtures.test.ts',
        [
          'backend/internal/accountdeletion/fixture_test.go',
          'backend/internal/billing/fixture_test.go',
          'backend/internal/cryptocontent/model_test.go',
          'backend/internal/encryptedobject/recovery_test.go',
          'backend/internal/entitlement/fixture_test.go',
          'backend/internal/httpapi/legal_test.go',
          'backend/internal/identity/email_otp_test.go',
          'backend/internal/identity/oidc_test.go',
          'backend/internal/identity/session_test.go',
          'backend/internal/legal/contract_test.go',
          'backend/internal/legal/terms_fixture_test.go',
          'backend/internal/privacyrequest/fixture_test.go',
          'backend/internal/stripebilling/fixture_test.go',
          'backend/internal/synclegacy/decode_test.go',
          'backend/internal/syncv2/protocol_cursor_test.go',
          'tests/contracts/migration-fixtures.test.ts',
        ],
      ],
      [
        'tests/unit/card-payment-security.test.ts',
        [
          'backend/internal/adapters/stripe/provider_test.go',
          'backend/internal/stripebilling/core_test.go',
          'tests/unit/card-payment-security.test.ts',
        ],
      ],
      [
        'tests/unit/external-transmission.test.ts',
        [
          'backend/internal/httpapi/handler_test.go',
          'backend/internal/identity/boundary_test.go',
          'backend/internal/identity/oidc_boundary_test.go',
          'backend/internal/identity/oidc_destination_test.go',
          'tests/unit/external-transmission.test.ts',
        ],
      ],
      [
        'tests/unit/privacy-processing-registry.test.ts',
        [
          'backend/internal/accountdeletion/model_protocol_test.go',
          'backend/internal/identity/boundary_test.go',
          'tests/unit/privacy-processing-registry.test.ts',
        ],
      ],
    ]);

    for (const [path, evidence] of expected) {
      const entry = entries.get(path);
      if (entry?.disposition.kind !== 'retained-frontend') {
        throw new TypeError(`missing mixed retained entry: ${path}`);
      }
      expect(entry.disposition.evidence).toEqual(evidence);
    }
  });

  it('rejects missing, duplicate, unsorted, unsafe, and unknown entry data', async () => {
    const missing = clone(await ledgerCandidate());
    list(Reflect.get(object(missing), 'entries')).pop();
    expect(() => decodeLegacyTestRetirementLedger(missing)).toThrow(
      'entry count',
    );

    const duplicate = clone(await ledgerCandidate());
    const duplicateEntries = list(Reflect.get(object(duplicate), 'entries'));
    duplicateEntries.push(clone(duplicateEntries[0]));
    Reflect.set(object(duplicate), 'files', 139);
    expect(() => decodeLegacyTestRetirementLedger(duplicate)).toThrow(
      'legacy test path must be unique',
    );

    const unsorted = clone(await ledgerCandidate());
    list(Reflect.get(object(unsorted), 'entries')).reverse();
    expect(() => decodeLegacyTestRetirementLedger(unsorted)).toThrow(
      'legacy test path must be sorted',
    );

    const unsafe = smallLedgerCandidate();
    const unsafeEntry = object(list(Reflect.get(unsafe, 'entries'))[0]);
    Reflect.set(unsafeEntry, 'legacyPath', '../tests/example.test.ts');
    expect(() => decodeLegacyTestRetirementLedger(unsafe)).toThrow('unsafe');

    const unknown = smallLedgerCandidate();
    Reflect.set(unknown, 'unexpected', true);
    expect(() => decodeLegacyTestRetirementLedger(unknown)).toThrow(
      'unknown or missing fields',
    );
  });

  it('rejects digest drift and closure provenance drift', () => {
    const digestDrift = smallLedgerCandidate();
    const entry = object(list(Reflect.get(digestDrift, 'entries'))[0]);
    Reflect.set(entry, 'legacySha256', 'c'.repeat(64));
    expect(() => decodeLegacyTestRetirementLedger(digestDrift)).toThrow(
      'entry digest',
    );

    const ledger = decodeLegacyTestRetirementLedger(smallLedgerCandidate());
    expect(() =>
      validateLedgerClosure(ledger, {
        ...closureBinding(),
        testCorpusRevision: 'd'.repeat(40),
      }),
    ).toThrow('corpus revision');
    expect(() =>
      validateLedgerClosure(ledger, {
        ...closureBinding(),
        features: [{ id: 'F02', migration: 'migrated' }],
      }),
    ).toThrow('unknown feature');
  });

  it('detects added, missing, and byte-drifted frozen test files', () => {
    const content = `import '${legacyImport}'`;
    const ledger = decodeLegacyTestRetirementLedger(
      smallLedgerCandidate({ content }),
    );
    const current = selectLegacyTestCorpus([
      { path: 'tests/unit/example.test.ts', content },
    ]);
    expect(() => validateReferenceCorpus(ledger, current)).not.toThrow();

    const added = selectLegacyTestCorpus([
      { path: 'tests/unit/example.test.ts', content },
      {
        path: 'tests/unit/unrecorded.test.ts',
        content: `const host = '${legacyHostName}'`,
      },
    ]);
    expect(() => validateReferenceCorpus(ledger, added)).toThrow('file count');
    expect(() => validateReferenceCorpus(ledger, [])).toThrow('file count');

    const drifted = selectLegacyTestCorpus([
      {
        path: 'tests/unit/example.test.ts',
        content: `${content}\n// changed`,
      },
    ]);
    expect(() => validateReferenceCorpus(ledger, drifted)).toThrow(
      'content drifted',
    );
  });

  it('sorts the selected corpus by deterministic code-unit path order', () => {
    const content = `import '${legacyImport}'`;
    expect(
      selectLegacyTestCorpus([
        { path: 'tests/unit/a.test.ts', content },
        { path: 'tests/unit/Z.test.ts', content },
      ]).map(({ path }) => path),
    ).toEqual(['tests/unit/Z.test.ts', 'tests/unit/a.test.ts']);
  });

  it('accepts only evidence executed by the shared Vitest, Playwright, or Go lanes', () => {
    expect(
      validateExecutableEvidence(
        goEvidence,
        'package example\nfunc TestEvidence(t *testing.T) {}\n',
      ),
    ).toBe('go-unit');
    expect(
      validateExecutableEvidence(
        'backend/tests/integration/example_test.go',
        '//go:build integration\npackage integration\nfunc TestEvidence(t *testing.T) {}\n',
      ),
    ).toBe('go-integration');
    expect(
      validateExecutableEvidence(
        'tests/unit/example.test.ts',
        "import { it } from 'vitest'; it('works', () => {});",
      ),
    ).toBe('vitest');
    expect(() =>
      validateExecutableEvidence(
        'docs/legacy-typescript-retirement.md',
        '# evidence',
      ),
    ).toThrow('not executed');
    expect(() =>
      validateExecutableEvidence(
        'tests/unit/example.test.ts',
        "import { it } from 'vitest';",
      ),
    ).toThrow('no named test');
    expect(() =>
      validateExecutableEvidence(goEvidence, 'package example\n'),
    ).toThrow('no named test');
    expect(() =>
      validateExecutableEvidence(
        goEvidence,
        'package example\nfunc BenchmarkEvidence(b *testing.B) {}\n',
      ),
    ).toThrow('no named test');
    expect(() =>
      validateExecutableEvidence(
        'backend/tests/integration/example_test.go',
        'package integration\nfunc TestEvidence(t *testing.T) {}\n',
      ),
    ).toThrow('build tag');
    expect(() =>
      validateExecutableEvidence(
        'backend/tests/integration/example_test.go',
        '//go:build linux\npackage integration\nfunc TestEvidence(t *testing.T) {}\n',
      ),
    ).toThrow('build tag');
  });

  it('requires removal or a legacy-free retained frontend path after retirement', () => {
    const replacement = decodeLegacyTestRetirementLedger(
      smallLedgerCandidate(),
    );
    expect(() =>
      validateRetiredTree(
        replacement,
        [],
        new Set(['tests/unit/example.test.ts', goEvidence]),
        new Map([[goEvidence, 'package example\nfunc TestEvidence() {}\n']]),
      ),
    ).toThrow('still tracked');

    const retainedCandidate = smallLedgerCandidate({
      disposition: {
        kind: 'retained-frontend',
        currentPath: 'tests/unit/example.test.ts',
        evidence: ['tests/unit/example.test.ts'],
      },
    });
    const retained = decodeLegacyTestRetirementLedger(retainedCandidate);
    expect(() =>
      validateRetiredTree(retained, [], new Set(), new Map()),
    ).toThrow('retained frontend path is missing');
    expect(() =>
      validateRetiredTree(
        retained,
        [],
        new Set(['tests/unit/example.test.ts']),
        new Map([['tests/unit/example.test.ts', `import '${legacyImport}'`]]),
      ),
    ).toThrow('still depends');
    expect(() =>
      validateRetiredTree(
        retained,
        [],
        new Set(['tests/unit/example.test.ts']),
        new Map([['tests/unit/example.test.ts', 'frontend-only']]),
      ),
    ).not.toThrow();
  });

  it('does not allow executable coverage to be classified as historical-only', () => {
    const historical = smallLedgerCandidate({
      disposition: {
        kind: 'historical-only',
        reasonCode: 'host-specific-noncontract',
        rationale:
          'This fixture contains only a retired host implementation detail and no product behavior.',
        archiveEvidence: 'docs/legacy-typescript-retirement.md',
      },
    });
    expect(() => decodeLegacyTestRetirementLedger(historical)).toThrow(
      'cannot be historical-only',
    );
  });

  it('wires the focused verifier into the shared gate', async () => {
    const packageCandidate: unknown = JSON.parse(
      await readFile('package.json', 'utf8'),
    );
    const scripts = object(Reflect.get(object(packageCandidate), 'scripts'));
    expect(Reflect.get(scripts, 'verify:legacy-retirement')).toBe(
      'node --experimental-strip-types scripts/verify-legacy-retirement.mts',
    );
    expect(Reflect.get(scripts, 'verify')).toContain(
      'npm run verify:migration-closure && npm run verify:legacy-retirement',
    );
  });
});

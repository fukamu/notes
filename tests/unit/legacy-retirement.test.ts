import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  decodeLegacyTestRetirementLedger,
  legacyTestCorpusDigest,
  selectLegacyTestCorpus,
  validateExecutableEvidence,
  validateLedgerClosure,
  validateNamedGoTestEvidence,
  validateReferenceCorpus,
  validateRetiredPackageLock,
  validateRetiredRepository,
  validateRetiredTree,
} from '../../scripts/legacy-retirement-core.mts';
import { decodeMigrationClosure } from '../../scripts/migration-closure-core.mts';

const legacyImport = ['@/', ['ser', 'ver/example'].join('')].join('');
const legacyHostName = ['Mini', 'flare'].join('');
const legacyPath = (root: string, suffix: string) => [root, suffix].join('/');
const legacyConfig = (stem: string, suffix: string) => [stem, suffix].join('.');
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
    schemaVersion: 3,
    selectionVersion: 2,
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
      files: 142,
      sha256:
        '878036f18d5bbfc107ad8f7873f5c9c942145b61d20f9c508a138ed797c1fc1e',
    });
    expect(
      ledger.entries.filter(
        ({ disposition }) => disposition.kind === 'retained-frontend',
      ),
    ).toHaveLength(11);
    expect(
      ledger.entries.filter(
        ({ disposition }) => disposition.kind === 'retained-tooling',
      ),
    ).toHaveLength(4);
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

  it('classifies every literal-dependent tooling test and binds server checks to Go evidence', async () => {
    const ledger = decodeLegacyTestRetirementLedger(await ledgerCandidate());
    const entries = new Map(
      ledger.entries.map((entry) => [entry.legacyPath, entry]),
    );
    for (const path of [
      'tests/unit/architecture.test.ts',
      'tests/unit/migration-closure.test.ts',
      'tests/unit/release-artifact.test.ts',
      'tests/unit/typecheck-config.test.ts',
    ]) {
      expect(entries.get(path)?.disposition.kind).toBe('retained-tooling');
    }
    const architecture = entries.get('tests/unit/architecture.test.ts');
    const typecheck = entries.get('tests/unit/typecheck-config.test.ts');
    if (
      architecture?.disposition.kind !== 'retained-tooling' ||
      typecheck?.disposition.kind !== 'retained-tooling'
    ) {
      throw new TypeError('server tooling evidence is not retained');
    }
    expect(architecture.disposition.evidence).toContain(
      'backend/internal/architecture/dependency_test.go',
    );
    expect(typecheck.disposition.evidence).toContain(
      'backend/internal/architecture/dependency_test.go',
    );
  });

  it('binds cross-cutting auth, signup, and checkout coverage to exact Go tests', async () => {
    const ledger = decodeLegacyTestRetirementLedger(await ledgerCandidate());
    const entries = new Map(
      ledger.entries.map((entry) => [entry.legacyPath, entry]),
    );
    const expected = new Map<
      string,
      Readonly<{
        featureIds: readonly string[];
        anchors: readonly Readonly<{ path: string; testName: string }>[];
      }>
    >([
      [
        'tests/integration/auth-security-corpus.test.ts',
        {
          featureIds: ['F04', 'F05', 'F06', 'F07', 'F08'],
          anchors: [
            {
              path: 'backend/internal/adapters/oidc/provider_test.go',
              testName: 'TestCryptoSecretsAndPkce',
            },
            {
              path: 'backend/internal/adapters/otp/crypto_test.go',
              testName: 'TestHasherBindsEveryContextValueAndPepper',
            },
            {
              path: 'backend/internal/identity/boundary_test.go',
              testName: 'TestCSRFPolicy',
            },
            {
              path: 'backend/internal/identity/email_otp_boundary_test.go',
              testName: 'TestEmailOtpCompleteHasExactlyOneConcurrentWinner',
            },
            {
              path: 'backend/internal/identity/email_otp_test.go',
              testName: 'TestEmailOtpChallengeLifecycle',
            },
            {
              path: 'backend/internal/identity/oidc_boundary_test.go',
              testName: 'TestGoogleOidcCompletionConsumesOnce',
            },
            {
              path: 'backend/internal/identity/oidc_test.go',
              testName: 'TestOidcTransactionAndClaimsValidation',
            },
            {
              path: 'backend/internal/identity/session_test.go',
              testName: 'TestSessionLifecycle',
            },
            {
              path: 'backend/tests/integration/session_store_test.go',
              testName: 'TestSessionStorePostgres',
            },
          ],
        },
      ],
      [
        'tests/integration/signup-admission.test.ts',
        {
          featureIds: ['F04', 'F05', 'F06', 'F07', 'F08', 'F21'],
          anchors: [
            {
              path: 'backend/internal/identity/email_otp_boundary_test.go',
              testName: 'TestEmailOtpCompletionAdmitsOnlyMatchingSignupReceipt',
            },
            {
              path: 'backend/internal/identity/oidc_boundary_test.go',
              testName: 'TestGoogleOidcCompletionAdmitsSignupOnlyWithConsent',
            },
            {
              path: 'backend/internal/identity/signup_boundary_test.go',
              testName:
                'TestSignupApplicationCreatesAndReplaysWithFreshHashedSession',
            },
            {
              path: 'backend/internal/identity/signup_test.go',
              testName:
                'TestSignupAdmissionPlanBindsIdentitySubmissionAndOwner',
            },
            {
              path: 'backend/internal/legal/terms_service_test.go',
              testName: 'TestSignupTermsAdmissionPreservesReplayEvidence',
            },
            {
              path: 'backend/tests/integration/identity_signup_test.go',
              testName: 'TestIdentityAndSignupPostgres',
            },
          ],
        },
      ],
      [
        'tests/unit/billing-checkout-http-handler.test.ts',
        {
          featureIds: ['F04', 'F17', 'F18', 'F19', 'F20', 'F21', 'F22'],
          anchors: [
            {
              path: 'backend/internal/billing/cancellation_test.go',
              testName:
                'TestCancellationServiceRedactsProviderAndRepositoryFailures',
            },
            {
              path: 'backend/internal/httpapi/billing_cancellation_test.go',
              testName:
                'TestBillingCancellationContractAuthenticatesBeforeReadingOrUsingOwnerInput',
            },
            {
              path: 'backend/internal/httpapi/legal_test.go',
              testName: 'TestLegalCheckoutHandlersPreserveHTTPContract',
            },
            {
              path: 'backend/internal/httpapi/legal_test.go',
              testName:
                'TestLegalHandlersAuthorizeBeforeReadingAndRejectInvalidBodies',
            },
            {
              path: 'backend/internal/httpapi/legal_test.go',
              testName:
                'TestLegalHandlersMapApplicationFailuresAndSanitizePanics',
            },
            {
              path: 'backend/internal/legal/contract_test.go',
              testName:
                'TestContractCheckoutRecordsEvidenceBeforeProviderAndReplaysLostResponse',
            },
          ],
        },
      ],
      [
        'tests/unit/signup-admission.test.ts',
        {
          featureIds: ['F04', 'F07', 'F08', 'F21'],
          anchors: [
            {
              path: 'backend/internal/identity/signup_boundary_test.go',
              testName:
                'TestSignupApplicationCreatesAndReplaysWithFreshHashedSession',
            },
            {
              path: 'backend/internal/identity/signup_test.go',
              testName:
                'TestSignupAdmissionPlanBindsIdentitySubmissionAndOwner',
            },
            {
              path: 'backend/tests/integration/identity_signup_test.go',
              testName: 'TestIdentityAndSignupPostgres',
            },
          ],
        },
      ],
    ]);

    for (const [legacyPath, contract] of expected) {
      const entry = entries.get(legacyPath);
      expect(entry?.featureIds).toEqual(contract.featureIds);
      if (entry?.disposition.kind !== 'go-replacement') {
        throw new TypeError(`missing anchored Go replacement: ${legacyPath}`);
      }
      expect(entry.disposition.evidenceAnchors).toEqual(contract.anchors);
      expect(entry.disposition.evidence).toEqual([
        ...new Set(contract.anchors.map(({ path }) => path)),
      ]);
      for (const anchor of contract.anchors) {
        const source = await readFile(anchor.path, 'utf8');
        expect(() =>
          validateNamedGoTestEvidence(anchor.path, source, anchor.testName),
        ).not.toThrow();
      }
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
    Reflect.set(object(duplicate), 'files', 143);
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

  it('selects literal roots, relative imports, and their transitive test consumers', () => {
    const architecture = `const ${['ro', 'ots'].join('')} = ['app', '${[
      'ser',
      'ver',
    ].join('')}'];`;
    const relativeImport = `import '../../${legacyPath('server', 'core/session')}';`;
    const selected = selectLegacyTestCorpus([
      { path: 'tests/unit/architecture.test.ts', content: architecture },
      { path: 'tests/unit/relative.test.ts', content: relativeImport },
      {
        path: 'tests/unit/consumer.test.ts',
        content: "import './relative.test';",
      },
      {
        path: 'tests/unit/frontend.test.ts',
        content: "const choice = 'server';",
      },
      {
        path: 'tests/unit/root-import.test.ts',
        content: `import '${['@', legacyPath('', 'server')].join('')}';`,
      },
    ]);

    expect(selected.map(({ path }) => path)).toEqual([
      'tests/unit/architecture.test.ts',
      'tests/unit/consumer.test.ts',
      'tests/unit/relative.test.ts',
      'tests/unit/root-import.test.ts',
    ]);
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
    expect(() =>
      validateNamedGoTestEvidence(
        goEvidence,
        'package example\nfunc TestExactContract(t *testing.T) {}\n',
        'TestExactContract',
      ),
    ).not.toThrow();
    expect(() =>
      validateNamedGoTestEvidence(
        goEvidence,
        'package example\nfunc TestOtherContract(t *testing.T) {}\n',
        'TestExactContract',
      ),
    ).toThrow('missing named test');

    const anchored = decodeLegacyTestRetirementLedger(
      smallLedgerCandidate({
        disposition: {
          kind: 'go-replacement',
          evidence: [goEvidence],
          evidenceAnchors: [
            { path: goEvidence, testName: 'TestExactContract' },
          ],
        },
      }),
    );
    const anchoredEntry = anchored.entries[0];
    if (anchoredEntry?.disposition.kind !== 'go-replacement') {
      throw new TypeError('anchored replacement fixture is missing');
    }
    expect(anchoredEntry.disposition.evidenceAnchors).toEqual([
      { path: goEvidence, testName: 'TestExactContract' },
    ]);

    expect(() =>
      decodeLegacyTestRetirementLedger(
        smallLedgerCandidate({
          disposition: {
            kind: 'go-replacement',
            evidence: [goEvidence],
            evidenceAnchors: [
              {
                path: 'backend/internal/example/other_test.go',
                testName: 'TestExactContract',
              },
            ],
          },
        }),
      ),
    ).toThrow('not disposition evidence');
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
    ).toThrow('retained test path is missing');
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

  it('rejects retired roots, configs, scripts, and dependencies', () => {
    const cleanPackage = {
      scripts: { build: 'vite build', start: 'go -C backend run ./cmd/notes' },
      dependencies: { react: '19.2.6' },
      devDependencies: { vitest: '5.0.0' },
    };
    expect(() =>
      validateRetiredRepository(
        new Set(['backend/cmd/notes/main.go', 'frontend/entry-client.tsx']),
        cleanPackage,
      ),
    ).not.toThrow();

    for (const path of [
      legacyPath('app', 'api/sync/route.ts'),
      legacyPath('db', 'schema.ts'),
      legacyPath('drizzle', '0000.sql'),
      legacyPath('server', 'core/session.ts'),
      legacyPath('.openai', 'hosting.json'),
      legacyConfig('drizzle', 'config.ts'),
      legacyConfig('tsconfig', 'api.json'),
      legacyConfig('vitest', 'server-load.config.ts'),
    ]) {
      expect(() =>
        validateRetiredRepository(new Set([path]), cleanPackage),
      ).toThrow('retired server');
    }
    for (const name of ['db:generate', 'lint:api', 'typecheck:api']) {
      expect(() =>
        validateRetiredRepository(new Set(), {
          ...cleanPackage,
          scripts: { ...cleanPackage.scripts, [name]: 'retired command' },
        }),
      ).toThrow('retired server script');
    }
    for (const name of [
      '@cloudflare/workers-types',
      'drizzle-kit',
      'drizzle-orm',
      'miniflare',
    ]) {
      expect(() =>
        validateRetiredRepository(new Set(), {
          ...cleanPackage,
          dependencies: { ...cleanPackage.dependencies, [name]: '1' },
        }),
      ).toThrow('retired server dependency');
    }
    for (const alias of [
      `npm:${['mini', 'flare'].join('')}@4.0.0`,
      `npm:${['@cloudflare', 'workers-types'].join('/')}@4.0.0`,
    ]) {
      expect(() =>
        validateRetiredRepository(new Set(), {
          ...cleanPackage,
          dependencies: { ...cleanPackage.dependencies, replacement: alias },
        }),
      ).toThrow('retired server dependency');
    }
    expect(() =>
      validateRetiredRepository(new Set(), {
        ...cleanPackage,
        overrides: {
          react: { replacement: `npm:${['drizzle', 'orm'].join('-')}@1` },
        },
      }),
    ).toThrow('retired server dependency');
    for (const command of [
      `oxlint ${legacyPath('app', 'api')}`,
      `oxlint ${['db', 'server'].join(' ')}`,
      `tsc ${legacyPath('db', 'schema.ts')}`,
      `node ${legacyPath('drizzle', 'migrate.mjs')}`,
      `oxlint ${legacyPath('server', '**/*.ts')}`,
      `node ./${legacyPath('server', 'index.ts')}`,
      `tsc ./${legacyPath('db', 'schema.ts')}`,
      `node ./${legacyPath('app', 'api/sync.ts')}`,
      `tsc -p ${legacyConfig('tsconfig', 'api.json')}`,
      `node ${legacyPath('.openai', 'hosting.json')}`,
    ]) {
      expect(() =>
        validateRetiredRepository(new Set(), {
          ...cleanPackage,
          scripts: { ...cleanPackage.scripts, check: command },
        }),
      ).toThrow('references retired server code');
    }
  });

  it('rejects retired direct and transitive package-lock entries', () => {
    const cleanLock = {
      packages: {
        '': { dependencies: { react: '19' }, devDependencies: { vitest: '5' } },
        'node_modules/react': { version: '19.2.6' },
      },
    };
    expect(() => validateRetiredPackageLock(cleanLock)).not.toThrow();
    for (const name of [
      '@cloudflare/workers-types',
      'drizzle-kit',
      'drizzle-orm',
      'miniflare',
    ]) {
      expect(() =>
        validateRetiredPackageLock({
          packages: {
            ...cleanLock.packages,
            [`node_modules/${name}`]: { version: '1.0.0' },
          },
        }),
      ).toThrow('retired server dependency is locked');
    }
    expect(() =>
      validateRetiredPackageLock({
        packages: {
          ...cleanLock.packages,
          'node_modules/replacement': {
            name: ['mini', 'flare'].join(''),
            version: '4.0.0',
          },
        },
      }),
    ).toThrow('retired server dependency is locked');
    expect(() =>
      validateRetiredPackageLock({
        packages: {
          ...cleanLock.packages,
          '': {
            ...cleanLock.packages[''],
            optionalDependencies: {
              replacement: `npm:${['drizzle', 'orm'].join('-')}@1`,
            },
          },
        },
      }),
    ).toThrow('retired server dependency is locked');
    expect(() =>
      validateRetiredPackageLock({
        packages: {
          ...cleanLock.packages,
          'node_modules/replacement': {
            version: '1.0.0',
            resolved: `https://registry.npmjs.org/${encodeURIComponent(
              ['@cloudflare', 'workers-types'].join('/'),
            ).toLowerCase()}/-/workers-types-1.0.0.tgz`,
          },
        },
      }),
    ).toThrow('retired server dependency is locked');
  });

  it('rejects renamed server-only TypeScript identity contracts without blocking browser contracts', () => {
    const browserContract = {
      path: 'lib/application/external-transmission.ts',
      content: "const destination = 'google-oidc';",
    };
    expect(() =>
      validateRetiredRepository(
        new Set([browserContract.path]),
        { scripts: {} },
        [browserContract],
      ),
    ).not.toThrow();

    const renamedServerContract = {
      path: 'lib/domain/provider-login.ts',
      content: `export type ${['Oidc', 'Nonce'].join('')} = string;`,
    };
    expect(() =>
      validateRetiredRepository(
        new Set([renamedServerContract.path]),
        { scripts: {} },
        [renamedServerContract],
      ),
    ).toThrow('server-only TypeScript contract');
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

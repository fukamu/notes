import { createHash } from 'node:crypto';

export const legacyRetirementSchemaVersion = 1;
export const legacyTestSelectionVersion = 1;
export const legacyTestMatcher =
  /@\/(?:server|db|app\/api)|Miniflare|cloudflare:workers/u;

const digestPattern = /^[a-f0-9]{64}$/u;
const revisionPattern = /^[a-f0-9]{40}$/u;
const featurePattern = /^F(?:0[1-9]|1[0-9]|2[0-8])$/u;
const executableLegacyTestPattern =
  /(?:\.benchmark\.test|\.test|\.spec)\.[cm]?[jt]sx?$/u;
const vitestEvidencePattern =
  /^tests\/(?:unit|integration|contracts)\/.+\.test\.ts$/u;
const playwrightEvidencePattern = /^tests\/e2e\/.+\.spec\.ts$/u;
const goEvidencePattern = /^backend\/.+_test\.go$/u;
const goIntegrationEvidencePattern =
  /^backend\/tests\/integration\/.+_test\.go$/u;
const typescriptTestDeclarationPattern =
  /(?:^|[^A-Za-z0-9_$])(?:describe|it|test)\s*\(/mu;
const goTestDeclarationPattern = /^func Test[A-Za-z0-9_]*\s*\(/mu;

export type LegacyTestCorpusEntry = Readonly<{
  path: string;
  sha256: string;
}>;

export type TrackedTextFile = Readonly<{
  path: string;
  content: string;
}>;

type RetainedFrontendDisposition = Readonly<{
  kind: 'retained-frontend';
  currentPath: string;
  evidence: readonly string[];
}>;

type GoReplacementDisposition = Readonly<{
  kind: 'go-replacement';
  evidence: readonly string[];
}>;

type HistoricalOnlyDisposition = Readonly<{
  kind: 'historical-only';
  reasonCode: 'host-specific-noncontract' | 'support-only';
  rationale: string;
  archiveEvidence: 'docs/legacy-typescript-retirement.md';
}>;

export type LegacyTestDisposition =
  | RetainedFrontendDisposition
  | GoReplacementDisposition
  | HistoricalOnlyDisposition;

export type LegacyTestRetirementEntry = Readonly<{
  legacyPath: string;
  legacySha256: string;
  featureIds: readonly string[];
  disposition: LegacyTestDisposition;
}>;

export type LegacyTestRetirementLedger = Readonly<{
  legacySourceRevision: string;
  testCorpusRevision: string;
  files: number;
  sha256: string;
  entries: readonly LegacyTestRetirementEntry[];
}>;

export type RetirementClosureBinding = Readonly<{
  phase: 'reference-present' | 'retired';
  sourceRevision: string;
  testCorpusRevision: string;
  files: number;
  sha256: string;
  features: readonly Readonly<{
    id: string;
    migration: 'migrated' | 'blocked-existing-work' | 'intentionally-absent';
  }>[];
}>;

export function decodeLegacyTestRetirementLedger(
  candidate: unknown,
): LegacyTestRetirementLedger {
  const root = exactRecord(candidate, 'legacy test retirement ledger', [
    'schemaVersion',
    'selectionVersion',
    'legacySourceRevision',
    'testCorpusRevision',
    'files',
    'sha256',
    'entries',
  ]);
  if (
    integer(root.schemaVersion, 'legacy retirement schema version') !==
    legacyRetirementSchemaVersion
  ) {
    throw new TypeError('legacy retirement schema version is unsupported');
  }
  if (
    integer(root.selectionVersion, 'legacy test selection version') !==
    legacyTestSelectionVersion
  ) {
    throw new TypeError('legacy test selection version is unsupported');
  }
  const entries = array(root.entries, 'legacy retirement entries').map(
    decodeEntry,
  );
  requireSortedUnique(
    entries.map(({ legacyPath }) => legacyPath),
    'legacy test path',
  );
  const files = positiveInteger(root.files, 'legacy test corpus files');
  if (entries.length !== files) {
    throw new TypeError('legacy retirement entry count does not match corpus');
  }
  const sha256 = digest(root.sha256, 'legacy test corpus digest');
  if (legacyTestCorpusDigest(entries) !== sha256) {
    throw new TypeError('legacy retirement entry digest does not match corpus');
  }
  return {
    legacySourceRevision: revision(
      root.legacySourceRevision,
      'legacy source revision',
    ),
    testCorpusRevision: revision(
      root.testCorpusRevision,
      'legacy test corpus revision',
    ),
    files,
    sha256,
    entries,
  };
}

export function selectLegacyTestCorpus(
  files: readonly TrackedTextFile[],
): readonly LegacyTestCorpusEntry[] {
  const ordered = [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  requireSortedUnique(
    ordered.map(({ path }) => repositoryPath(path, 'tracked test path')),
    'tracked test path',
  );
  return ordered
    .filter(({ content }) => legacyTestMatcher.test(content))
    .map(({ path, content }) => ({
      path,
      sha256: createHash('sha256').update(content).digest('hex'),
    }));
}

export function legacyTestCorpusDigest(
  entries: readonly Readonly<{
    path?: string;
    legacyPath?: string;
    sha256?: string;
    legacySha256?: string;
  }>[],
): string {
  const encoded = entries
    .map((entry) => {
      const path = entry.path ?? entry.legacyPath;
      const sha256 = entry.sha256 ?? entry.legacySha256;
      if (path === undefined || sha256 === undefined) {
        throw new TypeError('legacy corpus entry is incomplete');
      }
      return `${sha256}  ${path}\n`;
    })
    .join('');
  return createHash('sha256').update(encoded).digest('hex');
}

export function validateLedgerClosure(
  ledger: LegacyTestRetirementLedger,
  closure: RetirementClosureBinding,
): void {
  if (ledger.legacySourceRevision !== closure.sourceRevision) {
    throw new TypeError('legacy source revision does not match closure');
  }
  if (ledger.testCorpusRevision !== closure.testCorpusRevision) {
    throw new TypeError('legacy test corpus revision does not match closure');
  }
  if (ledger.files !== closure.files || ledger.sha256 !== closure.sha256) {
    throw new TypeError('legacy test corpus does not match closure');
  }
  const features = new Map(
    closure.features.map((feature) => [feature.id, feature.migration]),
  );
  for (const entry of ledger.entries) {
    for (const featureId of entry.featureIds) {
      const migration = features.get(featureId);
      if (migration === undefined) {
        throw new TypeError(
          `legacy retirement entry references unknown feature: ${featureId}`,
        );
      }
      if (migration === 'intentionally-absent') {
        throw new TypeError(
          `legacy retirement evidence cannot claim absent feature: ${featureId}`,
        );
      }
    }
  }
}

export function validateReferenceCorpus(
  ledger: LegacyTestRetirementLedger,
  current: readonly LegacyTestCorpusEntry[],
): void {
  if (current.length !== ledger.entries.length) {
    throw new TypeError('legacy TypeScript test corpus file count drifted');
  }
  for (let index = 0; index < ledger.entries.length; index += 1) {
    const recorded = ledger.entries[index];
    const observed = current[index];
    if (
      recorded === undefined ||
      observed === undefined ||
      recorded.legacyPath !== observed.path ||
      recorded.legacySha256 !== observed.sha256
    ) {
      throw new TypeError('legacy TypeScript test corpus content drifted');
    }
  }
  if (legacyTestCorpusDigest(current) !== ledger.sha256) {
    throw new TypeError('legacy TypeScript test corpus digest drifted');
  }
}

export function validateRetiredTree(
  ledger: LegacyTestRetirementLedger,
  currentLegacyCorpus: readonly LegacyTestCorpusEntry[],
  trackedPaths: ReadonlySet<string>,
  currentSources: ReadonlyMap<string, string>,
): void {
  if (currentLegacyCorpus.length !== 0) {
    throw new TypeError('retired tree still contains legacy-dependent tests');
  }
  for (const entry of ledger.entries) {
    switch (entry.disposition.kind) {
      case 'retained-frontend': {
        if (!trackedPaths.has(entry.disposition.currentPath)) {
          throw new TypeError(
            `retained frontend path is missing: ${entry.disposition.currentPath}`,
          );
        }
        const source = currentSources.get(entry.disposition.currentPath);
        if (source === undefined) {
          throw new TypeError(
            `retained frontend source is unreadable: ${entry.disposition.currentPath}`,
          );
        }
        if (legacyTestMatcher.test(source)) {
          throw new TypeError(
            `retained frontend path still depends on legacy server code: ${entry.disposition.currentPath}`,
          );
        }
        for (const evidencePath of entry.disposition.evidence) {
          const evidenceSource = currentSources.get(evidencePath);
          if (
            evidenceSource !== undefined &&
            (vitestEvidencePattern.test(evidencePath) ||
              playwrightEvidencePattern.test(evidencePath)) &&
            legacyTestMatcher.test(evidenceSource)
          ) {
            throw new TypeError(
              `retained frontend evidence still depends on legacy server code: ${evidencePath}`,
            );
          }
        }
        break;
      }
      case 'go-replacement':
      case 'historical-only':
        if (trackedPaths.has(entry.legacyPath)) {
          throw new TypeError(
            `retired legacy test path is still tracked: ${entry.legacyPath}`,
          );
        }
        break;
      default:
        assertNever(entry.disposition);
    }
  }
}

export function validateExecutableEvidence(
  evidencePath: string,
  source: string,
): 'go-integration' | 'go-unit' | 'playwright' | 'vitest' {
  repositoryPath(evidencePath, 'legacy retirement evidence path');
  if (vitestEvidencePattern.test(evidencePath)) {
    requireTypeScriptTestDeclaration(evidencePath, source);
    return 'vitest';
  }
  if (playwrightEvidencePattern.test(evidencePath)) {
    requireTypeScriptTestDeclaration(evidencePath, source);
    return 'playwright';
  }
  if (!goEvidencePattern.test(evidencePath)) {
    throw new TypeError(
      `legacy retirement evidence is not executed by the shared gate: ${evidencePath}`,
    );
  }
  if (!goTestDeclarationPattern.test(source)) {
    throw new TypeError(
      `legacy retirement Go evidence has no named test: ${evidencePath}`,
    );
  }
  if (goIntegrationEvidencePattern.test(evidencePath)) {
    if (!/^\/\/go:build integration\r?\n/u.test(source)) {
      throw new TypeError(
        `legacy retirement integration evidence lacks its build tag: ${evidencePath}`,
      );
    }
    return 'go-integration';
  }
  if (source.startsWith('//go:build ')) {
    throw new TypeError(
      `legacy retirement Go unit evidence has an unverified build tag: ${evidencePath}`,
    );
  }
  return 'go-unit';
}

export function evidencePaths(
  ledger: LegacyTestRetirementLedger,
): readonly string[] {
  const result = new Set<string>();
  for (const entry of ledger.entries) {
    if (entry.disposition.kind !== 'historical-only') {
      for (const path of entry.disposition.evidence) result.add(path);
    }
    if (entry.disposition.kind === 'retained-frontend') {
      result.add(entry.disposition.currentPath);
    }
  }
  return [...result].sort();
}

function decodeEntry(candidate: unknown): LegacyTestRetirementEntry {
  const value = exactRecord(candidate, 'legacy retirement entry', [
    'legacyPath',
    'legacySha256',
    'featureIds',
    'disposition',
  ]);
  const legacyPath = repositoryPath(value.legacyPath, 'legacy test path');
  if (!legacyPath.startsWith('tests/')) {
    throw new TypeError('legacy test path must be below tests');
  }
  const featureIds = uniqueStrings(value.featureIds, 'legacy feature ids');
  if (
    featureIds.length === 0 ||
    featureIds.some((id) => !featurePattern.test(id))
  ) {
    throw new TypeError('legacy feature ids are incomplete');
  }
  requireSortedUnique(featureIds, 'legacy feature id');
  return {
    legacyPath,
    legacySha256: digest(value.legacySha256, 'legacy test digest'),
    featureIds,
    disposition: decodeDisposition(value.disposition, legacyPath),
  };
}

function decodeDisposition(
  candidate: unknown,
  legacyPath: string,
): LegacyTestDisposition {
  const base = record(candidate, 'legacy retirement disposition');
  const kind = boundedString(
    base.kind,
    'legacy retirement disposition kind',
    32,
  );
  switch (kind) {
    case 'retained-frontend': {
      const value = exactRecord(candidate, 'retained frontend disposition', [
        'kind',
        'currentPath',
        'evidence',
      ]);
      const evidence = evidenceList(
        value.evidence,
        'retained frontend evidence',
      );
      if (
        !evidence.some(
          (path) =>
            vitestEvidencePattern.test(path) ||
            playwrightEvidencePattern.test(path),
        )
      ) {
        throw new TypeError(
          'retained frontend disposition requires frontend test evidence',
        );
      }
      return {
        kind,
        currentPath: repositoryPath(
          value.currentPath,
          'retained frontend current path',
        ),
        evidence,
      };
    }
    case 'go-replacement': {
      const value = exactRecord(candidate, 'Go replacement disposition', [
        'kind',
        'evidence',
      ]);
      const evidence = evidenceList(value.evidence, 'Go replacement evidence');
      if (!evidence.every((path) => goEvidencePattern.test(path))) {
        throw new TypeError('Go replacement requires only Go test evidence');
      }
      return { kind, evidence };
    }
    case 'historical-only': {
      const value = exactRecord(candidate, 'historical-only disposition', [
        'kind',
        'reasonCode',
        'rationale',
        'archiveEvidence',
      ]);
      if (executableLegacyTestPattern.test(legacyPath)) {
        throw new TypeError(
          'executable legacy tests cannot be historical-only evidence',
        );
      }
      const reasonCode = enumValue(
        value.reasonCode,
        'historical-only reason code',
        ['host-specific-noncontract', 'support-only'] as const,
      );
      const rationale = boundedString(
        value.rationale,
        'historical-only rationale',
        600,
      );
      if (rationale.length < 40) {
        throw new TypeError('historical-only rationale is incomplete');
      }
      return {
        kind,
        reasonCode,
        rationale,
        archiveEvidence: exactString(
          value.archiveEvidence,
          'historical archive evidence',
          'docs/legacy-typescript-retirement.md',
        ),
      };
    }
    default:
      throw new TypeError('legacy retirement disposition kind is invalid');
  }
}

function evidenceList(value: unknown, label: string): readonly string[] {
  const evidence = uniqueStrings(value, label).map((path) =>
    repositoryPath(path, label),
  );
  if (evidence.length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  requireSortedUnique(evidence, label);
  return evidence;
}

function exactRecord(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  const result = record(value, label);
  const keys = Object.keys(result).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
  return result;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function uniqueStrings(value: unknown, label: string): readonly string[] {
  const result = array(value, label).map((candidate) =>
    boundedString(candidate, `${label} value`, 600),
  );
  if (new Set(result).size !== result.length) {
    throw new TypeError(`${label} must be unique`);
  }
  return result;
}

function requireSortedUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} must be unique`);
  }
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (
      previous === undefined ||
      current === undefined ||
      previous >= current
    ) {
      throw new TypeError(`${label} must be sorted`);
    }
  }
}

function repositoryPath(value: unknown, label: string): string {
  const result = boundedString(value, label, 300);
  const segments = result.split('/');
  if (
    result.startsWith('/') ||
    result.startsWith('.') ||
    result.endsWith('/') ||
    result.includes('\\') ||
    segments.includes('.') ||
    segments.includes('..') ||
    result.includes('//')
  ) {
    throw new TypeError(`${label} is unsafe`);
  }
  return result;
}

function requireTypeScriptTestDeclaration(
  evidencePath: string,
  source: string,
): void {
  if (!typescriptTestDeclarationPattern.test(source)) {
    throw new TypeError(
      `legacy retirement TypeScript evidence has no named test: ${evidencePath}`,
    );
  }
}

function revision(value: unknown, label: string): string {
  const result = boundedString(value, label, 40);
  if (!revisionPattern.test(result)) throw new TypeError(`${label} is invalid`);
  return result;
}

function digest(value: unknown, label: string): string {
  const result = boundedString(value, label, 64);
  if (!digestPattern.test(result)) throw new TypeError(`${label} is invalid`);
  return result;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result < 1) throw new TypeError(`${label} must be positive`);
  return result;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    containsControl(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function containsControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

function exactString<const T extends string>(
  value: unknown,
  label: string,
  expected: T,
): T {
  const result = boundedString(value, label, expected.length);
  if (result !== expected) throw new TypeError(`${label} is invalid`);
  return expected;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  label: string,
  choices: T,
): T[number] {
  if (typeof value !== 'string') throw new TypeError(`${label} is invalid`);
  const selected = choices.find((choice) => choice === value);
  if (selected === undefined) throw new TypeError(`${label} is invalid`);
  return selected;
}

function assertNever(value: never): never {
  throw new TypeError(
    `unsupported legacy retirement disposition: ${JSON.stringify(value)}`,
  );
}

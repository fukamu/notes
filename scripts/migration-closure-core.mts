export const migrationClosureSchemaVersion = 2;

const shaPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const featureIDs = numberedIDs('F', 28);
const verificationIDs = numberedIDs('V', 12);

export type MigrationClosure = Readonly<{
  baseline: Readonly<{
    mainRevision: string;
    legacyRetirementRevision: string;
    integrationBranch: string;
  }>;
  features: readonly FeatureEvidence[];
  verifications: readonly VerificationEvidence[];
  retirement: RetirementEvidence;
}>;

export type FeatureEvidence = Readonly<{
  id: string;
  state: 'A' | 'B' | 'C' | 'A/B' | 'B/C';
  migration: 'migrated' | 'blocked-existing-work' | 'intentionally-absent';
  verification: readonly string[];
  goEvidence: readonly string[];
  dependencies: readonly string[];
  note: string | undefined;
}>;

export type VerificationEvidence = Readonly<{
  id: string;
  status: 'complete' | 'approval-pending' | 'in-progress';
  evidence: readonly string[];
  note: string | undefined;
}>;

export type RetirementEvidence = Readonly<{
  phase: 'reference-present' | 'retired';
  sourceRevision: string;
  sourceTrees: readonly Readonly<{ path: string; gitTree: string }>[];
  legacyTestCorpus: Readonly<{
    revision: string;
    files: number;
    sha256: string;
  }>;
  groups: readonly Readonly<{
    id: string;
    features: readonly string[];
    legacyPrefixes: readonly string[];
  }>[];
}>;

export function decodeMigrationClosure(candidate: unknown): MigrationClosure {
  const root = record(candidate, 'migration closure');
  if (
    integer(root.schemaVersion, 'schema version') !==
    migrationClosureSchemaVersion
  ) {
    throw new TypeError('migration closure schema version is unsupported');
  }
  const baselineRecord = record(root.baseline, 'migration baseline');
  const baseline = {
    mainRevision: revision(baselineRecord.mainRevision, 'main revision'),
    legacyRetirementRevision: revision(
      baselineRecord.legacyRetirementRevision,
      'legacy retirement revision',
    ),
    integrationBranch: exactString(
      baselineRecord.integrationBranch,
      'integration branch',
      'integration/409-go-backend-migration',
    ),
  };
  const features = array(root.features, 'feature evidence').map(decodeFeature);
  requireExactIDs(
    features.map(({ id }) => id),
    featureIDs,
    'feature',
  );
  const verifications = array(root.verifications, 'verification evidence').map(
    decodeVerification,
  );
  requireExactIDs(
    verifications.map(({ id }) => id),
    verificationIDs,
    'verification',
  );
  const verificationSet = new Set(verificationIDs);
  for (const feature of features) {
    for (const id of feature.verification) {
      if (!verificationSet.has(id)) {
        throw new TypeError('feature references an unknown verification');
      }
    }
  }
  const retirement = decodeRetirement(root.retirement);
  if (retirement.sourceRevision !== baseline.legacyRetirementRevision) {
    throw new TypeError('retirement revision does not match the baseline');
  }
  const retirementVerification = verifications.find(({ id }) => id === 'V11');
  if (
    retirement.phase === 'retired' &&
    retirementVerification?.status !== 'complete'
  ) {
    throw new TypeError('retired phase requires complete V11 verification');
  }
  const knownFeatures = new Set(featureIDs);
  for (const group of retirement.groups) {
    for (const id of group.features) {
      if (!knownFeatures.has(id)) {
        throw new TypeError('retirement group references an unknown feature');
      }
    }
  }
  return { baseline, features, verifications, retirement };
}

export function validateLegacyCoverage(
  paths: readonly string[],
  groups: RetirementEvidence['groups'],
): void {
  for (const path of paths) {
    const owners = groups.filter(({ legacyPrefixes }) =>
      legacyPrefixes.some(
        (prefix) => path === prefix || path.startsWith(prefix),
      ),
    );
    if (owners.length !== 1) {
      throw new TypeError(
        owners.length === 0
          ? `legacy source is not recorded: ${path}`
          : `legacy source has multiple retirement owners: ${path}`,
      );
    }
  }
}

function decodeFeature(candidate: unknown): FeatureEvidence {
  const value = record(candidate, 'feature evidence');
  const id = boundedString(value.id, 'feature id', 3);
  const state = enumValue(value.state, 'feature state', [
    'A',
    'B',
    'C',
    'A/B',
    'B/C',
  ] as const);
  const migration = enumValue(value.migration, 'feature migration', [
    'migrated',
    'blocked-existing-work',
    'intentionally-absent',
  ] as const);
  const verification = uniqueStrings(
    value.verification,
    'feature verification',
  );
  const goEvidence = paths(value.goEvidence, 'feature Go evidence');
  const dependencies =
    value.dependencies === undefined
      ? []
      : uniqueStrings(value.dependencies, 'feature dependencies');
  const note = optionalString(value.note, 'feature note', 600);
  if (verification.length === 0) {
    throw new TypeError('feature verification must not be empty');
  }
  if (migration === 'migrated' && goEvidence.length === 0) {
    throw new TypeError('migrated feature requires Go evidence');
  }
  if (migration === 'blocked-existing-work' && dependencies.length === 0) {
    throw new TypeError('blocked feature requires a dependency');
  }
  if (migration === 'intentionally-absent' && note === undefined) {
    throw new TypeError('intentionally absent feature requires a note');
  }
  return { id, state, migration, verification, goEvidence, dependencies, note };
}

function decodeVerification(candidate: unknown): VerificationEvidence {
  const value = record(candidate, 'verification evidence');
  const id = boundedString(value.id, 'verification id', 3);
  const status = enumValue(value.status, 'verification status', [
    'complete',
    'approval-pending',
    'in-progress',
  ] as const);
  const evidence = paths(value.evidence, 'verification evidence paths');
  const note = optionalString(value.note, 'verification note', 600);
  if (evidence.length === 0) {
    throw new TypeError('verification evidence paths must not be empty');
  }
  if (status !== 'complete' && note === undefined) {
    throw new TypeError('incomplete verification requires a note');
  }
  return { id, status, evidence, note };
}

function decodeRetirement(candidate: unknown): RetirementEvidence {
  const value = record(candidate, 'retirement evidence');
  const phase = enumValue(value.phase, 'retirement phase', [
    'reference-present',
    'retired',
  ] as const);
  const sourceRevision = revision(
    value.sourceRevision,
    'retirement source revision',
  );
  const sourceTrees = array(value.sourceTrees, 'retirement source trees').map(
    (candidate) => {
      const tree = record(candidate, 'retirement source tree');
      return {
        path: repositoryPath(tree.path, 'retirement source tree path'),
        gitTree: revision(tree.gitTree, 'retirement source tree id'),
      };
    },
  );
  requireUnique(
    sourceTrees.map(({ path }) => path),
    'retirement source tree path',
  );
  if (sourceTrees.length !== 4) {
    throw new TypeError('retirement source trees are incomplete');
  }
  const corpus = record(value.legacyTestCorpus, 'legacy test corpus');
  const legacyTestCorpus = {
    revision: revision(corpus.revision, 'legacy test corpus revision'),
    files: positiveInteger(corpus.files, 'legacy test corpus files'),
    sha256: digest(corpus.sha256, 'legacy test corpus digest'),
  };
  const groups = array(value.groups, 'retirement groups').map((candidate) => {
    const group = record(candidate, 'retirement group');
    return {
      id: boundedString(group.id, 'retirement group id', 64),
      features: uniqueStrings(group.features, 'retirement group features'),
      legacyPrefixes: paths(group.legacyPrefixes, 'legacy prefixes'),
    };
  });
  requireUnique(
    groups.map(({ id }) => id),
    'retirement group id',
  );
  if (
    groups.length === 0 ||
    groups.some(
      ({ features, legacyPrefixes }) =>
        features.length === 0 || legacyPrefixes.length === 0,
    )
  ) {
    throw new TypeError('retirement group is incomplete');
  }
  const allPrefixes = groups.flatMap(({ legacyPrefixes }) => legacyPrefixes);
  requireUnique(allPrefixes, 'legacy prefix');
  return { phase, sourceRevision, sourceTrees, legacyTestCorpus, groups };
}

function numberedIDs(prefix: string, maximum: number): readonly string[] {
  return Array.from(
    { length: maximum },
    (_, index) => `${prefix}${String(index + 1).padStart(2, '0')}`,
  );
}

function requireExactIDs(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  requireUnique(actual, `${label} id`);
  if (
    actual.length !== expected.length ||
    expected.some((id) => !actual.includes(id))
  ) {
    throw new TypeError(`${label} evidence is incomplete`);
  }
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} must be unique`);
  }
}

function paths(value: unknown, label: string): readonly string[] {
  const result = uniqueStrings(value, label);
  for (const path of result) repositoryPath(path, label);
  return result;
}

function repositoryPath(value: unknown, label: string): string {
  const result = boundedString(value, label, 300);
  if (
    result.startsWith('/') ||
    result.startsWith('.') ||
    result.includes('\\') ||
    result.split('/').includes('..')
  ) {
    throw new TypeError(`${label} is unsafe`);
  }
  return result;
}

function revision(value: unknown, label: string): string {
  const result = boundedString(value, label, 40);
  if (!shaPattern.test(result)) throw new TypeError(`${label} is invalid`);
  return result;
}

function digest(value: unknown, label: string): string {
  const result = boundedString(value, label, 64);
  if (!digestPattern.test(result)) throw new TypeError(`${label} is invalid`);
  return result;
}

function uniqueStrings(value: unknown, label: string): readonly string[] {
  return uniqueArray(value, label).map((candidate) =>
    boundedString(candidate, `${label} value`, 600),
  );
}

function uniqueArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const encoded = value.map((candidate) => JSON.stringify(candidate));
  if (new Set(encoded).size !== encoded.length) {
    throw new TypeError(`${label} must be unique`);
  }
  return value;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
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

function enumValue<const T extends readonly string[]>(
  value: unknown,
  label: string,
  choices: T,
): T[number] {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} is invalid`);
  }
  const selected = choices.find((choice) => choice === value);
  if (selected === undefined) throw new TypeError(`${label} is invalid`);
  return selected;
}

function optionalString(
  value: unknown,
  label: string,
  maximum: number,
): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, maximum);
}

function exactString(value: unknown, label: string, expected: string): string {
  const result = boundedString(value, label, expected.length);
  if (result !== expected) throw new TypeError(`${label} is invalid`);
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

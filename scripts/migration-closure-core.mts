import ts from 'typescript';

export const migrationClosureSchemaVersion = 3;

const shaPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const featureIDs = numberedIDs('F', 28);
const verificationIDs = numberedIDs('V', 12);
export const migrationClosureProfileIDs = [
  'local-private-legacy',
  'local-fixture-undecided',
  'local-fixture-delete-live-evidence',
  'production-disabled',
] as const;

export type MigrationClosureProfileID =
  (typeof migrationClosureProfileIDs)[number];
export type FeatureConnectivityState =
  | 'connected'
  | 'partially-connected'
  | 'closed'
  | 'not-connected'
  | 'intentionally-absent'
  | 'approval-pending';

const exactProfileFeatureStates: Readonly<
  Record<MigrationClosureProfileID, readonly FeatureConnectivityState[]>
> = {
  'local-private-legacy': [
    'connected',
    'connected',
    'connected',
    'closed',
    'not-connected',
    'not-connected',
    'closed',
    'not-connected',
    'closed',
    'closed',
    'not-connected',
    'not-connected',
    'not-connected',
    'closed',
    'not-connected',
    'closed',
    'closed',
    'not-connected',
    'closed',
    'closed',
    'closed',
    'closed',
    'closed',
    'closed',
    'connected',
    'partially-connected',
    'partially-connected',
    'intentionally-absent',
  ],
  'local-fixture-undecided': [
    'connected',
    'connected',
    'closed',
    'connected',
    'not-connected',
    'not-connected',
    'connected',
    'not-connected',
    'connected',
    'connected',
    'connected',
    'connected',
    'not-connected',
    'connected',
    'not-connected',
    'connected',
    'partially-connected',
    'not-connected',
    'connected',
    'connected',
    'connected',
    'connected',
    'closed',
    'partially-connected',
    'connected',
    'partially-connected',
    'connected',
    'intentionally-absent',
  ],
  'local-fixture-delete-live-evidence': [
    'connected',
    'connected',
    'closed',
    'connected',
    'not-connected',
    'not-connected',
    'connected',
    'not-connected',
    'connected',
    'connected',
    'connected',
    'connected',
    'not-connected',
    'connected',
    'not-connected',
    'connected',
    'partially-connected',
    'not-connected',
    'connected',
    'connected',
    'connected',
    'connected',
    'connected',
    'partially-connected',
    'connected',
    'partially-connected',
    'connected',
    'intentionally-absent',
  ],
  'production-disabled': [
    'connected',
    'closed',
    'closed',
    'closed',
    'not-connected',
    'not-connected',
    'closed',
    'not-connected',
    'closed',
    'closed',
    'not-connected',
    'approval-pending',
    'not-connected',
    'closed',
    'not-connected',
    'closed',
    'closed',
    'approval-pending',
    'closed',
    'closed',
    'closed',
    'closed',
    'closed',
    'closed',
    'not-connected',
    'partially-connected',
    'partially-connected',
    'intentionally-absent',
  ],
};

export type MigrationClosure = Readonly<{
  baseline: Readonly<{
    mainRevision: string;
    legacyRetirementRevision: string;
    integrationBranch: string;
  }>;
  features: readonly FeatureEvidence[];
  verifications: readonly VerificationEvidence[];
  profiles: readonly RuntimeProfileEvidence[];
  executableEvidence: readonly ExecutableEvidence[];
  gate: Readonly<{ rootScript: 'verify' }>;
  productionTransition: ProductionTransitionEvidence;
  retirement: RetirementEvidence;
}>;

export type RuntimeProfileEvidence = Readonly<{
  id: MigrationClosureProfileID;
  features: readonly ProfileFeatureEvidence[];
  note: string;
}>;

export type ProfileFeatureEvidence = Readonly<{
  id: string;
  state: FeatureConnectivityState;
  evidence: readonly string[];
  note: string | undefined;
}>;

export type ExecutableEvidence = Readonly<{
  id: string;
  profile: MigrationClosureProfileID;
  kind: 'go-test' | 'playwright-test' | 'verification-script';
  path: string;
  name: string;
  gate: string;
  selector: string;
}>;

export type ProductionTransitionEvidence = Readonly<{
  deployment: 'not-performed';
  databaseMigration: 'not-performed';
  trafficCutover: 'not-performed';
  externalResources: 'not-performed';
  approval: 'pending';
  note: string;
}>;

export type FeatureEvidence = Readonly<{
  id: string;
  state: 'A' | 'B' | 'C' | 'A/B' | 'B/C' | 'A/B/C';
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
  const root = strictRecord(candidate, 'migration closure', [
    'schemaVersion',
    'baseline',
    'features',
    'verifications',
    'profiles',
    'executableEvidence',
    'gate',
    'productionTransition',
    'retirement',
  ]);
  if (
    integer(root.schemaVersion, 'schema version') !==
    migrationClosureSchemaVersion
  ) {
    throw new TypeError('migration closure schema version is unsupported');
  }
  const baselineRecord = strictRecord(root.baseline, 'migration baseline', [
    'mainRevision',
    'legacyRetirementRevision',
    'integrationBranch',
  ]);
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
  const executableEvidence = array(
    root.executableEvidence,
    'executable evidence',
  ).map(decodeExecutableEvidence);
  requireUnique(
    executableEvidence.map(({ id }) => id),
    'executable evidence id',
  );
  requireUnique(
    executableEvidence.map(
      ({ profile, kind, path, name, gate, selector }) =>
        `${profile}\u0000${kind}\u0000${path}\u0000${name}\u0000${gate}\u0000${selector}`,
    ),
    'executable evidence anchor',
  );
  if (executableEvidence.length === 0) {
    throw new TypeError('executable evidence must not be empty');
  }
  const profiles = array(root.profiles, 'runtime profiles').map(decodeProfile);
  requireExactIDs(
    profiles.map(({ id }) => id),
    migrationClosureProfileIDs,
    'runtime profile',
  );
  for (const profile of profiles) {
    const expected = exactProfileFeatureStates[profile.id];
    const baseEvidence =
      profile.id === 'local-private-legacy'
        ? 'E01'
        : profile.id === 'local-fixture-undecided'
          ? 'E02'
          : profile.id === 'local-fixture-delete-live-evidence'
            ? 'E03'
            : 'E05';
    for (let index = 0; index < featureIDs.length; index += 1) {
      const featureID = featureIDs[index];
      const feature = profile.features.find(({ id }) => id === featureID);
      if (feature === undefined || feature.state !== expected[index]) {
        throw new TypeError(
          `runtime profile feature state is inaccurate: ${profile.id}/${featureID}`,
        );
      }
      const expectedEvidence =
        profile.id === 'local-fixture-delete-live-evidence' &&
        featureID === 'F23'
          ? ['E03', 'E04']
          : [baseEvidence];
      if (
        feature.evidence.length !== expectedEvidence.length ||
        expectedEvidence.some((id) => !feature.evidence.includes(id))
      ) {
        throw new TypeError(
          `runtime profile feature evidence is inaccurate: ${profile.id}/${featureID}`,
        );
      }
    }
  }
  const evidenceByID = new Map(
    executableEvidence.map((evidence) => [evidence.id, evidence]),
  );
  const referencedEvidence = new Set<string>();
  for (const profile of profiles) {
    for (const feature of profile.features) {
      for (const id of feature.evidence) {
        const evidence = evidenceByID.get(id);
        if (evidence === undefined) {
          throw new TypeError('runtime feature references unknown evidence');
        }
        if (evidence.profile !== profile.id) {
          throw new TypeError(
            'runtime feature references cross-profile evidence',
          );
        }
        referencedEvidence.add(id);
      }
    }
  }
  if (
    referencedEvidence.size !== executableEvidence.length ||
    executableEvidence.some(({ id }) => !referencedEvidence.has(id))
  ) {
    throw new TypeError(
      'executable evidence is not assigned to a runtime feature',
    );
  }
  const gateRecord = strictRecord(root.gate, 'closure gate', ['rootScript']);
  const gate = {
    rootScript: exactString(
      gateRecord.rootScript,
      'root gate script',
      'verify',
    ),
  } as const;
  const productionTransition = decodeProductionTransition(
    root.productionTransition,
  );
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
  return {
    baseline,
    features,
    verifications,
    profiles,
    executableEvidence,
    gate,
    productionTransition,
    retirement,
  };
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

export function validateExecutableEvidenceSource(
  evidence: ExecutableEvidence,
  source: string,
  _packageScripts: Readonly<Record<string, unknown>>,
): void {
  if (evidence.kind === 'go-test') {
    const liveSource = stripGoCommentsAndLiterals(source);
    if (/\.[ \t]*Skip(?:f|Now)?[ \t]*\(/u.test(liveSource)) {
      throw new TypeError('executable Go test evidence must not be skipped');
    }
    const declaration = new RegExp(
      `(?:^|\\n)func\\s+${escapeRegularExpression(evidence.name)}\\s*\\(`,
      'u',
    );
    const declarations =
      liveSource.match(new RegExp(declaration.source, 'gu')) ?? [];
    if (declarations.length !== 1) {
      throw new TypeError(
        `executable Go test evidence was renamed or removed: ${evidence.name}`,
      );
    }
    return;
  }
  if (evidence.kind === 'playwright-test') {
    const playwright = inspectPlaywrightEvidence(source, evidence.name);
    if (playwright.skipOrFocus) {
      throw new TypeError(
        'executable Playwright evidence must not be skipped or focused',
      );
    }
    if (playwright.declarations !== 1) {
      throw new TypeError(
        `executable Playwright evidence was renamed or removed: ${evidence.name}`,
      );
    }
    return;
  }
  if (
    evidence.kind !== 'verification-script' ||
    evidence.path !== evidence.selector ||
    !source.includes('RELEASE_ARTIFACT_VERIFIER_VERSION')
  ) {
    throw new TypeError(
      `executable verification script evidence was renamed or removed: ${evidence.name}`,
    );
  }
}

function stripGoCommentsAndLiterals(source: string): string {
  let result = '';
  let index = 0;
  const blank = (character: string): string =>
    character === '\n' || character === '\r' ? character : ' ';
  while (index < source.length) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (character === '/' && next === '/') {
      result += '  ';
      index += 2;
      while (index < source.length && source[index] !== '\n') {
        result += ' ';
        index += 1;
      }
      continue;
    }
    if (character === '/' && next === '*') {
      result += '  ';
      index += 2;
      while (index < source.length) {
        const current = source[index] ?? '';
        const following = source[index + 1] ?? '';
        if (current === '*' && following === '/') {
          result += '  ';
          index += 2;
          break;
        }
        result += blank(current);
        index += 1;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      const delimiter = character;
      result += ' ';
      index += 1;
      while (index < source.length) {
        const current = source[index] ?? '';
        result += blank(current);
        index += 1;
        if (current === delimiter) break;
        if (delimiter !== '`' && current === '\\' && index < source.length) {
          result += blank(source[index] ?? '');
          index += 1;
        }
      }
      continue;
    }
    result += character;
    index += 1;
  }
  return result;
}

function inspectPlaywrightEvidence(
  source: string,
  expectedName: string,
): Readonly<{ declarations: number; skipOrFocus: boolean }> {
  const file = ts.createSourceFile(
    'migration-evidence.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let declarations = 0;
  let skipOrFocus = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const chain = playwrightCallChain(node.expression);
      const last = chain.at(-1);
      if (
        chain.length >= 2 &&
        chain[0] === 'test' &&
        (last === 'skip' ||
          last === 'fixme' ||
          last === 'only' ||
          last === 'fail')
      ) {
        skipOrFocus = true;
      }
      const firstArgument = node.arguments[0];
      if (
        chain.length === 1 &&
        chain[0] === 'test' &&
        firstArgument !== undefined &&
        ts.isStringLiteral(firstArgument) &&
        firstArgument.text === expectedName
      ) {
        declarations += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { declarations, skipOrFocus };
}

function playwrightCallChain(expression: ts.Expression): readonly string[] {
  if (ts.isIdentifier(expression)) return [expression.text];
  if (!ts.isPropertyAccessExpression(expression)) return [];
  const parent = playwrightCallChain(expression.expression);
  return parent.length === 0 ? [] : [...parent, expression.name.text];
}

export function validateExecutableEvidenceGate(
  evidence: ExecutableEvidence,
  packageScripts: Readonly<Record<string, unknown>>,
  supportingSources: Readonly<Record<string, string>> = {},
): void {
  const command = packageScripts[evidence.gate];
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError(
      `executable evidence gate is missing: ${evidence.gate}`,
    );
  }
  if (evidence.kind === 'verification-script') {
    if (
      evidence.name !== evidence.gate ||
      evidence.selector !== evidence.path ||
      command !== `node --experimental-strip-types ${evidence.path}`
    ) {
      throw new TypeError(
        'verification script evidence is not bound to its exact gate',
      );
    }
    return;
  }
  if (!command.includes(evidence.selector)) {
    throw new TypeError('executable evidence gate does not select its runner');
  }
  if (evidence.kind === 'go-test') {
    const selectsEvidencePackage =
      (evidence.selector === './tests/integration/...' &&
        evidence.path.startsWith('backend/tests/integration/')) ||
      (evidence.selector === './cmd/notes' &&
        evidence.path.startsWith('backend/cmd/notes/'));
    if (
      command !==
        'NOTES_TEST_DATABASE_URL=${NOTES_TEST_DATABASE_URL:-postgres://notes_test:notes_test_password@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable} go -C backend test -p=1 -tags=integration ./tests/integration/... ./cmd/notes ./cmd/notesctl' ||
      !selectsEvidencePackage
    ) {
      throw new TypeError('Go evidence gate does not execute its package');
    }
    return;
  }
  const selectorSource = supportingSources[evidence.selector];
  const runnerPath = 'scripts/run-deletion-live-e2e.mts';
  const runnerSource = supportingSources[runnerPath];
  const expectedDirectory = pathDirectory(evidence.path);
  if (
    selectorSource === undefined ||
    runnerSource === undefined ||
    command !==
      `node --experimental-strip-types ${runnerPath} ${evidence.selector}` ||
    typeof packageScripts.verify !== 'string' ||
    !packageScripts.verify
      .split('&&')
      .map((segment) => segment.trim())
      .includes(
        'FUKAMU_E2E_USE_PREBUILT=1 FUKAMU_DELETION_E2E_CONFIRM=delete-live-evidence npm run test:e2e:deletion-live',
      ) ||
    !runnerSource.includes(evidence.selector) ||
    !selectorSource.includes(`testDir: './${expectedDirectory}'`)
  ) {
    throw new TypeError(
      'Playwright evidence gate does not execute its file selection',
    );
  }
}

export function reachableNpmScripts(
  packageScripts: Readonly<Record<string, unknown>>,
  rootScript: string,
): ReadonlySet<string> {
  const visited = new Set<string>();
  const pending = [rootScript];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    const command = packageScripts[current];
    if (typeof command !== 'string' || command.length === 0) {
      throw new TypeError(
        `closure gate references a missing npm script: ${current}`,
      );
    }
    visited.add(current);
    for (const child of invokedNpmScripts(command)) {
      if (!visited.has(child)) pending.push(child);
    }
  }
  return visited;
}

export function validateEvidenceFileIdentity(
  candidate: Readonly<{
    tracked: boolean;
    regularFile: boolean;
    symbolicLink: boolean;
  }>,
): void {
  if (!candidate.tracked) {
    throw new TypeError('migration evidence must be tracked by Git');
  }
  if (!candidate.regularFile || candidate.symbolicLink) {
    throw new TypeError(
      'migration evidence must be a regular non-symlink file',
    );
  }
}

function invokedNpmScripts(command: string): readonly string[] {
  const result: string[] = [];
  if (
    command.includes('||') ||
    command.includes(';') ||
    command.includes('\n') ||
    /(^|[^|])\|([^|]|$)/u.test(command) ||
    /(^|[^&])&([^&]|$)/u.test(command)
  ) {
    throw new TypeError('closure gate contains an unsafe shell operator');
  }
  for (const rawSegment of command.split('&&')) {
    const segment = rawSegment.trim();
    const match =
      /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*npm\s+run\s+([A-Za-z0-9:_-]+)$/u.exec(
        segment,
      );
    if (match !== null) {
      const script = match[1];
      if (script !== undefined) result.push(script);
    } else if (/\bnpm\s+run\b/u.test(segment)) {
      throw new TypeError('closure gate contains an inert npm invocation');
    }
  }
  return result;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function pathDirectory(value: string): string {
  const marker = value.lastIndexOf('/');
  if (marker < 1)
    throw new TypeError('executable evidence path has no directory');
  return value.slice(0, marker);
}

function decodeFeature(candidate: unknown): FeatureEvidence {
  const value = strictRecord(candidate, 'feature evidence', [
    'id',
    'state',
    'migration',
    'verification',
    'goEvidence',
    'dependencies',
    'note',
  ]);
  const id = boundedString(value.id, 'feature id', 3);
  const state = enumValue(value.state, 'feature state', [
    'A',
    'B',
    'C',
    'A/B',
    'B/C',
    'A/B/C',
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
  const value = strictRecord(candidate, 'verification evidence', [
    'id',
    'status',
    'evidence',
    'note',
  ]);
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

function decodeProfile(candidate: unknown): RuntimeProfileEvidence {
  const value = strictRecord(candidate, 'runtime profile', [
    'id',
    'features',
    'note',
  ]);
  const id = enumValue(
    value.id,
    'runtime profile id',
    migrationClosureProfileIDs,
  );
  const features = array(value.features, 'runtime profile features').map(
    decodeProfileFeature,
  );
  requireExactIDs(
    features.map(({ id: featureID }) => featureID),
    featureIDs,
    'runtime profile feature',
  );
  const note = boundedString(value.note, 'runtime profile note', 1_000);
  return { id, features, note };
}

function decodeProfileFeature(candidate: unknown): ProfileFeatureEvidence {
  const value = strictRecord(candidate, 'runtime profile feature', [
    'id',
    'state',
    'evidence',
    'note',
  ]);
  const evidence = uniqueStrings(value.evidence, 'runtime feature evidence');
  if (evidence.length === 0) {
    throw new TypeError('runtime feature evidence must not be empty');
  }
  return {
    id: boundedString(value.id, 'runtime feature id', 3),
    state: enumValue(value.state, 'runtime feature state', [
      'connected',
      'partially-connected',
      'closed',
      'not-connected',
      'intentionally-absent',
      'approval-pending',
    ] as const),
    evidence,
    note: optionalString(value.note, 'runtime feature note', 600),
  };
}

function decodeExecutableEvidence(candidate: unknown): ExecutableEvidence {
  const value = strictRecord(candidate, 'executable evidence', [
    'id',
    'profile',
    'kind',
    'path',
    'name',
    'gate',
    'selector',
  ]);
  const kind = enumValue(value.kind, 'executable evidence kind', [
    'go-test',
    'playwright-test',
    'verification-script',
  ] as const);
  const path = repositoryPath(value.path, 'executable evidence path');
  const name = boundedString(value.name, 'executable evidence name', 240);
  if (kind === 'go-test' && !/^Test[A-Za-z0-9_]+$/u.test(name)) {
    throw new TypeError('Go test evidence name is invalid');
  }
  if (kind === 'verification-script' && !path.startsWith('scripts/')) {
    throw new TypeError('verification script evidence path is invalid');
  }
  return {
    id: boundedString(value.id, 'executable evidence id', 32),
    profile: enumValue(
      value.profile,
      'executable evidence profile',
      migrationClosureProfileIDs,
    ),
    kind,
    path,
    name,
    gate: boundedString(value.gate, 'executable evidence gate', 80),
    selector: boundedString(
      value.selector,
      'executable evidence selector',
      300,
    ),
  };
}

function decodeProductionTransition(
  candidate: unknown,
): ProductionTransitionEvidence {
  const value = strictRecord(candidate, 'production transition', [
    'deployment',
    'databaseMigration',
    'trafficCutover',
    'externalResources',
    'approval',
    'note',
  ]);
  return {
    deployment: exactString(
      value.deployment,
      'production deployment transition',
      'not-performed',
    ),
    databaseMigration: exactString(
      value.databaseMigration,
      'production database migration transition',
      'not-performed',
    ),
    trafficCutover: exactString(
      value.trafficCutover,
      'production traffic cutover transition',
      'not-performed',
    ),
    externalResources: exactString(
      value.externalResources,
      'production external resource transition',
      'not-performed',
    ),
    approval: exactString(
      value.approval,
      'production transition approval',
      'pending',
    ),
    note: boundedString(value.note, 'production transition note', 1_000),
  };
}

function decodeRetirement(candidate: unknown): RetirementEvidence {
  const value = strictRecord(candidate, 'retirement evidence', [
    'phase',
    'sourceRevision',
    'sourceTrees',
    'legacyTestCorpus',
    'groups',
  ]);
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
      const tree = strictRecord(candidate, 'retirement source tree', [
        'path',
        'gitTree',
      ]);
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
  const corpus = strictRecord(value.legacyTestCorpus, 'legacy test corpus', [
    'revision',
    'files',
    'sha256',
  ]);
  const legacyTestCorpus = {
    revision: revision(corpus.revision, 'legacy test corpus revision'),
    files: positiveInteger(corpus.files, 'legacy test corpus files'),
    sha256: digest(corpus.sha256, 'legacy test corpus digest'),
  };
  const groups = array(value.groups, 'retirement groups').map((candidate) => {
    const group = strictRecord(candidate, 'retirement group', [
      'id',
      'features',
      'legacyPrefixes',
    ]);
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

function strictRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label} contains an unknown key: ${key}`);
    }
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

function exactString<const Expected extends string>(
  value: unknown,
  label: string,
  expected: Expected,
): Expected {
  const result = boundedString(value, label, expected.length);
  if (result !== expected) throw new TypeError(`${label} is invalid`);
  return expected;
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

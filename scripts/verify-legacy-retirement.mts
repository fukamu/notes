import { spawnSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import {
  decodeLegacyTestRetirementLedger,
  evidencePaths,
  selectLegacyTestCorpus,
  validateExecutableEvidence,
  validateLedgerClosure,
  validateNamedGoTestEvidence,
  validateReferenceCorpus,
  validateRetiredPackageLock,
  validateRetiredRepository,
  validateRetiredTree,
} from './legacy-retirement-core.mts';
import { decodeMigrationClosure } from './migration-closure-core.mts';

const ledgerCandidate: unknown = JSON.parse(
  await readFile('contracts/legacy-test-retirement.json', 'utf8'),
);
const closureCandidate: unknown = JSON.parse(
  await readFile('contracts/go-migration-closure.json', 'utf8'),
);
const ledger = decodeLegacyTestRetirementLedger(ledgerCandidate);
const closure = decodeMigrationClosure(closureCandidate);
validateLedgerClosure(ledger, {
  phase: closure.retirement.phase,
  sourceRevision: closure.retirement.sourceRevision,
  testCorpusRevision: closure.retirement.legacyTestCorpus.revision,
  files: closure.retirement.legacyTestCorpus.files,
  sha256: closure.retirement.legacyTestCorpus.sha256,
  features: closure.features,
});

const trackedPaths = new Set(
  gitOutput(['ls-files'])
    .split(/\r?\n/u)
    .filter((name) => name.length > 0),
);
const trackedTests = [...trackedPaths]
  .filter((name) => name.startsWith('tests/'))
  .sort();
const testSources = await Promise.all(
  trackedTests.map(async (path) => ({
    path,
    content: await readFile(path, 'utf8'),
  })),
);
const currentLegacyCorpus = selectLegacyTestCorpus(testSources);
const trackedTypeScriptSources = await Promise.all(
  [...trackedPaths]
    .filter((name) => /\.[cm]?[jt]sx?$/u.test(name))
    .sort()
    .map(async (path) => ({ path, content: await readFile(path, 'utf8') })),
);

const relevantPaths = evidencePaths(ledger);
const currentSources = new Map<string, string>();
for (const path of relevantPaths) {
  if (!trackedPaths.has(path)) {
    throw new TypeError(`legacy retirement evidence is not tracked: ${path}`);
  }
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new TypeError(
      `legacy retirement evidence is not a regular file: ${path}`,
    );
  }
  currentSources.set(path, await readFile(path, 'utf8'));
}

for (const entry of ledger.entries) {
  if (entry.disposition.kind === 'historical-only') continue;
  for (const evidencePath of entry.disposition.evidence) {
    const source = currentSources.get(evidencePath);
    if (source === undefined) {
      throw new TypeError(
        `legacy retirement evidence is unreadable: ${evidencePath}`,
      );
    }
    validateExecutableEvidence(evidencePath, source);
  }
  for (const anchor of entry.disposition.evidenceAnchors) {
    const source = currentSources.get(anchor.path);
    if (source === undefined) {
      throw new TypeError(
        `legacy retirement anchored evidence is unreadable: ${anchor.path}`,
      );
    }
    validateNamedGoTestEvidence(anchor.path, source, anchor.testName);
  }
}

if (closure.retirement.phase === 'reference-present') {
  validateReferenceCorpus(ledger, currentLegacyCorpus);
} else {
  validateRetiredTree(
    ledger,
    currentLegacyCorpus,
    trackedPaths,
    currentSources,
  );
  const packageCandidate: unknown = JSON.parse(
    await readFile('package.json', 'utf8'),
  );
  validateRetiredRepository(
    trackedPaths,
    packageCandidate,
    trackedTypeScriptSources,
  );
  const packageLockCandidate: unknown = JSON.parse(
    await readFile('package-lock.json', 'utf8'),
  );
  validateRetiredPackageLock(packageLockCandidate);
}

const retained = ledger.entries.filter(
  ({ disposition }) => disposition.kind === 'retained-frontend',
).length;
const retainedTooling = ledger.entries.filter(
  ({ disposition }) => disposition.kind === 'retained-tooling',
).length;
const replaced = ledger.entries.filter(
  ({ disposition }) => disposition.kind === 'go-replacement',
).length;
const historical = ledger.entries.filter(
  ({ disposition }) => disposition.kind === 'historical-only',
).length;
process.stdout.write(
  `Legacy test retirement verified: ${ledger.files} frozen files, ${retained} retained frontend, ${retainedTooling} retained tooling, ${replaced} Go replacements, ${historical} historical-only\n`,
);

function gitOutput(arguments_: readonly string[]): string {
  const result = spawnSync('git', arguments_, { encoding: 'utf8' });
  // Some restricted Linux runners report a child-process EPERM even though Git
  // exited successfully. Accept output only when status, signal, and stderr
  // independently prove success; every other anomaly remains a hard failure.
  if (
    result.status !== 0 ||
    result.signal !== null ||
    result.stderr.length !== 0
  ) {
    throw result.error ?? new Error(`git ${arguments_.join(' ')} failed`);
  }
  return result.stdout;
}

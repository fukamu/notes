import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  decodeMigrationClosure,
  validateLegacyCoverage,
} from './migration-closure-core.mts';

const manifestPath = 'contracts/go-migration-closure.json';
const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
const closure = decodeMigrationClosure(manifest);

const evidencePaths = new Set([
  ...closure.features.flatMap(({ goEvidence }) => goEvidence),
  ...closure.verifications.flatMap(({ evidence }) => evidence),
]);
await Promise.all(
  [...evidencePaths].map(async (evidencePath) => {
    const details = await stat(evidencePath);
    if (!details.isFile()) {
      throw new TypeError(`migration evidence is not a file: ${evidencePath}`);
    }
  }),
);

const sourcePaths = (
  await Promise.all(
    closure.retirement.sourceTrees.map(({ path: sourceRoot }) =>
      filesBelow(sourceRoot),
    ),
  )
).flat();

if (closure.retirement.phase === 'reference-present') {
  validateLegacyCoverage(sourcePaths, closure.retirement.groups);
  for (const sourceTree of closure.retirement.sourceTrees) {
    const currentTree = gitTree(sourceTree.path);
    if (currentTree !== sourceTree.gitTree) {
      throw new TypeError(
        `legacy source tree drifted without retirement evidence: ${sourceTree.path}`,
      );
    }
  }
  const corpus = await legacyTestCorpus();
  if (
    corpus.files !== closure.retirement.legacyTestCorpus.files ||
    corpus.sha256 !== closure.retirement.legacyTestCorpus.sha256
  ) {
    throw new TypeError(
      'legacy TypeScript test corpus drifted without evidence',
    );
  }
} else if (sourcePaths.length !== 0) {
  throw new TypeError('retired legacy source roots must be absent');
}

const migrated = closure.features.filter(
  ({ migration }) => migration === 'migrated',
).length;
const blocked = closure.features.filter(
  ({ migration }) => migration === 'blocked-existing-work',
).length;
const pendingVerification = closure.verifications.filter(
  ({ status }) => status !== 'complete',
).length;
process.stdout.write(
  `Migration closure verified: ${migrated} migrated features, ${blocked} blocked feature, ${pendingVerification} pending verification records\n`,
);

async function filesBelow(root: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const children = await Promise.all(
      entries.map(async (entry) => {
        const child = path.posix.join(root, entry.name);
        if (entry.isDirectory()) return filesBelow(child);
        if (!entry.isFile()) {
          throw new TypeError(
            `legacy source contains an unsupported entry: ${child}`,
          );
        }
        return [child];
      }),
    );
    return children.flat().sort();
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      Reflect.get(error, 'code') === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }
}

function gitTree(sourcePath: string): string {
  const output = gitOutput(['rev-parse', `HEAD:${sourcePath}`]).trim();
  if (!/^[a-f0-9]{40}$/u.test(output)) {
    throw new TypeError(`invalid Git tree identity for ${sourcePath}`);
  }
  return output;
}

async function legacyTestCorpus(): Promise<{
  files: number;
  sha256: string;
}> {
  const names = gitOutput(['ls-files', 'tests'])
    .split(/\r?\n/u)
    .filter((name) => name.length > 0)
    .sort();
  const matcher = /@\/(?:server|db|app\/api)|Miniflare|cloudflare:workers/u;
  const selected: { name: string; digest: string }[] = [];
  for (const name of names) {
    const content = await readFile(name, 'utf8');
    if (!matcher.test(content)) continue;
    selected.push({
      name,
      digest: createHash('sha256').update(content).digest('hex'),
    });
  }
  const encoded = selected
    .map(({ name, digest }) => `${digest}  ${name}\n`)
    .join('');
  return {
    files: selected.length,
    sha256: createHash('sha256').update(encoded).digest('hex'),
  };
}

function gitOutput(arguments_: readonly string[]): string {
  const result = spawnSync('git', arguments_, { encoding: 'utf8' });
  // Some restricted Linux runners report a child-process EPERM even though Git
  // exited successfully. Accept output only when the exit status, signal, and
  // stderr independently prove success; every other spawn anomaly still fails.
  if (
    result.status !== 0 ||
    result.signal !== null ||
    result.stderr.length !== 0
  ) {
    throw result.error ?? new Error(`git ${arguments_.join(' ')} failed`);
  }
  return result.stdout;
}

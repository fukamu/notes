import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeV12Evidence,
  verifyV12GitProvenance,
  verifyV12SourceContent,
  V12_SOURCE_PATHS,
} from './migration-v12-evidence-core.mts';
import {
  V12_REFERENCE_HANDLER_SHA256,
  V12_REFERENCE_OBSERVER_SHA256,
  V12_REFERENCE_PATCHED_HANDLER_SHA256,
} from './migration-v12-reference-observer.mts';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const artifactPath = path.join(
  repositoryRoot,
  'docs/benchmarks/migration-v12-local.json',
);
const source: unknown = JSON.parse(await readFile(artifactPath, 'utf8'));
const evidence = decodeV12Evidence(source);
if (
  evidence.identity.referenceHandlerSha256 !== V12_REFERENCE_HANDLER_SHA256 ||
  evidence.identity.referenceObserverSha256 !== V12_REFERENCE_OBSERVER_SHA256 ||
  evidence.identity.referencePatchedHandlerSha256 !==
    V12_REFERENCE_PATCHED_HANDLER_SHA256
) {
  throw new Error(
    'V12 reference handler or observer digest does not match the owned patch',
  );
}

const sourceContent = new Map<string, Uint8Array>();
for (const sourcePath of V12_SOURCE_PATHS) {
  sourceContent.set(
    sourcePath,
    await readFile(path.join(repositoryRoot, sourcePath)),
  );
}
verifyV12SourceContent(evidence, sourceContent);
const currentHead = (await gitText(['rev-parse', 'HEAD'])).trim();
await verifyV12GitProvenance(evidence, currentHead, {
  commitExists: async (revision) =>
    (await git(['cat-file', '-e', `${revision}^{commit}`], true)).code === 0,
  isAncestor: async (ancestor, descendant) =>
    (await git(['merge-base', '--is-ancestor', ancestor, descendant], true))
      .code === 0,
  treeObjectId: async (revision) =>
    (await gitText(['rev-parse', `${revision}^{tree}`])).trim(),
  readBlob: async (revision, sourcePath) => {
    const result = await git(['show', `${revision}:${sourcePath}`], true);
    if (result.code !== 0)
      throw new Error(`git blob unavailable: ${sourcePath}`);
    return result.stdout;
  },
});

process.stdout.write(
  `V12 local evidence verified: ${evidence.legacy.runs.length} legacy runs, ` +
    `${evidence.syncV2.runs.length} Sync v2 traversals, ` +
    `${evidence.syncV2.concurrency.length} concurrent waves.\n`,
);

async function gitText(arguments_: readonly string[]): Promise<string> {
  const result = await git(arguments_, false);
  return new TextDecoder().decode(result.stdout);
}

async function git(
  arguments_: readonly string[],
  allowFailure: boolean,
): Promise<Readonly<{ code: number; stdout: Uint8Array }>> {
  const child = spawn('git', arguments_, {
    cwd: repositoryRoot,
    env: safeGitEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  child.stdout.on('data', (chunk: Uint8Array) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Uint8Array) => stderr.push(chunk));
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve(status ?? 1));
  });
  if (!allowFailure && code !== 0) {
    throw new Error(
      `git ${arguments_[0] ?? 'command'} failed: ${Buffer.concat(stderr).toString('utf8').slice(0, 500)}`,
    );
  }
  return { code, stdout: Buffer.concat(stdout) };
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL']) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

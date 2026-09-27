import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { v7 as uuidV7 } from 'uuid';

const exactConfirmation = 'delete-live-evidence';
const exactConfig = 'playwright.deletion-live.config.ts';
if (process.env.FUKAMU_DELETION_E2E_CONFIRM !== exactConfirmation) {
  throw new Error(
    'live deletion E2E requires the exact destructive confirmation',
  );
}
if (process.argv.length !== 3 || process.argv[2] !== exactConfig) {
  throw new Error(
    'live deletion E2E accepts only its reviewed Playwright config',
  );
}

const require = createRequire(import.meta.url);
const playwrightCLI = require.resolve('@playwright/test/cli');
const prefix = 'fukamu-notes-deletion-e2e.';
const markerName = '.fukamu-notes-deletion-e2e-owner';
const directory = await mkdtemp(path.join(tmpdir(), prefix));
await chmod(directory, 0o700);
const token = randomUUID();
await writeFile(path.join(directory, markerName), token, {
  encoding: 'utf8',
  flag: 'wx',
  mode: 0o600,
});

const childEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  FUKAMU_DELETION_E2E_CONFIRM: exactConfirmation,
  FUKAMU_DELETION_E2E_CONTROL: directory,
  FUKAMU_DELETION_E2E_TOKEN: token,
  FUKAMU_DELETION_E2E_ACCOUNT_ID: uuidV7(),
  FUKAMU_DELETION_E2E_VAULT_ID: uuidV7(),
  FUKAMU_DELETION_E2E_SESSION_ID: uuidV7(),
  FUKAMU_DELETION_E2E_SESSION_TOKEN: randomBytes(32).toString('base64url'),
  FUKAMU_DELETION_E2E_CURSOR_KEY: randomBytes(32).toString('base64url'),
  FUKAMU_DELETION_E2E_CONTINUATION_KEY: randomBytes(32).toString('base64url'),
};
// The server derives the destructive policy only from the reviewed launcher
// confirmation plus its invocation-owned marker. A raw ambient policy cannot
// opt the shared or destructive browser lane into deletion.
delete childEnvironment.NOTES_LOCAL_FIXTURE_LEGAL_EVIDENCE_POLICY;
delete childEnvironment.FUKAMU_E2E_LOCAL_AUTH_PRIVATE_KEY;

let child: ReturnType<typeof spawn> | undefined;
try {
  child = spawn(
    process.execPath,
    [playwrightCLI, 'test', '--config', exactConfig],
    {
      cwd: process.cwd(),
      env: childEnvironment,
      stdio: 'inherit',
    },
  );
  const forwardInterrupt = () => child?.kill('SIGINT');
  const forwardTermination = () => child?.kill('SIGTERM');
  process.once('SIGINT', forwardInterrupt);
  process.once('SIGTERM', forwardTermination);
  const result = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child?.once('error', reject);
    child?.once('close', (code, signal) => resolve({ code, signal }));
  });
  process.off('SIGINT', forwardInterrupt);
  process.off('SIGTERM', forwardTermination);
  process.exitCode = result.code ?? (result.signal === 'SIGINT' ? 130 : 1);
} finally {
  await cleanDeletionFixture(directory);
  await cleanDeletionControl(directory, token);
}

async function cleanDeletionFixture(controlDirectory: string): Promise<void> {
  const record = path.join(controlDirectory, 'fixture.path');
  let recordStat;
  try {
    recordStat = await lstat(record);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const ownerUid = process.getuid?.();
  if (
    ownerUid === undefined ||
    recordStat.isSymbolicLink() ||
    !recordStat.isFile() ||
    recordStat.uid !== ownerUid ||
    recordStat.nlink !== 1 ||
    (recordStat.mode & 0o7777) !== 0o600
  ) {
    throw new Error('refusing to use an unsafe deletion fixture record');
  }
  const fixture = await readFile(record, 'utf8');
  if (
    path.dirname(fixture) !== tmpdir() ||
    !path.basename(fixture).startsWith('fukamu-notes-deletion-fixture.')
  ) {
    throw new Error('refusing to remove an unexpected deletion fixture');
  }
  try {
    const fixtureStat = await lstat(fixture);
    if (
      fixtureStat.isSymbolicLink() ||
      !fixtureStat.isDirectory() ||
      fixtureStat.uid !== ownerUid ||
      (fixtureStat.mode & 0o7777) !== 0o700
    ) {
      throw new Error('refusing to remove an unsafe deletion fixture');
    }
    await rm(fixture, { recursive: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    await lstat(fixture);
    throw new Error('deletion fixture cleanup did not remove its target');
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await unlink(record);
}

async function cleanDeletionControl(
  candidateDirectory: string,
  expectedToken: string,
): Promise<void> {
  if (
    path.dirname(candidateDirectory) !== tmpdir() ||
    !path.basename(candidateDirectory).startsWith(prefix)
  ) {
    throw new Error('refusing to clean an unexpected deletion control');
  }
  const ownerUid = process.getuid?.();
  const directoryStat = await lstat(candidateDirectory);
  const marker = path.join(candidateDirectory, markerName);
  const markerStat = await lstat(marker);
  if (
    ownerUid === undefined ||
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    directoryStat.uid !== ownerUid ||
    (directoryStat.mode & 0o7777) !== 0o700 ||
    markerStat.isSymbolicLink() ||
    !markerStat.isFile() ||
    markerStat.uid !== ownerUid ||
    markerStat.nlink !== 1 ||
    (markerStat.mode & 0o7777) !== 0o600 ||
    (await readFile(marker, 'utf8')) !== expectedToken
  ) {
    throw new Error('refusing to clean an unowned deletion control');
  }
  const entries = await readdir(candidateDirectory);
  const unexpected = entries.filter(
    (entry) =>
      entry !== markerName &&
      entry !== 'restart.request' &&
      entry !== 'restart.completed' &&
      entry !== 'restart.failed' &&
      entry !== 'notes-deletion-e2e-server' &&
      entry !== 'fixture.path' &&
      !/^restart\.(?:completed|failed)\.[1-9][0-9]*$/.test(entry),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `refusing to remove unexpected deletion artifacts: ${unexpected.join(', ')}`,
    );
  }
  for (const entry of entries) {
    await unlink(path.join(candidateDirectory, entry));
  }
  await rmdir(candidateDirectory);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

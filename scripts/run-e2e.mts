import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const playwrightCLI = require.resolve('@playwright/test/cli');
const prefix = 'fukamu-notes-e2e-restart.';
const markerName = '.fukamu-notes-e2e-owner';
const directory = await mkdtemp(path.join(tmpdir(), prefix));
await chmod(directory, 0o700);
const token = randomUUID();
await writeFile(path.join(directory, markerName), token, {
  encoding: 'utf8',
  flag: 'wx',
  mode: 0o600,
});

let child: ReturnType<typeof spawn> | undefined;
try {
  child = spawn(
    process.execPath,
    [playwrightCLI, 'test', ...process.argv.slice(2)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FUKAMU_E2E_RESTART_CONTROL: directory,
        FUKAMU_E2E_RESTART_TOKEN: token,
      },
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
  await cleanRestartControl(directory, token);
}

async function cleanRestartControl(
  candidateDirectory: string,
  expectedToken: string,
): Promise<void> {
  if (
    path.dirname(candidateDirectory) !== tmpdir() ||
    !path.basename(candidateDirectory).startsWith(prefix)
  ) {
    throw new Error('refusing to clean an unexpected restart directory');
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
    throw new Error('refusing to clean an unowned restart directory');
  }
  const entries = await readdir(candidateDirectory);
  const unexpected = entries.filter(
    (entry) =>
      entry !== markerName &&
      entry !== 'restart.request' &&
      entry !== 'restart.completed' &&
      entry !== 'notes-e2e-server' &&
      !/^restart\.completed\.[1-9][0-9]*$/.test(entry),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `refusing to remove unexpected restart artifacts: ${unexpected.join(', ')}`,
    );
  }
  for (const entry of entries) {
    await unlink(path.join(candidateDirectory, entry));
  }
  await rmdir(candidateDirectory);
}

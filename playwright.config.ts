import { defineConfig, devices } from '@playwright/test';
import { lstatSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  configureE2EIdentity,
  e2eAudience,
  e2eFixtureAccountId,
  e2eFixtureCursorHmacKey,
  e2eFixtureDeletionHmacKey,
  e2eFixtureSessionEpoch,
  e2eFixtureSessionId,
  e2eFixtureSessionToken,
  e2eFixtureVaultId,
  e2eIssuer,
  e2eOwnerSubject,
  e2eSessionStorageState,
  localAssertionHeader,
} from './tests/e2e/identity-fixture';

const identity = configureE2EIdentity();
const restartControlDirectory = requiredRestartEnvironment(
  'FUKAMU_E2E_RESTART_CONTROL',
);
const restartControlToken = requiredRestartEnvironment(
  'FUKAMU_E2E_RESTART_TOKEN',
);
validateRestartControl(restartControlDirectory, restartControlToken);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3100',
    extraHTTPHeaders: {
      [localAssertionHeader]: identity.ownerAssertion,
    },
    storageState: e2eSessionStorageState(),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npm run test:e2e:server',
    url: 'http://localhost:3100',
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      FUKAMU_E2E_LOCAL_AUTH_PUBLIC_KEY: identity.publicKey,
      NOTES_LOCAL_AUTH_AUDIENCE: e2eAudience,
      NOTES_LOCAL_AUTH_ISSUER: e2eIssuer,
      NOTES_LEGACY_OWNER_SUBJECT: e2eOwnerSubject,
      NOTES_LOCAL_FIXTURE_ACCOUNT_ID: e2eFixtureAccountId,
      NOTES_LOCAL_FIXTURE_VAULT_ID: e2eFixtureVaultId,
      NOTES_LOCAL_FIXTURE_SESSION_ID: e2eFixtureSessionId,
      NOTES_LOCAL_FIXTURE_SESSION_EPOCH: e2eFixtureSessionEpoch,
      NOTES_LOCAL_FIXTURE_SESSION_TOKEN: e2eFixtureSessionToken,
      NOTES_LOCAL_FIXTURE_CURSOR_HMAC_KEY: e2eFixtureCursorHmacKey,
      NOTES_LOCAL_FIXTURE_DELETION_HMAC_KEY: e2eFixtureDeletionHmacKey,
      FUKAMU_E2E_RESTART_CONTROL: restartControlDirectory,
      FUKAMU_E2E_RESTART_TOKEN: restartControlToken,
    },
  },
});

function requiredRestartEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be created by the E2E launcher`);
  }
  return value;
}

function validateRestartControl(directory: string, token: string): void {
  if (
    path.dirname(directory) !== tmpdir() ||
    !path.basename(directory).startsWith('fukamu-notes-e2e-restart.')
  ) {
    throw new Error('invalid E2E restart-control directory');
  }
  const ownerUid = process.getuid?.();
  const directoryStat = lstatSync(directory);
  if (
    ownerUid === undefined ||
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    directoryStat.uid !== ownerUid ||
    (directoryStat.mode & 0o7777) !== 0o700
  ) {
    throw new Error('unsafe E2E restart-control directory');
  }
  const marker = path.join(directory, '.fukamu-notes-e2e-owner');
  const markerStat = lstatSync(marker);
  if (
    markerStat.isSymbolicLink() ||
    !markerStat.isFile() ||
    markerStat.uid !== ownerUid ||
    markerStat.nlink !== 1 ||
    (markerStat.mode & 0o7777) !== 0o600 ||
    readFileSync(marker, 'utf8') !== token
  ) {
    throw new Error('unsafe E2E restart-control ownership marker');
  }
}

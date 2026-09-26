import { defineConfig, devices } from '@playwright/test';
import { lstatSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  configureE2EIdentity,
  e2eAudience,
  e2eIssuer,
  e2eOwnerSubject,
  e2eSessionCookieName,
  localAssertionHeader,
} from './tests/e2e/identity-fixture';

const exactConfirmation = 'delete-live-evidence';
if (process.env.FUKAMU_DELETION_E2E_CONFIRM !== exactConfirmation) {
  throw new Error('destructive Playwright configuration requires exact opt-in');
}
const identity = configureE2EIdentity();
const controlDirectory = requiredEnvironment('FUKAMU_DELETION_E2E_CONTROL');
const controlToken = requiredEnvironment('FUKAMU_DELETION_E2E_TOKEN');
validateDeletionControl(controlDirectory, controlToken);
const fixtureAccountId = requiredEnvironment('FUKAMU_DELETION_E2E_ACCOUNT_ID');
const fixtureVaultId = requiredEnvironment('FUKAMU_DELETION_E2E_VAULT_ID');
const fixtureSessionId = requiredEnvironment('FUKAMU_DELETION_E2E_SESSION_ID');
const fixtureSessionToken = requiredEnvironment(
  'FUKAMU_DELETION_E2E_SESSION_TOKEN',
);
const fixtureCursorKey = requiredEnvironment('FUKAMU_DELETION_E2E_CURSOR_KEY');
const fixtureContinuationKey = requiredEnvironment(
  'FUKAMU_DELETION_E2E_CONTINUATION_KEY',
);

export default defineConfig({
  testDir: './tests/e2e-live-deletion',
  testMatch: 'account-deletion-live.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  outputDir: 'test-results/deletion-live',
  use: {
    baseURL: 'http://localhost:3101',
    extraHTTPHeaders: {
      [localAssertionHeader]: identity.ownerAssertion,
    },
    storageState: {
      cookies: [
        {
          name: e2eSessionCookieName,
          value: fixtureSessionToken,
          domain: 'localhost',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Strict',
        },
      ],
      origins: [],
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bash scripts/e2e-deletion-live-server.sh',
    url: 'http://localhost:3101/healthz',
    reuseExistingServer: false,
    timeout: 180_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 20_000 },
    env: {
      FUKAMU_DELETION_E2E_CONFIRM: exactConfirmation,
      FUKAMU_DELETION_E2E_CONTROL: controlDirectory,
      FUKAMU_DELETION_E2E_TOKEN: controlToken,
      FUKAMU_E2E_LOCAL_AUTH_PUBLIC_KEY: identity.publicKey,
      NOTES_LOCAL_AUTH_AUDIENCE: e2eAudience,
      NOTES_LOCAL_AUTH_ISSUER: e2eIssuer,
      NOTES_LEGACY_OWNER_SUBJECT: e2eOwnerSubject,
      NOTES_LOCAL_FIXTURE_ACCOUNT_ID: fixtureAccountId,
      NOTES_LOCAL_FIXTURE_VAULT_ID: fixtureVaultId,
      NOTES_LOCAL_FIXTURE_SESSION_ID: fixtureSessionId,
      NOTES_LOCAL_FIXTURE_SESSION_EPOCH: '1',
      NOTES_LOCAL_FIXTURE_SESSION_TOKEN: fixtureSessionToken,
      NOTES_LOCAL_FIXTURE_CURSOR_HMAC_KEY: fixtureCursorKey,
      NOTES_LOCAL_FIXTURE_DELETION_HMAC_KEY: fixtureContinuationKey,
    },
  },
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be created by the deletion E2E launcher`);
  }
  return value;
}

function validateDeletionControl(directory: string, token: string): void {
  if (
    path.dirname(directory) !== tmpdir() ||
    !path.basename(directory).startsWith('fukamu-notes-deletion-e2e.')
  ) {
    throw new Error('invalid deletion E2E control directory');
  }
  const ownerUid = process.getuid?.();
  const directoryStat = lstatSync(directory);
  const marker = path.join(directory, '.fukamu-notes-deletion-e2e-owner');
  const markerStat = lstatSync(marker);
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
    readFileSync(marker, 'utf8') !== token
  ) {
    throw new Error('unsafe deletion E2E control ownership marker');
  }
}

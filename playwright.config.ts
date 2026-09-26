import { defineConfig, devices } from '@playwright/test';
import {
  configureE2EIdentity,
  e2eAudience,
  e2eIssuer,
  e2eOwnerSubject,
  e2eSessionCookieName,
  e2eSessionToken,
  localAssertionHeader,
} from './tests/e2e/identity-fixture';

const identity = configureE2EIdentity();

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
    storageState: {
      cookies: [
        {
          name: e2eSessionCookieName,
          value: e2eSessionToken,
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
    },
  },
});

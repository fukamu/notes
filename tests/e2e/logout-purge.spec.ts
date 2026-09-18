import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { fixtureCardId } from '@/tests/fixtures/ids';
import { sessionFixtureIds } from '@/tests/fixtures/session';

test.describe.configure({ mode: 'serial' });

const vaultA = {
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};
const vaultB = {
  accountId: sessionFixtureIds.otherAccountId,
  vaultId: sessionFixtureIds.otherVaultId,
  sessionId: sessionFixtureIds.nextSessionId,
  sessionEpoch: sessionFixtureIds.nextEpoch,
};
const sharedCardId = fixtureCardId('logout-e2e-shared-card');

let harnessSource: Promise<string> | undefined;

test('logout purge drains tabs and prevents browser content resurrection', async ({
  page,
  context,
}) => {
  const peer = await context.newPage();
  await Promise.all([ready(page), ready(peer)]);
  await Promise.all([installHarness(page), installHarness(peer)]);

  await page.evaluate(
    async ({ first, second, cardId }) => {
      await window.__fukamuLogoutPurgeHarness.seedVault(
        first,
        cardId,
        'Vault A private content',
      );
      await window.__fukamuLogoutPurgeHarness.seedVault(
        second,
        cardId,
        'Vault B retained content',
      );
      await window.__fukamuLogoutPurgeHarness.seedNotesCache();
      void window.__fukamuLogoutPurgeHarness
        .prepareGraphWorker()
        .catch(() => undefined);
      history.pushState({}, '', `/cards/${cardId}`);
      history.pushState({}, '', '/history');
    },
    { first: vaultA, second: vaultB, cardId: sharedCardId },
  );

  await expect(
    page.evaluate(
      (generation) => window.__fukamuLogoutPurgeHarness.enterFence(generation),
      vaultA,
    ),
  ).resolves.toEqual({ kind: 'entered' });
  await expect(
    peer.evaluate(
      (generation) => window.__fukamuLogoutPurgeHarness.enterFence(generation),
      vaultA,
    ),
  ).resolves.toEqual({ kind: 'entered' });

  await expect(
    page.evaluate(
      (generation) => window.__fukamuLogoutPurgeHarness.runPurge(generation),
      vaultA,
    ),
  ).resolves.toEqual({
    kind: 'completed',
    completionAnnouncement: 'sent',
  });

  await expect
    .poll(() =>
      peer.evaluate(() => window.__fukamuLogoutPurgeHarness.fenceStatus()),
    )
    .toBe('quiesced');
  await expect(
    page.evaluate(() => window.__fukamuLogoutPurgeHarness.progressMarker()),
  ).resolves.toBeUndefined();
  await expect(
    page.evaluate(
      (generation) =>
        window.__fukamuLogoutPurgeHarness.snapshotVault(generation),
      vaultA,
    ),
  ).resolves.toEqual({ present: false, titles: [] });
  await expect(
    peer.evaluate(
      (generation) =>
        window.__fukamuLogoutPurgeHarness.snapshotVault(generation),
      vaultA,
    ),
  ).resolves.toEqual({ present: false, titles: [] });
  await expect(
    page.evaluate(
      (generation) =>
        window.__fukamuLogoutPurgeHarness.snapshotVault(generation),
      vaultB,
    ),
  ).resolves.toEqual({
    present: true,
    titles: ['Vault B retained content'],
  });
  await expect(
    page.evaluate(() => window.__fukamuLogoutPurgeHarness.cacheNames()),
  ).resolves.not.toContain('fukamu-notes-e2e-private');
  await expect(
    page.evaluate(() => window.__fukamuLogoutPurgeHarness.graphWorkerIsReset()),
  ).resolves.toBe(true);

  await page.goBack();
  await page.goForward();
  await expect(
    page.evaluate(
      (generation) =>
        window.__fukamuLogoutPurgeHarness.snapshotVault(generation),
      vaultA,
    ),
  ).resolves.toEqual({ present: false, titles: [] });

  const nextLogin = await context.newPage();
  await ready(nextLogin);
  await installHarness(nextLogin);
  await expect(
    nextLogin.evaluate(
      (generation) => window.__fukamuLogoutPurgeHarness.enterFence(generation),
      vaultB,
    ),
  ).resolves.toEqual({ kind: 'entered' });
  await expect(
    nextLogin.evaluate(
      (generation) =>
        window.__fukamuLogoutPurgeHarness.snapshotVault(generation),
      vaultB,
    ),
  ).resolves.toEqual({
    present: true,
    titles: ['Vault B retained content'],
  });

  await Promise.all([
    page.evaluate(() => window.__fukamuLogoutPurgeHarness.closeFence()),
    peer.evaluate(() => window.__fukamuLogoutPurgeHarness.closeFence()),
    nextLogin.evaluate(() => window.__fukamuLogoutPurgeHarness.closeFence()),
  ]);
});

test('account deletion survives reload after revocation and reuses verified logout purge', async ({
  page,
  context,
}) => {
  const peer = await context.newPage();
  await Promise.all([ready(page), ready(peer)]);
  await Promise.all([installHarness(page), installHarness(peer)]);

  await page.evaluate(
    async ({ first, second, cardId }) => {
      await window.__fukamuLogoutPurgeHarness.seedVault(
        first,
        cardId,
        'Vault A account deletion content',
      );
      await window.__fukamuLogoutPurgeHarness.seedVault(
        second,
        cardId,
        'Vault B isolated content',
      );
      await window.__fukamuLogoutPurgeHarness.seedNotesCache();
      void window.__fukamuLogoutPurgeHarness
        .prepareGraphWorker()
        .catch(() => undefined);
      history.pushState({}, '', `/cards/${cardId}`);
      history.pushState({}, '', '/history');
    },
    { first: vaultA, second: vaultB, cardId: sharedCardId },
  );
  await Promise.all([
    page.evaluate(
      (generation) => window.__fukamuLogoutPurgeHarness.enterFence(generation),
      vaultA,
    ),
    peer.evaluate(
      (generation) => window.__fukamuLogoutPurgeHarness.enterFence(generation),
      vaultA,
    ),
  ]);

  await expect(
    page.evaluate(
      (generation) =>
        window.__fukamuLogoutPurgeHarness.beginAccountDeletion(generation),
      vaultA,
    ),
  ).resolves.toEqual({
    kind: 'pending',
    localContent: 'deleted',
    status: {
      kind: 'in-progress',
      continuationToken: `ad1.${'S'.repeat(43)}.1`,
    },
  });
  await expect
    .poll(() =>
      peer.evaluate(() => window.__fukamuLogoutPurgeHarness.fenceStatus()),
    )
    .toBe('quiesced');
  await expect(
    page.evaluate(() =>
      window.__fukamuLogoutPurgeHarness.accountDeletionRemoteCalls(),
    ),
  ).resolves.toEqual(['start', 'resume:0']);
  await expect(
    page.evaluate(() =>
      window.__fukamuLogoutPurgeHarness.accountDeletionMarker(),
    ),
  ).resolves.toMatchObject({ kind: 'server-pending', revision: 4 });
  await expect(
    page.evaluate(
      (generation) =>
        window.__fukamuLogoutPurgeHarness.snapshotVault(generation),
      vaultA,
    ),
  ).resolves.toEqual({ present: false, titles: [] });
  await expect(
    page.evaluate(
      (generation) =>
        window.__fukamuLogoutPurgeHarness.snapshotVault(generation),
      vaultB,
    ),
  ).resolves.toEqual({
    present: true,
    titles: ['Vault B isolated content'],
  });
  await expect(
    page.evaluate(() => window.__fukamuLogoutPurgeHarness.cacheNames()),
  ).resolves.not.toContain('fukamu-notes-e2e-private');
  await expect(
    page.evaluate(() => window.__fukamuLogoutPurgeHarness.graphWorkerIsReset()),
  ).resolves.toBe(true);

  await page.reload();
  await expect(page.getByTestId('new-card')).toBeVisible();
  await installHarness(page);
  await expect(
    page.evaluate(() =>
      window.__fukamuLogoutPurgeHarness.recoverAccountDeletion(),
    ),
  ).resolves.toMatchObject({
    kind: 'pending',
    localContent: 'deleted',
  });
  await expect(
    page.evaluate(() =>
      window.__fukamuLogoutPurgeHarness.accountDeletionRemoteCalls(),
    ),
  ).resolves.toEqual([]);
  await expect(
    page.evaluate(() =>
      window.__fukamuLogoutPurgeHarness.resumeAccountDeletion(),
    ),
  ).resolves.toEqual({ kind: 'terminal', status: 'completed' });
  await expect(
    page.evaluate(() =>
      window.__fukamuLogoutPurgeHarness.accountDeletionRemoteCalls(),
    ),
  ).resolves.toEqual(['resume:1']);
  await expect(
    page.evaluate(() =>
      window.__fukamuLogoutPurgeHarness.accountDeletionMarker(),
    ),
  ).resolves.toBeUndefined();

  await page.goBack();
  await page.goForward();
  await expect(
    page.evaluate(
      (generation) =>
        window.__fukamuLogoutPurgeHarness.snapshotVault(generation),
      vaultA,
    ),
  ).resolves.toEqual({ present: false, titles: [] });

  await Promise.all([
    page.evaluate(() => window.__fukamuLogoutPurgeHarness.closeFence()),
    peer.evaluate(() => window.__fukamuLogoutPurgeHarness.closeFence()),
  ]);
});

async function ready(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('new-card')).toBeVisible();
  await page.locator('html[data-offline-ready=true]').waitFor({
    state: 'attached',
    timeout: 15_000,
  });
}

async function installHarness(page: Page): Promise<void> {
  harnessSource ??= buildHarness();
  await page.addScriptTag({ content: await harnessSource });
}

async function buildHarness(): Promise<string> {
  const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { '@': repositoryRoot } },
    build: {
      write: false,
      target: 'es2022',
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      lib: {
        entry: fileURLToPath(
          new URL('./fixtures/logout-purge-harness.ts', import.meta.url),
        ),
        name: 'FukamuLogoutPurgeHarness',
        formats: ['iife'],
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if (!('output' in output)) continue;
    for (const item of output.output) {
      if (item.type === 'chunk') return item.code;
    }
  }
  throw new Error('logout purge browser harness bundle is missing');
}

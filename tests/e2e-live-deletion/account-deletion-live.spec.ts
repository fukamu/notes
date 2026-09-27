import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const fixtureSessionToken = requiredEnvironment(
  'FUKAMU_DELETION_E2E_SESSION_TOKEN',
);

test('live disposable account deletion survives an actual Go restart', async ({
  page,
  context,
}) => {
  const outsideDestinations: string[] = [];
  context.on('request', (request) => {
    const destination = new URL(request.url());
    if (
      (destination.protocol === 'http:' || destination.protocol === 'https:') &&
      destination.origin !== 'http://localhost:3101'
    ) {
      outsideDestinations.push(destination.origin);
    }
  });
  await context.route(/^https?:\/\//u, async (route) => {
    const destination = new URL(route.request().url());
    if (destination.origin !== 'http://localhost:3101') {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await page.goto('/');
  await expect(page.getByTestId('new-card')).toBeVisible();
  await page.locator('html[data-offline-ready=true]').waitFor({
    state: 'attached',
    timeout: 15_000,
  });
  await page.getByTestId('new-card').click();
  const title = `destructive-evidence-${randomUUID()}`;
  const synced = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v2/sync' &&
      (response.request().postData() ?? '').includes(title),
  );
  await page.getByTestId('card-title').fill(title);
  await page
    .getByTestId('body-editor')
    .fill('This plaintext must be removed by the disposable deletion fixture.');
  expect((await synced).status()).toBe(200);
  await expect(page.getByTestId('save-sync-status')).toHaveText('保存済み');
  await expect(page.getByTestId('display-id')).toHaveAttribute(
    'data-kind',
    'official',
    { timeout: 15_000 },
  );
  await expectBrowserPrivateStatePresent(page, title);

  await page.getByRole('button', { name: 'アカウントを削除' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('元に戻すことはできません');
  const startResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/account/deletion',
  );
  const revokeResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/account/deletion/status',
  );
  await dialog.getByRole('button', { name: '削除を開始' }).click();
  expect((await startResponse).status()).toBe(202);
  expect((await revokeResponse).status()).toBe(202);
  await expect(
    page.getByText(
      '端末内のデータは削除されました。サーバー側の退会処理は継続中です。',
    ),
  ).toBeVisible();
  await expectSyncDenied(page, 'revoked');
  await expectBrowserPurge(page, title, false, false);

  await restartActualGoServer(page);
  await page.reload();
  await expect(
    page.getByText(
      '端末内のデータは削除されました。サーバー側の退会処理は継続中です。',
    ),
  ).toBeVisible();
  await expectSyncDenied(page, 'fenced');
  await expectBrowserPurge(page, title, false, true);

  let completed = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/account/deletion/status',
    );
    await page.getByRole('button', { name: '状態を確認' }).click();
    const response = await responsePromise;
    const result: unknown = await response.json();
    if (
      typeof result === 'object' &&
      result !== null &&
      'status' in result &&
      result.status === 'completed'
    ) {
      expect(response.status()).toBe(200);
      completed = true;
      break;
    }
    expect(response.status()).toBe(202);
    await expect(
      page.getByRole('button', { name: '状態を確認' }),
    ).toBeVisible();
  }
  expect(completed).toBe(true);
  await expect(
    page.getByText('退会手続きが完了し、この端末内のノートを削除しました。'),
  ).toBeVisible();
  await expectBrowserPurge(page, title, true, true);
  await expectSyncDenied(page, 'completed');

  await restartActualGoServer(page);
  await page.reload();
  await expect(page.getByText(title, { exact: false })).toHaveCount(0);
  await expect(page.getByTestId('new-card')).toHaveCount(0);
  await expectBrowserPurge(page, title, true, true);
  await expectSyncDenied(page, 'completed');
  expect(outsideDestinations).toEqual([]);
});

async function expectSyncDenied(
  page: Page,
  phase: 'revoked' | 'fenced' | 'completed',
): Promise<void> {
  const response = await page.request.post('/api/v2/sync', {
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:3101',
      'Sec-Fetch-Site': 'same-origin',
      Cookie: `__Host-fukamu_session=${fixtureSessionToken}`,
    },
    data: {
      version: 'sync/v2',
      deviceId: '01999c20-9e33-7000-8000-000000000901',
      cursor: null,
      mutations: [],
    },
  });
  expect({
    status: response.status(),
    body: (await response.json()) as unknown,
  }).toEqual(
    phase === 'revoked'
      ? { status: 401, body: { error: 'authentication-required' } }
      : { status: 404, body: { error: 'not-found' } },
  );
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be supplied by the deletion E2E launcher`);
  }
  return value;
}

async function expectBrowserPrivateStatePresent(
  page: Page,
  title: string,
): Promise<void> {
  const state = await page.evaluate(async () => {
    const databaseNames = (await indexedDB.databases())
      .map(({ name }) => name)
      .filter((name): name is string => name !== undefined);
    const vaultDatabase = databaseNames.find((name) =>
      name.startsWith('fukamu-notes:v1:vault:'),
    );
    if (vaultDatabase === undefined) {
      return { databaseNames, cacheNames: await caches.keys(), cards: '' };
    }
    const cards = await new Promise<string>((resolve, reject) => {
      const request = indexedDB.open(vaultDatabase);
      request.addEventListener('error', () => reject(request.error), {
        once: true,
      });
      request.addEventListener(
        'success',
        () => {
          const database = request.result;
          const get = database
            .transaction('cards', 'readonly')
            .objectStore('cards')
            .getAll();
          get.addEventListener(
            'success',
            () => {
              database.close();
              resolve(JSON.stringify(get.result));
            },
            { once: true },
          );
          get.addEventListener(
            'error',
            () => {
              database.close();
              reject(get.error);
            },
            { once: true },
          );
        },
        { once: true },
      );
    });
    return { databaseNames, cacheNames: await caches.keys(), cards };
  });
  expect(
    state.databaseNames.filter((name) =>
      name.startsWith('fukamu-notes:v1:vault:'),
    ),
  ).toHaveLength(1);
  expect(
    state.cacheNames.some((name) => name.startsWith('fukamu-notes-')),
  ).toBe(true);
  expect(state.cards).toContain(title);
}

async function expectBrowserPurge(
  page: Page,
  title: string,
  terminalMarkerCleared: boolean,
  allowPublicShellCache: boolean,
): Promise<void> {
  const cookies = await page.context().cookies();
  expect(cookies.some(({ name }) => name === '__Host-fukamu_session')).toBe(
    false,
  );
  const state = await page.evaluate(async () => {
    const databaseNames = (await indexedDB.databases())
      .map(({ name }) => name)
      .filter((name): name is string => name !== undefined);
    const cacheNames = await caches.keys();
    const cacheEntries = await Promise.all(
      cacheNames.map(async (name) => ({
        name,
        urls: (await (await caches.open(name)).keys()).map(({ url }) => url),
      })),
    );
    const storageValues = (storage: Storage) =>
      Array.from({ length: storage.length }, (_, index) => {
        const key = storage.key(index);
        return key === null ? '' : (storage.getItem(key) ?? '');
      });
    const storedText = [
      ...storageValues(localStorage),
      ...storageValues(sessionStorage),
    ].join('\n');
    const marker = await new Promise<unknown>((resolve, reject) => {
      const request = indexedDB.open('fukamu-notes:control:v1', 2);
      request.addEventListener('error', () => reject(request.error), {
        once: true,
      });
      request.addEventListener(
        'success',
        () => {
          const database = request.result;
          const transaction = database.transaction(
            'account-deletion-handoff',
            'readonly',
          );
          const get = transaction
            .objectStore('account-deletion-handoff')
            .get('current');
          get.addEventListener(
            'success',
            () => {
              const result: unknown = get.result;
              database.close();
              resolve(result);
            },
            { once: true },
          );
          get.addEventListener(
            'error',
            () => {
              database.close();
              reject(get.error);
            },
            { once: true },
          );
        },
        { once: true },
      );
    });
    return {
      databaseNames,
      cacheNames,
      cacheEntries,
      storedText,
      visibleText: document.body.textContent ?? '',
      markerPresent: marker !== undefined,
    };
  });
  expect(
    state.databaseNames.filter((name) =>
      name.startsWith('fukamu-notes:v1:vault:'),
    ),
  ).toEqual([]);
  const notesCaches = state.cacheNames.filter((name) =>
    name.startsWith('fukamu-notes-'),
  );
  if (allowPublicShellCache) {
    expect(notesCaches.every((name) => name === 'fukamu-notes-static-v4')).toBe(
      true,
    );
    for (const cache of state.cacheEntries) {
      expect(cache.name).toBe('fukamu-notes-static-v4');
      for (const rawURL of cache.urls) {
        const url = new URL(rawURL);
        expect(url.origin).toBe('http://localhost:3101');
        expect(url.search).toBe('');
        expect(url.hash).toBe('');
        expect(
          url.pathname === '/' ||
            url.pathname === '/manifest.webmanifest' ||
            url.pathname === '/favicon.svg' ||
            url.pathname.startsWith('/assets/'),
        ).toBe(true);
      }
    }
  } else {
    expect(notesCaches).toEqual([]);
  }
  expect(state.storedText).not.toContain(title);
  expect(state.visibleText).not.toContain(title);
  expect(state.markerPresent).toBe(!terminalMarkerCleared);
}

async function restartActualGoServer(page: Page): Promise<void> {
  const directory = process.env.FUKAMU_DELETION_E2E_CONTROL;
  if (directory === undefined) {
    throw new Error('deletion E2E restart control is unavailable');
  }
  const request = path.join(directory, 'restart.request');
  const completed = path.join(directory, 'restart.completed');
  const failed = path.join(directory, 'restart.failed');
  const restartId = randomUUID();
  await rm(completed, { force: true });
  await rm(failed, { force: true });
  await writeFile(request, restartId, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  await waitForActualGoRestart(completed, failed, restartId);
  await expect
    .poll(async () => {
      try {
        return (await page.request.get('/healthz')).status();
      } catch {
        return 0;
      }
    })
    .toBe(200);
}

async function waitForActualGoRestart(
  completed: string,
  failed: string,
  restartId: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await readFile(failed, 'utf8').catch(() => '')) === restartId) {
      throw new Error(
        'actual Go server exited nonzero while handling the restart signal',
      );
    }
    if ((await readFile(completed, 'utf8').catch(() => '')) === restartId) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    'actual Go server restart did not complete within 30 seconds',
  );
}

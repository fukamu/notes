import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

test('privacy policy reaches a durable Go journal while browser state stays ephemeral', async ({
  page,
}) => {
  await page.goto('/legal/privacy');
  await page.getByRole('link', { name: '専用accountページで請求する' }).click();
  await expect(
    page.getByRole('heading', { name: '個人情報に関する請求', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId('privacy-request-fixture-notice'),
  ).toContainText('受付記録はテスト用PostgreSQLへ保存されます');
  await expect(page.getByTestId('new-card')).toHaveCount(0);

  const submittedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/account/privacy-requests'),
  );
  await page.getByTestId('submit-privacy-request').click();
  const submitted = await submittedResponse;
  expect(submitted.status()).toBe(202);
  const submittedBody: unknown = await submitted.json();
  expect(submittedBody).toMatchObject({
    requestKind: 'disclosure',
    status: 'verification-pending',
  });
  if (!isPendingPrivacyResponse(submittedBody)) {
    throw new Error('Go privacy response did not satisfy the browser contract');
  }
  await expect(page.getByRole('status')).toHaveText('本人確認待ち');
  await page.getByRole('button', { name: '最新状態を確認' }).click();
  await expect(page.getByRole('status')).toHaveText('本人確認待ち');

  await restartGoE2EServer(page);
  await page.reload();
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByLabel('請求内容')).toHaveValue('disclosure');
  const durable = await page.evaluate(async (requestId) => {
    const response = await fetch('/api/account/privacy-requests/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  }, submittedBody.requestId);
  expect(durable.status).toBe(202);
  expect(durable.body).toEqual(submittedBody);
});

async function restartGoE2EServer(page: Page): Promise<void> {
  const directory = process.env.FUKAMU_E2E_RESTART_CONTROL;
  if (directory === undefined) {
    throw new Error('E2E restart control is unavailable');
  }
  const request = path.join(directory, 'restart.request');
  const completed = path.join(directory, 'restart.completed');
  const restartId = randomUUID();
  await rm(completed, { force: true });
  await writeFile(request, restartId, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  await expect
    .poll(async () => readFile(completed, 'utf8').catch(() => ''))
    .toBe(restartId);
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

function isPendingPrivacyResponse(value: unknown): value is {
  readonly requestId: string;
  readonly status: 'verification-pending';
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'requestId' in value &&
    typeof value.requestId === 'string' &&
    'status' in value &&
    value.status === 'verification-pending'
  );
}

test('deletion request uses a confirmation dialog and never claims deletion', async ({
  page,
}) => {
  await page.goto('/account/privacy');
  await page.getByLabel('請求内容').selectOption('deletion');
  const trigger = page.getByTestId('submit-privacy-request');
  await trigger.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('受付だけで直ちに削除完了とは扱いません');
  await dialog.getByRole('button', { name: '請求せず戻る' }).click();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await dialog.getByRole('button', { name: '退会・削除を請求する' }).click();
  await expect(page.getByRole('status')).toHaveText('本人確認待ち');
  await expect(page.getByText('削除完了', { exact: true })).toHaveCount(0);
});

test('back-forward restoration does not resurrect local request content in Notes', async ({
  page,
}) => {
  await page.goto('/account/privacy');
  await page.getByTestId('submit-privacy-request').click();
  await expect(page.getByRole('status')).toBeVisible();
  await page
    .getByRole('navigation', { name: '個人情報に関するリンク' })
    .getByRole('link', { name: '個人情報保護方針' })
    .click();
  await page.goBack();
  await expect(page.getByRole('status')).toHaveCount(0);

  await page.getByRole('link', { name: 'ノートへ戻る' }).click();
  await expect(page.getByTestId('new-card')).toBeVisible();
  await expect(page.getByTestId('privacy-request-fixture-notice')).toHaveCount(
    0,
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

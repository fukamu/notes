import { expect, test } from '@playwright/test';

test('public navigation reaches the dedicated versioned terms page', async ({
  page,
}) => {
  await page.goto('/pricing');
  await page.getByRole('link', { name: '利用規約' }).first().click();
  await expect(
    page.getByRole('heading', { name: '利用規約', exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('legal-fixture-notice')).toContainText(
    'ローカル開発・テスト専用のサンプル規約',
  );
  for (const label of [
    '利用資格',
    '禁止行為',
    '利用者content',
    '料金・無料期間・更新',
    '責任・損害',
    'version・施行日',
  ]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('terms-v1:2026-09-15')).toBeVisible();
});

test('terms content and dialogs remain outside the normal Notes interface', async ({
  page,
}) => {
  await page.goto('/legal/terms');
  await expect(page.getByTestId('new-card')).toHaveCount(0);
  await page.goto('/');
  await expect(page.getByTestId('new-card')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: '利用規約', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId('legal-fixture-notice')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

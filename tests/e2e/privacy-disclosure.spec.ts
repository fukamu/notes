import { expect, test } from '@playwright/test';

test('public navigation reaches the canonical privacy page', async ({
  page,
}) => {
  await page.goto('/pricing');
  await page.getByRole('link', { name: '個人情報保護方針' }).first().click();

  await expect(
    page.getByRole('heading', { name: '個人情報保護方針', exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('legal-fixture-notice')).toContainText(
    'ローカル開発・テスト専用のサンプル方針',
  );
  for (const term of [
    '取得する情報・取得元・利用目的',
    '保存期間・削除',
    '安全管理措置の概要',
    '本人からの請求',
  ]) {
    await expect(page.getByText(term, { exact: true })).toBeVisible();
  }
  await expect(
    page.getByRole('link', { name: '個人情報に関する窓口' }),
  ).toBeVisible();
});

test('privacy policy remains separate from the normal Notes interface', async ({
  page,
}) => {
  await page.goto('/legal/privacy');
  await expect(page.getByTestId('new-card')).toHaveCount(0);
  await expect(page.getByTestId('legal-fixture-notice')).toBeVisible();

  await page.goto('/');
  await expect(page.getByTestId('new-card')).toBeVisible();
  await expect(page.getByTestId('legal-fixture-notice')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: '個人情報保護方針' }),
  ).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

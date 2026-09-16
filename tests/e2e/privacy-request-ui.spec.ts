import { expect, test } from '@playwright/test';

test('privacy policy reaches a dedicated non-persistent request page', async ({
  page,
}) => {
  await page.goto('/legal/privacy');
  await page.getByRole('link', { name: '専用accountページで請求する' }).click();
  await expect(
    page.getByRole('heading', { name: '個人情報に関する請求', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId('privacy-request-fixture-notice'),
  ).toContainText('本人確認、データ開示・変更・削除、退会は行われず');
  await expect(page.getByTestId('new-card')).toHaveCount(0);

  await page.getByTestId('submit-privacy-request').click();
  await expect(page.getByRole('status')).toHaveText('本人確認待ち');
  await page.getByRole('button', { name: '最新状態を確認' }).click();
  await expect(page.getByRole('status')).toHaveText('本人確認待ち');

  await page.reload();
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByLabel('請求内容')).toHaveValue('disclosure');
});

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

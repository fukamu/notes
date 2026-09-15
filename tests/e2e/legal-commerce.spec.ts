import { expect, test } from '@playwright/test';

test('pricing and public navigation lead to the dedicated legal disclosure', async ({
  page,
}) => {
  await page.goto('/pricing');
  await expect(
    page.getByRole('heading', { name: '料金', exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('legal-fixture-notice')).toBeVisible();
  await expect(page.getByText('980円（税込）')).toBeVisible();
  await expect(page.getByText('15日目に初回課金します。')).toBeVisible();
  await page
    .getByRole('link', { name: '特定商取引法に基づく表記' })
    .first()
    .click();

  await expect(
    page.getByRole('heading', {
      name: '特定商取引法に基づく表記',
      exact: true,
    }),
  ).toBeVisible();
  for (const term of [
    '販売事業者',
    '販売価格',
    '支払時期',
    '解約',
    '動作環境',
  ]) {
    await expect(page.getByText(term, { exact: true })).toBeVisible();
  }
  await expect(
    page.getByText(/無料期間の終了時まで利用できます/),
  ).toBeVisible();
  await expect(
    page.getByText(/日割り計算せず、通常は返金しません/),
  ).toBeVisible();
  await page.getByRole('link', { name: '会社概要' }).first().click();
  await expect(
    page.getByRole('heading', { name: '会社概要', exact: true }),
  ).toBeVisible();
});

test('legal pages remain separate from the normal notes interface', async ({
  page,
}) => {
  await page.goto('/legal/commercial-transactions');
  await expect(page.getByTestId('new-card')).toHaveCount(0);
  await expect(page.getByTestId('legal-fixture-notice')).toBeVisible();

  await page.goto('/');
  await expect(page.getByTestId('new-card')).toBeVisible();
  await expect(page.getByTestId('legal-fixture-notice')).toHaveCount(0);
});

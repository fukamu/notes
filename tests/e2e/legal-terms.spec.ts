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
    '会社名、所在地、電話番号と窓口は置換用のサンプル',
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
  await expect(
    page.getByText(
      '利用登録には、法定代理人の同意を要せず、ご本人が有料サブスクリプション契約を有効に締結できることが必要です。',
    ),
  ).toBeVisible();
  await expect(page.getByText(/対象年齢|18歳以上/)).toHaveCount(0);
  await expect(page.getByText(/原則として終了日の30日前/)).toBeVisible();
  await expect(page.getByText(/直近12か月間/)).toBeVisible();
  await expect(
    page.getByText(/消費者に法令上認められる裁判管轄を排除しません/),
  ).toBeVisible();
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

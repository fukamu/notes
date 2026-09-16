import { expect, test } from '@playwright/test';

test('checkout discloses Stripe card handling and possible 3DS without contacting Stripe', async ({
  page,
}) => {
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== 'http://localhost:3100') externalRequests.push(url.href);
  });

  await page.goto('/checkout');

  const notice = page.getByTestId('card-security-notice');
  await expect(notice).toContainText(
    'カード番号・セキュリティコードはStripeの画面で入力され',
  );
  await expect(notice).toContainText('サーバーでは取得・保存しません');
  await expect(notice).toContainText('本人認証（3Dセキュア）');
  await expect(
    notice.getByRole('link', { name: '外部送信に関する表示' }),
  ).toHaveAttribute('href', '/legal/external-transmission');
  await expect(page.locator('input[name*="card" i]')).toHaveCount(0);
  await expect(page.locator('input[autocomplete="cc-number"]')).toHaveCount(0);
  expect(externalRequests).toEqual([]);
});

test('card security disclosure remains outside the Notes workspace', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('card-security-notice')).toHaveCount(0);
  await expect(page.getByText('本人認証（3Dセキュア）')).toHaveCount(0);
});

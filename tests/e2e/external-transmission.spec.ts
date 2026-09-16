import { expect, test } from '@playwright/test';

test('privacy and the public footer reach the dedicated external transmission page', async ({
  page,
}) => {
  const response = await page.goto('/legal/privacy');
  expect(response?.headers()['content-security-policy']).toContain(
    "connect-src 'self'",
  );
  await page.getByRole('link', { name: '外部送信について確認する' }).click();

  await expect(
    page.getByRole('heading', { name: '外部送信について', exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('legal-fixture-notice')).toContainText(
    'Google LoginとStripe Checkoutへの実接続を行いません',
  );
  await expect(
    page.getByRole('heading', { name: 'Google Login（OpenID Connect）' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Stripe Checkout' }),
  ).toBeVisible();
  await expect(page.getByText('Google LLC', { exact: true })).toBeVisible();
  await expect(
    page.getByText('広告、行動分析またはerror monitoring'),
  ).toBeVisible();

  await page.goto('/pricing');
  await page
    .getByRole('contentinfo')
    .getByRole('link', { name: '外部送信' })
    .click();
  await expect(
    page.getByRole('heading', { name: '外部送信について', exact: true }),
  ).toBeVisible();
});

test('external transmission disclosure stays out of the Notes interface', async ({
  page,
}) => {
  const externalOrigins = new Set<string>();
  const expectedOrigin = 'http://localhost:3100';
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== expectedOrigin) externalOrigins.add(url.origin);
  });
  await page.goto('/');
  await expect(page.getByTestId('new-card')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: '外部送信について' }),
  ).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect([...externalOrigins]).toEqual([]);
});

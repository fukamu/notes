import { expect, test } from '@playwright/test';
import { assertionForSubject, localAssertionHeader } from './identity-fixture';

test('an unapproved production-like browser sees the limited-release screen and cannot call sync directly', async ({
  browser,
}) => {
  const context = await browser.newContext({
    extraHTTPHeaders: {
      [localAssertionHeader]: assertionForSubject(
        'fukamu-notes-e2e-not-allowed',
      ),
    },
  });
  const page = await context.newPage();

  await page.goto('/');
  await expect(
    page.getByText('現在、このサービスは限定公開中です。'),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: '許可済みアカウントでログイン' }),
  ).toHaveCount(0);

  const response = await context.request.post('/api/sync', { data: {} });
  expect(response.status()).toBe(403);
  expect(await response.json()).toEqual({ error: 'launch-access-denied' });

  await context.close();
});

test('the approved production-like identity reaches the Notes application after reload', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('new-card').first()).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('new-card').first()).toBeVisible();
});

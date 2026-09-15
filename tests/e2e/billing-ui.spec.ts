import { expect, test } from '@playwright/test';

const initialOfferHash = `sha256:${'0'.repeat(64)}`;
const refreshedOfferHash = `sha256:${'b'.repeat(64)}`;
const evidenceId = '01991f20-61d2-7000-8000-000000002301';

test('local fixture exercises checkout and cancellation without a provider', async ({
  page,
}) => {
  await page.goto('/pricing');
  await page.getByRole('link', { name: '申込み内容を確認する' }).click();
  await expect(page.getByTestId('billing-fixture-notice')).toBeVisible();
  await page
    .getByRole('checkbox', { name: /有料サブスクリプションの申込み/ })
    .check();
  await page.getByRole('checkbox', { name: /利用規約.*同意/ }).check();
  await page.getByTestId('confirm-subscription').click();
  await expect(
    page.getByRole('heading', { name: '開発用の申込み確認' }),
  ).toBeVisible();
  await expect(page.getByTestId('hosted-checkout-link')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText(
    '契約、カード登録、課金、利用権の変更は行われていません',
  );

  await page.getByRole('link', { name: '契約管理のサンプルを開く' }).click();
  await page.getByRole('button', { name: 'サブスクリプションを解約' }).click();
  await page.getByRole('button', { name: '解約を申し込む' }).click();
  await expect(page.getByTestId('cancellation-confirmed')).toContainText(
    '実際の契約状態は変更されていません',
  );
});

test('dedicated checkout keeps legal detail out of Notes and requires affirmative consent', async ({
  page,
}) => {
  let checkoutRequests = 0;
  await page.route('**/api/billing/checkout', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    checkoutRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        kind: 'redirect',
        evidenceOutcome: 'recorded',
        evidenceId,
        offerHash: initialOfferHash,
        offerVersion: 'legal-commerce-v1:2026-09-15',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_fukamu',
      }),
    });
  });

  await page.goto('/checkout');
  await expect(
    page.getByRole('heading', { name: '申込み内容の最終確認' }),
  ).toBeVisible();
  await expect(page.getByTestId('billing-fixture-notice')).toBeVisible();
  for (const label of [
    '無料期間',
    '初回課金',
    '自動更新',
    '支払方法',
    '解約',
    '返金・日割り',
    '支払い失敗時',
    '解約と退会',
  ]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByTestId('checkout-terms-reference')).toContainText(
    'terms-v1:2026-09-15',
  );
  await expect(
    page.getByRole('link', { name: '独立した利用規約ページ' }),
  ).toHaveAttribute('href', '/legal/terms');

  const submit = page.getByTestId('confirm-subscription');
  await expect(submit).toBeDisabled();
  await page
    .getByRole('checkbox', { name: /有料サブスクリプションの申込み/ })
    .check();
  await expect(submit).toBeDisabled();
  await page.getByRole('checkbox', { name: /利用規約.*同意/ }).check();
  await expect(submit).toBeEnabled();
  await submit.evaluate((element) => {
    if (!(element instanceof HTMLButtonElement)) {
      throw new Error('expected checkout button');
    }
    element.click();
    element.click();
  });

  await expect(
    page.getByRole('heading', { name: 'カード情報の登録へ進む' }),
  ).toBeVisible();
  await expect(page.getByTestId('hosted-checkout-link')).toHaveAttribute(
    'href',
    'https://checkout.stripe.com/c/pay/cs_test_fukamu',
  );
  await expect(page.getByTestId('billing-terms')).toBeVisible();
  expect(checkoutRequests).toBe(1);

  await page.getByRole('button', { name: '申込み内容をもう一度確認' }).click();
  await expect(page.getByRole('checkbox')).toHaveCount(2);
  for (const checkbox of await page.getByRole('checkbox').all()) {
    await expect(checkbox).not.toBeChecked();
  }

  await page.getByRole('link', { name: '料金へ戻って確認・訂正' }).click();
  await expect(
    page.getByRole('heading', { name: '料金', exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: '申込み内容の最終確認' }),
  ).toBeVisible();
});

test('a stale offer is reloaded and must be accepted again', async ({
  page,
}) => {
  let postCount = 0;
  await page.route('**/api/billing/checkout', async (route) => {
    if (route.request().method() === 'POST') {
      postCount += 1;
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'offer-changed' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        offer: checkoutOffer({ priceYen: 1_280, effectiveDate: '2026-09-15' }),
        offerHash: refreshedOfferHash,
      }),
    });
  });

  await page.goto('/checkout');
  await page
    .getByRole('checkbox', { name: /有料サブスクリプションの申込み/ })
    .check();
  await page.getByRole('checkbox', { name: /利用規約.*同意/ }).check();
  await page.getByTestId('confirm-subscription').click();
  await expect(
    page.getByText(
      '申込み条件が更新されました。最新内容を確認し、チェックを入れ直してください。',
    ),
  ).toBeVisible();
  await expect(
    page.getByText('1,280円（税込）', { exact: false }).first(),
  ).toBeVisible();
  for (const checkbox of await page.getByRole('checkbox').all()) {
    await expect(checkbox).not.toBeChecked();
  }
  await expect(page.getByTestId('confirm-subscription')).toBeDisabled();
  expect(postCount).toBe(1);
});

test('a server terms gate rejection reloads and clears both checkout consents', async ({
  page,
}) => {
  await page.route('**/api/billing/checkout', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'terms-consent-required' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        offer: checkoutOffer({ priceYen: 1_280, effectiveDate: '2026-09-14' }),
        offerHash: initialOfferHash,
      }),
    });
  });

  await page.goto('/checkout');
  await page
    .getByRole('checkbox', { name: /有料サブスクリプションの申込み/ })
    .check();
  await page.getByRole('checkbox', { name: /利用規約.*同意/ }).check();
  await page.getByTestId('confirm-subscription').click();
  await expect(
    page.getByText(
      '利用規約が更新されました。最新内容を確認し、両方のチェックを入れ直してください。',
    ),
  ).toBeVisible();
  for (const checkbox of await page.getByRole('checkbox').all()) {
    await expect(checkbox).not.toBeChecked();
  }
  await expect(page.getByTestId('confirm-subscription')).toBeDisabled();
});

test('checkout retry reuses the same submission identifier', async ({
  page,
}) => {
  const submissions: string[] = [];
  await page.route('**/api/billing/checkout', async (route) => {
    const command = requestRecord(route.request().postData());
    const submissionId = command.submissionId;
    if (typeof submissionId !== 'string') {
      throw new Error('missing submission ID');
    }
    submissions.push(submissionId);
    if (submissions.length === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'unavailable' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        kind: 'redirect',
        evidenceOutcome: 'replayed',
        evidenceId,
        offerHash: initialOfferHash,
        offerVersion: 'legal-commerce-v1:2026-09-15',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_retry',
      }),
    });
  });

  await page.goto('/checkout');
  await page
    .getByRole('checkbox', { name: /有料サブスクリプションの申込み/ })
    .check();
  await page.getByRole('checkbox', { name: /利用規約.*同意/ }).check();
  await page.getByTestId('confirm-subscription').click();
  await expect(
    page.getByText(/入力内容は変えずに再試行できます/),
  ).toBeVisible();
  await page.getByTestId('confirm-subscription').click();
  await expect(page.getByTestId('hosted-checkout-link')).toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toBe(submissions[0]);
});

test('account billing cancellation uses an accessible dialog, focus return, and stable retry', async ({
  page,
}) => {
  const cancellationKeys: string[] = [];
  await page.route('**/api/billing/cancel', async (route) => {
    const command = requestRecord(route.request().postData());
    const key = command.idempotencyKey;
    if (typeof key !== 'string') throw new Error('missing cancellation key');
    cancellationKeys.push(key);
    if (cancellationKeys.length === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'unavailable' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'cancelled',
        outcome: 'cancelled',
        confirmedAt: 2_000,
      }),
    });
  });

  await page.goto('/account/billing');
  const trigger = page.getByRole('button', {
    name: 'サブスクリプションを解約',
  });
  await trigger.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '解約せず戻る' }).click();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await dialog.getByRole('button', { name: '解約を申し込む' }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    '解約済みにはしていません',
  );
  await dialog.getByRole('button', { name: '同じ内容で再試行' }).click();
  await expect(page.getByTestId('cancellation-confirmed')).toBeVisible();
  expect(cancellationKeys).toHaveLength(2);
  expect(cancellationKeys[1]).toBe(cancellationKeys[0]);
});

test('account terms uses a dedicated keyboard-accessible page and resets on navigation', async ({
  page,
}) => {
  await page.goto('/account/terms');
  await expect(
    page.getByRole('heading', { name: '利用規約の確認' }),
  ).toBeVisible();
  await expect(page.getByTestId('terms-consent-fixture-notice')).toBeVisible();
  await expect(page.getByTestId('new-card')).toHaveCount(0);
  const checkbox = page.getByRole('checkbox', {
    name: /利用規約.*全文.*同意/,
  });
  const accept = page.getByTestId('accept-current-terms');
  await expect(checkbox).not.toBeChecked();
  await expect(accept).toBeDisabled();

  await page.getByRole('link', { name: '独立した利用規約ページ' }).click();
  await expect(page.getByRole('heading', { name: '利用規約' })).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: '利用規約の確認' }),
  ).toBeVisible();
  await expect(checkbox).not.toBeChecked();

  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(accept).toBeEnabled();
  await accept.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText(
    '現在の利用規約への同意を記録しました',
  );
  await expect(page.getByRole('checkbox')).toHaveCount(0);

  await page.getByRole('link', { name: 'ノートへ戻る' }).click();
  await expect(page.getByTestId('new-card')).toBeVisible();
  await expect(page.getByTestId('terms-consent-panel')).toHaveCount(0);
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: '利用規約の確認' }),
  ).toBeVisible();
});

test('billing pages do not mount in the normal Notes interface', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('new-card')).toBeVisible();
  await expect(page.getByTestId('billing-fixture-notice')).toHaveCount(0);
  await expect(page.getByTestId('billing-terms')).toHaveCount(0);
  await expect(page.getByTestId('terms-consent-panel')).toHaveCount(0);

  await page.goto('/account/billing');
  await expect(page.getByTestId('new-card')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '契約管理' })).toBeVisible();
  await expect(
    page.getByRole('link', { name: '利用規約の同意状態' }),
  ).toHaveAttribute('href', '/account/terms');
});

function requestRecord(body: string | null): Record<string, unknown> {
  if (body === null) throw new Error('missing request body');
  const input: unknown = JSON.parse(body);
  if (!isRecord(input)) {
    throw new Error('invalid request body');
  }
  return input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function checkoutOffer(input: {
  readonly priceYen: number;
  readonly effectiveDate: string;
}) {
  return {
    schemaVersion: 1,
    offerVersion: `legal-commerce-v1:${input.effectiveDate}`,
    disclosureVersion: input.effectiveDate,
    serviceName: 'FUKAMU Notes',
    quantity: 'one-personal-vault',
    planName: '更新後の月額プラン',
    priceYen: input.priceYen,
    billingPeriod: 'monthly',
    taxIncluded: true,
    trialDays: 14,
    trialPriceYen: 0,
    firstChargeDay: 15,
    renewalChargeYen: input.priceYen,
    annualEstimateYen: input.priceYen * 12,
    automaticRenewal: true,
    paymentMethod: 'credit-card',
    serviceStart: 'after-registration-and-payment-method-confirmation',
    servicePeriod: 'indefinite-until-cancelled',
    cancellationPolicy: '契約管理画面からいつでも解約できます。',
    refundPolicy: '支払い済み期間の日割り返金は行いません。',
    additionalFees: 'インターネット接続料金は利用者負担です。',
    onlineLockPolicy: 'immediate-on-payment-failure-or-action-required',
    cancellationSeparateFromAccountDeletion: true,
  };
}

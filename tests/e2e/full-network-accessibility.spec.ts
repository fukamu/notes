import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

let harnessSource: string | undefined;

async function installHarness(page: Page): Promise<void> {
  harnessSource ??= await buildHarness();
  await page.addScriptTag({ content: harnessSource });
}

async function buildHarness(): Promise<string> {
  const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { '@': repositoryRoot } },
    build: {
      write: false,
      target: 'es2022',
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      lib: {
        entry: fileURLToPath(
          new URL(
            './fixtures/full-network-accessibility-harness.ts',
            import.meta.url,
          ),
        ),
        name: 'FukamuFullNetworkAccessibilityHarness',
        formats: ['iife'],
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if (!('output' in output)) continue;
    for (const item of output.output) {
      if (item.type === 'chunk') return item.code;
    }
  }
  throw new Error('full-network accessibility browser harness is missing');
}

test('10k graph stays DOM-bounded while keyboard reaches nodes, links and cards', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.goto('/');
  await installHarness(page);
  const initial = await page.evaluate(() =>
    window.__fukamuFullNetworkAccessibilityHarness.initialize(),
  );
  expect(initial.nodeCount).toBe(10_000);
  expect(initial.edgeCount).toBe(9_999);
  expect(initial.overlayCount).toBeGreaterThan(0);
  expect(initial.overlayCount).toBeLessThan(200);
  expect(initial.summary).toContain('全10,000枚、全9,999本');
  expect(initial.reducedMotion).toBe(true);
  expect(initial.highContrast).toBe(true);

  const region = page.getByRole('region', { name: 'つながりマップ' });
  await expect(region).toBeVisible();
  await expect(region).toHaveAttribute('tabindex', '0');
  const overlay = page.getByTestId('full-network-accessibility-overlay');
  await expect(overlay.locator('button')).toHaveCount(initial.overlayCount);
  const firstOverlayNode = overlay.locator('button').first();
  await expect(firstOverlayNode).toHaveAccessibleName(/Primary vault card/);
  await expect(firstOverlayNode).toHaveCSS('width', '44px');
  await expect(firstOverlayNode).toHaveCSS('height', '44px');
  await firstOverlayNode.click();
  expect(
    (
      await page.evaluate(() =>
        window.__fukamuFullNetworkAccessibilityHarness.state(),
      )
    ).openedCardId,
  ).not.toBeNull();
  await expect(
    page.getByTestId('full-network-accessibility-harness').locator('ul, ol'),
  ).toHaveCount(0);

  await region.focus();
  await page.keyboard.press('n');
  await expect(
    page.getByTestId('full-network-accessibility-live'),
  ).toContainText('カード 2/10000');
  await page.keyboard.press('e');
  await expect(
    page.getByTestId('full-network-accessibility-live'),
  ).toContainText('リンク 1/9999');
  await page.keyboard.press('Shift+e');
  await expect(
    page.getByTestId('full-network-accessibility-live'),
  ).toContainText('リンク 9999/9999');
  await page.keyboard.press('l');
  await page.keyboard.press('c');
  await page.keyboard.press('Alt+ArrowRight');
  await page.keyboard.press('Enter');
  const opened = await page.evaluate(() =>
    window.__fukamuFullNetworkAccessibilityHarness.state(),
  );
  expect(opened.openedCardId).not.toBeNull();
});

test('incomplete and failed rendering use bounded explicit retry states', async ({
  page,
}) => {
  await page.goto('/');
  await installHarness(page);
  const initial = await page.evaluate(() =>
    window.__fukamuFullNetworkAccessibilityHarness.initialize(128),
  );
  expect(initial.overlayCount).toBeGreaterThan(0);

  const stale = await page.evaluate(() =>
    window.__fukamuFullNetworkAccessibilityHarness.fail('worker-stale'),
  );
  expect(stale.statusRole).toBe('status');
  expect(stale.overlayCount).toBe(initial.overlayCount);
  await page.getByRole('button', { name: '再試行' }).click();
  const retried = await page.evaluate(() =>
    window.__fukamuFullNetworkAccessibilityHarness.state(),
  );
  expect(retried.retryCount).toBe(1);
  expect(retried.retryDisabled).toBe(true);

  const invalid = await page.evaluate(() =>
    window.__fukamuFullNetworkAccessibilityHarness.fail('invalid-response'),
  );
  expect(invalid.statusRole).toBe('alert');
  expect(invalid.statusText).toContain('配置データを確認できませんでした');
  expect(invalid.overlayCount).toBe(0);
  const contextLost = await page.evaluate(() =>
    window.__fukamuFullNetworkAccessibilityHarness.fail('context-lost'),
  );
  expect(contextLost.statusRole).toBe('alert');
  expect(contextLost.statusText).toContain('描画を継続できませんでした');
  expect(contextLost.overlayCount).toBe(0);
  const allocation = await page.evaluate(() =>
    window.__fukamuFullNetworkAccessibilityHarness.fail('allocation-failure'),
  );
  expect(allocation.statusRole).toBe('alert');
  expect(allocation.statusText).toContain('描画できませんでした');
  expect(allocation.overlayCount).toBe(0);
  const loading = await page.evaluate(() =>
    window.__fukamuFullNetworkAccessibilityHarness.fail('loading'),
  );
  expect(loading.statusRole).toBe('status');
  expect(loading.statusText).toContain('準備しています');
  expect(loading.overlayCount).toBe(0);
  await expect(
    page.getByRole('region', { name: 'つながりマップ' }),
  ).toHaveAttribute('aria-busy', 'true');
});

test('destroy and Vault/session replacement remove prior accessible content', async ({
  page,
}) => {
  await page.goto('/');
  await installHarness(page);
  await page.evaluate(() =>
    window.__fukamuFullNetworkAccessibilityHarness.initialize(128),
  );
  expect(
    await page.evaluate(() =>
      window.__fukamuFullNetworkAccessibilityHarness.scopeMismatch(),
    ),
  ).toContain('scope mismatch');
  const destroyed = await page.evaluate(() =>
    window.__fukamuFullNetworkAccessibilityHarness.destroy(),
  );
  expect(destroyed.overlayCount).toBe(0);
  expect(destroyed.regionRole).toBeNull();
  expect(destroyed.regionName).toBeNull();
  expect(destroyed.summary).toBe('');
  expect(destroyed.selection).toBe('');

  const next = await page.evaluate(() =>
    window.__fukamuFullNetworkAccessibilityHarness.reenter(),
  );
  expect(next.nodeCount).toBe(64);
  expect(next.summary).toContain('全64枚');
  expect(next.selection).toContain('Next vault');
  expect(next.selection).not.toContain('Primary vault');
});

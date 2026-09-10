import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

function unique(prefix: string, project: string): string {
  return `${prefix}-${project}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('new-card')).toBeVisible();
}

async function openFromHistory(page: Page, title: string) {
  await page.getByRole('button', { name: '過去のカード' }).click();
  await page.getByTestId('history-list').getByText(title, { exact: true }).click();
  await expect(page.getByTestId('card-title')).toHaveValue(title);
}

test('offline creation, automatic save, reload, reconnect and another device sync', async ({
  page,
  context,
  browser,
}, testInfo) => {
  const title = unique('オフラインカード', testInfo.project.name);
  await ready(page);
  await page.locator('html[data-offline-ready=true]').waitFor({ state: 'attached', timeout: 15_000 });

  await context.setOffline(true);
  await page.getByTestId('new-card').click();
  await expect(page.getByTestId('display-id')).toHaveAttribute('data-kind', 'provisional');
  await page.getByTestId('card-title').fill(title);
  await page.getByTestId('body-editor').fill('通信がなくても、この本文は端末に残る。');
  await expect(page.getByTestId('save-sync-status')).toContainText('端末に保存済み');

  await page.reload();
  await expect(page.getByTestId('card-title')).toHaveValue(title);
  await expect(page.getByTestId('body-editor')).toContainText('通信がなくても、この本文は端末に残る。');
  await expect(page.getByTestId('display-id')).toHaveAttribute('data-kind', 'provisional');

  await context.setOffline(false);
  await expect(page.getByTestId('display-id')).toHaveAttribute('data-kind', 'official', {
    timeout: 15_000,
  });
  const officialValue = await page.getByTestId('display-id').getAttribute('data-value');

  const otherDevice = await browser.newContext();
  const otherPage = await otherDevice.newPage();
  await ready(otherPage);
  await openFromHistory(otherPage, title);
  await expect(otherPage.getByTestId('display-id')).toHaveAttribute('data-kind', 'official');
  await expect(otherPage.getByTestId('display-id')).toHaveAttribute('data-value', officialValue!);
  await expect(otherPage.getByTestId('body-editor')).toContainText('通信がなくても、この本文は端末に残る。');
  await otherDevice.close();
});

test('duplicate provisional ids become unique official ids without renumbering late arrivals', async ({
  browser,
}, testInfo) => {
  const seedTitle = unique('採番基準', testInfo.project.name);
  const firstTitle = unique('先着カード', testInfo.project.name);
  const lateTitle = unique('後着カード', testInfo.project.name);
  const first = await browser.newContext();
  const late = await browser.newContext();
  const firstPage = await first.newPage();
  const latePage = await late.newPage();

  await ready(firstPage);
  await firstPage.getByTestId('new-card').click();
  await firstPage.getByTestId('card-title').fill(seedTitle);
  await expect(firstPage.getByTestId('display-id')).toHaveAttribute('data-kind', 'official', {
    timeout: 15_000,
  });

  await ready(latePage);
  await openFromHistory(latePage, seedTitle);
  await first.setOffline(true);
  await late.setOffline(true);

  await latePage.getByTestId('new-card').click();
  await latePage.getByTestId('card-title').fill(lateTitle);
  await firstPage.getByTestId('new-card').click();
  await firstPage.getByTestId('card-title').fill(firstTitle);
  const firstProvisional = await firstPage.getByTestId('display-id').getAttribute('data-value');
  const lateProvisional = await latePage.getByTestId('display-id').getAttribute('data-value');
  expect(firstProvisional).toBe(lateProvisional);

  await first.setOffline(false);
  await expect(firstPage.getByTestId('display-id')).toHaveAttribute('data-kind', 'official', {
    timeout: 15_000,
  });
  const firstOfficial = await firstPage.getByTestId('display-id').getAttribute('data-value');

  await late.setOffline(false);
  await expect(latePage.getByTestId('display-id')).toHaveAttribute('data-kind', 'official', {
    timeout: 15_000,
  });
  const lateOfficial = await latePage.getByTestId('display-id').getAttribute('data-value');
  expect(lateOfficial).not.toBe(firstOfficial);
  expect(Number(lateOfficial)).toBeGreaterThan(Number(firstOfficial));

  const verifier = await browser.newContext();
  const verifierPage = await verifier.newPage();
  await ready(verifierPage);
  await openFromHistory(verifierPage, firstTitle);
  await expect(verifierPage.getByTestId('display-id')).toHaveAttribute('data-value', firstOfficial!);
  await openFromHistory(verifierPage, lateTitle);
  await expect(verifierPage.getByTestId('display-id')).toHaveAttribute('data-value', lateOfficial!);

  await verifier.close();
  await first.close();
  await late.close();
});

test('inline card links, Backspace, Undo/Redo, shortcuts and plain hashtag input', async ({
  page,
  context,
}, testInfo) => {
  const targetTitle = unique('リンク先', testInfo.project.name);
  const sourceTitle = unique('リンク元', testInfo.project.name);
  const unrelatedTitle = unique('無関係', testInfo.project.name);
  await ready(page);

  await page.getByTestId('new-card').click();
  await page.getByTestId('card-title').fill(targetTitle);
  await expect(page.getByTestId('display-id')).toHaveAttribute('data-kind', 'official', {
    timeout: 15_000,
  });
  await page.getByTestId('new-card').click();
  await page.getByTestId('card-title').fill(unrelatedTitle);
  await page.getByTestId('new-card').click();
  await page.getByTestId('card-title').fill(sourceTitle);

  const editor = page.getByTestId('body-editor');
  await editor.click();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(async () => navigator.clipboard.writeText('#'));
  await editor.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v');
  await expect(page.getByTestId('link-candidates')).toHaveCount(0);
  await editor.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');

  const softwareKeyboard = await context.newCDPSession(page);
  await softwareKeyboard.send('Input.insertText', { text: '#' });
  const targetOption = page.getByTestId('link-candidates').getByRole('button').filter({ hasText: targetTitle });
  await expect(targetOption).toBeVisible();
  await targetOption.click();
  await softwareKeyboard.detach();
  const capsule = editor.locator('[data-card-link-id]');
  await expect(capsule).toHaveCount(1);
  await expect(capsule).toContainText(targetTitle);

  await editor.press('Backspace');
  await expect(capsule).toHaveCount(0);
  await page.getByTestId('undo').click();
  await expect(capsule).toHaveCount(1);
  await page.getByTestId('redo').click();
  await expect(capsule).toHaveCount(0);
  await page.getByTestId('undo').click();
  await expect(capsule).toHaveCount(1);

  await editor.press('End');
  await editor.pressSequentially('X');
  await expect(editor).toContainText('X');
  await editor.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(editor).not.toContainText('X');
  await editor.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
  await expect(editor).toContainText('X');

  await editor.press('End');
  await editor.pressSequentially(' C# #123 ＃ https://example.test/#x [md](#1) 日本語');
  await page.evaluate(async () => navigator.clipboard.writeText(' 貼り付け #456 C# ＃'));
  await editor.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v');
  await expect(capsule).toHaveCount(1);

  await page.reload();
  await expect(page.getByTestId('card-title')).toHaveValue(sourceTitle);
  await expect(page.getByTestId('body-editor').locator('[data-card-link-id]')).toHaveCount(1);

  await page.getByRole('button', { name: 'つながり' }).click();
  const graph = page.getByTestId('connections-graph');
  await expect(graph.getByText(sourceTitle, { exact: true })).toBeVisible();
  await expect(graph.getByText(targetTitle, { exact: true })).toBeVisible();
  await expect(graph.getByText(unrelatedTitle, { exact: true })).toHaveCount(0);

  await graph.getByText(targetTitle, { exact: true }).click();
  await expect(page.getByTestId('card-title')).toHaveValue(targetTitle);

  await page.getByRole('button', { name: '過去のカード' }).click();
  const values = await page
    .getByTestId('history-list')
    .locator('[data-display-value]')
    .evaluateAll((items) => items.map((item) => Number(item.getAttribute('data-display-value'))));
  expect(values).toEqual([...values].sort((left, right) => left - right));
  const current = page.getByTestId('history-list').locator('[data-current=true]');
  await expect(current).toContainText(targetTitle);
  const isAtStartPosition = await current.evaluate((element) => {
    const item = element.getBoundingClientRect();
    const list = element.parentElement!.getBoundingClientRect();
    return item.top >= list.top && item.bottom <= list.bottom;
  });
  expect(isAtStartPosition).toBe(true);
});

test('concurrent device edits preserve both versions for explicit resolution', async ({
  browser,
}, testInfo) => {
  const baseline = unique('競合カード', testInfo.project.name);
  const localVersion = `${baseline}-端末A`;
  const otherVersion = `${baseline}-端末B`;
  const first = await browser.newContext();
  const second = await browser.newContext();
  const firstPage = await first.newPage();
  const secondPage = await second.newPage();
  await ready(firstPage);
  await firstPage.getByTestId('new-card').click();
  await firstPage.getByTestId('card-title').fill(baseline);
  await expect(firstPage.getByTestId('display-id')).toHaveAttribute('data-kind', 'official', {
    timeout: 15_000,
  });

  await ready(secondPage);
  await openFromHistory(secondPage, baseline);
  await second.setOffline(true);
  await firstPage.getByTestId('card-title').fill(localVersion);
  await expect(firstPage.getByTestId('save-sync-status')).toHaveText('保存済み', {
    timeout: 15_000,
  });
  const serverCheck = await browser.newContext();
  const serverCheckPage = await serverCheck.newPage();
  await ready(serverCheckPage);
  await openFromHistory(serverCheckPage, localVersion);
  await serverCheck.close();
  await secondPage.getByTestId('card-title').fill(otherVersion);
  await expect(secondPage.getByTestId('save-sync-status')).toContainText('端末に保存済み');
  await second.setOffline(false);

  const conflict = secondPage.getByRole('alert');
  await expect(conflict).toBeVisible({ timeout: 15_000 });
  await expect(conflict).toContainText(localVersion);
  await expect(conflict).toContainText(otherVersion);
  await conflict
    .getByRole('button', { name: `編集案「${otherVersion}」を使う` })
    .click();
  await expect(secondPage.getByTestId('card-title')).toHaveValue(otherVersion);
  await expect(conflict).toHaveCount(0, { timeout: 15_000 });

  await first.close();
  await second.close();
});

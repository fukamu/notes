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
  await page
    .getByTestId('history-list')
    .getByText(title, { exact: true })
    .click();
  await expect(page.getByTestId('card-title')).toHaveValue(title);
}

type LocalFixtureCard = {
  id: string;
  displayId: { kind: 'official'; value: number };
  title: string;
  body: { type: 'link'; targetCardId: string }[];
  createdAt: number;
  updatedAt: number;
  localRevision: number;
  serverRevision: number;
};

async function replaceLocalCards(page: Page, cards: LocalFixtureCard[]) {
  await page.evaluate(async (fixtureCards) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('fukamu-notes', 1);
      request.addEventListener('error', () => reject(request.error), {
        once: true,
      });
      request.addEventListener(
        'success',
        () => {
          const database = request.result;
          const transaction = database.transaction(
            ['cards', 'mutations', 'conflicts'],
            'readwrite',
          );
          transaction.objectStore('cards').clear();
          transaction.objectStore('mutations').clear();
          transaction.objectStore('conflicts').clear();
          for (const card of fixtureCards)
            transaction.objectStore('cards').put(card);
          transaction.addEventListener(
            'complete',
            () => {
              database.close();
              resolve();
            },
            { once: true },
          );
          transaction.addEventListener(
            'error',
            () => reject(transaction.error),
            {
              once: true,
            },
          );
          transaction.addEventListener(
            'abort',
            () => reject(transaction.error),
            {
              once: true,
            },
          );
        },
        { once: true },
      );
    });
  }, cards);
}

test('offline creation, automatic save, reload, reconnect and another device sync', async ({
  page,
  context,
  browser,
}, testInfo) => {
  const title = unique('オフラインカード', testInfo.project.name);
  await ready(page);
  await page
    .locator('html[data-offline-ready=true]')
    .waitFor({ state: 'attached', timeout: 15_000 });

  await context.setOffline(true);
  await page.getByTestId('new-card').click();
  await expect(page.getByTestId('display-id')).toHaveAttribute(
    'data-kind',
    'provisional',
  );
  await page.getByTestId('card-title').fill(title);
  await page
    .getByTestId('body-editor')
    .fill('通信がなくても、この本文は端末に残る。');
  await expect(page.getByTestId('save-sync-status')).toContainText(
    '端末に保存済み',
  );

  await page.reload();
  await expect(page.getByTestId('card-title')).toHaveValue(title);
  await expect(page.getByTestId('body-editor')).toContainText(
    '通信がなくても、この本文は端末に残る。',
  );
  await expect(page.getByTestId('display-id')).toHaveAttribute(
    'data-kind',
    'provisional',
  );

  await context.setOffline(false);
  await expect(page.getByTestId('display-id')).toHaveAttribute(
    'data-kind',
    'official',
    {
      timeout: 15_000,
    },
  );
  const officialValue = await page
    .getByTestId('display-id')
    .getAttribute('data-value');
  if (officialValue === null) throw new Error('official display ID is missing');

  const otherDevice = await browser.newContext();
  const otherPage = await otherDevice.newPage();
  await ready(otherPage);
  await openFromHistory(otherPage, title);
  await expect(otherPage.getByTestId('display-id')).toHaveAttribute(
    'data-kind',
    'official',
  );
  await expect(otherPage.getByTestId('display-id')).toHaveAttribute(
    'data-value',
    officialValue,
  );
  await expect(otherPage.getByTestId('body-editor')).toContainText(
    '通信がなくても、この本文は端末に残る。',
  );
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
  await expect(firstPage.getByTestId('display-id')).toHaveAttribute(
    'data-kind',
    'official',
    {
      timeout: 15_000,
    },
  );

  await ready(latePage);
  await openFromHistory(latePage, seedTitle);
  await first.setOffline(true);
  await late.setOffline(true);

  await latePage.getByTestId('new-card').click();
  await latePage.getByTestId('card-title').fill(lateTitle);
  await firstPage.getByTestId('new-card').click();
  await firstPage.getByTestId('card-title').fill(firstTitle);
  const firstProvisional = await firstPage
    .getByTestId('display-id')
    .getAttribute('data-value');
  const lateProvisional = await latePage
    .getByTestId('display-id')
    .getAttribute('data-value');
  expect(firstProvisional).toBe(lateProvisional);

  await first.setOffline(false);
  await expect(firstPage.getByTestId('display-id')).toHaveAttribute(
    'data-kind',
    'official',
    {
      timeout: 15_000,
    },
  );
  const firstOfficial = await firstPage
    .getByTestId('display-id')
    .getAttribute('data-value');
  if (firstOfficial === null)
    throw new Error('first official display ID is missing');

  await late.setOffline(false);
  await expect(latePage.getByTestId('display-id')).toHaveAttribute(
    'data-kind',
    'official',
    {
      timeout: 15_000,
    },
  );
  const lateOfficial = await latePage
    .getByTestId('display-id')
    .getAttribute('data-value');
  if (lateOfficial === null)
    throw new Error('late official display ID is missing');
  expect(lateOfficial).not.toBe(firstOfficial);
  expect(Number(lateOfficial)).toBeGreaterThan(Number(firstOfficial));

  const verifier = await browser.newContext();
  const verifierPage = await verifier.newPage();
  await ready(verifierPage);
  await openFromHistory(verifierPage, firstTitle);
  await expect(verifierPage.getByTestId('display-id')).toHaveAttribute(
    'data-value',
    firstOfficial,
  );
  await openFromHistory(verifierPage, lateTitle);
  await expect(verifierPage.getByTestId('display-id')).toHaveAttribute(
    'data-value',
    lateOfficial,
  );

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
  await expect(page.getByTestId('display-id')).toHaveAttribute(
    'data-kind',
    'official',
    {
      timeout: 15_000,
    },
  );
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
  const targetOption = page
    .getByTestId('link-candidates')
    .getByRole('button')
    .filter({ hasText: targetTitle });
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
  await editor.press(
    process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z',
  );
  await expect(editor).toContainText('X');

  await editor.press('End');
  await editor.pressSequentially(
    ' C# #123 ＃ https://example.test/#x [md](#1) 日本語',
  );
  await page.evaluate(async () =>
    navigator.clipboard.writeText(' 貼り付け #456 C# ＃'),
  );
  await editor.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v');
  await expect(capsule).toHaveCount(1);

  await page.reload();
  await expect(page.getByTestId('card-title')).toHaveValue(sourceTitle);
  await expect(
    page.getByTestId('body-editor').locator('[data-card-link-id]'),
  ).toHaveCount(1);

  await page.getByRole('button', { name: 'つながり' }).click();
  const graph = page.getByTestId('connections-graph');
  await expect(graph.getByText(sourceTitle, { exact: true })).toBeVisible();
  await expect(graph.getByText(targetTitle, { exact: true })).toBeVisible();
  await expect(graph.getByText(unrelatedTitle, { exact: true })).toBeVisible();

  await graph.getByText(targetTitle, { exact: true }).click();
  await expect(page.getByTestId('card-title')).toHaveValue(targetTitle);

  await page.getByRole('button', { name: '過去のカード' }).click();
  const values = await page
    .getByTestId('history-list')
    .locator('[data-display-value]')
    .evaluateAll((items) =>
      items.map((item) => Number(item.getAttribute('data-display-value'))),
    );
  expect(values).toEqual([...values].sort((left, right) => left - right));
  const current = page
    .getByTestId('history-list')
    .locator('[data-current=true]');
  await expect(current).toContainText(targetTitle);
  const isAtStartPosition = await current.evaluate((element) => {
    const item = element.getBoundingClientRect();
    const parent = element.parentElement;
    if (!parent) return false;
    const list = parent.getBoundingClientRect();
    return item.top >= list.top && item.bottom <= list.bottom;
  });
  expect(isAtStartPosition).toBe(true);
});

test('global directed graph is safe and operable for the reported and cyclic fixtures', async ({
  page,
  context,
}, testInfo) => {
  const suffix = unique('graph', testInfo.project.name);
  const ids = {
    reportA: '01991f20-61d2-7000-8000-000000000101',
    reportB: '01991f20-61d2-7000-8000-000000000102',
    reportC: '01991f20-61d2-7000-8000-000000000103',
    cycleA: '01991f20-61d2-7000-8000-000000000104',
    cycleB: '01991f20-61d2-7000-8000-000000000105',
    cycleC: '01991f20-61d2-7000-8000-000000000106',
    isolated: '01991f20-61d2-7000-8000-000000000107',
  };
  const titles = {
    reportA: `報告例 A ${suffix}`,
    reportB: `報告例 B ${suffix}`,
    reportC: `報告例 C ${suffix}`,
    cycleA: `循環 A ${suffix}`,
    cycleB: `循環 B ${suffix}`,
    cycleC: `循環 C ${suffix}`,
    isolated: `孤立 ${suffix}`,
  };
  const now = Date.now();
  const fixture = (
    id: string,
    value: number,
    title: string,
    targets: string[],
  ): LocalFixtureCard => ({
    id,
    displayId: { kind: 'official', value },
    title,
    body: targets.map((targetCardId) => ({ type: 'link', targetCardId })),
    createdAt: now + value,
    updatedAt: now + value,
    localRevision: 1,
    serverRevision: 1,
  });

  await ready(page);
  await page.locator('html[data-offline-ready=true]').waitFor({
    state: 'attached',
    timeout: 15_000,
  });
  await context.setOffline(true);
  await replaceLocalCards(page, [
    fixture(ids.reportA, 1, titles.reportA, [ids.reportB]),
    fixture(ids.reportB, 2, titles.reportB, []),
    fixture(ids.reportC, 3, titles.reportC, [ids.reportA, ids.reportB]),
    fixture(ids.cycleA, 4, titles.cycleA, [ids.cycleA, ids.cycleB]),
    fixture(ids.cycleB, 5, titles.cycleB, [ids.cycleA, ids.cycleC]),
    fixture(ids.cycleC, 6, titles.cycleC, [ids.cycleA]),
    fixture(ids.isolated, 7, titles.isolated, []),
  ]);
  await page.reload();
  await expect(page.getByTestId('new-card')).toBeVisible();

  await openFromHistory(page, titles.reportA);
  await page.getByRole('button', { name: 'つながり' }).click();
  const graph = page.getByTestId('connections-graph');
  await expect(graph).toHaveAttribute('data-layout-status', 'ready', {
    timeout: 15_000,
  });
  await expect(graph.getByTestId('connection-node')).toHaveCount(7);
  for (const id of Object.values(ids)) {
    await expect(graph.locator(`[data-card-id="${id}"]`)).toBeVisible();
  }

  const edge = (source: string, target: string) =>
    graph.locator(
      `[data-testid="connection-edge"][data-source="${source}"][data-target="${target}"]`,
    );
  const reportedEdges = [
    edge(ids.reportC, ids.reportA),
    edge(ids.reportC, ids.reportB),
    edge(ids.reportA, ids.reportB),
  ];
  for (const reportedEdge of reportedEdges) {
    await expect(reportedEdge).toHaveCount(1);
    await expect(
      reportedEdge.getByTestId('connection-edge-section').last(),
    ).toHaveAttribute('marker-end', /connection-edge-arrow/);
  }

  const currentNode = graph.locator(`[data-card-id="${ids.reportA}"]`);
  await expect(currentNode).toHaveAttribute('aria-current', 'true');
  const currentIsInitiallyVisible = await currentNode.evaluate((element) => {
    const node = element.getBoundingClientRect();
    const viewportElement = element.closest(
      '[data-testid="connections-graph"]',
    );
    if (!viewportElement) return false;
    const viewport = viewportElement.getBoundingClientRect();
    return (
      node.left >= viewport.left &&
      node.right <= viewport.right &&
      node.top >= viewport.top &&
      node.bottom <= viewport.bottom
    );
  });
  expect(currentIsInitiallyVisible).toBe(true);

  const selfEdge = edge(ids.cycleA, ids.cycleA);
  const forwardEdge = edge(ids.cycleA, ids.cycleB);
  const backwardEdge = edge(ids.cycleB, ids.cycleA);
  for (const routedEdge of [selfEdge, forwardEdge, backwardEdge]) {
    await expect(routedEdge).toHaveCount(1);
    const routeLength = await routedEdge
      .getByTestId('connection-edge-section')
      .evaluateAll((paths) =>
        paths.reduce(
          (total, path) =>
            total +
            (path instanceof SVGPathElement ? path.getTotalLength() : 0),
          0,
        ),
      );
    expect(routeLength).toBeGreaterThan(0);
  }
  const selfSourcePort = await selfEdge.getAttribute('data-source-port');
  const selfTargetPort = await selfEdge.getAttribute('data-target-port');
  expect(selfSourcePort).not.toBeNull();
  expect(selfTargetPort).not.toBeNull();
  expect(selfSourcePort).not.toBe(selfTargetPort);
  const routeSignature = async (routedEdge: ReturnType<typeof edge>) =>
    routedEdge
      .getByTestId('connection-edge-section')
      .evaluateAll((paths) => paths.map((path) => path.getAttribute('d')));
  expect(await routeSignature(forwardEdge)).not.toEqual(
    await routeSignature(backwardEdge),
  );

  const touchAction = await graph.evaluate(
    (element) => getComputedStyle(element).touchAction,
  );
  expect(touchAction).toContain('pan-x');
  expect(touchAction).toContain('pan-y');
  const targetNode = graph.locator(`[data-card-id="${ids.reportB}"]`);
  await targetNode.scrollIntoViewIfNeeded();
  if (testInfo.project.name === 'mobile-chromium') {
    await targetNode.tap();
  } else {
    await targetNode.focus();
    await targetNode.press('Enter');
  }
  await expect(page.getByTestId('card-title')).toHaveValue(titles.reportB);
});

test('malformed 2xx sync response preserves local edits and remains retryable', async ({
  page,
}, testInfo) => {
  const title = unique('不正応答保持', testInfo.project.name);
  await page.route('**/api/sync', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cards: null,
        conflicts: [],
        acknowledgedMutationIds: [],
      }),
    });
  });
  await ready(page);
  await page.getByTestId('new-card').click();
  await page.getByTestId('card-title').fill(title);
  await expect(page.getByTestId('save-sync-status')).toContainText(
    '同期失敗・端末に保存済み',
    { timeout: 15_000 },
  );

  await page.reload();
  await expect(page.getByTestId('card-title')).toHaveValue(title);
  await page.unroute('**/api/sync');
  await page.getByTestId('save-sync-status').click();
  await expect(page.getByTestId('display-id')).toHaveAttribute(
    'data-kind',
    'official',
    { timeout: 15_000 },
  );
  await expect(page.getByTestId('card-title')).toHaveValue(title);
});

test('semantic navigation preserves availability, current context and accessible state', async ({
  page,
  context,
}, testInfo) => {
  const title = unique('画面契約', testInfo.project.name);
  await ready(page);
  await page.locator('html[data-offline-ready=true]').waitFor({
    state: 'attached',
    timeout: 15_000,
  });
  await context.setOffline(true);
  await replaceLocalCards(page, []);
  await page.reload();

  const cardNavigation = page.getByRole('button', {
    name: 'カード',
    exact: true,
  });
  const historyNavigation = page.getByRole('button', {
    name: '過去のカード',
    exact: true,
  });
  const connectionsNavigation = page.getByRole('button', {
    name: 'つながり',
    exact: true,
  });
  await expect(cardNavigation).toBeDisabled();
  await expect(connectionsNavigation).toBeDisabled();
  await expect(historyNavigation).toBeEnabled();

  await historyNavigation.click();
  await expect(historyNavigation).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('heading', { name: '過去のカード' }),
  ).toBeVisible();

  await page.getByTestId('new-card').click();
  await expect(cardNavigation).toHaveAttribute('aria-current', 'page');
  await page.getByTestId('card-title').fill(title);

  await historyNavigation.click();
  const currentHistoryItem = page
    .getByTestId('history-list')
    .getByRole('button', { name: new RegExp(title) });
  await expect(currentHistoryItem).toHaveAttribute('aria-current', 'page');
  if (testInfo.project.name === 'mobile-chromium') {
    await currentHistoryItem.tap();
  } else {
    await currentHistoryItem.focus();
    await currentHistoryItem.press('Enter');
  }
  await expect(cardNavigation).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('card-title')).toHaveValue(title);

  await connectionsNavigation.click();
  await expect(connectionsNavigation).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('connections-graph')).toHaveAttribute(
    'data-layout-status',
    'ready',
    { timeout: 15_000 },
  );
  await expect(
    page.getByTestId('connections-graph').getByRole('button', {
      name: new RegExp(`${title}、現在のカード`),
    }),
  ).toHaveAttribute('aria-current', 'true');
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
  await expect(firstPage.getByTestId('display-id')).toHaveAttribute(
    'data-kind',
    'official',
    {
      timeout: 15_000,
    },
  );

  await ready(secondPage);
  await openFromHistory(secondPage, baseline);
  await second.setOffline(true);
  await firstPage.getByTestId('card-title').fill(localVersion);
  await expect(firstPage.getByTestId('save-sync-status')).toHaveText(
    '保存済み',
    {
      timeout: 15_000,
    },
  );
  const serverCheck = await browser.newContext();
  const serverCheckPage = await serverCheck.newPage();
  await ready(serverCheckPage);
  await openFromHistory(serverCheckPage, localVersion);
  await serverCheck.close();
  await secondPage.getByTestId('card-title').fill(otherVersion);
  await expect(secondPage.getByTestId('save-sync-status')).toContainText(
    '端末に保存済み',
  );
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

import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

function unique(prefix: string, project: string): string {
  return `${prefix}-${project}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('new-card')).toBeVisible();
}

async function expectPathname(page: Page, pathname: string) {
  await expect(page).toHaveURL(new URL(pathname, 'http://localhost:3100').href);
}

async function serveSyncCards(page: Page, cards: LocalFixtureCard[]) {
  await page.route('**/api/sync', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cards: cards.map((card) => ({
          id: card.id,
          officialDisplayId: card.displayId.value,
          title: card.title,
          body: card.body,
          createdAt: card.createdAt,
          updatedAt: card.updatedAt,
          revision: card.serverRevision ?? 1,
        })),
        conflicts: [],
        acknowledgedMutationIds: [],
      }),
    });
  });
}

async function forceConnectionsLayoutFailure(page: Page) {
  await page.route('**/_next/static/chunks/notes-app-*.js', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const layoutInvocation =
      /let ([\w$]+)=([\w$]+)\(([\w$]+)\),([\w$]+)=await ([\w$]+)\(\)\.layout\(([\w$]+)\(\3,\1,([\w$]+)\)\)/;
    const transformed = source.replace(
      layoutInvocation,
      'throw Error("forced connections layout failure");let $1=[],$4={}',
    );
    if (transformed === source) {
      throw new Error('Unable to install the connections layout fault');
    }
    await route.fulfill({ response, body: transformed });
  });
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
  const provisionalPathname = new URL(page.url()).pathname;
  expect(provisionalPathname).toMatch(
    /^\/cards\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
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
  expect(new URL(page.url()).pathname).toBe(provisionalPathname);
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

test('headless editor preserves IME, candidate keyboard, link activation and identity reset', async ({
  page,
  context,
}, testInfo) => {
  const firstTarget = unique('候補A', testInfo.project.name);
  const secondTarget = unique('候補B', testInfo.project.name);
  const source = unique('controller本文', testInfo.project.name);
  await ready(page);
  await page.locator('html[data-offline-ready=true]').waitFor({
    state: 'attached',
    timeout: 15_000,
  });
  await context.setOffline(true);
  await replaceLocalCards(page, []);
  await page.reload();
  await expect(page.getByTestId('new-card')).toBeVisible();

  await page.getByTestId('new-card').click();
  await page.getByTestId('card-title').fill(firstTarget);
  await page.getByTestId('new-card').click();
  await page.getByTestId('card-title').fill(secondTarget);
  await page.getByTestId('new-card').click();
  await page.getByTestId('card-title').fill(source);

  const editor = page.getByTestId('body-editor');
  await editor.click();
  const ime = await context.newCDPSession(page);
  await ime.send('Input.imeSetComposition', {
    text: '#',
    selectionStart: 1,
    selectionEnd: 1,
  });
  await expect(page.getByTestId('link-candidates')).toHaveCount(0);
  await ime.send('Input.insertText', { text: '#' });
  await ime.detach();

  const candidateList = page.getByTestId('link-candidates');
  await expect(candidateList).toBeVisible();
  const candidateButtons = candidateList.getByRole('button');
  await expect(candidateButtons).toHaveCount(2);
  await expect(candidateButtons.first()).toHaveAttribute(
    'aria-current',
    'true',
  );
  await editor.press('ArrowDown');
  await expect(candidateButtons.nth(1)).toHaveAttribute('aria-current', 'true');
  await editor.press('ArrowUp');
  await expect(candidateButtons.first()).toHaveAttribute(
    'aria-current',
    'true',
  );
  const chosenTitle = (await candidateButtons.first().innerText()).includes(
    firstTarget,
  )
    ? firstTarget
    : secondTarget;
  await editor.press('Enter');
  const capsule = editor.getByRole('link');
  await expect(capsule).toHaveCount(1);

  if (testInfo.project.name === 'mobile-chromium') {
    await capsule.tap();
  } else {
    await capsule.click();
  }
  await expect(page.getByTestId('card-title')).toHaveValue(chosenTitle);
  await openFromHistory(page, source);
  await expect(page.getByTestId('undo')).toBeDisabled();

  const restoredEditor = page.getByTestId('body-editor');
  const restoredCapsule = restoredEditor.getByRole('link');
  await restoredCapsule.focus();
  await restoredCapsule.press('Enter');
  await expect(page.getByTestId('card-title')).toHaveValue(chosenTitle);
  await openFromHistory(page, source);

  const keyboardEditor = page.getByTestId('body-editor');
  const keyboardCapsule = keyboardEditor.getByRole('link');
  await keyboardCapsule.focus();
  await keyboardCapsule.press('Space');
  await expect(page.getByTestId('card-title')).toHaveValue(chosenTitle);
  await openFromHistory(page, source);

  const sourceEditor = page.getByTestId('body-editor');
  await sourceEditor.focus();
  await sourceEditor.press('Home');
  await sourceEditor.press('Delete');
  await expect(sourceEditor.getByRole('link')).toHaveCount(0);
  await page.getByTestId('undo').click();
  await expect(sourceEditor.getByRole('link')).toHaveCount(1);

  await sourceEditor.press('End');
  await sourceEditor.pressSequentially('追記');
  await expect(page.getByTestId('undo')).toBeEnabled();
  await sourceEditor.getByRole('link').focus();
  await sourceEditor.getByRole('link').press('Enter');
  await openFromHistory(page, source);
  await expect(page.getByTestId('undo')).toBeDisabled();

  const resetEditor = page.getByTestId('body-editor');
  await resetEditor.press('End');
  const keyboard = await context.newCDPSession(page);
  await keyboard.send('Input.insertText', { text: ' #' });
  await expect(page.getByTestId('link-candidates')).toBeVisible();
  await resetEditor.press('Escape');
  await expect(page.getByTestId('link-candidates')).toHaveCount(0);
  await keyboard.detach();
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
  await expect(graph.getByRole('button')).toHaveCount(7);
  for (const title of Object.values(titles)) {
    await expect(
      graph.getByRole('button').filter({ hasText: title }),
    ).toBeVisible();
  }

  const semanticEdges = graph.getByRole('list', {
    name: 'カード間の一方向リンク一覧',
  });
  await expect(semanticEdges.getByRole('listitem')).toHaveCount(8);
  const expectedEdges = [
    `${titles.reportC} から ${titles.reportA} へのリンク`,
    `${titles.reportC} から ${titles.reportB} へのリンク`,
    `${titles.reportA} から ${titles.reportB} へのリンク`,
    `${titles.cycleA} から ${titles.cycleA} へのリンク`,
    `${titles.cycleA} から ${titles.cycleB} へのリンク`,
    `${titles.cycleB} から ${titles.cycleA} へのリンク`,
    `${titles.cycleB} から ${titles.cycleC} へのリンク`,
    `${titles.cycleC} から ${titles.cycleA} へのリンク`,
  ];
  for (const label of expectedEdges) {
    await expect(
      semanticEdges.getByRole('listitem').filter({ hasText: label }),
    ).toHaveCount(1);
  }

  const currentNode = graph
    .getByRole('button')
    .filter({ hasText: titles.reportA });
  await expect(currentNode).toHaveAttribute('aria-current', 'true');
  const nodeBox = await currentNode.boundingBox();
  const viewportBox = await graph.boundingBox();
  expect(nodeBox).not.toBeNull();
  expect(viewportBox).not.toBeNull();
  if (!nodeBox || !viewportBox) throw new Error('graph geometry is missing');
  expect(nodeBox.x).toBeGreaterThanOrEqual(viewportBox.x);
  expect(nodeBox.y).toBeGreaterThanOrEqual(viewportBox.y);
  expect(nodeBox.x + nodeBox.width).toBeLessThanOrEqual(
    viewportBox.x + viewportBox.width,
  );
  expect(nodeBox.y + nodeBox.height).toBeLessThanOrEqual(
    viewportBox.y + viewportBox.height,
  );

  const touchAction = await graph.evaluate(
    (element) => getComputedStyle(element).touchAction,
  );
  expect(touchAction).toContain('pan-x');
  expect(touchAction).toContain('pan-y');
  const targetNode = graph
    .getByRole('button')
    .filter({ hasText: titles.reportB });
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

test('layout failure fallback opens a card through URL navigation', async ({
  page,
}, testInfo) => {
  const cardA = '01991f20-61d2-7000-8000-000000000611';
  const cardB = '01991f20-61d2-7000-8000-000000000612';
  const suffix = unique('fallback-url', testInfo.project.name);
  const cardATitle = `配置失敗A ${suffix}`;
  const cardBTitle = `配置失敗B ${suffix}`;
  await forceConnectionsLayoutFailure(page);
  await serveSyncCards(page, [
    {
      id: cardA,
      displayId: { kind: 'official', value: 11 },
      title: cardATitle,
      body: [{ type: 'link', targetCardId: cardB }],
      createdAt: 11,
      updatedAt: 11,
      localRevision: 1,
      serverRevision: 1,
    },
    {
      id: cardB,
      displayId: { kind: 'official', value: 12 },
      title: cardBTitle,
      body: [],
      createdAt: 12,
      updatedAt: 12,
      localRevision: 1,
      serverRevision: 1,
    },
  ]);

  const response = await page.goto(`/cards/${cardA}/connections`);
  expect(response?.status()).toBe(200);
  await expectPathname(page, `/cards/${cardA}/connections`);
  const graph = page.getByTestId('connections-graph');
  await expect(graph).toHaveAttribute('data-layout-status', 'error', {
    timeout: 15_000,
  });
  await expect(graph.getByRole('alert')).toContainText(
    '配置を計算できませんでした',
  );
  const fallbackCard = graph.getByRole('button', {
    name: new RegExp(cardBTitle),
  });
  if (testInfo.project.name === 'mobile-chromium') {
    await fallbackCard.tap();
  } else {
    await fallbackCard.focus();
    await fallbackCard.press('Enter');
  }
  await expectPathname(page, `/cards/${cardB}`);
  await expect(page.getByTestId('card-title')).toHaveValue(cardBTitle);
});

test('canonical URLs restore cards and views through direct, back, forward and offline navigation', async ({
  page,
  context,
}, testInfo) => {
  const ids = {
    cardA: '01991f20-61d2-7000-8000-000000000601',
    cardB: '01991f20-61d2-7000-8000-000000000602',
    cardC: '01991f20-61d2-7000-8000-000000000603',
    missing: '01991f20-61d2-7000-8000-000000000604',
  };
  const suffix = unique('url', testInfo.project.name);
  const titles = {
    cardA: `URLカードA ${suffix}`,
    cardB: `URLカードB ${suffix}`,
    cardC: `URLカードC ${suffix}`,
  };
  const cards: LocalFixtureCard[] = [
    {
      id: ids.cardA,
      displayId: { kind: 'official', value: 1 },
      title: titles.cardA,
      body: [{ type: 'link', targetCardId: ids.cardB }],
      createdAt: 1,
      updatedAt: 1,
      localRevision: 1,
      serverRevision: 1,
    },
    {
      id: ids.cardB,
      displayId: { kind: 'official', value: 2 },
      title: titles.cardB,
      body: [{ type: 'link', targetCardId: ids.cardC }],
      createdAt: 2,
      updatedAt: 2,
      localRevision: 1,
      serverRevision: 1,
    },
    {
      id: ids.cardC,
      displayId: { kind: 'official', value: 3 },
      title: titles.cardC,
      body: [],
      createdAt: 3,
      updatedAt: 3,
      localRevision: 1,
      serverRevision: 1,
    },
  ];
  await serveSyncCards(page, cards);

  const response = await page.goto(`/cards/${ids.cardA}`);
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId('card-title')).toHaveValue(titles.cardA, {
    timeout: 15_000,
  });
  await expectPathname(page, `/cards/${ids.cardA}`);
  await page.reload();
  await expect(page.getByTestId('card-title')).toHaveValue(titles.cardA);
  await expectPathname(page, `/cards/${ids.cardA}`);
  await page.locator('html[data-offline-ready=true]').waitFor({
    state: 'attached',
    timeout: 15_000,
  });

  await page.getByRole('button', { name: '過去のカード', exact: true }).click();
  await expectPathname(page, `/cards/${ids.cardA}/history`);
  await expect(
    page.getByTestId('history-list').locator(`[data-card-id="${ids.cardA}"]`),
  ).toHaveAttribute('aria-current', 'page');
  await page
    .getByTestId('history-list')
    .locator(`[data-card-id="${ids.cardB}"]`)
    .click();
  await expectPathname(page, `/cards/${ids.cardB}`);
  await expect(page.getByTestId('card-title')).toHaveValue(titles.cardB);

  await page.getByRole('button', { name: 'つながり', exact: true }).click();
  await expectPathname(page, `/cards/${ids.cardB}/connections`);
  const graph = page.getByTestId('connections-graph');
  await expect(graph).toHaveAttribute('data-layout-status', 'ready', {
    timeout: 15_000,
  });
  await expect(
    graph.getByRole('button', {
      name: new RegExp(`${titles.cardB}、現在のカード`),
    }),
  ).toHaveAttribute('aria-current', 'true');
  const cardCNode = graph.getByRole('button').filter({ hasText: titles.cardC });
  if (testInfo.project.name === 'mobile-chromium') {
    await cardCNode.tap();
  } else {
    await cardCNode.focus();
    await cardCNode.press('Enter');
  }
  await expectPathname(page, `/cards/${ids.cardC}`);
  await expect(page.getByTestId('card-title')).toHaveValue(titles.cardC);

  const historyLength = await page.evaluate(() => window.history.length);
  await page.goBack();
  await expectPathname(page, `/cards/${ids.cardB}/connections`);
  await expect(page.getByRole('heading', { name: 'つながり' })).toBeVisible();
  await expect(
    page.getByTestId('connections-graph').getByRole('button', {
      name: new RegExp(`${titles.cardB}、現在のカード`),
    }),
  ).toHaveAttribute('aria-current', 'true');
  await page.goBack();
  await expectPathname(page, `/cards/${ids.cardB}`);
  await expect(page.getByTestId('card-title')).toHaveValue(titles.cardB);
  await page.goBack();
  await expectPathname(page, `/cards/${ids.cardA}/history`);
  await expect(
    page.getByTestId('history-list').locator(`[data-card-id="${ids.cardA}"]`),
  ).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expectPathname(page, `/cards/${ids.cardA}`);
  await expect(page.getByTestId('card-title')).toHaveValue(titles.cardA);

  await page.goForward();
  await expectPathname(page, `/cards/${ids.cardA}/history`);
  await page.goForward();
  await expectPathname(page, `/cards/${ids.cardB}`);
  await page.goForward();
  await expectPathname(page, `/cards/${ids.cardB}/connections`);
  await page.goForward();
  await expectPathname(page, `/cards/${ids.cardC}`);
  await expect(page.getByTestId('card-title')).toHaveValue(titles.cardC);
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);

  await page.getByRole('button', { name: 'カード', exact: true }).click();
  await expectPathname(page, `/cards/${ids.cardC}`);
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);

  const editedTitle = `${titles.cardC} 編集済み`;
  await page.getByTestId('card-title').fill(editedTitle);
  await page.getByTestId('body-editor').fill('URL履歴を増やさない編集');
  await expect(page.getByTestId('save-sync-status')).toHaveText('保存済み');
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
  await expectPathname(page, `/cards/${ids.cardC}`);

  await page.getByTestId('new-card').click();
  const newCardPathname = new URL(page.url()).pathname;
  expect(newCardPathname).toMatch(/^\/cards\/[0-9a-f-]{36}$/);
  await page.goBack();
  await expectPathname(page, `/cards/${ids.cardC}`);
  await expect(page.getByTestId('card-title')).toHaveValue(editedTitle);
  await page.goForward();
  await expectPathname(page, newCardPathname);
  await page.goBack();

  await page.getByRole('button', { name: '過去のカード', exact: true }).click();
  await page
    .getByTestId('history-list')
    .locator(`[data-card-id="${ids.cardA}"]`)
    .click();
  const inlineLink = page.getByTestId('body-editor').getByRole('link');
  if (testInfo.project.name === 'mobile-chromium') {
    await inlineLink.tap();
  } else {
    await inlineLink.focus();
    await inlineLink.press('Enter');
  }
  await expectPathname(page, `/cards/${ids.cardB}`);

  await context.setOffline(true);
  await page.goto(`/cards/${ids.cardB}/connections`);
  await expectPathname(page, `/cards/${ids.cardB}/connections`);
  await expect(page.getByRole('heading', { name: 'つながり' })).toBeVisible();
  await page.reload();
  await expectPathname(page, `/cards/${ids.cardB}/connections`);
  await expect(
    page.getByTestId('connections-graph').getByRole('button', {
      name: new RegExp(`${titles.cardB}、現在のカード`),
    }),
  ).toHaveAttribute('aria-current', 'true', { timeout: 15_000 });

  await page.goto(`/cards/${ids.missing}`);
  await expectPathname(page, newCardPathname);
  await expect(page.getByTestId('card-title')).toHaveValue('');
});

test('the first card replaces the empty root history entry', async ({
  page,
}) => {
  await serveSyncCards(page, []);
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole('heading', { name: '最初の一枚から始めましょう' }),
  ).toBeVisible();
  const historyLength = await page.evaluate(() => window.history.length);
  await page.getByTestId('new-card').click();
  expect(new URL(page.url()).pathname).toMatch(/^\/cards\/[0-9a-f-]{36}$/);
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
});

test('invalid and unresolved card URLs normalize without a history loop', async ({
  page,
}) => {
  const unknown = await page.goto('/not-an-app-route');
  expect(unknown?.status()).toBe(404);

  await serveSyncCards(page, []);
  const invalid = await page.goto('/cards/not-a-uuid');
  expect(invalid?.status()).toBe(200);
  await expectPathname(page, '/');
  await expect(
    page.getByRole('heading', { name: '最初の一枚から始めましょう' }),
  ).toBeVisible();

  await page.unroute('**/api/sync');
  const syncGate = Promise.withResolvers<void>();
  await page.route('**/api/sync', async (route) => {
    await syncGate.promise;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cards: [],
        conflicts: [],
        acknowledgedMutationIds: [],
      }),
    });
  });
  const missingId = '01991f20-61d2-7000-8000-000000000699';
  const missing = await page.goto(`/cards/${missingId}`);
  expect(missing?.status()).toBe(200);
  await expectPathname(page, `/cards/${missingId}`);
  await expect(page.getByText('カードを開いています')).toBeVisible();
  syncGate.resolve();
  await expectPathname(page, '/');
  await expect(
    page.getByRole('heading', { name: '最初の一枚から始めましょう' }),
  ).toBeVisible();
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

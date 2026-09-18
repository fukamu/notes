import { expect, test, type Locator, type Page } from '@playwright/test';
import { CONNECTIONS_ZOOM_PREFERENCE_KEY } from '@/lib/client/connections-zoom-preference';
import { selectConnectionsViewModel } from '@/lib/application/view-models';
import type { CardRecord } from '@/lib/domain/types';
import { decodeSyncRequest } from '@/lib/sync/protocol';
import { connectionsBenchmarkFixtures } from '@/tests/fixtures/connections-layout';
import { createClientPerformanceFixture } from '@/tests/fixtures/client-performance';
import { fixtureCardId, fixtureConflictId } from '@/tests/fixtures/ids';

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

async function expectVisibleButtonsToBeNonSelectable(page: Page) {
  const userSelectValues = await page
    .locator('button:visible')
    .evaluateAll((buttons) =>
      buttons.map((button) => getComputedStyle(button).userSelect),
    );
  expect(userSelectValues.length).toBeGreaterThan(0);
  expect(new Set(userSelectValues)).toEqual(new Set(['none']));
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

async function serveInitialPerformanceCards(
  page: Page,
  cards: readonly CardRecord[],
) {
  const cardIds = new Set(cards.map((card) => card.id));
  const fallbackTargetId = cards[0]?.id;
  const servedCards = cards.map((card) => ({
    ...card,
    body: card.body.map((segment) =>
      segment.type === 'link' &&
      !cardIds.has(segment.targetCardId) &&
      fallbackTargetId
        ? { ...segment, targetCardId: fallbackTargetId }
        : segment,
    ),
  }));
  const responseBody = JSON.stringify({
    cards: servedCards.map((card) => ({
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
  });
  const emptyResponseBody = JSON.stringify({
    cards: [],
    conflicts: [],
    acknowledgedMutationIds: [],
  });
  let initialResponsePending = true;
  await page.route('**/api/sync', async (route) => {
    const body = initialResponsePending ? responseBody : emptyResponseBody;
    initialResponsePending = false;
    await route.fulfill({ status: 200, contentType: 'application/json', body });
  });
  return servedCards;
}

async function browserHeapUsed(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const memory: unknown = Reflect.get(performance, 'memory');
    if (typeof memory !== 'object' || memory === null) return null;
    const heap: unknown = Reflect.get(memory, 'usedJSHeapSize');
    return typeof heap === 'number' && Number.isFinite(heap) ? heap : null;
  });
}

async function forceConnectionsLayoutFault(page: Page, failCorridor: boolean) {
  await page.route('**/_next/static/chunks/notes-app-*.js', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const layoutInvocation =
      /let ([\w$]+)=([\w$]+)\(([\w$]+)\),([\w$]+)=await ([\w$]+)\.layout\(([\w$]+)\(\3,\1,([\w$]+),([\w$]+)\)\)/;
    let transformed = source.replace(
      layoutInvocation,
      'throw Error("forced connections layout failure");let $1=[],$4={}',
    );
    if (transformed === source) {
      throw new Error('Unable to install the connections layout fault');
    }
    if (failCorridor) {
      const corridorWorkerConstruction =
        /new Worker\(([\w$]+),\{type:[`'"]module[`'"]\}\)/;
      const withCorridorFault = transformed.replace(
        corridorWorkerConstruction,
        '(()=>{throw Error("forced corridor layout failure")})()',
      );
      if (withCorridorFault === transformed) {
        throw new Error('Unable to install the corridor layout fault');
      }
      transformed = withCorridorFault;
    }
    await route.fulfill({ response, body: transformed });
  });
}

async function forceConnectionsElkLayoutFailure(page: Page) {
  await forceConnectionsLayoutFault(page, false);
}

async function forceConnectionsLayoutFailure(page: Page) {
  await forceConnectionsLayoutFault(page, true);
}

async function openFromHistory(page: Page, title: string) {
  await page.getByRole('button', { name: '過去のカード' }).click();
  const historyList = page.getByTestId('history-list');
  await expect(historyList).toHaveAttribute('data-history-total-count', /\d+/);
  const target = historyList.getByText(title, { exact: true });
  const scanCurrentHistory = async (): Promise<boolean> => {
    await historyList.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect
      .poll(() =>
        historyList
          .getAttribute('data-history-window-start')
          .then((value) => Number(value)),
      )
      .toBe(0);

    for (;;) {
      if ((await target.count()) > 0) return true;
      const state = await historyList.evaluate((element) => ({
        end: Number(element.dataset.historyWindowEnd),
        total: Number(element.dataset.historyTotalCount),
        rowHeight: Number(element.dataset.historyRowHeight),
        rowGap: Number(element.dataset.historyRowGap),
      }));
      if (state.end >= state.total) return false;
      const previousStart = Number(
        await historyList.getAttribute('data-history-window-start'),
      );
      await historyList.evaluate(
        (element, nextScrollTop) => {
          element.scrollTop = nextScrollTop;
        },
        state.end * (state.rowHeight + state.rowGap),
      );
      await expect
        .poll(() =>
          historyList
            .getAttribute('data-history-window-start')
            .then((value) => Number(value)),
        )
        .toBeGreaterThan(previousStart);
    }
  };
  await expect.poll(scanCurrentHistory, { timeout: 30_000 }).toBe(true);
  await target.click();
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

function largeConnectionsBenchmarkCards(): LocalFixtureCard[] {
  const fixture = connectionsBenchmarkFixtures.find(
    ({ name }) => name === 'synthetic large seed 0x41decade',
  );
  if (!fixture) throw new Error('Missing large connections benchmark fixture');
  const outgoing = new Map(fixture.nodes.map((node) => [node, [] as string[]]));
  for (const [source, target] of fixture.edges) {
    const targets = outgoing.get(source);
    if (!targets) throw new Error(`Missing benchmark source ${source}`);
    targets.push(target);
  }
  return fixture.nodes.map((node, index) => ({
    id: fixtureCardId(`${fixture.name}-${node}`),
    displayId: { kind: 'official', value: index + 1 },
    title: `性能fixture ${node}`,
    body: (outgoing.get(node) ?? []).map((target) => ({
      type: 'link',
      targetCardId: fixtureCardId(`${fixture.name}-${target}`),
    })),
    createdAt: index + 1,
    updatedAt: index + 1,
    localRevision: 1,
    serverRevision: 1,
  }));
}

type ConnectionsCameraSnapshot = {
  x: number;
  y: number;
  scale: number;
  renderCount: number;
};

async function connectionsCamera(
  graph: Locator,
): Promise<ConnectionsCameraSnapshot> {
  return graph.evaluate((element) => ({
    x: Number(element.dataset.cameraX),
    y: Number(element.dataset.cameraY),
    scale: Number(element.dataset.cameraScale),
    renderCount: Number(element.dataset.cameraRenderCount),
  }));
}

async function pressConnectionsKey(graph: Locator, key: string, count = 1) {
  await graph.focus();
  await graph.evaluate(
    (element, input) => {
      for (let index = 0; index < input.count; index += 1) {
        element.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: input.key,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    },
    { key, count },
  );
}

async function expectMapNodeFullyVisible(node: Locator, graph: Locator) {
  await expect(async () => {
    const nodeBox = await node.boundingBox();
    const viewportBox = await graph.boundingBox();
    expect(nodeBox).not.toBeNull();
    expect(viewportBox).not.toBeNull();
    if (!nodeBox || !viewportBox) throw new Error('Map geometry is missing');
    expect(nodeBox.x).toBeGreaterThanOrEqual(viewportBox.x);
    expect(nodeBox.y).toBeGreaterThanOrEqual(viewportBox.y);
    expect(nodeBox.x + nodeBox.width).toBeLessThanOrEqual(
      viewportBox.x + viewportBox.width,
    );
    expect(nodeBox.y + nodeBox.height).toBeLessThanOrEqual(
      viewportBox.y + viewportBox.height,
    );
  }).toPass({ timeout: 5_000 });
}

async function replaceLocalCards(page: Page, cards: LocalFixtureCard[]) {
  await page.evaluate(async (fixtureCards) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('fukamu-notes', 2);
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
  await expect(graph).toHaveAttribute('data-total-node-count', /\d+/);
  await expect(page.getByTestId('connections-semantic-lists')).toHaveCount(0);
  await page.getByRole('button', { name: '過去のカード' }).click();
  await page
    .getByTestId('history-list')
    .locator('button[data-current="false"]')
    .filter({ hasText: targetTitle })
    .click();
  await expect(page.getByTestId('card-title')).toHaveValue(targetTitle);

  await page.getByRole('button', { name: '過去のカード' }).click();
  const values = await page
    .getByTestId('history-list')
    .locator('[data-display-value]')
    .evaluateAll((items) =>
      items.map((item) => Number(item.getAttribute('data-display-value'))),
    );
  expect(values).toEqual([...values].sort((left, right) => right - left));
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

test('title and body share one chronological Undo/Redo history', async ({
  page,
  context,
}, testInfo) => {
  const titleA = unique('履歴A', testInfo.project.name);
  const titleB = unique('履歴B', testInfo.project.name);
  const titleC = unique('履歴C', testInfo.project.name);
  const titleD = unique('履歴D', testInfo.project.name);
  const imeTitle = unique('日本語確定', testInfo.project.name);
  const bodyText = '本文の履歴';
  const undoShortcut = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';

  await ready(page);
  await page.getByTestId('new-card').click();
  const title = page.getByTestId('card-title');
  const editor = page.getByTestId('body-editor');
  const undo = page.getByTestId('undo');
  const redo = page.getByTestId('redo');

  await title.fill(titleA);
  await editor.click();
  await expect(page.getByTestId('save-sync-status')).toHaveText('保存済み');
  await page.reload();
  await expect(title).toHaveValue(titleA);
  await expect(page.getByTestId('save-sync-status')).toHaveText('保存済み');
  await expect(undo).toBeDisabled();

  await title.fill(titleB);
  await expect(undo).toBeEnabled();
  await editor.click();
  await editor.pressSequentially(bodyText);
  await title.fill(titleC);

  await undo.click();
  await expect(title).toHaveValue(titleB);
  await expect(editor).toContainText(bodyText);
  await expect(title).toBeFocused();

  await undo.click();
  await expect(title).toHaveValue(titleB);
  await expect(editor).not.toContainText(bodyText);
  await expect(editor).toBeFocused();

  await undo.click();
  await expect(title).toHaveValue(titleA);
  await expect(editor).not.toContainText(bodyText);
  await expect(title).toBeFocused();
  await expect(undo).toBeDisabled();

  await redo.click();
  await expect(title).toHaveValue(titleB);
  await expect(editor).not.toContainText(bodyText);
  await redo.click();
  await expect(editor).toContainText(bodyText);
  await redo.click();
  await expect(title).toHaveValue(titleC);
  await expect(redo).toBeDisabled();

  await title.press(undoShortcut);
  await expect(title).toHaveValue(titleB);
  await expect(redo).toBeEnabled();
  await title.fill(titleD);
  await expect(redo).toBeDisabled();
  await undo.click();
  await expect(title).toHaveValue(titleB);
  await redo.click();
  await expect(title).toHaveValue(titleD);

  await title.focus();
  await title.selectText();
  const ime = await context.newCDPSession(page);
  await ime.send('Input.imeSetComposition', {
    text: '日本語',
    selectionStart: 3,
    selectionEnd: 3,
  });
  await ime.send('Input.insertText', { text: imeTitle });
  await ime.detach();
  await expect(title).toHaveValue(imeTitle);
  await editor.click();
  await undo.click();
  await expect(title).toHaveValue(titleD);
  await redo.click();
  await expect(title).toHaveValue(imeTitle);

  await expect(page.getByTestId('save-sync-status')).toHaveText('保存済み');
  await page.reload();
  await expect(title).toHaveValue(imeTitle);
  await expect(editor).toContainText(bodyText);
  await expect(undo).toBeDisabled();
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

test('link candidates are descending, prefix-filtered, scroll-following and explicit-only', async ({
  page,
  context,
}) => {
  await ready(page);
  await page.locator('html[data-offline-ready=true]').waitFor({
    state: 'attached',
    timeout: 15_000,
  });
  await context.setOffline(true);
  const cards: LocalFixtureCard[] = Array.from({ length: 101 }, (_, index) => ({
    id: fixtureCardId(`candidate-prefix-${index + 1}`),
    displayId: { kind: 'official', value: index + 1 },
    title: `候補 ${index + 1}`,
    body: [],
    createdAt: index + 1,
    updatedAt: index + 1,
    localRevision: 1,
    serverRevision: 1,
  }));
  const current = cards.at(-1);
  if (!current) throw new Error('Candidate fixture is empty');
  await replaceLocalCards(page, cards);
  await page.goto(`/cards/${current.id}`);
  await expect(page.getByTestId('card-title')).toHaveValue('候補 101');

  const editor = page.getByTestId('body-editor');
  await editor.click();
  const deleteThroughEditingCommand = (inputType = 'deleteContentBackward') =>
    editor.evaluate((editorElement, nextInputType) => {
      const selection = window.getSelection();
      const paragraph = editorElement.querySelector('p');
      const text = paragraph?.lastChild;
      if (
        !selection ||
        !(paragraph instanceof HTMLElement) ||
        !(text instanceof Text) ||
        text.length === 0
      ) {
        throw new Error('Expected editable text before deletion');
      }
      const range = document.createRange();
      range.setStart(text, text.length - 1);
      range.setEnd(text, text.length);
      selection.removeAllRanges();
      selection.addRange(range);
      paragraph.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: nextInputType,
        }),
      );
      range.deleteContents();
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      paragraph.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: nextInputType,
        }),
      );
    }, inputType);
  const input = await context.newCDPSession(page);
  await input.send('Input.insertText', { text: '#' });
  const candidateList = page.getByTestId('link-candidates');
  const candidateButtons = candidateList.getByRole('button');
  await expect(candidateButtons).toHaveCount(100);
  await expect(candidateButtons.first()).toContainText('#100');
  await expect(candidateButtons.last()).toContainText('#1');

  for (let index = 0; index < 30; index += 1) {
    await editor.press('ArrowDown');
  }
  const activeCandidate = candidateList.locator('[aria-current=true]');
  await expect(activeCandidate).toContainText('#70');
  const activeIsVisible = await activeCandidate.evaluate((element) => {
    const item = element.getBoundingClientRect();
    const scroll = element.closest('[data-testid=link-candidate-scroll]');
    if (!scroll) return false;
    const viewport = scroll.getBoundingClientRect();
    return item.top >= viewport.top && item.bottom <= viewport.bottom;
  });
  expect(activeIsVisible).toBe(true);
  expect(
    await page
      .getByTestId('link-candidate-scroll')
      .evaluate((element) => Math.max(element.scrollTop, 0)),
  ).toBeGreaterThan(0);

  await input.send('Input.insertText', { text: '3' });
  await expect(candidateButtons).toHaveCount(11);
  expect(
    await candidateButtons.evaluateAll((buttons) =>
      buttons.map((button) => button.textContent?.match(/#\d+/u)?.[0]),
    ),
  ).toEqual([
    '#39',
    '#38',
    '#37',
    '#36',
    '#35',
    '#34',
    '#33',
    '#32',
    '#31',
    '#30',
    '#3',
  ]);
  await input.send('Input.insertText', { text: '2' });
  await expect(candidateButtons).toHaveCount(1);
  await expect(candidateButtons.first()).toContainText('#32');
  await expect(editor.locator('[data-card-link-id]')).toHaveCount(0);

  await deleteThroughEditingCommand('deleteByCut');
  await expect(candidateButtons).toHaveCount(11);
  expect(
    await candidateButtons.evaluateAll((buttons) =>
      buttons.map((button) => button.textContent?.match(/#\d+/u)?.[0]),
    ),
  ).toEqual([
    '#39',
    '#38',
    '#37',
    '#36',
    '#35',
    '#34',
    '#33',
    '#32',
    '#31',
    '#30',
    '#3',
  ]);
  await deleteThroughEditingCommand();
  await expect(candidateButtons).toHaveCount(100);
  await expect(candidateButtons.first()).toContainText('#100');
  await expect(candidateButtons.last()).toContainText('#1');

  await input.send('Input.insertText', { text: '369' });
  await expect(candidateButtons).toHaveCount(0);
  await deleteThroughEditingCommand();
  await expect(candidateButtons).toHaveCount(1);
  await expect(candidateButtons.first()).toContainText('#36');
  await deleteThroughEditingCommand();
  await expect(candidateButtons).toHaveCount(11);
  await deleteThroughEditingCommand();
  await expect(candidateButtons).toHaveCount(100);

  await input.send('Input.insertText', { text: '32' });
  await expect(candidateButtons).toHaveCount(1);
  await expect(candidateButtons.first()).toContainText('#32');

  await input.send('Input.insertText', { text: ' ' });
  await expect(candidateList).toHaveCount(0);
  await expect(editor).toContainText('#32 ');
  await expect(editor.locator('[data-card-link-id]')).toHaveCount(0);

  await input.send('Input.insertText', { text: '#' });
  await editor.press('Escape');
  await expect(candidateList).toHaveCount(0);
  await expect(editor).toContainText('#32 #');

  await input.send('Input.insertText', { text: '32' });
  await expect(candidateButtons).toHaveCount(1);
  await candidateButtons.first().click();
  await expect(editor.locator('[data-card-link-id]')).toHaveCount(1);
  await expect(editor.getByRole('link')).toContainText('候補 32');
  await page.getByTestId('undo').click();
  await expect(editor.locator('[data-card-link-id]')).toHaveCount(0);
  await expect(editor).toContainText('#32 #32');
  await page.getByTestId('redo').click();
  await expect(editor.locator('[data-card-link-id]')).toHaveCount(1);
  await input.detach();
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
  await expect(graph).toHaveAttribute('data-camera-scale', /\d/, {
    timeout: 5_000,
  });
  await expect(graph).toHaveAttribute('data-edge-renderer', 'canvas-2d');
  await expect(graph).toHaveAttribute('data-edge-render-status', 'painted');
  const edgeCanvas = graph.getByTestId('connections-edge-canvas');
  const cardCanvas = graph.getByTestId('connections-card-canvas');
  await expect(edgeCanvas).toHaveCount(1);
  await expect(edgeCanvas).toHaveAttribute('aria-hidden', 'true');
  await expect(cardCanvas).toHaveCount(1);
  await expect(cardCanvas).toHaveAttribute('aria-hidden', 'true');
  await expect(graph.locator('svg')).toHaveCount(0);
  const canvasHasPaint = await edgeCanvas.evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) return false;
    const context = element.getContext('2d');
    if (!context) return false;
    const pixels = context.getImageData(
      0,
      0,
      element.width,
      element.height,
    ).data;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] !== 0) return true;
    }
    return false;
  });
  expect(canvasHasPaint).toBe(true);
  await expect(graph).toHaveAttribute(
    'data-card-renderer',
    /^(html-windowed|canvas-2d-overview)$/,
  );

  await expect(page.getByTestId('connections-semantic-lists')).toHaveCount(0);
  await expect(graph).toHaveAttribute('data-total-node-count', '7');
  await expect(graph).toHaveAttribute('data-total-edge-count', '8');

  await pressConnectionsKey(graph, 'Home');
  await expect(graph).toHaveAttribute('data-node-renderer', 'html');
  await expect
    .poll(() => graph.locator('button[data-card-id]').count())
    .toBeGreaterThan(0);

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

  const viewportBehavior = await graph.evaluate((element) => {
    const style = getComputedStyle(element);
    const navigation = document.querySelector('.app-navigation');
    if (!navigation) throw new Error('Connections navigation is missing');
    const viewportBounds = element.getBoundingClientRect();
    const navigationBounds = navigation.getBoundingClientRect();
    return {
      touchAction: style.touchAction,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      viewportHeight: element.clientHeight,
      viewportBottom: viewportBounds.bottom,
      viewportRight: viewportBounds.right,
      navigationTop: navigationBounds.top,
      navigationLeft: navigationBounds.left,
      windowHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
      windowWidth: window.innerWidth,
    };
  });
  expect(viewportBehavior.touchAction).toBe('none');
  expect(viewportBehavior.overflowX).toBe('clip');
  expect(viewportBehavior.overflowY).toBe('clip');
  expect(viewportBehavior.viewportHeight).toBeGreaterThan(
    viewportBehavior.windowHeight * 0.55,
  );
  expect(viewportBehavior.documentWidth).toBeLessThanOrEqual(
    viewportBehavior.windowWidth + 1,
  );
  expect(viewportBehavior.documentHeight).toBeLessThanOrEqual(
    viewportBehavior.windowHeight + 1,
  );
  if (testInfo.project.name === 'mobile-chromium') {
    expect(viewportBehavior.viewportBottom).toBeLessThanOrEqual(
      viewportBehavior.navigationTop,
    );
  } else {
    expect(viewportBehavior.viewportRight).toBeLessThanOrEqual(
      viewportBehavior.navigationLeft,
    );
  }
  await testInfo.attach('connections-expanded-workspace.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  if (testInfo.project.name === 'mobile-chromium') {
    const portraitViewport = page.viewportSize();
    if (!portraitViewport) throw new Error('Mobile viewport is unavailable');
    await page.setViewportSize({ width: 667, height: 375 });
    const landscapeLayout = await graph.evaluate((element) => {
      const navigation = document.querySelector('.app-navigation');
      if (!navigation) throw new Error('Connections navigation is missing');
      return {
        graphHeight: element.clientHeight,
        graphBottom: element.getBoundingClientRect().bottom,
        navigationTop: navigation.getBoundingClientRect().top,
        documentHeight: document.documentElement.scrollHeight,
        windowHeight: window.innerHeight,
      };
    });
    expect(landscapeLayout.graphHeight).toBeGreaterThan(150);
    expect(landscapeLayout.graphBottom).toBeLessThanOrEqual(
      landscapeLayout.navigationTop,
    );
    expect(landscapeLayout.documentHeight).toBeLessThanOrEqual(
      landscapeLayout.windowHeight + 1,
    );
    await testInfo.attach('connections-expanded-workspace-landscape.png', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await page.setViewportSize(portraitViewport);
  }
  const targetNode = graph
    .getByRole('button')
    .filter({ hasText: titles.reportB });
  await targetNode.focus();
  await expect(targetNode).toBeInViewport();
  if (testInfo.project.name === 'mobile-chromium') {
    await targetNode.tap();
  } else {
    await targetNode.focus();
    await targetNode.press('Enter');
  }
  await expect(page.getByTestId('card-title')).toHaveValue(titles.reportB);
});

test('connections map supports viewport keyboard, touch gestures and drag-safe selection', async ({
  page,
  context,
}, testInfo) => {
  const cards = largeConnectionsBenchmarkCards();
  const current = cards[0];
  if (!current) throw new Error('Large camera fixture is incomplete');
  await ready(page);
  await page.locator('html[data-offline-ready=true]').waitFor({
    state: 'attached',
    timeout: 15_000,
  });
  await context.setOffline(true);
  await replaceLocalCards(page, cards);
  await page.reload();
  await openFromHistory(page, current.title);
  await page.getByRole('button', { name: 'つながり', exact: true }).click();
  const graph = page.getByTestId('connections-graph');
  await expect(graph).toHaveAttribute('data-layout-status', 'ready', {
    timeout: 30_000,
  });
  await expect(graph).toHaveAttribute('data-camera-scale', /\d/, {
    timeout: 5_000,
  });

  await expect(graph).toHaveAttribute('tabindex', '0');
  await expect(graph).toHaveAttribute(
    'aria-keyshortcuts',
    'ArrowLeft ArrowRight ArrowUp ArrowDown + - 0 Home',
  );
  await expect(
    page.getByRole('toolbar', { name: 'つながりマップの表示操作' }),
  ).toHaveCount(0);
  await expect(page.getByTestId('connections-network-summary')).toHaveCount(0);
  await expect(page.getByText('FULL DIRECTED NETWORK')).toHaveCount(0);
  const headerCreateButton = page.getByTestId('new-card');
  await headerCreateButton.focus();
  await page.keyboard.press('Tab');
  await expect(graph).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(headerCreateButton).toBeFocused();
  const fitted = await connectionsCamera(graph);
  for (const value of Object.values(fitted)) {
    expect(Number.isFinite(value)).toBe(true);
  }
  const currentNode = graph
    .getByRole('button')
    .filter({ hasText: current.title });
  expect(fitted.scale).toBeGreaterThan(0);
  expect(fitted.scale).toBeLessThanOrEqual(2);
  await pressConnectionsKey(graph, '+');
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeGreaterThan(fitted.scale);
  const explicitlyZoomed = await connectionsCamera(graph);
  await pressConnectionsKey(graph, '-');
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeLessThan(explicitlyZoomed.scale);
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeCloseTo(fitted.scale, 5);

  const normalWheelPrevented = await graph.evaluate((element) => {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100,
      deltaY: -120,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(normalWheelPrevented).toBe(false);
  const beforeModifiedWheel = await connectionsCamera(graph);
  const modifiedWheelPrevented = await graph.evaluate((element) => {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100,
      deltaY: -120,
      ctrlKey: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(modifiedWheelPrevented).toBe(true);
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeGreaterThan(beforeModifiedWheel.scale);

  const maximumWheelPrevented = await graph.evaluate((element) => {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100,
      deltaY: -10_000,
      ctrlKey: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(maximumWheelPrevented).toBe(true);
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeCloseTo(2, 7);

  const originalViewport = page.viewportSize();
  if (!originalViewport) throw new Error('Browser viewport is unavailable');
  await page.setViewportSize({
    width: originalViewport.width - 20,
    height: originalViewport.height - 20,
  });
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeCloseTo(2, 7);
  await page.setViewportSize(originalViewport);

  await graph.evaluate((element) => {
    element.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100,
        deltaY: 10_000,
        ctrlKey: true,
      }),
    );
  });
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeLessThanOrEqual(0.1);
  const minimumScale = (await connectionsCamera(graph)).scale;
  expect(minimumScale).toBeGreaterThan(0);

  await pressConnectionsKey(graph, '0');
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeCloseTo(fitted.scale, 5);
  const dispatchMapKey = (key: string, count = 1) =>
    pressConnectionsKey(graph, key, count);
  const fittedBeforeFreePan = await connectionsCamera(graph);
  await dispatchMapKey('ArrowRight', 20);
  await expect
    .poll(async () => (await connectionsCamera(graph)).x)
    .toBeCloseTo(fittedBeforeFreePan.x - 1_280, 5);
  await dispatchMapKey('ArrowLeft', 40);
  await expect
    .poll(async () => (await connectionsCamera(graph)).x)
    .toBeCloseTo(fittedBeforeFreePan.x + 1_280, 5);
  await dispatchMapKey('0');
  await expect
    .poll(async () => (await connectionsCamera(graph)).x)
    .toBeCloseTo(fittedBeforeFreePan.x, 5);
  await dispatchMapKey('ArrowUp', 20);
  await expect
    .poll(async () => (await connectionsCamera(graph)).y)
    .toBeCloseTo(fittedBeforeFreePan.y + 1_280, 5);
  await dispatchMapKey('ArrowDown', 40);
  await expect
    .poll(async () => (await connectionsCamera(graph)).y)
    .toBeCloseTo(fittedBeforeFreePan.y - 1_280, 5);
  await dispatchMapKey('Home');
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeGreaterThanOrEqual(0.5);
  await expect(currentNode).toBeInViewport();
  await dispatchMapKey('0');
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeCloseTo(fitted.scale, 5);
  await graph.press('+');
  await graph.press('+');
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeGreaterThan(fitted.scale);
  const beforeKeyboardPan = await connectionsCamera(graph);
  await graph.press('ArrowRight');
  await page.waitForTimeout(50);
  let afterKeyboardPan = await connectionsCamera(graph);
  if (afterKeyboardPan.x === beforeKeyboardPan.x) {
    await graph.press('ArrowLeft');
    await page.waitForTimeout(50);
    afterKeyboardPan = await connectionsCamera(graph);
  }
  expect(afterKeyboardPan.x).not.toBe(beforeKeyboardPan.x);
  await dispatchMapKey('0');
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeCloseTo(fitted.scale, 5);
  await graph.press('+');
  await graph.press('+');
  const viewportBox = await graph.boundingBox();
  if (!viewportBox) throw new Error('Connections viewport has no geometry');
  const center = {
    x: viewportBox.x + viewportBox.width / 2,
    y: viewportBox.y + viewportBox.height / 2,
  };
  const touch = await context.newCDPSession(page);
  const outsideTouchAction = await page
    .locator('header')
    .evaluate((element) => getComputedStyle(element).touchAction);
  expect(outsideTouchAction).toBe('auto');
  await graph.evaluate((element) => {
    element.dataset.pointerTrace = '';
    const eventTypes = [
      'pointerdown',
      'pointermove',
      'gotpointercapture',
      'lostpointercapture',
      'pointerup',
      'pointercancel',
    ] as const;
    for (const eventType of eventTypes) {
      element.addEventListener(
        eventType,
        (event) => {
          if (!(event instanceof PointerEvent)) return;
          element.dataset.lastPointerId = String(event.pointerId);
          const entry = [
            event.type,
            event.pointerType,
            String(event.pointerId),
            element.hasPointerCapture(event.pointerId) ? 'captured' : 'free',
            event.target === element ? 'self' : 'descendant',
          ].join(':');
          element.dataset.pointerTrace = [element.dataset.pointerTrace, entry]
            .filter(Boolean)
            .join('\n');
        },
        true,
      );
    }
  });
  const canvasBeforeGesture = await graph.evaluate((element) => {
    const canvas = element.querySelector('[data-testid="connections-canvas"]');
    return {
      width: canvas?.getAttribute('data-layout-width'),
      height: canvas?.getAttribute('data-layout-height'),
      layoutKey: canvas?.getAttribute('data-layout-key'),
      nodeCount: canvas?.querySelectorAll('[data-card-id]').length ?? -1,
      pathCount: canvas?.querySelectorAll('path[d]').length ?? -1,
    };
  });
  const beforeTouchPan = await connectionsCamera(graph);
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: center.x, y: center.y, id: 1 }],
  });
  const smallMoveCameras: ConnectionsCameraSnapshot[] = [];
  for (let step = 1; step <= 10; step += 1) {
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: center.x + step * 2, y: center.y + step * 1.2, id: 1 },
      ],
    });
    await page.waitForTimeout(20);
    smallMoveCameras.push(await connectionsCamera(graph));
  }
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  const singlePointerTrace = await graph.getAttribute('data-pointer-trace');
  console.info(
    `connections-small-move-trace ${JSON.stringify({
      project: testInfo.project.name,
      before: beforeTouchPan,
      cameras: smallMoveCameras,
      trace: singlePointerTrace,
    })}`,
  );
  await expect
    .poll(async () => {
      const camera = await connectionsCamera(graph);
      return `${camera.x}:${camera.y}`;
    })
    .not.toBe(`${beforeTouchPan.x}:${beforeTouchPan.y}`);
  expect(
    new Set(smallMoveCameras.map(({ x, y }) => `${x}:${y}`)).size,
  ).toBeGreaterThan(4);
  expect(singlePointerTrace).toMatch(
    /pointerdown:touch:\d+:(?:free|captured):(?:self|descendant)/,
  );
  expect(singlePointerTrace).toMatch(
    /lostpointercapture:touch:\d+:(?:free|captured):descendant/,
  );
  expect(singlePointerTrace).toMatch(
    /gotpointercapture:touch:\d+:captured:self/,
  );
  expect(singlePointerTrace).toMatch(/pointermove:touch:\d+:captured:self/);
  expect(singlePointerTrace).toMatch(/pointerup:touch:\d+:captured:self/);
  expect(singlePointerTrace).toMatch(/lostpointercapture:touch:\d+:free:self/);
  const traceEntries = singlePointerTrace?.split('\n') ?? [];
  const capturedAt = traceEntries.findIndex((entry) =>
    /^gotpointercapture:.*:captured:self$/.test(entry),
  );
  const firstCapturedMoveAt = traceEntries.findIndex((entry) =>
    /^pointermove:.*:captured:self$/.test(entry),
  );
  expect(capturedAt).toBeGreaterThanOrEqual(0);
  expect(firstCapturedMoveAt).toBeGreaterThan(capturedAt);

  const beforePinch = await connectionsCamera(graph);
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: center.x - 45, y: center.y, id: 2 },
      { x: center.x + 45, y: center.y, id: 3 },
    ],
  });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { x: center.x - 90, y: center.y, id: 2 },
      { x: center.x + 90, y: center.y, id: 3 },
    ],
  });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeGreaterThan(beforePinch.scale);

  await graph.evaluate((element) => {
    element.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100,
        deltaY: -10_000,
        ctrlKey: true,
      }),
    );
  });
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeCloseTo(2, 7);
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: center.x - 30, y: center.y, id: 8 },
      { x: center.x + 30, y: center.y, id: 9 },
    ],
  });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { x: center.x - 100, y: center.y, id: 8 },
      { x: center.x + 100, y: center.y, id: 9 },
    ],
  });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeCloseTo(2, 7);

  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: center.x, y: center.y, id: 7 }],
  });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: center.x + 10, y: center.y + 8, id: 7 }],
  });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: center.x + 12, y: center.y + 10, id: 7 }],
  });
  await graph.evaluate((element) => {
    const pointerId = Number(element.dataset.lastPointerId);
    if (Number.isFinite(pointerId) && element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
  });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: center.x + 14, y: center.y + 12, id: 7 }],
  });
  await expect(graph).toHaveAttribute('data-active-pointers', '0');
  await expect(graph).toHaveAttribute('data-dragging', 'false');
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchCancel',
    touchPoints: [],
  });

  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: center.x, y: center.y, id: 5 }],
  });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: center.x + 30, y: center.y + 20, id: 5 }],
  });
  await expect(graph).toHaveAttribute('data-dragging', 'true');
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchCancel',
    touchPoints: [],
  });
  await expect(graph).toHaveAttribute('data-active-pointers', '0');
  await expect(graph).toHaveAttribute('data-dragging', 'false');
  await expect(graph).toHaveAttribute('data-click-suppression', 'false', {
    timeout: 1_000,
  });
  const pointerTrace = await graph.getAttribute('data-pointer-trace');
  expect(pointerTrace).toMatch(
    /pointercancel:touch:\d+:(?:captured|free):(?:self|descendant)/,
  );
  expect(pointerTrace).toMatch(/lostpointercapture:touch:\d+:free:self/);
  await testInfo.attach('connections-pointer-trace.txt', {
    body: Buffer.from(`${pointerTrace ?? ''}\n`),
    contentType: 'text/plain',
  });

  const canvasAfterGesture = await graph.evaluate((element) => {
    const canvas = element.querySelector('[data-testid="connections-canvas"]');
    return {
      width: canvas?.getAttribute('data-layout-width'),
      height: canvas?.getAttribute('data-layout-height'),
      layoutKey: canvas?.getAttribute('data-layout-key'),
      nodeCount: canvas?.querySelectorAll('[data-card-id]').length ?? -1,
      pathCount: canvas?.querySelectorAll('path[d]').length ?? -1,
    };
  });
  expect(canvasAfterGesture).toMatchObject({
    width: canvasBeforeGesture.width,
    height: canvasBeforeGesture.height,
    layoutKey: canvasBeforeGesture.layoutKey,
  });
  expect(canvasBeforeGesture.nodeCount).toBeLessThan(cards.length);
  expect(canvasAfterGesture.nodeCount).toBeLessThan(cards.length);
  expect(canvasAfterGesture.pathCount).toBeGreaterThanOrEqual(0);

  if (testInfo.project.name === 'chromium') {
    const beforePenPan = await connectionsCamera(graph);
    const dragPen = async (deltaX: number, deltaY: number) => {
      await touch.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: center.x,
        y: center.y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
        pointerType: 'pen',
      });
      await touch.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: center.x + deltaX,
        y: center.y + deltaY,
        button: 'left',
        buttons: 1,
        pointerType: 'pen',
      });
      await touch.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: center.x + deltaX,
        y: center.y + deltaY,
        button: 'left',
        buttons: 0,
        clickCount: 1,
        pointerType: 'pen',
      });
    };
    await dragPen(40, 30);
    let afterPenPan = await connectionsCamera(graph);
    if (afterPenPan.x === beforePenPan.x && afterPenPan.y === beforePenPan.y) {
      await dragPen(-40, -30);
      afterPenPan = await connectionsCamera(graph);
    }
    expect([afterPenPan.x, afterPenPan.y]).not.toEqual([
      beforePenPan.x,
      beforePenPan.y,
    ]);
  }

  await pressConnectionsKey(graph, 'Home');
  await expect(currentNode).toBeInViewport();
  await expectMapNodeFullyVisible(currentNode, graph);
  const currentBox = await currentNode.boundingBox();
  if (!currentBox) throw new Error('Current map node has no geometry');
  if (testInfo.project.name === 'mobile-chromium') {
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        {
          x: currentBox.x + currentBox.width / 2,
          y: currentBox.y + currentBox.height / 2,
          id: 4,
        },
      ],
    });
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: currentBox.x + currentBox.width / 2 + 50,
          y: currentBox.y + currentBox.height / 2 + 35,
          id: 4,
        },
      ],
    });
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  } else {
    await page.mouse.move(
      currentBox.x + currentBox.width / 2,
      currentBox.y + currentBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      currentBox.x + currentBox.width / 2 + 50,
      currentBox.y + currentBox.height / 2 + 35,
      { steps: 5 },
    );
    await page.mouse.up();
  }
  await expectPathname(page, `/cards/${current.id}/connections`);

  const gesturePerformance = await graph.evaluate(async (element) => {
    const durations: number[] = [];
    const frameIntervals: number[] = [];
    const longTasks: number[] = [];
    const observer =
      typeof PerformanceObserver === 'undefined'
        ? null
        : new PerformanceObserver((list) => {
            longTasks.push(...list.getEntries().map((entry) => entry.duration));
          });
    observer?.observe({ entryTypes: ['longtask'] });
    const startingRenderCount = Number(
      element.dataset.cameraRenderCount ?? '0',
    );
    const started = performance.now();
    let previousFrame = started;
    for (let frame = 0; frame < 120; frame += 1) {
      const frameTime = await new Promise<number>((resolve) =>
        requestAnimationFrame((time) => resolve(time)),
      );
      frameIntervals.push(frameTime - previousFrame);
      previousFrame = frameTime;
      for (let eventIndex = 0; eventIndex < 4; eventIndex += 1) {
        const event = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 120,
          deltaY: eventIndex % 2 === 0 ? -0.5 : 0.5,
          ctrlKey: true,
        });
        const before = performance.now();
        element.dispatchEvent(event);
        durations.push(performance.now() - before);
      }
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    longTasks.push(
      ...(observer?.takeRecords() ?? []).map((entry) => entry.duration),
    );
    observer?.disconnect();
    durations.sort((left, right) => left - right);
    frameIntervals.sort((left, right) => left - right);
    const p95Index = Math.floor((durations.length - 1) * 0.95);
    const frameP95Index = Math.floor((frameIntervals.length - 1) * 0.95);
    return {
      durationMs: performance.now() - started,
      handlerP95Ms: durations[p95Index] ?? Number.NaN,
      frameP95Ms: frameIntervals[frameP95Index] ?? Number.NaN,
      longTaskCount: longTasks.length,
      longestTaskMs: Math.max(0, ...longTasks),
      transformWrites:
        Number(element.dataset.cameraRenderCount ?? '0') - startingRenderCount,
    };
  });
  expect(gesturePerformance.durationMs).toBeGreaterThan(1_500);
  expect(Number.isFinite(gesturePerformance.handlerP95Ms)).toBe(true);
  expect(Number.isFinite(gesturePerformance.frameP95Ms)).toBe(true);
  expect(gesturePerformance.transformWrites).toBeLessThanOrEqual(122);
  console.info(
    `connections-gesture-benchmark ${JSON.stringify({ project: testInfo.project.name, ...gesturePerformance })}`,
  );
  await testInfo.attach('connections-gesture-benchmark.json', {
    body: Buffer.from(`${JSON.stringify(gesturePerformance, null, 2)}\n`),
    contentType: 'application/json',
  });

  await page.waitForTimeout(400);
  await pressConnectionsKey(graph, 'Home');
  await currentNode.focus();
  await expect(currentNode).toBeFocused();
  await page.waitForTimeout(100);
  const beforeChildArrow = await connectionsCamera(graph);
  await currentNode.evaluate((element) => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await page.waitForTimeout(50);
  const afterChildArrow = await connectionsCamera(graph);
  expect(afterChildArrow.x).toBe(beforeChildArrow.x);
  expect(afterChildArrow.y).toBe(beforeChildArrow.y);
  expect(afterChildArrow.scale).toBe(beforeChildArrow.scale);
  await graph.scrollIntoViewIfNeeded();
  await expect(currentNode).toBeInViewport();
  await expectMapNodeFullyVisible(currentNode, graph);
  const focusedCurrentBox = await currentNode.boundingBox();
  if (!focusedCurrentBox) throw new Error('Current map node has no geometry');
  await expect(graph).toHaveAttribute('data-active-pointers', '0');
  await expect(graph).toHaveAttribute('data-click-suppression', 'false');
  await expect(graph).toHaveAttribute('data-dragging', 'false');
  await currentNode.evaluate((element) => {
    if (element instanceof HTMLElement) element.blur();
  });
  const beforeOverviewScale = (await connectionsCamera(graph)).scale;
  const overviewWheelDelta = -Math.log(0.49 / beforeOverviewScale) / 0.002;
  await graph.evaluate(
    (element, input) => {
      element.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: input.x,
          clientY: input.y,
          deltaY: input.deltaY,
          ctrlKey: true,
        }),
      );
    },
    {
      x: focusedCurrentBox.x + focusedCurrentBox.width / 2,
      y: focusedCurrentBox.y + focusedCurrentBox.height / 2,
      deltaY: overviewWheelDelta,
    },
  );
  await expect(graph).toHaveAttribute('data-node-renderer', 'overview-canvas');
  await expect(graph.locator('button[data-card-id]')).toHaveCount(0);
  await page.mouse.click(
    focusedCurrentBox.x + focusedCurrentBox.width / 2,
    focusedCurrentBox.y + focusedCurrentBox.height / 2,
  );
  await touch.detach();
  await expectPathname(page, `/cards/${current.id}`);
  await expect(page.getByTestId('card-title')).toHaveValue(current.title);
});

test('connections zoom persists across app views and reloads', async ({
  page,
  context,
}) => {
  const cards = largeConnectionsBenchmarkCards();
  const current = cards[0];
  if (!current) throw new Error('Zoom preference fixture is incomplete');
  await ready(page);
  await page.evaluate(
    (key) => localStorage.removeItem(key),
    CONNECTIONS_ZOOM_PREFERENCE_KEY,
  );
  await page.locator('html[data-offline-ready=true]').waitFor({
    state: 'attached',
    timeout: 15_000,
  });
  await context.setOffline(true);
  await replaceLocalCards(page, cards);
  await page.reload();
  await openFromHistory(page, current.title);
  await page.getByRole('button', { name: 'つながり', exact: true }).click();

  let graph = page.getByTestId('connections-graph');
  await expect(graph).toHaveAttribute('data-layout-status', 'ready', {
    timeout: 30_000,
  });
  await expect(graph).toHaveAttribute('data-camera-scale', /\d/, {
    timeout: 5_000,
  });
  const fitted = await connectionsCamera(graph);
  await pressConnectionsKey(graph, '+', 2);
  const expectedPreferredScale = fitted.scale * 1.25 * 1.25;
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeCloseTo(expectedPreferredScale, 7);
  const preferredScale = (await connectionsCamera(graph)).scale;
  await expect
    .poll(() =>
      page.evaluate(
        (key) => Number(localStorage.getItem(key)),
        CONNECTIONS_ZOOM_PREFERENCE_KEY,
      ),
    )
    .toBeCloseTo(preferredScale, 7);

  await page.getByRole('button', { name: 'カード', exact: true }).click();
  await expect(page.getByTestId('card-title')).toHaveValue(current.title);
  await page.getByRole('button', { name: '過去のカード', exact: true }).click();
  await expect(page.getByTestId('history-list')).toBeVisible();
  await page.getByRole('button', { name: 'つながり', exact: true }).click();
  graph = page.getByTestId('connections-graph');
  await expect(graph).toHaveAttribute('data-layout-status', 'ready', {
    timeout: 30_000,
  });
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeCloseTo(preferredScale, 7);

  await page.reload();
  graph = page.getByTestId('connections-graph');
  await expect(graph).toHaveAttribute('data-layout-status', 'ready', {
    timeout: 30_000,
  });
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeCloseTo(preferredScale, 7);

  await page.evaluate(
    (key) => localStorage.setItem(key, '2'),
    CONNECTIONS_ZOOM_PREFERENCE_KEY,
  );
  await page.reload();
  graph = page.getByTestId('connections-graph');
  await expect(graph).toHaveAttribute('data-layout-status', 'ready', {
    timeout: 30_000,
  });
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeCloseTo(2, 7);

  await page.evaluate(
    (key) => localStorage.setItem(key, '0.1'),
    CONNECTIONS_ZOOM_PREFERENCE_KEY,
  );
  await page.reload();
  graph = page.getByTestId('connections-graph');
  await expect(graph).toHaveAttribute('data-layout-status', 'ready', {
    timeout: 30_000,
  });
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeCloseTo(0.1, 7);
  await expect(page.getByRole('status', { name: '現在のズーム' })).toHaveCount(
    0,
  );
});

test('connections readiness records reproducible large-fixture browser timing', async ({
  page,
  context,
}, testInfo) => {
  await page.addInitScript(() => {
    const root = document.documentElement;
    root.dataset.connectionsLongTaskCount = '0';
    root.dataset.connectionsLongTaskMax = '0';
    if (typeof PerformanceObserver === 'undefined') return;
    const observer = new PerformanceObserver((list) => {
      let count = Number(root.dataset.connectionsLongTaskCount ?? '0');
      let maximum = Number(root.dataset.connectionsLongTaskMax ?? '0');
      for (const entry of list.getEntries()) {
        count += 1;
        maximum = Math.max(maximum, entry.duration);
      }
      root.dataset.connectionsLongTaskCount = String(count);
      root.dataset.connectionsLongTaskMax = String(maximum);
    });
    observer.observe({ type: 'longtask', buffered: true });
  });
  const cards = largeConnectionsBenchmarkCards();
  const current = cards[0];
  if (!current) throw new Error('Large benchmark fixture is empty');
  await ready(page);
  await page.locator('html[data-offline-ready=true]').waitFor({
    state: 'attached',
    timeout: 15_000,
  });
  await context.setOffline(true);
  await replaceLocalCards(page, cards);
  await page.reload();
  await openFromHistory(page, current.title);

  const measureReady = async () => {
    await page.evaluate(async () => {
      const root = document.documentElement;
      root.dataset.connectionsLongTaskCount = '0';
      root.dataset.connectionsLongTaskMax = '0';
      root.dataset.connectionsFrameGapMax = '0';
      root.dataset.connectionsFrameMonitoring = 'true';
      await new Promise<void>((resolve) => {
        requestAnimationFrame((firstTimestamp) => {
          let previousFrame = firstTimestamp;
          const observeFrameGap = (timestamp: number) => {
            if (root.dataset.connectionsFrameMonitoring !== 'true') return;
            const previousMaximum = Number(
              root.dataset.connectionsFrameGapMax ?? '0',
            );
            root.dataset.connectionsFrameGapMax = String(
              Math.max(previousMaximum, timestamp - previousFrame),
            );
            previousFrame = timestamp;
            requestAnimationFrame(observeFrameGap);
          };
          requestAnimationFrame(observeFrameGap);
          resolve();
        });
      });
    });
    const started = await page.evaluate(() => performance.now());
    await page.getByRole('button', { name: 'つながり', exact: true }).click();
    await expect(page.getByTestId('connections-graph')).toHaveAttribute(
      'data-layout-status',
      'ready',
      { timeout: 30_000 },
    );
    await page.waitForTimeout(50);
    return page.evaluate((start) => {
      const root = document.documentElement;
      root.dataset.connectionsFrameMonitoring = 'false';
      return {
        timeToReadyMs: performance.now() - start,
        longTaskCount: Number(root.dataset.connectionsLongTaskCount ?? '0'),
        longestTaskMs: Number(root.dataset.connectionsLongTaskMax ?? '0'),
        maximumFrameGapMs: Number(root.dataset.connectionsFrameGapMax ?? '0'),
      };
    }, started);
  };

  const initial = await measureReady();
  await page.getByRole('button', { name: 'カード', exact: true }).click();
  const reentry = await measureReady();
  for (const measurement of [initial, reentry]) {
    expect(Number.isFinite(measurement.timeToReadyMs)).toBe(true);
    expect(measurement.timeToReadyMs).toBeGreaterThan(0);
    expect(measurement.longTaskCount).toBeGreaterThanOrEqual(0);
    expect(measurement.longestTaskMs).toBeGreaterThanOrEqual(0);
    expect(measurement.maximumFrameGapMs).toBeGreaterThanOrEqual(0);
  }
  const artifact = {
    project: testInfo.project.name,
    fixture: { nodes: cards.length, edges: 120, seed: '0x41decade' },
    initial,
    reentry,
  };
  console.info(`connections-browser-benchmark ${JSON.stringify(artifact)}`);
  await testInfo.attach('connections-browser-benchmark.json', {
    body: Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`),
    contentType: 'application/json',
  });
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
  await expect(page.getByTestId('save-sync-status')).toContainText(
    '同期失敗・端末に保存済み',
    { timeout: 15_000 },
  );
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
    page.locator('section[aria-label="過去のカード"]'),
  ).toBeVisible();
  await expect(page.getByTestId('history-list')).toBeVisible();

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

test('button and card labels are non-selectable while card editors remain selectable', async ({
  page,
}, testInfo) => {
  const card: LocalFixtureCard = {
    id: fixtureCardId(`non-selectable-${testInfo.project.name}`),
    displayId: { kind: 'official', value: 1 },
    title: '選択抑止を確認するカード',
    body: [],
    createdAt: 1,
    updatedAt: 1,
    localRevision: 1,
    serverRevision: 1,
  };
  await serveSyncCards(page, [card]);
  const response = await page.goto(`/cards/${card.id}`);
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId('card-title')).toHaveValue(card.title);

  await expectVisibleButtonsToBeNonSelectable(page);
  const editableUserSelect = await Promise.all([
    page
      .getByTestId('card-title')
      .evaluate((element) => getComputedStyle(element).userSelect),
    page
      .getByTestId('body-editor')
      .evaluate((element) => getComputedStyle(element).userSelect),
  ]);
  expect(editableUserSelect).not.toContain('none');

  await page.getByRole('button', { name: '過去のカード' }).click();
  const historyCard = page
    .getByTestId('history-list')
    .locator(`[data-card-id="${card.id}"]`);
  await expect(historyCard).toBeVisible();
  await expect(historyCard).toHaveCSS('user-select', 'none');
  await expectVisibleButtonsToBeNonSelectable(page);

  await page.getByRole('button', { name: 'つながり' }).click();
  const graph = page.getByTestId('connections-graph');
  await expect(graph).toHaveAttribute('data-layout-status', 'ready', {
    timeout: 15_000,
  });
  const connectionsCard = graph.locator(`[data-card-id="${card.id}"]`);
  await expect(connectionsCard).toBeVisible();
  await expect(connectionsCard).toHaveCSS('user-select', 'none');
  await expectVisibleButtonsToBeNonSelectable(page);
});

test('history centers the current card without obscuring its page chrome', async ({
  page,
}, testInfo) => {
  const cards: LocalFixtureCard[] = Array.from({ length: 12 }, (_, index) => ({
    id: `01991f20-61d2-7000-8000-${String(index + 701).padStart(12, '0')}`,
    displayId: { kind: 'official', value: index + 1 },
    title: `一覧レイアウト ${index + 1}`,
    body: [],
    createdAt: index + 1,
    updatedAt: index + 1,
    localRevision: 1,
    serverRevision: 1,
  }));
  const currentCard = cards.at(-1);
  if (!currentCard) throw new Error('history layout fixture is empty');

  await serveSyncCards(page, cards);
  const response = await page.goto(`/cards/${currentCard.id}/history`);
  expect(response?.status()).toBe(200);

  const historyList = page.getByTestId('history-list');
  const historyItems = historyList.locator('[data-display-value]');
  await expect(historyList).toHaveAttribute('data-history-total-count', '12');
  await expect(historyItems.first()).toBeVisible({ timeout: 15_000 });
  const initialDisplayValues = await historyItems.evaluateAll((items) =>
    items.map((item) => Number(item.getAttribute('data-display-value'))),
  );
  expect(initialDisplayValues).toEqual(
    Array.from(
      { length: initialDisplayValues.length },
      (_, index) => 12 - index,
    ),
  );
  const currentItem = historyList.locator('[data-current=true]');
  await expect(currentItem).toHaveAttribute('aria-current', 'page', {
    timeout: 15_000,
  });
  await expect(page.getByText('CARD STACK')).toHaveCount(0);
  await expect(
    page.getByText('新しい番号から、前後のカードをめくれます。'),
  ).toHaveCount(0);
  await expect(
    page.locator('section[aria-label="過去のカード"]'),
  ).toBeVisible();

  const layout = await page.evaluate(() => {
    const header = document.querySelector('header');
    const list = document.querySelector('[data-testid="history-list"]');
    const current = list?.querySelector('[data-current="true"]');
    const navigation = document.querySelector('.app-navigation');
    if (!header || !list || !current || !navigation) {
      throw new Error('history layout elements are missing');
    }

    return {
      scrollY: window.scrollY,
      headerBottom: header.getBoundingClientRect().bottom,
      listTop: list.getBoundingClientRect().top,
      listBottom: list.getBoundingClientRect().bottom,
      listRight: list.getBoundingClientRect().right,
      currentTop: current.getBoundingClientRect().top,
      currentBottom: current.getBoundingClientRect().bottom,
      navigationTop: navigation.getBoundingClientRect().top,
      navigationLeft: navigation.getBoundingClientRect().left,
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
      windowHeight: window.innerHeight,
      windowWidth: window.innerWidth,
    };
  });

  expect(layout.scrollY).toBe(0);
  expect(layout.listTop).toBeGreaterThanOrEqual(layout.headerBottom);
  expect(layout.currentTop).toBeGreaterThanOrEqual(layout.listTop);
  expect(layout.currentBottom).toBeLessThanOrEqual(layout.listBottom);
  expect(layout.documentHeight).toBeLessThanOrEqual(layout.windowHeight + 1);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.windowWidth + 1);
  if (testInfo.project.name === 'mobile-chromium') {
    expect(layout.listBottom).toBeLessThanOrEqual(layout.navigationTop);
  } else {
    expect(layout.listRight).toBeLessThanOrEqual(layout.navigationLeft);
  }

  await testInfo.attach('history-expanded-workspace.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  if (testInfo.project.name === 'mobile-chromium') {
    const portraitListHeight = await historyList.evaluate(
      (element) => element.clientHeight,
    );
    const portraitViewport = page.viewportSize();
    if (!portraitViewport) throw new Error('Mobile viewport is unavailable');
    await page.setViewportSize({ width: 667, height: 375 });
    const landscapeLayout = await historyList.evaluate((element) => {
      const navigation = document.querySelector('.app-navigation');
      if (!navigation) throw new Error('History navigation is missing');
      return {
        listHeight: element.clientHeight,
        listBottom: element.getBoundingClientRect().bottom,
        navigationTop: navigation.getBoundingClientRect().top,
        documentHeight: document.documentElement.scrollHeight,
        windowHeight: window.innerHeight,
      };
    });
    expect(landscapeLayout.listHeight).toBeGreaterThan(150);
    expect(landscapeLayout.listBottom).toBeLessThanOrEqual(
      landscapeLayout.navigationTop,
    );
    expect(landscapeLayout.documentHeight).toBeLessThanOrEqual(
      landscapeLayout.windowHeight + 1,
    );
    await testInfo.attach('history-expanded-workspace-landscape.png', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await page.setViewportSize(portraitViewport);
    await expect
      .poll(() => historyList.evaluate((element) => element.clientHeight))
      .toBe(portraitListHeight);
  }

  await historyList.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(historyList).toHaveAttribute('data-history-window-end', '12');
  const finalDisplayValues = await historyItems.evaluateAll((items) =>
    items.map((item) => Number(item.getAttribute('data-display-value'))),
  );
  expect(finalDisplayValues.at(-1)).toBe(1);
  expect(finalDisplayValues).toEqual(
    [...finalDisplayValues].sort((left, right) => right - left),
  );
});

test('10k history remains viewport-bounded and operable in the browser', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(180_000);
  const cards = createClientPerformanceFixture();
  const current = cards[Math.floor(cards.length / 2)];
  if (!current) throw new Error('10k browser fixture omitted its current card');
  await serveInitialPerformanceCards(page, cards);

  const initialStarted = performance.now();
  const response = await page.goto(`/cards/${current.id}`);
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId('card-title')).toHaveValue(current.title, {
    timeout: 30_000,
  });
  const initialRenderMs = performance.now() - initialStarted;
  const initialDomCount = await page.locator('*').count();
  const heapAfterInitialBytes = await browserHeapUsed(page);

  const historyStarted = performance.now();
  await page.getByRole('button', { name: '過去のカード', exact: true }).click();
  const historyList = page.getByTestId('history-list');
  await expect(historyList).toHaveAttribute(
    'data-history-total-count',
    '10000',
    { timeout: 30_000 },
  );
  await expect(historyList.locator('[data-current=true]')).toBeVisible();
  const historyOpenMs = performance.now() - historyStarted;
  const initialHistorySnapshot = await historyList.evaluate((element) => {
    const renderCount = Number(element.dataset.historyRenderCount);
    const rowHeight = Number(element.dataset.historyRowHeight);
    const rowGap = Number(element.dataset.historyRowGap);
    const overscan = Number(element.dataset.historyOverscan);
    const extent = rowHeight + rowGap;
    return {
      renderCount,
      renderLimit: Math.ceil(element.clientHeight / extent) + 1 + overscan * 2,
      totalDomCount: document.getElementsByTagName('*').length,
      viewportHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      windowStart: Number(element.dataset.historyWindowStart),
      windowEnd: Number(element.dataset.historyWindowEnd),
    };
  });
  expect(initialHistorySnapshot.renderCount).toBeGreaterThan(0);
  expect(initialHistorySnapshot.renderCount).toBeLessThanOrEqual(
    initialHistorySnapshot.renderLimit,
  );
  expect(initialHistorySnapshot.windowStart).toBeGreaterThan(0);
  expect(initialHistorySnapshot.windowEnd).toBeLessThan(10_000);
  expect(initialHistorySnapshot.scrollTop).toBeGreaterThan(0);

  const scrollStarted = performance.now();
  await historyList.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(historyList).toHaveAttribute('data-history-window-end', '10000');
  const historyScrollMs = performance.now() - scrollStarted;
  const bottomRenderCount = Number(
    await historyList.getAttribute('data-history-render-count'),
  );
  expect(bottomRenderCount).toBeLessThanOrEqual(
    initialHistorySnapshot.renderLimit,
  );

  const lastVisibleButton = historyList.locator('button[data-card-id]').last();
  await lastVisibleButton.focus();
  await lastVisibleButton.press('Home');
  await expect(page.locator('button[data-card-id]:focus')).toHaveAttribute(
    'data-display-value',
    '10000',
  );
  await page.locator('button[data-card-id]:focus').press('End');
  await expect(page.locator('button[data-card-id]:focus')).toHaveAttribute(
    'data-display-value',
    '1',
  );
  await page.locator('button[data-card-id]:focus').press('Enter');
  await expect(page.getByTestId('card-title')).toHaveValue(
    'Performance card 00001',
  );
  await page.goBack();
  await expect(historyList).toHaveAttribute(
    'data-history-total-count',
    '10000',
  );

  await page.goto(`/cards/${current.id}`);
  await expect(page.getByTestId('card-title')).toHaveValue(current.title);
  const editor = page.getByTestId('body-editor');
  await editor.focus();
  await editor.press('End');
  const input = await context.newCDPSession(page);
  const linkQueryStarted = performance.now();
  await input.send('Input.insertText', { text: ' #99' });
  const candidates = page.getByTestId('link-candidates').getByRole('button');
  await expect(candidates).toHaveCount(111);
  const linkQueryMs = performance.now() - linkQueryStarted;
  await input.detach();

  const artifact = {
    schemaVersion: 1,
    issue: 204,
    project: testInfo.project.name,
    fixture: {
      cards: cards.length,
      seed: '0x1260cafe',
      textCharactersPerCard: 768,
    },
    measurements: {
      initialRenderMs,
      historyOpenMs,
      historyScrollMs,
      linkQueryMs,
      initialDomCount,
      historyDomCount: initialHistorySnapshot.totalDomCount,
      historyMountedRows: initialHistorySnapshot.renderCount,
      historyMountedRowLimit: initialHistorySnapshot.renderLimit,
      historyViewportHeight: initialHistorySnapshot.viewportHeight,
      historyScrollHeight: initialHistorySnapshot.scrollHeight,
      heapAfterInitialBytes,
      heapAfterInteractionsBytes: await browserHeapUsed(page),
    },
    policy: {
      timing: 'observational; no absolute wall-clock CI threshold',
      memory:
        'observational; availability and GC behavior are browser-specific',
      requiredGate:
        'mounted history rows <= viewport rows + one partial row + 2x fixed overscan',
    },
  };
  console.info(`history-10k-browser-benchmark ${JSON.stringify(artifact)}`);
  await testInfo.attach('history-10k-browser-benchmark.json', {
    body: Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`),
    contentType: 'application/json',
  });
});

test('10k connections lays out the complete graph and paints edges on Canvas', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const cards = createClientPerformanceFixture();
  const current = cards[5_000];
  if (!current) {
    throw new Error('10k connections fixture omitted its current card');
  }
  const servedCards = await serveInitialPerformanceCards(page, cards);
  const completeInput = selectConnectionsViewModel(servedCards, current.id);

  const navigationStarted = performance.now();
  const response = await page.goto(`/cards/${current.id}/connections`);
  expect(response?.status()).toBe(200);
  const graph = page.getByTestId('connections-graph');
  await expect(graph).toHaveAttribute('data-total-node-count', '10000', {
    timeout: 30_000,
  });
  await expect(graph).toHaveAttribute(
    'data-total-edge-count',
    String(completeInput.edges.length),
  );
  await expect(graph).toHaveAttribute('data-layout-status', 'ready', {
    timeout: 60_000,
  });
  const layoutReadyMs = performance.now() - navigationStarted;
  await expect(graph).toHaveAttribute('data-card-render-status', 'painted');
  await expect
    .poll(async () =>
      Number(await graph.getAttribute('data-card-raster-refresh-count')),
    )
    .toBeGreaterThan(0);
  await expect(graph).toHaveAttribute('data-card-draw-node-count', '10000');
  await expect(graph).toHaveAttribute('data-node-renderer', 'overview-canvas');
  await expect(graph.locator('button[data-card-id]')).toHaveCount(0);
  await expect(page.getByTestId('connections-semantic-lists')).toHaveCount(0);
  await expect(graph).toHaveAttribute('data-edge-renderer', 'canvas-2d');
  await expect(graph).toHaveAttribute('data-edge-render-status', 'painted');
  await expect
    .poll(async () =>
      Number(await graph.getAttribute('data-edge-raster-refresh-count')),
    )
    .toBeGreaterThan(0);
  await expect(graph).toHaveAttribute(
    'data-edge-draw-edge-count',
    String(completeInput.edges.length),
  );
  const initialReadyMs = performance.now() - navigationStarted;
  const initialCanvasDrawMs = Number(
    await graph.getAttribute('data-edge-draw-duration-ms'),
  );
  const initialCanvasPrepareMs = Number(
    await graph.getAttribute('data-edge-prepare-duration-ms'),
  );
  const initialCardCanvasDrawMs = Number(
    await graph.getAttribute('data-card-draw-duration-ms'),
  );
  const initialEdgeRasterRenderMs = Number(
    await graph.getAttribute('data-edge-raster-render-duration-ms'),
  );
  const initialCardRasterRenderMs = Number(
    await graph.getAttribute('data-card-raster-render-duration-ms'),
  );
  const initialVisibilityQueryMs = Number(
    await graph.getAttribute('data-visibility-query-duration-ms'),
  );
  const initialNodeCommitMs = Number(
    await graph.getAttribute('data-node-commit-duration-ms'),
  );
  const edgeCanvas = graph.getByTestId('connections-edge-canvas');
  const cardCanvas = graph.getByTestId('connections-card-canvas');
  await expect(edgeCanvas).toHaveCount(1);
  await expect(edgeCanvas).toHaveAttribute('aria-hidden', 'true');
  await expect(cardCanvas).toHaveCount(1);
  await expect(cardCanvas).toHaveAttribute('aria-hidden', 'true');
  await expect(graph.locator('svg')).toHaveCount(0);
  const canvasBackingStore = await edgeCanvas.evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) {
      throw new Error('Connections edge renderer is not a canvas');
    }
    return {
      width: element.width,
      height: element.height,
      cssWidth: element.clientWidth,
      cssHeight: element.clientHeight,
      devicePixelRatio: window.devicePixelRatio,
    };
  });
  expect(canvasBackingStore.width).toBe(
    Math.round(
      canvasBackingStore.cssWidth * canvasBackingStore.devicePixelRatio,
    ),
  );
  expect(canvasBackingStore.height).toBe(
    Math.round(
      canvasBackingStore.cssHeight * canvasBackingStore.devicePixelRatio,
    ),
  );
  const boundedRasterStore = {
    edgeWidth: Number(
      await graph.getAttribute('data-edge-raster-cache-pixel-width'),
    ),
    edgeHeight: Number(
      await graph.getAttribute('data-edge-raster-cache-pixel-height'),
    ),
    cardWidth: Number(
      await graph.getAttribute('data-card-raster-cache-pixel-width'),
    ),
    cardHeight: Number(
      await graph.getAttribute('data-card-raster-cache-pixel-height'),
    ),
  };
  const expectedRasterWidth = Math.round(
    (canvasBackingStore.cssWidth + 192) * canvasBackingStore.devicePixelRatio,
  );
  const expectedRasterHeight = Math.round(
    (canvasBackingStore.cssHeight + 192) * canvasBackingStore.devicePixelRatio,
  );
  expect(boundedRasterStore).toEqual({
    edgeWidth: expectedRasterWidth,
    edgeHeight: expectedRasterHeight,
    cardWidth: expectedRasterWidth,
    cardHeight: expectedRasterHeight,
  });
  await expect(page.getByTestId('connections-search')).toHaveCount(0);
  await expect(page.getByTestId('connections-expand')).toHaveCount(0);
  const fitScale = Number(await graph.getAttribute('data-camera-scale'));
  expect(fitScale).toBeGreaterThan(0);
  expect(fitScale).toBeLessThan(0.1);

  const focusStarted = performance.now();
  await pressConnectionsKey(graph, 'Home');
  await expect
    .poll(async () => Number(await graph.getAttribute('data-camera-scale')))
    .toBeGreaterThanOrEqual(0.5);
  await expect
    .poll(async () =>
      Number(await graph.getAttribute('data-visual-node-count')),
    )
    .toBeLessThan(10_000);
  await expect
    .poll(async () =>
      Number(await graph.getAttribute('data-visual-edge-count')),
    )
    .toBeLessThan(completeInput.edges.length);
  await expect
    .poll(async () =>
      Number(await graph.getAttribute('data-edge-draw-edge-count')),
    )
    .toBeLessThan(completeInput.edges.length);
  const focusReadyMs = performance.now() - focusStarted;
  const localizedCanvasDrawMs = Number(
    await graph.getAttribute('data-edge-draw-duration-ms'),
  );
  const localizedDom = await graph.evaluate((element) => ({
    descendants: element.querySelectorAll('*').length,
    cardButtons: element.querySelectorAll('button[data-card-id]').length,
    svgPaths: element.querySelectorAll('svg path').length,
    canvasCount: element.querySelectorAll('canvas').length,
  }));
  expect(localizedDom.cardButtons).toBeGreaterThan(0);
  expect(localizedDom.cardButtons).toBeLessThan(10_000);
  expect(localizedDom.svgPaths).toBe(0);
  expect(localizedDom.canvasCount).toBe(2);
  await testInfo.attach('connections-10k-canvas-localized.png', {
    body: await graph.screenshot(),
    contentType: 'image/png',
  });

  const beforeFitDrawCount = Number(
    await graph.getAttribute('data-edge-draw-count'),
  );
  const beforeFitCardDrawCount = Number(
    await graph.getAttribute('data-card-draw-count'),
  );
  const fitStarted = performance.now();
  await pressConnectionsKey(graph, '0');
  await expect
    .poll(async () => Number(await graph.getAttribute('data-edge-draw-count')))
    .toBeGreaterThan(beforeFitDrawCount);
  await expect(graph).toHaveAttribute(
    'data-edge-draw-edge-count',
    String(completeInput.edges.length),
  );
  await expect(graph).toHaveAttribute('data-visual-node-count', '10000');
  await expect
    .poll(async () => Number(await graph.getAttribute('data-card-draw-count')))
    .toBeGreaterThan(beforeFitCardDrawCount);
  await expect(graph).toHaveAttribute('data-node-renderer', 'overview-canvas');
  await expect(graph).toHaveAttribute('data-card-draw-node-count', '10000');
  await expect(graph.locator('button[data-card-id]')).toHaveCount(0);
  const fitReadyMs = performance.now() - fitStarted;
  const fullFitCanvasDrawMs = Number(
    await graph.getAttribute('data-edge-draw-duration-ms'),
  );
  const fullFitCardCanvasDrawMs = Number(
    await graph.getAttribute('data-card-draw-duration-ms'),
  );
  await testInfo.attach('connections-10k-canvas-full-fit.png', {
    body: await graph.screenshot(),
    contentType: 'image/png',
  });

  const fullFitContinuous = await graph.evaluate(async (element) => {
    const frameIntervals: number[] = [];
    const edgeDrawDurations: number[] = [];
    const cardDrawDurations: number[] = [];
    const longTasks: number[] = [];
    const observer =
      typeof PerformanceObserver === 'undefined'
        ? null
        : new PerformanceObserver((list) => {
            longTasks.push(...list.getEntries().map((entry) => entry.duration));
          });
    observer?.observe({ entryTypes: ['longtask'] });
    const before = {
      edgeRefresh: Number(element.dataset.edgeRasterRefreshCount ?? '0'),
      edgeReuse: Number(element.dataset.edgeRasterReuseCount ?? '0'),
      cardRefresh: Number(element.dataset.cardRasterRefreshCount ?? '0'),
      cardReuse: Number(element.dataset.cardRasterReuseCount ?? '0'),
      cameraX: Number(element.dataset.cameraX),
      cameraY: Number(element.dataset.cameraY),
    };
    const cameraPositions: { x: number; y: number }[] = [];
    let previousFrame = performance.now();
    for (let frame = 0; frame < 30; frame += 1) {
      const frameTime = await new Promise<number>((resolve) =>
        requestAnimationFrame((time) => resolve(time)),
      );
      frameIntervals.push(frameTime - previousFrame);
      previousFrame = frameTime;
      edgeDrawDurations.push(
        Number(element.dataset.edgeDrawDurationMs ?? Number.NaN),
      );
      cardDrawDurations.push(
        Number(element.dataset.cardDrawDurationMs ?? Number.NaN),
      );
      cameraPositions.push({
        x: Number(element.dataset.cameraX),
        y: Number(element.dataset.cameraY),
      });
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: frame % 2 === 0 ? 'ArrowRight' : 'ArrowLeft',
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    cameraPositions.push({
      x: Number(element.dataset.cameraX),
      y: Number(element.dataset.cameraY),
    });
    longTasks.push(
      ...(observer?.takeRecords() ?? []).map((entry) => entry.duration),
    );
    observer?.disconnect();
    const p95 = (values: readonly number[]) => {
      const finite = values
        .filter(Number.isFinite)
        .sort((left, right) => left - right);
      return finite[Math.floor((finite.length - 1) * 0.95)] ?? Number.NaN;
    };
    const after = {
      edgeRefresh: Number(element.dataset.edgeRasterRefreshCount ?? '0'),
      edgeReuse: Number(element.dataset.edgeRasterReuseCount ?? '0'),
      cardRefresh: Number(element.dataset.cardRasterRefreshCount ?? '0'),
      cardReuse: Number(element.dataset.cardRasterReuseCount ?? '0'),
      cameraX: Number(element.dataset.cameraX),
      cameraY: Number(element.dataset.cameraY),
    };
    const cameraDisplacements = cameraPositions.map((camera) =>
      Math.hypot(camera.x - before.cameraX, camera.y - before.cameraY),
    );
    return {
      frameP95Ms: p95(frameIntervals),
      maximumFrameMs: Math.max(0, ...frameIntervals),
      edgeDrawP95Ms: p95(edgeDrawDurations),
      cardDrawP95Ms: p95(cardDrawDurations),
      longTaskCount: longTasks.length,
      longestTaskMs: Math.max(0, ...longTasks),
      samples: frameIntervals.length,
      edgeRefreshCount: after.edgeRefresh - before.edgeRefresh,
      edgeReuseCount: after.edgeReuse - before.edgeReuse,
      cardRefreshCount: after.cardRefresh - before.cardRefresh,
      cardReuseCount: after.cardReuse - before.cardReuse,
      finalEdgeStrategy: element.dataset.edgeDrawStrategy ?? null,
      finalCardStrategy: element.dataset.cardDrawStrategy ?? null,
      maximumCameraDisplacementPx: Math.max(0, ...cameraDisplacements),
      uniqueCameraPositions: new Set(
        cameraPositions.map((camera) => `${camera.x}:${camera.y}`),
      ).size,
      returnedToOriginPx: Math.hypot(
        after.cameraX - before.cameraX,
        after.cameraY - before.cameraY,
      ),
    };
  });
  console.info(
    `connections-10k-full-fit-continuous ${JSON.stringify({ project: testInfo.project.name, ...fullFitContinuous })}`,
  );
  expect(fullFitContinuous.samples).toBe(30);
  expect(Number.isFinite(fullFitContinuous.frameP95Ms)).toBe(true);
  expect(fullFitContinuous.frameP95Ms).toBeLessThanOrEqual(50);
  expect(fullFitContinuous.edgeRefreshCount).toBeLessThanOrEqual(1);
  expect(fullFitContinuous.cardRefreshCount).toBeLessThanOrEqual(1);
  expect(fullFitContinuous.edgeReuseCount).toBeGreaterThanOrEqual(28);
  expect(fullFitContinuous.cardReuseCount).toBeGreaterThanOrEqual(28);
  expect(fullFitContinuous.maximumCameraDisplacementPx).toBeGreaterThanOrEqual(
    63,
  );
  expect(fullFitContinuous.uniqueCameraPositions).toBeGreaterThanOrEqual(2);
  expect(fullFitContinuous.returnedToOriginPx).toBeLessThanOrEqual(1);

  const fullFitBeyondCache = await graph.evaluate(async (element) => {
    const frameIntervals: number[] = [];
    const edgeRasterDurations: number[] = [];
    const cardRasterDurations: number[] = [];
    const before = {
      x: Number(element.dataset.cameraX),
      y: Number(element.dataset.cameraY),
      edgeRefresh: Number(element.dataset.edgeRasterRefreshCount ?? '0'),
      cardRefresh: Number(element.dataset.cardRasterRefreshCount ?? '0'),
      edgeWidth: Number(element.dataset.edgeRasterCachePixelWidth),
      edgeHeight: Number(element.dataset.edgeRasterCachePixelHeight),
      cardWidth: Number(element.dataset.cardRasterCachePixelWidth),
      cardHeight: Number(element.dataset.cardRasterCachePixelHeight),
    };
    let previousFrame = performance.now();
    for (let frame = 0; frame < 8; frame += 1) {
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          bubbles: true,
          cancelable: true,
        }),
      );
      const frameTime = await new Promise<number>((resolve) =>
        requestAnimationFrame((time) => resolve(time)),
      );
      frameIntervals.push(frameTime - previousFrame);
      previousFrame = frameTime;
      edgeRasterDurations.push(
        Number(element.dataset.edgeRasterRenderDurationMs ?? Number.NaN),
      );
      cardRasterDurations.push(
        Number(element.dataset.cardRasterRenderDurationMs ?? Number.NaN),
      );
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const p95 = (values: readonly number[]) => {
      const finite = values
        .filter(Number.isFinite)
        .sort((left, right) => left - right);
      return finite[Math.floor((finite.length - 1) * 0.95)] ?? Number.NaN;
    };
    const after = {
      x: Number(element.dataset.cameraX),
      y: Number(element.dataset.cameraY),
      edgeRefresh: Number(element.dataset.edgeRasterRefreshCount ?? '0'),
      cardRefresh: Number(element.dataset.cardRasterRefreshCount ?? '0'),
      edgeWidth: Number(element.dataset.edgeRasterCachePixelWidth),
      edgeHeight: Number(element.dataset.edgeRasterCachePixelHeight),
      cardWidth: Number(element.dataset.cardRasterCachePixelWidth),
      cardHeight: Number(element.dataset.cardRasterCachePixelHeight),
    };
    return {
      frameP95Ms: p95(frameIntervals),
      maximumFrameMs: Math.max(0, ...frameIntervals),
      edgeRasterP95Ms: p95(edgeRasterDurations),
      cardRasterP95Ms: p95(cardRasterDurations),
      cameraDelta: { x: after.x - before.x, y: after.y - before.y },
      edgeRefreshCount: after.edgeRefresh - before.edgeRefresh,
      cardRefreshCount: after.cardRefresh - before.cardRefresh,
      rasterDimensionsStable:
        before.edgeWidth === after.edgeWidth &&
        before.edgeHeight === after.edgeHeight &&
        before.cardWidth === after.cardWidth &&
        before.cardHeight === after.cardHeight,
    };
  });
  console.info(
    `connections-10k-beyond-cache-pan ${JSON.stringify({ project: testInfo.project.name, ...fullFitBeyondCache })}`,
  );
  expect(fullFitBeyondCache.cameraDelta.x).toBeCloseTo(-512, 5);
  expect(fullFitBeyondCache.cameraDelta.y).toBeCloseTo(0, 5);
  expect(fullFitBeyondCache.edgeRefreshCount).toBeGreaterThan(0);
  expect(fullFitBeyondCache.cardRefreshCount).toBeGreaterThan(0);
  expect(fullFitBeyondCache.rasterDimensionsStable).toBe(true);
  expect(Number.isFinite(fullFitBeyondCache.frameP95Ms)).toBe(true);
  expect(Number.isFinite(fullFitBeyondCache.edgeRasterP95Ms)).toBe(true);
  expect(Number.isFinite(fullFitBeyondCache.cardRasterP95Ms)).toBe(true);

  await pressConnectionsKey(graph, 'Home');
  await expect
    .poll(async () => Number(await graph.getAttribute('data-camera-scale')))
    .toBeGreaterThanOrEqual(0.5);

  const nextCard = graph.locator('button[data-card-id][aria-current="true"]');
  const nextCardId = await nextCard.getAttribute('data-card-id');
  if (!nextCardId) throw new Error('Complete graph omitted its current card');
  await nextCard.click();
  await expectPathname(page, `/cards/${nextCardId}`);
  const reentryStarted = performance.now();
  await page.getByRole('button', { name: 'つながり', exact: true }).click();
  await expectPathname(page, `/cards/${nextCardId}/connections`);
  await expect(graph).toHaveAttribute('data-total-node-count', '10000');
  await expect(graph).toHaveAttribute('data-edge-render-status', 'painted');
  await expect(graph).toHaveAttribute('data-card-render-status', 'painted');
  await expect(graph.locator('button[data-card-id]')).toHaveCount(0);
  const reentryReadyMs = performance.now() - reentryStarted;
  const dom = await graph.evaluate((element) => ({
    descendants: element.querySelectorAll('*').length,
    cardButtons: element.querySelectorAll('button[data-card-id]').length,
    svgPaths: element.querySelectorAll('svg path').length,
    canvasCount: element.querySelectorAll('canvas').length,
  }));
  expect(dom.svgPaths).toBe(0);
  expect(dom.canvasCount).toBe(2);
  const artifact = {
    schemaVersion: 5,
    issues: [325, 327, 329, 330, 331],
    project: testInfo.project.name,
    environment: {
      browser: page.context().browser()?.version() ?? 'unknown',
      viewport: page.viewportSize(),
      devicePixelRatio: await page.evaluate(() => window.devicePixelRatio),
    },
    fixture: { nodes: cards.length, source: 'client-performance' },
    comparison:
      'Complete product graph in the expanded residual-height workspace with viewport keyboard input, free camera translation, windowed HTML cards, no semantic list or map toolbar UI, and bounded overview Canvas bitmap reuse for cards and edges',
    initialReadyMs,
    layoutReadyMs,
    focusReadyMs,
    fitReadyMs,
    reentryReadyMs,
    canvas: {
      initialPrepareMs: initialCanvasPrepareMs,
      initialDrawMs: initialCanvasDrawMs,
      initialRasterRenderMs: initialEdgeRasterRenderMs,
      localizedDrawMs: localizedCanvasDrawMs,
      fullFitDrawMs: fullFitCanvasDrawMs,
      backingStore: canvasBackingStore,
      boundedRasterStore,
    },
    cardCanvas: {
      initialDrawMs: initialCardCanvasDrawMs,
      initialRasterRenderMs: initialCardRasterRenderMs,
      fullFitDrawMs: fullFitCardCanvasDrawMs,
    },
    browserPipeline: {
      visibilityQueryMs: initialVisibilityQueryMs,
      nodeCommitMs: initialNodeCommitMs,
    },
    fullFitContinuous,
    fullFitBeyondCache,
    completeGraph: {
      nodes: completeInput.nodes.length,
      edges: completeInput.edges.length,
      fitScale,
    },
    semanticListUiPresent:
      (await page.getByTestId('connections-semantic-lists').count()) > 0,
    localizedDom,
    dom,
    heapUsedBytes: await browserHeapUsed(page),
    policy:
      'Observational browser evidence for the complete product graph. No timing sample is removed and no absolute CI wall-clock gate is inferred from this single run.',
  };
  console.info(
    `connections-10k-full-network-browser ${JSON.stringify(artifact)}`,
  );
  await testInfo.attach('connections-10k-full-network-browser.json', {
    body: Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`),
    contentType: 'application/json',
  });
});

test('ELK failure retries the same complete graph through corridor', async ({
  page,
}, testInfo) => {
  const cardA = '01991f20-61d2-7000-8000-000000000613';
  const cardB = '01991f20-61d2-7000-8000-000000000614';
  const suffix = unique('elk-corridor-fallback', testInfo.project.name);
  const cardATitle = `代替配置A ${suffix}`;
  const cardBTitle = `代替配置B ${suffix}`;
  await forceConnectionsElkLayoutFailure(page);
  await serveSyncCards(page, [
    {
      id: cardA,
      displayId: { kind: 'official', value: 13 },
      title: cardATitle,
      body: [{ type: 'link', targetCardId: cardB }],
      createdAt: 13,
      updatedAt: 13,
      localRevision: 1,
      serverRevision: 1,
    },
    {
      id: cardB,
      displayId: { kind: 'official', value: 14 },
      title: cardBTitle,
      body: [],
      createdAt: 14,
      updatedAt: 14,
      localRevision: 1,
      serverRevision: 1,
    },
  ]);

  const response = await page.goto(`/cards/${cardA}/connections`);
  expect(response?.status()).toBe(200);
  const graph = page.getByTestId('connections-graph');
  await expect(graph).toHaveAttribute('data-layout-status', 'ready', {
    timeout: 15_000,
  });
  await expect(graph).toHaveAttribute('data-total-node-count', '2');
  await expect(graph).toHaveAttribute('data-total-edge-count', '1');
  await expect(graph).toHaveAttribute('data-visual-node-count', '2');
  await expect(graph).toHaveAttribute('data-edge-draw-edge-count', '1');
  await expect(page.getByTestId('connections-semantic-lists')).toHaveCount(0);
});

test('all layout engine failure leaves app navigation available', async ({
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
  await expect(graph.locator('button[data-card-id]')).toHaveCount(0);
  await expect(page.getByTestId('connections-semantic-lists')).toHaveCount(0);
  await page.getByRole('button', { name: '過去のカード', exact: true }).click();
  const fallbackCard = page
    .getByTestId('history-list')
    .locator(`[data-card-id="${cardB}"]`);
  await fallbackCard.click();
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
  await expect(page.getByTestId('connections-semantic-lists')).toHaveCount(0);
  await pressConnectionsKey(graph, 'Home');
  await expect(graph).toHaveAttribute('data-node-renderer', 'html');
  await expect(
    graph.locator(`button[data-card-id="${ids.cardB}"]`),
  ).toHaveAttribute('aria-current', 'true');
  const linkedMapCard = graph.locator(`button[data-card-id="${ids.cardC}"]`);
  await linkedMapCard.focus();
  await expectMapNodeFullyVisible(linkedMapCard, graph);
  await linkedMapCard.press('Enter');
  await expectPathname(page, `/cards/${ids.cardC}`);
  await expect(page.getByTestId('card-title')).toHaveValue(titles.cardC);

  const historyLength = await page.evaluate(() => window.history.length);
  await page.goBack();
  await expectPathname(page, `/cards/${ids.cardB}/connections`);
  await expect(page.locator('section[aria-label="つながり"]')).toBeVisible();
  await pressConnectionsKey(graph, 'Home');
  await expect(
    graph.locator(`button[data-card-id="${ids.cardB}"]`),
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
  await expect(page.locator('section[aria-label="つながり"]')).toBeVisible();
  await page.reload();
  await expectPathname(page, `/cards/${ids.cardB}/connections`);
  await expect(page.getByTestId('connections-semantic-lists')).toHaveCount(0);
  await expect(graph).toHaveAttribute('data-layout-status', 'ready', {
    timeout: 15_000,
  });
  await expect(graph).toHaveAttribute('data-camera-scale', /\d/, {
    timeout: 5_000,
  });
  await pressConnectionsKey(graph, 'Home');
  await expect(
    page
      .getByTestId('connections-graph')
      .locator(`button[data-card-id="${ids.cardB}"]`),
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

test('current input resolves every visible conflict from the notice close action', async ({
  page,
}) => {
  const cardId = fixtureCardId('e2e-current-conflict-card');
  const firstConflictId = fixtureConflictId('e2e-current-conflict-first');
  const secondConflictId = fixtureConflictId('e2e-current-conflict-second');
  const currentTitle = '現在入力を最終内容として残す';
  let resolved = false;
  let observedConflictIds: readonly string[] = [];
  await page.route('**/api/sync', async (route) => {
    const request = decodeSyncRequest(route.request().postDataJSON());
    const resolveMutation = request.mutations.find(
      (mutation) => mutation.kind === 'resolve',
    );
    if (resolveMutation) {
      observedConflictIds = resolveMutation.conflictIds;
      resolved = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          cards: [
            {
              id: cardId,
              officialDisplayId: 29,
              title: resolveMutation.title,
              body: resolveMutation.body,
              createdAt: 1,
              updatedAt: resolveMutation.updatedAt,
              revision: 4,
            },
          ],
          conflicts: [],
          acknowledgedMutationIds: [resolveMutation.mutationId],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cards: [
          {
            id: cardId,
            officialDisplayId: 29,
            title: resolved ? currentTitle : '同期済みの現在カード',
            body: [],
            createdAt: 1,
            updatedAt: resolved ? 4 : 3,
            revision: resolved ? 4 : 3,
          },
        ],
        conflicts: resolved
          ? []
          : [
              {
                id: firstConflictId,
                cardId,
                serverRevision: 1,
                localTitle: '編集案A-1',
                localBody: [],
                serverTitle: '編集案B-1',
                serverBody: [],
                createdAt: 2,
              },
              {
                id: secondConflictId,
                cardId,
                serverRevision: 2,
                localTitle: '編集案A-2',
                localBody: [],
                serverTitle: '編集案B-2',
                serverBody: [],
                createdAt: 3,
              },
            ],
        acknowledgedMutationIds: [],
      }),
    });
  });

  const response = await page.goto(`/cards/${cardId}`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('alert')).toHaveCount(2);
  await page.getByTestId('card-title').fill(currentTitle);
  await expect(page.getByTestId('save-sync-status')).toHaveText('保存済み');

  await page
    .getByRole('button', {
      name: '現在の入力を残して競合案を破棄',
    })
    .first()
    .click();
  await expect(
    page.getByText('選んだ内容で競合を解決しています。').first(),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0, { timeout: 15_000 });
  expect(observedConflictIds).toEqual([firstConflictId, secondConflictId]);
  await expect(page.getByTestId('card-title')).toHaveValue(currentTitle);

  await page.reload();
  await expect(page.getByTestId('card-title')).toHaveValue(currentTitle);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

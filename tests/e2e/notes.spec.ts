import { expect, test, type Locator, type Page } from '@playwright/test';
import { CONNECTIONS_ZOOM_PREFERENCE_KEY } from '@/lib/client/connections-zoom-preference';
import { connectionsBenchmarkFixtures } from '@/tests/fixtures/connections-layout';
import { fixtureCardId } from '@/tests/fixtures/ids';

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

async function forceConnectionsLayoutFailure(page: Page) {
  await page.route('**/_next/static/chunks/notes-app-*.js', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const layoutInvocation =
      /let ([\w$]+)=([\w$]+)\(([\w$]+)\),([\w$]+)=await ([\w$]+)\.layout\(([\w$]+)\(\3,\1,([\w$]+),([\w$]+)\)\)/;
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

async function expectMapNodeFullyVisible(node: Locator, graph: Locator) {
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
}

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
  await expect(graph.locator('button[data-card-id]')).toHaveCount(7);
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
  await expect(currentNode).toContainText('現在');
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
    return {
      touchAction: style.touchAction,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      viewportHeight: element.clientHeight,
      windowHeight: window.innerHeight,
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

test('connections map supports controls, keyboard, touch gestures and drag-safe selection', async ({
  page,
  context,
}, testInfo) => {
  const cards = largeConnectionsBenchmarkCards();
  const current = cards[0];
  const target = cards[1];
  if (!current || !target)
    throw new Error('Large camera fixture is incomplete');
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

  const fitButton = page.getByRole('button', { name: '全体表示' });
  const currentButton = page.getByRole('button', {
    name: '現在のカードへ戻る',
  });
  const zoomInButton = page.getByRole('button', { name: '拡大' });
  const zoomOutButton = page.getByRole('button', { name: '縮小' });
  const keyboardControl = page.getByRole('button', {
    name: 'キーボードでマップを操作',
  });
  const fitted = await connectionsCamera(graph);
  for (const control of [
    fitButton,
    currentButton,
    zoomInButton,
    keyboardControl,
  ]) {
    await expect(control).toBeVisible();
    await expect(control).toBeEnabled();
  }
  await expect(zoomOutButton).toBeVisible();
  await expect(fitButton).toHaveText('全体');
  await expect(currentButton).toHaveText('現在地');
  await expect(keyboardControl).toHaveText('操作');
  await expect(zoomOutButton).toHaveText('−');
  await expect(zoomInButton).toHaveText('＋');
  if (fitted.scale <= 0.100_000_1) await expect(zoomOutButton).toBeDisabled();
  else await expect(zoomOutButton).toBeEnabled();
  for (const value of Object.values(fitted)) {
    expect(Number.isFinite(value)).toBe(true);
  }
  const currentNode = graph
    .getByRole('button')
    .filter({ hasText: current.title });
  const zoomOutput = page.getByRole('status', { name: '現在のズーム' });
  await expect(zoomOutput).toHaveText(`${Math.round(fitted.scale * 100)}%`);
  expect(fitted.scale).toBeGreaterThanOrEqual(0.1);
  expect(fitted.scale).toBeLessThanOrEqual(2);
  await expect(currentNode).toBeInViewport();
  await expectMapNodeFullyVisible(currentNode, graph);
  await zoomInButton.click();
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeGreaterThan(fitted.scale);
  const explicitlyZoomed = await connectionsCamera(graph);
  await zoomOutButton.click();
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
  await expect(zoomInButton).toBeDisabled();
  await expect(zoomOutButton).toBeEnabled();
  await expect(zoomOutput).toHaveText('200%');
  await expect
    .poll(async () =>
      Number(
        await zoomInButton.evaluate(
          (element) => getComputedStyle(element).opacity,
        ),
      ),
    )
    .toBeCloseTo(0.35, 2);
  const maximumControlStyle = await zoomInButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      opacity: Number(style.opacity),
      pointerEvents: style.pointerEvents,
    };
  });
  expect(maximumControlStyle.opacity).toBeCloseTo(0.35, 2);
  expect(maximumControlStyle.pointerEvents).toBe('none');

  const originalViewport = page.viewportSize();
  if (!originalViewport) throw new Error('Browser viewport is unavailable');
  await page.setViewportSize({
    width: originalViewport.width - 20,
    height: originalViewport.height - 20,
  });
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeCloseTo(2, 7);
  await expect(zoomInButton).toBeDisabled();
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
    .toBeCloseTo(0.1, 7);
  await expect(zoomOutButton).toBeDisabled();
  await expect(zoomOutput).toHaveText('10%');
  await expect
    .poll(async () =>
      Number(
        await zoomOutButton.evaluate(
          (element) => getComputedStyle(element).opacity,
        ),
      ),
    )
    .toBeCloseTo(0.35, 2);
  const minimumControlStyle = await zoomOutButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      opacity: Number(style.opacity),
      pointerEvents: style.pointerEvents,
    };
  });
  expect(minimumControlStyle.opacity).toBeCloseTo(0.35, 2);
  expect(minimumControlStyle.pointerEvents).toBe('none');

  await fitButton.click();
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeCloseTo(fitted.scale, 5);
  await keyboardControl.focus();
  await keyboardControl.press('+');
  await keyboardControl.press('+');
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeGreaterThan(fitted.scale);
  const beforeKeyboardPan = await connectionsCamera(graph);
  await keyboardControl.press('ArrowRight');
  await page.waitForTimeout(50);
  let afterKeyboardPan = await connectionsCamera(graph);
  if (afterKeyboardPan.x === beforeKeyboardPan.x) {
    await keyboardControl.press('ArrowLeft');
    await page.waitForTimeout(50);
    afterKeyboardPan = await connectionsCamera(graph);
  }
  expect(afterKeyboardPan.x).not.toBe(beforeKeyboardPan.x);
  await keyboardControl.press('0');
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeCloseTo(fitted.scale, 5);
  if (fitted.scale <= 0.100_000_1) await expect(zoomOutButton).toBeDisabled();
  else await expect(zoomOutButton).toBeEnabled();
  await expect(zoomOutput).toHaveText(`${Math.round(fitted.scale * 100)}%`);

  await zoomInButton.click();
  await zoomInButton.click();
  const viewportBox = await graph.boundingBox();
  if (!viewportBox) throw new Error('Connections viewport has no geometry');
  const center = {
    x: viewportBox.x + viewportBox.width / 2,
    y: viewportBox.y + viewportBox.height / 2,
  };
  const touch = await context.newCDPSession(page);
  const outsideTouchAction = await page
    .getByRole('heading', { name: 'つながり' })
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
      nodeCount: canvas?.querySelectorAll('[data-card-id]').length ?? -1,
      pathData: [...(canvas?.querySelectorAll('path[d]') ?? [])].map((path) =>
        path.getAttribute('d'),
      ),
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
  await expect(zoomInButton).toBeDisabled();
  await expect(zoomOutput).toHaveText('200%');

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
      nodeCount: canvas?.querySelectorAll('[data-card-id]').length ?? -1,
      pathData: [...(canvas?.querySelectorAll('path[d]') ?? [])].map((path) =>
        path.getAttribute('d'),
      ),
    };
  });
  expect(canvasAfterGesture).toEqual(canvasBeforeGesture);

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

  await currentButton.click();
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
    for (let frame = 0; frame < 120; frame += 1) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
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
    const p95Index = Math.floor((durations.length - 1) * 0.95);
    return {
      durationMs: performance.now() - started,
      handlerP95Ms: durations[p95Index] ?? Number.NaN,
      longTaskCount: longTasks.length,
      longestTaskMs: Math.max(0, ...longTasks),
      transformWrites:
        Number(element.dataset.cameraRenderCount ?? '0') - startingRenderCount,
    };
  });
  expect(gesturePerformance.durationMs).toBeGreaterThan(1_500);
  expect(Number.isFinite(gesturePerformance.handlerP95Ms)).toBe(true);
  expect(gesturePerformance.transformWrites).toBeLessThanOrEqual(122);
  console.info(
    `connections-gesture-benchmark ${JSON.stringify({ project: testInfo.project.name, ...gesturePerformance })}`,
  );
  await testInfo.attach('connections-gesture-benchmark.json', {
    body: Buffer.from(`${JSON.stringify(gesturePerformance, null, 2)}\n`),
    contentType: 'application/json',
  });

  await page.waitForTimeout(400);
  const targetNode = graph
    .getByRole('button')
    .filter({ hasText: target.title });
  await targetNode.focus();
  await page.waitForTimeout(100);
  await expect(targetNode).toBeInViewport();
  await expectMapNodeFullyVisible(targetNode, graph);
  await expect(graph).toHaveAttribute('data-active-pointers', '0');
  await expect(graph).toHaveAttribute('data-click-suppression', 'false');
  await expect(graph).toHaveAttribute('data-dragging', 'false');
  if (testInfo.project.name === 'mobile-chromium') await targetNode.tap();
  else await targetNode.click();
  await touch.detach();
  await expectPathname(page, `/cards/${target.id}`);
  await expect(page.getByTestId('card-title')).toHaveValue(target.title);
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
  const fitted = await connectionsCamera(graph);
  await page.getByRole('button', { name: '拡大' }).click();
  await page.getByRole('button', { name: '拡大' }).click();
  await expect
    .poll(async () => (await connectionsCamera(graph)).scale)
    .toBeGreaterThan(fitted.scale);
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
  await expect(page.getByRole('status', { name: '現在のズーム' })).toHaveText(
    `${Math.round(preferredScale * 100)}%`,
  );

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
  await expect(page.getByRole('button', { name: '拡大' })).toBeDisabled();
  await expect(page.getByRole('status', { name: '現在のズーム' })).toHaveText(
    '200%',
  );

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
  await expect(page.getByRole('button', { name: '縮小' })).toBeDisabled();
  await expect(page.getByRole('status', { name: '現在のズーム' })).toHaveText(
    '10%',
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
}) => {
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
  await expect(historyItems).toHaveCount(12, { timeout: 15_000 });
  expect(
    await historyItems.evaluateAll((items) =>
      items.map((item) => Number(item.getAttribute('data-display-value'))),
    ),
  ).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  const currentItem = historyList.locator('[data-current=true]');
  await expect(currentItem).toHaveAttribute('aria-current', 'page', {
    timeout: 15_000,
  });
  await expect(currentItem).toContainText('現在');

  const layout = await page.evaluate(() => {
    const header = document.querySelector('header');
    const heading = document.querySelector('#history-heading');
    const list = document.querySelector('[data-testid="history-list"]');
    const current = list?.querySelector('[data-current="true"]');
    const navigation = document.querySelector('.app-navigation');
    if (!header || !heading || !list || !current || !navigation) {
      throw new Error('history layout elements are missing');
    }

    return {
      scrollY: window.scrollY,
      headerTop: header.getBoundingClientRect().top,
      headerBottom: header.getBoundingClientRect().bottom,
      headingTop: heading.getBoundingClientRect().top,
      listTop: list.getBoundingClientRect().top,
      listBottom: list.getBoundingClientRect().bottom,
      currentTop: current.getBoundingClientRect().top,
      currentBottom: current.getBoundingClientRect().bottom,
      navigationTop: navigation.getBoundingClientRect().top,
      navigationBottom: navigation.getBoundingClientRect().bottom,
    };
  });

  expect(layout.scrollY).toBe(0);
  expect(layout.headingTop).toBeGreaterThanOrEqual(layout.headerBottom);
  expect(layout.navigationTop).toBeGreaterThanOrEqual(layout.headerTop);
  expect(layout.navigationBottom).toBeLessThanOrEqual(layout.headerBottom);
  expect(layout.currentTop).toBeGreaterThanOrEqual(layout.listTop);
  expect(layout.currentBottom).toBeLessThanOrEqual(layout.listBottom);
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

test('C2 keeps the editor, history and connections usable at 320px', async ({
  page,
}) => {
  const card: LocalFixtureCard = {
    id: '01991f20-61d2-7000-8000-000000000702',
    displayId: { kind: 'official', value: 1042 },
    title: '考えを小さく残す',
    body: [],
    createdAt: 1,
    updatedAt: 1,
    localRevision: 1,
    serverRevision: 1,
  };
  await page.setViewportSize({ width: 320, height: 900 });
  await serveSyncCards(page, [card]);
  const response = await page.goto(`/cards/${card.id}`);
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId('card-title')).toHaveValue(card.title);

  const expectNoDocumentOverflow = async () => {
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  };
  const expectVisibleTargetsAtLeast44px = async () => {
    const targetSizes = await page
      .locator('button:visible')
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const bounds = button.getBoundingClientRect();
          return { width: bounds.width, height: bounds.height };
        }),
      );
    expect(targetSizes.length).toBeGreaterThan(0);
    for (const target of targetSizes) {
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
    }
  };

  await expect(page.locator('.c2-card-layout > .c2-manuscript')).toHaveCount(1);
  await expect(page.getByText('本文にあるリンク', { exact: true })).toHaveCount(
    0,
  );
  await expectNoDocumentOverflow();
  await expectVisibleTargetsAtLeast44px();

  await page.getByRole('button', { name: '過去のカード', exact: true }).click();
  await expect(page.getByTestId('history-list')).toBeVisible();
  await expectNoDocumentOverflow();
  await expectVisibleTargetsAtLeast44px();

  await page.getByRole('button', { name: 'つながり', exact: true }).click();
  await expect(page.getByTestId('connections-graph')).toHaveAttribute(
    'data-layout-status',
    'ready',
    { timeout: 15_000 },
  );
  await expectNoDocumentOverflow();
  await expectVisibleTargetsAtLeast44px();
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

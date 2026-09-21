import { expect, test, type Page } from '@playwright/test';
import { fixtureCardId, fixtureConflictId } from '@/tests/fixtures/ids';

type DesignTokenCard = {
  id: string;
  displayId: number;
  title: string;
  body: (
    | { type: 'text'; text: string }
    | { type: 'link'; targetCardId: string }
  )[];
  createdAt: number;
  updatedAt: number;
};

function designTokenCards(): DesignTokenCard[] {
  const ids = Array.from({ length: 13 }, (_, index) =>
    fixtureCardId(`design-token-card-${index + 1}`),
  );
  return ids.map((id, index) => ({
    id,
    displayId: index + 1,
    title: `共通トークン検証カード ${index + 1} — 長い日本語でも操作と表示を維持する`,
    body: [
      {
        type: 'text',
        text: `本文 ${index + 1}。共通本文色、紙面、折り返し、フォーカス、Canvasとの一貫性を検証する。`,
      },
      { type: 'link', targetCardId: ids[(index + 1) % ids.length] ?? id },
    ],
    createdAt: index + 1,
    updatedAt: index + 1,
  }));
}

async function serveDesignTokenFixture(page: Page, cards: DesignTokenCard[]) {
  const current = cards[0];
  if (!current) throw new Error('Design-token fixture must contain a card');
  await page.route('**/api/sync', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cards: cards.map((card) => ({
          id: card.id,
          officialDisplayId: card.displayId,
          title: card.title,
          body: card.body,
          createdAt: card.createdAt,
          updatedAt: card.updatedAt,
          revision: 1,
        })),
        conflicts: [
          {
            id: fixtureConflictId('design-token-conflict'),
            cardId: current.id,
            serverRevision: 1,
            localTitle: '端末側の長い日本語編集案',
            localBody: current.body,
            serverTitle: '同期先の長い日本語編集案',
            serverBody: current.body,
            createdAt: 14,
          },
        ],
        acknowledgedMutationIds: [],
      }),
    });
  });
}

test('shared light tokens reach editor, warning, navigation, DOM and Canvas', async ({
  page,
}, testInfo) => {
  await page.setViewportSize(
    testInfo.project.name === 'mobile-chromium'
      ? { width: 412, height: 915 }
      : { width: 1440, height: 900 },
  );
  const cards = designTokenCards();
  const currentCard = cards[0];
  if (!currentCard) throw new Error('Design-token fixture is empty');
  await serveDesignTokenFixture(page, cards);
  await page.goto(`/cards/${currentCard.id}`);
  const newCard = page.getByTestId('new-card');
  await expect(newCard).toBeVisible();
  const conflict = page.getByRole('alert');
  await expect(conflict).toBeVisible();

  const light = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    return {
      userAgent: navigator.userAgent,
      language: document.documentElement.lang,
      rootClass: document.documentElement.className,
      viewport: { width: innerWidth, height: innerHeight },
      textPrimary: root.getPropertyValue('--fukamu-color-text-primary').trim(),
      foreground: root.getPropertyValue('--foreground').trim(),
      surfaceDefault: root
        .getPropertyValue('--fukamu-color-surface-default')
        .trim(),
      card: root.getPropertyValue('--card').trim(),
      actionPrimary: root
        .getPropertyValue('--fukamu-color-action-primary')
        .trim(),
      primary: root.getPropertyValue('--primary').trim(),
      actionHover: root
        .getPropertyValue('--fukamu-color-action-primary-hover')
        .trim(),
      primaryHover: root.getPropertyValue('--primary-hover').trim(),
      focus: root.getPropertyValue('--fukamu-color-focus-ring').trim(),
      ring: root.getPropertyValue('--ring').trim(),
      border: root.getPropertyValue('--border').trim(),
      bodyFont: body.fontFamily,
      bodyBackground: body.backgroundColor,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  expect(light).toMatchObject({
    language: 'ja',
    rootClass: '',
    viewport:
      testInfo.project.name === 'mobile-chromium'
        ? { width: 412, height: 915 }
        : { width: 1440, height: 900 },
    textPrimary: '#10233f',
    foreground: '#10233f',
    surfaceDefault: '#fff',
    card: '#fff',
    actionPrimary: '#0d3b8e',
    primary: '#0d3b8e',
    actionHover: '#082b69',
    primaryHover: '#082b69',
    focus: '#4a90e2',
    ring: '#4a90e2',
    border: '#ccdaec',
  });
  expect(light.bodyFont).toContain('Hiragino Kaku Gothic ProN');
  expect(light.bodyBackground).not.toBe('rgb(255, 255, 255)');
  expect(light.scrollWidth).toBe(light.viewport.width);

  await expect(newCard).toHaveCSS('background-color', 'rgb(13, 59, 142)');
  if (testInfo.project.name === 'chromium') {
    await newCard.hover();
    await expect(newCard).toHaveCSS('background-color', 'rgb(8, 43, 105)');
  }
  await expect(conflict).toHaveCSS('background-color', 'rgb(255, 247, 219)');
  await expect(conflict).toHaveCSS('border-color', 'rgb(234, 217, 158)');
  await expect(conflict).toHaveCSS('color', 'rgb(113, 81, 10)');
  await testInfo.attach(`design-tokens-card-${testInfo.project.name}`, {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  await page.getByRole('button', { name: '過去のカード', exact: true }).click();
  const history = page.getByTestId('history-list');
  await expect(history).toHaveAttribute('data-history-total-count', '13');
  await expect(history.getByRole('listitem').first()).toContainText(
    '共通トークン検証カード',
  );

  await page.getByRole('button', { name: 'つながり', exact: true }).click();
  const graph = page.getByTestId('connections-graph');
  await expect(graph).toHaveAttribute('data-layout-status', 'ready');
  await expect(graph).toHaveAttribute('data-total-node-count', '13');
  await expect(graph).toHaveAttribute('data-total-edge-count', '13');
  const graphTokens = await graph.evaluate((element) => {
    const style = getComputedStyle(element);
    const root = getComputedStyle(document.documentElement);
    return {
      actionPrimary: root.getPropertyValue('--primary').trim(),
      graphPrimary: style.getPropertyValue('--primary').trim(),
      commonAccent: root.getPropertyValue('--fukamu-color-accent').trim(),
      graphCard: style.getPropertyValue('--card').trim(),
      commonCard: root
        .getPropertyValue('--fukamu-color-surface-default')
        .trim(),
      graphBorder: style.getPropertyValue('--border').trim(),
      commonBorder: root
        .getPropertyValue('--fukamu-color-border-default')
        .trim(),
    };
  });
  expect(graphTokens).toEqual({
    actionPrimary: '#0d3b8e',
    graphPrimary: '#4a90e2',
    commonAccent: '#4a90e2',
    graphCard: '#fff',
    commonCard: '#fff',
    graphBorder: '#ccdaec',
    commonBorder: '#ccdaec',
  });

  const edgeCanvas = page.getByTestId('connections-edge-canvas');
  const paintedPixels = await edgeCanvas.evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) {
      throw new Error('Connections edge layer must be a canvas');
    }
    const context = element.getContext('2d');
    if (!context) throw new Error('Connections edge context is unavailable');
    const pixels = context.getImageData(0, 0, element.width, element.height);
    let painted = 0;
    for (let index = 3; index < pixels.data.length; index += 16 * 4) {
      if ((pixels.data[index] ?? 0) > 0) painted += 1;
    }
    return painted;
  });
  expect(paintedPixels).toBeGreaterThan(0);

  const edgeDrawBeforeThemeFixture = Number(
    await graph.getAttribute('data-edge-draw-count'),
  );
  await page
    .locator('html')
    .evaluate((element) => element.classList.add('dark'));
  await expect
    .poll(async () => Number(await graph.getAttribute('data-edge-draw-count')))
    .toBeGreaterThan(edgeDrawBeforeThemeFixture);
  await expect(graph).toHaveCSS('--primary', '#4a90e2');
  await page
    .locator('html')
    .evaluate((element) => element.classList.remove('dark'));
  await testInfo.attach(`design-tokens-connections-${testInfo.project.name}`, {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

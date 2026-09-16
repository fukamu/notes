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
          new URL('./fixtures/full-network-camera-harness.ts', import.meta.url),
        ),
        name: 'FukamuFullNetworkCameraHarness',
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
  throw new Error('full-network camera browser harness bundle is missing');
}

async function nodePoint(page: Page, index: number) {
  return page.evaluate(
    (nodeIndex) => window.__fukamuFullNetworkCameraHarness.nodePoint(nodeIndex),
    index,
  );
}

test('explicit camera actions preserve same-session position across routes and offline history', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await installHarness(page);
  const initial = await page.evaluate(() =>
    window.__fukamuFullNetworkCameraHarness.initialize(120),
  );
  expect(initial.level).toBe('overview');
  expect(initial.restoreReason).toBe('fit');
  const beforeCurrentChange = {
    offsetX: initial.offsetX,
    offsetY: initial.offsetY,
    scale: initial.scale,
  };
  const changedCurrent = await page.evaluate(() =>
    window.__fukamuFullNetworkCameraHarness.setCurrent(180),
  );
  expect({
    offsetX: changedCurrent.offsetX,
    offsetY: changedCurrent.offsetY,
    scale: changedCurrent.scale,
  }).toEqual(beforeCurrentChange);

  const centered = await page.evaluate(() =>
    window.__fukamuFullNetworkCameraHarness.centerCurrent(),
  );
  expect(
    centered.offsetX !== initial.offsetX ||
      centered.offsetY !== initial.offsetY,
  ).toBe(true);
  const refit = await page.evaluate(() =>
    window.__fukamuFullNetworkCameraHarness.fitAll(),
  );
  expect(refit.scale).toBeCloseTo(initial.scale);

  const reset = await page.evaluate(() =>
    window.__fukamuFullNetworkCameraHarness.initialize(180),
  );
  expect(reset.level).toBe('overview');

  const targetIndex = 180;
  let target = await nodePoint(page, targetIndex);
  await page.mouse.click(target.x, target.y);
  const network = await page.evaluate(() =>
    window.__fukamuFullNetworkCameraHarness.state(),
  );
  expect(network.level).toBe('network');
  expect(network.selectedCardId).not.toBeNull();
  target = await nodePoint(page, targetIndex);
  await page.mouse.click(target.x, target.y);
  const detail = await page.evaluate(() =>
    window.__fukamuFullNetworkCameraHarness.state(),
  );
  expect(detail.level).toBe('detail');
  target = await nodePoint(page, targetIndex);
  await page.mouse.click(target.x, target.y);
  await expect(page.getByTestId('full-network-camera-harness')).toBeHidden();
  const cardRoute = await page.evaluate(() =>
    window.__fukamuFullNetworkCameraHarness.state(),
  );
  expect(cardRoute.route).toBe('card');
  expect(cardRoute.openedCardId).toBe(detail.selectedCardId);

  await context.setOffline(true);
  const restored = await page.evaluate(() =>
    window.__fukamuFullNetworkCameraHarness.dispatchHistoryRoute('map'),
  );
  expect(restored.route).toBe('map');
  expect(restored.restoreReason).toBe('exact');
  expect(restored.level).toBe('detail');
  expect(restored.scale).toBeCloseTo(detail.scale);
  expect(restored.selectedCardId).toBe(detail.selectedCardId);
  const forward = await page.evaluate(() =>
    window.__fukamuFullNetworkCameraHarness.dispatchHistoryRoute('card'),
  );
  expect(forward.route).toBe('card');
  await context.setOffline(false);
});

test('pointer, pinch, cancellation, lost capture and keyboard keep click semantics safe', async ({
  page,
}) => {
  await page.goto('/');
  await installHarness(page);
  await page.evaluate(() =>
    window.__fukamuFullNetworkCameraHarness.initialize(),
  );
  const surface = page.getByTestId('full-network-camera-harness');
  const bounds = await surface.boundingBox();
  if (!bounds) throw new Error('Camera harness has no bounds');

  await page.mouse.move(bounds.x + 200, bounds.y + 200);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 280, bounds.y + 240, { steps: 3 });
  await page.mouse.up();
  const afterDrag = await page.evaluate(() =>
    window.__fukamuFullNetworkCameraHarness.state(),
  );
  expect(afterDrag.selectedCardId).toBeNull();
  await expect(surface).toHaveAttribute('data-active-pointers', '0');

  const beforePinch = afterDrag.scale;
  await surface.dispatchEvent('pointerdown', {
    pointerId: 11,
    pointerType: 'touch',
    isPrimary: true,
    clientX: bounds.x + 220,
    clientY: bounds.y + 200,
  });
  await surface.dispatchEvent('pointerdown', {
    pointerId: 12,
    pointerType: 'touch',
    isPrimary: false,
    clientX: bounds.x + 420,
    clientY: bounds.y + 200,
  });
  await page.dispatchEvent('body', 'pointermove', {
    pointerId: 11,
    pointerType: 'touch',
    clientX: bounds.x + 160,
    clientY: bounds.y + 210,
  });
  await page.dispatchEvent('body', 'pointermove', {
    pointerId: 12,
    pointerType: 'touch',
    clientX: bounds.x + 480,
    clientY: bounds.y + 210,
  });
  const afterPinch = await page.evaluate(() =>
    window.__fukamuFullNetworkCameraHarness.state(),
  );
  expect(afterPinch.scale).toBeGreaterThan(beforePinch);
  await page.dispatchEvent('body', 'pointercancel', {
    pointerId: 11,
    pointerType: 'touch',
  });
  await page.dispatchEvent('body', 'pointercancel', {
    pointerId: 12,
    pointerType: 'touch',
  });
  await expect(surface).toHaveAttribute('data-active-pointers', '0');

  await surface.dispatchEvent('pointerdown', {
    pointerId: 20,
    pointerType: 'touch',
    isPrimary: true,
    clientX: bounds.x + 250,
    clientY: bounds.y + 220,
  });
  await page.dispatchEvent('body', 'pointermove', {
    pointerId: 20,
    pointerType: 'touch',
    clientX: bounds.x + 300,
    clientY: bounds.y + 250,
  });
  await surface.dispatchEvent('lostpointercapture', {
    pointerId: 20,
    pointerType: 'touch',
  });
  await expect(surface).toHaveAttribute('data-active-pointers', '0');

  await surface.focus();
  const beforeKeyboard = await page.evaluate(() =>
    window.__fukamuFullNetworkCameraHarness.state(),
  );
  await page.keyboard.press('+');
  const afterKeyboardZoom = await page.evaluate(() =>
    window.__fukamuFullNetworkCameraHarness.state(),
  );
  expect(afterKeyboardZoom.scale).toBeGreaterThan(beforeKeyboard.scale);
  await page.keyboard.press('0');
  const fit = await page.evaluate(() =>
    window.__fukamuFullNetworkCameraHarness.state(),
  );
  expect(fit.scale).toBeLessThan(afterKeyboardZoom.scale);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await expect(surface).toBeFocused();
});

test('topology changes use surviving anchors and logout cannot restore another session', async ({
  page,
}) => {
  await page.goto('/');
  await installHarness(page);
  await page.evaluate(() =>
    window.__fukamuFullNetworkCameraHarness.initialize(),
  );
  const target = await nodePoint(page, 100);
  await page.mouse.click(target.x, target.y);
  const selected = await page.evaluate(() =>
    window.__fukamuFullNetworkCameraHarness.state(),
  );
  expect(selected.selectedCardId).not.toBeNull();

  const anchored = await page.evaluate(() =>
    window.__fukamuFullNetworkCameraHarness.replaceTopology(false),
  );
  expect(anchored.restoreReason).toBe('anchor');
  expect(anchored.selectedCardId).toBe(selected.selectedCardId);
  expect(anchored.scale).toBeCloseTo(selected.scale);

  const fallback = await page.evaluate(() =>
    window.__fukamuFullNetworkCameraHarness.replaceTopology(true),
  );
  expect(fallback.restoreReason).toBe('fit');
  expect(fallback.selectedCardId).toBeNull();
  expect(
    await page.evaluate(() =>
      window.__fukamuFullNetworkCameraHarness.scopeMismatch(),
    ),
  ).toContain('scope mismatch');

  const newSession = await page.evaluate(() => {
    window.__fukamuFullNetworkCameraHarness.setCurrent(200);
    window.__fukamuFullNetworkCameraHarness.centerCurrent();
    return window.__fukamuFullNetworkCameraHarness.logoutAndReenter();
  });
  expect(newSession.restoreReason).toBe('fit');
  expect(newSession.selectedCardId).toBeNull();
  expect(newSession.currentCardId).not.toBeNull();
});

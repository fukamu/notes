import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

let harnessSource: string | undefined;

test('retained semantic renderer draws every identity and coalesces camera frames', async ({
  page,
}) => {
  await page.goto('/');
  await installHarness(page);
  const initial = await page.evaluate(() =>
    window.__fukamuFullNetworkRendererHarness.initialize('webgl2'),
  );
  expect(initial.snapshot.status).toMatchObject({
    kind: 'ready',
    nodeCount: 256,
    edgeCount: 20_480,
  });
  expect(initial.snapshot.overviewBuildCount).toBe(1);
  expect(initial.snapshot.datasetKey).toContain('render-dataset-v1');
  expect(initial.level).toBe('overview');
  expect(initial.canvasDataLength).toBeGreaterThan(1_000);

  const camera = await page.evaluate(() =>
    window.__fukamuFullNetworkRendererHarness.cameraBurst(),
  );
  expect(camera.finalLevel).toBe('detail');
  expect(camera.visibleNodeCount).toBeGreaterThan(0);
  expect(camera.visibleNodeCount).toBeLessThan(256);
  expect(camera.visibleEdgeCount).toBeGreaterThan(0);
  expect(camera.after.overviewBuildCount).toBe(
    camera.before.overviewBuildCount,
  );
  expect(camera.after.overviewDrawCount).toBe(camera.before.overviewDrawCount);
  expect(camera.after.detailDrawCount - camera.before.detailDrawCount).toBe(1);
  expect(
    camera.after.scheduledFrameCount - camera.before.scheduledFrameCount,
  ).toBe(1);
  expect(camera.overviewTransform).toContain('translate(');
  expect(camera.overviewTransform).toContain('scale(');
  expect(camera.detailQuadraticCurveCount).toBeGreaterThan(0);

  const themed = await page.evaluate(() =>
    window.__fukamuFullNetworkRendererHarness.changeTheme(),
  );
  expect(themed.status.kind).toBe('ready');
  expect(themed.overviewDrawCount).toBeGreaterThan(
    camera.after.overviewDrawCount,
  );
  expect(themed.detailDrawCount).toBeGreaterThan(camera.after.detailDrawCount);
  const resized = await page.evaluate(() =>
    window.__fukamuFullNetworkRendererHarness.resize(),
  );
  expect(resized.after.overviewDrawCount).toBeGreaterThan(
    resized.before.overviewDrawCount,
  );
  expect(resized.after.detailDrawCount).toBeGreaterThan(
    resized.before.detailDrawCount,
  );
  expect(resized.backingWidth).toBeGreaterThan(0);
  expect(resized.backingHeight).toBeGreaterThan(0);
  if (initial.snapshot.backend === 'webgl2') {
    expect(resized.after.overviewBuildCount).toBe(
      resized.before.overviewBuildCount,
    );
  }
  expect(
    await page.evaluate(() =>
      window.__fukamuFullNetworkRendererHarness.rejectHiddenDetail(),
    ),
  ).toContain('not a unique visible node');

  if (initial.snapshot.backend === 'webgl2') {
    const recovery = await page.evaluate(() =>
      window.__fukamuFullNetworkRendererHarness.recoverContext(),
    );
    expect(recovery.lost.status.kind).toBe('context-lost');
    expect(recovery.recovered.status.kind).toBe('ready');
    expect(recovery.recovered.overviewBuildCount).toBeGreaterThan(
      recovery.lost.overviewBuildCount,
    );
  }

  const disposed = await page.evaluate(() =>
    window.__fukamuFullNetworkRendererHarness.dispose(),
  );
  expect(disposed.status.kind).toBe('disposed');
  await expect(page.getByTestId('full-network-renderer-harness')).toBeVisible();
});

test('progressive Canvas2D fallback completes without edge or node caps', async ({
  page,
}) => {
  await page.goto('/');
  await installHarness(page);
  const initial = await page.evaluate(() =>
    window.__fukamuFullNetworkRendererHarness.initialize('canvas2d'),
  );
  expect(initial.snapshot.status).toEqual({
    kind: 'ready',
    backend: 'canvas2d',
    nodeCount: 256,
    edgeCount: 20_480,
  });
  expect(initial.snapshot.backend).toBe('canvas2d');
  expect(initial.snapshot.overviewBuildCount).toBe(1);
  expect(initial.snapshot.overviewDrawCount).toBeGreaterThan(1);
  expect(initial.canvasDataLength).toBeGreaterThan(1_000);

  const camera = await page.evaluate(() =>
    window.__fukamuFullNetworkRendererHarness.cameraBurst(),
  );
  expect(camera.after.overviewDrawCount).toBe(camera.before.overviewDrawCount);
  expect(camera.after.detailDrawCount - camera.before.detailDrawCount).toBe(1);
  expect(camera.detailQuadraticCurveCount).toBeGreaterThan(0);

  const themed = await page.evaluate(() =>
    window.__fukamuFullNetworkRendererHarness.changeTheme(),
  );
  expect(themed.status.kind).toBe('ready');
  expect(themed.overviewBuildCount).toBe(2);
  expect(themed.overviewDrawCount).toBeGreaterThan(
    camera.after.overviewDrawCount,
  );
  expect(themed.detailDrawCount).toBeGreaterThan(camera.after.detailDrawCount);
  const resized = await page.evaluate(() =>
    window.__fukamuFullNetworkRendererHarness.resize(),
  );
  expect(resized.after.overviewBuildCount).toBe(
    resized.before.overviewBuildCount + 1,
  );
  expect(resized.after.overviewDrawCount).toBeGreaterThan(
    resized.before.overviewDrawCount,
  );

  const disposed = await page.evaluate(() =>
    window.__fukamuFullNetworkRendererHarness.dispose(),
  );
  expect(disposed.status.kind).toBe('disposed');
});

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
            './fixtures/full-network-renderer-harness.ts',
            import.meta.url,
          ),
        ),
        name: 'FukamuFullNetworkRendererHarness',
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
  throw new Error('full-network renderer browser harness bundle is missing');
}

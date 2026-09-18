import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

function field(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null) return undefined;
  return Reflect.get(input, key);
}

function finite(input: unknown, label: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
    throw new TypeError(`${label} must be finite and non-negative`);
  }
  return input;
}

describe('connections bounded-raster-cache product evidence', () => {
  it('records bounded surfaces and target-meeting complete-graph samples', async () => {
    const artifact: unknown = JSON.parse(
      await readFile(
        'docs/benchmarks/connections-bounded-raster-cache.json',
        'utf8',
      ),
    );
    expect(field(artifact, 'issue')).toBe(327);
    expect(field(artifact, 'branchPoint')).toBe(
      '63beff4422e66745f6554bd8bbd0febaa4776214',
    );
    const fixture = field(artifact, 'fixture');
    expect(field(fixture, 'nodes')).toBe(10_000);
    expect(field(fixture, 'directedEdges')).toBe(19_999);
    const policy = field(artifact, 'policy');
    expect(field(policy, 'overscanCssPixels')).toBe(96);
    expect(field(policy, 'maximumRasterSurfacesPerLayer')).toBe(2);
    expect(field(policy, 'wholeWorldBitmap')).toBe(false);
    expect(field(policy, 'tileCache')).toBe(false);
    expect(field(policy, 'offscreenCanvasWorker')).toBe(false);

    const runs = field(artifact, 'runs');
    if (!Array.isArray(runs)) throw new TypeError('Expected recorded runs');
    expect(runs.map((run) => field(run, 'project'))).toEqual([
      'chromium',
      'mobile-chromium',
    ]);
    for (const run of runs) {
      const viewport = field(run, 'graphViewport');
      const dpr = finite(field(run, 'devicePixelRatio'), 'DPR');
      const expectedWidth = Math.round(
        (finite(field(viewport, 'width'), 'viewport width') + 192) * dpr,
      );
      const expectedHeight = Math.round(
        (finite(field(viewport, 'height'), 'viewport height') + 192) * dpr,
      );
      const raster = field(run, 'boundedRasterPixels');
      for (const layer of ['edge', 'card']) {
        expect(field(field(raster, layer), 'width')).toBe(expectedWidth);
        expect(field(field(raster, layer), 'height')).toBe(expectedHeight);
      }
      const samples = field(run, 'samples');
      if (!Array.isArray(samples) || samples.length !== 2) {
        throw new TypeError('Expected two product samples per project');
      }
      for (const sample of samples) {
        expect(
          finite(field(sample, 'initialReadyMs'), 'initial ready'),
        ).toBeLessThan(5_000);
        const continuous = field(sample, 'continuousWholeWorld');
        expect(field(continuous, 'samples')).toBe(30);
        expect(
          finite(field(continuous, 'frameP95Ms'), 'full-fit frame p95'),
        ).toBeLessThanOrEqual(50);
        expect(field(continuous, 'edgeRefreshCount')).toBe(0);
        expect(field(continuous, 'edgeReuseCount')).toBe(30);
        expect(field(continuous, 'cardRefreshCount')).toBe(0);
        expect(field(continuous, 'cardReuseCount')).toBe(30);
        expect(field(continuous, 'longTaskCount')).toBe(0);
      }
    }

    const interpretation = field(artifact, 'interpretation');
    expect(field(interpretation, 'membership')).toBe('complete');
    expect(field(interpretation, 'provisionalFiveSecondReadyTarget')).toContain(
      'met',
    );
    expect(
      field(
        interpretation,
        'provisionalFiftyMillisecondContinuousWholeWorldTarget',
      ),
    ).toContain('met');
    expect(field(interpretation, 'conditionalWorker')).toContain(
      'not implemented',
    );
  });
});

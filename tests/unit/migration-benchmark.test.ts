import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  benchmarkRequestHeaders,
  decodeBenchmarkFixture,
  liveBenchmarkTarget,
  parseBenchmarkOptions,
  validateBenchmarkOptions,
} from '../../scripts/migration-benchmark-core.mts';

function readyOptions(arguments_: readonly string[]) {
  const options = parseBenchmarkOptions(arguments_);
  validateBenchmarkOptions(options);
  return options;
}

describe('migration benchmark safety boundary', () => {
  it('decodes the shared setup and measured request', async () => {
    const candidate: unknown = JSON.parse(
      await readFile('contracts/fixtures/sync/legacy-v1.json', 'utf8'),
    );
    const fixture = decodeBenchmarkFixture(candidate);
    const options = readyOptions([
      '--target=go',
      '--store-id=postgres-fixture',
      '--warmup=2',
      '--samples=6',
      '--dry-run',
    ]);

    expect(fixture.setupRequests).toHaveLength(2);
    expect(fixture.request).toBeDefined();
    expect(options).toMatchObject({
      target: 'go',
      storeId: 'postgres-fixture',
      warmup: 2,
      samples: 6,
      dryRun: true,
    });
  });

  it('rejects remote, credential-bearing, and non-root targets', () => {
    for (const baseUrl of [
      'https://example.com/',
      'http://user:secret@127.0.0.1:3100/',
      'http://127.0.0.1:3100/private',
    ]) {
      const options = readyOptions([
        '--target=reference',
        `--base-url=${baseUrl}`,
        '--store-id=d1-fixture',
      ]);
      expect(() => liveBenchmarkTarget(options)).toThrow(
        'root loopback HTTP URL',
      );
    }
  });

  it('requires a warm-up, measured sample floor, and disposable-store label', () => {
    expect(() => readyOptions(['--target=reference', '--warmup=0'])).toThrow(
      '--warmup must be at least 1',
    );
    expect(() => readyOptions(['--target=reference', '--samples=4'])).toThrow(
      '--samples must be at least 5',
    );
    expect(() =>
      liveBenchmarkTarget(readyOptions(['--target=reference'])),
    ).toThrow('--base-url is required');
    expect(() =>
      liveBenchmarkTarget(
        readyOptions([
          '--target=reference',
          '--base-url=http://127.0.0.1:3100/',
        ]),
      ),
    ).toThrow('--store-id is required');
  });

  it('requires bounded auth while keeping error text independent of the value', () => {
    const secret = 'not-a-valid-assertion-secret';
    const invoke = () =>
      benchmarkRequestHeaders('go', 'http://127.0.0.1:3100', {
        referenceSubject: undefined,
        goAssertion: secret,
      });

    expect(invoke).toThrow(
      'MIGRATION_BENCHMARK_GO_ASSERTION is required and invalid',
    );
    try {
      invoke();
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('returns only the selected target header and matching origin', () => {
    expect(
      benchmarkRequestHeaders('reference', 'http://127.0.0.1:3100', {
        referenceSubject: 'opaque-test-user',
        goAssertion: undefined,
      }),
    ).toEqual({
      'Content-Type': 'application/json',
      Origin: 'http://127.0.0.1:3100',
      'oai-authenticated-user-id': 'opaque-test-user',
    });
    expect(
      benchmarkRequestHeaders('go', 'http://localhost:3100', {
        referenceSubject: undefined,
        goAssertion: 'header.payload.signature',
      }),
    ).toEqual({
      'Content-Type': 'application/json',
      Origin: 'http://localhost:3100',
      'X-Fukamu-Local-Identity-Assertion': 'header.payload.signature',
    });
  });
});

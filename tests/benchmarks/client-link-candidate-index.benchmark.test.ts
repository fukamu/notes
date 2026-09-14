import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  createCardEditorCandidateIndex,
  maximumCardEditorCandidateResults,
  queryCardEditorCandidates,
  reconcileCardEditorCandidateIndex,
} from '@/lib/application/card-editor-index';
import { linkCandidates } from '@/lib/domain/body';
import type { CardRecord } from '@/lib/domain/types';
import { invariant } from '@/lib/shared/invariant';
import {
  decodeClientBenchmarkDistribution,
  summarizeClientBenchmarkSamples,
} from '@/tests/benchmarks/client-performance-support';
import { createClientPerformanceFixture } from '@/tests/fixtures/client-performance';

type IndexBenchmark = Readonly<{
  name: string;
  warmupIterations: number;
  measuredIterations: number;
  expectedChecksum: number;
  run: () => number;
}>;

function measureIndexBenchmark(benchmark: IndexBenchmark) {
  for (let index = 0; index < benchmark.warmupIterations; index += 1) {
    if (benchmark.run() !== benchmark.expectedChecksum) {
      throw new Error(`${benchmark.name} warmup checksum changed`);
    }
  }
  const samples: number[] = [];
  for (let index = 0; index < benchmark.measuredIterations; index += 1) {
    const started = performance.now();
    const checksum = benchmark.run();
    samples.push(performance.now() - started);
    if (checksum !== benchmark.expectedChecksum) {
      throw new Error(`${benchmark.name} checksum changed`);
    }
  }
  return {
    name: benchmark.name,
    warmupIterations: benchmark.warmupIterations,
    measuredIterations: benchmark.measuredIterations,
    timing: decodeClientBenchmarkDistribution(
      summarizeClientBenchmarkSamples(samples),
    ),
  };
}

describe('10,000-card link candidate index benchmark', () => {
  it('records exact legacy equivalence and no per-prefix scan/sort evidence', async () => {
    const cards = createClientPerformanceFixture();
    const currentCard = cards[Math.floor(cards.length / 2)];
    invariant(currentCard, '10k fixture omitted its current card');
    const prefixes = ['', '9', '99', '999'] as const;
    const index = createCardEditorCandidateIndex(cards, currentCard.id);
    const bodyOnlyCards: CardRecord[] = cards.map((card) =>
      card.id === currentCard.id
        ? {
            ...card,
            body: [{ type: 'text', text: 'body-only benchmark edit' }],
            updatedAt: card.updatedAt + 1,
            localRevision: card.localRevision + 1,
          }
        : card,
    );
    const reconciled = reconcileCardEditorCandidateIndex(
      index,
      bodyOnlyCards,
      currentCard.id,
    );
    const expectedChecksum = prefixes.reduce(
      (total, prefix) =>
        total + linkCandidates(cards, currentCard.id, prefix).length,
      0,
    );

    for (const prefix of prefixes) {
      expect(
        queryCardEditorCandidates(index, prefix).map(
          (candidate) => candidate.cardId,
        ),
      ).toEqual(
        linkCandidates(cards, currentCard.id, prefix).map((card) => card.id),
      );
    }
    expect(reconciled).toBe(index);

    const measurements = [
      measureIndexBenchmark({
        name: 'legacy-prefix-sequence-scan-sort',
        warmupIterations: 1,
        measuredIterations: 5,
        expectedChecksum,
        run: () =>
          prefixes.reduce(
            (total, prefix) =>
              total + linkCandidates(cards, currentCard.id, prefix).length,
            0,
          ),
      }),
      measureIndexBenchmark({
        name: 'candidate-index-build',
        warmupIterations: 1,
        measuredIterations: 5,
        expectedChecksum: cards.length * 2 - 1,
        run: () => {
          const built = createCardEditorCandidateIndex(cards, currentCard.id);
          return (
            built.labels.length + queryCardEditorCandidates(built, '').length
          );
        },
      }),
      measureIndexBenchmark({
        name: 'indexed-prefix-sequence',
        warmupIterations: 20,
        measuredIterations: 100,
        expectedChecksum,
        run: () =>
          prefixes.reduce(
            (total, prefix) =>
              total + queryCardEditorCandidates(index, prefix).length,
            0,
          ),
      }),
      measureIndexBenchmark({
        name: 'body-only-index-reconcile',
        warmupIterations: 5,
        measuredIterations: 30,
        expectedChecksum: 1,
        run: () =>
          reconcileCardEditorCandidateIndex(
            index,
            bodyOnlyCards,
            currentCard.id,
          ) === index
            ? 1
            : 0,
      }),
    ];
    const artifact = {
      schemaVersion: 1,
      issue: 202,
      branchPoint: '137e78af5ad4283859153518a9c3f541a84f67cc',
      generatedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model ?? 'unknown',
        cpuCount: cpus().length,
      },
      fixture: {
        cards: cards.length,
        source: 'tests/fixtures/client-performance.ts',
        currentCardId: currentCard.id,
        prefixes,
      },
      mechanismBudget: {
        exactLegacyOrderAndFiltering: true,
        bodyAndRevisionOnlyEditReusesIndexIdentity: reconciled === index,
        indexedPrefixQuery:
          'One ReadonlyMap lookup; no card-replica scan and no candidate sort.',
        maximumResults: maximumCardEditorCandidateResults,
        rebuildInputs: [
          'card id/order/create/delete',
          'display-id kind/value',
          'title',
          'createdAt tie-break',
          'current card id',
        ],
        ignoredInputs: ['body', 'updatedAt', 'localRevision', 'serverRevision'],
      },
      comparisonPolicy:
        'Legacy and indexed queries run on the same host, fixture, current card and prefix sequence. Timing is review evidence; exact result equivalence, direct prefix lookup and index identity reuse are the required gates.',
      measurements,
    };

    await mkdir('docs/benchmarks', { recursive: true });
    await writeFile(
      'docs/benchmarks/10k-link-candidate-index.json',
      `${JSON.stringify(artifact, null, 2)}\n`,
    );

    expect(cards).toHaveLength(10_000);
    expect(artifact.mechanismBudget).toMatchObject({
      exactLegacyOrderAndFiltering: true,
      bodyAndRevisionOnlyEditReusesIndexIdentity: true,
    });
  });
});

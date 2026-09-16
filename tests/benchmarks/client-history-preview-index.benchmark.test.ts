import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { describe, expect, it } from 'vitest';
import { selectHistoryViewModel } from '@/lib/application/view-models';
import { bodyToPlainText } from '@/lib/domain/body';
import { formatDisplayId } from '@/lib/domain/display-id';
import type { CardId } from '@/lib/domain/id';
import { visibleTitle, type CardRecord } from '@/lib/domain/types';
import { invariant } from '@/lib/shared/invariant';
import {
  decodeClientBenchmarkDistribution,
  summarizeClientBenchmarkSamples,
} from '@/tests/benchmarks/client-performance-support';
import { createClientPerformanceFixture } from '@/tests/fixtures/client-performance';

type HistoryBenchmark = Readonly<{
  name: string;
  warmupIterations: number;
  measuredIterations: number;
  expectedChecksum: number;
  run: () => number;
}>;

function measureHistoryBenchmark(benchmark: HistoryBenchmark) {
  for (let index = 0; index < benchmark.warmupIterations; index += 1) {
    if (benchmark.run() !== benchmark.expectedChecksum) {
      throw new Error(`${benchmark.name} warmup checksum changed`);
    }
  }
  const samples: number[] = [];
  const heapBeforeBytes = process.memoryUsage().heapUsed;
  for (let index = 0; index < benchmark.measuredIterations; index += 1) {
    const started = performance.now();
    const checksum = benchmark.run();
    samples.push(performance.now() - started);
    if (checksum !== benchmark.expectedChecksum) {
      throw new Error(`${benchmark.name} checksum changed`);
    }
  }
  const heapAfterBytes = process.memoryUsage().heapUsed;
  return {
    name: benchmark.name,
    warmupIterations: benchmark.warmupIterations,
    measuredIterations: benchmark.measuredIterations,
    timing: decodeClientBenchmarkDistribution(
      summarizeClientBenchmarkSamples(samples),
    ),
    observedHeapDeltaBytes: heapAfterBytes - heapBeforeBytes,
  };
}

function compareLegacyHistoryCards(
  left: { card: CardRecord; sourceIndex: number },
  right: { card: CardRecord; sourceIndex: number },
): number {
  const byNumber = right.card.displayId.value - left.card.displayId.value;
  if (byNumber !== 0) return byNumber;
  if (left.card.displayId.kind !== right.card.displayId.kind) {
    return left.card.displayId.kind === 'official' ? -1 : 1;
  }
  const byCreatedAt = left.card.createdAt - right.card.createdAt;
  if (byCreatedAt !== 0) return byCreatedAt;
  const byId = left.card.id.localeCompare(right.card.id);
  return byId !== 0 ? byId : left.sourceIndex - right.sourceIndex;
}

function legacyHistoryViewModel(
  cards: CardRecord[],
  currentCardId: CardId | null,
) {
  return {
    currentCardId,
    items: cards
      .map((card, sourceIndex) => ({ card, sourceIndex }))
      .sort(compareLegacyHistoryCards)
      .map(({ card }) => {
        const preview = bodyToPlainText(card.body, cards)
          .replace(/\s+/g, ' ')
          .trim();
        return {
          cardId: card.id,
          displayLabel: formatDisplayId(card.displayId),
          displayValue: card.displayId.value,
          title: visibleTitle(card.title),
          preview: preview || '本文はまだありません',
          current: card.id === currentCardId,
        };
      }),
  };
}

function historyChecksum(model: ReturnType<typeof selectHistoryViewModel>) {
  return model.items.reduce(
    (total, item) =>
      total + item.displayValue + item.title.length + item.preview.length,
    0,
  );
}

describe('10,000-card history preview index benchmark', () => {
  it('records exact legacy equivalence and one lookup per selector evidence', async () => {
    const cards = createClientPerformanceFixture();
    const currentCard = cards[Math.floor(cards.length / 2)];
    invariant(currentCard, '10k fixture omitted its current card');
    const legacy = legacyHistoryViewModel(cards, currentCard.id);
    const indexed = selectHistoryViewModel(cards, currentCard.id);
    const expectedChecksum = historyChecksum(indexed);
    const bodySegments = cards.reduce(
      (total, card) => total + card.body.length,
      0,
    );

    expect(indexed).toEqual(legacy);

    const measurements = [
      measureHistoryBenchmark({
        name: 'legacy-history-per-item-map',
        warmupIterations: 0,
        measuredIterations: 1,
        expectedChecksum,
        run: () =>
          historyChecksum(legacyHistoryViewModel(cards, currentCard.id)),
      }),
      measureHistoryBenchmark({
        name: 'indexed-history-single-lookup',
        warmupIterations: 1,
        measuredIterations: 5,
        expectedChecksum,
        run: () =>
          historyChecksum(selectHistoryViewModel(cards, currentCard.id)),
      }),
    ];
    const artifact = {
      schemaVersion: 1,
      issue: 203,
      branchPoint: 'b9aa21c0b85bc4d235ab5e805f843d28c6c87f6b',
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
        bodySegments,
        source: 'tests/fixtures/client-performance.ts',
        currentCardId: currentCard.id,
      },
      mechanismBudget: {
        cardBodyLookupBuildsPerSelector: 1,
        maximumLookupEntries: cards.length,
        historyItems: indexed.items.length,
        expectedComplexity:
          'O(cards log cards + total body segments) time and O(cards) derived lookup space.',
        exactLegacyOutput: true,
      },
      memoryPolicy:
        'Heap deltas are observational because garbage collection and host load are nondeterministic. The stable memory gate is one lookup with at most one entry per distinct CardId plus one history item per card.',
      comparisonPolicy:
        'Legacy and indexed selectors run on the same host, fixture and current card. Timing is review evidence; exact output equality and the single-lookup complexity contract are required gates.',
      measurements,
    };

    await mkdir('docs/benchmarks', { recursive: true });
    await writeFile(
      'docs/benchmarks/10k-history-preview-index.json',
      `${JSON.stringify(artifact, null, 2)}\n`,
    );

    expect(artifact.mechanismBudget).toMatchObject({
      cardBodyLookupBuildsPerSelector: 1,
      maximumLookupEntries: 10_000,
      historyItems: 10_000,
      exactLegacyOutput: true,
    });
  });
});

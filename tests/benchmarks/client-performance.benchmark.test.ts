import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  selectCardEditorInputModel,
  selectConnectionsViewModel,
  selectHistoryViewModel,
} from '@/lib/application/view-models';
import { outgoingCardIds } from '@/lib/domain/body';
import { formatDisplayId } from '@/lib/domain/display-id';
import {
  decodeCardRecord,
  visibleTitle,
  type CardRecord,
} from '@/lib/domain/types';
import { filterCardEditorCandidates } from '@/lib/editor/card-editor-state';
import { invariant } from '@/lib/shared/invariant';
import {
  clientPerformanceFixtureDefaults,
  createClientPerformanceFixture,
} from '@/tests/fixtures/client-performance';
import {
  decodeClientBenchmarkDistribution,
  relativeTimingTolerance,
  summarizeClientBenchmarkSamples,
} from '@/tests/benchmarks/client-performance-support';

type BenchmarkCase = Readonly<{
  name: string;
  warmupIterations: number;
  measuredIterations: number;
  expectedChecksum: number;
  run: () => number;
}>;

function measureBenchmarkCase(benchmark: BenchmarkCase) {
  for (let index = 0; index < benchmark.warmupIterations; index += 1) {
    const checksum = benchmark.run();
    if (checksum !== benchmark.expectedChecksum) {
      throw new Error(`${benchmark.name} warmup returned ${checksum}`);
    }
  }

  const samples: number[] = [];
  const heapBeforeBytes = process.memoryUsage().heapUsed;
  for (let index = 0; index < benchmark.measuredIterations; index += 1) {
    const started = performance.now();
    const checksum = benchmark.run();
    samples.push(performance.now() - started);
    if (checksum !== benchmark.expectedChecksum) {
      throw new Error(`${benchmark.name} returned ${checksum}`);
    }
  }
  const heapAfterBytes = process.memoryUsage().heapUsed;
  const timing = decodeClientBenchmarkDistribution(
    summarizeClientBenchmarkSamples(samples),
  );

  return {
    name: benchmark.name,
    warmupIterations: benchmark.warmupIterations,
    measuredIterations: benchmark.measuredIterations,
    timing,
    observedHeapDeltaBytes: heapAfterBytes - heapBeforeBytes,
    sameHostFollowUpToleranceRatio: relativeTimingTolerance(timing),
  };
}

function decodeReplica(serialized: string): CardRecord[] {
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new TypeError('Serialized replica must decode to an array');
  }
  return parsed.map((item) => decodeCardRecord(item));
}

function fixtureResourceSummary(cards: readonly CardRecord[]) {
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  let bodySegments = 0;
  let linkSegments = 0;
  let maximumDisplayedCharacters = 0;
  let maximumContentBytes = 0;
  for (const card of cards) {
    bodySegments += card.body.length;
    linkSegments += card.body.filter(
      (segment) => segment.type === 'link',
    ).length;
    let displayedCharacters = card.title.length;
    for (const segment of card.body) {
      if (segment.type === 'text') {
        displayedCharacters += segment.text.length;
        continue;
      }
      const target = cardsById.get(segment.targetCardId);
      displayedCharacters += target
        ? `［${formatDisplayId(target.displayId)} ${visibleTitle(target.title)}］`
            .length
        : '［リンク先なし］'.length;
    }
    maximumDisplayedCharacters = Math.max(
      maximumDisplayedCharacters,
      displayedCharacters,
    );
    maximumContentBytes = Math.max(
      maximumContentBytes,
      Buffer.byteLength(JSON.stringify({ title: card.title, body: card.body })),
    );
  }
  const serializedReplica = JSON.stringify(cards);
  return {
    cards: cards.length,
    bodySegments,
    linkSegments,
    maximumDisplayedCharactersPerCard: maximumDisplayedCharacters,
    maximumSerializedContentBytesPerCard: maximumContentBytes,
    serializedReplicaBytes: Buffer.byteLength(serializedReplica),
    serializedReplica,
  };
}

describe('10,000-card client benchmark artifact', () => {
  it('measures fixed client boundaries without imposing an unexplained time gate', async () => {
    const memoryBeforeFixture = process.memoryUsage();
    const cards = createClientPerformanceFixture();
    const memoryAfterFixture = process.memoryUsage();
    const resources = fixtureResourceSummary(cards);
    const currentCard = cards[Math.floor(cards.length / 2)];
    invariant(currentCard, '10k fixture omitted its current card');
    const editorInput = selectCardEditorInputModel(cards, currentCard);
    const cardIds = new Set(cards.map((card) => card.id));
    const validLinkCount = cards.reduce((total, card) => {
      const targets = new Set(
        outgoingCardIds(card.body).filter((targetCardId) =>
          cardIds.has(targetCardId),
        ),
      );
      return total + targets.size;
    }, 0);

    const measurements = [
      measureBenchmarkCase({
        name: 'fixture-generation',
        warmupIterations: 1,
        measuredIterations: 5,
        expectedChecksum: cards.length,
        run: () => createClientPerformanceFixture().length,
      }),
      measureBenchmarkCase({
        name: 'serialized-replica-boundary-decode',
        warmupIterations: 1,
        measuredIterations: 3,
        expectedChecksum: cards.length,
        run: () => decodeReplica(resources.serializedReplica).length,
      }),
      measureBenchmarkCase({
        name: 'card-editor-input-model',
        warmupIterations: 1,
        measuredIterations: 5,
        expectedChecksum: cards.length * 2 - 1,
        run: () => {
          const input = selectCardEditorInputModel(cards, currentCard);
          return input.labels.length + input.candidates.length;
        },
      }),
      measureBenchmarkCase({
        name: 'link-prefix-interaction-99',
        warmupIterations: 10,
        measuredIterations: 30,
        expectedChecksum: filterCardEditorCandidates(
          editorInput.candidates,
          '99',
        ).length,
        run: () =>
          filterCardEditorCandidates(editorInput.candidates, '99').length,
      }),
      measureBenchmarkCase({
        name: 'history-view-model',
        warmupIterations: 1,
        measuredIterations: 3,
        expectedChecksum: cards.length,
        run: () => selectHistoryViewModel(cards, currentCard.id).items.length,
      }),
      measureBenchmarkCase({
        name: 'connections-input-boundary',
        warmupIterations: 1,
        measuredIterations: 3,
        expectedChecksum: cards.length + validLinkCount,
        run: () => {
          const model = selectConnectionsViewModel(cards, currentCard.id);
          return model.nodes.length + model.edges.length;
        },
      }),
    ];

    const artifact = {
      schemaVersion: 1,
      issue: 200,
      branchPoint: '556a18651dc2bf4f7d36cfb3c77dba073c8f23d6',
      generatedAt: new Date().toISOString(),
      fixture: {
        ...clientPerformanceFixtureDefaults,
        bodySegments: resources.bodySegments,
        linkSegments: resources.linkSegments,
        maximumSerializedContentBytesPerCard:
          resources.maximumSerializedContentBytesPerCard,
        serializedReplicaBytes: resources.serializedReplicaBytes,
      },
      scaleBudgets: {
        activeCardsPerVault: {
          limit: 10_000,
          observed: cards.length,
          source: 'Personal Vault entitlement requirement',
        },
        displayedCharactersPerCard: {
          limit: 1_000,
          observed: resources.maximumDisplayedCharactersPerCard,
          source: 'Product display-content requirement',
        },
        serializedContentBytesPerCard: {
          limit: 8 * 1_024,
          observed: resources.maximumSerializedContentBytesPerCard,
          source: 'Recommended internal plaintext limit',
        },
        serializedVaultBytes: {
          limit: 128 * 1_024 * 1_024,
          observed: resources.serializedReplicaBytes,
          source: 'Recommended Personal Vault plaintext envelope',
        },
      },
      environment: {
        node: process.version,
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model ?? 'unknown',
        cpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
      },
      memoryObservation: {
        heapUsedBeforeFixtureBytes: memoryBeforeFixture.heapUsed,
        heapUsedAfterFixtureBytes: memoryAfterFixture.heapUsed,
        rssBeforeFixtureBytes: memoryBeforeFixture.rss,
        rssAfterFixtureBytes: memoryAfterFixture.rss,
        policy:
          'Observational only: Node garbage collection and host load make heap deltas unsuitable for a strict CI gate. Stable serialized-byte limits are enforced separately.',
      },
      methodology: {
        command: 'npm run benchmark:client',
        syntheticDataOnly: true,
        outlierPolicy:
          'No timing sample is removed. Raw samples, median and nearest-rank p95 are retained.',
        timingGate:
          'Issue #200 records a baseline and does not add an absolute wall-clock CI gate. Follow-up Issues compare the same case on the same host and use max(20%, 3x observed median-to-p95 spread) as a review tolerance for non-targeted regressions.',
        interactionBudget:
          'Mechanism budgets are authoritative until final browser evidence in #204: zero inactive heavy selectors, no per-keystroke full sort, one card lookup build per history selection, and viewport-bounded history DOM.',
        connectionsDecision:
          'Only the typed graph-input boundary is measured. Full-graph versus staged disclosure remains Decision Required.',
      },
      measurements,
    };

    expect(cards).toHaveLength(10_000);
    expect(resources.maximumDisplayedCharactersPerCard).toBeLessThanOrEqual(
      1_000,
    );
    expect(resources.maximumSerializedContentBytesPerCard).toBeLessThanOrEqual(
      8 * 1_024,
    );
    expect(resources.serializedReplicaBytes).toBeLessThanOrEqual(
      128 * 1_024 * 1_024,
    );
    expect(measurements).toHaveLength(6);

    await mkdir('docs/benchmarks', { recursive: true });
    await writeFile(
      'docs/benchmarks/10k-client-baseline.json',
      `${JSON.stringify(artifact, null, 2)}\n`,
      'utf8',
    );
  });
});

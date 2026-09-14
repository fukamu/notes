import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  createNotesPresentationModel,
  type NotesStorePort,
} from '@/lib/application/notes-controller';
import {
  selectCardEditorInputModel,
  selectConnectionsViewModel,
  selectHistoryViewModel,
} from '@/lib/application/view-models';
import type { NotesLocation } from '@/lib/application/navigation';
import type { NotesPresentationModel } from '@/lib/application/presentation';
import { queryCardEditorCandidates } from '@/lib/application/card-editor-index';
import type { CardRecord } from '@/lib/domain/types';
import { invariant } from '@/lib/shared/invariant';
import {
  decodeClientBenchmarkDistribution,
  summarizeClientBenchmarkSamples,
} from '@/tests/benchmarks/client-performance-support';
import { createClientPerformanceFixture } from '@/tests/fixtures/client-performance';

type ProjectionBenchmark = Readonly<{
  name: string;
  warmupIterations: number;
  measuredIterations: number;
  expectedChecksum: number;
  run: () => number;
}>;

function measureProjection(benchmark: ProjectionBenchmark) {
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

function benchmarkStore(cards: CardRecord[]): NotesStorePort {
  return {
    cards,
    conflicts: [],
    initialization: { stage: 'ready', loadOutcome: 'succeeded' },
    saveState: 'saved',
    syncState: 'idle',
    createCard: async () => {
      const card = cards[0];
      invariant(card, 'Performance fixture cannot create from an empty store');
      return card;
    },
    hasCard: (cardId) => cards.some((card) => card.id === cardId),
    updateCard: () => undefined,
    synchronizeNow: async () => undefined,
    resolveConflict: () => undefined,
  };
}

function activeProjectionChecksum(
  model: NotesPresentationModel,
  expectedView: 'card' | 'history' | 'connections',
): number {
  if (model.activeView !== expectedView) {
    throw new Error(
      `Expected ${expectedView} projection, received ${model.activeView}`,
    );
  }
  switch (model.activeView) {
    case 'card':
      if (model.history !== null || model.connections !== null) {
        throw new Error('Card projection materialized an inactive view');
      }
      return (
        (model.cardEditor?.labels.length ?? 0) +
        (model.cardEditor
          ? queryCardEditorCandidates(model.cardEditor.candidateIndex, '')
              .length
          : 0)
      );
    case 'history':
      if (model.cardEditor !== null || model.connections !== null) {
        throw new Error('History projection materialized an inactive view');
      }
      return model.history.items.length;
    case 'connections':
      if (model.cardEditor !== null || model.history !== null) {
        throw new Error('Connections projection materialized an inactive view');
      }
      return model.connections?.nodes.length ?? 0;
  }
}

function projectionFor(
  store: NotesStorePort,
  location: NotesLocation,
): NotesPresentationModel {
  return createNotesPresentationModel(store, location);
}

describe('10,000-card demand-driven presentation benchmark', () => {
  it('records same-host eager versus active-view projection evidence', async () => {
    const cards = createClientPerformanceFixture();
    const currentCard = cards[Math.floor(cards.length / 2)];
    invariant(currentCard, '10k fixture omitted its current card');
    const store = benchmarkStore(cards);
    const locations = {
      card: { kind: 'card', cardId: currentCard.id },
      history: { kind: 'history', cardId: currentCard.id },
      connections: { kind: 'connections', cardId: currentCard.id },
    } as const satisfies Record<
      'card' | 'history' | 'connections',
      NotesLocation
    >;

    const eagerCardProxy = measureProjection({
      name: 'legacy-eager-card-proxy',
      warmupIterations: 0,
      measuredIterations: 1,
      expectedChecksum: cards.length * 4 - 1,
      run: () => {
        const editor = selectCardEditorInputModel(cards, currentCard);
        const history = selectHistoryViewModel(cards, currentCard.id);
        const connections = selectConnectionsViewModel(cards, currentCard.id);
        return (
          editor.labels.length +
          queryCardEditorCandidates(editor.candidateIndex, '').length +
          history.items.length +
          connections.nodes.length
        );
      },
    });
    const card = measureProjection({
      name: 'demand-driven-card',
      warmupIterations: 1,
      measuredIterations: 5,
      expectedChecksum: cards.length * 2 - 1,
      run: () =>
        activeProjectionChecksum(projectionFor(store, locations.card), 'card'),
    });
    const history = measureProjection({
      name: 'demand-driven-history',
      warmupIterations: 0,
      measuredIterations: 1,
      expectedChecksum: cards.length,
      run: () =>
        activeProjectionChecksum(
          projectionFor(store, locations.history),
          'history',
        ),
    });
    const connections = measureProjection({
      name: 'demand-driven-connections',
      warmupIterations: 1,
      measuredIterations: 3,
      expectedChecksum: cards.length,
      run: () =>
        activeProjectionChecksum(
          projectionFor(store, locations.connections),
          'connections',
        ),
    });
    const speedupRatio =
      eagerCardProxy.timing.medianMs / Math.max(card.timing.medianMs, 0.001);
    const artifact = {
      schemaVersion: 1,
      issue: 201,
      branchPoint: '03d57c9dcd71e3bea51151e542dd71805e3d262d',
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
      },
      mechanismBudget: {
        card: {
          cardEditor: 'materialized',
          conflicts: 'materialized for the current card',
          history: 'null',
          connections: 'null',
        },
        history: {
          cardEditor: 'null',
          conflicts: 'empty',
          history: 'materialized',
          connections: 'null',
        },
        connections: {
          cardEditor: 'null',
          conflicts: 'empty',
          history: 'null',
          connections: 'materialized',
        },
      },
      comparisonPolicy:
        'The eager proxy and active projection run on the same host and fixture. Timing is review evidence; the discriminated inactive-null contract is the required regression gate.',
      eagerToDemandDrivenCardMedianRatio: Number(speedupRatio.toFixed(3)),
      measurements: [eagerCardProxy, card, history, connections],
    };

    expect(projectionFor(store, locations.card).activeView).toBe('card');
    expect(projectionFor(store, locations.history).activeView).toBe('history');
    expect(projectionFor(store, locations.connections).activeView).toBe(
      'connections',
    );

    await mkdir('docs/benchmarks', { recursive: true });
    await writeFile(
      'docs/benchmarks/10k-demand-driven-presentation.json',
      `${JSON.stringify(artifact, null, 2)}\n`,
      'utf8',
    );
  });
});

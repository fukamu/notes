import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { selectConnectionsViewModel } from '@/lib/application/view-models';
import { createMainThreadConnectionsLayoutRunner } from '@/lib/client/connections-layout-main-thread';
import { defaultConnectionsPresentation } from '@/components/connections-presentation';
import type { ConnectionsLayout } from '@/lib/graph/elk-layout';
import {
  connectionsLayoutGraph,
  fullNetworkGeometryShape,
  fullNetworkGraphShape,
  type FullNetworkLayoutMode,
  type IsolatedFullNetworkLayoutResult,
} from '@/tests/benchmarks/connections-full-network-baseline-support';
import { createFullNetworkBaselineFixture } from '@/tests/fixtures/connections-full-network';
import { selectLegacyInitialConnectionsStage } from '@/tests/benchmarks/legacy-connections-staging';

const fixtureName = process.env.CONNECTIONS_BASELINE_FIXTURE;
const requestedMode = process.env.CONNECTIONS_BASELINE_MODE;
const resultPath = process.env.CONNECTIONS_BASELINE_RESULT_PATH;
const warmupTarget = 1;
const measuredTarget = 5;

function mode(input: string | undefined): FullNetworkLayoutMode {
  if (input === 'staged' || input === 'full') return input;
  throw new TypeError('CONNECTIONS_BASELINE_MODE must be staged or full');
}

function failureMessage(error: unknown): string {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  return message.length <= 12_000 ? message : message.slice(0, 12_000);
}

describe('isolated full-network ELK baseline process', () => {
  it('runs one explicitly selected fixture or remains inert in the parent benchmark', async () => {
    if (
      fixtureName === undefined &&
      requestedMode === undefined &&
      resultPath === undefined
    ) {
      expect(process.env.CONNECTIONS_BASELINE_RESULT_PATH).toBeUndefined();
      return;
    }
    if (!fixtureName || !resultPath) {
      throw new TypeError(
        'Isolated baseline fixture and result path are required',
      );
    }

    const selectedMode = mode(requestedMode);
    const fixture = createFullNetworkBaselineFixture(fixtureName);
    const fullInput = selectConnectionsViewModel(
      fixture.cards,
      fixture.currentCardId,
    );
    const stagedInput = selectLegacyInitialConnectionsStage(fullInput).input;
    const graph = connectionsLayoutGraph(
      selectedMode === 'staged' ? stagedInput : fullInput,
    );
    const base = {
      schemaVersion: 1,
      fixture: fixtureName,
      mode: selectedMode,
      processNode: process.version,
      warmupTarget,
      measuredTarget,
      input: fullNetworkGraphShape(graph),
    } as const;
    let result: IsolatedFullNetworkLayoutResult = {
      ...base,
      status: 'running',
      failure: null,
      warmupCompleted: 0,
      layoutSamplesMs: [],
      pathSamplesMs: [],
      geometry: null,
    };
    const persist = () =>
      writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await persist();

    try {
      const runner = createMainThreadConnectionsLayoutRunner();
      let lastLayout: ConnectionsLayout | null = null;
      for (let index = 0; index < warmupTarget; index += 1) {
        lastLayout = await runner(
          graph,
          defaultConnectionsPresentation.layoutMetrics,
        );
        result = { ...result, warmupCompleted: index + 1 };
        await persist();
      }

      const layoutSamplesMs: number[] = [];
      const pathSamplesMs: number[] = [];
      for (let index = 0; index < measuredTarget; index += 1) {
        const layoutStarted = performance.now();
        lastLayout = await runner(
          graph,
          defaultConnectionsPresentation.layoutMetrics,
        );
        layoutSamplesMs.push(performance.now() - layoutStarted);
        const pathStarted = performance.now();
        const geometry = fullNetworkGeometryShape(
          lastLayout,
          defaultConnectionsPresentation.layoutMetrics,
        );
        pathSamplesMs.push(performance.now() - pathStarted);
        result = {
          ...result,
          layoutSamplesMs: [...layoutSamplesMs],
          pathSamplesMs: [...pathSamplesMs],
          geometry,
        };
        await persist();
      }
      expect(lastLayout?.nodes).toHaveLength(graph.nodes.length);
      expect(lastLayout?.edges).toHaveLength(graph.edges.length);
      result = { ...result, status: 'completed' };
      await persist();
    } catch (error: unknown) {
      result = {
        ...result,
        status: 'failed',
        failure: failureMessage(error),
      };
      await persist();
      throw error;
    }
  });
});

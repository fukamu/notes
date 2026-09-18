import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  decodeServerLoadArtifact,
  evaluateServerLoadObservation,
  serverLoadScenarios,
} from '@/tests/benchmarks/server-load-support';

describe('checked-in local server load artifact', () => {
  it('retains every required scenario and its correctness evidence', async () => {
    const source = await readFile(
      'docs/benchmarks/server-load-local.json',
      'utf8',
    );
    const candidate: unknown = JSON.parse(source);
    const artifact = decodeServerLoadArtifact(candidate);

    expect(artifact.branchPoint).toBe(
      '78a77aadbcc29aa628f25be287ece307acebf70d',
    );
    expect(artifact.observations.map(({ scenario }) => scenario)).toEqual(
      serverLoadScenarios,
    );
    expect(artifact.observations.map(evaluateServerLoadObservation)).toEqual(
      serverLoadScenarios.map((scenario) => ({ kind: 'accepted', scenario })),
    );
  });
});

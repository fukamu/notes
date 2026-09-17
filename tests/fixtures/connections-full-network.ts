import { parseCardId, type CardId } from '@/lib/domain/id';
import type { BodySegment, CardRecord } from '@/lib/domain/types';
import { invariant } from '@/lib/shared/invariant';
import {
  clientPerformanceFixtureDefaults,
  createClientPerformanceFixture,
} from '@/tests/fixtures/client-performance';

export type FullNetworkBaselineFixtureDefinition = Readonly<{
  name: string;
  source: 'generated' | 'client-performance';
  nodeCount: number;
  edgeCount: number | null;
  seed: number;
  textCharacters: number;
  componentSizes: readonly number[];
}>;

export type FullNetworkBaselineFixture = Readonly<{
  definition: FullNetworkBaselineFixtureDefinition;
  cards: CardRecord[];
  currentCardId: CardId;
}>;

const mixed257ComponentSizes = [160, 64, ...Array<number>(33).fill(1)];
const representativeComponentSizes = [
  600,
  250,
  100,
  ...Array<number>(50).fill(1),
];

export const fullNetworkBaselineFixtureDefinitions = [
  {
    name: 'boundary-64-connected',
    source: 'generated',
    nodeCount: 64,
    edgeCount: 63,
    seed: 0x4064,
    textCharacters: 64,
    componentSizes: [64],
  },
  {
    name: 'boundary-65-connected',
    source: 'generated',
    nodeCount: 65,
    edgeCount: 64,
    seed: 0x4065,
    textCharacters: 64,
    componentSizes: [65],
  },
  {
    name: 'boundary-256-connected',
    source: 'generated',
    nodeCount: 256,
    edgeCount: 255,
    seed: 0x4256,
    textCharacters: 64,
    componentSizes: [256],
  },
  {
    name: 'boundary-257-connected',
    source: 'generated',
    nodeCount: 257,
    edgeCount: 256,
    seed: 0x4257,
    textCharacters: 64,
    componentSizes: [257],
  },
  {
    name: 'boundary-257-mixed',
    source: 'generated',
    nodeCount: 257,
    edgeCount: 256,
    seed: 0x42570001,
    textCharacters: 64,
    componentSizes: mixed257ComponentSizes,
  },
  {
    name: 'representative-1000-e3000-mixed',
    source: 'generated',
    nodeCount: 1_000,
    edgeCount: 3_000,
    seed: 0x41c0ffee,
    textCharacters: 128,
    componentSizes: representativeComponentSizes,
  },
  {
    name: 'product-10000-existing',
    source: 'client-performance',
    nodeCount: clientPerformanceFixtureDefaults.cardCount,
    edgeCount: null,
    seed: clientPerformanceFixtureDefaults.seed,
    textCharacters: clientPerformanceFixtureDefaults.textCharacters,
    componentSizes: [clientPerformanceFixtureDefaults.cardCount],
  },
  {
    name: 'connected-10000-e20000',
    source: 'generated',
    nodeCount: 10_000,
    edgeCount: 20_000,
    seed: 0x41decade,
    textCharacters: 64,
    componentSizes: [10_000],
  },
] as const satisfies readonly FullNetworkBaselineFixtureDefinition[];

function fixtureCardId(index: number): CardId {
  const tail = (index + 1).toString(16).padStart(12, '0');
  return parseCardId(`0199f305-0000-7000-8000-${tail}`);
}

function nextSeed(state: number): number {
  let next = state >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

function validateDefinition(
  definition: FullNetworkBaselineFixtureDefinition,
): void {
  const describedNodes = definition.componentSizes.reduce(
    (total, size) => total + size,
    0,
  );
  if (describedNodes !== definition.nodeCount) {
    throw new RangeError(
      `${definition.name} component sizes describe ${describedNodes} nodes instead of ${definition.nodeCount}`,
    );
  }
  if (
    definition.componentSizes.some(
      (size) => !Number.isSafeInteger(size) || size <= 0,
    )
  ) {
    throw new RangeError(`${definition.name} has an invalid component size`);
  }
  if (definition.edgeCount === null) return;
  const minimumEdges = definition.componentSizes.reduce(
    (total, size) => total + Math.max(0, size - 1),
    0,
  );
  const maximumEdges = definition.componentSizes.reduce(
    (total, size) => total + size * Math.max(0, size - 1),
    0,
  );
  if (
    !Number.isSafeInteger(definition.edgeCount) ||
    definition.edgeCount < minimumEdges ||
    definition.edgeCount > maximumEdges
  ) {
    throw new RangeError(
      `${definition.name} edge count must be between ${minimumEdges} and ${maximumEdges}`,
    );
  }
}

function generatedEdges(
  definition: FullNetworkBaselineFixtureDefinition,
): readonly (readonly [number, number])[] {
  const edgeCount = definition.edgeCount;
  invariant(edgeCount, 'Generated fixture omitted edge count');
  const edges = new Set<string>();
  const components: { start: number; size: number }[] = [];
  let start = 0;
  for (const size of definition.componentSizes) {
    components.push({ start, size });
    for (let offset = 0; offset + 1 < size; offset += 1) {
      edges.add(`${start + offset}\u0000${start + offset + 1}`);
    }
    start += size;
  }
  const connectedComponents = components.filter(({ size }) => size > 1);
  let state = definition.seed >>> 0;
  while (edges.size < edgeCount) {
    state = nextSeed(state);
    const component = connectedComponents[state % connectedComponents.length];
    invariant(component, `${definition.name} has no component for an edge`);
    state = nextSeed(state);
    const sourceOffset = state % component.size;
    state = nextSeed(state);
    let targetOffset = state % (component.size - 1);
    if (targetOffset >= sourceOffset) targetOffset += 1;
    edges.add(
      `${component.start + sourceOffset}\u0000${component.start + targetOffset}`,
    );
  }
  return [...edges]
    .map((edge): readonly [number, number] => {
      const parts = edge.split('\u0000');
      const sourceText = parts[0];
      const targetText = parts[1];
      invariant(sourceText, 'Generated edge omitted source');
      invariant(targetText, 'Generated edge omitted target');
      const source = Number(sourceText);
      const target = Number(targetText);
      if (!Number.isSafeInteger(source) || !Number.isSafeInteger(target)) {
        throw new TypeError('Generated edge indices must be safe integers');
      }
      return [source, target];
    })
    .sort(
      ([leftSource, leftTarget], [rightSource, rightTarget]) =>
        leftSource - rightSource || leftTarget - rightTarget,
    );
}

function generatedCards(
  definition: FullNetworkBaselineFixtureDefinition,
): CardRecord[] {
  const ids = Array.from({ length: definition.nodeCount }, (_, index) =>
    fixtureCardId(index),
  );
  const outgoing = new Map(ids.map((id) => [id, [] as CardId[]]));
  for (const [sourceIndex, targetIndex] of generatedEdges(definition)) {
    const source = ids[sourceIndex];
    const target = ids[targetIndex];
    invariant(source, `Missing generated source ${sourceIndex}`);
    invariant(target, `Missing generated target ${targetIndex}`);
    outgoing.get(source)?.push(target);
  }
  return ids.map((id, index) => {
    const prefix = `Baseline ${String(index + 1).padStart(5, '0')} `;
    const body: BodySegment[] = [
      {
        type: 'text',
        text:
          prefix +
          '測'.repeat(Math.max(0, definition.textCharacters - prefix.length)),
      },
      ...(outgoing.get(id) ?? []).map(
        (targetCardId): BodySegment => ({ type: 'link', targetCardId }),
      ),
    ];
    return {
      id,
      displayId: { kind: 'official', value: index + 1 },
      title: `Baseline card ${String(index + 1).padStart(5, '0')}`,
      body,
      createdAt: index + 1,
      updatedAt: index + 1,
      localRevision: 1,
      serverRevision: 1,
    };
  });
}

export function createFullNetworkBaselineFixture(
  name: string,
): FullNetworkBaselineFixture {
  const definition = fullNetworkBaselineFixtureDefinitions.find(
    (candidate) => candidate.name === name,
  );
  invariant(definition, `Unknown full-network baseline fixture ${name}`);
  validateDefinition(definition);
  const cards =
    definition.source === 'client-performance'
      ? createClientPerformanceFixture()
      : generatedCards(definition);
  const current = cards[Math.floor(cards.length / 2)];
  invariant(current, `${definition.name} omitted its current card`);
  return { definition, cards, currentCardId: current.id };
}

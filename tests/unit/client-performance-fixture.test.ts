import { describe, expect, it } from 'vitest';
import {
  clientPerformanceFixtureDefaults,
  createClientPerformanceFixture,
} from '@/tests/fixtures/client-performance';

describe('10,000-card client performance fixture', () => {
  it('is deterministic, unique and representative without external data', () => {
    const first = createClientPerformanceFixture();
    const second = createClientPerformanceFixture();
    const ids = new Set(first.map((card) => card.id));

    expect(first).toEqual(second);
    expect(first).toHaveLength(10_000);
    expect(ids.size).toBe(10_000);
    expect(
      first.every(
        (card) =>
          card.body
            .filter((segment) => segment.type === 'text')
            .reduce((total, segment) => total + segment.text.length, 0) ===
          clientPerformanceFixtureDefaults.textCharacters,
      ),
    ).toBe(true);
    expect(
      first.filter((card) => card.displayId.kind === 'provisional').length,
    ).toBeGreaterThan(0);
    expect(
      first.some((card) =>
        card.body.some(
          (segment) =>
            segment.type === 'link' && !ids.has(segment.targetCardId),
        ),
      ),
    ).toBe(true);
  });

  it('supports small edge fixtures and rejects invalid scale inputs', () => {
    expect(
      createClientPerformanceFixture({
        cardCount: 0,
        seed: 1,
        textCharacters: 0,
      }),
    ).toEqual([]);
    expect(
      createClientPerformanceFixture({
        cardCount: 1,
        seed: 1,
        textCharacters: 12,
      })[0]?.body,
    ).toEqual([{ type: 'text', text: 'Card 00001 深' }]);
    expect(() =>
      createClientPerformanceFixture({
        cardCount: -1,
        seed: 1,
        textCharacters: 1,
      }),
    ).toThrow(/cardCount/u);
    expect(() =>
      createClientPerformanceFixture({
        cardCount: 1,
        seed: 1,
        textCharacters: 1_001,
      }),
    ).toThrow(/textCharacters/u);
    expect(() =>
      createClientPerformanceFixture({
        cardCount: 1,
        seed: 0x1_0000_0000,
        textCharacters: 1,
      }),
    ).toThrow(/seed/u);
  });
});

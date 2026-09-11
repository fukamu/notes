import { describe, expect, it } from 'vitest';
import {
  createConnectionsSvgPath,
  normalizeConnectionsOrthogonalPoints,
  sampleConnectionsSvgPath,
} from '@/lib/graph/connections-path';
import type { ConnectionsLayoutSection } from '@/lib/graph/elk-layout';

function section(
  startPoint: { x: number; y: number },
  bendPoints: { x: number; y: number }[],
  endPoint: { x: number; y: number },
): ConnectionsLayoutSection {
  return { id: 'section-test', startPoint, bendPoints, endPoint };
}

const options = { maximumRadius: 16, nodeClearance: 44 };

describe('connections SVG paths', () => {
  it('replaces a real corner with a quadratic and preserves endpoints and end tangent', () => {
    const path = createConnectionsSvgPath(
      section({ x: 0, y: 0 }, [{ x: 10, y: 0 }], { x: 10, y: 10 }),
      options,
    );

    expect(path.d).toBe('M 0 0 L 5 0 Q 10 0 10 5 L 10 10');
    expect(path.startPoint).toEqual({ x: 0, y: 0 });
    expect(path.endPoint).toEqual({ x: 10, y: 10 });
    expect(path.quadraticCount).toBe(1);
    expect(path.segments.at(-1)).toEqual({
      kind: 'line',
      start: { x: 10, y: 5 },
      end: { x: 10, y: 10 },
    });
  });

  it('clamps radius by node clearance and both adjacent segment lengths', () => {
    const clearanceClamped = createConnectionsSvgPath(
      section({ x: 0, y: 0 }, [{ x: 100, y: 0 }], { x: 100, y: 100 }),
      { maximumRadius: 30, nodeClearance: 20 },
    );
    const shortClamped = createConnectionsSvgPath(
      section({ x: 0, y: 0 }, [{ x: 4, y: 0 }], { x: 4, y: 100 }),
      options,
    );

    expect(clearanceClamped.d).toContain('L 90 0 Q 100 0 100 10');
    expect(shortClamped.d).toContain('L 2 0 Q 4 0 4 2');
  });

  it('removes duplicates and forward-collinear points without mutating input', () => {
    const input = section(
      { x: 0, y: 0 },
      [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      { x: 10, y: 20 },
    );
    const snapshot = structuredClone(input);

    expect(normalizeConnectionsOrthogonalPoints(input)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 20 },
    ]);
    const path = createConnectionsSvgPath(input, options);

    expect(path.d).toBe('M 0 0 L 5 0 Q 10 0 10 5 L 10 20');
    expect(input).toEqual(snapshot);
  });

  it('keeps very short segments finite without overshooting', () => {
    const path = createConnectionsSvgPath(
      section({ x: 0, y: 0 }, [{ x: 0.04, y: 0 }], { x: 0.04, y: 1 }),
      options,
    );

    expect(path.quadraticCount).toBe(0);
    expect(path.d).toBe('M 0 0 L 0.04 0 L 0.04 1');
    expect(path.d).not.toMatch(/NaN|Infinity/);
  });

  it('keeps a self-loop closed, curved, finite, and non-degenerate', () => {
    const path = createConnectionsSvgPath(
      section(
        { x: 0, y: 0 },
        [
          { x: 20, y: 0 },
          { x: 20, y: 20 },
          { x: 0, y: 20 },
        ],
        { x: 0, y: 0 },
      ),
      options,
    );
    const sampled = sampleConnectionsSvgPath(path, 12);

    expect(path.startPoint).toEqual(path.endPoint);
    expect(path.quadraticCount).toBe(3);
    expect(
      new Set(sampled.map(({ x, y }) => `${x},${y}`)).size,
    ).toBeGreaterThan(12);
    expect(
      sampled.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)),
    ).toBe(true);
  });

  it('preserves a U-turn instead of collapsing it as collinear', () => {
    const input = section({ x: 0, y: 0 }, [{ x: 10, y: 0 }], { x: 0, y: 0 });
    const path = createConnectionsSvgPath(input, options);

    expect(normalizeConnectionsOrthogonalPoints(input)).toHaveLength(3);
    expect(path.d).toBe('M 0 0 L 10 0 L 0 0');
    expect(path.segments).toHaveLength(2);
  });

  it('emits at most two segments per input point for a long route', () => {
    const bendPoints = Array.from({ length: 2_000 }, (_, index) => ({
      x: index % 2 === 0 ? index : index - 1,
      y: index,
    }));
    const path = createConnectionsSvgPath(
      section({ x: 0, y: -1 }, bendPoints, { x: 2_000, y: 2_000 }),
      options,
    );

    expect(path.segments.length).toBeLessThanOrEqual(
      2 * (bendPoints.length + 2),
    );
    expect(path.d).not.toMatch(/NaN|Infinity/);
  });

  it('rejects non-finite geometry, invisible routes, and invalid options', () => {
    expect(() =>
      createConnectionsSvgPath(
        section({ x: 0, y: 0 }, [], { x: Number.NaN, y: 1 }),
        options,
      ),
    ).toThrow('non-finite point');
    expect(() =>
      createConnectionsSvgPath(
        section({ x: 1, y: 1 }, [{ x: 1, y: 1 }], { x: 1, y: 1 }),
        options,
      ),
    ).toThrow('no visible route');
    expect(() =>
      createConnectionsSvgPath(section({ x: 0, y: 0 }, [], { x: 1, y: 1 }), {
        maximumRadius: -1,
        nodeClearance: 2,
      }),
    ).toThrow('radius and clearance must be finite');
  });
});

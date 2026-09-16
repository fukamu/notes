/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VaultNotesScope } from '@/lib/application/notes-access';
import { createFullNetworkAccessibilityAdapter } from '@/lib/client/full-network-accessibility-adapter';
import {
  parseAccountId,
  parseSessionEpoch,
  parseSessionId,
  parseVaultId,
} from '@/lib/domain/identity';
import type { CardId } from '@/lib/domain/id';
import type { ConnectionsInputModel } from '@/lib/graph/connections-contract';
import { createFullNetworkAccessibilityIndex } from '@/lib/graph/full-network-accessibility';
import {
  createFullNetworkTopology,
  defaultFullNetworkLayoutConfiguration,
  layoutFullNetworkTopology,
} from '@/lib/graph/full-network-layout';
import {
  createFullNetworkRenderDataset,
  createFullNetworkRenderPlan,
} from '@/lib/graph/full-network-render-plan';
import { createFullNetworkRouting } from '@/lib/graph/full-network-routing';
import { fixtureCardId } from '@/tests/fixtures/ids';

const scope: VaultNotesScope = {
  kind: 'vault',
  accountId: parseAccountId('01991f20-61d2-7000-8000-000000009101'),
  vaultId: parseVaultId('01991f20-61d2-7000-8000-000000009201'),
  sessionId: parseSessionId('01991f20-61d2-7000-8000-000000009301'),
  sessionEpoch: parseSessionEpoch(1),
};

class FakeMediaQueryList extends EventTarget implements MediaQueryList {
  readonly media: string;
  matches: boolean;
  onchange: MediaQueryList['onchange'] = null;
  addListener: MediaQueryList['addListener'] = () => undefined;
  removeListener: MediaQueryList['removeListener'] = () => undefined;

  constructor(media: string, matches: boolean) {
    super();
    this.media = media;
    this.matches = matches;
  }
}

function createFixture() {
  const ids = Array.from({ length: 12 }, (_, index) =>
    fixtureCardId(`full-network-accessibility-adapter-${index}`),
  );
  const id = (index: number): CardId => {
    const value = ids[index];
    if (!value) throw new Error(`Missing adapter fixture ${index}`);
    return value;
  };
  const input: ConnectionsInputModel = {
    currentCardId: id(0),
    nodes: ids.map((cardId, index) => ({
      cardId,
      displayLabel: `#${index + 1}`,
      title: `Adapter card ${index + 1}`,
      accessibleName: `Adapter card ${index + 1}`,
      current: index === 0,
    })),
    edges: Array.from({ length: 10 }, (_, index) => ({
      sourceCardId: id(index),
      targetCardId: id(index + 1),
      accessibleName: `Adapter link ${index + 1}`,
    })),
  };
  const topology = createFullNetworkTopology(input);
  const layout = layoutFullNetworkTopology(topology);
  const dataset = createFullNetworkRenderDataset(
    createFullNetworkRouting(
      topology,
      layout,
      defaultFullNetworkLayoutConfiguration,
    ),
  );
  const plan = createFullNetworkRenderPlan({
    dataset,
    camera: {
      offsetX: 320,
      offsetY: 210,
      scale: 6,
      viewportWidth: 640,
      viewportHeight: 420,
    },
    currentCardId: id(0),
    selectedCardId: null,
    reducedMotion: false,
  });
  return {
    ids,
    input,
    dataset,
    plan,
    index: createFullNetworkAccessibilityIndex(input, dataset),
  };
}

function createElements() {
  const region = document.createElement('section');
  const overlay = document.createElement('div');
  const summary = document.createElement('p');
  const liveRegion = document.createElement('p');
  const statusRegion = document.createElement('div');
  region.appendChild(overlay);
  document.body.appendChild(region);
  document.body.appendChild(summary);
  document.body.appendChild(liveRegion);
  document.body.appendChild(statusRegion);
  return { region, overlay, summary, liveRegion, statusRegion };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('full-network accessibility browser adapter', () => {
  it('exposes one named region and drives bounded keyboard selection and open', () => {
    const value = createFixture();
    const elements = createElements();
    const selected: CardId[] = [];
    const opened: CardId[] = [];
    const changed = vi.fn();
    const adapter = createFullNetworkAccessibilityAdapter({
      scope,
      ...elements,
      index: value.index,
      dataset: value.dataset,
      plan: value.plan,
      availability: {
        layout: { status: 'ready', hasCompleteLayout: true },
        renderer: { status: 'ready' },
      },
      mediaQueryFactory: (query) => new FakeMediaQueryList(query, false),
      onSelectCard: (cardId) => selected.push(cardId),
      onOpenCard: (cardId) => opened.push(cardId),
      onRetry: vi.fn(),
      onPreferences: vi.fn(),
      onChange: changed,
    });

    expect(elements.region.getAttribute('role')).toBe('region');
    expect(elements.region.getAttribute('aria-label')).toBe('つながりマップ');
    expect(elements.summary.textContent).toContain('全12枚、全10本');
    expect(elements.overlay.childElementCount).toBeLessThan(12);
    elements.region.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', bubbles: true }),
    );
    expect(selected.at(-1)).toBe(value.ids[1]);
    elements.region.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'e', bubbles: true }),
    );
    expect(elements.liveRegion.textContent).toContain('リンク 1/10');
    adapter.update({
      scope,
      index: value.index,
      dataset: value.dataset,
      plan: value.plan,
      availability: {
        layout: { status: 'ready', hasCompleteLayout: true },
        renderer: { status: 'ready' },
      },
    });
    expect(elements.liveRegion.textContent).toContain('リンク 1/10');
    elements.region.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(opened.at(-1)).toBe(value.ids[0]);
    expect(changed).toHaveBeenCalled();

    adapter.destroy();
    expect(elements.overlay.childElementCount).toBe(0);
    expect(elements.summary.textContent).toBe('');
    expect(elements.region.hasAttribute('role')).toBe(false);
  });

  it('offers one explicit retry, preserves complete stale UX and rejects scope changes', () => {
    const value = createFixture();
    const elements = createElements();
    const retry = vi.fn();
    const adapter = createFullNetworkAccessibilityAdapter({
      scope,
      ...elements,
      index: value.index,
      dataset: value.dataset,
      plan: value.plan,
      availability: {
        layout: {
          status: 'error',
          hasCompleteLayout: true,
          reason: 'invalid-response',
        },
        renderer: { status: 'ready' },
      },
      mediaQueryFactory: (query) =>
        new FakeMediaQueryList(query, query.includes('reduce')),
      onSelectCard: vi.fn(),
      onOpenCard: vi.fn(),
      onRetry: retry,
      onPreferences: vi.fn(),
    });

    expect(elements.statusRegion.getAttribute('role')).toBe('status');
    const button = elements.statusRegion.querySelector('button');
    if (!button) throw new Error('Expected retry button');
    button.click();
    button.click();
    expect(retry).toHaveBeenCalledTimes(1);
    const pendingButton = elements.statusRegion.querySelector('button');
    if (!pendingButton) throw new Error('Expected pending retry button');
    expect(pendingButton.disabled).toBe(true);
    expect(adapter.getState().preferences.reducedMotion).toBe(true);

    expect(() =>
      adapter.update({
        scope: {
          ...scope,
          sessionEpoch: parseSessionEpoch(2),
        },
        index: value.index,
        dataset: value.dataset,
        plan: value.plan,
        availability: {
          layout: { status: 'ready', hasCompleteLayout: true },
          renderer: { status: 'ready' },
        },
      }),
    ).toThrow('scope mismatch');
    adapter.destroy();
  });
});

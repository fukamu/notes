/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { HistoryView } from '@/components/history-view';
import type { HistoryViewModel } from '@/lib/application/presentation';
import { historyWindowLayout } from '@/lib/application/history-window';
import { fixtureCardId } from '@/tests/fixtures/ids';
import { createNotesViewStatePorts } from '@/lib/client/notes-view-state';

type ResizeRegistration = Readonly<{
  observer: FixtureResizeObserver;
  callback: ResizeObserverCallback;
}>;

const resizeRegistrations = new Set<ResizeRegistration>();
const originalClientHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'clientHeight',
);
let historyViewportHeight = 480;
let root: Root | undefined;

class FixtureResizeObserver implements ResizeObserver {
  readonly registration: ResizeRegistration;

  constructor(callback: ResizeObserverCallback) {
    this.registration = { observer: this, callback };
    resizeRegistrations.add(this.registration);
  }

  disconnect(): void {
    resizeRegistrations.delete(this.registration);
  }

  observe(): void {}

  unobserve(): void {}

  takeRecords(): ResizeObserverEntry[] {
    return [];
  }
}

function notifyResizeObservers(): void {
  for (const registration of resizeRegistrations) {
    registration.callback([], registration.observer);
  }
}

function historyModel(currentIndex: number): HistoryViewModel {
  const items = Array.from({ length: 10_000 }, (_, index) => ({
    cardId: fixtureCardId(`history-window-${index}`),
    displayLabel: `#${10_000 - index}`,
    displayValue: 10_000 - index,
    title: `履歴カード ${10_000 - index}`,
    preview: `本文 ${10_000 - index}`,
    current: index === currentIndex,
  }));
  return {
    currentCardId: items[currentIndex]?.cardId ?? null,
    items,
  };
}

function historyList(): HTMLDivElement {
  const element = document.querySelector('[data-testid="history-list"]');
  if (!(element instanceof HTMLDivElement)) {
    throw new Error('History list did not render');
  }
  return element;
}

function renderedButtons(): NodeListOf<HTMLButtonElement> {
  return historyList().querySelectorAll('button[data-card-id]');
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: FixtureResizeObserver,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => historyViewportHeight,
  });
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
  historyViewportHeight = 480;
  resizeRegistrations.clear();
});

afterAll(() => {
  if (originalClientHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      'clientHeight',
      originalClientHeight,
    );
  }
});

describe('history windowing adapter', () => {
  it('bounds 10k rows while preserving centering, scrolling, keyboard and cleanup', () => {
    const model = historyModel(5_000);
    const onOpenCard = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const position = createNotesViewStatePorts(model.currentCardId).history;
    act(() =>
      root?.render(createElement(HistoryView, { model, onOpenCard, position })),
    );

    const list = historyList();
    expect(list.dataset.historyTotalCount).toBe('10000');
    expect(renderedButtons().length).toBeLessThanOrEqual(13);
    const current = list.querySelector('button[data-current="true"]');
    expect(current).toBeInstanceOf(HTMLButtonElement);
    expect(list.scrollTop).toBeGreaterThan(0);
    expect(list.querySelector('ol')?.getAttribute('aria-label')).toBe(
      '過去のカード一覧',
    );
    expect(current?.closest('li')?.getAttribute('aria-setsize')).toBe('10000');
    expect(current?.closest('li')?.getAttribute('aria-posinset')).toBe('5001');

    act(() => {
      list.scrollTop =
        historyWindowLayout.contentPadding +
        9_000 * (historyWindowLayout.rowHeight + historyWindowLayout.rowGap);
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(Number(list.dataset.historyWindowStart)).toBeGreaterThanOrEqual(
      8_996,
    );
    expect(renderedButtons().length).toBeLessThanOrEqual(13);

    historyViewportHeight = 720;
    act(() => notifyResizeObservers());
    expect(renderedButtons().length).toBeLessThanOrEqual(15);
    expect(list.scrollTop).toBe(
      historyWindowLayout.contentPadding +
        9_000 * (historyWindowLayout.rowHeight + historyWindowLayout.rowGap),
    );

    const visibleButton = list.querySelector('button[data-card-id]');
    if (!(visibleButton instanceof HTMLButtonElement)) {
      throw new Error('Visible history button is missing');
    }
    act(() => {
      visibleButton.focus();
      visibleButton.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      );
    });
    expect(document.activeElement?.getAttribute('data-display-value')).toBe(
      '1',
    );
    expect(renderedButtons().length).toBeLessThanOrEqual(15);

    const lastButton = document.activeElement;
    if (!(lastButton instanceof HTMLButtonElement)) {
      throw new Error('Last history button did not receive focus');
    }
    act(() => {
      lastButton.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      );
    });
    expect(document.activeElement?.getAttribute('data-display-value')).toBe(
      '10000',
    );
    const firstButton = document.activeElement;
    if (!(firstButton instanceof HTMLButtonElement)) {
      throw new Error('First history button did not receive focus');
    }
    act(() => firstButton.click());
    expect(onOpenCard).toHaveBeenCalledWith(model.items[0]?.cardId);

    act(() => root?.unmount());
    root = undefined;
    expect(container.querySelector('[data-testid="history-list"]')).toBeNull();
    expect(resizeRegistrations.size).toBe(0);
  });
});

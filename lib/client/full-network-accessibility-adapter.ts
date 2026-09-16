'use client';

import type { VaultNotesScope } from '@/lib/application/notes-access';
import type { CardId } from '@/lib/domain/id';
import {
  createFullNetworkAccessibilityOverlay,
  deriveFullNetworkAvailability,
  describeFullNetworkAccessibility,
  initialFullNetworkAccessibilityCursor,
  transitionFullNetworkAccessibilityCursor,
  type FullNetworkAccessibilityCursor,
  type FullNetworkAccessibilityIndex,
  type FullNetworkAvailability,
  type FullNetworkAvailabilityInput,
} from '@/lib/graph/full-network-accessibility';
import type {
  FullNetworkRenderDataset,
  FullNetworkRenderPlan,
} from '@/lib/graph/full-network-render-plan';

export type FullNetworkAccessibilityPreferences = Readonly<{
  reducedMotion: boolean;
  highContrast: boolean;
}>;

export type FullNetworkAccessibilityAdapterState = Readonly<{
  cursor: FullNetworkAccessibilityCursor;
  availability: FullNetworkAvailability;
  overlayCount: number;
  retryPending: boolean;
  preferences: FullNetworkAccessibilityPreferences;
}>;

export type FullNetworkAccessibilityAdapter = Readonly<{
  getState: () => FullNetworkAccessibilityAdapterState;
  update: (input: {
    scope: VaultNotesScope;
    index: FullNetworkAccessibilityIndex;
    dataset: FullNetworkRenderDataset;
    plan: FullNetworkRenderPlan;
    availability: FullNetworkAvailabilityInput;
  }) => void;
  focus: () => void;
  destroy: () => void;
}>;

type MediaQueryFactory = (query: string) => MediaQueryList;

function sameScope(left: VaultNotesScope, right: VaultNotesScope): boolean {
  return (
    left.accountId === right.accountId &&
    left.vaultId === right.vaultId &&
    left.sessionId === right.sessionId &&
    left.sessionEpoch === right.sessionEpoch
  );
}

function keyboardEvent(event: KeyboardEvent):
  | Readonly<{
      kind: 'navigate';
      event: Parameters<typeof transitionFullNetworkAccessibilityCursor>[3];
    }>
  | Readonly<{ kind: 'open' }>
  | null {
  if (event.ctrlKey || event.metaKey) return null;
  if (event.altKey) {
    switch (event.key) {
      case 'ArrowLeft':
        return { kind: 'navigate', event: { type: 'move', direction: 'left' } };
      case 'ArrowRight':
        return {
          kind: 'navigate',
          event: { type: 'move', direction: 'right' },
        };
      case 'ArrowUp':
        return { kind: 'navigate', event: { type: 'move', direction: 'up' } };
      case 'ArrowDown':
        return { kind: 'navigate', event: { type: 'move', direction: 'down' } };
      default:
        return null;
    }
  }
  switch (event.key.toLowerCase()) {
    case 'n':
      return {
        kind: 'navigate',
        event: { type: 'next-node', direction: event.shiftKey ? -1 : 1 },
      };
    case 'e':
      return {
        kind: 'navigate',
        event: { type: 'next-edge', direction: event.shiftKey ? -1 : 1 },
      };
    case 'l':
      return {
        kind: 'navigate',
        event: { type: 'next-neighbor', direction: event.shiftKey ? -1 : 1 },
      };
    case 'c':
      return {
        kind: 'navigate',
        event: { type: 'next-component', direction: event.shiftKey ? -1 : 1 },
      };
    case 'home':
      return { kind: 'navigate', event: { type: 'select-current' } };
    case 'escape':
      return { kind: 'navigate', event: { type: 'clear-edge' } };
    case 'enter':
      return { kind: 'open' };
    default:
      return null;
  }
}

function ensureIdentifier(element: HTMLElement, fallback: string): string {
  if (element.id.length === 0) element.id = fallback;
  return element.id;
}

function buttonForOverlay(
  item: ReturnType<typeof createFullNetworkAccessibilityOverlay>[number],
  onSelect: (cardId: CardId) => void,
  onOpen: (cardId: CardId) => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.fullNetworkNode = item.cardId;
  button.dataset.nodeIndex = String(item.nodeIndex);
  button.setAttribute('aria-label', item.accessibleName);
  if (item.current) button.setAttribute('aria-current', 'true');
  if (item.selected) button.setAttribute('aria-pressed', 'true');
  button.style.position = 'absolute';
  button.style.left = `${item.screenX}px`;
  button.style.top = `${item.screenY}px`;
  button.style.width = '44px';
  button.style.height = '44px';
  button.style.transform = 'translate(-50%, -50%)';
  button.style.border = '1px solid transparent';
  button.style.borderRadius = '999px';
  button.style.background = 'transparent';
  button.style.color = 'transparent';
  button.style.pointerEvents = 'auto';
  button.style.touchAction = 'manipulation';
  button.textContent = `${item.displayLabel} ${item.title}`;
  button.addEventListener('focus', () => onSelect(item.cardId));
  button.addEventListener('click', () => onOpen(item.cardId));
  return button;
}

export function createFullNetworkAccessibilityAdapter(
  input: Readonly<{
    scope: VaultNotesScope;
    region: HTMLElement;
    overlay: HTMLElement;
    summary: HTMLElement;
    liveRegion: HTMLElement;
    statusRegion: HTMLElement;
    index: FullNetworkAccessibilityIndex;
    dataset: FullNetworkRenderDataset;
    plan: FullNetworkRenderPlan;
    availability: FullNetworkAvailabilityInput;
    selectedCardId?: CardId | null;
    mediaQueryFactory?: MediaQueryFactory;
    onSelectCard: (cardId: CardId) => void;
    onOpenCard: (cardId: CardId) => void;
    onRetry: () => void;
    onPreferences: (preferences: FullNetworkAccessibilityPreferences) => void;
    onChange?: (state: FullNetworkAccessibilityAdapterState) => void;
  }>,
): FullNetworkAccessibilityAdapter {
  const scope = input.scope;
  let index = input.index;
  let dataset = input.dataset;
  let plan = input.plan;
  let cursor = initialFullNetworkAccessibilityCursor(
    index,
    input.selectedCardId,
  );
  let availability = deriveFullNetworkAvailability(input.availability);
  let overlayCount = 0;
  let retryPending = false;
  let destroyed = false;
  const matchMedia = input.mediaQueryFactory ?? window.matchMedia.bind(window);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const forcedColors = matchMedia('(forced-colors: active)');
  const moreContrast = matchMedia('(prefers-contrast: more)');
  let preferences: FullNetworkAccessibilityPreferences = {
    reducedMotion: reducedMotion.matches,
    highContrast: forcedColors.matches || moreContrast.matches,
  };
  const summaryId = ensureIdentifier(
    input.summary,
    'full-network-accessibility-summary',
  );
  const liveId = ensureIdentifier(
    input.liveRegion,
    'full-network-accessibility-selection',
  );

  const state = (): FullNetworkAccessibilityAdapterState => ({
    cursor,
    availability,
    overlayCount,
    retryPending,
    preferences,
  });
  const publish = (): void => input.onChange?.(state());

  const announce = (): void => {
    const message = describeFullNetworkAccessibility(index, cursor, plan.level);
    input.summary.textContent = message.summary;
    input.liveRegion.textContent = message.selection;
  };

  const selectCard = (cardId: CardId): void => {
    cursor = transitionFullNetworkAccessibilityCursor(index, dataset, cursor, {
      type: 'select-card',
      cardId,
    });
    announce();
    input.onSelectCard(cardId);
    publish();
  };

  const openCard = (cardId: CardId): void => {
    selectCard(cardId);
    input.onOpenCard(cardId);
  };

  const renderOverlay = (): void => {
    input.overlay.replaceChildren();
    if (availability.kind !== 'ready' && availability.kind !== 'stale') {
      overlayCount = 0;
      input.overlay.dataset.nodeCount = '0';
      return;
    }
    const items = createFullNetworkAccessibilityOverlay(index, dataset, plan);
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      fragment.append(buttonForOverlay(item, selectCard, openCard));
    }
    input.overlay.appendChild(fragment);
    overlayCount = items.length;
    input.overlay.dataset.nodeCount = String(overlayCount);
  };

  const retry = (): void => {
    if (retryPending) return;
    if (
      (availability.kind !== 'error' && availability.kind !== 'stale') ||
      !availability.retryable
    ) {
      return;
    }
    retryPending = true;
    renderStatus();
    publish();
    input.onRetry();
  };

  function renderStatus(): void {
    input.statusRegion.replaceChildren();
    input.statusRegion.removeAttribute('role');
    input.region.removeAttribute('aria-busy');
    if (availability.kind === 'ready') return;
    const message = document.createElement('p');
    message.textContent = availability.message;
    input.statusRegion.appendChild(message);
    if (availability.kind === 'loading') {
      input.region.setAttribute('aria-busy', 'true');
      input.statusRegion.setAttribute('role', 'status');
      return;
    }
    input.statusRegion.setAttribute(
      'role',
      availability.kind === 'stale' ? 'status' : 'alert',
    );
    if (
      (availability.kind === 'error' || availability.kind === 'stale') &&
      availability.retryable
    ) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = retryPending ? '再試行中' : '再試行';
      button.disabled = retryPending;
      button.addEventListener('click', retry);
      input.statusRegion.appendChild(button);
    }
  }

  const render = (): void => {
    announce();
    renderOverlay();
    renderStatus();
    input.region.dataset.semanticLevel = plan.level;
    input.region.dataset.accessibilityNodeCount = String(index.nodes.length);
    input.region.dataset.accessibilityEdgeCount = String(index.edges.length);
    input.region.dataset.accessibilityOverlayCount = String(overlayCount);
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.target !== input.region) return;
    const action = keyboardEvent(event);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (action.kind === 'open') {
      if (cursor.nodeIndex !== null) {
        input.onOpenCard(nodeCardId(index, cursor.nodeIndex));
      }
      return;
    }
    cursor = transitionFullNetworkAccessibilityCursor(
      index,
      dataset,
      cursor,
      action.event,
    );
    announce();
    if (cursor.nodeIndex !== null) {
      input.onSelectCard(nodeCardId(index, cursor.nodeIndex));
    }
    publish();
  };

  const refreshPreferences = (): void => {
    preferences = {
      reducedMotion: reducedMotion.matches,
      highContrast: forcedColors.matches || moreContrast.matches,
    };
    input.region.dataset.reducedMotion = String(preferences.reducedMotion);
    input.region.dataset.highContrast = String(preferences.highContrast);
    input.onPreferences(preferences);
    publish();
  };

  input.region.tabIndex = 0;
  input.region.setAttribute('role', 'region');
  input.region.setAttribute('aria-label', 'つながりマップ');
  input.region.setAttribute('aria-describedby', `${summaryId} ${liveId}`);
  input.region.setAttribute(
    'aria-keyshortcuts',
    'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown N Shift+N E Shift+E L Shift+L C Shift+C Home Enter Escape',
  );
  input.liveRegion.setAttribute('aria-live', 'polite');
  input.liveRegion.setAttribute('aria-atomic', 'true');
  input.overlay.style.position = 'absolute';
  input.overlay.style.inset = '0';
  input.overlay.style.pointerEvents = 'none';
  input.overlay.setAttribute('aria-label', '画面内のカード');
  input.overlay.addEventListener('focusin', () => {
    input.overlay.style.pointerEvents = 'auto';
  });
  input.overlay.addEventListener('focusout', () => {
    input.overlay.style.pointerEvents = 'none';
  });
  input.region.addEventListener('keydown', handleKeyDown, true);
  reducedMotion.addEventListener('change', refreshPreferences);
  forcedColors.addEventListener('change', refreshPreferences);
  moreContrast.addEventListener('change', refreshPreferences);
  render();
  refreshPreferences();

  return {
    getState: state,
    update(next) {
      if (destroyed) throw new Error('Accessibility adapter is destroyed');
      if (!sameScope(scope, next.scope)) {
        throw new Error('Full-network accessibility scope mismatch');
      }
      const selectedCardId =
        cursor.nodeIndex === null
          ? null
          : nodeCardIdFromPrevious(index, cursor.nodeIndex);
      index = next.index;
      dataset = next.dataset;
      plan = next.plan;
      availability = deriveFullNetworkAvailability(next.availability);
      retryPending = false;
      cursor = initialFullNetworkAccessibilityCursor(index, selectedCardId);
      render();
      publish();
    },
    focus: () => input.region.focus(),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      input.region.removeEventListener('keydown', handleKeyDown, true);
      reducedMotion.removeEventListener('change', refreshPreferences);
      forcedColors.removeEventListener('change', refreshPreferences);
      moreContrast.removeEventListener('change', refreshPreferences);
      input.overlay.replaceChildren();
      input.statusRegion.replaceChildren();
      input.summary.textContent = '';
      input.liveRegion.textContent = '';
      input.region.removeAttribute('aria-busy');
      input.region.removeAttribute('aria-describedby');
      input.region.removeAttribute('aria-keyshortcuts');
      input.region.removeAttribute('aria-label');
      input.region.removeAttribute('role');
      delete input.region.dataset.semanticLevel;
      delete input.region.dataset.accessibilityNodeCount;
      delete input.region.dataset.accessibilityEdgeCount;
      delete input.region.dataset.accessibilityOverlayCount;
      delete input.region.dataset.reducedMotion;
      delete input.region.dataset.highContrast;
      overlayCount = 0;
      publish();
    },
  };
}

function nodeCardId(
  index: FullNetworkAccessibilityIndex,
  nodeIndex: number,
): CardId {
  const node = index.nodes[nodeIndex];
  if (!node) throw new Error(`Missing accessible node at ${nodeIndex}`);
  return node.cardId;
}

function nodeCardIdFromPrevious(
  index: FullNetworkAccessibilityIndex,
  nodeIndex: number,
): CardId | null {
  return index.nodes[nodeIndex]?.cardId ?? null;
}

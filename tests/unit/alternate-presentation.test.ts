import { describe, expect, it, vi } from 'vitest';
import type {
  CardEditorRendererProps,
  ConnectionsRendererProps,
  NotesPresentationProps,
} from '@/components/presentation-contract';
import type {
  ConflictViewModel,
  NotesPresentationActions,
  NotesPresentationModel,
} from '@/lib/application/presentation';
import type { ConnectionsControllerState } from '@/lib/graph/connections-contract';
import { createCardEditorCandidateIndex } from '@/lib/application/card-editor-index';
import { invariant } from '@/lib/shared/invariant';
import { fixtureCardId, fixtureConflictId } from '@/tests/fixtures/ids';
import {
  alternateNotesAppConfiguration,
  createAlternateCardEditorProbe,
  createAlternateConnectionsProbe,
  createAlternatePresentationProbe,
} from '@/tests/fixtures/alternate-presentation';

const firstId = fixtureCardId('alternate-first');
const secondId = fixtureCardId('alternate-second');
const conflictId = fixtureConflictId('alternate');

function actions(): NotesPresentationActions {
  return {
    createCard: vi.fn(async () => undefined),
    openCard: vi.fn(),
    showCurrentCard: vi.fn(),
    showHistory: vi.fn(),
    showConnections: vi.fn(),
    updateTitle: vi.fn(),
    updateBody: vi.fn(),
    retrySync: vi.fn(async () => undefined),
    resolveConflict: vi.fn(),
  };
}

function model(
  location: NotesPresentationModel['location'],
): NotesPresentationModel {
  const currentCard = {
    id: firstId,
    displayId: { kind: 'official' as const, value: 1 },
    title: 'First',
    body: [],
    createdAt: 1,
    updatedAt: 1,
    localRevision: 1,
    serverRevision: 1,
  };
  const candidateCard = {
    ...currentCard,
    id: secondId,
    displayId: { kind: 'official' as const, value: 2 },
    title: 'Second',
    createdAt: 2,
    updatedAt: 2,
  };
  const activeView = location.kind === 'empty' ? 'card' : location.kind;
  const common = {
    initialized: true,
    location,
    availableViews: { card: true, history: true, connections: true },
    currentCard,
    currentCardDisplayLabel: '#1',
    status: {
      kind: 'sync-failed' as const,
      label: 'Sync failed',
      retryable: true as const,
    },
  };
  const cardEditor = {
    cardId: firstId,
    title: 'First',
    body: [],
    labels: [
      { cardId: firstId, label: '#1 First' },
      { cardId: secondId, label: '#2 Second' },
    ],
    candidateIndex: createCardEditorCandidateIndex(
      [currentCard, candidateCard],
      firstId,
    ),
  };
  const history = {
    currentCardId: firstId,
    items: [
      {
        cardId: firstId,
        displayLabel: '#1',
        displayValue: 1,
        title: 'First',
        preview: 'Body',
        current: true,
      },
    ],
  };
  const conflicts: ConflictViewModel[] = [
    {
      conflictId,
      cardId: firstId,
      resolutionState: 'ready',
      options: [
        {
          choice: 'local',
          heading: '編集案 A',
          title: 'Local',
          preview: 'Local body',
          accessibleName: 'Localを使う',
        },
        {
          choice: 'server',
          heading: '編集案 B',
          title: 'Server',
          preview: 'Server body',
          accessibleName: 'Serverを使う',
        },
      ],
    },
  ];
  const connections = {
    currentCardId: firstId,
    nodes: [
      {
        cardId: firstId,
        displayLabel: '#1',
        title: 'First',
        accessibleName: '#1 First、現在のカード',
        current: true,
      },
    ],
    edges: [],
  };

  switch (activeView) {
    case 'card':
      return {
        ...common,
        activeView,
        cardEditor,
        history: null,
        conflicts,
        connections: null,
      };
    case 'history':
      return {
        ...common,
        activeView,
        cardEditor: null,
        history,
        conflicts: [],
        connections: null,
      };
    case 'connections':
      return {
        ...common,
        activeView,
        cardEditor: null,
        history: null,
        conflicts: [],
        connections,
      };
  }
}

function presentationProps(
  location: NotesPresentationModel['location'],
): NotesPresentationProps {
  return {
    model: model(location),
    actions: actions(),
    features: {
      renderCardEditor: vi.fn(() => 'alternate editor feature'),
      renderConnections: vi.fn(() => 'alternate connections feature'),
    },
  };
}

function controllerState(
  status: ConnectionsControllerState['status'],
): ConnectionsControllerState {
  const connections = model({
    kind: 'connections',
    cardId: firstId,
  }).connections;
  invariant(connections, 'Alternate fixture requires connections');
  const fallbackItems = connections.nodes;
  const firstItem = fallbackItems[0];
  invariant(firstItem, 'Alternate fixture requires one connection node');
  const base = {
    layoutKey: 'alternate-layout',
    currentCardId: firstId,
    fallbackItems,
  };
  if (status !== 'ready') return { ...base, status };
  const node = {
    ...firstItem,
    x: 10,
    y: 20,
    width: 148,
    height: 56,
    ports: [],
  };
  return {
    ...base,
    status,
    geometry: {
      width: 200,
      height: 120,
      nodes: [
        {
          id: firstId,
          x: 10,
          y: 20,
          width: 148,
          height: 56,
          ports: [],
        },
      ],
      edges: [
        {
          sourceCardId: firstId,
          targetCardId: firstId,
          id: 'edge-0',
          sourcePortId: 'source-0',
          targetPortId: 'target-0',
          sections: [],
        },
      ],
    },
    width: 200,
    height: 120,
    nodes: [node],
    edges: [
      {
        sourceCardId: firstId,
        targetCardId: firstId,
        accessibleName: 'First から First へのリンク',
        id: 'edge-0',
        sourcePortId: 'source-0',
        targetPortId: 'target-0',
        sections: [],
      },
    ],
    currentNode: node,
  };
}

describe('alternate presentation contract', () => {
  it('consumes every location and application state and invokes every action', async () => {
    const locations: NotesPresentationModel['location'][] = [
      { kind: 'empty' },
      { kind: 'card', cardId: firstId },
      { kind: 'history', cardId: firstId },
      { kind: 'connections', cardId: firstId },
    ];
    const summaries = locations.map((location) => {
      const props = presentationProps(location);
      return createAlternatePresentationProbe(props).summary;
    });
    expect(summaries).toEqual([
      expect.stringContaining('empty;card;sync-failed'),
      expect.stringContaining(`card:${firstId};card;sync-failed`),
      expect.stringContaining(`history:${firstId};history;sync-failed`),
      expect.stringContaining(`connections:${firstId};connections;sync-failed`),
    ]);

    const props = presentationProps({ kind: 'card', cardId: firstId });
    const probe = createAlternatePresentationProbe(props);
    const historyProbe = createAlternatePresentationProbe({
      ...props,
      model: model({ kind: 'history', cardId: firstId }),
    });
    createAlternatePresentationProbe({
      ...props,
      model: model({ kind: 'connections', cardId: firstId }),
    });
    await probe.createCard();
    historyProbe.openFirstHistory();
    probe.showCurrentCard();
    probe.showHistory();
    probe.showConnections();
    probe.updateTitle('Changed');
    probe.updateBody([{ type: 'text', text: 'Changed body' }]);
    await probe.retrySync();
    probe.resolveFirstConflict();
    expect(props.actions.createCard).toHaveBeenCalled();
    expect(props.actions.openCard).toHaveBeenCalledWith(firstId);
    expect(props.actions.showCurrentCard).toHaveBeenCalled();
    expect(props.actions.showHistory).toHaveBeenCalled();
    expect(props.actions.showConnections).toHaveBeenCalled();
    expect(props.actions.updateTitle).toHaveBeenCalledWith('Changed');
    expect(props.actions.updateBody).toHaveBeenCalledWith([
      { type: 'text', text: 'Changed body' },
    ]);
    expect(props.actions.retrySync).toHaveBeenCalled();
    expect(props.actions.resolveConflict).toHaveBeenCalledWith(
      conflictId,
      'local',
    );
    expect(props.features.renderCardEditor).toHaveBeenCalled();
    expect(props.features.renderConnections).toHaveBeenCalled();

    const statuses: NotesPresentationModel['status'][] = [
      { kind: 'saved', label: 'Saved', retryable: false },
      { kind: 'saving', label: 'Saving', retryable: false },
      { kind: 'save-failed', label: 'Save failed', retryable: false },
      { kind: 'syncing', label: 'Syncing', retryable: false },
      { kind: 'offline', label: 'Offline', retryable: false },
      { kind: 'sync-failed', label: 'Sync failed', retryable: true },
    ];
    for (const status of statuses) {
      const statusProps = presentationProps({
        kind: 'card',
        cardId: firstId,
      });
      statusProps.model.status = status;
      expect(createAlternatePresentationProbe(statusProps).summary).toContain(
        `${status.kind};${status.label}`,
      );
    }
  });

  it('consumes editor state, candidate link, undo and redo commands', () => {
    const commands: CardEditorRendererProps['commands'] = {
      setTitleInputElement: vi.fn(),
      updateTitle: vi.fn(),
      handleTitleBlur: vi.fn(),
      handleTitleKeyDown: vi.fn(),
      handleTitleCompositionStart: vi.fn(),
      handleTitleCompositionEnd: vi.fn(),
      prepareBodyEditing: vi.fn(),
      handleKeyDown: vi.fn(),
      handleInput: vi.fn(),
      handleCompositionEnd: vi.fn(),
      preserveEditorFocus: vi.fn(),
      selectCandidate: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
    };
    const props: CardEditorRendererProps = {
      model: {
        editor: null,
        title: 'First',
        ready: true,
        focused: true,
        selectionEmpty: false,
        canUndo: true,
        canRedo: true,
        candidates: [
          {
            cardId: secondId,
            displayLabel: '#2',
            displayValue: 2,
            title: 'Second',
          },
        ],
        suggestionOpen: true,
        activeCandidate: 0,
      },
      commands,
    };
    const probe = createAlternateCardEditorProbe(props);
    expect(probe.summary).toBe(
      'First;ready;focused;range-selection;candidates-open;can-undo;can-redo;Second',
    );
    probe.updateTitle('Changed title');
    probe.undo();
    probe.redo();
    probe.insertCandidateLink();
    expect(commands.undo).toHaveBeenCalled();
    expect(commands.redo).toHaveBeenCalled();
    expect(commands.updateTitle).toHaveBeenCalledWith('Changed title');
    expect(commands.selectCandidate).toHaveBeenCalledWith(secondId);
  });

  it('consumes loading, error and ready connections with one open action', () => {
    const openCard = vi.fn();
    for (const status of ['loading', 'error', 'ready'] as const) {
      const connectionsState = controllerState(status);
      const props: ConnectionsRendererProps = {
        model: connectionsState,
        totalNodeCount: 1,
        totalEdgeCount: status === 'ready' ? 1 : 0,
        actions: {
          openCard,
        },
        presentation: alternateNotesAppConfiguration.connectionsPresentation,
      };
      const probe = createAlternateConnectionsProbe(props);
      expect(probe.summary).toContain(status);
      if (status === 'ready') {
        expect(probe.summary).toContain('200x120:10,20');
      }
      probe.openFirst();
    }
    expect(openCard).toHaveBeenCalledTimes(3);
    expect(openCard).toHaveBeenNthCalledWith(1, firstId);
    expect(openCard).toHaveBeenNthCalledWith(2, firstId);
    expect(openCard).toHaveBeenNthCalledWith(3, firstId);
  });

  it('provides a complete alternate composition-root configuration', () => {
    expect(typeof alternateNotesAppConfiguration.Presentation).toBe('function');
    expect(typeof alternateNotesAppConfiguration.CardEditorRenderer).toBe(
      'function',
    );
    expect(typeof alternateNotesAppConfiguration.ConnectionsRenderer).toBe(
      'function',
    );
    expect(
      alternateNotesAppConfiguration.connectionsPresentation.viewportPadding,
    ).toEqual({ top: 8, right: 8, bottom: 8, left: 8 });
    expect(
      alternateNotesAppConfiguration.connectionsPresentation.layoutMetrics,
    ).toMatchObject({ nodeWidth: 148, nodeHeight: 56, layerSpacing: 80 });
    expect(
      alternateNotesAppConfiguration.connectionsPresentation.edgeMaximumRadius,
    ).toBe(7);
  });
});

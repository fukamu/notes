import { createElement } from 'react';
import type { NotesAppConfiguration } from '@/components/notes-app';
import type {
  CardEditorRendererProps,
  ConnectionsRendererProps,
  NotesPresentationProps,
} from '@/components/presentation-contract';
import type { BodySegment } from '@/lib/domain/types';
import { queryCardEditorCandidates } from '@/lib/application/card-editor-index';

function locationLabel(props: NotesPresentationProps): string {
  const location = props.model.location;
  switch (location.kind) {
    case 'empty':
      return 'empty';
    case 'card':
      return `card:${location.cardId}`;
    case 'history':
      return `history:${location.cardId ?? 'none'}`;
    case 'connections':
      return `connections:${location.cardId}`;
  }
}

export function createAlternatePresentationProbe(
  props: NotesPresentationProps,
) {
  const firstHistory = props.model.history?.items[0];
  const firstConflict = props.model.conflicts[0];
  const editor = props.model.cardEditor;
  const connections = props.model.connections;
  return {
    summary: [
      locationLabel(props),
      props.model.activeView,
      props.model.status.kind,
      props.model.status.label,
      props.model.status.retryable ? 'retryable' : 'settled',
      props.model.history?.currentCardId ?? 'no-current-history',
      firstHistory?.current ? 'current-history-item' : 'other-history-item',
      firstHistory?.title ?? 'no-history',
      firstConflict?.options.map((option) => option.heading).join('|') ??
        'no-conflict',
      editor
        ? queryCardEditorCandidates(editor.candidateIndex, '')
            .map((candidate) => candidate.title)
            .join('|')
        : 'no-candidates',
      connections?.nodes.map((node) => node.title).join('|') ??
        'no-connections',
    ].join(';'),
    createCard: props.actions.createCard,
    openFirstHistory: () => {
      if (firstHistory) props.actions.openCard(firstHistory.cardId);
    },
    showCurrentCard: props.actions.showCurrentCard,
    showHistory: props.actions.showHistory,
    showConnections: props.actions.showConnections,
    updateTitle: (title: string) => props.actions.updateTitle(title),
    updateBody: (body: BodySegment[]) => props.actions.updateBody(body),
    retrySync: props.actions.retrySync,
    resolveFirstConflict: () => {
      const option = firstConflict?.options[0];
      if (firstConflict && option) {
        props.actions.resolveConflict(firstConflict.conflictId, option.choice);
      }
    },
    editorFeature: editor
      ? props.features.renderCardEditor({
          input: editor,
          actions: props.actions,
        })
      : null,
    connectionsFeature: connections
      ? props.features.renderConnections({
          input: connections,
          actions: props.actions,
        })
      : null,
  };
}

export function AlternateNotesPresentation(props: NotesPresentationProps) {
  const probe = createAlternatePresentationProbe(props);
  return createElement(
    'main',
    { 'aria-label': 'Alternate notes presentation' },
    createElement('output', null, probe.summary),
    createElement('button', { onClick: probe.createCard }, 'Create'),
    createElement('button', { onClick: probe.openFirstHistory }, 'Open'),
    createElement('button', { onClick: probe.showCurrentCard }, 'Current'),
    createElement('button', { onClick: probe.showHistory }, 'History'),
    createElement('button', { onClick: probe.showConnections }, 'Connections'),
    createElement(
      'button',
      { onClick: () => probe.updateTitle('Alternate title') },
      'Update title',
    ),
    createElement(
      'button',
      {
        onClick: () =>
          probe.updateBody([{ type: 'text', text: 'Alternate body' }]),
      },
      'Update body',
    ),
    createElement('button', { onClick: probe.retrySync }, 'Retry'),
    createElement(
      'button',
      { onClick: probe.resolveFirstConflict },
      'Resolve conflict',
    ),
    probe.editorFeature,
    probe.connectionsFeature,
  );
}

export function createAlternateCardEditorProbe({
  model,
  commands,
}: CardEditorRendererProps) {
  const candidate = model.candidates[model.activeCandidate];
  return {
    summary: [
      model.title,
      model.ready ? 'ready' : 'loading',
      model.focused ? 'focused' : 'blurred',
      model.selectionEmpty ? 'empty-selection' : 'range-selection',
      model.suggestionOpen ? 'candidates-open' : 'candidates-closed',
      model.canUndo ? 'can-undo' : 'cannot-undo',
      model.canRedo ? 'can-redo' : 'cannot-redo',
      candidate?.title ?? 'no-candidate',
    ].join(';'),
    updateTitle: commands.updateTitle,
    undo: commands.undo,
    redo: commands.redo,
    insertCandidateLink: () => {
      if (candidate) commands.selectCandidate(candidate.cardId);
    },
  };
}

export function AlternateCardEditorRenderer(props: CardEditorRendererProps) {
  const probe = createAlternateCardEditorProbe(props);
  return createElement(
    'section',
    { 'aria-label': 'Alternate editor' },
    createElement(
      'button',
      { onClick: () => probe.updateTitle('Alternate title') },
      'Update title',
    ),
    createElement('output', null, probe.summary),
    createElement('button', { onClick: probe.undo }, 'Undo'),
    createElement('button', { onClick: probe.redo }, 'Redo'),
    createElement('button', { onClick: probe.insertCandidateLink }, 'Link'),
  );
}

export function createAlternateConnectionsProbe({
  model,
  actions,
}: ConnectionsRendererProps) {
  const items = model.status === 'ready' ? model.nodes : model.fallbackItems;
  const edgeLabels =
    model.status === 'ready'
      ? model.edges.map((edge) => edge.accessibleName)
      : [];
  return {
    summary: [
      model.status,
      items.map((item) => item.title).join('|'),
      edgeLabels.join('|'),
      model.status === 'ready'
        ? (model.currentNode?.title ?? 'missing-current')
        : 'layout-unavailable',
      model.status === 'ready'
        ? `${model.width}x${model.height}:${model.currentNode?.x ?? 'x'},${model.currentNode?.y ?? 'y'}`
        : 'no-geometry',
    ].join(';'),
    openFirst: () => {
      const first = items[0];
      if (first) actions.openCard(first.cardId);
    },
  };
}

export function AlternateConnectionsRenderer(props: ConnectionsRendererProps) {
  const probe = createAlternateConnectionsProbe(props);
  return createElement(
    'section',
    { 'aria-label': 'Alternate connections' },
    createElement('output', null, probe.summary),
    createElement('button', { onClick: probe.openFirst }, 'Open node'),
  );
}

export const alternateNotesAppConfiguration = {
  Presentation: AlternateNotesPresentation,
  CardEditorRenderer: AlternateCardEditorRenderer,
  cardEditorPresentation: {
    contentAttributes: {
      class: 'alternate-editor-structure',
      role: 'textbox',
      'aria-label': 'Alternate card body',
    },
    cardLinkNodeView: { className: 'alternate-card-link' },
  },
  ConnectionsRenderer: AlternateConnectionsRenderer,
  connectionsPresentation: {
    layoutMetrics: {
      nodeWidth: 148,
      nodeHeight: 56,
      portSize: 2,
      componentSpacing: 64,
      nodeSpacing: 48,
      edgeNodeSpacing: 24,
      layerSpacing: 80,
      edgeLayerSpacing: 28,
      padding: { top: 16, right: 16, bottom: 16, left: 16 },
    },
    viewportPadding: { top: 8, right: 8, bottom: 8, left: 8 },
    edgeMaximumRadius: 7,
  },
} satisfies NotesAppConfiguration;

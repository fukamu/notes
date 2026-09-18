'use client';

import type { ComponentType } from 'react';
import type { CardEditorRendererProps } from '@/components/presentation-contract';
import type {
  CardEditorActivity,
  CardEditorDocumentInput,
  EditorFocusIntent,
  NotesPresentationActions,
} from '@/lib/application/presentation';
import { useCardEditor } from '@/lib/editor/use-card-editor';
import type { CardEditorPresentationAdapter } from '@/lib/editor/use-card-editor';

type Props = {
  document: CardEditorDocumentInput;
  activity: CardEditorActivity;
  actions: Pick<
    NotesPresentationActions,
    'openCard' | 'updateTitle' | 'updateBody'
  >;
  focusIntent: EditorFocusIntent | null;
  consumeFocusIntent: (requestId: number) => void;
  presentation: CardEditorPresentationAdapter;
  Renderer: ComponentType<CardEditorRendererProps>;
};

export function BodyEditorAdapter({
  document,
  activity,
  actions,
  focusIntent,
  consumeFocusIntent,
  presentation,
  Renderer,
}: Props) {
  const controller = useCardEditor({
    document,
    activity,
    actions,
    focusIntent,
    consumeFocusIntent,
    presentation,
  });
  return <Renderer model={controller.model} commands={controller.commands} />;
}

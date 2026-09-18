'use client';

import type { ComponentType } from 'react';
import type { CardEditorRendererProps } from '@/components/presentation-contract';
import type {
  CardEditorActivity,
  CardEditorDocumentInput,
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
  presentation: CardEditorPresentationAdapter;
  Renderer: ComponentType<CardEditorRendererProps>;
};

export function BodyEditorAdapter({
  document,
  activity,
  actions,
  presentation,
  Renderer,
}: Props) {
  const controller = useCardEditor({
    document,
    activity,
    actions,
    presentation,
  });
  return <Renderer model={controller.model} commands={controller.commands} />;
}

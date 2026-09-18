'use client';

import type { ComponentType } from 'react';
import type { CardEditorRendererProps } from '@/components/presentation-contract';
import type {
  CardEditorInputModel,
  NotesPresentationActions,
} from '@/lib/application/presentation';
import { useCardEditor } from '@/lib/editor/use-card-editor';
import type { CardEditorPresentationAdapter } from '@/lib/editor/use-card-editor';

type Props = {
  model: CardEditorInputModel;
  actions: Pick<
    NotesPresentationActions,
    'openCard' | 'updateTitle' | 'updateBody'
  >;
  presentation: CardEditorPresentationAdapter;
  Renderer: ComponentType<CardEditorRendererProps>;
};

export function BodyEditorAdapter({
  model,
  actions,
  presentation,
  Renderer,
}: Props) {
  const controller = useCardEditor({
    input: model,
    actions,
    presentation,
  });
  return <Renderer model={controller.model} commands={controller.commands} />;
}

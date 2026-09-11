'use client';

import {
  BodyEditor,
  defaultCardEditorPresentation,
} from '@/components/body-editor';
import type {
  CardEditorInputModel,
  NotesPresentationActions,
} from '@/lib/application/presentation';
import { useCardEditor } from '@/lib/editor/use-card-editor';

type Props = {
  model: CardEditorInputModel;
  actions: Pick<NotesPresentationActions, 'openCard' | 'updateBody'>;
};

export function BodyEditorAdapter({ model, actions }: Props) {
  const controller = useCardEditor({
    input: model,
    actions,
    presentation: defaultCardEditorPresentation,
  });
  return <BodyEditor model={controller.model} commands={controller.commands} />;
}

/** @vitest-environment happy-dom */

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCardEditorCandidateIndex } from '@/lib/application/card-editor-index';
import type { CardEditorInputModel } from '@/lib/application/presentation';
import type { CardRecord } from '@/lib/domain/types';
import { useCardEditor } from '@/lib/editor/use-card-editor';
import { fixtureCardId } from '@/tests/fixtures/ids';

type Controller = ReturnType<typeof useCardEditor>;

const roots: Root[] = [];

function cardInput(seed: string, title: string): CardEditorInputModel {
  const card: CardRecord = {
    id: fixtureCardId(seed),
    displayId: { kind: 'official', value: 1 },
    title,
    body: [],
    createdAt: 1,
    updatedAt: 1,
    localRevision: 1,
    serverRevision: 1,
  };
  return {
    cardId: card.id,
    title,
    body: card.body,
    labels: [],
    candidateIndex: createCardEditorCandidateIndex([card], card.id),
  };
}

async function flushEditor(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.replaceChildren();
});

describe('card editor controller history boundary', () => {
  it('persists only the changed field and preserves self echoes', async () => {
    const updateTitle = vi.fn();
    const updateBody = vi.fn();
    let controller: Controller | null = null;
    const firstInput = cardInput('controller-history', 'A');
    const actions = {
      openCard: vi.fn(),
      updateTitle,
      updateBody,
    };
    const Harness = ({
      input,
      onController,
    }: {
      input: CardEditorInputModel;
      onController: (next: Controller) => void;
    }) => {
      const nextController = useCardEditor({
        input,
        actions,
        presentation: {
          contentAttributes: { 'aria-label': 'test editor' },
          cardLinkNodeView: { className: 'test-card-link' },
        },
      });
      useEffect(
        () => onController(nextController),
        [nextController, onController],
      );
      return null;
    };
    const captureController = (next: Controller) => {
      controller = next;
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        createElement(Harness, {
          input: firstInput,
          onController: captureController,
        }),
      ),
    );
    await flushEditor();

    const current = () => {
      if (!controller) throw new Error('Card editor controller is unavailable');
      return controller;
    };
    expect(current().model.ready).toBe(true);

    await act(async () => {
      current().commands.updateTitle('B');
      current().commands.handleTitleBlur();
    });
    expect(updateTitle).toHaveBeenCalledTimes(1);
    expect(updateTitle).toHaveBeenLastCalledWith('B');
    expect(updateBody).not.toHaveBeenCalled();
    expect(current().model.canUndo).toBe(true);

    await act(async () =>
      root.render(
        createElement(Harness, {
          input: { ...firstInput, title: 'B' },
          onController: captureController,
        }),
      ),
    );
    await flushEditor();
    expect(current().model.canUndo).toBe(true);

    await act(async () => current().commands.undo());
    expect(updateTitle).toHaveBeenCalledTimes(2);
    expect(updateTitle).toHaveBeenLastCalledWith('A');
    expect(updateBody).not.toHaveBeenCalled();

    const editor = current().model.editor;
    if (!editor) throw new Error('Card editor instance is unavailable');
    await act(async () => {
      editor.commands.insertContent('body');
    });
    expect(updateBody).toHaveBeenCalledTimes(1);
    expect(updateTitle).toHaveBeenCalledTimes(2);
  });

  it('resets pending title and history for external content or card identity', async () => {
    const actions = {
      openCard: vi.fn(),
      updateTitle: vi.fn(),
      updateBody: vi.fn(),
    };
    let controller: Controller | null = null;
    const Harness = ({
      input,
      onController,
    }: {
      input: CardEditorInputModel;
      onController: (next: Controller) => void;
    }) => {
      const nextController = useCardEditor({
        input,
        actions,
        presentation: {
          contentAttributes: { 'aria-label': 'test editor' },
          cardLinkNodeView: { className: 'test-card-link' },
        },
      });
      useEffect(
        () => onController(nextController),
        [nextController, onController],
      );
      return null;
    };
    const captureController = (next: Controller) => {
      controller = next;
    };
    const first = cardInput('controller-reset-a', 'A');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        createElement(Harness, {
          input: first,
          onController: captureController,
        }),
      ),
    );
    await flushEditor();

    const current = () => {
      if (!controller) throw new Error('Card editor controller is unavailable');
      return controller;
    };
    await act(async () => {
      current().commands.updateTitle('B');
      current().commands.handleTitleBlur();
    });
    expect(current().model.canUndo).toBe(true);

    await act(async () =>
      root.render(
        createElement(Harness, {
          input: { ...first, title: 'External' },
          onController: captureController,
        }),
      ),
    );
    await flushEditor();
    expect(current().model.title).toBe('External');
    expect(current().model.canUndo).toBe(false);
    expect(current().model.canRedo).toBe(false);

    await act(async () => current().commands.updateTitle('Pending'));
    const second = cardInput('controller-reset-b', 'Second');
    await act(async () =>
      root.render(
        createElement(Harness, {
          input: second,
          onController: captureController,
        }),
      ),
    );
    await flushEditor();
    expect(current().model.title).toBe('Second');
    expect(current().model.canUndo).toBe(false);
    expect(current().model.canRedo).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { BodyEditor } from '@/components/body-editor';
import type {
  CardEditorCommands,
  CardEditorModel,
} from '@/lib/editor/use-card-editor';
import { fixtureCardId } from '@/tests/fixtures/ids';

describe('default body editor renderer contract', () => {
  it('is constructible from typed model and commands only', () => {
    const model: CardEditorModel = {
      editor: null,
      ready: false,
      focused: false,
      selectionEmpty: true,
      canUndo: false,
      canRedo: false,
      candidates: [
        {
          cardId: fixtureCardId('renderer-candidate'),
          displayLabel: '#1',
          displayValue: 1,
          title: 'Candidate',
        },
      ],
      suggestionOpen: true,
      activeCandidate: 0,
    };
    const commands: CardEditorCommands = {
      handleKeyDown: vi.fn(),
      handleInput: vi.fn(),
      handleCompositionEnd: vi.fn(),
      preserveEditorFocus: vi.fn(),
      selectCandidate: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
    };
    const props: Parameters<typeof BodyEditor>[0] = { model, commands };

    expect(props.model.candidates[0]?.title).toBe('Candidate');
    expect(props.commands.selectCandidate).toBe(commands.selectCandidate);
  });
});

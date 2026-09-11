import { describe, expect, it, vi } from 'vitest';
import {
  activateCardLink,
  createCardLinkExtension,
} from '@/lib/editor/card-link-extension';
import { createCardLabelResolver } from '@/lib/editor/card-labels';
import { fixtureCardId } from '@/tests/fixtures/ids';

describe('card link Tiptap adapter', () => {
  it('keeps the card link inline, atomic, selectable and draggable', () => {
    const extension = createCardLinkExtension({
      labels: createCardLabelResolver([]),
      nodeView: { className: 'injected-structure injected-theme' },
      openCard: vi.fn(),
    });
    expect(extension.config).toMatchObject({
      name: 'cardLink',
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      draggable: true,
    });
  });

  it('decodes attributes and invokes typed openCard exactly once', () => {
    const cardId = fixtureCardId('extension-open');
    const openCard = vi.fn();
    expect(activateCardLink({ targetCardId: cardId }, openCard)).toBe(true);
    expect(openCard).toHaveBeenCalledOnce();
    expect(openCard).toHaveBeenCalledWith(cardId);
  });

  it('ignores malformed third-party attributes without dispatch', () => {
    const openCard = vi.fn();
    expect(activateCardLink({ targetCardId: 'not-a-card-id' }, openCard)).toBe(
      false,
    );
    expect(activateCardLink(null, openCard)).toBe(false);
    expect(openCard).not.toHaveBeenCalled();
  });
});

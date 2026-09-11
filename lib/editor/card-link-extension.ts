import { mergeAttributes, Node, type Editor } from '@tiptap/core';
import type { CardId } from '@/lib/domain/id';
import { cardLinkTargetId } from '@/lib/editor/card-link-attributes';
import type { CardLabelResolver } from '@/lib/editor/card-labels';

const INVALID_CARD_LINK_LABEL = '無効なカードリンク';

export type CardLinkNodeViewAdapter = {
  className: string;
};

export type CardLinkExtensionOptions = {
  labels: CardLabelResolver;
  nodeView: CardLinkNodeViewAdapter;
  openCard: (cardId: CardId) => void;
};

export function activateCardLink(
  attributes: unknown,
  openCard: (cardId: CardId) => void,
): boolean {
  const targetCardId = cardLinkTargetId(attributes);
  if (!targetCardId) return false;
  openCard(targetCardId);
  return true;
}

export function createCardLinkExtension({
  labels,
  nodeView,
  openCard,
}: CardLinkExtensionOptions) {
  return Node.create({
    name: 'cardLink',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    draggable: true,

    addAttributes() {
      return {
        targetCardId: {
          default: null,
          parseHTML: (element) => element.getAttribute('data-card-link-id'),
          renderHTML: (attributes) => {
            const targetCardId = cardLinkTargetId(attributes);
            return targetCardId ? { 'data-card-link-id': targetCardId } : {};
          },
        },
      };
    },

    parseHTML() {
      return [{ tag: 'span[data-card-link-id]' }];
    },

    renderHTML({ HTMLAttributes }) {
      const targetCardId = cardLinkTargetId(HTMLAttributes);
      return [
        'span',
        mergeAttributes(HTMLAttributes, {
          class: nodeView.className,
          contenteditable: 'false',
        }),
        targetCardId ? labels.labelFor(targetCardId) : INVALID_CARD_LINK_LABEL,
      ];
    },

    addNodeView() {
      return ({ node }) => {
        let targetCardId = cardLinkTargetId(node.attrs);
        const dom = document.createElement('span');
        dom.className = nodeView.className;
        dom.contentEditable = 'false';
        dom.tabIndex = 0;
        dom.setAttribute('role', 'link');

        const render = () => {
          if (!targetCardId) {
            dom.removeAttribute('data-card-link-id');
            dom.textContent = INVALID_CARD_LINK_LABEL;
            dom.setAttribute('aria-label', INVALID_CARD_LINK_LABEL);
            return;
          }
          dom.setAttribute('data-card-link-id', targetCardId);
          const label = labels.labelFor(targetCardId);
          dom.textContent = label;
          dom.setAttribute('aria-label', `${label}を開く`);
        };
        const activate = () => {
          activateCardLink({ targetCardId }, openCard);
        };
        const onClick = () => activate();
        const onKeyDown = (event: KeyboardEvent) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          activate();
        };

        render();
        const unsubscribe = labels.subscribe(render);
        dom.addEventListener('click', onClick);
        dom.addEventListener('keydown', onKeyDown);

        return {
          dom,
          stopEvent: (event) =>
            event.type === 'click' || event.type === 'keydown',
          update(updatedNode) {
            if (updatedNode.type.name !== 'cardLink') return false;
            targetCardId = cardLinkTargetId(updatedNode.attrs);
            render();
            return true;
          },
          destroy() {
            unsubscribe();
            dom.removeEventListener('click', onClick);
            dom.removeEventListener('keydown', onKeyDown);
          },
        };
      };
    },

    addKeyboardShortcuts() {
      const deleteAdjacent = (
        direction: 'before' | 'after',
        editor: Editor,
      ) => {
        const { selection } = editor.state;
        if (!selection.empty) return false;
        const adjacent =
          direction === 'before'
            ? selection.$anchor.nodeBefore
            : selection.$anchor.nodeAfter;
        if (adjacent?.type.name !== this.name) return false;
        const from =
          direction === 'before'
            ? selection.$anchor.pos - adjacent.nodeSize
            : selection.$anchor.pos;
        editor.view.dispatch(
          editor.state.tr.delete(from, from + adjacent.nodeSize),
        );
        return true;
      };

      return {
        Backspace: ({ editor }) => deleteAdjacent('before', editor),
        Delete: ({ editor }) => deleteAdjacent('after', editor),
      };
    },
  });
}

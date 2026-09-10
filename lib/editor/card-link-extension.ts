import { mergeAttributes, Node } from '@tiptap/core';
import { getCardLabel, subscribeToCardLabels } from './card-labels';
import { cardLinkTargetId } from './card-link-attributes';

const INVALID_CARD_LINK_LABEL = '無効なカードリンク';

export const CardLink = Node.create({
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
        renderHTML: (attributes) => ({
          'data-card-link-id': attributes.targetCardId,
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-card-link-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const targetCardId = cardLinkTargetId({
      targetCardId: HTMLAttributes['data-card-link-id'],
    });
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        class: 'card-link-capsule',
        contenteditable: 'false',
      }),
      targetCardId ? getCardLabel(targetCardId) : INVALID_CARD_LINK_LABEL,
    ];
  },

  addNodeView() {
    return ({ node }) => {
      let targetCardId = cardLinkTargetId(node.attrs);
      const dom = document.createElement('span');
      dom.className = 'card-link-capsule';
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
        const label = getCardLabel(targetCardId);
        dom.textContent = label;
        dom.setAttribute('aria-label', `${label}を開く`);
      };
      render();
      const unsubscribe = subscribeToCardLabels(render);

      dom.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          dom.click();
        }
      });

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type.name !== 'cardLink') return false;
          targetCardId = cardLinkTargetId(updatedNode.attrs);
          render();
          return true;
        },
        destroy: unsubscribe,
      };
    };
  },

  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { selection } = editor.state;
        if (!selection.empty) return false;
        const nodeBefore = selection.$anchor.nodeBefore;
        if (nodeBefore?.type.name !== this.name) return false;
        const end = selection.$anchor.pos;
        editor.view.dispatch(
          editor.state.tr.delete(end - nodeBefore.nodeSize, end),
        );
        return true;
      },
    };
  },
});

import { mergeAttributes, Node } from '@tiptap/core';
import { getCardLabel, subscribeToCardLabels } from './card-labels';

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
        renderHTML: (attributes) => ({ 'data-card-link-id': attributes.targetCardId }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-card-link-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        class: 'card-link-capsule',
        contenteditable: 'false',
      }),
      getCardLabel(String(HTMLAttributes['data-card-link-id'])),
    ];
  },

  addNodeView() {
    return ({ node }) => {
      let targetCardId = String(node.attrs.targetCardId);
      const dom = document.createElement('span');
      dom.className = 'card-link-capsule';
      dom.contentEditable = 'false';
      dom.tabIndex = 0;
      dom.setAttribute('role', 'link');
      dom.setAttribute('data-card-link-id', targetCardId);

      const render = () => {
        dom.textContent = getCardLabel(targetCardId);
        dom.setAttribute('aria-label', `${getCardLabel(targetCardId)}を開く`);
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
          targetCardId = String(updatedNode.attrs.targetCardId);
          dom.setAttribute('data-card-link-id', targetCardId);
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
        editor.view.dispatch(editor.state.tr.delete(end - nodeBefore.nodeSize, end));
        return true;
      },
    };
  },
});

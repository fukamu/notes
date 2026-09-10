import type { JSONContent } from '@tiptap/core';
import { normalizeBody } from '@/lib/domain/body';
import type { BodySegment } from '@/lib/domain/types';

export function segmentsToEditorDocument(segments: BodySegment[]): JSONContent {
  const content: JSONContent[] = [];
  for (const segment of segments) {
    if (segment.type === 'link') {
      content.push({
        type: 'cardLink',
        attrs: { targetCardId: segment.targetCardId },
      });
      continue;
    }

    const lines = segment.text.split('\n');
    lines.forEach((line, index) => {
      if (line) content.push({ type: 'text', text: line });
      if (index < lines.length - 1) content.push({ type: 'hardBreak' });
    });
  }

  return { type: 'doc', content: [{ type: 'paragraph', content }] };
}

export function editorDocumentToSegments(document: JSONContent): BodySegment[] {
  const segments: BodySegment[] = [];
  const blocks = document.content ?? [];

  blocks.forEach((block, blockIndex) => {
    if (blockIndex > 0) segments.push({ type: 'text', text: '\n' });
    for (const node of block.content ?? []) {
      if (node.type === 'text' && typeof node.text === 'string') {
        segments.push({ type: 'text', text: node.text });
      } else if (node.type === 'hardBreak') {
        segments.push({ type: 'text', text: '\n' });
      } else if (
        node.type === 'cardLink' &&
        typeof node.attrs?.targetCardId === 'string'
      ) {
        segments.push({ type: 'link', targetCardId: node.attrs.targetCardId });
      }
    }
  });

  return normalizeBody(segments);
}

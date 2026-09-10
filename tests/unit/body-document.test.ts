import { describe, expect, it } from 'vitest';
import {
  editorDocumentToSegments,
  segmentsToEditorDocument,
} from '@/lib/editor/body-document';
import type { BodySegment } from '@/lib/domain/types';

describe('editor body document', () => {
  it('round-trips ordered text, whitespace, newlines and atomic links', () => {
    const body: BodySegment[] = [
      { type: 'text', text: '前  \n' },
      { type: 'link', targetCardId: '01991f20-61d2-7000-8000-000000000001' },
      { type: 'text', text: '\n 後' },
    ];
    expect(editorDocumentToSegments(segmentsToEditorDocument(body))).toEqual(body);
  });

  it('does not infer links from hashtag-like plain text', () => {
    const body: BodySegment[] = [
      { type: 'text', text: 'C# #123 ＃ URL https://example.test/#x [md](#1) 日本語' },
    ];
    expect(editorDocumentToSegments(segmentsToEditorDocument(body))).toEqual(body);
  });
});

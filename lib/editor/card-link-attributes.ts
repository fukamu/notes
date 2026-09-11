import { objectDecoder } from '@/lib/codec/core';
import { cardIdDecoder, type CardId } from '@/lib/domain/id';

export const cardLinkAttributesDecoder = objectDecoder(
  { targetCardId: cardIdDecoder },
  { unknownFields: 'allow' },
);

export function cardLinkTargetId(attributes: unknown): CardId | undefined {
  const result = cardLinkAttributesDecoder.decode(attributes);
  return result.ok ? result.value.targetCardId : undefined;
}

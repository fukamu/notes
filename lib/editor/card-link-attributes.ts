import { isUuidV7 } from '@/lib/domain/id';

export function cardLinkTargetId(attributes: unknown): string | undefined {
  if (!attributes || typeof attributes !== 'object') return undefined;
  if (!('targetCardId' in attributes)) return undefined;
  const targetCardId = attributes.targetCardId;
  return typeof targetCardId === 'string' && isUuidV7(targetCardId)
    ? targetCardId
    : undefined;
}

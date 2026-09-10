import { describe, expect, it } from 'vitest';
import {
  createCardId,
  createDeviceId,
  createMutationId,
  isUuidV7,
} from '@/lib/domain/id';

describe('internal ids', () => {
  it('creates standards-compliant UUIDv7 values', () => {
    for (const id of [createCardId(), createMutationId(), createDeviceId()]) {
      expect(isUuidV7(id)).toBe(true);
      expect(id[14]).toBe('7');
    }
  });
});

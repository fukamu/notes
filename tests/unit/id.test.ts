import { describe, expect, it } from 'vitest';
import { createInternalId, isUuidV7 } from '@/lib/domain/id';

describe('internal ids', () => {
  it('creates standards-compliant UUIDv7 values', () => {
    const id = createInternalId();
    expect(isUuidV7(id)).toBe(true);
    expect(id[14]).toBe('7');
  });
});

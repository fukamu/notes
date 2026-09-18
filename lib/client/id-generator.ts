import { v7 as uuidv7 } from 'uuid';
import type { IdGenerator } from '@/lib/application/notes-runtime';
import {
  parseCardId,
  parseDeviceId,
  parseMutationId,
  type CardId,
  type DeviceId,
  type MutationId,
} from '@/lib/domain/id';

/**
 * UUID generation observes clock/random runtime state. Keep it in this outer
 * adapter and pass the branded result into deterministic domain functions.
 */
export function createCardId(): CardId {
  return parseCardId(uuidv7());
}

export function createMutationId(): MutationId {
  return parseMutationId(uuidv7());
}

export function createDeviceId(): DeviceId {
  return parseDeviceId(uuidv7());
}

export const browserIdGenerator: IdGenerator = {
  createCardId,
  createMutationId,
  createDeviceId,
};

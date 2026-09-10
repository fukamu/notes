import {
  v7 as uuidv7,
  validate as validateUuid,
  version as uuidVersion,
} from 'uuid';

export function createInternalId(): string {
  return uuidv7();
}

export function isUuidV7(value: string): boolean {
  return validateUuid(value) && uuidVersion(value) === 7;
}

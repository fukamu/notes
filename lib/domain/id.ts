import { validate as validateUuid, version as uuidVersion } from 'uuid';
import {
  decodeOrThrow,
  refineDecoder,
  stringDecoder,
  transformDecoder,
  type Decoder,
} from '@/lib/codec/core';

declare const identifierBrand: unique symbol;

type Identifier<TName extends string> = string & {
  readonly [identifierBrand]: TName;
};

export type CardId = Identifier<'CardId'>;
export type MutationId = Identifier<'MutationId'>;
export type ConflictId = Identifier<'ConflictId'>;
export type DeviceId = Identifier<'DeviceId'>;

export function isUuidV7(value: string): boolean {
  return validateUuid(value) && uuidVersion(value) === 7;
}

const uuidV7StringDecoder = refineDecoder(
  stringDecoder({ minLength: 36, maxLength: 36 }),
  isUuidV7,
  'expected UUIDv7',
);

function identifierDecoder<TName extends string>(): Decoder<Identifier<TName>> {
  return transformDecoder(
    uuidV7StringDecoder,
    // A brand is attached only after the shared UUIDv7 decoder succeeds.
    (value) => value as Identifier<TName>,
  );
}

export const cardIdDecoder = identifierDecoder<'CardId'>();
export const mutationIdDecoder = identifierDecoder<'MutationId'>();
export const conflictIdDecoder = identifierDecoder<'ConflictId'>();
export const deviceIdDecoder = identifierDecoder<'DeviceId'>();

export function parseCardId(input: unknown): CardId {
  return decodeOrThrow(cardIdDecoder, input, 'CardId');
}

export function parseMutationId(input: unknown): MutationId {
  return decodeOrThrow(mutationIdDecoder, input, 'MutationId');
}

export function parseConflictId(input: unknown): ConflictId {
  return decodeOrThrow(conflictIdDecoder, input, 'ConflictId');
}

export function parseDeviceId(input: unknown): DeviceId {
  return decodeOrThrow(deviceIdDecoder, input, 'DeviceId');
}

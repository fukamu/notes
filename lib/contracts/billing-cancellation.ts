import {
  decodeOrThrow,
  refineDecoder,
  stringDecoder,
  transformDecoder,
  type Decoder,
} from '../codec/core';

declare const subscriptionCancellationIdempotencyKeyBrand: unique symbol;

export type SubscriptionCancellationIdempotencyKey = string & {
  readonly [subscriptionCancellationIdempotencyKeyBrand]: 'SubscriptionCancellationIdempotencyKey';
};

export const subscriptionCancellationIdempotencyKeyDecoder: Decoder<SubscriptionCancellationIdempotencyKey> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 1, maxLength: 255 }),
      (value) => /^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(value),
      'expected a non-sensitive provider idempotency key',
    ),
    (value) => value as SubscriptionCancellationIdempotencyKey,
  );

export function parseSubscriptionCancellationIdempotencyKey(
  input: unknown,
): SubscriptionCancellationIdempotencyKey {
  return decodeOrThrow(
    subscriptionCancellationIdempotencyKeyDecoder,
    input,
    'SubscriptionCancellationIdempotencyKey',
  );
}

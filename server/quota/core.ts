import {
  decodeOrThrow,
  safeIntegerDecoder,
  transformDecoder,
  type Decoder,
} from '../../lib/codec/core';
import type { BodySegment } from '../../lib/domain/types';
import { CONTRACT_LIMITS } from '../../lib/domain/types';
import type { PersonalVaultLimits } from '../entitlement/public';

declare const activeCardCountBrand: unique symbol;
declare const displayCharacterCountBrand: unique symbol;
declare const quotaByteCountBrand: unique symbol;

export type ActiveCardCount = number & {
  readonly [activeCardCountBrand]: 'ActiveCardCount';
};
export type DisplayCharacterCount = number & {
  readonly [displayCharacterCountBrand]: 'DisplayCharacterCount';
};
export type QuotaByteCount = number & {
  readonly [quotaByteCountBrand]: 'QuotaByteCount';
};

const nonNegativeCountDecoder = safeIntegerDecoder({ minimum: 0 });

export const activeCardCountDecoder: Decoder<ActiveCardCount> =
  transformDecoder(
    nonNegativeCountDecoder,
    // The decoder is the runtime proof for this nominal count.
    (value) => value as ActiveCardCount,
  );
export const displayCharacterCountDecoder: Decoder<DisplayCharacterCount> =
  transformDecoder(
    nonNegativeCountDecoder,
    // The decoder is the runtime proof for this nominal count.
    (value) => value as DisplayCharacterCount,
  );
export const quotaByteCountDecoder: Decoder<QuotaByteCount> = transformDecoder(
  nonNegativeCountDecoder,
  // The decoder is the runtime proof for this nominal count.
  (value) => value as QuotaByteCount,
);

export function parseActiveCardCount(input: unknown): ActiveCardCount {
  return decodeOrThrow(activeCardCountDecoder, input, 'active card count');
}

export function parseDisplayCharacterCount(
  input: unknown,
): DisplayCharacterCount {
  return decodeOrThrow(
    displayCharacterCountDecoder,
    input,
    'display character count',
  );
}

export function parseQuotaByteCount(input: unknown): QuotaByteCount {
  return decodeOrThrow(quotaByteCountDecoder, input, 'quota byte count');
}

export const quotaTransportLimits = {
  requestBytes: parseQuotaByteCount(CONTRACT_LIMITS.payloadBytes),
  ciphertextBytesPerObject: parseQuotaByteCount(16_384),
} as const;

export type QuotaTransportLimits = Readonly<{
  requestBytes: QuotaByteCount;
  ciphertextBytesPerObject: QuotaByteCount;
}>;

export type CardDisplayCharacterEvaluation =
  | { readonly kind: 'counted'; readonly characters: DisplayCharacterCount }
  | { readonly kind: 'rejected'; readonly reason: 'ill-formed-unicode' };

export type QuotaBoundaryMeasurement = {
  readonly displayCharacters: DisplayCharacterCount;
  readonly serializedPlaintextBytes: QuotaByteCount;
  readonly ciphertextBytes: QuotaByteCount;
  readonly requestBytes: QuotaByteCount;
};

export type QuotaBoundaryRejectionReason =
  | 'display-character-limit'
  | 'serialized-plaintext-limit'
  | 'ciphertext-limit'
  | 'request-limit';

export type QuotaBoundaryEvaluation =
  | { readonly kind: 'accepted' }
  | {
      readonly kind: 'rejected';
      readonly reasons: readonly QuotaBoundaryRejectionReason[];
    };

export type VaultQuotaUsage = {
  readonly activeCards: ActiveCardCount;
  readonly plaintextBytes: QuotaByteCount;
};

export type VaultQuotaChange =
  | {
      readonly kind: 'create';
      readonly nextPlaintextBytes: QuotaByteCount;
    }
  | {
      readonly kind: 'update';
      readonly currentPlaintextBytes: QuotaByteCount;
      readonly nextPlaintextBytes: QuotaByteCount;
    }
  | {
      readonly kind: 'delete';
      readonly currentPlaintextBytes: QuotaByteCount;
    };

export type VaultQuotaChangeEvaluation =
  | {
      readonly kind: 'accepted';
      readonly cardDelta: -1 | 0 | 1;
      readonly plaintextByteDelta: number;
      readonly next: VaultQuotaUsage;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-usage'
        | 'active-card-limit'
        | 'vault-plaintext-limit';
    };

export function countCardDisplayCharacters(input: {
  readonly title: string;
  readonly body: readonly BodySegment[];
}): CardDisplayCharacterEvaluation {
  const titleCharacters = countUnicodeScalars(input.title);
  if (titleCharacters === undefined) {
    return { kind: 'rejected', reason: 'ill-formed-unicode' };
  }
  let characters = titleCharacters;
  for (const segment of input.body) {
    const segmentCharacters =
      segment.type === 'link' ? 1 : countUnicodeScalars(segment.text);
    if (segmentCharacters === undefined) {
      return { kind: 'rejected', reason: 'ill-formed-unicode' };
    }
    characters += segmentCharacters;
    if (!Number.isSafeInteger(characters)) {
      return { kind: 'rejected', reason: 'ill-formed-unicode' };
    }
  }
  return {
    kind: 'counted',
    characters: parseDisplayCharacterCount(characters),
  };
}

export function evaluateQuotaBoundaries(input: {
  readonly measurement: QuotaBoundaryMeasurement;
  readonly limits: PersonalVaultLimits;
  readonly transportLimits: QuotaTransportLimits;
}): QuotaBoundaryEvaluation {
  const reasons: QuotaBoundaryRejectionReason[] = [];
  if (
    input.measurement.displayCharacters > input.limits.displayCharactersPerCard
  ) {
    reasons.push('display-character-limit');
  }
  if (
    input.measurement.serializedPlaintextBytes >
    input.limits.serializedPlaintextBytesPerCard
  ) {
    reasons.push('serialized-plaintext-limit');
  }
  if (
    input.measurement.ciphertextBytes >
    input.transportLimits.ciphertextBytesPerObject
  ) {
    reasons.push('ciphertext-limit');
  }
  if (input.measurement.requestBytes > input.transportLimits.requestBytes) {
    reasons.push('request-limit');
  }
  return reasons.length === 0
    ? { kind: 'accepted' }
    : { kind: 'rejected', reasons };
}

export function evaluateVaultQuotaChange(input: {
  readonly current: VaultQuotaUsage;
  readonly change: VaultQuotaChange;
  readonly limits: PersonalVaultLimits;
}): VaultQuotaChangeEvaluation {
  const transition = quotaDelta(input.change);
  if (
    transition.currentPlaintextBytes > input.current.plaintextBytes ||
    (transition.cardDelta === -1 && input.current.activeCards === 0)
  ) {
    return { kind: 'rejected', reason: 'invalid-usage' };
  }
  const activeCards = input.current.activeCards + transition.cardDelta;
  const plaintextBytes =
    input.current.plaintextBytes + transition.plaintextByteDelta;
  if (
    !Number.isSafeInteger(activeCards) ||
    !Number.isSafeInteger(plaintextBytes) ||
    activeCards < 0 ||
    plaintextBytes < 0
  ) {
    return { kind: 'rejected', reason: 'invalid-usage' };
  }
  if (activeCards > input.limits.activeCards) {
    return { kind: 'rejected', reason: 'active-card-limit' };
  }
  if (plaintextBytes > input.limits.plaintextBytesPerVault) {
    return { kind: 'rejected', reason: 'vault-plaintext-limit' };
  }
  return {
    kind: 'accepted',
    cardDelta: transition.cardDelta,
    plaintextByteDelta: transition.plaintextByteDelta,
    next: {
      activeCards: parseActiveCardCount(activeCards),
      plaintextBytes: parseQuotaByteCount(plaintextBytes),
    },
  };
}

function quotaDelta(change: VaultQuotaChange): {
  readonly cardDelta: -1 | 0 | 1;
  readonly currentPlaintextBytes: QuotaByteCount;
  readonly plaintextByteDelta: number;
} {
  switch (change.kind) {
    case 'create':
      return {
        cardDelta: 1,
        currentPlaintextBytes: parseQuotaByteCount(0),
        plaintextByteDelta: change.nextPlaintextBytes,
      };
    case 'update':
      return {
        cardDelta: 0,
        currentPlaintextBytes: change.currentPlaintextBytes,
        plaintextByteDelta:
          change.nextPlaintextBytes - change.currentPlaintextBytes,
      };
    case 'delete':
      return {
        cardDelta: -1,
        currentPlaintextBytes: change.currentPlaintextBytes,
        plaintextByteDelta: 0 - change.currentPlaintextBytes,
      };
  }
}

function countUnicodeScalars(value: string): number | undefined {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return undefined;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return undefined;
    }
    count += 1;
  }
  return count;
}

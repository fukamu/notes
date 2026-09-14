import { describe, expect, it } from 'vitest';
import { parseCardId } from '@/lib/domain/id';
import { paidPersonalVaultLimits } from '@/server/entitlement/public';
import {
  countCardDisplayCharacters,
  evaluateQuotaBoundaries,
  evaluateVaultQuotaChange,
  parseActiveCardCount,
  parseDisplayCharacterCount,
  parseQuotaByteCount,
  quotaTransportLimits,
} from '@/server/quota/public';

describe('Quota pure policy', () => {
  it('counts Unicode scalar values, not UTF-16 units or grapheme clusters', () => {
    expect(characters('日本😀')).toBe(3);
    expect(characters('e\u0301')).toBe(2);
    expect(characters('👩‍👩‍👧‍👦')).toBe(7);
    expect(
      countCardDisplayCharacters({
        title: '題',
        body: [
          { type: 'text', text: '本文' },
          {
            type: 'link',
            targetCardId: parseCardId('01991f20-61d2-7000-8000-000000001940'),
          },
        ],
      }),
    ).toEqual({ kind: 'counted', characters: 4 });
  });

  it('rejects unpaired UTF-16 surrogates instead of silently replacing them', () => {
    expect(countCardDisplayCharacters({ title: '\ud800', body: [] })).toEqual({
      kind: 'rejected',
      reason: 'ill-formed-unicode',
    });
    expect(
      countCardDisplayCharacters({
        title: '',
        body: [{ type: 'text', text: '\udc00' }],
      }),
    ).toEqual({ kind: 'rejected', reason: 'ill-formed-unicode' });
  });

  it('accepts exact per-card and transport limits', () => {
    expect(
      evaluateQuotaBoundaries({
        measurement: measurement(),
        limits: paidPersonalVaultLimits,
        transportLimits: quotaTransportLimits,
      }),
    ).toEqual({ kind: 'accepted' });
  });

  it.each([
    ['displayCharacters', 1_001, 'display-character-limit'],
    ['serializedPlaintextBytes', 8_193, 'serialized-plaintext-limit'],
    ['ciphertextBytes', 16_385, 'ciphertext-limit'],
    ['requestBytes', 4_000_001, 'request-limit'],
  ] as const)('rejects %s independently', (field, value, reason) => {
    expect(
      evaluateQuotaBoundaries({
        measurement: { ...measurement(), [field]: quotaValue(field, value) },
        limits: paidPersonalVaultLimits,
        transportLimits: quotaTransportLimits,
      }),
    ).toEqual({ kind: 'rejected', reasons: [reason] });
  });

  it('accepts the 10,000th card and rejects the 10,001st', () => {
    expect(
      evaluateVaultQuotaChange({
        current: usage(9_999, 1_000),
        change: { kind: 'create', nextPlaintextBytes: bytes(8_192) },
        limits: paidPersonalVaultLimits,
      }),
    ).toMatchObject({
      kind: 'accepted',
      cardDelta: 1,
      plaintextByteDelta: 8_192,
      next: { activeCards: 10_000, plaintextBytes: 9_192 },
    });
    expect(
      evaluateVaultQuotaChange({
        current: usage(10_000, 1_000),
        change: { kind: 'create', nextPlaintextBytes: bytes(1) },
        limits: paidPersonalVaultLimits,
      }),
    ).toEqual({ kind: 'rejected', reason: 'active-card-limit' });
  });

  it('checks the Vault byte boundary and applies update/delete deltas', () => {
    expect(
      evaluateVaultQuotaChange({
        current: usage(1, 134_217_727),
        change: {
          kind: 'update',
          currentPlaintextBytes: bytes(10),
          nextPlaintextBytes: bytes(11),
        },
        limits: paidPersonalVaultLimits,
      }),
    ).toMatchObject({
      kind: 'accepted',
      plaintextByteDelta: 1,
      next: { activeCards: 1, plaintextBytes: 134_217_728 },
    });
    expect(
      evaluateVaultQuotaChange({
        current: usage(1, 134_217_728),
        change: {
          kind: 'update',
          currentPlaintextBytes: bytes(10),
          nextPlaintextBytes: bytes(11),
        },
        limits: paidPersonalVaultLimits,
      }),
    ).toEqual({ kind: 'rejected', reason: 'vault-plaintext-limit' });
    expect(
      evaluateVaultQuotaChange({
        current: usage(2, 20),
        change: { kind: 'delete', currentPlaintextBytes: bytes(8) },
        limits: paidPersonalVaultLimits,
      }),
    ).toMatchObject({
      kind: 'accepted',
      cardDelta: -1,
      plaintextByteDelta: -8,
      next: { activeCards: 1, plaintextBytes: 12 },
    });
  });

  it('rejects impossible usage and unrefined external measurements', () => {
    expect(
      evaluateVaultQuotaChange({
        current: usage(0, 0),
        change: { kind: 'delete', currentPlaintextBytes: bytes(1) },
        limits: paidPersonalVaultLimits,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-usage' });
    for (const value of [-1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseActiveCardCount(value)).toThrow();
      expect(() => parseDisplayCharacterCount(value)).toThrow();
      expect(() => parseQuotaByteCount(value)).toThrow();
    }
  });
});

function characters(value: string): number {
  const result = countCardDisplayCharacters({ title: value, body: [] });
  if (result.kind !== 'counted') throw new Error('expected valid Unicode');
  return result.characters;
}

function measurement() {
  return {
    displayCharacters: parseDisplayCharacterCount(1_000),
    serializedPlaintextBytes: bytes(8_192),
    ciphertextBytes: bytes(16_384),
    requestBytes: bytes(4_000_000),
  };
}

function quotaValue(
  field: keyof ReturnType<typeof measurement>,
  value: number,
) {
  return field === 'displayCharacters'
    ? parseDisplayCharacterCount(value)
    : bytes(value);
}

function usage(activeCards: number, plaintextBytes: number) {
  return {
    activeCards: parseActiveCardCount(activeCards),
    plaintextBytes: bytes(plaintextBytes),
  };
}

function bytes(value: number) {
  return parseQuotaByteCount(value);
}

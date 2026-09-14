import { parseCardId, parseMutationId } from '@/lib/domain/id';
import { parseVaultQuotaFingerprint } from '@/server/quota/public';

export const quotaIds = {
  cardA: parseCardId('01991f20-61d2-7000-8000-000000001950'),
  cardB: parseCardId('01991f20-61d2-7000-8000-000000001951'),
  cardC: parseCardId('01991f20-61d2-7000-8000-000000001954'),
  cardD: parseCardId('01991f20-61d2-7000-8000-000000001955'),
  reservationA: parseMutationId('01991f20-61d2-7000-8000-000000001952'),
  reservationB: parseMutationId('01991f20-61d2-7000-8000-000000001953'),
  reservationC: parseMutationId('01991f20-61d2-7000-8000-000000001956'),
  reservationD: parseMutationId('01991f20-61d2-7000-8000-000000001957'),
  fingerprintA: parseVaultQuotaFingerprint(`${'A'.repeat(42)}A`),
  fingerprintB: parseVaultQuotaFingerprint(`${'B'.repeat(42)}A`),
  fingerprintC: parseVaultQuotaFingerprint(`${'C'.repeat(42)}A`),
  fingerprintD: parseVaultQuotaFingerprint(`${'D'.repeat(42)}A`),
} as const;

import type { ContractOfferHasherPort } from './public';

export function createWebCryptoContractOfferHasher(
  subtle: SubtleCrypto,
): ContractOfferHasherPort {
  return {
    async hash(serializedOffer) {
      const digest = await subtle.digest(
        'SHA-256',
        new TextEncoder().encode(serializedOffer),
      );
      const hex = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      return `sha256:${hex}`;
    },
  };
}

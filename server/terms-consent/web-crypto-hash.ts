import type { TermsDocumentHasherPort } from './public';

export function createWebCryptoTermsDocumentHasher(
  subtle: SubtleCrypto,
): TermsDocumentHasherPort {
  return {
    async hash(serializedTerms) {
      const digest = await subtle.digest(
        'SHA-256',
        new TextEncoder().encode(serializedTerms),
      );
      const hex = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      return `sha256:${hex}`;
    },
  };
}

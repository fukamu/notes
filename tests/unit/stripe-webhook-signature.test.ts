import { describe, expect, it } from 'vitest';
import {
  createWebCryptoStripeWebhookVerifier,
  parseStripeSignatureHeader,
} from '@/server/stripe/webhook-signature';
import { parseStripeWebhookSecret } from '@/server/stripe/public';

const secret = parseStripeWebhookSecret('whsec_0123456789abcdefghijklmnop');
const payload = new TextEncoder().encode('{"id":"evt_signature"}');

describe('Stripe raw-body webhook signature verifier', () => {
  it('verifies a current raw body and any matching v1 rotation signature', async () => {
    const timestamp = 1_000;
    const valid = await sign(timestamp, payload, secret);
    const verifier = createWebCryptoStripeWebhookVerifier(secret);
    await expect(
      verifier.verify({
        rawBody: payload,
        signatureHeader: `t=${timestamp},v1=${'0'.repeat(64)},v1=${valid}`,
        receivedAt: 1_000_000,
      }),
    ).resolves.toMatchObject({ kind: 'verified' });
  });

  it('rejects modified bytes, wrong secrets, stale timestamps, and future timestamps', async () => {
    const timestamp = 1_000;
    const valid = await sign(timestamp, payload, secret);
    const verifier = createWebCryptoStripeWebhookVerifier(secret);
    const modified = new TextEncoder().encode('{"id": "evt_signature"}');
    await expect(
      verifier.verify({
        rawBody: modified,
        signatureHeader: `t=${timestamp},v1=${valid}`,
        receivedAt: 1_000_000,
      }),
    ).resolves.toEqual({ kind: 'rejected' });
    await expect(
      createWebCryptoStripeWebhookVerifier(
        parseStripeWebhookSecret('whsec_zyxwvutsrqponmlkjihgfedc'),
      ).verify({
        rawBody: payload,
        signatureHeader: `t=${timestamp},v1=${valid}`,
        receivedAt: 1_000_000,
      }),
    ).resolves.toEqual({ kind: 'rejected' });
    await expect(
      verifier.verify({
        rawBody: payload,
        signatureHeader: `t=${timestamp},v1=${valid}`,
        receivedAt: 1_300_001,
      }),
    ).resolves.toEqual({ kind: 'rejected' });
    const futureTimestamp = 1_301;
    await expect(
      verifier.verify({
        rawBody: payload,
        signatureHeader: `t=${futureTimestamp},v1=${await sign(futureTimestamp, payload, secret)}`,
        receivedAt: 1_000_000,
      }),
    ).resolves.toEqual({ kind: 'rejected' });
  });

  it('rejects ambiguous/malformed headers and a disabled recency check', () => {
    expect(
      parseStripeSignatureHeader(`t=1,t=2,v1=${'0'.repeat(64)}`),
    ).toBeUndefined();
    expect(
      parseStripeSignatureHeader(`t=1,v1=${'x'.repeat(64)}`),
    ).toBeUndefined();
    expect(() => createWebCryptoStripeWebhookVerifier(secret, 0)).toThrow(
      /positive integer/,
    );
  });

  it('rejects an oversized raw payload before cryptographic work', async () => {
    await expect(
      createWebCryptoStripeWebhookVerifier(secret).verify({
        rawBody: new Uint8Array(256 * 1_024 + 1),
        signatureHeader: `t=1,v1=${'0'.repeat(64)}`,
        receivedAt: 1_000,
      }),
    ).resolves.toEqual({ kind: 'rejected' });
  });
});

async function sign(
  timestamp: number,
  body: Uint8Array,
  signingSecret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(new TextEncoder().encode(signingSecret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.byteLength + body.byteLength);
  signed.set(prefix);
  signed.set(body, prefix.byteLength);
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, toArrayBuffer(signed)),
  );
  return [...signature]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

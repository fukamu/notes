import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { accountDeletionWireStatusDecoder } from '@/lib/application/account-deletion-handoff';
import { decodeLegalCommerceDisclosure } from '@/lib/application/legal-commerce';
import { decodeLegalTermsDisclosure } from '@/lib/application/legal-terms';
import { createBillingUiHttpTransport } from '@/lib/client/http-billing-ui';
import { createPrivacyRequestUiHttpTransport } from '@/lib/client/http-privacy-request';
import { createTermsConsentUiHttpTransport } from '@/lib/client/terms-consent-ui';
import {
  decodeSyncRequest,
  decodeSyncResponse,
  encodeSyncRequest,
} from '@/lib/sync/protocol';
import {
  decodeSyncV2Request,
  decodeSyncV2Response,
} from '@/lib/sync/v2-protocol';

const fixtureRoot = new URL('../../contracts/fixtures/', import.meta.url);

describe('Go migration browser wire fixtures', () => {
  it('keeps the legacy sync request bytes and response decoder compatible', async () => {
    const value = record(await fixture('sync/legacy-v1.json'));
    const request = decodeSyncRequest(field(value, 'request'));
    const response = decodeSyncResponse(
      field(value, 'response'),
      request.mutations,
    );

    expect(JSON.stringify(encodeSyncRequest(request))).toBe(
      text(field(value, 'canonicalRequestJson')),
    );
    expect(response.cards).toHaveLength(2);
    expect(response.cards[1]?.body).toEqual([]);
    expect(response.conflicts).toEqual([]);
  });

  it('rejects every unsafe or ambiguous legacy sync fixture', async () => {
    const value = record(await fixture('sync/rejections.json'));
    const cases = field(value, 'cases');
    if (!Array.isArray(cases)) throw new Error('cases must be an array');
    for (const testCase of cases) {
      const candidate = record(testCase);
      expect(
        () => decodeSyncRequest(field(candidate, 'input')),
        text(field(candidate, 'name')),
      ).toThrow();
    }
  });

  it('preserves v2 null cursors and empty arrays on the browser boundary', async () => {
    const value = record(await fixture('sync/v2.json'));
    const request = decodeSyncV2Request(field(value, 'request'));
    const response = decodeSyncV2Response(
      field(value, 'response'),
      request.mutations,
    );

    expect(request.cursor).toBeNull();
    expect(request.mutations).toEqual([]);
    expect(response).toMatchObject({
      changes: [],
      receipts: [],
      highWatermark: 0,
    });
  });

  it('decodes the legal disclosures rendered by the browser', async () => {
    const commerce = record(await fixture('legal/contract-evidence.json'));
    const terms = record(await fixture('legal/terms-consent.json'));

    expect(
      decodeLegalCommerceDisclosure(field(commerce, 'disclosure')),
    ).toMatchObject({
      kind: 'decoded',
      disclosure: { offer: { trialDays: 14 } },
    });
    expect(
      decodeLegalTermsDisclosure(field(terms, 'disclosure')),
    ).toMatchObject({
      kind: 'decoded',
      disclosure: {
        termsVersion: 'terms-v1:2026-09-15',
        authentication: { password: false, sharedVault: false },
      },
    });
  });

  it('decodes billing and rejects an untrusted checkout destination', async () => {
    const value = record(await fixture('billing/checkout.json'));
    const offer = field(value, 'offer');
    const offerHash = text(field(value, 'offerHash'));
    const load = createBillingUiHttpTransport(async () =>
      Response.json({ offer, offerHash }),
    );
    const loaded = await load.loadOffer();
    expect(loaded).toMatchObject({
      kind: 'available',
      offer: { serviceName: 'FUKAMU Notes', trialDays: 14 },
      offerHash,
    });
    if (loaded.kind !== 'available') throw new Error('fixture offer rejected');

    const redirect = record(field(value, 'redirect'));
    const untrusted = createBillingUiHttpTransport(async () =>
      Response.json({
        ...redirect,
        checkoutUrl: 'https://checkout.stripe.com.evil.test/session',
      }),
    );
    await expect(
      untrusted.submitCheckout({
        offer: loaded.offer,
        offerHash: loaded.offerHash,
        terms: {
          termsVersion: 'terms-v1:2026-09-15',
          termsHash: `sha256:${'a'.repeat(64)}`,
          effectiveDate: '2026-09-15',
        },
        submissionId: '01991f20-61d2-7000-8000-000000002401',
      }),
    ).resolves.toEqual({ kind: 'unavailable' });
  });

  it('decodes account, privacy, and terms responses without trusting scope fields', async () => {
    const value = record(await fixture('account/lifecycle.json'));
    const deletion = record(field(value, 'deletion'));
    expect(
      accountDeletionWireStatusDecoder.decode(field(deletion, 'inProgress')),
    ).toMatchObject({ ok: true, value: { kind: 'in-progress' } });
    expect(
      accountDeletionWireStatusDecoder.decode(
        field(deletion, 'invalidTerminal'),
      ),
    ).toMatchObject({ ok: false });

    const privacy = record(field(value, 'privacy'));
    const submit = record(field(privacy, 'submit'));
    const privacyTransport = createPrivacyRequestUiHttpTransport(async () =>
      Response.json(field(privacy, 'pending')),
    );
    await expect(
      privacyTransport.submit({
        submissionId: text(field(submit, 'submissionId')),
        requestKind: 'disclosure',
      }),
    ).resolves.toMatchObject({ kind: 'accepted' });

    const terms = record(field(value, 'terms'));
    const termsTransport = createTermsConsentUiHttpTransport(async () =>
      Response.json(field(terms, 'status')),
    );
    await expect(termsTransport.loadStatus()).resolves.toMatchObject({
      kind: 'available',
      status: { kind: 'current', acceptanceRequired: true },
    });
  });
});

async function fixture(name: string): Promise<unknown> {
  const value: unknown = JSON.parse(
    await readFile(new URL(name, fixtureRoot), 'utf8'),
  );
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('fixture value must be an object');
  }
  return value as Record<string, unknown>;
}

function field(value: Record<string, unknown>, name: string): unknown {
  if (!Object.hasOwn(value, name))
    throw new TypeError(`missing fixture field ${name}`);
  return value[name];
}

function text(value: unknown): string {
  if (typeof value !== 'string')
    throw new TypeError('fixture value must be text');
  return value;
}

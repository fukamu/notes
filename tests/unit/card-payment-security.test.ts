import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  cardPaymentSecurityControlIds,
  cardPaymentSecurityManifest,
  decodeCardPaymentSecurityManifest,
  evaluateCardPaymentSecurityReadiness,
} from '@/lib/application/card-payment-security';
import { planStripeCheckout } from '@/server/stripe/core';
import {
  stripeConfiguration,
  stripeHostedCheckoutCommand,
} from '@/tests/fixtures/stripe';

describe('card payment security contract', () => {
  it('keeps a complete, decodable control inventory while launch evidence is pending', () => {
    expect(
      decodeCardPaymentSecurityManifest(cardPaymentSecurityManifest),
    ).toEqual({
      kind: 'decoded',
      manifest: cardPaymentSecurityManifest,
    });
    expect(
      evaluateCardPaymentSecurityReadiness(cardPaymentSecurityManifest),
    ).toEqual({
      kind: 'blocked',
      missingEvidence: [
        'merchant-contract-review',
        'pci-saq-confirmation',
        'production-3ds-evidence',
        'vulnerability-management-evidence',
        'incident-contact',
      ],
    });
    expect(cardPaymentSecurityManifest.controls.map(({ id }) => id)).toEqual(
      cardPaymentSecurityControlIds,
    );
  });

  it('rejects unsupported PCI claims and incomplete evidence inventories', () => {
    expect(
      decodeCardPaymentSecurityManifest({
        ...cardPaymentSecurityManifest,
        pciClaim: 'pci-compliant',
      }),
    ).toMatchObject({ kind: 'invalid' });
    expect(
      decodeCardPaymentSecurityManifest({
        ...cardPaymentSecurityManifest,
        controls: cardPaymentSecurityManifest.controls.slice(1),
      }),
    ).toMatchObject({ kind: 'invalid' });
  });

  it('uses hosted Checkout, requests 3DS and never accepts cardholder fields', async () => {
    const command = planStripeCheckout(
      stripeConfiguration,
      stripeHostedCheckoutCommand(),
    );
    const fields = new Map(command.fields);
    expect(fields.get('mode')).toBe('subscription');
    expect(fields.get('payment_method_collection')).toBe('always');
    expect(
      fields.get('payment_method_options[card][request_three_d_secure]'),
    ).toBe('any');

    const boundaryFiles = [
      'app/api/billing/http.ts',
      'app/api/billing/checkout/handler.ts',
      'lib/application/billing-ui.ts',
      'lib/client/http-billing-ui.ts',
      'server/legal-checkout/checkout-core.ts',
      'server/legal-checkout/public.ts',
      'server/stripe/core.ts',
      'server/stripe/ports.ts',
      'server/stripe/public.ts',
      'server/stripe/service.ts',
    ];
    const forbiddenCardFields =
      /\b(?:card_?number|cardNumber|primaryAccountNumber|pan|cvc|cvv|exp(?:iry)?Month|exp(?:iry)?Year)\b/iu;
    const violations: string[] = [];
    for (const file of boundaryFiles) {
      const source = await readFile(file, 'utf8');
      if (forbiddenCardFields.test(source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it('runs the card boundary drift check in every build', async () => {
    const packageSource = await readFile('package.json', 'utf8');
    expect(packageSource).toContain('check:card-payment-security');
    expect(packageSource).toContain('verify-card-payment-security.mjs');
  });
});

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  cardPaymentSecurityControlIds,
  cardPaymentSecurityManifest,
  decodeCardPaymentSecurityManifest,
  evaluateCardPaymentSecurityReadiness,
} from '@/lib/application/card-payment-security';

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

  it('keeps browser and Go Checkout boundaries hosted-only and card-data-free', async () => {
    const boundaryFiles = [
      'lib/application/billing-ui.ts',
      'lib/client/http-billing-ui.ts',
      'components/billing-checkout-boundary.tsx',
      'backend/internal/stripebilling/core.go',
      'backend/internal/adapters/stripe/provider.go',
    ];
    const forbiddenCardFields =
      /\b(?:card_?number|cardNumber|primaryAccountNumber|pan|cvc|cvv|exp(?:iry)?Month|exp(?:iry)?Year)\b/iu;
    const violations: string[] = [];
    for (const file of boundaryFiles) {
      const source = await readFile(file, 'utf8');
      if (forbiddenCardFields.test(source)) violations.push(file);
    }
    expect(violations).toEqual([]);

    const [browserTransport, goProvider, goProviderTest] = await Promise.all([
      readFile('lib/client/http-billing-ui.ts', 'utf8'),
      readFile('backend/internal/adapters/stripe/provider.go', 'utf8'),
      readFile('backend/internal/adapters/stripe/provider_test.go', 'utf8'),
    ]);
    expect(browserTransport).toContain(
      "decideBrowserExternalDestination('stripe-checkout'",
    );
    expect(goProvider).toContain(
      'PaymentMethodCollection: stripe.String("always")',
    );
    expect(goProvider).toContain('RequestThreeDSecure: stripe.String("any")');
    expect(goProviderTest).toContain(
      'func TestProviderUsesPinnedSDKCheckoutContract',
    );
  });

  it('runs the card boundary drift check in every build', async () => {
    const packageSource = await readFile('package.json', 'utf8');
    expect(packageSource).toContain('check:card-payment-security');
    expect(packageSource).toContain('verify-card-payment-security.mjs');
  });
});

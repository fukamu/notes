import {
  arrayDecoder,
  literalDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
} from '../codec/core.ts';

export const CARD_PAYMENT_SECURITY_SCHEMA_VERSION = 1;

export const cardPaymentSecurityControlIds = [
  'hosted-checkout-boundary',
  'pan-cvc-non-transit',
  'emv-3ds-request',
  'off-session-payment-method',
  'verified-entitlement-authority',
  'login-abuse-protection',
  'merchant-contract-review',
  'pci-saq-confirmation',
  'production-3ds-evidence',
  'vulnerability-management-evidence',
  'incident-contact',
] as const;

export type CardPaymentSecurityControlId =
  (typeof cardPaymentSecurityControlIds)[number];
export type CardPaymentSecurityControlStatus =
  | 'implemented-and-automated'
  | 'production-evidence-required';

export type CardPaymentSecurityControl = Readonly<{
  id: CardPaymentSecurityControlId;
  status: CardPaymentSecurityControlStatus;
  evidence: readonly string[];
}>;

export type CardPaymentSecurityManifest = Readonly<{
  schemaVersion: typeof CARD_PAYMENT_SECURITY_SCHEMA_VERSION;
  manifestVersion: string;
  reviewedOn: string;
  merchantRole: 'operator-is-merchant-assumption-pending-contract-review';
  provider: 'stripe';
  integration: 'stripe-hosted-checkout';
  pciClaim: 'not-asserted-pending-provider-confirmation';
  dataFlow: Readonly<{
    paymentEntryOrigin: 'https://checkout.stripe.com';
    cardholderDataCollector: 'stripe';
    applicationCardDataHandling: 'never-collected-stored-or-transited';
    applicationProviderData: 'opaque-identifiers-and-verified-facts-only';
  }>;
  authentication: Readonly<{
    setupUsage: 'off_session';
    requestThreeDSecure: 'any';
    paymentActionRequired: 'lock-online-immediately';
    resumeAuthority: 'invoice-paid-only';
  }>;
  controls: readonly CardPaymentSecurityControl[];
}>;

export type CardPaymentSecurityManifestDecodeResult =
  | {
      readonly kind: 'decoded';
      readonly manifest: CardPaymentSecurityManifest;
    }
  | { readonly kind: 'invalid'; readonly issues: readonly string[] };

export type CardPaymentSecurityReadiness =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'blocked';
      readonly missingEvidence: readonly CardPaymentSecurityControlId[];
    };

const textDecoder = refineDecoder(
  stringDecoder({ minLength: 1, maxLength: 1_000 }),
  (value) => value.trim().length > 0,
  'expected non-blank text',
);
const dateDecoder = refineDecoder(
  stringDecoder({ minLength: 10, maxLength: 10 }),
  validCalendarDate,
  'expected a valid YYYY-MM-DD date',
);
const controlIdDecoder: Decoder<CardPaymentSecurityControlId> = unionDecoder(
  ...cardPaymentSecurityControlIds.map((id) => literalDecoder(id)),
);
const controlStatusDecoder: Decoder<CardPaymentSecurityControlStatus> =
  unionDecoder(
    literalDecoder('implemented-and-automated'),
    literalDecoder('production-evidence-required'),
  );
const controlDecoder: Decoder<CardPaymentSecurityControl> = transformDecoder(
  objectDecoder({
    id: controlIdDecoder,
    status: controlStatusDecoder,
    evidence: arrayDecoder(textDecoder, {
      minLength: 1,
      maxLength: 10,
      uniqueBy: (value) => value,
    }),
  }),
  (value): CardPaymentSecurityControl => value,
);
const manifestDecoder: Decoder<CardPaymentSecurityManifest> = transformDecoder(
  objectDecoder({
    schemaVersion: transformDecoder(
      safeIntegerDecoder({ minimum: 1, maximum: 1 }),
      (): typeof CARD_PAYMENT_SECURITY_SCHEMA_VERSION =>
        CARD_PAYMENT_SECURITY_SCHEMA_VERSION,
    ),
    manifestVersion: textDecoder,
    reviewedOn: dateDecoder,
    merchantRole: literalDecoder(
      'operator-is-merchant-assumption-pending-contract-review',
    ),
    provider: literalDecoder('stripe'),
    integration: literalDecoder('stripe-hosted-checkout'),
    pciClaim: literalDecoder('not-asserted-pending-provider-confirmation'),
    dataFlow: objectDecoder({
      paymentEntryOrigin: literalDecoder('https://checkout.stripe.com'),
      cardholderDataCollector: literalDecoder('stripe'),
      applicationCardDataHandling: literalDecoder(
        'never-collected-stored-or-transited',
      ),
      applicationProviderData: literalDecoder(
        'opaque-identifiers-and-verified-facts-only',
      ),
    }),
    authentication: objectDecoder({
      setupUsage: literalDecoder('off_session'),
      requestThreeDSecure: literalDecoder('any'),
      paymentActionRequired: literalDecoder('lock-online-immediately'),
      resumeAuthority: literalDecoder('invoice-paid-only'),
    }),
    controls: arrayDecoder(controlDecoder, {
      minLength: cardPaymentSecurityControlIds.length,
      maxLength: cardPaymentSecurityControlIds.length,
      uniqueBy: (value) => value.id,
    }),
  }),
  (value): CardPaymentSecurityManifest => value,
);

export const cardPaymentSecurityManifest: CardPaymentSecurityManifest = {
  schemaVersion: CARD_PAYMENT_SECURITY_SCHEMA_VERSION,
  manifestVersion: 'card-payment-security-v1:2026-09-15',
  reviewedOn: '2026-09-15',
  merchantRole: 'operator-is-merchant-assumption-pending-contract-review',
  provider: 'stripe',
  integration: 'stripe-hosted-checkout',
  pciClaim: 'not-asserted-pending-provider-confirmation',
  dataFlow: {
    paymentEntryOrigin: 'https://checkout.stripe.com',
    cardholderDataCollector: 'stripe',
    applicationCardDataHandling: 'never-collected-stored-or-transited',
    applicationProviderData: 'opaque-identifiers-and-verified-facts-only',
  },
  authentication: {
    setupUsage: 'off_session',
    requestThreeDSecure: 'any',
    paymentActionRequired: 'lock-online-immediately',
    resumeAuthority: 'invoice-paid-only',
  },
  controls: [
    {
      id: 'hosted-checkout-boundary',
      status: 'implemented-and-automated',
      evidence: [
        'Checkout responses accept only the exact checkout.stripe.com origin',
        'The local fixture never creates a Stripe Checkout session',
      ],
    },
    {
      id: 'pan-cvc-non-transit',
      status: 'implemented-and-automated',
      evidence: [
        'Billing HTTP and Stripe application contracts expose no PAN, CVC or expiry fields',
        'The source boundary scan runs in the build gate',
      ],
    },
    {
      id: 'emv-3ds-request',
      status: 'implemented-and-automated',
      evidence: [
        'Checkout requests set payment_method_options[card][request_three_d_secure]=any',
      ],
    },
    {
      id: 'off-session-payment-method',
      status: 'implemented-and-automated',
      evidence: [
        'Trial projection requires a succeeded SetupIntent with usage=off_session',
      ],
    },
    {
      id: 'verified-entitlement-authority',
      status: 'implemented-and-automated',
      evidence: [
        'Webhook signatures and provider mapping are verified before billing facts are accepted',
        'Payment action locks online use and only invoice.paid resumes it',
      ],
    },
    {
      id: 'login-abuse-protection',
      status: 'implemented-and-automated',
      evidence: [
        'Authentication is Google OIDC or one-time Email OTP without passwords',
        'Email OTP has expiry, single-use, attempt and rate-limit controls',
      ],
    },
    {
      id: 'merchant-contract-review',
      status: 'production-evidence-required',
      evidence: [
        'Confirm the operating company is the merchant and Stripe is its PSP/payment processor',
      ],
    },
    {
      id: 'pci-saq-confirmation',
      status: 'production-evidence-required',
      evidence: [
        'Record the applicable SAQ and PCI scope confirmed with Stripe or the acquirer',
      ],
    },
    {
      id: 'production-3ds-evidence',
      status: 'production-evidence-required',
      evidence: [
        'Record sandbox 3DS challenge, failure and recurring-payment results for the production configuration',
      ],
    },
    {
      id: 'vulnerability-management-evidence',
      status: 'production-evidence-required',
      evidence: [
        'The 2026-09-15 npm production-dependency audit reported five high-severity findings',
        'Record dependency and application vulnerability review results and remediation ownership',
      ],
    },
    {
      id: 'incident-contact',
      status: 'production-evidence-required',
      evidence: [
        'Replace the incident contact placeholder and complete the card incident escalation drill',
      ],
    },
  ],
};

export function decodeCardPaymentSecurityManifest(
  input: unknown,
): CardPaymentSecurityManifestDecodeResult {
  const decoded = manifestDecoder.decode(input);
  if (!decoded.ok) {
    return {
      kind: 'invalid',
      issues: decoded.issues.map(
        (issue) =>
          `${issue.path.length === 0 ? '$' : `$.${issue.path.join('.')}`}: ${issue.reason}`,
      ),
    };
  }
  const issues: string[] = [];
  if (
    decoded.value.manifestVersion !==
    `card-payment-security-v1:${decoded.value.reviewedOn}`
  ) {
    issues.push(
      '$.manifestVersion must match card-payment-security-v1:<reviewedOn>',
    );
  }
  for (const id of cardPaymentSecurityControlIds) {
    if (!decoded.value.controls.some((control) => control.id === id)) {
      issues.push(`$.controls must include ${id}`);
    }
  }
  return issues.length === 0
    ? { kind: 'decoded', manifest: decoded.value }
    : { kind: 'invalid', issues };
}

export function evaluateCardPaymentSecurityReadiness(
  manifest: CardPaymentSecurityManifest,
): CardPaymentSecurityReadiness {
  const missingEvidence = manifest.controls
    .filter((control) => control.status === 'production-evidence-required')
    .map((control) => control.id);
  return missingEvidence.length === 0
    ? { kind: 'ready' }
    : { kind: 'blocked', missingEvidence };
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

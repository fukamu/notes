import { readFile } from 'node:fs/promises';
import {
  cardPaymentSecurityControlIds,
  cardPaymentSecurityManifest,
  decodeCardPaymentSecurityManifest,
  evaluateCardPaymentSecurityReadiness,
} from '../lib/application/card-payment-security.ts';

const decoded = decodeCardPaymentSecurityManifest(cardPaymentSecurityManifest);
if (decoded.kind !== 'decoded') {
  throw new Error(
    `card payment security manifest is invalid: ${decoded.issues.join('; ')}`,
  );
}

const readiness = evaluateCardPaymentSecurityReadiness(decoded.manifest);
if (readiness.kind !== 'blocked') {
  throw new Error(
    'card payment security must remain launch-blocked until production evidence is recorded',
  );
}
const expectedEvidence = new Set([
  'merchant-contract-review',
  'pci-saq-confirmation',
  'production-3ds-evidence',
  'vulnerability-management-evidence',
  'incident-contact',
]);
if (
  readiness.missingEvidence.length !== expectedEvidence.size ||
  readiness.missingEvidence.some((id) => !expectedEvidence.has(id))
) {
  throw new Error('card payment security production-evidence blockers drifted');
}

const sources = await Promise.all(
  [
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
  ].map(async (path) => ({ path, source: await readFile(path, 'utf8') })),
);
const forbiddenCardFields =
  /\b(?:card_?number|cardNumber|primaryAccountNumber|pan|cvc|cvv|exp(?:iry)?Month|exp(?:iry)?Year)\b/iu;
const violations = sources
  .filter(({ source }) => forbiddenCardFields.test(source))
  .map(({ path }) => path);
if (violations.length > 0) {
  throw new Error(
    `cardholder-data field crossed the application boundary: ${violations.join(', ')}`,
  );
}

const stripeCore = await readFile('server/stripe/core.ts', 'utf8');
if (
  !stripeCore.includes(
    "['payment_method_options[card][request_three_d_secure]', 'any']",
  )
) {
  throw new Error(
    'Stripe Checkout no longer explicitly requests EMV 3-D Secure',
  );
}
if (!stripeCore.includes("url.hostname === 'checkout.stripe.com'")) {
  throw new Error(
    'Stripe Checkout response is not restricted to the hosted origin',
  );
}

const checkout = await readFile(
  'components/billing-checkout-boundary.tsx',
  'utf8',
);
for (const marker of [
  'data-testid="card-security-notice"',
  'カード番号・セキュリティコードはStripeの画面で入力され',
  'Notesのサーバーでは取得・保存しません',
  '本人認証（3Dセキュア）',
]) {
  if (!checkout.includes(marker)) {
    throw new Error(`checkout card-security disclosure is missing: ${marker}`);
  }
}

if (decoded.manifest.controls.length !== cardPaymentSecurityControlIds.length) {
  throw new Error('card payment security control inventory drifted');
}

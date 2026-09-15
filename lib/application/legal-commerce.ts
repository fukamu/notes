import { localLegalOperatorFixture } from './legal-operator-fixture.ts';
import {
  FUKAMU_BILLING_PERIOD,
  FUKAMU_MONTHLY_PRICE_YEN,
} from './legal-product.ts';

export const LEGAL_COMMERCE_SCHEMA_VERSION = 1;
export const LEGAL_TRIAL_DAYS = 14;

export type BillingPeriod = 'monthly' | 'annual';

export type LegalCommerceDisclosure = Readonly<{
  schemaVersion: typeof LEGAL_COMMERCE_SCHEMA_VERSION;
  seller: Readonly<{
    legalName: string;
    representative: string;
    postalAddress: string;
    phone: string;
    supportUrl: string;
  }>;
  offer: Readonly<{
    planName: string;
    priceYen: number;
    billingPeriod: BillingPeriod;
    taxIncluded: true;
    trialDays: typeof LEGAL_TRIAL_DAYS;
  }>;
  additionalFees: string;
  cancellationPolicy: string;
  refundPolicy: string;
  specialTerms: string;
  systemRequirements: readonly string[];
  effectiveDate: string;
}>;

export type LegalCommerceDecodeResult =
  | { readonly kind: 'decoded'; readonly disclosure: LegalCommerceDisclosure }
  | { readonly kind: 'invalid'; readonly issues: readonly string[] };

export type LegalCommerceResolution =
  | {
      readonly kind: 'ready';
      readonly source: 'local-fixture' | 'production-configuration';
      readonly disclosure: LegalCommerceDisclosure;
    }
  | {
      readonly kind: 'blocked';
      readonly reason:
        | 'invalid-environment'
        | 'invalid-service-mode'
        | 'missing-production-configuration'
        | 'invalid-production-configuration';
      readonly issues: readonly string[];
    };

export const localLegalCommerceFixture: LegalCommerceDisclosure = {
  schemaVersion: LEGAL_COMMERCE_SCHEMA_VERSION,
  seller: {
    legalName: localLegalOperatorFixture.legalName,
    representative: localLegalOperatorFixture.representative,
    postalAddress: localLegalOperatorFixture.postalAddress,
    phone: localLegalOperatorFixture.phone,
    supportUrl: localLegalOperatorFixture.supportUrl,
  },
  offer: {
    planName: '開発用サンプル月額プラン',
    priceYen: FUKAMU_MONTHLY_PRICE_YEN,
    billingPeriod: FUKAMU_BILLING_PERIOD,
    taxIncluded: true,
    trialDays: LEGAL_TRIAL_DAYS,
  },
  additionalFees: '開発用サンプル：インターネット接続料金は利用者負担',
  cancellationPolicy: '開発用サンプル：アカウント画面から解約',
  refundPolicy: '開発用サンプル：返金条件は未確定',
  specialTerms: '開発用サンプル：本表示で契約や課金は行われません',
  systemRequirements: ['開発用サンプル：サポート対象ブラウザは未確定'],
  effectiveDate: '2026-09-14',
};

export function decodeLegalCommerceDisclosure(
  input: unknown,
): LegalCommerceDecodeResult {
  const issues: string[] = [];
  if (!isRecord(input)) return invalid('disclosure must be an object');

  rejectUnknownFields(
    input,
    [
      'schemaVersion',
      'seller',
      'offer',
      'additionalFees',
      'cancellationPolicy',
      'refundPolicy',
      'specialTerms',
      'systemRequirements',
      'effectiveDate',
    ],
    '$',
    issues,
  );
  if (input.schemaVersion !== LEGAL_COMMERCE_SCHEMA_VERSION) {
    issues.push('schemaVersion must be 1');
  }

  const seller = decodeSeller(input.seller, issues);
  const offer = decodeOffer(input.offer, issues);
  const additionalFees = requiredString(
    input,
    'additionalFees',
    '$.additionalFees',
    1,
    500,
    issues,
  );
  const cancellationPolicy = requiredString(
    input,
    'cancellationPolicy',
    '$.cancellationPolicy',
    1,
    1_000,
    issues,
  );
  const refundPolicy = requiredString(
    input,
    'refundPolicy',
    '$.refundPolicy',
    1,
    1_000,
    issues,
  );
  const specialTerms = requiredString(
    input,
    'specialTerms',
    '$.specialTerms',
    1,
    1_000,
    issues,
  );
  const systemRequirements = stringArray(
    input.systemRequirements,
    '$.systemRequirements',
    issues,
  );
  const effectiveDate = requiredString(
    input,
    'effectiveDate',
    '$.effectiveDate',
    10,
    10,
    issues,
  );
  if (!validCalendarDate(effectiveDate)) {
    issues.push('$.effectiveDate must use a valid YYYY-MM-DD date');
  }

  if (issues.length > 0 || seller === undefined || offer === undefined) {
    return { kind: 'invalid', issues };
  }
  return {
    kind: 'decoded',
    disclosure: {
      schemaVersion: LEGAL_COMMERCE_SCHEMA_VERSION,
      seller,
      offer,
      additionalFees,
      cancellationPolicy,
      refundPolicy,
      specialTerms,
      systemRequirements,
      effectiveDate,
    },
  };
}

export function resolveLegalCommerceDisclosure(
  environment: unknown,
): LegalCommerceResolution {
  if (!isRecord(environment)) {
    return {
      kind: 'blocked',
      reason: 'invalid-environment',
      issues: ['environment must be an object'],
    };
  }
  const serviceMode = environment.FUKAMU_SERVICE_MODE;
  if (serviceMode === undefined || serviceMode === 'legacy-test') {
    return {
      kind: 'ready',
      source: 'local-fixture',
      disclosure: localLegalCommerceFixture,
    };
  }
  if (serviceMode !== 'public-paid') {
    return {
      kind: 'blocked',
      reason: 'invalid-service-mode',
      issues: ['FUKAMU_SERVICE_MODE must be legacy-test or public-paid'],
    };
  }

  const source = environment.FUKAMU_LEGAL_COMMERCE_JSON;
  if (typeof source !== 'string' || source.length === 0) {
    return {
      kind: 'blocked',
      reason: 'missing-production-configuration',
      issues: ['FUKAMU_LEGAL_COMMERCE_JSON is required in public-paid mode'],
    };
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(source);
  } catch {
    return {
      kind: 'blocked',
      reason: 'invalid-production-configuration',
      issues: ['FUKAMU_LEGAL_COMMERCE_JSON must be valid JSON'],
    };
  }
  const decoded = decodeLegalCommerceDisclosure(candidate);
  if (decoded.kind === 'invalid') {
    return {
      kind: 'blocked',
      reason: 'invalid-production-configuration',
      issues: decoded.issues,
    };
  }
  const productionIssues = validateProductionDisclosure(decoded.disclosure);
  return productionIssues.length === 0
    ? {
        kind: 'ready',
        source: 'production-configuration',
        disclosure: decoded.disclosure,
      }
    : {
        kind: 'blocked',
        reason: 'invalid-production-configuration',
        issues: productionIssues,
      };
}

export function formatTaxIncludedPrice(disclosure: LegalCommerceDisclosure) {
  const digits = String(disclosure.offer.priceYen);
  const formatted = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${formatted}円（税込）`;
}

export function billingPeriodLabel(period: BillingPeriod): string {
  return period === 'monthly' ? '月額' : '年額';
}

function decodeSeller(
  input: unknown,
  issues: string[],
): LegalCommerceDisclosure['seller'] | undefined {
  if (!isRecord(input)) {
    issues.push('$.seller must be an object');
    return undefined;
  }
  rejectUnknownFields(
    input,
    ['legalName', 'representative', 'postalAddress', 'phone', 'supportUrl'],
    '$.seller',
    issues,
  );
  const legalName = requiredString(
    input,
    'legalName',
    '$.seller.legalName',
    1,
    200,
    issues,
  );
  const representative = requiredString(
    input,
    'representative',
    '$.seller.representative',
    1,
    200,
    issues,
  );
  const postalAddress = requiredString(
    input,
    'postalAddress',
    '$.seller.postalAddress',
    5,
    500,
    issues,
  );
  const phone = requiredString(input, 'phone', '$.seller.phone', 9, 30, issues);
  if (!/^\+?[0-9][0-9()-]{7,28}[0-9]$/.test(phone)) {
    issues.push('$.seller.phone must be a telephone number');
  }
  const supportUrl = requiredString(
    input,
    'supportUrl',
    '$.seller.supportUrl',
    1,
    500,
    issues,
  );
  if (!httpUrl(supportUrl)) {
    issues.push('$.seller.supportUrl must be an absolute HTTP(S) URL');
  }
  return { legalName, representative, postalAddress, phone, supportUrl };
}

function decodeOffer(
  input: unknown,
  issues: string[],
): LegalCommerceDisclosure['offer'] | undefined {
  if (!isRecord(input)) {
    issues.push('$.offer must be an object');
    return undefined;
  }
  rejectUnknownFields(
    input,
    ['planName', 'priceYen', 'billingPeriod', 'taxIncluded', 'trialDays'],
    '$.offer',
    issues,
  );
  const planName = requiredString(
    input,
    'planName',
    '$.offer.planName',
    1,
    200,
    issues,
  );
  const priceYen = input.priceYen;
  if (
    typeof priceYen !== 'number' ||
    !Number.isSafeInteger(priceYen) ||
    priceYen < 1 ||
    priceYen > 10_000_000
  ) {
    issues.push('$.offer.priceYen must be a positive safe integer');
  }
  const billingPeriod = input.billingPeriod;
  if (billingPeriod !== 'monthly' && billingPeriod !== 'annual') {
    issues.push('$.offer.billingPeriod must be monthly or annual');
  }
  if (input.taxIncluded !== true) {
    issues.push('$.offer.taxIncluded must be true');
  }
  if (input.trialDays !== LEGAL_TRIAL_DAYS) {
    issues.push('$.offer.trialDays must be 14');
  }
  if (
    typeof priceYen !== 'number' ||
    !Number.isSafeInteger(priceYen) ||
    priceYen < 1 ||
    priceYen > 10_000_000 ||
    (billingPeriod !== 'monthly' && billingPeriod !== 'annual')
  ) {
    return undefined;
  }
  return {
    planName,
    priceYen,
    billingPeriod,
    taxIncluded: true,
    trialDays: LEGAL_TRIAL_DAYS,
  };
}

function validateProductionDisclosure(
  disclosure: LegalCommerceDisclosure,
): readonly string[] {
  const issues: string[] = [];
  if (disclosure.offer.priceYen !== FUKAMU_MONTHLY_PRICE_YEN) {
    issues.push(`$.offer.priceYen must be ${FUKAMU_MONTHLY_PRICE_YEN}`);
  }
  if (disclosure.offer.billingPeriod !== FUKAMU_BILLING_PERIOD) {
    issues.push(`$.offer.billingPeriod must be ${FUKAMU_BILLING_PERIOD}`);
  }
  const strings = [
    ['$.seller.legalName', disclosure.seller.legalName],
    ['$.seller.representative', disclosure.seller.representative],
    ['$.seller.postalAddress', disclosure.seller.postalAddress],
    ['$.seller.phone', disclosure.seller.phone],
    ['$.seller.supportUrl', disclosure.seller.supportUrl],
    ['$.offer.planName', disclosure.offer.planName],
    ['$.additionalFees', disclosure.additionalFees],
    ['$.cancellationPolicy', disclosure.cancellationPolicy],
    ['$.refundPolicy', disclosure.refundPolicy],
    ['$.specialTerms', disclosure.specialTerms],
    ...disclosure.systemRequirements.map(
      (value, index) => [`$.systemRequirements[${index}]`, value] as const,
    ),
  ] as const;
  const placeholder =
    /(?:placeholder|example|sample|todo|tbd|未設定|開発用|サンプル)/i;
  for (const [path, value] of strings) {
    if (placeholder.test(value)) issues.push(`${path} contains a placeholder`);
  }
  if (!disclosure.seller.legalName.includes('株式会社')) {
    issues.push('$.seller.legalName must contain the verified corporate name');
  }
  const phoneDigits = disclosure.seller.phone.replace(/\D/g, '');
  if (phoneDigits.length < 9 || /^0+$/.test(phoneDigits)) {
    issues.push('$.seller.phone must be a reachable production number');
  }
  try {
    const support = new URL(disclosure.seller.supportUrl);
    if (
      support.protocol !== 'https:' ||
      support.hostname === 'localhost' ||
      support.hostname.endsWith('.example') ||
      support.hostname.endsWith('.test')
    ) {
      issues.push('$.seller.supportUrl must be a production HTTPS URL');
    }
  } catch {
    issues.push('$.seller.supportUrl must be a production HTTPS URL');
  }
  return issues;
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
  path: string,
  minimum: number,
  maximum: number,
  issues: string[],
): string {
  const value = record[field];
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum
  ) {
    issues.push(`${path} must contain ${minimum}-${maximum} characters`);
    return '';
  }
  return value;
}

function stringArray(
  input: unknown,
  path: string,
  issues: string[],
): readonly string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 10) {
    issues.push(`${path} must contain 1-10 items`);
    return [];
  }
  const values: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of input.entries()) {
    if (typeof item !== 'string' || item.length < 1 || item.length > 500) {
      issues.push(`${path}[${index}] must contain 1-500 characters`);
      continue;
    }
    if (seen.has(item)) {
      issues.push(`${path}[${index}] must be unique`);
      continue;
    }
    seen.add(item);
    values.push(item);
  }
  return values;
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) issues.push(`${path}.${key} is not allowed`);
  }
}

function validCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0);
}

function httpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function invalid(issue: string): LegalCommerceDecodeResult {
  return { kind: 'invalid', issues: [issue] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

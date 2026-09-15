import {
  arrayDecoder,
  literalDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  type DecodeIssue,
  type Decoder,
} from '../codec/core.ts';
import type { LegalCommerceDisclosure } from './legal-commerce.ts';
import { localLegalOperatorFixture } from './legal-operator-fixture.ts';
import { FUKAMU_SERVICE_ELIGIBILITY } from './legal-product.ts';
import type { PrivacyDisclosure } from './privacy-disclosure.ts';

export const LEGAL_TERMS_SCHEMA_VERSION = 1;
export const LEGAL_TERMS_TRIAL_DAYS = 14;
export const LEGAL_TERMS_FIRST_CHARGE_DAY = 15;
export const LEGAL_TERMS_BACKUP_MAXIMUM_DAYS = 30;

export type LegalTermsDisclosure = Readonly<{
  schemaVersion: typeof LEGAL_TERMS_SCHEMA_VERSION;
  termsVersion: string;
  effectiveDate: string;
  serviceName: 'FUKAMU Notes';
  operator: Readonly<{
    legalName: string;
    supportUrl: string;
  }>;
  serviceEligibility: string;
  accountSecurity: string;
  authentication: Readonly<{
    googleLogin: true;
    emailOtp: true;
    password: false;
    sharedVault: false;
  }>;
  prohibitedActivities: readonly string[];
  userContent: Readonly<{
    ownership: 'retained-by-user';
    licenseScope: 'minimum-necessary-for-service';
    licensePurpose: string;
  }>;
  billing: Readonly<{
    paidOnly: true;
    trialDays: typeof LEGAL_TERMS_TRIAL_DAYS;
    firstChargeDay: typeof LEGAL_TERMS_FIRST_CHARGE_DAY;
    automaticRenewal: true;
    cancellationPolicy: string;
    refundPolicy: string;
    paymentFailureLock: 'immediate-online-lock';
    resumePolicy: 'invoice-paid-only';
    cancellationSeparateFromAccountDeletion: true;
  }>;
  dataHandling: Readonly<{
    oneAccountOnePersonalVault: true;
    localContentOnLogout: 'deleted-on-logout';
    liveDataOnAccountDeletion: 'deleted-on-account-deletion';
    backupMaximumDays: typeof LEGAL_TERMS_BACKUP_MAXIMUM_DAYS;
  }>;
  suspensionPolicy: string;
  maintenanceAndChanges: string;
  serviceTermination: string;
  intellectualProperty: string;
  liability: string;
  notices: string;
  governingLawAndVenue: string;
  amendments: Readonly<{
    procedure: string;
    materialChangeHandling: 'legal-review-required-before-enforcement';
  }>;
}>;

export type LegalTermsDecodeResult =
  | { readonly kind: 'decoded'; readonly disclosure: LegalTermsDisclosure }
  | { readonly kind: 'invalid'; readonly issues: readonly string[] };

export type LegalTermsResolution =
  | {
      readonly kind: 'ready';
      readonly source: 'local-fixture' | 'production-configuration';
      readonly disclosure: LegalTermsDisclosure;
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

export type LegalTermsConsistencyResult =
  | { readonly kind: 'consistent' }
  | { readonly kind: 'inconsistent'; readonly issues: readonly string[] };

// Booleans are decoded without coercion; these small decoders preserve their
// literal types so product invariants cannot become configurable strings.
const literalTrueDecoder: Decoder<true> = {
  decode(input, path = []) {
    return input === true
      ? { ok: true, value: true }
      : { ok: false, issues: [{ path, reason: 'expected true' }] };
  },
};
const literalFalseDecoder: Decoder<false> = {
  decode(input, path = []) {
    return input === false
      ? { ok: true, value: false }
      : { ok: false, issues: [{ path, reason: 'expected false' }] };
  },
};
const oneDecoder: Decoder<1> = transformDecoder(
  safeIntegerDecoder({ minimum: 1, maximum: 1 }),
  () => 1,
);
const fourteenDecoder: Decoder<14> = transformDecoder(
  safeIntegerDecoder({ minimum: 14, maximum: 14 }),
  () => 14,
);
const fifteenDecoder: Decoder<15> = transformDecoder(
  safeIntegerDecoder({ minimum: 15, maximum: 15 }),
  () => 15,
);
const thirtyDecoder: Decoder<30> = transformDecoder(
  safeIntegerDecoder({ minimum: 30, maximum: 30 }),
  () => 30,
);
const calendarDateDecoder = refineDecoder(
  stringDecoder({ minLength: 10, maxLength: 10 }),
  validCalendarDate,
  'expected a valid YYYY-MM-DD date',
);
const termsVersionDecoder = refineDecoder(
  stringDecoder({ minLength: 19, maxLength: 19 }),
  (value) => /^terms-v1:\d{4}-\d{2}-\d{2}$/.test(value),
  'expected terms-v1:YYYY-MM-DD',
);
const policyTextDecoder = stringDecoder({ minLength: 1, maxLength: 2_000 });

const legalTermsDecoder: Decoder<LegalTermsDisclosure> = objectDecoder({
  schemaVersion: oneDecoder,
  termsVersion: termsVersionDecoder,
  effectiveDate: calendarDateDecoder,
  serviceName: literalDecoder('FUKAMU Notes'),
  operator: objectDecoder({
    legalName: stringDecoder({ minLength: 1, maxLength: 200 }),
    supportUrl: refineDecoder(
      stringDecoder({ minLength: 1, maxLength: 500 }),
      isHttpUrl,
      'expected an absolute HTTP(S) URL',
    ),
  }),
  serviceEligibility: policyTextDecoder,
  accountSecurity: policyTextDecoder,
  authentication: objectDecoder({
    googleLogin: literalTrueDecoder,
    emailOtp: literalTrueDecoder,
    password: literalFalseDecoder,
    sharedVault: literalFalseDecoder,
  }),
  prohibitedActivities: arrayDecoder(
    stringDecoder({ minLength: 1, maxLength: 500 }),
    { minLength: 1, maxLength: 20, uniqueBy: (value) => value },
  ),
  userContent: objectDecoder({
    ownership: literalDecoder('retained-by-user'),
    licenseScope: literalDecoder('minimum-necessary-for-service'),
    licensePurpose: policyTextDecoder,
  }),
  billing: objectDecoder({
    paidOnly: literalTrueDecoder,
    trialDays: fourteenDecoder,
    firstChargeDay: fifteenDecoder,
    automaticRenewal: literalTrueDecoder,
    cancellationPolicy: stringDecoder({ minLength: 1, maxLength: 1_000 }),
    refundPolicy: stringDecoder({ minLength: 1, maxLength: 1_000 }),
    paymentFailureLock: literalDecoder('immediate-online-lock'),
    resumePolicy: literalDecoder('invoice-paid-only'),
    cancellationSeparateFromAccountDeletion: literalTrueDecoder,
  }),
  dataHandling: objectDecoder({
    oneAccountOnePersonalVault: literalTrueDecoder,
    localContentOnLogout: literalDecoder('deleted-on-logout'),
    liveDataOnAccountDeletion: literalDecoder('deleted-on-account-deletion'),
    backupMaximumDays: thirtyDecoder,
  }),
  suspensionPolicy: policyTextDecoder,
  maintenanceAndChanges: policyTextDecoder,
  serviceTermination: policyTextDecoder,
  intellectualProperty: policyTextDecoder,
  liability: policyTextDecoder,
  notices: policyTextDecoder,
  governingLawAndVenue: policyTextDecoder,
  amendments: objectDecoder({
    procedure: policyTextDecoder,
    materialChangeHandling: literalDecoder(
      'legal-review-required-before-enforcement',
    ),
  }),
});

export const localLegalTermsFixture: LegalTermsDisclosure = {
  schemaVersion: LEGAL_TERMS_SCHEMA_VERSION,
  termsVersion: 'terms-v1:2026-09-15',
  effectiveDate: '2026-09-15',
  serviceName: 'FUKAMU Notes',
  operator: {
    legalName: localLegalOperatorFixture.legalName,
    supportUrl: localLegalOperatorFixture.supportUrl,
  },
  serviceEligibility: FUKAMU_SERVICE_ELIGIBILITY,
  accountSecurity:
    '開発用サンプル：認証情報と利用端末を適切に管理し、不正利用を確認した場合は窓口へ連絡します。',
  authentication: {
    googleLogin: true,
    emailOtp: true,
    password: false,
    sharedVault: false,
  },
  prohibitedActivities: [
    '開発用サンプル：法令または第三者の権利を侵害する行為',
    '開発用サンプル：service、他の利用者またはnetworkの安全を損なう行為',
  ],
  userContent: {
    ownership: 'retained-by-user',
    licenseScope: 'minimum-necessary-for-service',
    licensePurpose:
      '開発用サンプル：利用者contentの権利は利用者に留保され、serviceの保存・同期・表示・保守・security対応に必要な最小範囲だけ取り扱います。',
  },
  billing: {
    paidOnly: true,
    trialDays: LEGAL_TERMS_TRIAL_DAYS,
    firstChargeDay: LEGAL_TERMS_FIRST_CHARGE_DAY,
    automaticRenewal: true,
    cancellationPolicy: '開発用サンプル：アカウント画面から解約',
    refundPolicy: '開発用サンプル：返金条件は未確定',
    paymentFailureLock: 'immediate-online-lock',
    resumePolicy: 'invoice-paid-only',
    cancellationSeparateFromAccountDeletion: true,
  },
  dataHandling: {
    oneAccountOnePersonalVault: true,
    localContentOnLogout: 'deleted-on-logout',
    liveDataOnAccountDeletion: 'deleted-on-account-deletion',
    backupMaximumDays: LEGAL_TERMS_BACKUP_MAXIMUM_DAYS,
  },
  suspensionPolicy:
    '開発用サンプル：支払い停止または重大な違反時の利用制限手順は本番公開前に法務確認します。',
  maintenanceAndChanges:
    '開発用サンプル：保守、機能変更および一時停止の通知条件は本番公開前に確定します。',
  serviceTermination:
    '開発用サンプル：service終了時のnotice期間とdata export手順は本番公開前に確定します。',
  intellectualProperty:
    '開発用サンプル：service自体の知的財産権と利用者contentの権利を区別します。',
  liability:
    '開発用サンプル：責任範囲・上限は消費者契約法を含む適用法令と専門家review後に確定します。',
  notices: '開発用サンプル：重要な通知方法と到達時期は本番公開前に確定します。',
  governingLawAndVenue:
    '開発用サンプル：準拠法と裁判管轄は日本法専門家review後に確定します。',
  amendments: {
    procedure:
      '開発用サンプル：規約versionと施行日を公開し、重要な変更は施行前に通知します。',
    materialChangeHandling: 'legal-review-required-before-enforcement',
  },
};

export function decodeLegalTermsDisclosure(
  input: unknown,
): LegalTermsDecodeResult {
  const decoded = legalTermsDecoder.decode(input);
  if (!decoded.ok) {
    return { kind: 'invalid', issues: decoded.issues.map(formatDecodeIssue) };
  }
  if (
    decoded.value.termsVersion !== `terms-v1:${decoded.value.effectiveDate}`
  ) {
    return {
      kind: 'invalid',
      issues: ['$.termsVersion must match terms-v1:<effectiveDate>'],
    };
  }
  return { kind: 'decoded', disclosure: decoded.value };
}

export function resolveLegalTermsDisclosure(
  environment: unknown,
): LegalTermsResolution {
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
      disclosure: localLegalTermsFixture,
    };
  }
  if (serviceMode !== 'public-paid') {
    return {
      kind: 'blocked',
      reason: 'invalid-service-mode',
      issues: ['FUKAMU_SERVICE_MODE must be legacy-test or public-paid'],
    };
  }
  const source = environment.FUKAMU_LEGAL_TERMS_JSON;
  if (typeof source !== 'string' || source.length === 0) {
    return {
      kind: 'blocked',
      reason: 'missing-production-configuration',
      issues: ['FUKAMU_LEGAL_TERMS_JSON is required in public-paid mode'],
    };
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(source);
  } catch {
    return {
      kind: 'blocked',
      reason: 'invalid-production-configuration',
      issues: ['FUKAMU_LEGAL_TERMS_JSON must be valid JSON'],
    };
  }
  const decoded = decodeLegalTermsDisclosure(candidate);
  if (decoded.kind === 'invalid') {
    return {
      kind: 'blocked',
      reason: 'invalid-production-configuration',
      issues: decoded.issues,
    };
  }
  const productionIssues = validateProductionTerms(decoded.disclosure);
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

export function evaluateLegalTermsConsistency(
  terms: LegalTermsDisclosure,
  commerce: LegalCommerceDisclosure,
  privacy: PrivacyDisclosure,
): LegalTermsConsistencyResult {
  const issues: string[] = [];
  if (terms.serviceName !== privacy.serviceName) {
    issues.push('service name differs from privacy disclosure');
  }
  if (
    terms.operator.legalName !== commerce.seller.legalName ||
    terms.operator.legalName !== privacy.controller.legalName
  ) {
    issues.push('operator legal name differs across legal disclosures');
  }
  if (terms.operator.supportUrl !== commerce.seller.supportUrl) {
    issues.push('support URL differs from commercial disclosure');
  }
  if (terms.billing.trialDays !== commerce.offer.trialDays) {
    issues.push('trial duration differs from commercial disclosure');
  }
  if (
    terms.billing.cancellationPolicy !== commerce.cancellationPolicy ||
    terms.billing.refundPolicy !== commerce.refundPolicy
  ) {
    issues.push(
      'cancellation or refund policy differs from commercial disclosure',
    );
  }
  if (
    terms.dataHandling.localContentOnLogout !==
      privacy.retention.localContentOnLogout ||
    terms.dataHandling.liveDataOnAccountDeletion !==
      privacy.retention.liveDataOnAccountDeletion ||
    terms.dataHandling.backupMaximumDays !== privacy.retention.backupMaximumDays
  ) {
    issues.push('retention policy differs from privacy disclosure');
  }
  return issues.length === 0
    ? { kind: 'consistent' }
    : { kind: 'inconsistent', issues };
}

function validateProductionTerms(
  disclosure: LegalTermsDisclosure,
): readonly string[] {
  const issues: string[] = [];
  if (disclosure.serviceEligibility !== FUKAMU_SERVICE_ELIGIBILITY) {
    issues.push(
      '$.serviceEligibility must match the approved contract-capacity policy',
    );
  }
  const values = [
    disclosure.operator.legalName,
    disclosure.operator.supportUrl,
    disclosure.serviceEligibility,
    disclosure.accountSecurity,
    ...disclosure.prohibitedActivities,
    disclosure.userContent.licensePurpose,
    disclosure.billing.cancellationPolicy,
    disclosure.billing.refundPolicy,
    disclosure.suspensionPolicy,
    disclosure.maintenanceAndChanges,
    disclosure.serviceTermination,
    disclosure.intellectualProperty,
    disclosure.liability,
    disclosure.notices,
    disclosure.governingLawAndVenue,
    disclosure.amendments.procedure,
  ];
  const placeholder =
    /(?:placeholder|example|sample|todo|tbd|未設定|未確定|開発用|サンプル)/i;
  if (values.some((value) => placeholder.test(value))) {
    issues.push('production terms contain a placeholder');
  }
  if (!disclosure.operator.legalName.includes('株式会社')) {
    issues.push('operator legal name must contain the verified corporate name');
  }
  try {
    const support = new URL(disclosure.operator.supportUrl);
    if (
      support.protocol !== 'https:' ||
      support.hostname === 'localhost' ||
      support.hostname.endsWith('.example') ||
      support.hostname.endsWith('.test')
    ) {
      issues.push('support URL must be a production HTTPS URL');
    }
  } catch {
    issues.push('support URL must be a production HTTPS URL');
  }
  return issues;
}

function formatDecodeIssue(issue: DecodeIssue): string {
  const path = issue.path.reduce(
    (value, segment) =>
      typeof segment === 'number'
        ? `${value}[${segment}]`
        : `${value}.${segment}`,
    '$',
  );
  return `${path}: ${issue.reason}`;
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

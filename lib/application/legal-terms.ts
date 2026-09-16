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
import {
  FUKAMU_AMENDMENTS_POLICY,
  FUKAMU_CANCELLATION_POLICY,
  FUKAMU_GOVERNING_LAW_AND_VENUE_POLICY,
  FUKAMU_LIABILITY_POLICY,
  FUKAMU_MAINTENANCE_AND_CHANGES_POLICY,
  FUKAMU_NOTICES_POLICY,
  FUKAMU_REFUND_POLICY,
  FUKAMU_SERVICE_ELIGIBILITY,
  FUKAMU_SERVICE_TERMINATION_POLICY,
} from './legal-product.ts';
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
    '利用者は、Google LoginまたはEmail OTPに使用するアカウント、登録連絡先および利用端末を適切に管理し、第三者による不正利用を確認した場合は速やかに問い合わせ窓口へ連絡するものとします。',
  authentication: {
    googleLogin: true,
    emailOtp: true,
    password: false,
    sharedVault: false,
  },
  prohibitedActivities: [
    '法令、公序良俗または本規約に違反する行為',
    '第三者の知的財産権、プライバシーその他の権利を侵害する行為',
    '不正アクセス、認証情報の不正取得その他本サービスの安全性を損なう行為',
    '本サービスまたはその基盤へ過度な負荷を与え、運営を妨害する行為',
    'アカウントを第三者へ譲渡もしくは貸与し、または本サービスを無断で再販売する行為',
  ],
  userContent: {
    ownership: 'retained-by-user',
    licenseScope: 'minimum-necessary-for-service',
    licensePurpose:
      '利用者contentの権利は利用者に留保されます。利用者は当社に対し、本サービスにおける保存、暗号化、同期、表示、バックアップ、保守およびセキュリティ対応に必要な最小範囲で、利用者contentを複製その他取り扱う権限を付与します。この権限は本サービスの提供以外の目的には使用しません。',
  },
  billing: {
    paidOnly: true,
    trialDays: LEGAL_TERMS_TRIAL_DAYS,
    firstChargeDay: LEGAL_TERMS_FIRST_CHARGE_DAY,
    automaticRenewal: true,
    cancellationPolicy: FUKAMU_CANCELLATION_POLICY,
    refundPolicy: FUKAMU_REFUND_POLICY,
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
    '支払い失敗、追加認証要求、本規約への重大な違反、不正利用またはサービスの安全を守るために必要な場合、当社は必要な範囲で本サービスの利用を停止できます。合理的に可能な場合は理由と解除方法を通知します。停止中も支払い、解約、退会および問い合わせに必要な経路は利用できます。支払いに基づく停止は、未払いinvoiceの支払いを確認した場合に限り解除します。',
  maintenanceAndChanges: FUKAMU_MAINTENANCE_AND_CHANGES_POLICY,
  serviceTermination: FUKAMU_SERVICE_TERMINATION_POLICY,
  intellectualProperty:
    '本サービス、ソフトウェア、画面、文書その他当社が提供するものに関する知的財産権は、当社または正当な権利者に帰属します。利用者contentの権利は利用者に留保されます。',
  liability: FUKAMU_LIABILITY_POLICY,
  notices: FUKAMU_NOTICES_POLICY,
  governingLawAndVenue: FUKAMU_GOVERNING_LAW_AND_VENUE_POLICY,
  amendments: {
    procedure: FUKAMU_AMENDMENTS_POLICY,
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
  const approvedPolicies = [
    [
      '$.billing.cancellationPolicy',
      disclosure.billing.cancellationPolicy,
      FUKAMU_CANCELLATION_POLICY,
    ],
    [
      '$.billing.refundPolicy',
      disclosure.billing.refundPolicy,
      FUKAMU_REFUND_POLICY,
    ],
    [
      '$.maintenanceAndChanges',
      disclosure.maintenanceAndChanges,
      FUKAMU_MAINTENANCE_AND_CHANGES_POLICY,
    ],
    [
      '$.serviceTermination',
      disclosure.serviceTermination,
      FUKAMU_SERVICE_TERMINATION_POLICY,
    ],
    ['$.liability', disclosure.liability, FUKAMU_LIABILITY_POLICY],
    ['$.notices', disclosure.notices, FUKAMU_NOTICES_POLICY],
    [
      '$.governingLawAndVenue',
      disclosure.governingLawAndVenue,
      FUKAMU_GOVERNING_LAW_AND_VENUE_POLICY,
    ],
    [
      '$.amendments.procedure',
      disclosure.amendments.procedure,
      FUKAMU_AMENDMENTS_POLICY,
    ],
  ] as const;
  for (const [path, actual, approved] of approvedPolicies) {
    if (actual !== approved) {
      issues.push(`${path} must match the approved policy`);
    }
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

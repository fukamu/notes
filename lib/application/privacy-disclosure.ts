import {
  isPrivacyDataCategoryId,
  privacyDataCategoryIds,
  type PrivacyDataCategoryId,
} from '../domain/privacy-processing.ts';
import {
  isPrivacyRequestKind,
  privacyRequestKinds,
  type PrivacyRequestKind,
} from '../domain/privacy-request.ts';
import { localLegalOperatorFixture } from './legal-operator-fixture.ts';

export type { PrivacyRequestKind } from '../domain/privacy-request.ts';

export const PRIVACY_DISCLOSURE_SCHEMA_VERSION = 1;
export const PRIVACY_BACKUP_RETENTION_MAXIMUM_DAYS = 30;

export type PrivacyCollectionItem = Readonly<{
  categoryId: PrivacyDataCategoryId;
  category: string;
  source: string;
  purposes: readonly string[];
}>;

export type PrivacyDisclosure = Readonly<{
  schemaVersion: typeof PRIVACY_DISCLOSURE_SCHEMA_VERSION;
  policyVersion: string;
  effectiveDate: string;
  serviceName: 'FUKAMU Notes';
  controller: Readonly<{
    legalName: string;
    representative: string;
    postalAddress: string;
    contactUrl: string;
  }>;
  collection: readonly PrivacyCollectionItem[];
  personalVaultModel: 'one-account-one-personal-vault';
  userContentNotice: string;
  localDeviceHandling: string;
  retention: Readonly<{
    accountAndBilling: string;
    vaultContent: string;
    localContentOnLogout: 'deleted-on-logout';
    liveDataOnAccountDeletion: 'deleted-on-account-deletion';
    backupMaximumDays: typeof PRIVACY_BACKUP_RETENTION_MAXIMUM_DAYS;
  }>;
  securityMeasures: readonly string[];
  processorsAndThirdParties: string;
  foreignTransfers: string;
  dataSubjectRequests: Readonly<{
    availableActions: readonly PrivacyRequestKind[];
    procedure: string;
    identityVerification: string;
    fee: string;
    contactUrl: string;
  }>;
  policyChanges: string;
}>;

export type PrivacyDisclosureDecodeResult =
  | { readonly kind: 'decoded'; readonly disclosure: PrivacyDisclosure }
  | { readonly kind: 'invalid'; readonly issues: readonly string[] };

export type PrivacyDisclosureResolution =
  | {
      readonly kind: 'ready';
      readonly source: 'local-fixture' | 'production-configuration';
      readonly disclosure: PrivacyDisclosure;
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

const requiredRequestKinds: readonly PrivacyRequestKind[] = privacyRequestKinds;

export const localPrivacyDisclosureFixture: PrivacyDisclosure = {
  schemaVersion: PRIVACY_DISCLOSURE_SCHEMA_VERSION,
  policyVersion: 'privacy-v1:2026-09-15',
  effectiveDate: '2026-09-15',
  serviceName: 'FUKAMU Notes',
  controller: {
    legalName: localLegalOperatorFixture.legalName,
    representative: localLegalOperatorFixture.representative,
    postalAddress: localLegalOperatorFixture.postalAddress,
    contactUrl: localLegalOperatorFixture.privacyContactUrl,
  },
  collection: [
    {
      categoryId: 'account-identity',
      category: '開発用サンプル：account・identity情報',
      source: '開発用サンプル：利用者による登録と認証provider',
      purposes: ['開発用サンプル：本人認証、account管理、不正利用防止'],
    },
    {
      categoryId: 'authentication-security',
      category: '開発用サンプル：認証・security情報',
      source: '開発用サンプル：認証操作とserviceによる生成',
      purposes: ['開発用サンプル：session管理、OTP検証、不正利用防止'],
    },
    {
      categoryId: 'billing-contract',
      category: '開発用サンプル：契約・請求状態',
      source: '開発用サンプル：利用者の申込みと決済provider',
      purposes: [
        '開発用サンプル：subscription管理、利用権判定、問い合わせ対応',
      ],
    },
    {
      categoryId: 'vault-content',
      category: '開発用サンプル：Personal Vaultの利用者content',
      source: '開発用サンプル：利用者による入力と同期',
      purposes: ['開発用サンプル：notes保存、同期、競合解決、関連表示の提供'],
    },
    {
      categoryId: 'device-offline-replica',
      category: '開発用サンプル：端末内offline replica',
      source: '開発用サンプル：利用者の入力と端末内の編集状態',
      purposes: ['開発用サンプル：offline編集と再接続後の同期'],
    },
    {
      categoryId: 'operational-audit',
      category: '開発用サンプル：運用・監査metadata',
      source: '開発用サンプル：service利用とsecurity event',
      purposes: ['開発用サンプル：不正利用防止、障害対応、service品質維持'],
    },
  ],
  personalVaultModel: 'one-account-one-personal-vault',
  userContentNotice:
    '開発用サンプル：利用者contentには第三者の個人情報が含まれる場合があるため、適法な範囲で入力してください。',
  localDeviceHandling:
    '開発用サンプル：offline利用のため端末へ保存し、logout時は当該利用者のlocal contentを削除します。',
  retention: {
    accountAndBilling:
      '開発用サンプル：契約・法令・問い合わせ対応に必要な期間のみ保持します。',
    vaultContent:
      '開発用サンプル：退会処理でlive dataを削除し、backup等の残存は最大30日です。',
    localContentOnLogout: 'deleted-on-logout',
    liveDataOnAccountDeletion: 'deleted-on-account-deletion',
    backupMaximumDays: PRIVACY_BACKUP_RETENTION_MAXIMUM_DAYS,
  },
  securityMeasures: [
    '開発用サンプル：認証済みsessionからPersonal Vaultのscopeを決定し、tenant間のaccessを分離します。',
    '開発用サンプル：利用者contentをserver-side envelope encryptionで保護します。',
    '開発用サンプル：権限管理、監査、障害対応と復旧手順を運用します。',
  ],
  processorsAndThirdParties:
    '開発用サンプル：service提供に必要な委託先は本番provider決定後に公開し、必要な監督を行います。法令上認められる場合を除き、本人の同意なく第三者提供しません。',
  foreignTransfers:
    '開発用サンプル：外国での取扱いはprovider・region・法的構成の決定後に必要な情報を公開します。',
  dataSubjectRequests: {
    availableActions: requiredRequestKinds,
    procedure:
      '開発用サンプル：専用account画面または問い合わせ窓口から請求を受け付けます。',
    identityVerification:
      '開発用サンプル：不正な開示や変更を防ぐため、請求内容に応じて本人確認を行います。',
    fee: '開発用サンプル：手数料と回答方法は本番運用前に確定します。',
    contactUrl: localLegalOperatorFixture.privacyContactUrl,
  },
  policyChanges:
    '開発用サンプル：重要な変更は適用前にservice内または登録連絡先へ通知します。',
};

export function decodePrivacyDisclosure(
  input: unknown,
): PrivacyDisclosureDecodeResult {
  const issues: string[] = [];
  if (!isRecord(input)) return invalid('disclosure must be an object');

  rejectUnknownFields(
    input,
    [
      'schemaVersion',
      'policyVersion',
      'effectiveDate',
      'serviceName',
      'controller',
      'collection',
      'personalVaultModel',
      'userContentNotice',
      'localDeviceHandling',
      'retention',
      'securityMeasures',
      'processorsAndThirdParties',
      'foreignTransfers',
      'dataSubjectRequests',
      'policyChanges',
    ],
    '$',
    issues,
  );
  if (input.schemaVersion !== PRIVACY_DISCLOSURE_SCHEMA_VERSION) {
    issues.push('schemaVersion must be 1');
  }
  const policyVersion = requiredString(
    input,
    'policyVersion',
    '$.policyVersion',
    1,
    128,
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
  if (policyVersion !== `privacy-v1:${effectiveDate}`) {
    issues.push('$.policyVersion must match privacy-v1:<effectiveDate>');
  }
  if (input.serviceName !== 'FUKAMU Notes') {
    issues.push('$.serviceName must be FUKAMU Notes');
  }
  if (input.personalVaultModel !== 'one-account-one-personal-vault') {
    issues.push('$.personalVaultModel must be one-account-one-personal-vault');
  }

  const controller = decodeController(input.controller, issues);
  const collection = decodeCollection(input.collection, issues);
  const retention = decodeRetention(input.retention, issues);
  const securityMeasures = stringArray(
    input.securityMeasures,
    '$.securityMeasures',
    1,
    10,
    issues,
  );
  const dataSubjectRequests = decodeDataSubjectRequests(
    input.dataSubjectRequests,
    issues,
  );
  const userContentNotice = requiredString(
    input,
    'userContentNotice',
    '$.userContentNotice',
    1,
    1_000,
    issues,
  );
  const localDeviceHandling = requiredString(
    input,
    'localDeviceHandling',
    '$.localDeviceHandling',
    1,
    1_000,
    issues,
  );
  const processorsAndThirdParties = requiredString(
    input,
    'processorsAndThirdParties',
    '$.processorsAndThirdParties',
    1,
    2_000,
    issues,
  );
  const foreignTransfers = requiredString(
    input,
    'foreignTransfers',
    '$.foreignTransfers',
    1,
    2_000,
    issues,
  );
  const policyChanges = requiredString(
    input,
    'policyChanges',
    '$.policyChanges',
    1,
    1_000,
    issues,
  );

  if (
    issues.length > 0 ||
    controller === undefined ||
    retention === undefined ||
    dataSubjectRequests === undefined
  ) {
    return { kind: 'invalid', issues };
  }
  return {
    kind: 'decoded',
    disclosure: {
      schemaVersion: PRIVACY_DISCLOSURE_SCHEMA_VERSION,
      policyVersion,
      effectiveDate,
      serviceName: 'FUKAMU Notes',
      controller,
      collection,
      personalVaultModel: 'one-account-one-personal-vault',
      userContentNotice,
      localDeviceHandling,
      retention,
      securityMeasures,
      processorsAndThirdParties,
      foreignTransfers,
      dataSubjectRequests,
      policyChanges,
    },
  };
}

export function resolvePrivacyDisclosure(
  environment: unknown,
): PrivacyDisclosureResolution {
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
      disclosure: localPrivacyDisclosureFixture,
    };
  }
  if (serviceMode !== 'public-paid') {
    return {
      kind: 'blocked',
      reason: 'invalid-service-mode',
      issues: ['FUKAMU_SERVICE_MODE must be legacy-test or public-paid'],
    };
  }
  const source = environment.FUKAMU_PRIVACY_DISCLOSURE_JSON;
  if (typeof source !== 'string' || source.length === 0) {
    return {
      kind: 'blocked',
      reason: 'missing-production-configuration',
      issues: [
        'FUKAMU_PRIVACY_DISCLOSURE_JSON is required in public-paid mode',
      ],
    };
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(source);
  } catch {
    return {
      kind: 'blocked',
      reason: 'invalid-production-configuration',
      issues: ['FUKAMU_PRIVACY_DISCLOSURE_JSON must be valid JSON'],
    };
  }
  const decoded = decodePrivacyDisclosure(candidate);
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

export function privacyRequestKindLabel(kind: PrivacyRequestKind): string {
  switch (kind) {
    case 'purpose-notification':
      return '利用目的の通知';
    case 'disclosure':
      return '保有個人データ・第三者提供記録の開示';
    case 'correction':
      return '内容の訂正・追加・削除';
    case 'usage-suspension':
      return '利用停止・消去';
    case 'deletion':
      return '退会に伴うlive dataの削除';
    case 'third-party-provision-suspension':
      return '第三者提供の停止';
  }
}

function decodeController(
  input: unknown,
  issues: string[],
): PrivacyDisclosure['controller'] | undefined {
  if (!isRecord(input)) {
    issues.push('$.controller must be an object');
    return undefined;
  }
  rejectUnknownFields(
    input,
    ['legalName', 'representative', 'postalAddress', 'contactUrl'],
    '$.controller',
    issues,
  );
  const legalName = requiredString(
    input,
    'legalName',
    '$.controller.legalName',
    1,
    200,
    issues,
  );
  const representative = requiredString(
    input,
    'representative',
    '$.controller.representative',
    1,
    200,
    issues,
  );
  const postalAddress = requiredString(
    input,
    'postalAddress',
    '$.controller.postalAddress',
    5,
    500,
    issues,
  );
  const contactUrl = requiredString(
    input,
    'contactUrl',
    '$.controller.contactUrl',
    1,
    500,
    issues,
  );
  if (!httpUrl(contactUrl)) {
    issues.push('$.controller.contactUrl must be an absolute HTTP(S) URL');
  }
  return { legalName, representative, postalAddress, contactUrl };
}

function decodeCollection(
  input: unknown,
  issues: string[],
): readonly PrivacyCollectionItem[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) {
    issues.push('$.collection must contain 1-20 items');
    return [];
  }
  const items: PrivacyCollectionItem[] = [];
  const categories = new Set<string>();
  for (const [index, item] of input.entries()) {
    const path = `$.collection[${index}]`;
    if (!isRecord(item)) {
      issues.push(`${path} must be an object`);
      continue;
    }
    rejectUnknownFields(
      item,
      ['categoryId', 'category', 'source', 'purposes'],
      path,
      issues,
    );
    const categoryId = item.categoryId;
    if (!isPrivacyDataCategoryId(categoryId)) {
      issues.push(`${path}.categoryId is unsupported`);
    }
    const category = requiredString(
      item,
      'category',
      `${path}.category`,
      1,
      300,
      issues,
    );
    const source = requiredString(
      item,
      'source',
      `${path}.source`,
      1,
      500,
      issues,
    );
    const purposes = stringArray(
      item.purposes,
      `${path}.purposes`,
      1,
      10,
      issues,
    );
    if (categories.has(category)) {
      issues.push(`${path}.category must be unique`);
    }
    categories.add(category);
    if (isPrivacyDataCategoryId(categoryId)) {
      items.push({ categoryId, category, source, purposes });
    }
  }
  const categoryIds = new Set(items.map((item) => item.categoryId));
  for (const required of privacyDataCategoryIds) {
    if (!categoryIds.has(required)) {
      issues.push(`$.collection must include ${required}`);
    }
  }
  return items;
}

function decodeRetention(
  input: unknown,
  issues: string[],
): PrivacyDisclosure['retention'] | undefined {
  if (!isRecord(input)) {
    issues.push('$.retention must be an object');
    return undefined;
  }
  rejectUnknownFields(
    input,
    [
      'accountAndBilling',
      'vaultContent',
      'localContentOnLogout',
      'liveDataOnAccountDeletion',
      'backupMaximumDays',
    ],
    '$.retention',
    issues,
  );
  const accountAndBilling = requiredString(
    input,
    'accountAndBilling',
    '$.retention.accountAndBilling',
    1,
    1_000,
    issues,
  );
  const vaultContent = requiredString(
    input,
    'vaultContent',
    '$.retention.vaultContent',
    1,
    1_000,
    issues,
  );
  if (input.localContentOnLogout !== 'deleted-on-logout') {
    issues.push('$.retention.localContentOnLogout must be deleted-on-logout');
  }
  if (input.liveDataOnAccountDeletion !== 'deleted-on-account-deletion') {
    issues.push(
      '$.retention.liveDataOnAccountDeletion must be deleted-on-account-deletion',
    );
  }
  if (input.backupMaximumDays !== PRIVACY_BACKUP_RETENTION_MAXIMUM_DAYS) {
    issues.push('$.retention.backupMaximumDays must be 30');
  }
  return {
    accountAndBilling,
    vaultContent,
    localContentOnLogout: 'deleted-on-logout',
    liveDataOnAccountDeletion: 'deleted-on-account-deletion',
    backupMaximumDays: PRIVACY_BACKUP_RETENTION_MAXIMUM_DAYS,
  };
}

function decodeDataSubjectRequests(
  input: unknown,
  issues: string[],
): PrivacyDisclosure['dataSubjectRequests'] | undefined {
  if (!isRecord(input)) {
    issues.push('$.dataSubjectRequests must be an object');
    return undefined;
  }
  rejectUnknownFields(
    input,
    [
      'availableActions',
      'procedure',
      'identityVerification',
      'fee',
      'contactUrl',
    ],
    '$.dataSubjectRequests',
    issues,
  );
  const availableActions = decodeRequestKinds(input.availableActions, issues);
  const procedure = requiredString(
    input,
    'procedure',
    '$.dataSubjectRequests.procedure',
    1,
    1_000,
    issues,
  );
  const identityVerification = requiredString(
    input,
    'identityVerification',
    '$.dataSubjectRequests.identityVerification',
    1,
    1_000,
    issues,
  );
  const fee = requiredString(
    input,
    'fee',
    '$.dataSubjectRequests.fee',
    1,
    500,
    issues,
  );
  const contactUrl = requiredString(
    input,
    'contactUrl',
    '$.dataSubjectRequests.contactUrl',
    1,
    500,
    issues,
  );
  if (!httpUrl(contactUrl)) {
    issues.push(
      '$.dataSubjectRequests.contactUrl must be an absolute HTTP(S) URL',
    );
  }
  return {
    availableActions,
    procedure,
    identityVerification,
    fee,
    contactUrl,
  };
}

function decodeRequestKinds(
  input: unknown,
  issues: string[],
): readonly PrivacyRequestKind[] {
  if (!Array.isArray(input)) {
    issues.push('$.dataSubjectRequests.availableActions must be an array');
    return [];
  }
  const available: PrivacyRequestKind[] = [];
  for (const [index, value] of input.entries()) {
    if (!isPrivacyRequestKind(value)) {
      issues.push(
        `$.dataSubjectRequests.availableActions[${index}] is unsupported`,
      );
      continue;
    }
    if (available.includes(value)) {
      issues.push(
        `$.dataSubjectRequests.availableActions[${index}] must be unique`,
      );
      continue;
    }
    available.push(value);
  }
  for (const required of requiredRequestKinds) {
    if (!available.includes(required)) {
      issues.push(
        `$.dataSubjectRequests.availableActions must include ${required}`,
      );
    }
  }
  return available;
}

function validateProductionDisclosure(
  disclosure: PrivacyDisclosure,
): readonly string[] {
  const issues: string[] = [];
  const strings: readonly (readonly [string, string])[] = [
    ['$.controller.legalName', disclosure.controller.legalName],
    ['$.controller.representative', disclosure.controller.representative],
    ['$.controller.postalAddress', disclosure.controller.postalAddress],
    ['$.controller.contactUrl', disclosure.controller.contactUrl],
    ['$.userContentNotice', disclosure.userContentNotice],
    ['$.localDeviceHandling', disclosure.localDeviceHandling],
    ['$.retention.accountAndBilling', disclosure.retention.accountAndBilling],
    ['$.retention.vaultContent', disclosure.retention.vaultContent],
    ['$.processorsAndThirdParties', disclosure.processorsAndThirdParties],
    ['$.foreignTransfers', disclosure.foreignTransfers],
    [
      '$.dataSubjectRequests.procedure',
      disclosure.dataSubjectRequests.procedure,
    ],
    [
      '$.dataSubjectRequests.identityVerification',
      disclosure.dataSubjectRequests.identityVerification,
    ],
    ['$.dataSubjectRequests.fee', disclosure.dataSubjectRequests.fee],
    [
      '$.dataSubjectRequests.contactUrl',
      disclosure.dataSubjectRequests.contactUrl,
    ],
    ['$.policyChanges', disclosure.policyChanges],
    ...disclosure.collection.flatMap((item, index) => [
      [`$.collection[${index}].category`, item.category] as const,
      [`$.collection[${index}].source`, item.source] as const,
      ...item.purposes.map(
        (purpose, purposeIndex) =>
          [
            `$.collection[${index}].purposes[${purposeIndex}]`,
            purpose,
          ] as const,
      ),
    ]),
    ...disclosure.securityMeasures.map(
      (measure, index) => [`$.securityMeasures[${index}]`, measure] as const,
    ),
  ];
  const placeholder =
    /(?:placeholder|example|sample|todo|tbd|未設定|未確定|開発用|サンプル)/i;
  for (const [path, value] of strings) {
    if (placeholder.test(value)) issues.push(`${path} contains a placeholder`);
  }
  if (!disclosure.controller.legalName.includes('株式会社')) {
    issues.push(
      '$.controller.legalName must contain the verified corporate name',
    );
  }
  for (const [path, value] of [
    ['$.controller.contactUrl', disclosure.controller.contactUrl],
    [
      '$.dataSubjectRequests.contactUrl',
      disclosure.dataSubjectRequests.contactUrl,
    ],
  ] as const) {
    if (!productionHttpsUrl(value)) {
      issues.push(`${path} must be a production HTTPS URL`);
    }
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
  minimum: number,
  maximum: number,
  issues: string[],
): readonly string[] {
  if (
    !Array.isArray(input) ||
    input.length < minimum ||
    input.length > maximum
  ) {
    issues.push(`${path} must contain ${minimum}-${maximum} items`);
    return [];
  }
  const values: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of input.entries()) {
    if (typeof item !== 'string' || item.length < 1 || item.length > 1_000) {
      issues.push(`${path}[${index}] must contain 1-1000 characters`);
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

function productionHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.hostname !== 'localhost' &&
      !url.hostname.endsWith('.example') &&
      !url.hostname.endsWith('.test')
    );
  } catch {
    return false;
  }
}

function invalid(issue: string): PrivacyDisclosureDecodeResult {
  return { kind: 'invalid', issues: [issue] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

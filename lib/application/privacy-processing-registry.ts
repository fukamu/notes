import {
  arrayDecoder,
  literalDecoder,
  objectDecoder,
  optionalDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
} from '../codec/core.ts';
import type { PrivacyDisclosure } from './privacy-disclosure.ts';
import {
  privacyDataCategoryIds,
  privacyProcessingPurposeIds,
  type PrivacyDataCategoryId,
  type PrivacyProcessingPurposeId,
} from '../domain/privacy-processing.ts';

export const PRIVACY_PROCESSING_REGISTRY_SCHEMA_VERSION = 1;

export const privacyProcessorRoles = [
  'hosting-database-object-storage',
  'google-identity',
  'email-delivery',
  'subscription-billing',
  'key-management',
] as const;

export type PrivacyProcessorRole = (typeof privacyProcessorRoles)[number];

export type PrivacyDataSource =
  | 'direct-from-user'
  | 'identity-provider'
  | 'billing-provider'
  | 'service-generated'
  | 'device-generated';

export type PrivacyProcessingSystem =
  | 'd1-control-plane'
  | 'private-encrypted-object-storage'
  | 'browser-indexeddb'
  | 'provider-system';

export type PrivacyRetentionPolicy =
  | { readonly kind: 'session-expiry-or-revocation' }
  | { readonly kind: 'otp-challenge-expiry' }
  | { readonly kind: 'account-deletion-live-purge' }
  | { readonly kind: 'logout-local-purge' }
  | { readonly kind: 'backup-expiry'; readonly maximumDays: 30 }
  | { readonly kind: 'documented-period'; readonly summary: string }
  | { readonly kind: 'decision-required'; readonly topic: string };

export type PrivacyProcessingEntry = Readonly<{
  categoryId: PrivacyDataCategoryId;
  sources: readonly PrivacyDataSource[];
  purposes: readonly PrivacyProcessingPurposeId[];
  systems: readonly PrivacyProcessingSystem[];
  retention: readonly PrivacyRetentionPolicy[];
}>;

export type PrivacyProcessorStatus =
  | {
      readonly kind: 'decision-required';
      readonly decisions: readonly string[];
    }
  | {
      readonly kind: 'verified';
      readonly legalName: string;
      readonly legalRole: 'processor' | 'independent-controller';
      readonly countries: readonly string[];
      readonly privacyUrl: string;
      readonly subprocessorsUrl: string | undefined;
      readonly transfer:
        | { readonly kind: 'domestic-only' }
        | {
            readonly kind: 'cross-border-reviewed';
            readonly summary: string;
            readonly safeguards: string;
            readonly reviewedOn: string;
          };
    };

export type PrivacyProcessorEntry = Readonly<{
  role: PrivacyProcessorRole;
  dataCategories: readonly PrivacyDataCategoryId[];
  purposes: readonly PrivacyProcessingPurposeId[];
  status: PrivacyProcessorStatus;
}>;

export type PrivacyProcessingRegistry = Readonly<{
  schemaVersion: typeof PRIVACY_PROCESSING_REGISTRY_SCHEMA_VERSION;
  registryVersion: string;
  reviewedOn: string;
  data: readonly PrivacyProcessingEntry[];
  processors: readonly PrivacyProcessorEntry[];
}>;

export type PrivacyProcessingRegistryDecodeResult =
  | { readonly kind: 'decoded'; readonly registry: PrivacyProcessingRegistry }
  | { readonly kind: 'invalid'; readonly issues: readonly string[] };

export type PrivacyProcessingRegistryResolution =
  | {
      readonly kind: 'ready';
      readonly source: 'local-fixture' | 'production-configuration';
      readonly registry: PrivacyProcessingRegistry;
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

export type PrivacyProcessingConsistencyResult =
  | { readonly kind: 'consistent' }
  | { readonly kind: 'inconsistent'; readonly issues: readonly string[] };

const shortTextDecoder = refineDecoder(
  stringDecoder({ minLength: 1, maxLength: 1_000 }),
  (value) => value.trim().length > 0,
  'expected non-blank text',
);
const dateDecoder = refineDecoder(
  stringDecoder({ minLength: 10, maxLength: 10 }),
  validCalendarDate,
  'expected valid YYYY-MM-DD date',
);
const productionHttpsUrlDecoder = refineDecoder(
  stringDecoder({ minLength: 1, maxLength: 500 }),
  productionHttpsUrl,
  'expected production HTTPS URL',
);

const dataCategoryIdDecoder = unionDecoder(
  ...privacyDataCategoryIds.map(literalDecoder),
);
const purposeIdDecoder = unionDecoder(
  ...privacyProcessingPurposeIds.map(literalDecoder),
);
const dataSourceDecoder: Decoder<PrivacyDataSource> = unionDecoder(
  literalDecoder('direct-from-user'),
  literalDecoder('identity-provider'),
  literalDecoder('billing-provider'),
  literalDecoder('service-generated'),
  literalDecoder('device-generated'),
);
const processingSystemDecoder: Decoder<PrivacyProcessingSystem> = unionDecoder(
  literalDecoder('d1-control-plane'),
  literalDecoder('private-encrypted-object-storage'),
  literalDecoder('browser-indexeddb'),
  literalDecoder('provider-system'),
);
const processorRoleDecoder = unionDecoder(
  ...privacyProcessorRoles.map(literalDecoder),
);

const retentionPolicyDecoder: Decoder<PrivacyRetentionPolicy> = unionDecoder(
  objectDecoder({ kind: literalDecoder('session-expiry-or-revocation') }),
  objectDecoder({ kind: literalDecoder('otp-challenge-expiry') }),
  objectDecoder({ kind: literalDecoder('account-deletion-live-purge') }),
  objectDecoder({ kind: literalDecoder('logout-local-purge') }),
  transformDecoder(
    objectDecoder({
      kind: literalDecoder('backup-expiry'),
      maximumDays: safeIntegerDecoder({ minimum: 30, maximum: 30 }),
    }),
    (value) => ({ ...value, maximumDays: 30 as const }),
  ),
  objectDecoder({
    kind: literalDecoder('documented-period'),
    summary: shortTextDecoder,
  }),
  objectDecoder({
    kind: literalDecoder('decision-required'),
    topic: shortTextDecoder,
  }),
);

const processingEntryDecoder = objectDecoder({
  categoryId: dataCategoryIdDecoder,
  sources: arrayDecoder(dataSourceDecoder, {
    minLength: 1,
    maxLength: 5,
    uniqueBy: (value) => value,
  }),
  purposes: arrayDecoder(purposeIdDecoder, {
    minLength: 1,
    maxLength: 7,
    uniqueBy: (value) => value,
  }),
  systems: arrayDecoder(processingSystemDecoder, {
    minLength: 1,
    maxLength: 4,
    uniqueBy: (value) => value,
  }),
  retention: arrayDecoder(retentionPolicyDecoder, {
    minLength: 1,
    maxLength: 8,
    uniqueBy: retentionKey,
  }),
});

const processorStatusDecoder: Decoder<PrivacyProcessorStatus> = unionDecoder(
  objectDecoder({
    kind: literalDecoder('decision-required'),
    decisions: arrayDecoder(shortTextDecoder, {
      minLength: 1,
      maxLength: 10,
      uniqueBy: (value) => value,
    }),
  }),
  objectDecoder({
    kind: literalDecoder('verified'),
    legalName: shortTextDecoder,
    legalRole: unionDecoder(
      literalDecoder('processor'),
      literalDecoder('independent-controller'),
    ),
    countries: arrayDecoder(shortTextDecoder, {
      minLength: 1,
      maxLength: 30,
      uniqueBy: (value) => value,
    }),
    privacyUrl: productionHttpsUrlDecoder,
    subprocessorsUrl: optionalDecoder(productionHttpsUrlDecoder),
    transfer: unionDecoder(
      objectDecoder({ kind: literalDecoder('domestic-only') }),
      objectDecoder({
        kind: literalDecoder('cross-border-reviewed'),
        summary: shortTextDecoder,
        safeguards: shortTextDecoder,
        reviewedOn: dateDecoder,
      }),
    ),
  }),
);

const processorEntryDecoder = objectDecoder({
  role: processorRoleDecoder,
  dataCategories: arrayDecoder(dataCategoryIdDecoder, {
    minLength: 1,
    maxLength: privacyDataCategoryIds.length,
    uniqueBy: (value) => value,
  }),
  purposes: arrayDecoder(purposeIdDecoder, {
    minLength: 1,
    maxLength: privacyProcessingPurposeIds.length,
    uniqueBy: (value) => value,
  }),
  status: processorStatusDecoder,
});

const registryShapeDecoder = objectDecoder({
  schemaVersion: transformDecoder(
    safeIntegerDecoder({ minimum: 1, maximum: 1 }),
    (): typeof PRIVACY_PROCESSING_REGISTRY_SCHEMA_VERSION =>
      PRIVACY_PROCESSING_REGISTRY_SCHEMA_VERSION,
  ),
  registryVersion: shortTextDecoder,
  reviewedOn: dateDecoder,
  data: arrayDecoder(processingEntryDecoder, {
    minLength: privacyDataCategoryIds.length,
    maxLength: privacyDataCategoryIds.length,
    uniqueBy: (value) => value.categoryId,
  }),
  processors: arrayDecoder(processorEntryDecoder, {
    minLength: privacyProcessorRoles.length,
    maxLength: privacyProcessorRoles.length,
    uniqueBy: (value) => value.role,
  }),
});

export const localPrivacyProcessingRegistryFixture: PrivacyProcessingRegistry =
  {
    schemaVersion: PRIVACY_PROCESSING_REGISTRY_SCHEMA_VERSION,
    registryVersion: 'processing-registry-v1:2026-09-15',
    reviewedOn: '2026-09-15',
    data: [
      {
        categoryId: 'account-identity',
        sources: ['direct-from-user', 'identity-provider'],
        purposes: ['identity-and-account', 'support-and-legal-compliance'],
        systems: ['d1-control-plane', 'provider-system'],
        retention: [
          {
            kind: 'decision-required',
            topic: 'account and identity record retention after closure',
          },
        ],
      },
      {
        categoryId: 'authentication-security',
        sources: ['direct-from-user', 'service-generated'],
        purposes: ['identity-and-account', 'security-and-abuse-prevention'],
        systems: ['d1-control-plane', 'provider-system'],
        retention: [
          { kind: 'session-expiry-or-revocation' },
          { kind: 'otp-challenge-expiry' },
        ],
      },
      {
        categoryId: 'billing-contract',
        sources: ['direct-from-user', 'billing-provider'],
        purposes: ['billing-and-entitlement', 'support-and-legal-compliance'],
        systems: ['d1-control-plane', 'provider-system'],
        retention: [
          {
            kind: 'decision-required',
            topic: 'contract and billing record statutory retention',
          },
        ],
      },
      {
        categoryId: 'vault-content',
        sources: ['direct-from-user'],
        purposes: ['service-delivery-and-sync', 'deletion-and-recovery'],
        systems: ['d1-control-plane', 'private-encrypted-object-storage'],
        retention: [
          { kind: 'account-deletion-live-purge' },
          { kind: 'backup-expiry', maximumDays: 30 },
        ],
      },
      {
        categoryId: 'device-offline-replica',
        sources: ['direct-from-user', 'device-generated'],
        purposes: ['service-delivery-and-sync'],
        systems: ['browser-indexeddb'],
        retention: [{ kind: 'logout-local-purge' }],
      },
      {
        categoryId: 'operational-audit',
        sources: ['service-generated'],
        purposes: [
          'security-and-abuse-prevention',
          'service-reliability',
          'support-and-legal-compliance',
        ],
        systems: ['d1-control-plane'],
        retention: [
          {
            kind: 'decision-required',
            topic: 'redacted operational and audit record retention',
          },
        ],
      },
    ],
    processors: [
      pendingProcessor('hosting-database-object-storage', [
        'account-identity',
        'authentication-security',
        'billing-contract',
        'vault-content',
        'operational-audit',
      ]),
      pendingProcessor('google-identity', [
        'account-identity',
        'authentication-security',
      ]),
      pendingProcessor('email-delivery', [
        'account-identity',
        'authentication-security',
      ]),
      pendingProcessor('subscription-billing', ['billing-contract']),
      pendingProcessor('key-management', ['vault-content']),
    ],
  };

export function decodePrivacyProcessingRegistry(
  input: unknown,
): PrivacyProcessingRegistryDecodeResult {
  const decoded = registryShapeDecoder.decode(input);
  if (!decoded.ok) {
    return {
      kind: 'invalid',
      issues: decoded.issues.map(
        (issue) => `${formatPath(issue.path)}: ${issue.reason}`,
      ),
    };
  }
  const registry: PrivacyProcessingRegistry = decoded.value;
  const issues = validateRegistry(registry);
  return issues.length > 0
    ? { kind: 'invalid', issues }
    : { kind: 'decoded', registry };
}

export function resolvePrivacyProcessingRegistry(
  environment: unknown,
): PrivacyProcessingRegistryResolution {
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
      registry: localPrivacyProcessingRegistryFixture,
    };
  }
  if (serviceMode !== 'public-paid') {
    return {
      kind: 'blocked',
      reason: 'invalid-service-mode',
      issues: ['FUKAMU_SERVICE_MODE must be legacy-test or public-paid'],
    };
  }
  const source = environment.FUKAMU_PRIVACY_PROCESSING_REGISTRY_JSON;
  if (typeof source !== 'string' || source.length === 0) {
    return {
      kind: 'blocked',
      reason: 'missing-production-configuration',
      issues: [
        'FUKAMU_PRIVACY_PROCESSING_REGISTRY_JSON is required in public-paid mode',
      ],
    };
  }
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch {
    return {
      kind: 'blocked',
      reason: 'invalid-production-configuration',
      issues: ['FUKAMU_PRIVACY_PROCESSING_REGISTRY_JSON must be valid JSON'],
    };
  }
  const decoded = decodePrivacyProcessingRegistry(input);
  if (decoded.kind === 'invalid') {
    return {
      kind: 'blocked',
      reason: 'invalid-production-configuration',
      issues: decoded.issues,
    };
  }
  const productionIssues = validateProductionRegistry(decoded.registry);
  return productionIssues.length > 0
    ? {
        kind: 'blocked',
        reason: 'invalid-production-configuration',
        issues: productionIssues,
      }
    : {
        kind: 'ready',
        source: 'production-configuration',
        registry: decoded.registry,
      };
}

export function evaluatePrivacyProcessingConsistency(input: {
  readonly disclosure: PrivacyDisclosure;
  readonly registry: PrivacyProcessingRegistry;
}): PrivacyProcessingConsistencyResult {
  const issues = validateRegistry(input.registry);
  const disclosed = new Set(
    input.disclosure.collection.map((item) => item.categoryId),
  );
  const registered = new Set(
    input.registry.data.map((item) => item.categoryId),
  );
  for (const categoryId of privacyDataCategoryIds) {
    if (!disclosed.has(categoryId)) {
      issues.push(`privacy disclosure is missing ${categoryId}`);
    }
    if (!registered.has(categoryId)) {
      issues.push(`processing registry is missing ${categoryId}`);
    }
  }
  if (
    input.disclosure.retention.backupMaximumDays !== 30 ||
    !hasRetention(input.registry, 'vault-content', 'backup-expiry')
  ) {
    issues.push('vault-content backup retention must remain at most 30 days');
  }
  if (
    !hasRetention(
      input.registry,
      'vault-content',
      'account-deletion-live-purge',
    )
  ) {
    issues.push('vault-content must be live-purged by account deletion');
  }
  if (
    !hasRetention(
      input.registry,
      'device-offline-replica',
      'logout-local-purge',
    )
  ) {
    issues.push('device replica must be purged on logout');
  }
  return issues.length > 0
    ? { kind: 'inconsistent', issues }
    : { kind: 'consistent' };
}

function validateRegistry(registry: PrivacyProcessingRegistry): string[] {
  const issues: string[] = [];
  if (
    registry.registryVersion !== `processing-registry-v1:${registry.reviewedOn}`
  ) {
    issues.push(
      'registryVersion must match processing-registry-v1:<reviewedOn>',
    );
  }
  const categories = new Set(registry.data.map((entry) => entry.categoryId));
  for (const required of privacyDataCategoryIds) {
    if (!categories.has(required))
      issues.push(`data entry missing ${required}`);
  }
  const roles = new Set(registry.processors.map((entry) => entry.role));
  for (const required of privacyProcessorRoles) {
    if (!roles.has(required)) issues.push(`processor role missing ${required}`);
  }
  for (const processor of registry.processors) {
    for (const categoryId of processor.dataCategories) {
      if (!categories.has(categoryId)) {
        issues.push(`${processor.role} references missing ${categoryId}`);
      }
    }
    const categoryPurposes = new Set(
      registry.data
        .filter((entry) => processor.dataCategories.includes(entry.categoryId))
        .flatMap((entry) => entry.purposes),
    );
    for (const purpose of processor.purposes) {
      if (!categoryPurposes.has(purpose)) {
        issues.push(
          `${processor.role} references undeclared purpose ${purpose}`,
        );
      }
    }
  }
  if (
    !hasRetention(
      registry,
      'authentication-security',
      'session-expiry-or-revocation',
    )
  ) {
    issues.push('authentication-security must expire or revoke sessions');
  }
  if (
    !hasRetention(registry, 'authentication-security', 'otp-challenge-expiry')
  ) {
    issues.push('authentication-security must expire OTP challenges');
  }
  if (!hasRetention(registry, 'vault-content', 'account-deletion-live-purge')) {
    issues.push('vault-content must be live-purged by account deletion');
  }
  const backupPolicies = retentionFor(registry, 'vault-content').filter(
    (policy) => policy.kind === 'backup-expiry',
  );
  if (
    backupPolicies.length !== 1 ||
    backupPolicies[0]?.kind !== 'backup-expiry' ||
    backupPolicies[0].maximumDays !== 30
  ) {
    issues.push('vault-content must have one 30-day backup expiry policy');
  }
  if (!hasRetention(registry, 'device-offline-replica', 'logout-local-purge')) {
    issues.push('device replica must be purged on logout');
  }
  return issues;
}

function validateProductionRegistry(
  registry: PrivacyProcessingRegistry,
): readonly string[] {
  const issues: string[] = [];
  const placeholder =
    /(?:placeholder|example|sample|todo|tbd|未設定|未確定|開発用|サンプル)/i;
  for (const entry of registry.data) {
    for (const policy of entry.retention) {
      if (policy.kind === 'decision-required') {
        issues.push(`${entry.categoryId} retention remains decision-required`);
      }
      if (
        policy.kind === 'documented-period' &&
        placeholder.test(policy.summary)
      ) {
        issues.push(`${entry.categoryId} retention contains a placeholder`);
      }
    }
  }
  for (const processor of registry.processors) {
    if (processor.status.kind === 'decision-required') {
      issues.push(`${processor.role} remains decision-required`);
      continue;
    }
    for (const [field, value] of [
      ['legalName', processor.status.legalName],
      ...processor.status.countries.map(
        (country, index) => [`countries[${index}]`, country] as const,
      ),
    ] as const) {
      if (placeholder.test(value)) {
        issues.push(`${processor.role}.${field} contains a placeholder`);
      }
    }
    if (processor.status.transfer.kind === 'cross-border-reviewed') {
      for (const [field, value] of [
        ['summary', processor.status.transfer.summary],
        ['safeguards', processor.status.transfer.safeguards],
      ] as const) {
        if (placeholder.test(value)) {
          issues.push(
            `${processor.role}.transfer.${field} contains a placeholder`,
          );
        }
      }
    }
  }
  return issues;
}

function pendingProcessor(
  role: PrivacyProcessorRole,
  dataCategories: readonly PrivacyDataCategoryId[],
): PrivacyProcessorEntry {
  const purposes = unique(localPrivacyPurposesForCategories(dataCategories));
  return {
    role,
    dataCategories,
    purposes,
    status: {
      kind: 'decision-required',
      decisions: [
        'legal entity, processing location, legal role, transfer basis, safeguards, and subprocessors',
      ],
    },
  };
}

function localPrivacyPurposesForCategories(
  dataCategories: readonly PrivacyDataCategoryId[],
): readonly PrivacyProcessingPurposeId[] {
  const purposeByCategory: Readonly<
    Record<PrivacyDataCategoryId, readonly PrivacyProcessingPurposeId[]>
  > = {
    'account-identity': [
      'identity-and-account',
      'support-and-legal-compliance',
    ],
    'authentication-security': [
      'identity-and-account',
      'security-and-abuse-prevention',
    ],
    'billing-contract': [
      'billing-and-entitlement',
      'support-and-legal-compliance',
    ],
    'vault-content': ['service-delivery-and-sync', 'deletion-and-recovery'],
    'device-offline-replica': ['service-delivery-and-sync'],
    'operational-audit': [
      'security-and-abuse-prevention',
      'service-reliability',
      'support-and-legal-compliance',
    ],
  };
  return dataCategories.flatMap((categoryId) => purposeByCategory[categoryId]);
}

function retentionFor(
  registry: PrivacyProcessingRegistry,
  categoryId: PrivacyDataCategoryId,
): readonly PrivacyRetentionPolicy[] {
  return (
    registry.data.find((entry) => entry.categoryId === categoryId)?.retention ??
    []
  );
}

function hasRetention(
  registry: PrivacyProcessingRegistry,
  categoryId: PrivacyDataCategoryId,
  kind: PrivacyRetentionPolicy['kind'],
): boolean {
  return retentionFor(registry, categoryId).some(
    (policy) => policy.kind === kind,
  );
}

function retentionKey(policy: PrivacyRetentionPolicy): string {
  return policy.kind;
}

function unique<TValue extends string>(values: readonly TValue[]): TValue[] {
  return [...new Set(values)];
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

function formatPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return '$';
  return path.reduce<string>(
    (result, segment) =>
      typeof segment === 'number'
        ? `${result}[${segment}]`
        : `${result}.${segment}`,
    '$',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

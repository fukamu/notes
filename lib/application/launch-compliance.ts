import {
  arrayDecoder,
  booleanDecoder,
  literalDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
} from '../codec/core.ts';

export const LAUNCH_COMPLIANCE_SCHEMA_VERSION = 1;

export const launchComplianceRequirementIds = [
  'approved-public-offer',
  'operator-corporate-and-contact-values',
  'policy-version-archive',
  'japanese-legal-review',
  'tax-and-qualified-invoice-review',
  'telecom-business-assessment',
  'email-delivery-provider',
  'gcp-kms-production-configuration',
  'psp-merchant-contract-review',
  'pci-saq-confirmation',
  'production-3ds-evidence',
  'vulnerability-management-evidence',
  'incident-contact-and-drill',
  'marketing-consent-operations',
  'privacy-incident-timeline',
] as const;

export type LaunchComplianceRequirementId =
  (typeof launchComplianceRequirementIds)[number];

export type LaunchComplianceEvidence =
  | Readonly<{
      kind: 'automated';
      version: string;
      reference: string;
    }>
  | Readonly<{
      kind: 'pending';
      reason: string;
    }>
  | Readonly<{
      kind: 'verified';
      version: string;
      reference: string;
      verifiedOn: string;
      expiresOn: string;
    }>;

export type LaunchComplianceRequirement = Readonly<{
  id: LaunchComplianceRequirementId;
  evidence: LaunchComplianceEvidence;
}>;

export type LaunchComplianceManifest = Readonly<{
  schemaVersion: typeof LAUNCH_COMPLIANCE_SCHEMA_VERSION;
  manifestVersion: string;
  reviewedOn: string;
  service: Readonly<{
    monthlyPriceYen: 980;
    taxIncluded: true;
    trialDays: 14;
  }>;
  policyVersions: Readonly<{
    commercialEffectiveDate: string;
    termsVersion: string;
    privacyVersion: string;
    processingRegistryVersion: string;
    externalTransmissionVersion: string;
    cardPaymentSecurityVersion: string;
  }>;
  requirements: readonly LaunchComplianceRequirement[];
}>;

export type LaunchComplianceManifestDecodeResult =
  | { readonly kind: 'decoded'; readonly manifest: LaunchComplianceManifest }
  | { readonly kind: 'invalid'; readonly issues: readonly string[] };

export type LaunchComplianceBlockReason =
  | 'missing-evidence'
  | 'evidence-not-yet-valid'
  | 'evidence-expired';

export type LaunchComplianceEvaluation =
  | { readonly kind: 'invalid-check-date' }
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'blocked';
      readonly blockers: readonly Readonly<{
        id: LaunchComplianceRequirementId;
        reason: LaunchComplianceBlockReason;
      }>[];
    };

const calendarDateDecoder = refineDecoder(
  stringDecoder({ minLength: 10, maxLength: 10 }),
  isCalendarDate,
  'expected a valid YYYY-MM-DD date',
);
const nonBlankTextDecoder = refineDecoder(
  stringDecoder({ minLength: 1, maxLength: 1_000 }),
  (value) => value.trim().length > 0,
  'expected non-blank text',
);
const versionDecoder = refineDecoder(
  stringDecoder({ minLength: 1, maxLength: 200 }),
  (value) => /^[a-z0-9][a-z0-9:._-]+$/i.test(value),
  'expected a version identifier',
);
const repositoryReferenceDecoder = refineDecoder(
  stringDecoder({ minLength: 1, maxLength: 500 }),
  (value) =>
    /^(?:repository|approved-system):[a-z0-9][a-z0-9./:_-]+$/i.test(value),
  'expected a repository: or approved-system: evidence reference',
);
const requirementIdDecoder: Decoder<LaunchComplianceRequirementId> =
  unionDecoder(
    ...launchComplianceRequirementIds.map((id) => literalDecoder(id)),
  );
const evidenceDecoder: Decoder<LaunchComplianceEvidence> = unionDecoder(
  objectDecoder({
    kind: literalDecoder('automated'),
    version: versionDecoder,
    reference: repositoryReferenceDecoder,
  }),
  objectDecoder({
    kind: literalDecoder('pending'),
    reason: nonBlankTextDecoder,
  }),
  objectDecoder({
    kind: literalDecoder('verified'),
    version: versionDecoder,
    reference: repositoryReferenceDecoder,
    verifiedOn: calendarDateDecoder,
    expiresOn: calendarDateDecoder,
  }),
);
const requirementDecoder: Decoder<LaunchComplianceRequirement> = objectDecoder({
  id: requirementIdDecoder,
  evidence: evidenceDecoder,
});
const literalTrueDecoder: Decoder<true> = transformDecoder(
  refineDecoder(booleanDecoder, (value) => value, 'expected true'),
  () => true,
);
const literal980Decoder: Decoder<980> = transformDecoder(
  safeIntegerDecoder({ minimum: 980, maximum: 980 }),
  () => 980,
);
const literal14Decoder: Decoder<14> = transformDecoder(
  safeIntegerDecoder({ minimum: 14, maximum: 14 }),
  () => 14,
);
const manifestDecoder: Decoder<LaunchComplianceManifest> = transformDecoder(
  objectDecoder({
    schemaVersion: transformDecoder(
      safeIntegerDecoder({ minimum: 1, maximum: 1 }),
      (): typeof LAUNCH_COMPLIANCE_SCHEMA_VERSION =>
        LAUNCH_COMPLIANCE_SCHEMA_VERSION,
    ),
    manifestVersion: versionDecoder,
    reviewedOn: calendarDateDecoder,
    service: objectDecoder({
      monthlyPriceYen: literal980Decoder,
      taxIncluded: literalTrueDecoder,
      trialDays: literal14Decoder,
    }),
    policyVersions: objectDecoder({
      commercialEffectiveDate: calendarDateDecoder,
      termsVersion: versionDecoder,
      privacyVersion: versionDecoder,
      processingRegistryVersion: versionDecoder,
      externalTransmissionVersion: versionDecoder,
      cardPaymentSecurityVersion: versionDecoder,
    }),
    requirements: arrayDecoder(requirementDecoder, {
      minLength: launchComplianceRequirementIds.length,
      maxLength: launchComplianceRequirementIds.length,
      uniqueBy: (requirement) => requirement.id,
    }),
  }),
  (value): LaunchComplianceManifest => value,
);

export const launchComplianceManifest: LaunchComplianceManifest = {
  schemaVersion: LAUNCH_COMPLIANCE_SCHEMA_VERSION,
  manifestVersion: 'launch-compliance-v1:2026-09-15',
  reviewedOn: '2026-09-15',
  service: {
    monthlyPriceYen: 980,
    taxIncluded: true,
    trialDays: 14,
  },
  policyVersions: {
    commercialEffectiveDate: '2026-09-15',
    termsVersion: 'terms-v1:2026-09-15',
    privacyVersion: 'privacy-v1:2026-09-15',
    processingRegistryVersion: 'processing-registry-v1:2026-09-15',
    externalTransmissionVersion: 'external-transmission-v1:2026-09-15',
    cardPaymentSecurityVersion: 'card-payment-security-v1:2026-09-15',
  },
  requirements: [
    {
      id: 'approved-public-offer',
      evidence: {
        kind: 'automated',
        version: 'offer-v1:2026-09-15',
        reference: 'repository:lib/application/legal-product.ts',
      },
    },
    {
      id: 'operator-corporate-and-contact-values',
      evidence: {
        kind: 'pending',
        reason:
          'Replace the central development placeholders with verified company, representative, address, phone and support contact values.',
      },
    },
    {
      id: 'policy-version-archive',
      evidence: {
        kind: 'pending',
        reason:
          'Archive the exact production-rendered terms, privacy, commerce and external-transmission versions in the approved evidence system.',
      },
    },
    {
      id: 'japanese-legal-review',
      evidence: {
        kind: 'pending',
        reason:
          'Obtain qualified Japanese legal review of the final operator values, public copy, checkout and consent flows.',
      },
    },
    {
      id: 'tax-and-qualified-invoice-review',
      evidence: {
        kind: 'pending',
        reason:
          'Record the tax treatment and qualified-invoice decision for the operating company.',
      },
    },
    {
      id: 'telecom-business-assessment',
      evidence: {
        kind: 'pending',
        reason:
          'Record the final telecommunications-business and external-transmission assessment for the production service shape.',
      },
    },
    {
      id: 'email-delivery-provider',
      evidence: {
        kind: 'pending',
        reason:
          'Select and review the Email OTP delivery provider before enabling production Email OTP.',
      },
    },
    {
      id: 'gcp-kms-production-configuration',
      evidence: {
        kind: 'pending',
        reason:
          'Record approved GCP Cloud KMS project, region, IAM, rotation and staging evidence without storing credentials in this repository.',
      },
    },
    {
      id: 'psp-merchant-contract-review',
      evidence: {
        kind: 'pending',
        reason:
          'Confirm the operating company merchant role and Stripe PSP/acquirer contract responsibilities.',
      },
    },
    {
      id: 'pci-saq-confirmation',
      evidence: {
        kind: 'pending',
        reason:
          'Confirm and record the applicable PCI DSS SAQ and scope with Stripe or the acquirer.',
      },
    },
    {
      id: 'production-3ds-evidence',
      evidence: {
        kind: 'pending',
        reason:
          'Record production-like 3DS challenge, failure and recurring-payment evidence for the final configuration.',
      },
    },
    {
      id: 'vulnerability-management-evidence',
      evidence: {
        kind: 'pending',
        reason:
          'Resolve or formally assess the five high-severity production dependency findings recorded by Issue 134 and assign remediation ownership.',
      },
    },
    {
      id: 'incident-contact-and-drill',
      evidence: {
        kind: 'pending',
        reason:
          'Replace the incident contact placeholder and record a reviewed card and privacy incident escalation drill.',
      },
    },
    {
      id: 'marketing-consent-operations',
      evidence: {
        kind: 'pending',
        reason:
          'Implement the approved provider-backed marketing opt-in, withdrawal and retention record before any marketing email is sent.',
      },
    },
    {
      id: 'privacy-incident-timeline',
      evidence: {
        kind: 'automated',
        version: 'privacy-incident-tabletop-v1:2026-09-15',
        reference: 'repository:lib/domain/privacy-incident.ts',
      },
    },
  ],
};

export function decodeLaunchComplianceManifest(
  input: unknown,
): LaunchComplianceManifestDecodeResult {
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
    `launch-compliance-v1:${decoded.value.reviewedOn}`
  ) {
    issues.push(
      '$.manifestVersion must match launch-compliance-v1:<reviewedOn>',
    );
  }
  for (const id of launchComplianceRequirementIds) {
    if (!decoded.value.requirements.some((entry) => entry.id === id)) {
      issues.push(`$.requirements must include ${id}`);
    }
  }
  for (const requirement of decoded.value.requirements) {
    if (
      requirement.evidence.kind === 'verified' &&
      requirement.evidence.expiresOn < requirement.evidence.verifiedOn
    ) {
      issues.push(
        `$.requirements.${requirement.id}.evidence expires before verification`,
      );
    }
  }

  return issues.length === 0
    ? { kind: 'decoded', manifest: decoded.value }
    : { kind: 'invalid', issues };
}

export function evaluateLaunchCompliance(
  manifest: LaunchComplianceManifest,
  checkedOn: string,
): LaunchComplianceEvaluation {
  if (!isCalendarDate(checkedOn)) return { kind: 'invalid-check-date' };

  const blockers: Array<{
    id: LaunchComplianceRequirementId;
    reason: LaunchComplianceBlockReason;
  }> = [];
  for (const requirement of manifest.requirements) {
    switch (requirement.evidence.kind) {
      case 'automated':
        break;
      case 'pending':
        blockers.push({ id: requirement.id, reason: 'missing-evidence' });
        break;
      case 'verified':
        if (requirement.evidence.verifiedOn > checkedOn) {
          blockers.push({
            id: requirement.id,
            reason: 'evidence-not-yet-valid',
          });
        } else if (requirement.evidence.expiresOn < checkedOn) {
          blockers.push({ id: requirement.id, reason: 'evidence-expired' });
        }
        break;
    }
  }

  return blockers.length === 0
    ? { kind: 'ready' }
    : { kind: 'blocked', blockers };
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value)
  );
}

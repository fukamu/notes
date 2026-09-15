import { access, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { cardPaymentSecurityManifest } from '../lib/application/card-payment-security.ts';
import {
  decodeLaunchComplianceManifest,
  evaluateLaunchCompliance,
  launchComplianceManifest,
} from '../lib/application/launch-compliance.ts';
import { localLegalCommerceFixture } from '../lib/application/legal-commerce.ts';
import { FUKAMU_MONTHLY_PRICE_YEN } from '../lib/application/legal-product.ts';
import { localLegalTermsFixture } from '../lib/application/legal-terms.ts';
import { externalTransmissionManifest } from '../lib/application/external-transmission.ts';
import { localPrivacyDisclosureFixture } from '../lib/application/privacy-disclosure.ts';
import { localPrivacyProcessingRegistryFixture } from '../lib/application/privacy-processing-registry.ts';

const decoded = decodeLaunchComplianceManifest(launchComplianceManifest);
if (decoded.kind !== 'decoded') {
  throw new Error(
    `Launch compliance manifest is invalid: ${decoded.issues.join('; ')}`,
  );
}

const versionDrift = [
  [
    'monthlyPriceYen',
    decoded.manifest.service.monthlyPriceYen,
    FUKAMU_MONTHLY_PRICE_YEN,
  ],
  [
    'commercialEffectiveDate',
    decoded.manifest.policyVersions.commercialEffectiveDate,
    localLegalCommerceFixture.effectiveDate,
  ],
  [
    'termsVersion',
    decoded.manifest.policyVersions.termsVersion,
    localLegalTermsFixture.termsVersion,
  ],
  [
    'privacyVersion',
    decoded.manifest.policyVersions.privacyVersion,
    localPrivacyDisclosureFixture.policyVersion,
  ],
  [
    'processingRegistryVersion',
    decoded.manifest.policyVersions.processingRegistryVersion,
    localPrivacyProcessingRegistryFixture.registryVersion,
  ],
  [
    'externalTransmissionVersion',
    decoded.manifest.policyVersions.externalTransmissionVersion,
    externalTransmissionManifest.manifestVersion,
  ],
  [
    'cardPaymentSecurityVersion',
    decoded.manifest.policyVersions.cardPaymentSecurityVersion,
    cardPaymentSecurityManifest.manifestVersion,
  ],
].filter(([, expected, actual]) => expected !== actual);
if (versionDrift.length > 0) {
  throw new Error(
    `Launch compliance policy drift: ${versionDrift
      .map(([field, expected, actual]) => `${field}=${expected}/${actual}`)
      .join('; ')}`,
  );
}

const checkedOnFlag = process.argv.find((argument) =>
  argument.startsWith('--checked-on='),
);
const checkedOn =
  checkedOnFlag === undefined
    ? new Date().toISOString().slice(0, 10)
    : checkedOnFlag.slice('--checked-on='.length);
const evaluation = evaluateLaunchCompliance(decoded.manifest, checkedOn);
if (evaluation.kind === 'invalid-check-date') {
  throw new Error(`Invalid launch compliance check date: ${checkedOn}`);
}
if (
  process.argv.includes('--production-release') &&
  evaluation.kind === 'blocked'
) {
  throw new Error(
    `Production launch compliance blocked: ${evaluation.blockers
      .map(({ id, reason }) => `${id}:${reason}`)
      .join(', ')}`,
  );
}

const documentationFiles = [
  'docs/legal-launch-compliance.md',
  'docs/marketing-email-consent.md',
  'docs/personal-data-incident-response.md',
];
for (const path of documentationFiles) {
  const source = await readFile(path, 'utf8');
  await verifyMarkdownLinks(path, source);
}

/**
 * @param {string} sourcePath
 * @param {string} source
 */
async function verifyMarkdownLinks(sourcePath, source) {
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (target === undefined || target.startsWith('#')) continue;
    if (/^https?:\/\//.test(target)) {
      const url = new URL(target);
      if (url.protocol !== 'https:') {
        throw new Error(`${sourcePath} contains a non-HTTPS public link`);
      }
      continue;
    }

    const pathWithoutFragment = target.split('#')[0];
    if (pathWithoutFragment === undefined || pathWithoutFragment.length === 0) {
      continue;
    }
    const resolved = resolve(dirname(sourcePath), pathWithoutFragment);
    if (relative(process.cwd(), resolved).startsWith('..')) {
      throw new Error(`${sourcePath} link escapes the repository: ${target}`);
    }
    await access(resolved);
  }
}

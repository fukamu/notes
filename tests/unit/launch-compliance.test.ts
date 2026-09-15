import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  decodeLaunchComplianceManifest,
  evaluateLaunchCompliance,
  launchComplianceManifest,
  launchComplianceRequirementIds,
  type LaunchComplianceManifest,
} from '@/lib/application/launch-compliance';

function verifiedManifest(
  verifiedOn = '2026-09-01',
  expiresOn = '2027-09-01',
): LaunchComplianceManifest {
  return {
    ...launchComplianceManifest,
    requirements: launchComplianceManifest.requirements.map((requirement) => ({
      id: requirement.id,
      evidence: {
        kind: 'verified',
        version: 'evidence-v1:2026-09-01',
        reference: `approved-system:${requirement.id}`,
        verifiedOn,
        expiresOn,
      },
    })),
  };
}

describe('production launch compliance manifest', () => {
  it('strictly decodes the complete inventory and keeps production blocked', () => {
    expect(decodeLaunchComplianceManifest(launchComplianceManifest)).toEqual({
      kind: 'decoded',
      manifest: launchComplianceManifest,
    });
    expect(launchComplianceManifest.requirements.map(({ id }) => id)).toEqual(
      launchComplianceRequirementIds,
    );

    const evaluation = evaluateLaunchCompliance(
      launchComplianceManifest,
      '2026-09-15',
    );
    expect(evaluation).toMatchObject({ kind: 'blocked' });
    if (evaluation.kind === 'blocked') {
      expect(evaluation.blockers).toEqual([
        {
          id: 'operator-corporate-and-contact-values',
          reason: 'missing-evidence',
        },
        { id: 'policy-version-archive', reason: 'missing-evidence' },
        { id: 'japanese-legal-review', reason: 'missing-evidence' },
        {
          id: 'tax-and-qualified-invoice-review',
          reason: 'missing-evidence',
        },
        { id: 'telecom-business-assessment', reason: 'missing-evidence' },
        { id: 'email-delivery-provider', reason: 'missing-evidence' },
        {
          id: 'gcp-kms-production-configuration',
          reason: 'missing-evidence',
        },
        { id: 'psp-merchant-contract-review', reason: 'missing-evidence' },
        { id: 'pci-saq-confirmation', reason: 'missing-evidence' },
        { id: 'production-3ds-evidence', reason: 'missing-evidence' },
        {
          id: 'vulnerability-management-evidence',
          reason: 'missing-evidence',
        },
        { id: 'incident-contact-and-drill', reason: 'missing-evidence' },
        { id: 'marketing-consent-operations', reason: 'missing-evidence' },
      ]);
    }
  });

  it('rejects incomplete, unknown and internally inconsistent evidence', () => {
    for (const input of [
      {
        ...launchComplianceManifest,
        service: { ...launchComplianceManifest.service, monthlyPriceYen: 960 },
      },
      {
        ...launchComplianceManifest,
        requirements: launchComplianceManifest.requirements.slice(1),
      },
      {
        ...launchComplianceManifest,
        unexpected: 'field',
      },
      verifiedManifest('2027-09-01', '2026-09-01'),
    ]) {
      expect(decodeLaunchComplianceManifest(input)).toMatchObject({
        kind: 'invalid',
      });
    }
  });

  it('fails not-yet-valid and expired evidence, then accepts complete current evidence', () => {
    const future = evaluateLaunchCompliance(
      verifiedManifest('2026-09-16', '2027-09-01'),
      '2026-09-15',
    );
    expect(future.kind).toBe('blocked');
    if (future.kind === 'blocked') {
      expect(future.blockers).toHaveLength(
        launchComplianceRequirementIds.length,
      );
      expect(
        future.blockers.every(
          ({ reason }) => reason === 'evidence-not-yet-valid',
        ),
      ).toBe(true);
    }

    const expired = evaluateLaunchCompliance(
      verifiedManifest('2026-01-01', '2026-09-14'),
      '2026-09-15',
    );
    expect(expired.kind).toBe('blocked');
    if (expired.kind === 'blocked') {
      expect(expired.blockers).toHaveLength(
        launchComplianceRequirementIds.length,
      );
      expect(
        expired.blockers.every(({ reason }) => reason === 'evidence-expired'),
      ).toBe(true);
    }
    expect(evaluateLaunchCompliance(verifiedManifest(), '2026-09-15')).toEqual({
      kind: 'ready',
    });
    expect(evaluateLaunchCompliance(verifiedManifest(), 'invalid')).toEqual({
      kind: 'invalid-check-date',
    });
  });

  it('runs a non-blocking build check and a fail-closed production release check', async () => {
    const check = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'scripts/verify-launch-compliance.mjs',
        '--checked-on=2026-09-15',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(check.status).toBe(0);

    const release = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'scripts/verify-launch-compliance.mjs',
        '--production-release',
        '--checked-on=2026-09-15',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(release.status).not.toBe(0);
    expect(`${release.stdout}${release.stderr}`).toContain(
      'Production launch compliance blocked',
    );

    const packageSource = await readFile('package.json', 'utf8');
    expect(packageSource).toContain('check:launch-compliance');
    expect(packageSource).toContain('check:production-launch');
  });
});

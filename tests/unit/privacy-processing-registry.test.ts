import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { localPrivacyDisclosureFixture } from '@/lib/application/privacy-disclosure';
import {
  decodePrivacyProcessingRegistry,
  evaluatePrivacyProcessingConsistency,
  localPrivacyProcessingRegistryFixture,
  resolvePrivacyProcessingRegistry,
  type PrivacyProcessingRegistry,
  type PrivacyProcessorEntry,
} from '@/lib/application/privacy-processing-registry';
import {
  privacyDataCategoryIds,
  privacyProcessingPurposeIds,
} from '@/lib/domain/privacy-processing';

function productionRegistry(): PrivacyProcessingRegistry {
  return {
    ...localPrivacyProcessingRegistryFixture,
    data: localPrivacyProcessingRegistryFixture.data.map((entry) => ({
      ...entry,
      retention: entry.retention.map((policy) =>
        policy.kind === 'decision-required'
          ? {
              kind: 'documented-period' as const,
              summary: '法令、契約および問い合わせ対応に必要な承認済み期間',
            }
          : policy,
      ),
    })),
    processors:
      localPrivacyProcessingRegistryFixture.processors.map(verifiedProcessor),
  };
}

function verifiedProcessor(
  processor: PrivacyProcessorEntry,
): PrivacyProcessorEntry {
  return {
    ...processor,
    status: {
      kind: 'verified',
      legalName: `株式会社${processor.role}`,
      legalRole: 'processor',
      countries: ['日本'],
      privacyUrl: `https://providers.fukamu-notes.jp/${processor.role}/privacy`,
      subprocessorsUrl: undefined,
      transfer: { kind: 'domestic-only' },
    },
  };
}

describe('privacy processing registry core', () => {
  it('decodes the complete provider-neutral registry and its stable vocabulary', () => {
    expect(
      decodePrivacyProcessingRegistry(localPrivacyProcessingRegistryFixture),
    ).toEqual({
      kind: 'decoded',
      registry: localPrivacyProcessingRegistryFixture,
    });
    expect(privacyDataCategoryIds).toHaveLength(6);
    expect(privacyProcessingPurposeIds).toContain('deletion-and-recovery');
  });

  it('rejects missing categories, unknown values, references, and retention drift', () => {
    const registry = localPrivacyProcessingRegistryFixture;
    for (const input of [
      null,
      { ...registry, unknown: true },
      { ...registry, reviewedOn: '2026-02-30' },
      { ...registry, registryVersion: 'processing-registry-v1:2026-09-14' },
      { ...registry, data: registry.data.slice(1) },
      {
        ...registry,
        data: registry.data.map((entry) =>
          entry.categoryId === 'vault-content'
            ? {
                ...entry,
                retention: [{ kind: 'account-deletion-live-purge' }],
              }
            : entry,
        ),
      },
      {
        ...registry,
        processors: registry.processors.map((processor, index) =>
          index === 1
            ? {
                ...processor,
                purposes: ['billing-and-entitlement'],
              }
            : processor,
        ),
      },
    ]) {
      expect(decodePrivacyProcessingRegistry(input).kind).toBe('invalid');
    }
  });

  it('uses pending local decisions without allowing them into public-paid mode', () => {
    const local = resolvePrivacyProcessingRegistry({});
    expect(local).toMatchObject({ kind: 'ready', source: 'local-fixture' });
    if (local.kind === 'ready') {
      expect(
        local.registry.processors.every(
          (processor) => processor.status.kind === 'decision-required',
        ),
      ).toBe(true);
    }

    expect(
      resolvePrivacyProcessingRegistry({
        FUKAMU_SERVICE_MODE: 'public-paid',
      }),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'missing-production-configuration',
    });
    expect(
      resolvePrivacyProcessingRegistry({
        FUKAMU_SERVICE_MODE: 'public-paid',
        FUKAMU_PRIVACY_PROCESSING_REGISTRY_JSON: '{',
      }),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'invalid-production-configuration',
    });
    expect(
      resolvePrivacyProcessingRegistry({
        FUKAMU_SERVICE_MODE: 'public-paid',
        FUKAMU_PRIVACY_PROCESSING_REGISTRY_JSON: JSON.stringify(
          localPrivacyProcessingRegistryFixture,
        ),
      }),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'invalid-production-configuration',
    });
  });

  it('accepts only a complete verified production registry', () => {
    const registry = productionRegistry();
    expect(
      resolvePrivacyProcessingRegistry({
        FUKAMU_SERVICE_MODE: 'public-paid',
        FUKAMU_PRIVACY_PROCESSING_REGISTRY_JSON: JSON.stringify(registry),
      }),
    ).toEqual({
      kind: 'ready',
      source: 'production-configuration',
      registry,
    });

    const insecure = {
      ...registry,
      processors: registry.processors.map((processor, index) =>
        index === 0 && processor.status.kind === 'verified'
          ? {
              ...processor,
              status: {
                ...processor.status,
                privacyUrl: 'http://localhost/privacy',
              },
            }
          : processor,
      ),
    };
    expect(
      resolvePrivacyProcessingRegistry({
        FUKAMU_SERVICE_MODE: 'public-paid',
        FUKAMU_PRIVACY_PROCESSING_REGISTRY_JSON: JSON.stringify(insecure),
      }),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'invalid-production-configuration',
    });
  });

  it('detects policy, registry, logout, and account-deletion drift', async () => {
    expect(
      evaluatePrivacyProcessingConsistency({
        disclosure: localPrivacyDisclosureFixture,
        registry: localPrivacyProcessingRegistryFixture,
      }),
    ).toEqual({ kind: 'consistent' });

    const disclosureWithoutVault = {
      ...localPrivacyDisclosureFixture,
      collection: localPrivacyDisclosureFixture.collection.filter(
        (entry) => entry.categoryId !== 'vault-content',
      ),
    };
    expect(
      evaluatePrivacyProcessingConsistency({
        disclosure: disclosureWithoutVault,
        registry: localPrivacyProcessingRegistryFixture,
      }),
    ).toMatchObject({ kind: 'inconsistent' });

    const registryWithoutPurge: PrivacyProcessingRegistry = {
      ...localPrivacyProcessingRegistryFixture,
      data: localPrivacyProcessingRegistryFixture.data.map((entry) =>
        entry.categoryId === 'device-offline-replica'
          ? {
              ...entry,
              retention: [{ kind: 'documented-period', summary: '保持する' }],
            }
          : entry,
      ),
    };
    expect(
      evaluatePrivacyProcessingConsistency({
        disclosure: localPrivacyDisclosureFixture,
        registry: registryWithoutPurge,
      }),
    ).toMatchObject({ kind: 'inconsistent' });

    const [deletionModel, deletionEvidence, sessionCookie, sessionEvidence] =
      await Promise.all([
        readFile('backend/internal/accountdeletion/model.go', 'utf8'),
        readFile(
          'backend/internal/accountdeletion/model_protocol_test.go',
          'utf8',
        ),
        readFile('backend/internal/identity/cookie.go', 'utf8'),
        readFile('backend/internal/identity/boundary_test.go', 'utf8'),
      ]);
    for (const step of [
      'revoke-sessions',
      'cancel-subscription',
      'delete-vault-data',
      'delete-private-objects',
      'finalize-account',
    ]) {
      expect(deletionModel).toContain(`"${step}"`);
    }
    expect(deletionEvidence).toContain(
      'func TestAccountDeletionLifecycleReceiptsAndRetry',
    );
    expect(sessionCookie).toContain(
      'SessionCookieName              = "__Host-fukamu_session"',
    );
    expect(sessionEvidence).toContain('func TestSessionCookiePolicy');
  });

  it('runs the combined disclosure/registry build gate for local fixtures', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'scripts/verify-privacy-processing-registry.mjs',
      ],
      { cwd: process.cwd(), encoding: 'utf8', env: {} },
    );
    expect(result.status).toBe(0);
  });
});

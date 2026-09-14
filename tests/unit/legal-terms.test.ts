import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  decodeLegalTermsDisclosure,
  evaluateLegalTermsConsistency,
  LEGAL_TERMS_BACKUP_MAXIMUM_DAYS,
  LEGAL_TERMS_FIRST_CHARGE_DAY,
  LEGAL_TERMS_TRIAL_DAYS,
  localLegalTermsFixture,
  resolveLegalTermsDisclosure,
  type LegalTermsDisclosure,
} from '@/lib/application/legal-terms';
import { localLegalCommerceFixture } from '@/lib/application/legal-commerce';
import { localPrivacyDisclosureFixture } from '@/lib/application/privacy-disclosure';

function productionTerms(): LegalTermsDisclosure {
  return {
    schemaVersion: 1,
    termsVersion: 'terms-v1:2026-09-15',
    effectiveDate: '2026-09-15',
    serviceName: 'FUKAMU Notes',
    operator: {
      legalName: '株式会社深考ノート',
      supportUrl: 'https://support.fukamu-notes.jp/contact',
    },
    serviceEligibility:
      '18歳以上の方が利用できます。未成年者は法定代理人の同意を得てください。',
    accountSecurity:
      '認証情報と利用端末を適切に管理し、不正利用を確認した場合は直ちに窓口へ連絡してください。',
    authentication: {
      googleLogin: true,
      emailOtp: true,
      password: false,
      sharedVault: false,
    },
    prohibitedActivities: [
      '法令または第三者の権利を侵害する行為',
      'サービスまたはネットワークの安全を損なう行為',
    ],
    userContent: {
      ownership: 'retained-by-user',
      licenseScope: 'minimum-necessary-for-service',
      licensePurpose:
        '利用者contentの権利は利用者に留保され、保存、同期、表示、保守およびsecurity対応に必要な最小範囲で取り扱います。',
    },
    billing: {
      paidOnly: true,
      trialDays: 14,
      firstChargeDay: 15,
      automaticRenewal: true,
      cancellationPolicy: 'アカウントの契約管理画面から解約できます。',
      refundPolicy: '提供開始後の返金条件は申込み最終確認画面に表示します。',
      paymentFailureLock: 'immediate-online-lock',
      resumePolicy: 'invoice-paid-only',
      cancellationSeparateFromAccountDeletion: true,
    },
    dataHandling: {
      oneAccountOnePersonalVault: true,
      localContentOnLogout: 'deleted-on-logout',
      liveDataOnAccountDeletion: 'deleted-on-account-deletion',
      backupMaximumDays: 30,
    },
    suspensionPolicy:
      '支払い停止または重大な違反がある場合、必要な範囲で利用を停止します。',
    maintenanceAndChanges:
      '保守または機能変更が必要な場合、影響と緊急性に応じて事前に通知します。',
    serviceTermination:
      'サービスを終了する場合、合理的な期間を設けて通知し、利用者dataの取扱方法を案内します。',
    intellectualProperty:
      'サービス自体の知的財産権は運営者または正当な権利者に帰属します。',
    liability:
      '適用法令に反しない範囲で、運営者の責任範囲を個別事情に応じて判断します。',
    notices: '重要な通知は登録連絡先またはサービス内の専用画面で行います。',
    governingLawAndVenue:
      '日本法を準拠法とし、法令上認められる合意管轄を利用者へ表示します。',
    amendments: {
      procedure:
        '変更後のversionと施行日を公開し、重要な変更は施行前に通知します。',
      materialChangeHandling: 'legal-review-required-before-enforcement',
    },
  };
}

describe('legal terms disclosure core', () => {
  it('decodes complete terms and fixes product invariants in the type', () => {
    expect(decodeLegalTermsDisclosure(productionTerms())).toEqual({
      kind: 'decoded',
      disclosure: productionTerms(),
    });
    expect(LEGAL_TERMS_TRIAL_DAYS).toBe(14);
    expect(LEGAL_TERMS_FIRST_CHARGE_DAY).toBe(15);
    expect(LEGAL_TERMS_BACKUP_MAXIMUM_DAYS).toBe(30);
  });

  it('rejects unknown, malformed, incomplete, and product-drift input', () => {
    const terms = productionTerms();
    for (const input of [
      null,
      { ...terms, unknown: true },
      { ...terms, termsVersion: 'terms-v1:2026-09-14' },
      { ...terms, effectiveDate: '2026-02-30' },
      { ...terms, authentication: { ...terms.authentication, password: true } },
      { ...terms, prohibitedActivities: [] },
      {
        ...terms,
        billing: { ...terms.billing, firstChargeDay: 14 },
      },
      {
        ...terms,
        dataHandling: { ...terms.dataHandling, backupMaximumDays: 31 },
      },
      {
        ...terms,
        userContent: { ...terms.userContent, licenseScope: 'unlimited' },
      },
    ]) {
      expect(decodeLegalTermsDisclosure(input).kind).toBe('invalid');
    }
  });

  it('uses an unmistakable local fixture and fails closed in public-paid mode', () => {
    for (const environment of [{}, { FUKAMU_SERVICE_MODE: 'legacy-test' }]) {
      expect(resolveLegalTermsDisclosure(environment)).toEqual({
        kind: 'ready',
        source: 'local-fixture',
        disclosure: localLegalTermsFixture,
      });
    }
    expect(resolveLegalTermsDisclosure(undefined)).toMatchObject({
      kind: 'blocked',
      reason: 'invalid-environment',
    });
    expect(
      resolveLegalTermsDisclosure({ FUKAMU_SERVICE_MODE: 'public-paid' }),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'missing-production-configuration',
    });
    expect(
      resolveLegalTermsDisclosure({
        FUKAMU_SERVICE_MODE: 'public-paid',
        FUKAMU_LEGAL_TERMS_JSON: '{',
      }),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'invalid-production-configuration',
    });
  });

  it('rejects production placeholders and insecure contacts but accepts complete terms', () => {
    const terms = productionTerms();
    expect(
      resolveLegalTermsDisclosure({
        FUKAMU_SERVICE_MODE: 'public-paid',
        FUKAMU_LEGAL_TERMS_JSON: JSON.stringify({
          ...terms,
          operator: {
            legalName: 'サンプル株式会社',
            supportUrl: 'http://localhost:3100/contact',
          },
          liability: '未確定です。',
        }),
      }),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'invalid-production-configuration',
    });
    expect(
      resolveLegalTermsDisclosure({
        FUKAMU_SERVICE_MODE: 'public-paid',
        FUKAMU_LEGAL_TERMS_JSON: JSON.stringify(terms),
      }),
    ).toEqual({
      kind: 'ready',
      source: 'production-configuration',
      disclosure: terms,
    });
  });

  it('detects drift from commercial and privacy disclosures', () => {
    expect(
      evaluateLegalTermsConsistency(
        localLegalTermsFixture,
        localLegalCommerceFixture,
        localPrivacyDisclosureFixture,
      ),
    ).toEqual({ kind: 'consistent' });
    expect(
      evaluateLegalTermsConsistency(
        {
          ...localLegalTermsFixture,
          billing: {
            ...localLegalTermsFixture.billing,
            cancellationPolicy: 'different',
          },
        },
        localLegalCommerceFixture,
        {
          ...localPrivacyDisclosureFixture,
          retention: {
            ...localPrivacyDisclosureFixture.retention,
            backupMaximumDays: 30,
          },
        },
      ),
    ).toMatchObject({ kind: 'inconsistent' });
  });
});

describe('legal terms build and page contracts', () => {
  it('runs locally and blocks public-paid builds without approved terms', () => {
    const local = spawnSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/verify-legal-terms.mjs'],
      { cwd: process.cwd(), encoding: 'utf8', env: {} },
    );
    expect(local.status).toBe(0);

    const blocked = spawnSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/verify-legal-terms.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { FUKAMU_SERVICE_MODE: 'public-paid' },
      },
    );
    expect(blocked.status).not.toBe(0);
    expect(`${blocked.stdout}${blocked.stderr}`).toContain(
      'missing-production-configuration',
    );
  });

  it('keeps the canonical terms on a dedicated public route and out of Notes', async () => {
    const [page, layout, notes, documentation] = await Promise.all([
      readFile('app/(public)/legal/terms/page.tsx', 'utf8'),
      readFile('app/(public)/layout.tsx', 'utf8'),
      readFile('components/notes-presentation.tsx', 'utf8'),
      readFile('docs/legal-terms.md', 'utf8'),
    ]);
    for (const label of [
      '利用資格',
      '禁止行為',
      '利用者content',
      '料金・無料期間・更新',
      'logout・退会・data削除',
      '責任・損害',
      '準拠法・裁判管轄',
      'version・施行日',
    ]) {
      expect(page).toContain(label);
    }
    expect(layout).toContain('/legal/terms');
    expect(notes).not.toMatch(/legal\/terms|利用規約/);
    expect(documentation).toContain('does not mount the Notes');
  });
});

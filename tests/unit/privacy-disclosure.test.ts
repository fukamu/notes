import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  decodePrivacyDisclosure,
  PRIVACY_BACKUP_RETENTION_MAXIMUM_DAYS,
  privacyRequestKindLabel,
  resolvePrivacyDisclosure,
  type PrivacyDisclosure,
} from '@/lib/application/privacy-disclosure';

function productionDisclosure(): PrivacyDisclosure {
  return {
    schemaVersion: 1,
    policyVersion: 'privacy-v1:2026-09-15',
    effectiveDate: '2026-09-15',
    serviceName: 'FUKAMU Notes',
    controller: {
      legalName: '株式会社深考ノート',
      representative: '代表取締役 山田太郎',
      postalAddress: '〒100-0001 東京都千代田区千代田1-1',
      contactUrl: 'https://support.fukamu-notes.jp/privacy',
    },
    collection: [
      {
        categoryId: 'account-identity',
        category: 'account・identity情報',
        source: '利用者による登録および認証service',
        purposes: ['本人認証、account管理および不正利用防止'],
      },
      {
        categoryId: 'authentication-security',
        category: '認証・security情報',
        source: '認証操作およびserviceによる生成',
        purposes: ['session管理、OTP検証および不正利用防止'],
      },
      {
        categoryId: 'billing-contract',
        category: '契約・請求状態',
        source: '利用者による申込みおよび決済service',
        purposes: ['subscription管理、利用権判定および問い合わせ対応'],
      },
      {
        categoryId: 'vault-content',
        category: 'Personal Vaultの利用者content',
        source: '利用者による入力および同期',
        purposes: ['notesの保存、同期、競合解決および関連表示の提供'],
      },
      {
        categoryId: 'device-offline-replica',
        category: '端末内offline replica',
        source: '利用者の入力および端末内の編集状態',
        purposes: ['offline編集および再接続後の同期'],
      },
      {
        categoryId: 'operational-audit',
        category: '運用・監査metadata',
        source: 'service利用およびsecurity event',
        purposes: ['不正利用防止、障害対応およびservice品質維持'],
      },
    ],
    personalVaultModel: 'one-account-one-personal-vault',
    userContentNotice:
      '利用者contentには第三者の個人情報が含まれる場合があるため、適法な範囲で入力してください。',
    localDeviceHandling:
      'offline利用のため端末へ保存し、logout時は当該利用者のlocal contentを削除します。',
    retention: {
      accountAndBilling:
        '契約、法令および問い合わせ対応に必要な期間保持します。',
      vaultContent:
        '退会処理でlive dataを削除し、backup等の残存は最大30日です。',
      localContentOnLogout: 'deleted-on-logout',
      liveDataOnAccountDeletion: 'deleted-on-account-deletion',
      backupMaximumDays: 30,
    },
    securityMeasures: [
      '認証、access制御およびtenant分離を実施します。',
      '利用者contentをserver-side encryptionで保護します。',
      '権限管理、監査、障害対応および復旧手順を運用します。',
    ],
    processorsAndThirdParties:
      'service提供に必要な委託先を管理・監督し、法令上認められる場合を除き、本人の同意なく第三者提供しません。',
    foreignTransfers:
      '外国で取り扱う場合は、適用法令に従い必要な情報提供と保護措置を実施します。',
    dataSubjectRequests: {
      availableActions: [
        'purpose-notification',
        'disclosure',
        'correction',
        'usage-suspension',
        'deletion',
        'third-party-provision-suspension',
      ],
      procedure: 'account画面またはprivacy窓口から請求を受け付けます。',
      identityVerification:
        '不正な開示や変更を防ぐため、請求内容に応じて本人確認を行います。',
      fee: '手数料が必要な場合は請求前に金額と支払方法を案内します。',
      contactUrl: 'https://support.fukamu-notes.jp/privacy-request',
    },
    policyChanges:
      '重要な変更は適用前にservice内または登録連絡先へ通知します。',
  };
}

describe('privacy disclosure core', () => {
  it('decodes a complete disclosure and exposes every supported request kind', () => {
    expect(decodePrivacyDisclosure(productionDisclosure())).toEqual({
      kind: 'decoded',
      disclosure: productionDisclosure(),
    });
    expect(
      productionDisclosure().dataSubjectRequests.availableActions.map(
        privacyRequestKindLabel,
      ),
    ).toEqual([
      '利用目的の通知',
      '保有個人データ・第三者提供記録の開示',
      '内容の訂正・追加・削除',
      '利用停止・消去',
      '退会に伴うlive dataの削除',
      '第三者提供の停止',
    ]);
    expect(PRIVACY_BACKUP_RETENTION_MAXIMUM_DAYS).toBe(30);
  });

  it('rejects unknown, malformed, incomplete, and product-drift values', () => {
    const disclosure = productionDisclosure();
    for (const input of [
      null,
      { ...disclosure, unknown: 'field' },
      { ...disclosure, effectiveDate: '2026-02-30' },
      { ...disclosure, policyVersion: 'privacy-v1:2026-09-14' },
      { ...disclosure, personalVaultModel: 'shared-vault' },
      { ...disclosure, collection: [] },
      {
        ...disclosure,
        retention: { ...disclosure.retention, backupMaximumDays: 31 },
      },
      {
        ...disclosure,
        dataSubjectRequests: {
          ...disclosure.dataSubjectRequests,
          availableActions: ['disclosure'],
        },
      },
      {
        ...disclosure,
        controller: { ...disclosure.controller, contactUrl: 'relative/path' },
      },
    ]) {
      expect(decodePrivacyDisclosure(input).kind).toBe('invalid');
    }
  });

  it('uses an unmistakable local fixture and blocks invalid environments', () => {
    for (const environment of [{}, { FUKAMU_SERVICE_MODE: 'legacy-test' }]) {
      const result = resolvePrivacyDisclosure(environment);
      expect(result.kind).toBe('ready');
      if (result.kind === 'ready') {
        expect(result.source).toBe('local-fixture');
        expect(result.disclosure.controller.legalName).toContain(
          '開発用サンプル',
        );
      }
    }
    expect(resolvePrivacyDisclosure(undefined)).toEqual({
      kind: 'blocked',
      reason: 'invalid-environment',
      issues: ['environment must be an object'],
    });
    expect(
      resolvePrivacyDisclosure({ FUKAMU_SERVICE_MODE: 'typo' }),
    ).toMatchObject({ kind: 'blocked', reason: 'invalid-service-mode' });
  });

  it('fails closed for missing, malformed, placeholder, and insecure production configuration', () => {
    expect(
      resolvePrivacyDisclosure({ FUKAMU_SERVICE_MODE: 'public-paid' }),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'missing-production-configuration',
    });
    expect(
      resolvePrivacyDisclosure({
        FUKAMU_SERVICE_MODE: 'public-paid',
        FUKAMU_PRIVACY_DISCLOSURE_JSON: '{',
      }),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'invalid-production-configuration',
    });
    expect(
      resolvePrivacyDisclosure({
        FUKAMU_SERVICE_MODE: 'public-paid',
        FUKAMU_PRIVACY_DISCLOSURE_JSON: JSON.stringify({
          ...productionDisclosure(),
          controller: {
            ...productionDisclosure().controller,
            legalName: 'サンプル株式会社',
            contactUrl: 'http://localhost:3100/privacy',
          },
          foreignTransfers: '未確定です。',
        }),
      }),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'invalid-production-configuration',
    });
  });

  it('accepts only a complete non-placeholder production configuration', () => {
    expect(
      resolvePrivacyDisclosure({
        FUKAMU_SERVICE_MODE: 'public-paid',
        FUKAMU_PRIVACY_DISCLOSURE_JSON: JSON.stringify(productionDisclosure()),
      }),
    ).toEqual({
      kind: 'ready',
      source: 'production-configuration',
      disclosure: productionDisclosure(),
    });
  });
});

describe('privacy disclosure build and page contracts', () => {
  it('blocks its executable build gate without production disclosure', () => {
    const blocked = spawnSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/verify-privacy-disclosure.mjs'],
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

    const ready = spawnSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/verify-privacy-disclosure.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          FUKAMU_SERVICE_MODE: 'public-paid',
          FUKAMU_PRIVACY_DISCLOSURE_JSON: JSON.stringify(
            productionDisclosure(),
          ),
        },
      },
    );
    expect(ready.status).toBe(0);
  });

  it('keeps the canonical policy on a dedicated page and out of Notes', async () => {
    const [privacy, publicLayout, notes] = await Promise.all([
      readFile('app/(public)/legal/privacy/page.tsx', 'utf8'),
      readFile('app/(public)/layout.tsx', 'utf8'),
      readFile('components/notes-presentation.tsx', 'utf8'),
    ]);
    for (const label of [
      '取得する情報・取得元・利用目的',
      '保存期間・削除',
      '安全管理措置の概要',
      '委託・第三者提供',
      '外国での取扱い',
      '本人からの請求',
      '制定・改定',
    ]) {
      expect(privacy).toContain(label);
    }
    expect(publicLayout).toContain('/legal/privacy');
    expect(notes).not.toMatch(/legal\/privacy|個人情報保護方針/);
  });
});

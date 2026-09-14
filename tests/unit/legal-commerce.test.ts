import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  billingPeriodLabel,
  decodeLegalCommerceDisclosure,
  formatTaxIncludedPrice,
  LEGAL_TRIAL_DAYS,
  resolveLegalCommerceDisclosure,
  type LegalCommerceDisclosure,
} from '@/lib/application/legal-commerce';
import { BILLING_TRIAL_DURATION_MS } from '@/server/billing/core';

function productionDisclosure(): LegalCommerceDisclosure {
  return {
    schemaVersion: 1,
    seller: {
      legalName: '株式会社深考ノート',
      representative: '販売責任者 山田太郎',
      postalAddress: '〒100-0001 東京都千代田区千代田1-1',
      phone: '03-1234-5678',
      supportUrl: 'https://support.fukamu-notes.jp/contact',
    },
    offer: {
      planName: 'FUKAMU Notes スタンダード',
      priceYen: 1_280,
      billingPeriod: 'monthly',
      taxIncluded: true,
      trialDays: 14,
    },
    additionalFees: 'インターネット接続料金は利用者の負担です。',
    cancellationPolicy: 'アカウントの契約管理画面から解約できます。',
    refundPolicy: '提供開始後の返金条件は申込み最終確認画面に表示します。',
    specialTerms: '日本国内から利用できます。',
    systemRequirements: ['最新版のChrome、Safari、Firefox、Edge'],
    effectiveDate: '2026-09-14',
  };
}

describe('legal commerce disclosure core', () => {
  it('decodes a complete disclosure and formats its explicit billing period', () => {
    expect(decodeLegalCommerceDisclosure(productionDisclosure())).toEqual({
      kind: 'decoded',
      disclosure: productionDisclosure(),
    });
    expect(formatTaxIncludedPrice(productionDisclosure())).toBe(
      '1,280円（税込）',
    );
    expect(billingPeriodLabel('monthly')).toBe('月額');
    expect(billingPeriodLabel('annual')).toBe('年額');
  });

  it('rejects missing, unknown, malformed, and product-drift values', () => {
    for (const input of [
      null,
      { ...productionDisclosure(), unknown: 'field' },
      { ...productionDisclosure(), seller: { legalName: '株式会社不足' } },
      {
        ...productionDisclosure(),
        offer: { ...productionDisclosure().offer, priceYen: 0 },
      },
      {
        ...productionDisclosure(),
        offer: { ...productionDisclosure().offer, trialDays: 7 },
      },
      { ...productionDisclosure(), effectiveDate: '2026-02-30' },
      { ...productionDisclosure(), systemRequirements: [] },
    ]) {
      expect(decodeLegalCommerceDisclosure(input).kind).toBe('invalid');
    }
    expect(LEGAL_TRIAL_DAYS * 24 * 60 * 60 * 1_000).toBe(
      BILLING_TRIAL_DURATION_MS,
    );
  });

  it('uses an unmistakable fixture outside public-paid mode', () => {
    for (const environment of [{}, { FUKAMU_SERVICE_MODE: 'legacy-test' }]) {
      const result = resolveLegalCommerceDisclosure(environment);
      expect(result.kind).toBe('ready');
      if (result.kind === 'ready') {
        expect(result.source).toBe('local-fixture');
        expect(result.disclosure.seller.legalName).toContain('開発用サンプル');
      }
    }
    expect(resolveLegalCommerceDisclosure(undefined)).toEqual({
      kind: 'blocked',
      reason: 'invalid-environment',
      issues: ['environment must be an object'],
    });
  });

  it('fails closed for missing, malformed, placeholder, and insecure production configuration', () => {
    expect(
      resolveLegalCommerceDisclosure({ FUKAMU_SERVICE_MODE: 'public-paid' }),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'missing-production-configuration',
    });
    expect(
      resolveLegalCommerceDisclosure({
        FUKAMU_SERVICE_MODE: 'public-paid',
        FUKAMU_LEGAL_COMMERCE_JSON: '{',
      }),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'invalid-production-configuration',
    });
    expect(
      resolveLegalCommerceDisclosure({
        FUKAMU_SERVICE_MODE: 'public-paid',
        FUKAMU_LEGAL_COMMERCE_JSON: JSON.stringify({
          ...productionDisclosure(),
          seller: {
            ...productionDisclosure().seller,
            legalName: 'サンプル株式会社',
            phone: '000-0000-0000',
            supportUrl: 'http://localhost:3100/contact',
          },
        }),
      }),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'invalid-production-configuration',
    });
    expect(
      resolveLegalCommerceDisclosure({ FUKAMU_SERVICE_MODE: 'typo' }),
    ).toMatchObject({ kind: 'blocked', reason: 'invalid-service-mode' });
  });

  it('accepts only complete non-placeholder production configuration', () => {
    expect(
      resolveLegalCommerceDisclosure({
        FUKAMU_SERVICE_MODE: 'public-paid',
        FUKAMU_LEGAL_COMMERCE_JSON: JSON.stringify(productionDisclosure()),
      }),
    ).toEqual({
      kind: 'ready',
      source: 'production-configuration',
      disclosure: productionDisclosure(),
    });
  });
});

describe('legal commerce build and page contracts', () => {
  it('blocks the executable build gate without production disclosure', () => {
    const blocked = spawnSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/verify-legal-commerce.mjs'],
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
      ['--experimental-strip-types', 'scripts/verify-legal-commerce.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          FUKAMU_SERVICE_MODE: 'public-paid',
          FUKAMU_LEGAL_COMMERCE_JSON: JSON.stringify(productionDisclosure()),
        },
      },
    );
    expect(ready.status).toBe(0);
  });

  it('keeps legal content on dedicated pages with direct public links', async () => {
    const [commercial, company, pricing, publicLayout, notes] =
      await Promise.all([
        readFile('app/(public)/legal/commercial-transactions/page.tsx', 'utf8'),
        readFile('app/(public)/company/page.tsx', 'utf8'),
        readFile('app/(public)/pricing/page.tsx', 'utf8'),
        readFile('app/(public)/layout.tsx', 'utf8'),
        readFile('components/notes-presentation.tsx', 'utf8'),
      ]);
    for (const label of [
      '販売事業者',
      '運営責任者',
      '所在地',
      '電話番号',
      '販売価格',
      '価格以外の負担',
      '支払方法',
      '支払時期',
      'サービス提供時期',
      '継続条件',
      '解約',
      '返金',
      '動作環境',
    ]) {
      expect(commercial).toContain(label);
    }
    expect(company).toContain('会社概要');
    expect(pricing).toContain('15日目に初回課金');
    expect(publicLayout).toContain('/legal/commercial-transactions');
    expect(publicLayout).toContain('/pricing');
    expect(publicLayout).toContain('/company');
    expect(notes).not.toContain('commercial-transactions');
    expect(notes).not.toContain('legal-fixture-notice');
  });
});

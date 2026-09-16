import { describe, expect, it } from 'vitest';
import {
  applyMarketingConsentEvent,
  decideMarketingDelivery,
  findMarketingConsentRecord,
  planMarketingConsentRetention,
  type MarketingConsentState,
} from '@/lib/domain/marketing-consent';

describe('marketing consent and record retention', () => {
  it('requires a separate explicit opt-in and blocks immediately after withdrawal', () => {
    const initial: MarketingConsentState = { kind: 'never-consented' };
    expect(decideMarketingDelivery(initial)).toEqual({
      kind: 'blocked',
      reason: 'explicit-marketing-consent-required',
    });

    const granted = applyMarketingConsentEvent(initial, {
      kind: 'grant-explicit-consent',
      occurredOn: '2026-09-15',
    });
    expect(granted.kind).toBe('applied');
    if (granted.kind !== 'applied') return;
    expect(decideMarketingDelivery(granted.state)).toEqual({ kind: 'allowed' });

    const sent = applyMarketingConsentEvent(granted.state, {
      kind: 'record-marketing-send',
      occurredOn: '2026-10-01',
    });
    expect(sent.kind).toBe('applied');
    if (sent.kind !== 'applied') return;

    const withdrawn = applyMarketingConsentEvent(sent.state, {
      kind: 'withdraw-consent',
      occurredOn: '2026-10-02',
    });
    expect(withdrawn.kind).toBe('applied');
    if (withdrawn.kind !== 'applied') return;
    expect(decideMarketingDelivery(withdrawn.state)).toEqual({
      kind: 'blocked',
      reason: 'explicit-marketing-consent-required',
    });
    expect(
      applyMarketingConsentEvent(withdrawn.state, {
        kind: 'record-marketing-send',
        occurredOn: '2026-10-03',
      }),
    ).toEqual({ kind: 'rejected', reason: 'marketing-consent-required' });
  });

  it('keeps the record for three years from the latest relevant event', () => {
    const state: MarketingConsentState = {
      kind: 'withdrawn',
      consentedOn: '2024-02-29',
      lastMarketingSentOn: '2026-10-01',
      withdrawnOn: '2026-10-02',
    };
    expect(planMarketingConsentRetention(state, '2029-10-02')).toEqual({
      kind: 'retain',
      retainThrough: '2029-10-02',
    });
    expect(planMarketingConsentRetention(state, '2029-10-03')).toEqual({
      kind: 'eligible-for-reviewed-deletion',
      retainThrough: '2029-10-02',
    });
    expect(
      planMarketingConsentRetention({ kind: 'never-consented' }, '2026-09-15'),
    ).toEqual({ kind: 'no-record' });
  });

  it('supports an opaque record lookup fixture without recipient data', () => {
    const record = {
      subjectReference: 'fixture-subject-a',
      state: {
        kind: 'consented',
        consentedOn: '2026-09-15',
        lastMarketingSentOn: null,
      },
    } as const;
    expect(findMarketingConsentRecord([record], 'fixture-subject-a')).toEqual(
      record,
    );
    expect(findMarketingConsentRecord([record], 'fixture-subject-b')).toBe(
      undefined,
    );
  });

  it('rejects invalid and out-of-order record events', () => {
    const state: MarketingConsentState = {
      kind: 'consented',
      consentedOn: '2026-09-15',
      lastMarketingSentOn: '2026-10-01',
    };
    expect(
      applyMarketingConsentEvent(state, {
        kind: 'withdraw-consent',
        occurredOn: '2026-09-30',
      }),
    ).toEqual({ kind: 'rejected', reason: 'event-before-current-state' });
    expect(
      applyMarketingConsentEvent(state, {
        kind: 'record-marketing-send',
        occurredOn: 'not-a-date',
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-event-date' });
  });
});

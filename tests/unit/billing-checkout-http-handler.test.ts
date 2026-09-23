import { describe, expect, it, vi } from 'vitest';
import {
  createContractCheckoutHandler,
  createContractOfferHandler,
  type ContractCheckoutHttpDependencies,
} from '@/app/api/billing/checkout/handler';
import {
  createSubscriptionCancellationHandler,
  type SubscriptionCancellationHttpDependencies,
} from '@/app/api/billing/cancel/handler';
import {
  parseSubscriptionCancellationIdempotencyKey,
  type PeriodEndSubscriptionCancellationPort,
} from '@/server/billing/public';
import type { ContractCheckoutApplication } from '@/server/legal-checkout/public';
import { fixtureActiveSession, cookieHeader } from '@/tests/fixtures/session';
import {
  contractCommand,
  contractEvidence,
  contractIds,
} from '@/tests/fixtures/legal-checkout';
import {
  containsSensitiveMarker,
  securityCorpusMarker,
} from '@/tests/fixtures/security-corpus';

const expectedOrigin = 'https://notes.example';
const cancellationKey =
  parseSubscriptionCancellationIdempotencyKey('cancel_contract_A');

describe('contract checkout HTTP handlers', () => {
  it('returns the authenticated authoritative offer without caching it', async () => {
    const response = await createContractOfferHandler(checkoutDependencies())(
      request('/api/billing/checkout', {
        method: 'GET',
        cookie: cookieHeader(),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    await expect(response.json()).resolves.toMatchObject({
      offer: { trialDays: 14, firstChargeDay: 15, priceYen: 1_280 },
      offerHash: contractIds.offerHashA,
    });
  });

  it('derives ownership, clock, and evidence ID outside the request body', async () => {
    const confirm = vi.fn(async () => ({
      kind: 'redirect' as const,
      evidenceOutcome: 'recorded' as const,
      evidence: contractEvidence(),
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_FukamuA',
    }));
    const response = await createContractCheckoutHandler(
      checkoutDependencies({ application: application({ confirm }) }),
    )(
      request('/api/billing/checkout', {
        method: 'POST',
        cookie: cookieHeader(),
        body: JSON.stringify(contractCommand()),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      kind: 'redirect',
      evidenceOutcome: 'recorded',
      evidenceId: contractIds.evidenceA,
      offerHash: contractIds.offerHashA,
      offerVersion: contractEvidence().offer.offerVersion,
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_FukamuA',
    });
    expect(confirm).toHaveBeenCalledWith({
      context: {
        accountId: fixtureActiveSession().accountId,
        vaultId: fixtureActiveSession().vaultId,
        sessionId: fixtureActiveSession().sessionId,
        sessionEpoch: fixtureActiveSession().sessionEpoch,
      },
      command: contractCommand(),
      evidenceId: contractIds.evidenceA,
      confirmedAt: 1_500,
    });
  });

  it('rejects anonymous, cross-site, oversized, and owner-injected requests before confirmation', async () => {
    const confirm = vi.fn();
    const handler = createContractCheckoutHandler(
      checkoutDependencies({ application: application({ confirm }) }),
    );
    expect(
      (
        await handler(
          request('/api/billing/checkout', {
            method: 'POST',
            body: JSON.stringify(contractCommand()),
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handler(
          request('/api/billing/checkout', {
            method: 'POST',
            body: JSON.stringify(contractCommand()),
            cookie: cookieHeader(),
            origin: 'https://attacker.example',
            site: 'cross-site',
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          request('/api/billing/checkout', {
            method: 'POST',
            body: JSON.stringify(contractCommand()),
            cookie: cookieHeader(),
            contentLength: '2049',
          }),
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await handler(
          request('/api/billing/checkout', {
            method: 'POST',
            body: JSON.stringify({
              ...contractCommand(),
              accountId: fixtureActiveSession().accountId,
            }),
            cookie: cookieHeader(),
          }),
        )
      ).status,
    ).toBe(400);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('returns stable consent, stale-offer, conflict, and dependency errors', async () => {
    for (const [reason, status, error] of [
      ['consent-required', 422, 'consent-required'],
      ['stale-offer', 409, 'offer-changed'],
      ['terms-changed', 409, 'terms-changed'],
      ['terms-consent-required', 422, 'terms-consent-required'],
      ['identifier-conflict', 409, 'request-conflict'],
      ['provider-mapping-mismatch', 503, 'unavailable'],
    ] as const) {
      const response = await createContractCheckoutHandler(
        checkoutDependencies({
          application: application({
            confirm: async () => ({ kind: 'rejected', reason }),
          }),
        }),
      )(
        request('/api/billing/checkout', {
          method: 'POST',
          body: JSON.stringify(contractCommand()),
          cookie: cookieHeader(),
        }),
      );
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error });
    }
  });

  it('logs only a fixed category when a secret-bearing dependency fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error(`provider:${securityCorpusMarker}`);
    const response = await createContractCheckoutHandler(
      checkoutDependencies({
        application: application({
          confirm: async () => {
            throw failure;
          },
        }),
      }),
    )(
      request('/api/billing/checkout', {
        method: 'POST',
        body: JSON.stringify(contractCommand()),
        cookie: cookieHeader(),
      }),
    );
    expect(response.status).toBe(503);
    expect(log).toHaveBeenCalledWith(
      'billing checkout request failed',
      'Error',
    );
    expect(
      containsSensitiveMarker(log.mock.calls, [securityCorpusMarker]),
    ).toBe(false);
  });
});

describe('subscription cancellation HTTP handler', () => {
  it('uses only session ownership and remains callable without an entitlement gate', async () => {
    const scheduleSubscriptionCancellation = vi.fn(async () => ({
      kind: 'confirmed' as const,
      outcome: 'scheduled' as const,
      confirmedAt: 1_600,
      accessEndsAt: 2_600,
    }));
    const response = await createSubscriptionCancellationHandler(
      cancellationDependencies({
        cancellation: { scheduleSubscriptionCancellation },
      }),
    )(
      request('/api/billing/cancel', {
        method: 'POST',
        body: JSON.stringify({ idempotencyKey: cancellationKey }),
        cookie: cookieHeader(),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      status: 'cancellation-scheduled',
      outcome: 'scheduled',
      confirmedAt: 1_600,
      accessEndsAt: 2_600,
    });
    expect(scheduleSubscriptionCancellation).toHaveBeenCalledWith({
      accountId: fixtureActiveSession().accountId,
      vaultId: fixtureActiveSession().vaultId,
      idempotencyKey: cancellationKey,
      requestedAt: 1_500,
    });
  });

  it('rejects cross-site and owner-injected cancellation before the port', async () => {
    const scheduleSubscriptionCancellation = vi.fn();
    const handler = createSubscriptionCancellationHandler(
      cancellationDependencies({
        cancellation: { scheduleSubscriptionCancellation },
      }),
    );
    expect(
      (
        await handler(
          request('/api/billing/cancel', {
            method: 'POST',
            body: JSON.stringify({ idempotencyKey: cancellationKey }),
            cookie: cookieHeader(),
            origin: 'https://attacker.example',
            site: 'cross-site',
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          request('/api/billing/cancel', {
            method: 'POST',
            body: JSON.stringify({
              idempotencyKey: cancellationKey,
              vaultId: fixtureActiveSession().vaultId,
            }),
            cookie: cookieHeader(),
          }),
        )
      ).status,
    ).toBe(400);
    expect(scheduleSubscriptionCancellation).not.toHaveBeenCalled();
  });

  it('distinguishes retryable, owner, and terminal cancellation results', async () => {
    for (const [result, status, error] of [
      [
        { kind: 'retryable-failure', reason: 'provider-unavailable' },
        503,
        'unavailable',
      ],
      [
        { kind: 'terminal-failure', reason: 'owner-mismatch' },
        403,
        'forbidden',
      ],
      [
        { kind: 'terminal-failure', reason: 'provider-terminal' },
        409,
        'cancellation-unavailable',
      ],
      [
        { kind: 'terminal-failure', reason: 'invalid-subscription-state' },
        409,
        'cancellation-unavailable',
      ],
    ] as const) {
      const response = await createSubscriptionCancellationHandler(
        cancellationDependencies({
          cancellation: {
            scheduleSubscriptionCancellation: async () => result,
          },
        }),
      )(
        request('/api/billing/cancel', {
          method: 'POST',
          body: JSON.stringify({ idempotencyKey: cancellationKey }),
          cookie: cookieHeader(),
        }),
      );
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error });
    }
  });
});

function checkoutDependencies(
  overrides: Partial<ContractCheckoutHttpDependencies> = {},
): ContractCheckoutHttpDependencies {
  return {
    expectedOrigin,
    clock: { now: () => 1_500 },
    ids: { createEvidenceId: () => contractIds.evidenceA },
    sessions: { findSessionByToken: async () => fixtureActiveSession() },
    application: application(),
    ...overrides,
  };
}

function application(
  overrides: Partial<ContractCheckoutApplication> = {},
): ContractCheckoutApplication {
  const evidence = contractEvidence();
  return {
    prepareOffer: async () => ({
      kind: 'available',
      prepared: {
        offer: evidence.offer,
        serializedOffer: evidence.serializedOffer,
        offerHash: evidence.offerHash,
      },
    }),
    confirm: async () => ({
      kind: 'redirect',
      evidenceOutcome: 'recorded',
      evidence,
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_FukamuA',
    }),
    ...overrides,
  };
}

function cancellationDependencies(
  overrides: Partial<SubscriptionCancellationHttpDependencies> = {},
): SubscriptionCancellationHttpDependencies {
  return {
    expectedOrigin,
    clock: { now: () => 1_500 },
    sessions: { findSessionByToken: async () => fixtureActiveSession() },
    cancellation: cancellationPort(),
    ...overrides,
  };
}

function cancellationPort(): PeriodEndSubscriptionCancellationPort {
  return {
    scheduleSubscriptionCancellation: async () => ({
      kind: 'confirmed',
      outcome: 'scheduled',
      confirmedAt: 1_600,
      accessEndsAt: 2_600,
    }),
  };
}

function request(
  pathname: string,
  input: {
    readonly method: 'GET' | 'POST';
    readonly body?: string;
    readonly cookie?: string;
    readonly origin?: string;
    readonly site?: string;
    readonly contentLength?: string;
  },
): Request {
  const headers = new Headers();
  if (input.method === 'POST') {
    headers.set('content-type', 'application/json');
    headers.set('origin', input.origin ?? expectedOrigin);
    headers.set('sec-fetch-site', input.site ?? 'same-origin');
  }
  if (input.cookie !== undefined) headers.set('cookie', input.cookie);
  if (input.contentLength !== undefined) {
    headers.set('content-length', input.contentLength);
  }
  return new Request(`${expectedOrigin}${pathname}`, {
    method: input.method,
    headers,
    ...(input.body === undefined ? {} : { body: input.body }),
  });
}

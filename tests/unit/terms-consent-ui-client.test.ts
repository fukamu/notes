import { describe, expect, it } from 'vitest';
import {
  createLocalTermsConsentUiTransport,
  createTermsConsentSubmissionId,
  createTermsConsentUiHttpTransport,
} from '@/lib/client/terms-consent-ui';
import { termsConsentIds } from '@/tests/fixtures/terms-consent';

describe('terms consent UI adapters', () => {
  it('decodes status and sends only the shared submission and presented terms', async () => {
    const calls: { readonly input: string; readonly init: RequestInit }[] = [];
    const transport = createTermsConsentUiHttpTransport(
      async (input, init = {}) => {
        calls.push({ input: requestLabel(input), init });
        return init.method === 'POST'
          ? Response.json(acceptedResponse('recorded'))
          : Response.json({ outcome: 'status', status: currentStatus() });
      },
    );

    await expect(transport.loadStatus()).resolves.toEqual({
      kind: 'available',
      status: currentStatus(),
    });
    await expect(
      transport.accept({
        current: current(),
        submissionId: termsConsentIds.submissionA,
      }),
    ).resolves.toMatchObject({ kind: 'accepted', outcome: 'recorded' });
    const requestBody = calls[1]?.init.body;
    if (typeof requestBody !== 'string') throw new Error('missing JSON body');
    expect(JSON.parse(requestBody)).toEqual({
      submissionId: termsConsentIds.submissionA,
      presentedTermsVersion: current().termsVersion,
      presentedTermsHash: current().termsHash,
      consent: { kind: 'affirmed' },
    });
    expect(requestBody).not.toMatch(/accountId|vaultId/);
    expect(calls[1]?.input).toBe('/api/account/terms-consent');
    expect(calls[1]?.init.credentials).toBe('same-origin');
    expect(calls[1]?.init.cache).toBe('no-store');
  });

  it('rejects malformed, mismatched, and stale responses', async () => {
    const malformed = createTermsConsentUiHttpTransport(async () =>
      Response.json({
        outcome: 'status',
        status: { ...currentStatus(), extra: true },
      }),
    );
    await expect(malformed.loadStatus()).resolves.toEqual({
      kind: 'unavailable',
    });

    const mismatched = createTermsConsentUiHttpTransport(async () =>
      Response.json({
        ...acceptedResponse('recorded'),
        status: {
          ...acceptedResponse('recorded').status,
          current: { ...current(), termsHash: `sha256:${'b'.repeat(64)}` },
        },
      }),
    );
    await expect(
      mismatched.accept({
        current: current(),
        submissionId: termsConsentIds.submissionA,
      }),
    ).resolves.toEqual({ kind: 'unavailable' });

    const mismatchedEvidence = createTermsConsentUiHttpTransport(async () =>
      Response.json({
        ...acceptedResponse('recorded'),
        status: {
          ...acceptedResponse('recorded').status,
          accepted: {
            ...acceptedResponse('recorded').status.accepted,
            termsHash: `sha256:${'b'.repeat(64)}`,
          },
        },
      }),
    );
    await expect(
      mismatchedEvidence.accept({
        current: current(),
        submissionId: termsConsentIds.submissionA,
      }),
    ).resolves.toEqual({ kind: 'unavailable' });

    const stale = createTermsConsentUiHttpTransport(async () =>
      Response.json({ error: 'terms-changed' }, { status: 409 }),
    );
    await expect(
      stale.accept({
        current: current(),
        submissionId: termsConsentIds.submissionA,
      }),
    ).resolves.toEqual({ kind: 'terms-changed' });
  });

  it('keeps explicit material and notice-only server classifications distinct', async () => {
    for (const [kind, acceptanceRequired] of [
      ['reconsent-required', true],
      ['notice-only', false],
    ] as const) {
      const transport = createTermsConsentUiHttpTransport(async () =>
        Response.json({
          outcome: 'status',
          status: {
            kind,
            acceptanceRequired,
            current: current(),
            accepted: acceptedResponse('recorded').status.accepted,
          },
        }),
      );
      await expect(transport.loadStatus()).resolves.toMatchObject({
        kind: 'available',
        status: { kind, acceptanceRequired, acceptedAt: 2_000 },
      });
    }
  });

  it('keeps the local fixture in memory and never calls an external provider', async () => {
    const local = createLocalTermsConsentUiTransport(current());
    await expect(local.loadStatus()).resolves.toMatchObject({
      kind: 'available',
      status: { kind: 'current', acceptanceRequired: true },
    });
    const input = {
      current: current(),
      submissionId: termsConsentIds.submissionA,
    };
    await expect(local.accept(input)).resolves.toMatchObject({
      kind: 'accepted',
      outcome: 'recorded',
    });
    await expect(local.accept(input)).resolves.toMatchObject({
      kind: 'accepted',
      outcome: 'replayed',
    });
    await expect(local.loadStatus()).resolves.toMatchObject({
      kind: 'available',
      status: { kind: 'accepted', acceptanceRequired: false },
    });
  });

  it('creates UUIDv7 submission identifiers at the client boundary', () => {
    expect(createTermsConsentSubmissionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

function current() {
  return {
    termsVersion: 'terms-v1:2026-09-15',
    termsHash: termsConsentIds.hashA,
    effectiveDate: '2026-09-15',
  };
}

function currentStatus() {
  return {
    kind: 'current',
    acceptanceRequired: true,
    current: current(),
  } as const;
}

function acceptedResponse(outcome: 'recorded' | 'replayed') {
  return {
    outcome,
    status: {
      kind: 'accepted',
      acceptanceRequired: false,
      current: current(),
      accepted: {
        consentId: termsConsentIds.consentA,
        termsVersion: current().termsVersion,
        termsHash: current().termsHash,
        acceptedAt: 2_000,
      },
    },
  } as const;
}

function requestLabel(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

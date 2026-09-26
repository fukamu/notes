import { describe, expect, it } from 'vitest';
import {
  createPrivacyRequestSubmissionId,
  createPrivacyRequestUiHttpTransport,
} from '@/lib/client/http-privacy-request';
import { privacyRequestIds } from '@/tests/fixtures/privacy-request';

describe('privacy request UI HTTP adapter', () => {
  it('sends only request correlation fields and decodes public status', async () => {
    const calls: { readonly input: string; readonly init: RequestInit }[] = [];
    const transport = createPrivacyRequestUiHttpTransport(
      async (input, init = {}) => {
        calls.push({ input: requestLabel(input), init });
        return Response.json(publicStatus());
      },
    );
    await expect(
      transport.submit({
        submissionId: privacyRequestIds.submissionA,
        requestKind: 'disclosure',
      }),
    ).resolves.toMatchObject({
      kind: 'accepted',
      request: { status: 'verification-pending' },
    });
    await expect(
      transport.status({ requestId: privacyRequestIds.requestA }),
    ).resolves.toMatchObject({ kind: 'accepted' });

    expect(requestBody(calls[0]?.init)).toEqual({
      submissionId: privacyRequestIds.submissionA,
      requestKind: 'disclosure',
    });
    expect(requestBody(calls[1]?.init)).toEqual({
      requestId: privacyRequestIds.requestA,
    });
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
    });
    expect(JSON.stringify(calls)).not.toMatch(/accountId|vaultId/);
  });

  it('rejects malformed, uncorrelated, failed, and redirected responses', async () => {
    const malformed = createPrivacyRequestUiHttpTransport(async () =>
      Response.json({ ...publicStatus(), secret: 'must-not-pass' }),
    );
    await expect(
      malformed.submit({
        submissionId: privacyRequestIds.submissionA,
        requestKind: 'disclosure',
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'unavailable' });

    const mismatch = createPrivacyRequestUiHttpTransport(async () =>
      Response.json({
        ...publicStatus(),
        requestId: privacyRequestIds.requestB,
      }),
    );
    await expect(
      mismatch.status({ requestId: privacyRequestIds.requestA }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'unavailable' });

    const unavailable = createPrivacyRequestUiHttpTransport(async () =>
      Response.json({ error: 'unavailable' }, { status: 503 }),
    );
    await expect(
      unavailable.submit({
        submissionId: privacyRequestIds.submissionA,
        requestKind: 'disclosure',
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'unavailable' });

    const failed = createPrivacyRequestUiHttpTransport(async () => {
      throw new Error('redirect or network failure');
    });
    await expect(
      failed.status({ requestId: privacyRequestIds.requestA }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'unavailable' });
  });

  it('maps only matching authenticated errors and creates UUIDv7 submissions', async () => {
    const unauthenticated = createPrivacyRequestUiHttpTransport(async () =>
      Response.json({ error: 'authentication-required' }, { status: 401 }),
    );
    await expect(
      unauthenticated.status({ requestId: privacyRequestIds.requestA }),
    ).resolves.toEqual({
      kind: 'rejected',
      reason: 'authentication-required',
    });
    expect(createPrivacyRequestSubmissionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('treats submit route closure separately from an absent status record', async () => {
    const notFound = createPrivacyRequestUiHttpTransport(async () =>
      Response.json({ error: 'not-found' }, { status: 404 }),
    );
    await expect(
      notFound.submit({
        submissionId: privacyRequestIds.submissionA,
        requestKind: 'disclosure',
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'unavailable' });
    await expect(
      notFound.status({ requestId: privacyRequestIds.requestA }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'not-found' });
  });

  it('rejects impossible timestamps and completion outcomes', async () => {
    for (const candidate of [
      { ...publicStatus(), updatedAt: 999 },
      {
        ...publicStatus(),
        status: 'completed',
        outcome: 'account-deletion-started',
      },
      {
        ...publicStatus(),
        requestKind: 'deletion',
        status: 'completed',
        outcome: 'fulfilled',
      },
    ]) {
      const transport = createPrivacyRequestUiHttpTransport(async () =>
        Response.json(candidate),
      );
      await expect(
        transport.status({ requestId: privacyRequestIds.requestA }),
      ).resolves.toEqual({ kind: 'rejected', reason: 'unavailable' });
    }
  });

  it('accepts both correlated completed response variants', async () => {
    for (const candidate of [
      {
        ...publicStatus(),
        status: 'completed',
        outcome: 'fulfilled',
      },
      {
        ...publicStatus(),
        requestKind: 'deletion',
        status: 'completed',
        outcome: 'account-deletion-started',
      },
    ]) {
      const transport = createPrivacyRequestUiHttpTransport(async () =>
        Response.json(candidate),
      );
      await expect(
        transport.status({ requestId: privacyRequestIds.requestA }),
      ).resolves.toEqual({ kind: 'accepted', request: candidate });
    }
  });
});

function publicStatus() {
  return {
    requestId: privacyRequestIds.requestA,
    requestKind: 'disclosure',
    requestedAt: 1_000,
    updatedAt: 1_000,
    status: 'verification-pending',
  };
}

function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('missing request body');
  const value: unknown = JSON.parse(init.body);
  return value;
}

function requestLabel(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

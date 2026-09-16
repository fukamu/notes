import { describe, expect, it } from 'vitest';
import { createLocalPrivacyRequestUiTransport } from '@/lib/client/local-privacy-request';
import { privacyRequestIds } from '@/tests/fixtures/privacy-request';

describe('local privacy request UI adapter', () => {
  it('is idempotent in memory and never advances deletion beyond verification', async () => {
    const transport = createLocalPrivacyRequestUiTransport(() => 1_000);
    const command = {
      submissionId: privacyRequestIds.submissionA,
      requestKind: 'deletion' as const,
    };
    const first = await transport.submit(command);
    const replay = await transport.submit(command);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      kind: 'accepted',
      request: { requestKind: 'deletion', status: 'verification-pending' },
    });
    if (first.kind !== 'accepted') throw new Error('sample request failed');
    await expect(
      transport.status({ requestId: first.request.requestId }),
    ).resolves.toEqual(first);
    await expect(
      transport.submit({ ...command, requestKind: 'correction' }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'request-conflict' });
  });

  it('does not restore a request in a new in-memory adapter', async () => {
    const first = createLocalPrivacyRequestUiTransport(() => 1_000);
    const submitted = await first.submit({
      submissionId: privacyRequestIds.submissionA,
      requestKind: 'disclosure',
    });
    if (submitted.kind !== 'accepted') throw new Error('sample request failed');
    const reloaded = createLocalPrivacyRequestUiTransport(() => 2_000);
    await expect(
      reloaded.status({ requestId: submitted.request.requestId }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'not-found' });
  });
});

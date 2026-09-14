import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1IdentityVaultControlPlane } from '@/server/control-plane/d1-adapter';
import { productionMigrationManifest } from '@/server/migrations/production';
import {
  createPrivacyRequestApplication,
  type PrivacyRequestApplicationDependencies,
} from '@/server/privacy-request/application';
import { D1PrivacyRequestRepository } from '@/server/privacy-request/d1-adapter';
import {
  FakePrivacyRequestDeletionHandoff,
  FakePrivacyRequestExecution,
  FakePrivacyRequestVerification,
} from '@/server/privacy-request/fake';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import { billingContext } from '@/tests/fixtures/billing';
import { personalAccountProvision } from '@/tests/fixtures/control-plane';
import { privacyRequestIds } from '@/tests/fixtures/privacy-request';

let miniflare: Miniflare;
let repository: D1PrivacyRequestRepository;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['PRIVACY_REQUEST_APPLICATION'],
  });
  const database = await miniflare.getD1Database('PRIVACY_REQUEST_APPLICATION');
  await runD1Migrations({
    database,
    manifest: productionMigrationManifest,
    appliedAt: 900,
  });
  const controlPlane = new D1IdentityVaultControlPlane(database);
  await controlPlane.provisionPersonalAccount(personalAccountProvision('a'));
  await controlPlane.provisionPersonalAccount(personalAccountProvision('b'));
  repository = new D1PrivacyRequestRepository(database);
});

afterAll(async () => {
  await miniflare.dispose();
});

describe('privacy request application', () => {
  it('submits idempotently, hides cross-tenant status, and waits for verification', async () => {
    const ports = fakes();
    const application = createPrivacyRequestApplication({
      repository,
      ...ports.dependencies,
    });
    const submitted = await application.submit({
      scope: billingContext(),
      command: {
        submissionId: privacyRequestIds.submissionA,
        requestKind: 'disclosure',
      },
      requestId: privacyRequestIds.requestA,
      requestedAt: 1_000,
    });
    expect(submitted).toMatchObject({
      kind: 'accepted',
      outcome: 'recorded',
      request: { status: 'verification-pending' },
    });
    expect(
      await application.submit({
        scope: billingContext(),
        command: {
          submissionId: privacyRequestIds.submissionA,
          requestKind: 'disclosure',
        },
        requestId: privacyRequestIds.requestB,
        requestedAt: 1_001,
      }),
    ).toMatchObject({
      kind: 'accepted',
      outcome: 'replayed',
      request: { requestId: privacyRequestIds.requestA },
    });
    expect(
      await application.submit({
        scope: billingContext(),
        command: {
          submissionId: privacyRequestIds.submissionA,
          requestKind: 'correction',
        },
        requestId: privacyRequestIds.requestB,
        requestedAt: 1_002,
      }),
    ).toEqual({ kind: 'rejected', reason: 'identifier-conflict' });
    expect(
      await application.status({
        scope: billingContext('b'),
        requestId: privacyRequestIds.requestA,
      }),
    ).toEqual({ kind: 'rejected', reason: 'not-found' });

    expect(
      await application.process({
        scope: billingContext(),
        requestId: privacyRequestIds.requestA,
        startedAt: 1_100,
        finishedAt: 1_200,
      }),
    ).toMatchObject({
      kind: 'accepted',
      request: { status: 'verification-pending' },
    });
    expect(ports.execution.calls).toHaveLength(0);
    expect(ports.accountDeletion.calls).toHaveLength(0);
  });

  it('executes a verified non-delete request once and records completion', async () => {
    const ports = fakes();
    const application = createPrivacyRequestApplication({
      repository,
      ...ports.dependencies,
    });
    expect(
      await application.verify({
        scope: billingContext(),
        requestId: privacyRequestIds.requestA,
        checkedAt: 1_100,
      }),
    ).toMatchObject({
      kind: 'accepted',
      request: { status: 'ready' },
    });
    expect(ports.verification.calls).toHaveLength(1);
    expect(
      await application.process({
        scope: billingContext(),
        requestId: privacyRequestIds.requestA,
        startedAt: 1_200,
        finishedAt: 1_300,
      }),
    ).toMatchObject({
      kind: 'accepted',
      request: { status: 'completed', outcome: 'fulfilled' },
    });
    expect(ports.execution.calls).toEqual([
      {
        scope: {
          accountId: billingContext().accountId,
          vaultId: billingContext().vaultId,
        },
        requestId: privacyRequestIds.requestA,
        requestKind: 'disclosure',
      },
    ]);
    expect(ports.accountDeletion.calls).toHaveLength(0);
    await application.process({
      scope: billingContext(),
      requestId: privacyRequestIds.requestA,
      startedAt: 1_400,
      finishedAt: 1_500,
    });
    expect(ports.execution.calls).toHaveLength(1);
  });

  it('routes deletion only to the existing account deletion saga handoff', async () => {
    const ports = fakes({ verificationReceipt: 'b' });
    const application = createPrivacyRequestApplication({
      repository,
      ...ports.dependencies,
    });
    await application.submit({
      scope: billingContext(),
      command: {
        submissionId: privacyRequestIds.submissionB,
        requestKind: 'deletion',
      },
      requestId: privacyRequestIds.requestB,
      requestedAt: 2_000,
    });
    await application.verify({
      scope: billingContext(),
      requestId: privacyRequestIds.requestB,
      checkedAt: 2_100,
    });
    expect(
      await application.process({
        scope: billingContext(),
        requestId: privacyRequestIds.requestB,
        startedAt: 2_200,
        finishedAt: 2_300,
      }),
    ).toMatchObject({
      kind: 'accepted',
      request: {
        status: 'completed',
        outcome: 'account-deletion-started',
      },
    });
    expect(ports.execution.calls).toHaveLength(0);
    expect(ports.accountDeletion.calls).toEqual([
      {
        scope: {
          accountId: billingContext().accountId,
          vaultId: billingContext().vaultId,
        },
        privacyRequestId: privacyRequestIds.requestB,
      },
    ]);
  });

  it('records a retryable failure instead of a false completion', async () => {
    const ports = fakes();
    const dependencies: PrivacyRequestApplicationDependencies = {
      repository,
      verification: ports.verification,
      accountDeletion: ports.accountDeletion,
      execution: {
        async execute() {
          throw new Error('injected executor outage');
        },
      },
    };
    const application = createPrivacyRequestApplication(dependencies);
    await application.submit({
      scope: billingContext(),
      command: {
        submissionId: privacyRequestIds.submissionC,
        requestKind: 'correction',
      },
      requestId: privacyRequestIds.requestC,
      requestedAt: 3_000,
    });
    await application.verify({
      scope: billingContext(),
      requestId: privacyRequestIds.requestC,
      checkedAt: 3_100,
    });
    expect(
      await application.process({
        scope: billingContext(),
        requestId: privacyRequestIds.requestC,
        startedAt: 3_200,
        finishedAt: 3_300,
      }),
    ).toMatchObject({
      kind: 'accepted',
      request: { status: 'failed', retryable: true },
    });
    expect(
      await application.status({
        scope: billingContext(),
        requestId: privacyRequestIds.requestC,
      }),
    ).toMatchObject({
      kind: 'accepted',
      request: { status: 'failed', retryable: true },
    });
  });

  it('keeps unavailable verification pending and persists an explicit rejection', async () => {
    const ports = fakes();
    ports.verification.setResult({ kind: 'unavailable' });
    const application = createPrivacyRequestApplication({
      repository,
      ...ports.dependencies,
    });
    await application.submit({
      scope: billingContext(),
      command: {
        submissionId: privacyRequestIds.submissionD,
        requestKind: 'purpose-notification',
      },
      requestId: privacyRequestIds.requestD,
      requestedAt: 4_000,
    });
    expect(
      await application.verify({
        scope: billingContext(),
        requestId: privacyRequestIds.requestD,
        checkedAt: 4_100,
      }),
    ).toEqual({ kind: 'rejected', reason: 'unavailable' });
    expect(
      await application.status({
        scope: billingContext(),
        requestId: privacyRequestIds.requestD,
      }),
    ).toMatchObject({
      kind: 'accepted',
      request: { status: 'verification-pending' },
    });

    ports.verification.setResult({
      kind: 'rejected',
      reason: 'identity-not-verified',
    });
    expect(
      await application.verify({
        scope: billingContext(),
        requestId: privacyRequestIds.requestD,
        checkedAt: 4_200,
      }),
    ).toMatchObject({
      kind: 'accepted',
      request: { status: 'rejected' },
    });
    expect(ports.execution.calls).toHaveLength(0);
    expect(ports.accountDeletion.calls).toHaveLength(0);
  });
});

function fakes(input: { readonly verificationReceipt?: 'a' | 'b' } = {}) {
  const verification = new FakePrivacyRequestVerification({
    kind: 'approved',
    receiptId:
      input.verificationReceipt === 'b'
        ? privacyRequestIds.verificationB
        : privacyRequestIds.verificationA,
  });
  const execution = new FakePrivacyRequestExecution({ kind: 'fulfilled' });
  const accountDeletion = new FakePrivacyRequestDeletionHandoff({
    kind: 'started',
  });
  return {
    verification,
    execution,
    accountDeletion,
    dependencies: { verification, execution, accountDeletion },
  };
}

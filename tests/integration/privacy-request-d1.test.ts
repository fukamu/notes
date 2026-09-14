import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoundaryDecodeError } from '@/lib/codec/core';
import { D1IdentityVaultControlPlane } from '@/server/control-plane/d1-adapter';
import { productionMigrationManifest } from '@/server/migrations/production';
import {
  planPrivacyRequestCompletion,
  planPrivacyRequestFailure,
  planPrivacyRequestProcessingStart,
  planPrivacyRequestRetry,
  planPrivacyRequestVerification,
} from '@/server/privacy-request/core';
import { D1PrivacyRequestRepository } from '@/server/privacy-request/d1-adapter';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import { billingContext } from '@/tests/fixtures/billing';
import { personalAccountProvision } from '@/tests/fixtures/control-plane';
import {
  privacyRequestIds,
  privacyRequestRecord,
} from '@/tests/fixtures/privacy-request';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

let miniflare: Miniflare;
let database: TestDatabase;
let repository: D1PrivacyRequestRepository;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['PRIVACY_REQUESTS'],
  });
  database = await miniflare.getD1Database('PRIVACY_REQUESTS');
  expect(
    await runD1Migrations({
      database,
      manifest: productionMigrationManifest,
      appliedAt: 1_000,
    }),
  ).toMatchObject({ kind: 'applied' });
  const controlPlane = new D1IdentityVaultControlPlane(database);
  await controlPlane.provisionPersonalAccount(personalAccountProvision('a'));
  await controlPlane.provisionPersonalAccount(personalAccountProvision('b'));
  repository = new D1PrivacyRequestRepository(database);
});

afterAll(async () => {
  await miniflare.dispose();
});

describe('D1 privacy request repository', () => {
  it('creates idempotently and isolates the same identifiers between Vaults', async () => {
    const ownerA = privacyRequestRecord();
    expect(await repository.create(ownerA)).toEqual({
      kind: 'created',
      record: ownerA,
    });

    const retriedWithNewRequestId = privacyRequestRecord({
      requestId: privacyRequestIds.requestB,
    });
    expect(await repository.create(retriedWithNewRequestId)).toEqual({
      kind: 'existing',
      record: ownerA,
    });
    expect(
      await repository.create(
        privacyRequestRecord({
          requestId: privacyRequestIds.requestB,
          requestKind: 'correction',
        }),
      ),
    ).toEqual({ kind: 'conflict' });

    const ownerB = privacyRequestRecord({ owner: 'b' });
    expect(await repository.create(ownerB)).toEqual({
      kind: 'created',
      record: ownerB,
    });
    expect(
      await repository.findById(billingContext(), privacyRequestIds.requestA),
    ).toEqual(ownerA);
    expect(
      await repository.findById(
        billingContext('b'),
        privacyRequestIds.requestA,
      ),
    ).toEqual(ownerB);
    expect(
      await repository.findById(
        billingContext('b'),
        privacyRequestIds.requestB,
      ),
    ).toBeUndefined();
  });

  it('applies and replays CAS transitions without accepting a stale branch', async () => {
    const pending = await repository.findById(
      billingContext(),
      privacyRequestIds.requestA,
    );
    if (pending === undefined) throw new Error('missing request');
    const verified = planPrivacyRequestVerification({
      record: pending,
      decision: {
        kind: 'approved',
        receiptId: privacyRequestIds.verificationA,
        decidedAt: 1_100,
      },
    });
    if (verified.kind !== 'accepted') throw new Error('verification failed');
    expect(
      await repository.commit(billingContext(), verified.transition),
    ).toMatchObject({ kind: 'applied', record: { state: { kind: 'ready' } } });
    expect(
      await repository.commit(billingContext(), verified.transition),
    ).toMatchObject({ kind: 'replayed', record: { state: { kind: 'ready' } } });

    const staleAlternative = planPrivacyRequestVerification({
      record: pending,
      decision: {
        kind: 'rejected',
        reason: 'identity-not-verified',
        decidedAt: 1_100,
      },
    });
    if (staleAlternative.kind !== 'accepted') {
      throw new Error('stale transition fixture failed');
    }
    expect(
      await repository.commit(billingContext(), staleAlternative.transition),
    ).toMatchObject({
      kind: 'conflict',
      current: { state: { kind: 'ready' } },
    });

    const processing = planPrivacyRequestProcessingStart({
      record: verified.transition.next,
      startedAt: 1_200,
    });
    if (processing.kind !== 'accepted') throw new Error('start failed');
    expect(
      await repository.commit(billingContext('b'), processing.transition),
    ).toEqual({ kind: 'rejected', reason: 'invalid-transition' });
    expect(
      await repository.commit(billingContext(), processing.transition),
    ).toMatchObject({
      kind: 'applied',
      record: { state: { kind: 'processing' } },
    });

    const failed = planPrivacyRequestFailure({
      record: processing.transition.next,
      failedAt: 1_300,
      failureCode: privacyRequestIds.failureA,
      retryable: true,
    });
    if (failed.kind !== 'accepted') throw new Error('failure failed');
    expect(
      await repository.commit(billingContext(), failed.transition),
    ).toMatchObject({
      kind: 'applied',
      record: { state: { kind: 'failed', retryable: true } },
    });
    const retried = planPrivacyRequestRetry({
      record: failed.transition.next,
      retriedAt: 1_400,
    });
    if (retried.kind !== 'accepted') throw new Error('retry failed');
    expect(
      await repository.commit(billingContext(), retried.transition),
    ).toMatchObject({ kind: 'applied', record: { state: { kind: 'ready' } } });
    const restarted = planPrivacyRequestProcessingStart({
      record: retried.transition.next,
      startedAt: 1_500,
    });
    if (restarted.kind !== 'accepted') throw new Error('restart failed');
    expect(
      await repository.commit(billingContext(), restarted.transition),
    ).toMatchObject({
      kind: 'applied',
      record: { state: { kind: 'processing' } },
    });
    const completed = planPrivacyRequestCompletion({
      record: restarted.transition.next,
      completedAt: 1_600,
      outcome: 'fulfilled',
    });
    if (completed.kind !== 'accepted') throw new Error('completion failed');
    expect(
      await repository.commit(billingContext(), completed.transition),
    ).toMatchObject({
      kind: 'applied',
      record: { state: { kind: 'completed', outcome: 'fulfilled' } },
    });
  });

  it('decodes rows from unknown and fails closed on an inconsistent state', async () => {
    const record = privacyRequestRecord({
      requestId: privacyRequestIds.requestC,
      submissionId: privacyRequestIds.submissionC,
    });
    expect(await repository.create(record)).toMatchObject({ kind: 'created' });
    await database.prepare('PRAGMA ignore_check_constraints = ON').run();
    await database
      .prepare(
        `UPDATE privacy_requests SET state = 'completed'
         WHERE account_id = ? AND vault_id = ? AND request_id = ?`,
      )
      .bind(record.accountId, record.vaultId, record.requestId)
      .run();
    await database.prepare('PRAGMA ignore_check_constraints = OFF').run();
    await expect(
      repository.findById(billingContext(), privacyRequestIds.requestC),
    ).rejects.toBeInstanceOf(BoundaryDecodeError);
  });
});

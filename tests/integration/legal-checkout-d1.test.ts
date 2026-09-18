import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoundaryDecodeError } from '@/lib/codec/core';
import { D1IdentityVaultControlPlane } from '@/server/control-plane/d1-adapter';
import { D1ContractEvidenceRepository } from '@/server/legal-checkout/d1-adapter';
import { createContractEvidenceService } from '@/server/legal-checkout/service';
import { createWebCryptoContractOfferHasher } from '@/server/legal-checkout/web-crypto-hash';
import { productionMigrationManifest } from '@/server/migrations/production';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import { billingContext } from '@/tests/fixtures/billing';
import { personalAccountProvision } from '@/tests/fixtures/control-plane';
import {
  contractCommand,
  contractDisclosure,
  contractEvidence,
  contractIds,
} from '@/tests/fixtures/legal-checkout';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

let miniflare: Miniflare;
let database: TestDatabase;
let repository: D1ContractEvidenceRepository;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['CONTRACTS'],
  });
  database = await miniflare.getD1Database('CONTRACTS');
  expect(
    await runD1Migrations({
      database,
      manifest: productionMigrationManifest,
      appliedAt: 1_000,
    }),
  ).toMatchObject({ kind: 'applied' });
  await database.prepare('PRAGMA foreign_keys = ON').run();
  const controlPlane = new D1IdentityVaultControlPlane(database);
  await controlPlane.provisionPersonalAccount(personalAccountProvision('a'));
  await controlPlane.provisionPersonalAccount(personalAccountProvision('b'));
  repository = new D1ContractEvidenceRepository(database);
});

afterAll(async () => {
  await miniflare.dispose();
});

describe('D1 contract evidence repository', () => {
  it('records, replays, and isolates the same identifiers between Vaults', async () => {
    const service = createContractEvidenceService({
      repository,
      hasher: createWebCryptoContractOfferHasher(globalThis.crypto.subtle),
    });
    const prepared = await service.prepareOffer(contractDisclosure());
    if (prepared.kind !== 'available') throw new Error('missing offer fixture');
    const command = contractCommand({
      presentedOfferHash: prepared.prepared.offerHash,
    });
    const input = {
      disclosure: contractDisclosure(),
      command,
      evidenceId: contractIds.evidenceA,
      confirmedAt: 2_000,
    } as const;
    expect(
      await service.confirm({ ...input, context: billingContext() }),
    ).toMatchObject({ kind: 'accepted', outcome: 'recorded' });
    expect(
      await service.confirm({ ...input, context: billingContext() }),
    ).toMatchObject({ kind: 'accepted', outcome: 'replayed' });
    expect(
      await service.confirm({ ...input, context: billingContext('b') }),
    ).toMatchObject({ kind: 'accepted', outcome: 'recorded' });

    const [ownerA, ownerB] = await Promise.all([
      repository.findBySubmission(billingContext(), contractIds.submissionA),
      repository.findBySubmission(billingContext('b'), contractIds.submissionA),
    ]);
    expect(ownerA?.scope).toEqual({
      accountId: billingContext().accountId,
      vaultId: billingContext().vaultId,
    });
    expect(ownerB?.scope).toEqual({
      accountId: billingContext('b').accountId,
      vaultId: billingContext('b').vaultId,
    });
  });

  it('rejects an evidence identifier collision and database updates', async () => {
    expect(
      await repository.append(
        contractEvidence({
          submissionId: contractIds.submissionB,
          confirmedAt: 2_100,
        }),
      ),
    ).toEqual({ kind: 'conflict' });
    await expect(
      database
        .prepare(
          `UPDATE contract_evidence SET confirmed_at = confirmed_at + 1
           WHERE account_id = ? AND vault_id = ?`,
        )
        .bind(billingContext().accountId, billingContext().vaultId)
        .run(),
    ).rejects.toThrow(/immutable/);
  });

  it('decodes stored values from unknown and fails closed on malformed JSON', async () => {
    await database.prepare('PRAGMA ignore_check_constraints = ON').run();
    await database
      .prepare(
        `INSERT INTO contract_evidence(
          account_id, vault_id, evidence_id, submission_id, offer_hash,
          offer_version, disclosure_version, serialized_offer, consent,
          confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'affirmed', ?)`,
      )
      .bind(
        billingContext('b').accountId,
        billingContext('b').vaultId,
        contractIds.evidenceB,
        contractIds.submissionB,
        contractIds.offerHashA,
        'legal-commerce-v1:2026-09-14',
        '2026-09-14',
        'not-json',
        2_200,
      )
      .run();
    await database.prepare('PRAGMA ignore_check_constraints = OFF').run();
    await expect(
      repository.findBySubmission(billingContext('b'), contractIds.submissionB),
    ).rejects.toBeInstanceOf(BoundaryDecodeError);
  });

  it('removes live contract evidence when its personal Vault is deleted', async () => {
    await database
      .prepare(
        'DELETE FROM personal_vaults WHERE account_id = ? AND vault_id = ?',
      )
      .bind(billingContext().accountId, billingContext().vaultId)
      .run();
    expect(
      await repository.findBySubmission(
        billingContext(),
        contractIds.submissionA,
      ),
    ).toBeUndefined();
  });
});

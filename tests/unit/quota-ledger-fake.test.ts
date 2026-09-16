import { describe, expect, it } from 'vitest';
import { paidPersonalVaultLimits } from '@/server/entitlement/public';
import { FakeVaultQuotaLedgerDirectory } from '@/server/quota/fake';
import {
  parseQuotaByteCount,
  type VaultQuotaLedger,
  type VaultQuotaReservationCommand,
} from '@/server/quota/public';
import {
  controlPlaneContext,
  controlPlaneIds,
} from '@/tests/fixtures/control-plane';
import { quotaIds } from '@/tests/fixtures/quota';

describe('Fake Vault quota ledger', () => {
  it('reserves, replays, reconciles, commits, and never expires implicitly', async () => {
    const directory = new FakeVaultQuotaLedgerDirectory([
      controlPlaneContext(),
    ]);
    const ledger = await open(directory, controlPlaneContext());
    const command = createCommand();

    expect(await ledger.reserve(command)).toMatchObject({
      kind: 'reserved',
      snapshot: {
        committed: { activeCards: 0, plaintextBytes: 0 },
        reserved: { activeCards: 1, plaintextBytes: 100 },
        effective: { activeCards: 1, plaintextBytes: 100 },
      },
    });
    expect(await ledger.reserve(command)).toMatchObject({ kind: 'replayed' });
    expect(
      await ledger.listReconciliationCandidates({ now: 2_999, limit: 10 }),
    ).toEqual([]);
    expect(
      await ledger.listReconciliationCandidates({ now: 99_999, limit: 10 }),
    ).toHaveLength(1);
    expect(await ledger.snapshot()).toMatchObject({
      reserved: { activeCards: 1, plaintextBytes: 100 },
    });

    const committed = await ledger.finalize({
      reservationId: command.reservationId,
      fingerprint: command.fingerprint,
      outcome: 'commit',
      limits: command.limits,
      finalizedAt: 4_000,
    });
    expect(committed).toMatchObject({
      kind: 'committed',
      snapshot: {
        revision: 2,
        committed: { activeCards: 1, plaintextBytes: 100 },
        reserved: { activeCards: 0, plaintextBytes: 0 },
      },
    });
  });

  it('isolates identical identifiers by authenticated Account/Vault scope', async () => {
    const contextA = controlPlaneContext();
    const contextB = {
      ...contextA,
      accountId: controlPlaneIds.accountB,
      vaultId: controlPlaneIds.vaultB,
    };
    const directory = new FakeVaultQuotaLedgerDirectory([contextA, contextB]);
    const [ledgerA, ledgerB] = await Promise.all([
      open(directory, contextA),
      open(directory, contextB),
    ]);
    await Promise.all([
      ledgerA.reserve(createCommand()),
      ledgerB.reserve(createCommand()),
    ]);

    expect(directory.inspect()).toMatchObject({
      snapshots: [
        { accountId: contextA.accountId, vaultId: contextA.vaultId },
        { accountId: contextB.accountId, vaultId: contextB.vaultId },
      ],
      reservations: [
        { accountId: contextA.accountId, vaultId: contextA.vaultId },
        { accountId: contextB.accountId, vaultId: contextB.vaultId },
      ],
    });
  });

  it('rejects an owner that was not provisioned', async () => {
    const directory = new FakeVaultQuotaLedgerDirectory([]);
    expect(await directory.open(controlPlaneContext(), 1_000)).toEqual({
      kind: 'owner-mismatch',
    });
  });
});

async function open(
  directory: FakeVaultQuotaLedgerDirectory,
  context: ReturnType<typeof controlPlaneContext>,
): Promise<VaultQuotaLedger> {
  const result = await directory.open(context, 1_000);
  if (result.kind !== 'opened') throw new Error('quota ledger did not open');
  return result.ledger;
}

function createCommand(): VaultQuotaReservationCommand {
  return {
    reservationId: quotaIds.reservationA,
    fingerprint: quotaIds.fingerprintA,
    cardId: quotaIds.cardA,
    change: {
      kind: 'create',
      nextPlaintextBytes: parseQuotaByteCount(100),
    },
    limits: paidPersonalVaultLimits,
    requestedAt: 2_000,
    reconcileAfter: 3_000,
  };
}

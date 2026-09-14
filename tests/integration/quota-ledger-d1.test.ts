import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { VaultContext } from '@/lib/domain/identity';
import type { CardId, MutationId } from '@/lib/domain/id';
import { identityVaultControlPlaneMigration } from '@/server/control-plane/migration';
import { paidPersonalVaultLimits } from '@/server/entitlement/public';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import { D1VaultQuotaLedgerDirectory } from '@/server/quota/d1-adapter';
import { vaultQuotaLedgerMigration } from '@/server/quota/migration';
import {
  parseQuotaByteCount,
  type VaultQuotaFingerprint,
  type VaultQuotaLedger,
  type VaultQuotaReservationCommand,
} from '@/server/quota/public';
import {
  controlPlaneContext,
  controlPlaneIds,
} from '@/tests/fixtures/control-plane';
import { quotaIds } from '@/tests/fixtures/quota';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

const migrationManifest = [
  identityVaultControlPlaneMigration,
  vaultQuotaLedgerMigration,
] as const;

let miniflare: Miniflare;
let database: TestDatabase;

beforeAll(async () => {
  miniflare = createMiniflare('QUOTA');
  database = await miniflare.getD1Database('QUOTA');
  await runD1Migrations({
    database,
    manifest: migrationManifest,
    appliedAt: 1_000,
  });
  await database.prepare('PRAGMA foreign_keys = ON').run();
});

beforeEach(async () => {
  await database.prepare('DELETE FROM accounts').run();
  await seedOwners(database);
});

afterAll(async () => {
  await miniflare.dispose();
});

describe('D1 Vault quota ledger', () => {
  it('opens only the authenticated owner scope and initializes empty usage once', async () => {
    const directory = new D1VaultQuotaLedgerDirectory(database);
    const ledger = await open(directory, contextA());
    expect(await ledger.snapshot()).toMatchObject({
      accountId: controlPlaneIds.accountA,
      vaultId: controlPlaneIds.vaultA,
      revision: 1,
      committed: { activeCards: 0, plaintextBytes: 0 },
      reserved: { activeCards: 0, plaintextBytes: 0 },
      effective: { activeCards: 0, plaintextBytes: 0 },
    });
    expect(await open(directory, contextA())).not.toBe(ledger);
    expect(
      await directory.open(
        {
          ...contextA(),
          vaultId: controlPlaneIds.vaultB,
        },
        1_000,
      ),
    ).toEqual({ kind: 'owner-mismatch' });
  });

  it('admits exactly the 10,000th card and the final Vault byte at race boundaries', async () => {
    const ledger = await open(
      new D1VaultQuotaLedgerDirectory(database),
      contextA(),
    );
    await seedUsage(database, 9_999, 0);
    const cardRace = await Promise.all([
      ledger.reserve(createCommand('a', 1)),
      ledger.reserve(createCommand('b', 1)),
    ]);
    expect(
      cardRace.filter((result) => result.kind === 'reserved'),
    ).toHaveLength(1);
    expect(cardRace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'rejected',
          reason: 'active-card-limit',
        }),
      ]),
    );

    await database.prepare('DELETE FROM vault_quota_reservations').run();
    await seedUsage(
      database,
      0,
      paidPersonalVaultLimits.plaintextBytesPerVault - 1,
    );
    const byteRace = await Promise.all([
      ledger.reserve(createCommand('c', 1)),
      ledger.reserve(createCommand('d', 1)),
    ]);
    expect(
      byteRace.filter((result) => result.kind === 'reserved'),
    ).toHaveLength(1);
    expect(byteRace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'rejected',
          reason: 'vault-plaintext-limit',
        }),
      ]),
    );
  });

  it('does not release delete or decreasing-update capacity before commit', async () => {
    const ledger = await open(
      new D1VaultQuotaLedgerDirectory(database),
      contextA(),
    );
    await seedUsage(database, 10_000, 100);
    const deletion = deleteCommand('a', 40);
    expect(await ledger.reserve(deletion)).toMatchObject({
      kind: 'reserved',
      snapshot: {
        committed: { activeCards: 10_000, plaintextBytes: 100 },
        reserved: { activeCards: 0, plaintextBytes: 0 },
        effective: { activeCards: 10_000, plaintextBytes: 100 },
      },
    });
    expect(await ledger.reserve(createCommand('b', 1))).toEqual({
      kind: 'rejected',
      reason: 'active-card-limit',
    });
    expect(
      await ledger.finalize({
        reservationId: deletion.reservationId,
        fingerprint: deletion.fingerprint,
        outcome: 'commit',
        limits: deletion.limits,
        finalizedAt: 4_000,
      }),
    ).toMatchObject({
      kind: 'committed',
      snapshot: {
        committed: { activeCards: 9_999, plaintextBytes: 60 },
      },
    });
    expect(await ledger.reserve(createCommand('b', 1))).toMatchObject({
      kind: 'reserved',
    });
  });

  it('charges positive updates, explicitly releases abandoned work, and rejects key reuse', async () => {
    const ledger = await open(
      new D1VaultQuotaLedgerDirectory(database),
      contextA(),
    );
    await seedUsage(database, 1, 100);
    const increase = updateCommand('a', 100, 140);
    expect(await ledger.reserve(increase)).toMatchObject({
      kind: 'reserved',
      snapshot: {
        committed: { activeCards: 1, plaintextBytes: 100 },
        reserved: { activeCards: 0, plaintextBytes: 40 },
        effective: { activeCards: 1, plaintextBytes: 140 },
      },
    });
    expect(await ledger.reserve(increase)).toMatchObject({ kind: 'replayed' });
    expect(
      await ledger.reserve({ ...increase, fingerprint: quotaIds.fingerprintB }),
    ).toEqual({ kind: 'rejected', reason: 'idempotency-key-reuse' });
    expect(
      await ledger.listReconciliationCandidates({ now: 2_999, limit: 10 }),
    ).toEqual([]);
    expect(
      await ledger.listReconciliationCandidates({ now: 9_000, limit: 10 }),
    ).toHaveLength(1);
    expect(await ledger.snapshot()).toMatchObject({
      reserved: { activeCards: 0, plaintextBytes: 40 },
    });
    expect(
      await ledger.finalize({
        reservationId: increase.reservationId,
        fingerprint: increase.fingerprint,
        outcome: 'release',
        limits: increase.limits,
        finalizedAt: 9_001,
      }),
    ).toMatchObject({
      kind: 'released',
      snapshot: {
        committed: { activeCards: 1, plaintextBytes: 100 },
        reserved: { activeCards: 0, plaintextBytes: 0 },
      },
    });
  });

  it('recovers concurrent finalization CAS without losing either committed delta', async () => {
    const ledger = await open(
      new D1VaultQuotaLedgerDirectory(database),
      contextA(),
    );
    const commands = [createCommand('a', 10), createCommand('b', 20)] as const;
    await Promise.all(commands.map((command) => ledger.reserve(command)));
    const finalized = await Promise.all(
      commands.map((command) =>
        ledger.finalize({
          reservationId: command.reservationId,
          fingerprint: command.fingerprint,
          outcome: 'commit',
          limits: command.limits,
          finalizedAt: 4_000,
        }),
      ),
    );
    expect(finalized.every((result) => result.kind === 'committed')).toBe(true);
    expect(await ledger.snapshot()).toMatchObject({
      revision: 3,
      committed: { activeCards: 2, plaintextBytes: 30 },
      reserved: { activeCards: 0, plaintextBytes: 0 },
      effective: { activeCards: 2, plaintextBytes: 30 },
    });
  });

  it('replays a completed finalization without applying usage twice', async () => {
    const ledger = await open(
      new D1VaultQuotaLedgerDirectory(database),
      contextA(),
    );
    const command = createCommand('a', 10);
    await ledger.reserve(command);
    const finalization = {
      reservationId: command.reservationId,
      fingerprint: command.fingerprint,
      outcome: 'commit' as const,
      limits: command.limits,
      finalizedAt: 4_000,
    };

    expect(await ledger.finalize(finalization)).toMatchObject({
      kind: 'committed',
    });
    expect(await ledger.finalize(finalization)).toMatchObject({
      kind: 'replayed',
    });
    expect(await ledger.snapshot()).toMatchObject({
      revision: 2,
      committed: { activeCards: 1, plaintextBytes: 10 },
    });
    expect(
      await database
        .prepare(
          'SELECT COUNT(*) AS count FROM vault_quota_finalization_assertions',
        )
        .first(),
    ).toEqual({ count: 0 });
  });

  it('rolls usage back when the reservation CAS changes no row', async () => {
    const ledger = await open(
      new D1VaultQuotaLedgerDirectory(database),
      contextA(),
    );
    const command = createCommand('a', 10);
    await ledger.reserve(command);
    await database
      .prepare(
        `CREATE TRIGGER fail_quota_reservation_finalize
         BEFORE UPDATE OF state ON vault_quota_reservations
         FOR EACH ROW BEGIN SELECT RAISE(IGNORE); END`,
      )
      .run();
    try {
      expect(
        await ledger.finalize({
          reservationId: command.reservationId,
          fingerprint: command.fingerprint,
          outcome: 'commit',
          limits: command.limits,
          finalizedAt: 4_000,
        }),
      ).toEqual({ kind: 'rejected', reason: 'cas-conflict' });
      expect(await ledger.snapshot()).toMatchObject({
        revision: 1,
        committed: { activeCards: 0, plaintextBytes: 0 },
        reserved: { activeCards: 1, plaintextBytes: 10 },
      });
      expect(await ledger.findReservation(command.reservationId)).toMatchObject(
        { state: { kind: 'reserved' } },
      );
    } finally {
      await database
        .prepare('DROP TRIGGER fail_quota_reservation_finalize')
        .run();
    }
  });

  it('leaves the reservation pending when the usage CAS changes no row', async () => {
    const ledger = await open(
      new D1VaultQuotaLedgerDirectory(database),
      contextA(),
    );
    const command = createCommand('a', 10);
    await ledger.reserve(command);
    await database
      .prepare(
        `CREATE TRIGGER fail_quota_usage_finalize
         BEFORE UPDATE OF revision ON vault_quota_usage
         FOR EACH ROW BEGIN SELECT RAISE(IGNORE); END`,
      )
      .run();
    try {
      expect(
        await ledger.finalize({
          reservationId: command.reservationId,
          fingerprint: command.fingerprint,
          outcome: 'commit',
          limits: command.limits,
          finalizedAt: 4_000,
        }),
      ).toEqual({ kind: 'rejected', reason: 'cas-conflict' });
      expect(await ledger.snapshot()).toMatchObject({
        revision: 1,
        committed: { activeCards: 0, plaintextBytes: 0 },
        reserved: { activeCards: 1, plaintextBytes: 10 },
      });
      expect(await ledger.findReservation(command.reservationId)).toMatchObject(
        { state: { kind: 'reserved' } },
      );
    } finally {
      await database.prepare('DROP TRIGGER fail_quota_usage_finalize').run();
    }
  });

  it('rolls the whole batch back and propagates an unrelated D1 failure', async () => {
    const ledger = await open(
      new D1VaultQuotaLedgerDirectory(database),
      contextA(),
    );
    const command = createCommand('a', 10);
    await ledger.reserve(command);
    await database
      .prepare(
        `CREATE TRIGGER abort_quota_reservation_finalize
         BEFORE UPDATE OF state ON vault_quota_reservations
         FOR EACH ROW BEGIN
           SELECT RAISE(ABORT, 'injected quota finalization failure');
         END`,
      )
      .run();
    try {
      await expect(
        ledger.finalize({
          reservationId: command.reservationId,
          fingerprint: command.fingerprint,
          outcome: 'commit',
          limits: command.limits,
          finalizedAt: 4_000,
        }),
      ).rejects.toThrow(/injected quota finalization failure/);
      expect(await ledger.snapshot()).toMatchObject({
        revision: 1,
        committed: { activeCards: 0, plaintextBytes: 0 },
        reserved: { activeCards: 1, plaintextBytes: 10 },
      });
      expect(await ledger.findReservation(command.reservationId)).toMatchObject(
        { state: { kind: 'reserved' } },
      );
    } finally {
      await database
        .prepare('DROP TRIGGER abort_quota_reservation_finalize')
        .run();
    }
  });

  it('allows identical card and reservation IDs only within separate Vault scopes', async () => {
    const directory = new D1VaultQuotaLedgerDirectory(database);
    const [ledgerA, ledgerB] = await Promise.all([
      open(directory, contextA()),
      open(directory, contextB()),
    ]);
    const [resultA, resultB] = await Promise.all([
      ledgerA.reserve(createCommand('a', 10)),
      ledgerB.reserve(createCommand('a', 20)),
    ]);
    expect(resultA).toMatchObject({
      kind: 'reserved',
      reservation: {
        accountId: controlPlaneIds.accountA,
        vaultId: controlPlaneIds.vaultA,
      },
    });
    expect(resultB).toMatchObject({
      kind: 'reserved',
      reservation: {
        accountId: controlPlaneIds.accountB,
        vaultId: controlPlaneIds.vaultB,
      },
    });
    expect(await ledgerA.snapshot()).toMatchObject({
      effective: { plaintextBytes: 10 },
    });
    expect(await ledgerB.snapshot()).toMatchObject({
      effective: { plaintextBytes: 20 },
    });
    const [finalizedA, finalizedB] = await Promise.all([
      ledgerA.finalize({
        reservationId: quotaIds.reservationA,
        fingerprint: quotaIds.fingerprintA,
        outcome: 'commit',
        limits: paidPersonalVaultLimits,
        finalizedAt: 4_000,
      }),
      ledgerB.finalize({
        reservationId: quotaIds.reservationA,
        fingerprint: quotaIds.fingerprintA,
        outcome: 'commit',
        limits: paidPersonalVaultLimits,
        finalizedAt: 4_000,
      }),
    ]);
    expect(finalizedA).toMatchObject({ kind: 'committed' });
    expect(finalizedB).toMatchObject({ kind: 'committed' });
    expect(await ledgerA.snapshot()).toMatchObject({
      committed: { activeCards: 1, plaintextBytes: 10 },
    });
    expect(await ledgerB.snapshot()).toMatchObject({
      committed: { activeCards: 1, plaintextBytes: 20 },
    });
  });

  it('fails closed when D1 becomes unavailable', async () => {
    const failingMiniflare = createMiniflare('FAILURE');
    const failingDatabase = await failingMiniflare.getD1Database('FAILURE');
    await runD1Migrations({
      database: failingDatabase,
      manifest: migrationManifest,
      appliedAt: 1_000,
    });
    await seedOwners(failingDatabase);
    const ledger = await open(
      new D1VaultQuotaLedgerDirectory(failingDatabase),
      contextA(),
    );
    await failingMiniflare.dispose();

    await expect(ledger.snapshot()).rejects.toThrow();
  });
});

function createMiniflare(binding: string): Miniflare {
  return new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: [binding],
  });
}

async function seedOwners(target: TestDatabase): Promise<void> {
  await target.batch([
    target
      .prepare('INSERT INTO accounts(account_id, created_at) VALUES (?, ?)')
      .bind(controlPlaneIds.accountA, 1_000),
    target
      .prepare(
        'INSERT INTO personal_vaults(vault_id, account_id, created_at) VALUES (?, ?, ?)',
      )
      .bind(controlPlaneIds.vaultA, controlPlaneIds.accountA, 1_000),
    target
      .prepare('INSERT INTO accounts(account_id, created_at) VALUES (?, ?)')
      .bind(controlPlaneIds.accountB, 1_000),
    target
      .prepare(
        'INSERT INTO personal_vaults(vault_id, account_id, created_at) VALUES (?, ?, ?)',
      )
      .bind(controlPlaneIds.vaultB, controlPlaneIds.accountB, 1_000),
  ]);
}

async function seedUsage(
  target: TestDatabase,
  activeCards: number,
  plaintextBytes: number,
): Promise<void> {
  await target
    .prepare(
      `INSERT INTO vault_quota_usage(
        account_id, vault_id, revision, active_cards, plaintext_bytes,
        last_transition_reservation_id, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, NULL, 1000, 1000)
      ON CONFLICT(account_id, vault_id) DO UPDATE SET
        revision = 1, active_cards = excluded.active_cards,
        plaintext_bytes = excluded.plaintext_bytes,
        last_transition_reservation_id = NULL, updated_at = 1000`,
    )
    .bind(
      controlPlaneIds.accountA,
      controlPlaneIds.vaultA,
      activeCards,
      plaintextBytes,
    )
    .run();
}

async function open(
  directory: D1VaultQuotaLedgerDirectory,
  context: VaultContext,
): Promise<VaultQuotaLedger> {
  const result = await directory.open(context, 1_000);
  if (result.kind !== 'opened') throw new Error('quota ledger did not open');
  return result.ledger;
}

function contextA(): VaultContext {
  return controlPlaneContext();
}

function contextB(): VaultContext {
  return {
    ...controlPlaneContext(),
    accountId: controlPlaneIds.accountB,
    vaultId: controlPlaneIds.vaultB,
  };
}

function createCommand(
  id: 'a' | 'b' | 'c' | 'd',
  plaintextBytes: number,
): VaultQuotaReservationCommand {
  const identifiers = commandIdentifiers(id);
  return {
    ...identifiers,
    change: {
      kind: 'create',
      nextPlaintextBytes: parseQuotaByteCount(plaintextBytes),
    },
    limits: paidPersonalVaultLimits,
    requestedAt: 2_000,
    reconcileAfter: 3_000,
  };
}

function updateCommand(
  id: 'a' | 'b' | 'c' | 'd',
  currentBytes: number,
  nextBytes: number,
): VaultQuotaReservationCommand {
  return {
    ...commandIdentifiers(id),
    change: {
      kind: 'update',
      currentPlaintextBytes: parseQuotaByteCount(currentBytes),
      nextPlaintextBytes: parseQuotaByteCount(nextBytes),
    },
    limits: paidPersonalVaultLimits,
    requestedAt: 2_000,
    reconcileAfter: 3_000,
  };
}

function deleteCommand(
  id: 'a' | 'b' | 'c' | 'd',
  currentBytes: number,
): VaultQuotaReservationCommand {
  return {
    ...commandIdentifiers(id),
    change: {
      kind: 'delete',
      currentPlaintextBytes: parseQuotaByteCount(currentBytes),
    },
    limits: paidPersonalVaultLimits,
    requestedAt: 2_000,
    reconcileAfter: 3_000,
  };
}

function commandIdentifiers(id: 'a' | 'b' | 'c' | 'd'): {
  readonly reservationId: MutationId;
  readonly fingerprint: VaultQuotaFingerprint;
  readonly cardId: CardId;
} {
  if (id === 'a') {
    return {
      reservationId: quotaIds.reservationA,
      fingerprint: quotaIds.fingerprintA,
      cardId: quotaIds.cardA,
    };
  }
  if (id === 'b') {
    return {
      reservationId: quotaIds.reservationB,
      fingerprint: quotaIds.fingerprintB,
      cardId: quotaIds.cardB,
    };
  }
  if (id === 'c') {
    return {
      reservationId: quotaIds.reservationC,
      fingerprint: quotaIds.fingerprintC,
      cardId: quotaIds.cardC,
    };
  }
  return {
    reservationId: quotaIds.reservationD,
    fingerprint: quotaIds.fingerprintD,
    cardId: quotaIds.cardD,
  };
}

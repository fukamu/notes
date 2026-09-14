import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { handleSyncRequest } from '@/app/api/sync/handler';
import { synchronize } from '@/db/d1-sync';
import {
  parseCardId,
  parseConflictId,
  parseDeviceId,
  parseMutationId,
  type CardId,
  type ConflictId,
  type MutationId,
} from '@/lib/domain/id';
import { CONTRACT_LIMITS, type PendingMutation } from '@/lib/domain/types';
import { decodeSyncResponse, encodeSyncRequest } from '@/lib/sync/protocol';
import {
  containsSensitiveMarker,
  securityCorpusMarker,
} from '@/tests/fixtures/security-corpus';

const ids = {
  device: parseDeviceId('01991f20-61d2-7000-8000-000000001000'),
  cardA: parseCardId('01991f20-61d2-7000-8000-000000001001'),
  cardB: parseCardId('01991f20-61d2-7000-8000-000000001002'),
  missingCard: parseCardId('01991f20-61d2-7000-8000-000000001003'),
  createA: parseMutationId('01991f20-61d2-7000-8000-000000001010'),
  conflictA: parseMutationId('01991f20-61d2-7000-8000-000000001011'),
  createB: parseMutationId('01991f20-61d2-7000-8000-000000001012'),
  conflictB: parseMutationId('01991f20-61d2-7000-8000-000000001013'),
  invalidOne: parseMutationId('01991f20-61d2-7000-8000-000000001014'),
  invalidTwo: parseMutationId('01991f20-61d2-7000-8000-000000001015'),
  invalidThree: parseMutationId('01991f20-61d2-7000-8000-000000001016'),
  validResolve: parseMutationId('01991f20-61d2-7000-8000-000000001017'),
  rollbackResolve: parseMutationId('01991f20-61d2-7000-8000-000000001018'),
  racingResolveA: parseMutationId('01991f20-61d2-7000-8000-000000001019'),
  racingResolveB: parseMutationId('01991f20-61d2-7000-8000-000000001020'),
  missingConflict: parseConflictId('01991f20-61d2-7000-8000-000000001099'),
} as const;

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

let miniflare: Miniflare;
let database: TestDatabase;
let migrationDatabase: TestDatabase;

// These two composite cases intentionally run several Miniflare transactions
// and resets. CI/coverage measured 5.3-5.8s, above Vitest's incidental 5s
// default; 15s keeps a finite hang guard without changing any assertion.
const compositeD1TestTimeoutMs = 15_000;
vi.setConfig({ testTimeout: compositeD1TestTimeoutMs });

function upsert(
  mutationId: MutationId,
  cardId: CardId,
  title: string,
  baseServerRevision: number | null,
): PendingMutation {
  return {
    mutationId,
    cardId,
    kind: 'upsert',
    baseServerRevision,
    title,
    body: [],
    createdAt: 1_789_000_000_000,
    updatedAt: 1_789_000_000_100,
    conflictIds: [],
  };
}

function resolve(
  mutationId: MutationId,
  cardId: CardId,
  conflictIds: [ConflictId, ...ConflictId[]],
  title = '解決済み',
  baseServerRevision = 1,
): PendingMutation {
  return {
    mutationId,
    cardId,
    kind: 'resolve',
    baseServerRevision,
    title,
    body: [],
    createdAt: 1_789_000_000_000,
    updatedAt: 1_789_000_000_200,
    conflictIds,
  };
}

function syncRequest(mutations: PendingMutation[]): Request {
  return new Request('https://notes.example/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      encodeSyncRequest({ deviceId: ids.device, mutations }),
    ),
  });
}

function rawRequest(
  body: string,
  headers: Record<string, string> = {},
): Request {
  return new Request('https://notes.example/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

async function post(mutations: PendingMutation[]): Promise<Response> {
  return handleSyncRequest(syncRequest(mutations), { DB: database });
}

async function snapshot(): Promise<string> {
  const state: unknown[] = [];
  for (const query of [
    'SELECT * FROM sync_state ORDER BY singleton',
    'SELECT * FROM cards ORDER BY id',
    'SELECT * FROM card_mutations ORDER BY id',
    'SELECT * FROM conflicts ORDER BY id',
  ]) {
    const result: unknown = await database.prepare(query).raw();
    state.push(result);
  }
  return JSON.stringify(state);
}

async function resetDatabase(): Promise<void> {
  await database.exec(`
    DROP TRIGGER IF EXISTS fail_resolve_log;
    DROP TABLE IF EXISTS conflicts;
    DROP TABLE IF EXISTS card_mutations;
    DROP TABLE IF EXISTS cards;
    DROP TABLE IF EXISTS sync_state;
  `);
  await applyMigration(database, 'drizzle/0000_sticky_gamora.sql');
  await applyMigration(database, 'drizzle/0001_amazing_cannonball.sql');
  await database
    .prepare('INSERT INTO sync_state(singleton, next_display_id) VALUES (1, 1)')
    .run();
}

async function applyMigration(
  target: TestDatabase,
  file: string,
): Promise<void> {
  const source = await readFile(file, 'utf8');
  for (const statement of source.split('--> statement-breakpoint')) {
    if (statement.trim() !== '') await target.prepare(statement).run();
  }
}

async function createConflict(
  cardId: CardId,
  createId: MutationId,
  conflictId: MutationId,
): Promise<void> {
  expect((await post([upsert(createId, cardId, 'server', null)])).status).toBe(
    200,
  );
  expect((await post([upsert(conflictId, cardId, 'local', 99)])).status).toBe(
    200,
  );
}

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB', 'MIGRATION_DB'],
  });
  database = await miniflare.getD1Database('DB');
  migrationDatabase = await miniflare.getD1Database('MIGRATION_DB');
});

beforeEach(resetDatabase);

afterAll(async () => {
  await miniflare.dispose();
});

describe('sync API request and response boundaries', () => {
  it('round-trips a valid request through local D1 and a validated response', async () => {
    const mutation = upsert(ids.createA, ids.cardA, '同期カード', null);
    const response = await post([mutation]);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const payload: unknown = await response.json();
    const decoded = decodeSyncResponse(payload, [mutation]);
    expect(decoded.cards).toMatchObject([
      { id: ids.cardA, officialDisplayId: 1, title: '同期カード' },
    ]);
    expect(decoded.acknowledgedMutationIds).toEqual([ids.createA]);
  });

  it('classifies malformed and oversized input as 4xx without changing D1', async () => {
    const valid = encodeSyncRequest({
      deviceId: ids.device,
      mutations: [upsert(ids.createA, ids.cardA, 'secret-title', null)],
    });
    const mutation = valid.mutations[0];
    if (!mutation) throw new Error('fixture mutation is missing');
    const invalidBodies = [
      '{',
      'null',
      '42',
      '[]',
      '{}',
      JSON.stringify({ ...valid, extra: true }),
      JSON.stringify({ ...valid, deviceId: 'not-a-uuid' }),
      JSON.stringify({ ...valid, mutations: [mutation, mutation] }),
      JSON.stringify({
        ...valid,
        mutations: [{ ...mutation, unknown: true }],
      }),
      JSON.stringify({
        ...valid,
        mutations: [{ ...mutation, title: null }],
      }),
      JSON.stringify({
        ...valid,
        mutations: [
          { ...mutation, title: 'x'.repeat(CONTRACT_LIMITS.title + 1) },
        ],
      }),
      JSON.stringify({
        ...valid,
        mutations: [
          {
            ...mutation,
            body: [
              {
                type: 'text',
                text: 'x'.repeat(CONTRACT_LIMITS.text + 1),
              },
            ],
          },
        ],
      }),
      JSON.stringify({
        ...valid,
        mutations: Array.from(
          { length: CONTRACT_LIMITS.mutations + 1 },
          () => mutation,
        ),
      }),
      JSON.stringify({
        ...valid,
        mutations: [
          { ...mutation, baseServerRevision: Number.MAX_SAFE_INTEGER + 1 },
        ],
      }),
      JSON.stringify({
        ...valid,
        mutations: [{ ...mutation, createdAt: mutation.updatedAt + 1 }],
      }),
    ];
    const before = await snapshot();
    for (const body of invalidBodies) {
      const response = await handleSyncRequest(rawRequest(body), {
        DB: database,
      });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain('secret-title');
      expect(await snapshot()).toBe(before);
    }

    const oversized = await handleSyncRequest(
      rawRequest('{}', {
        'content-length': String(CONTRACT_LIMITS.payloadBytes + 1),
      }),
      { DB: database },
    );
    expect(oversized.status).toBe(413);
    expect(await snapshot()).toBe(before);

    const actualOversized = await handleSyncRequest(
      rawRequest(
        JSON.stringify({ padding: 'x'.repeat(CONTRACT_LIMITS.payloadBytes) }),
      ),
      { DB: database },
    );
    expect(actualOversized.status).toBe(413);
    expect(await snapshot()).toBe(before);
  });

  it('returns database failures as redacted 5xx after request validation', async () => {
    const failure = new Error(`message:${securityCorpusMarker}`);
    failure.name = `name:${securityCorpusMarker}`;
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failingDatabase = {
      prepare() {
        throw failure;
      },
      batch() {
        throw failure;
      },
      exec() {
        throw failure;
      },
    };
    const response = await handleSyncRequest(syncRequest([]), {
      DB: failingDatabase,
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('DB');
    expect(log).toHaveBeenCalledWith('sync failed', 'Error');
    expect(
      containsSensitiveMarker(log.mock.calls, [securityCorpusMarker]),
    ).toBe(false);
  });
});

describe('resolve transaction invariants', () => {
  it('rejects empty, missing, foreign, mixed, and stale conflicts with all state unchanged', async () => {
    await createConflict(ids.cardA, ids.createA, ids.conflictA);
    await createConflict(ids.cardB, ids.createB, ids.conflictB);
    const conflictA = parseConflictId(ids.conflictA);
    const conflictB = parseConflictId(ids.conflictB);
    const before = await snapshot();

    const emptyWire = encodeSyncRequest({
      deviceId: ids.device,
      mutations: [upsert(ids.invalidOne, ids.cardA, 'invalid', 1)],
    });
    const base = emptyWire.mutations[0];
    if (!base) throw new Error('fixture mutation is missing');
    const emptyResponse = await handleSyncRequest(
      rawRequest(
        JSON.stringify({
          ...emptyWire,
          mutations: [{ ...base, kind: 'resolve', conflictIds: [] }],
        }),
      ),
      { DB: database },
    );
    expect(emptyResponse.status).toBe(400);
    expect(await snapshot()).toBe(before);

    for (const mutation of [
      resolve(ids.invalidOne, ids.cardA, [ids.missingConflict]),
      resolve(ids.invalidTwo, ids.cardA, [conflictB]),
      resolve(ids.invalidThree, ids.cardA, [conflictA, conflictB]),
      resolve(ids.validResolve, ids.cardA, [conflictA], 'stale', 99),
    ]) {
      expect((await post([mutation])).status).toBe(500);
      expect(await snapshot()).toBe(before);
    }

    const valid = resolve(
      ids.validResolve,
      ids.cardA,
      [conflictA],
      '正しく解決',
    );
    const response = await post([valid]);
    expect(response.status).toBe(200);
    const payload: unknown = await response.json();
    const decoded = decodeSyncResponse(payload, [valid]);
    expect(decoded.cards.find((card) => card.id === ids.cardA)).toMatchObject({
      title: '正しく解決',
      revision: 2,
    });
    expect(decoded.conflicts.map((conflict) => conflict.id)).toEqual([
      conflictB,
    ]);
  });

  it('rolls back card, conflict, and mutation log when the batch fails last', async () => {
    await createConflict(ids.cardA, ids.createA, ids.conflictA);
    const conflictA = parseConflictId(ids.conflictA);
    await database
      .prepare(
        `CREATE TRIGGER fail_resolve_log
         BEFORE INSERT ON card_mutations
         WHEN NEW.id = '${ids.rollbackResolve}'
         BEGIN
           SELECT RAISE(ABORT, 'injected transaction failure');
         END`,
      )
      .run();
    const before = await snapshot();
    const response = await post([
      resolve(ids.rollbackResolve, ids.cardA, [conflictA]),
    ]);
    expect(response.status).toBe(500);
    expect(await snapshot()).toBe(before);
  });

  it('allows only one of two racing resolves to commit', async () => {
    await createConflict(ids.cardA, ids.createA, ids.conflictA);
    const conflictA = parseConflictId(ids.conflictA);
    const responses = await Promise.all([
      post([
        resolve(ids.racingResolveA, ids.cardA, [conflictA], 'race winner A'),
      ]),
      post([
        resolve(ids.racingResolveB, ids.cardA, [conflictA], 'race winner B'),
      ]),
    ]);
    expect(
      responses
        .map((response) => response.status)
        .sort((left, right) => left - right),
    ).toEqual([200, 500]);
    const card: unknown = await database
      .prepare('SELECT title, revision FROM cards WHERE id = ?')
      .bind(ids.cardA)
      .first();
    expect(card).toMatchObject({ revision: 2 });
    const conflicts: unknown = await database
      .prepare('SELECT id FROM conflicts')
      .all();
    expect(conflicts).toMatchObject({ results: [] });
  });
});

describe('D1 row and saved JSON boundaries', () => {
  it('upgrades a valid base migration without changing its data meaning', async () => {
    await migrationDatabase.exec(`
      DROP TABLE IF EXISTS conflicts;
      DROP TABLE IF EXISTS card_mutations;
      DROP TABLE IF EXISTS cards;
      DROP TABLE IF EXISTS sync_state;
    `);
    await applyMigration(migrationDatabase, 'drizzle/0000_sticky_gamora.sql');
    await migrationDatabase
      .prepare(
        'INSERT INTO sync_state(singleton, next_display_id) VALUES (1, 1)',
      )
      .run();
    const mutation = upsert(ids.createA, ids.cardA, 'migration fixture', null);
    const before = await synchronize(migrationDatabase, [mutation]);
    await applyMigration(
      migrationDatabase,
      'drizzle/0001_amazing_cannonball.sql',
    );
    const after = await synchronize(migrationDatabase, []);
    expect(after.cards).toEqual(before.cards);
    expect(after.conflicts).toEqual(before.conflicts);
  });

  it('preflights corrupt state before applying any new mutation', async () => {
    expect(
      (await post([upsert(ids.createA, ids.cardA, 'valid', null)])).status,
    ).toBe(200);
    await database.prepare("UPDATE cards SET body_json = '{'").run();
    const corruptCardState = await snapshot();
    expect(
      (await post([upsert(ids.invalidOne, ids.cardA, 'overwrite', 1)])).status,
    ).toBe(500);
    expect(await snapshot()).toBe(corruptCardState);

    await resetDatabase();
    await createConflict(ids.cardA, ids.createA, ids.conflictA);
    await database.prepare("UPDATE conflicts SET server_body_json = '{'").run();
    const corruptConflictState = await snapshot();
    expect(
      (await post([upsert(ids.createB, ids.cardB, 'new card', null)])).status,
    ).toBe(500);
    expect(await snapshot()).toBe(corruptConflictState);
  });

  it('rejects malformed body JSON, row values, duplicate displays, and missing references', async () => {
    const cases = [
      "UPDATE cards SET body_json = '{'",
      'UPDATE cards SET revision = 0',
      'UPDATE cards SET updated_at = created_at - 1',
      "UPDATE cards SET id = 'not-a-uuid'",
      `UPDATE cards SET body_json = '[{"type":"link","targetCardId":"${ids.missingCard}"}]'`,
    ];
    for (const statement of cases) {
      await resetDatabase();
      expect(
        (await post([upsert(ids.createA, ids.cardA, 'valid', null)])).status,
      ).toBe(200);
      if (statement.includes('revision = 0')) {
        await database.prepare('PRAGMA ignore_check_constraints = ON').run();
      }
      await database.prepare(statement).run();
      if (statement.includes('revision = 0')) {
        await database.prepare('PRAGMA ignore_check_constraints = OFF').run();
      }
      expect((await post([])).status).toBe(500);
    }

    await resetDatabase();
    expect(
      (
        await post([
          upsert(ids.createA, ids.cardA, 'first', null),
          upsert(ids.createB, ids.cardB, 'second', null),
        ])
      ).status,
    ).toBe(200);
    await database.prepare('DROP INDEX idx_cards_display_id').run();
    await database
      .prepare('UPDATE cards SET display_id = 1 WHERE id = ?')
      .bind(ids.cardB)
      .run();
    expect((await post([])).status).toBe(500);
  });

  it('rejects malformed conflict rows instead of returning them', async () => {
    await createConflict(ids.cardA, ids.createA, ids.conflictA);
    for (const statement of [
      "UPDATE conflicts SET local_body_json = '{'",
      "UPDATE conflicts SET card_id = 'not-a-uuid'",
      'UPDATE conflicts SET server_revision = 0',
    ]) {
      await database.prepare(statement).run();
      expect((await post([])).status).toBe(500);
      await resetDatabase();
      await createConflict(ids.cardA, ids.createA, ids.conflictA);
    }
  });
});

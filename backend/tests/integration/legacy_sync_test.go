//go:build integration

package integration_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"sort"
	"sync"
	"testing"
	"time"

	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/synclegacy"
	"github.com/fukamu/notes/backend/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
)

const legacyDeviceID synclegacy.DeviceID = "01991f20-61d2-7000-8000-000000001000"
const secondLegacyDeviceID synclegacy.DeviceID = "01991f20-61d2-7000-8000-000000001001"

func TestLegacySyncPostgres(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("NOTES_TEST_DATABASE_URL is required for integration tests")
	}
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("unsafe test database target: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 8)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, "DROP SCHEMA public CASCADE"); err != nil {
		t.Fatalf("drop test schema: %v", err)
	}
	if _, err := pool.Exec(ctx, "CREATE SCHEMA public"); err != nil {
		t.Fatalf("create test schema: %v", err)
	}
	database, err := postgresadapter.OpenSQL(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenSQL() error = %v", err)
	}
	defer database.Close()
	migrator, err := postgresadapter.NewMigrator(database, migrations.Files)
	if err != nil {
		t.Fatalf("NewMigrator() error = %v", err)
	}
	if err := migrator.Up(ctx); err != nil {
		t.Fatalf("migrate legacy sync database: %v", err)
	}
	store, err := postgresadapter.NewLegacySyncStore(pool)
	if err != nil {
		t.Fatalf("NewLegacySyncStore() error = %v", err)
	}

	empty, err := store.Sync(ctx, synclegacy.Request{
		DeviceID: legacyDeviceID, Mutations: []synclegacy.Mutation{},
	})
	if err != nil || len(empty.Cards) != 0 || empty.Cards == nil ||
		empty.Conflicts == nil || empty.AcknowledgedMutationIDs == nil {
		t.Fatalf("empty sync = %#v, error = %v", empty, err)
	}

	cardA := synclegacy.CardID("01991f20-61d2-7000-8000-000000001001")
	createA := legacyUpsert(
		"01991f20-61d2-7000-8000-000000001010",
		cardA,
		"server",
		nil,
	)
	created, err := store.Sync(ctx, legacyRequest(createA))
	if err != nil || len(created.Cards) != 1 || created.Cards[0].OfficialDisplayID != 1 ||
		created.Cards[0].Revision != 1 {
		t.Fatalf("create response = %#v, error = %v", created, err)
	}
	replayed, err := store.Sync(ctx, legacyRequest(createA))
	if err != nil || len(replayed.Cards) != 1 || replayed.Cards[0].Revision != 1 ||
		len(replayed.AcknowledgedMutationIDs) != 1 {
		t.Fatalf("replay response = %#v, error = %v", replayed, err)
	}

	cardB := synclegacy.CardID("01991f20-61d2-7000-8000-000000001002")
	createB := legacyUpsert(
		"01991f20-61d2-7000-8000-000000001011",
		cardB,
		"second",
		nil,
	)
	second, err := store.Sync(ctx, legacyRequest(createB))
	if err != nil || len(second.Cards) != 2 || second.Cards[1].OfficialDisplayID != 2 {
		t.Fatalf("second create response = %#v, error = %v", second, err)
	}

	baseOne := int64(1)
	updateA := legacyUpsert(
		"01991f20-61d2-7000-8000-000000001012",
		cardA,
		"updated",
		&baseOne,
	)
	updated, err := store.Sync(ctx, legacyRequest(updateA))
	if err != nil || updated.Cards[0].Revision != 2 || updated.Cards[0].Title != "updated" {
		t.Fatalf("update response = %#v, error = %v", updated, err)
	}

	stale := legacyUpsert(
		"01991f20-61d2-7000-8000-000000001013",
		cardA,
		"stale local",
		&baseOne,
	)
	conflicted, err := store.Sync(ctx, legacyRequestForDevice(secondLegacyDeviceID, stale))
	if err != nil || len(conflicted.Conflicts) != 1 ||
		conflicted.Conflicts[0].ID != synclegacy.ConflictID(stale.MutationID) ||
		conflicted.Cards[0].Title != "updated" || conflicted.Cards[0].Revision != 2 {
		t.Fatalf("conflict response = %#v, error = %v", conflicted, err)
	}

	baseTwo := int64(2)
	resolve := synclegacy.Mutation{
		MutationID:         "01991f20-61d2-7000-8000-000000001014",
		CardID:             cardA,
		BaseServerRevision: &baseTwo,
		Title:              "resolved",
		Body:               []synclegacy.BodySegment{},
		CreatedAt:          1_789_000_000_000,
		UpdatedAt:          1_789_000_000_400,
		Kind:               synclegacy.MutationResolve,
		ConflictIDs:        []synclegacy.ConflictID{synclegacy.ConflictID(stale.MutationID)},
	}
	resolved, err := store.Sync(ctx, legacyRequest(resolve))
	if err != nil || len(resolved.Conflicts) != 0 || resolved.Cards[0].Revision != 3 ||
		resolved.Cards[0].Title != "resolved" {
		t.Fatalf("resolve response = %#v, error = %v", resolved, err)
	}

	assertConcurrentLegacyCreates(t, ctx, store)
	assertConcurrentLegacyResolve(t, ctx, store)
	assertLegacyBatchRollback(t, ctx, pool, store)
	assertLegacyPreflightRollback(t, ctx, pool, store, cardA)
	assertCapturedLegacyFixture(t, ctx, pool, store)
	cancelledContext, cancelSync := context.WithCancel(ctx)
	cancelSync()
	if _, err := store.Sync(cancelledContext, legacyRequest()); !errors.Is(
		err,
		synclegacy.ErrSyncFailed,
	) {
		t.Fatalf("cancelled sync error = %v", err)
	}
	if acquired := pool.Stat().AcquiredConns(); acquired != 0 {
		t.Fatalf("database connections still acquired after sync scenarios: %d", acquired)
	}
}

func assertCapturedLegacyFixture(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	store *postgresadapter.LegacySyncStore,
) {
	t.Helper()
	if _, err := pool.Exec(ctx, "TRUNCATE conflicts, card_mutations, cards"); err != nil {
		t.Fatalf("reset fixture tables: %v", err)
	}
	if _, err := pool.Exec(ctx, "UPDATE sync_state SET next_display_id = 3 WHERE singleton = 1"); err != nil {
		t.Fatalf("reset fixture display ID: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO cards(
         id, display_id, title, body_json, revision, created_at, updated_at, last_mutation_id
       ) VALUES
         ('01991f20-61d2-7000-8000-000000000001', 1, 'before', '[]', 1,
          1789000000000, 1789000000000, '01991f20-61d2-7000-8000-000000000010'),
         ('01991f20-61d2-7000-8000-000000000002', 2, '固定カードB', '[]', 1,
          1789000000200, 1789000000200, '01991f20-61d2-7000-8000-000000000011')`,
	); err != nil {
		t.Fatalf("seed captured fixture: %v", err)
	}
	fixture := readLegacyFixture(t)
	request, err := synclegacy.DecodeRequest(fixture["request"])
	if err != nil {
		t.Fatalf("decode captured request: %v", err)
	}
	response, err := store.Sync(ctx, request)
	if err != nil {
		t.Fatalf("sync captured request: %v", err)
	}
	actualJSON, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal Go response: %v", err)
	}
	var actual any
	var expected any
	if err := json.Unmarshal(actualJSON, &actual); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(fixture["response"], &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("Go response = %s, want %s", actualJSON, fixture["response"])
	}
}

func readLegacyFixture(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	content, err := os.ReadFile("../../../contracts/fixtures/sync/legacy-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture map[string]json.RawMessage
	if err := json.Unmarshal(content, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func assertConcurrentLegacyResolve(
	t *testing.T,
	ctx context.Context,
	store *postgresadapter.LegacySyncStore,
) {
	t.Helper()
	cardID := synclegacy.CardID("01991f20-61d2-7000-8000-000000001050")
	create := legacyUpsert(
		"01991f20-61d2-7000-8000-000000001050",
		cardID,
		"race server",
		nil,
	)
	if _, err := store.Sync(ctx, legacyRequest(create)); err != nil {
		t.Fatalf("create race card: %v", err)
	}
	staleRevision := int64(99)
	conflict := legacyUpsert(
		"01991f20-61d2-7000-8000-000000001051",
		cardID,
		"race conflict",
		&staleRevision,
	)
	if _, err := store.Sync(ctx, legacyRequest(conflict)); err != nil {
		t.Fatalf("create race conflict: %v", err)
	}
	base := int64(1)
	resolutions := []synclegacy.Mutation{
		{
			MutationID:         "01991f20-61d2-7000-8000-000000001052",
			CardID:             cardID,
			BaseServerRevision: &base,
			Title:              "race winner a",
			Body:               []synclegacy.BodySegment{},
			CreatedAt:          1_789_000_000_000,
			UpdatedAt:          1_789_000_000_200,
			Kind:               synclegacy.MutationResolve,
			ConflictIDs:        []synclegacy.ConflictID{synclegacy.ConflictID(conflict.MutationID)},
		},
		{
			MutationID:         "01991f20-61d2-7000-8000-000000001053",
			CardID:             cardID,
			BaseServerRevision: &base,
			Title:              "race winner b",
			Body:               []synclegacy.BodySegment{},
			CreatedAt:          1_789_000_000_000,
			UpdatedAt:          1_789_000_000_200,
			Kind:               synclegacy.MutationResolve,
			ConflictIDs:        []synclegacy.ConflictID{synclegacy.ConflictID(conflict.MutationID)},
		},
	}
	start := make(chan struct{})
	failures := make([]error, len(resolutions))
	var wait sync.WaitGroup
	for index, resolution := range resolutions {
		index, resolution := index, resolution
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			_, failures[index] = store.Sync(ctx, legacyRequest(resolution))
		}()
	}
	close(start)
	wait.Wait()
	successes := 0
	rejections := 0
	for _, err := range failures {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, synclegacy.ErrSyncFailed):
			rejections++
		default:
			t.Fatalf("unexpected resolve race error = %v", err)
		}
	}
	if successes != 1 || rejections != 1 {
		t.Fatalf("resolve race outcomes: success=%d rejected=%d", successes, rejections)
	}
	state, err := store.Sync(ctx, synclegacy.Request{
		DeviceID: legacyDeviceID, Mutations: []synclegacy.Mutation{},
	})
	if err != nil {
		t.Fatalf("read resolve race state: %v", err)
	}
	for _, remaining := range state.Conflicts {
		if remaining.CardID == cardID {
			t.Fatalf("resolved conflict remains: %#v", remaining)
		}
	}
}

func assertConcurrentLegacyCreates(
	t *testing.T,
	ctx context.Context,
	store *postgresadapter.LegacySyncStore,
) {
	t.Helper()
	mutations := []synclegacy.Mutation{
		legacyUpsert(
			"01991f20-61d2-7000-8000-000000001020",
			"01991f20-61d2-7000-8000-000000001020",
			"concurrent-a",
			nil,
		),
		legacyUpsert(
			"01991f20-61d2-7000-8000-000000001021",
			"01991f20-61d2-7000-8000-000000001021",
			"concurrent-b",
			nil,
		),
	}
	start := make(chan struct{})
	failures := make([]error, len(mutations))
	var wait sync.WaitGroup
	for index, mutation := range mutations {
		index, mutation := index, mutation
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			_, failures[index] = store.Sync(ctx, legacyRequest(mutation))
		}()
	}
	close(start)
	wait.Wait()
	for _, err := range failures {
		if err != nil {
			t.Fatalf("concurrent create error = %v", err)
		}
	}
	state, err := store.Sync(ctx, synclegacy.Request{
		DeviceID: legacyDeviceID, Mutations: []synclegacy.Mutation{},
	})
	if err != nil {
		t.Fatalf("read concurrent state: %v", err)
	}
	displayIDs := make([]int, 0, 2)
	for _, card := range state.Cards {
		if card.Title == "concurrent-a" || card.Title == "concurrent-b" {
			displayIDs = append(displayIDs, int(card.OfficialDisplayID))
		}
	}
	sort.Ints(displayIDs)
	if len(displayIDs) != 2 || displayIDs[0] == displayIDs[1] {
		t.Fatalf("concurrent display IDs = %v", displayIDs)
	}
}

func assertLegacyBatchRollback(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	store *postgresadapter.LegacySyncStore,
) {
	t.Helper()
	rollbackCard := synclegacy.CardID("01991f20-61d2-7000-8000-000000001030")
	create := legacyUpsert(
		"01991f20-61d2-7000-8000-000000001030",
		rollbackCard,
		"must rollback",
		nil,
	)
	base := int64(1)
	invalidResolve := synclegacy.Mutation{
		MutationID:         "01991f20-61d2-7000-8000-000000001099",
		CardID:             "01991f20-61d2-7000-8000-000000001099",
		BaseServerRevision: &base,
		Title:              "invalid",
		Body:               []synclegacy.BodySegment{},
		CreatedAt:          1,
		UpdatedAt:          1,
		Kind:               synclegacy.MutationResolve,
		ConflictIDs:        []synclegacy.ConflictID{"01991f20-61d2-7000-8000-000000001098"},
	}
	_, err := store.Sync(ctx, synclegacy.Request{
		DeviceID: legacyDeviceID, Mutations: []synclegacy.Mutation{create, invalidResolve},
	})
	if !errors.Is(err, synclegacy.ErrSyncFailed) {
		t.Fatalf("batch error = %v", err)
	}
	var count int
	if err := pool.QueryRow(
		ctx,
		"SELECT count(*) FROM cards WHERE id = $1",
		string(rollbackCard),
	).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rolled-back card count = %d, error = %v", count, err)
	}
}

func assertLegacyPreflightRollback(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	store *postgresadapter.LegacySyncStore,
	cardID synclegacy.CardID,
) {
	t.Helper()
	if _, err := pool.Exec(ctx, "UPDATE cards SET body_json = '{' WHERE id = $1", string(cardID)); err != nil {
		t.Fatalf("corrupt card body: %v", err)
	}
	mutation := legacyUpsert(
		"01991f20-61d2-7000-8000-000000001040",
		"01991f20-61d2-7000-8000-000000001040",
		"must not apply",
		nil,
	)
	if _, err := store.Sync(ctx, legacyRequest(mutation)); !errors.Is(err, synclegacy.ErrSyncFailed) {
		t.Fatalf("corrupt preflight error = %v", err)
	}
	if _, err := pool.Exec(ctx, "UPDATE cards SET body_json = '[]' WHERE id = $1", string(cardID)); err != nil {
		t.Fatalf("restore card body: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		"UPDATE cards SET last_mutation_id = 'invalid' WHERE id = $1",
		string(cardID),
	); err != nil {
		t.Fatalf("corrupt last mutation ID: %v", err)
	}
	if _, err := store.Sync(ctx, legacyRequest()); !errors.Is(err, synclegacy.ErrSyncFailed) {
		t.Fatalf("corrupt last mutation ID error = %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		"UPDATE cards SET last_mutation_id = $1 WHERE id = $2",
		"01991f20-61d2-7000-8000-000000001014",
		string(cardID),
	); err != nil {
		t.Fatalf("restore last mutation ID: %v", err)
	}
}

func legacyRequest(mutations ...synclegacy.Mutation) synclegacy.Request {
	return legacyRequestForDevice(legacyDeviceID, mutations...)
}

func legacyRequestForDevice(
	deviceID synclegacy.DeviceID,
	mutations ...synclegacy.Mutation,
) synclegacy.Request {
	return synclegacy.Request{DeviceID: deviceID, Mutations: mutations}
}

func legacyUpsert(
	mutationID synclegacy.MutationID,
	cardID synclegacy.CardID,
	title string,
	baseRevision *int64,
) synclegacy.Mutation {
	return synclegacy.Mutation{
		MutationID:         mutationID,
		CardID:             cardID,
		BaseServerRevision: baseRevision,
		Title:              title,
		Body:               []synclegacy.BodySegment{},
		CreatedAt:          1_789_000_000_000,
		UpdatedAt:          1_789_000_000_100,
		Kind:               synclegacy.MutationUpsert,
		ConflictIDs:        []synclegacy.ConflictID{},
	}
}

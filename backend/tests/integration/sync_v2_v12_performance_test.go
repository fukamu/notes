//go:build integration && v12benchmark

package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/syncv2"
	"github.com/fukamu/notes/backend/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	v12SyncEntries        = 10_000
	v12SyncPageSize       = 500
	v12SyncPageCount      = 20
	v12SyncRuns           = 5
	v12SyncWarmups        = 3
	v12SyncConcurrent     = 100
	v12SyncPoolLimit      = int32(16)
	v12SyncOutputFileName = "migration-v12-sync-v2.json"
	v12SyncOwnedMarker    = "fukamu-notes-v12-owned-v1\n"
)

type v12SyncObservation struct {
	Operation            string  `json:"operation"`
	DurationMilliseconds float64 `json:"durationMilliseconds"`
	Status               int     `json:"status"`
	ResponseBytes        int     `json:"responseBytes"`
	QueryCount           int64   `json:"queryCount"`
	RSSBytes             int64   `json:"rssBytes"`
	PSSBytes             int64   `json:"pssBytes"`
	ResponseDigest       string  `json:"responseDigest"`
}

type v12SyncTraversal struct {
	ColdPageEntryCounts []int  `json:"coldPageEntryCounts"`
	WarmPageEntryCounts []int  `json:"warmPageEntryCounts"`
	ColdUniqueEntries   int    `json:"coldUniqueEntries"`
	WarmUniqueEntries   int    `json:"warmUniqueEntries"`
	DuplicateEntries    int    `json:"duplicateEntries"`
	MissingEntries      int    `json:"missingEntries"`
	FixedHighWatermark  bool   `json:"fixedHighWatermark"`
	DeltaChanges        int    `json:"deltaChanges"`
	ColdDigest          string `json:"coldDigest"`
	WarmDigest          string `json:"warmDigest"`
	DeltaDigest         string `json:"deltaDigest"`
}

type v12SyncRun struct {
	Run           int                  `json:"run"`
	StoreIdentity string               `json:"storeIdentity"`
	Observations  []v12SyncObservation `json:"observations"`
	Traversal     v12SyncTraversal     `json:"traversal"`
}

type v12ConcurrentObservation struct {
	RequestIndex         int     `json:"requestIndex"`
	DurationMilliseconds float64 `json:"durationMilliseconds"`
	Status               int     `json:"status"`
	ResponseBytes        int     `json:"responseBytes"`
	QueryCount           int64   `json:"queryCount"`
}

type v12Concurrency struct {
	Run                            int                        `json:"run"`
	StoreIdentity                  string                     `json:"storeIdentity"`
	Requests                       int                        `json:"requests"`
	BarrierParticipants            int                        `json:"barrierParticipants"`
	IndependentVaults              int                        `json:"independentVaults"`
	IndependentSessions            int                        `json:"independentSessions"`
	IndependentDevices             int                        `json:"independentDevices"`
	PoolLimit                      int                        `json:"poolLimit"`
	ApplicationSerializationShim   bool                       `json:"applicationSerializationShim"`
	MaximumHTTPConcurrency         int                        `json:"maximumHTTPConcurrency"`
	AdmittedApplicationConcurrency int                        `json:"admittedApplicationConcurrency"`
	MaximumApplicationConcurrency  int                        `json:"maximumApplicationConcurrency"`
	MaximumDatabaseConcurrency     int                        `json:"maximumDatabaseConcurrency"`
	TenantScopeViolations          int                        `json:"tenantScopeViolations"`
	ErrorCount                     int                        `json:"errorCount"`
	DurableCommits                 int                        `json:"durableCommits"`
	DurableCards                   int                        `json:"durableCards"`
	EncryptedMetadataRows          int                        `json:"encryptedMetadataRows"`
	QuotaCommittedReservations     int                        `json:"quotaCommittedReservations"`
	ObjectWrites                   int                        `json:"objectWrites"`
	Encryptions                    int                        `json:"encryptions"`
	DurationMilliseconds           float64                    `json:"durationMilliseconds"`
	RSSBytes                       int64                      `json:"rssBytes"`
	PSSBytes                       int64                      `json:"pssBytes"`
	Observations                   []v12ConcurrentObservation `json:"observations"`
}

type v12SyncFragment struct {
	SchemaVersion int              `json:"schemaVersion"`
	Runs          []v12SyncRun     `json:"runs"`
	Concurrency   []v12Concurrency `json:"concurrency"`
}

type v12QueryCounterKey struct{}

type v12PGXTracer struct {
	inFlight atomic.Int64
	maximum  atomic.Int64
}

func (tracer *v12PGXTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	if counter, ok := ctx.Value(v12QueryCounterKey{}).(*atomic.Int64); ok {
		counter.Add(1)
	}
	current := tracer.inFlight.Add(1)
	v12Maximum(&tracer.maximum, current)
	return ctx
}

func (tracer *v12PGXTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {
	tracer.inFlight.Add(-1)
}

func (tracer *v12PGXTracer) TraceBatchStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceBatchStartData) context.Context {
	current := tracer.inFlight.Add(1)
	v12Maximum(&tracer.maximum, current)
	return ctx
}

func (*v12PGXTracer) TraceBatchQuery(ctx context.Context, _ *pgx.Conn, _ pgx.TraceBatchQueryData) {
	if counter, ok := ctx.Value(v12QueryCounterKey{}).(*atomic.Int64); ok {
		counter.Add(1)
	}
}

func (tracer *v12PGXTracer) TraceBatchEnd(context.Context, *pgx.Conn, pgx.TraceBatchEndData) {
	tracer.inFlight.Add(-1)
}

func TestSyncV2V12PerformanceEvidence(t *testing.T) {
	if os.Getenv("FUKAMU_V12_PERFORMANCE_MODE") != "local-go-postgres" {
		t.Fatal("FUKAMU_V12_PERFORMANCE_MODE=local-go-postgres is required")
	}
	outputPath := os.Getenv("FUKAMU_V12_SYNC_OUTPUT")
	outputDirectory := filepath.Dir(outputPath)
	info, directoryErr := os.Stat(outputDirectory)
	marker, markerErr := os.ReadFile(filepath.Join(outputDirectory, ".fukamu-v12-owned"))
	if filepath.Dir(outputDirectory) != os.TempDir() ||
		!strings.HasPrefix(filepath.Base(outputDirectory), "fukamu-v12-") ||
		filepath.Base(outputPath) != v12SyncOutputFileName || directoryErr != nil ||
		!info.IsDir() || info.Mode().Perm() != 0o700 || markerErr != nil || string(marker) != v12SyncOwnedMarker {
		t.Fatal("FUKAMU_V12_SYNC_OUTPUT must be inside a fresh owned 0700 /tmp directory")
	}
	if _, err := os.Lstat(outputPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("V12 Sync output must not already exist")
	}
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("unsafe local test database: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Minute)
	defer cancel()
	fragment := v12SyncFragment{
		SchemaVersion: 1,
		Runs:          make([]v12SyncRun, 0, v12SyncRuns),
		Concurrency:   make([]v12Concurrency, 0, v12SyncRuns),
	}
	for run := 1; run <= v12SyncRuns; run++ {
		fragment.Runs = append(fragment.Runs, runV12Traversal(t, ctx, databaseURL, run))
	}
	for run := 1; run <= v12SyncRuns; run++ {
		fragment.Concurrency = append(fragment.Concurrency, runV12Concurrency(t, ctx, databaseURL, run))
	}
	encoded, err := json.MarshalIndent(fragment, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	encoded = append(encoded, '\n')
	file, err := os.OpenFile(outputPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(encoded); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func runV12Traversal(t *testing.T, ctx context.Context, databaseURL string, run int) v12SyncRun {
	t.Helper()
	pool, _, storeIdentity := openV12TracedDatabase(t, ctx, databaseURL)
	defer pool.Close()
	cursors, err := syncv2.NewCursorAuthenticator(bytes.Repeat([]byte{byte(0x70 + run)}, 32))
	if err != nil {
		t.Fatal(err)
	}
	users := seedServerLoadUserCount(t, ctx, pool, cursors, 1)
	user := users[0]
	harness := newServerLoadHarness(t, pool, cursors, users[:1])
	seedV12Cards(t, ctx, harness.application, user, run)

	cold := measureV12Traversal(t, ctx, harness.application, user, "cold-full-sync", run)
	for warmup := 0; warmup < v12SyncWarmups; warmup++ {
		_ = measureV12Traversal(t, ctx, harness.application, user, "warmup", run)
	}
	warm := measureV12Traversal(t, ctx, harness.application, user, "warm-full-sync", run)
	if cold.digest != warm.digest {
		t.Fatalf("run %d cold/warm digest mismatch", run)
	}
	delta := measureV12Delta(t, ctx, harness.application, user, run, cold.terminalCursor)
	return v12SyncRun{
		Run: run, StoreIdentity: storeIdentity,
		Observations: []v12SyncObservation{cold.observation, warm.observation, delta.observation},
		Traversal: v12SyncTraversal{
			ColdPageEntryCounts: cold.pageCounts, WarmPageEntryCounts: warm.pageCounts,
			ColdUniqueEntries: cold.uniqueEntries, WarmUniqueEntries: warm.uniqueEntries,
			DuplicateEntries:   cold.duplicates + warm.duplicates,
			MissingEntries:     (v12SyncEntries - cold.uniqueEntries) + (v12SyncEntries - warm.uniqueEntries),
			FixedHighWatermark: cold.fixedHighWatermark && warm.fixedHighWatermark,
			DeltaChanges:       delta.changeCount, ColdDigest: cold.digest, WarmDigest: warm.digest,
			DeltaDigest: delta.digest,
		},
	}
}

func openV12TracedDatabase(
	t *testing.T,
	ctx context.Context,
	databaseURL string,
) (*pgxpool.Pool, *v12PGXTracer, string) {
	t.Helper()
	database, err := postgresadapter.OpenSQL(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, "DROP SCHEMA public CASCADE"); err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, "CREATE SCHEMA public"); err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	migrator, err := postgresadapter.NewMigrator(database, migrations.Files)
	if err != nil || migrator.Up(ctx) != nil {
		_ = database.Close()
		t.Fatal("apply V12 migrations")
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	configuration, err := postgresadapter.PoolConfiguration(databaseURL, v12SyncPoolLimit)
	if err != nil {
		t.Fatal(err)
	}
	tracer := &v12PGXTracer{}
	configuration.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(ctx, configuration)
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	var databaseOID uint32
	var schemaOID uint32
	if err := pool.QueryRow(ctx, `
		SELECT database.oid, namespace.oid
		  FROM pg_database database
		 CROSS JOIN pg_namespace namespace
		 WHERE database.datname = current_database()
		   AND namespace.nspname = 'public'`).Scan(&databaseOID, &schemaOID); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	return pool, tracer, "store-" + v12Digest(fmt.Sprintf("postgres-db-%d-schema-%d", databaseOID, schemaOID))
}

func seedV12Cards(
	t *testing.T,
	ctx context.Context,
	application *syncv2.Application,
	user serverLoadUser,
	run int,
) {
	t.Helper()
	var cursor *syncv2.Cursor
	for page := 0; page < v12SyncPageCount; page++ {
		mutations := make([]syncv2.Mutation, v12SyncPageSize)
		for offset := range v12SyncPageSize {
			index := page*v12SyncPageSize + offset
			mutations[offset] = v12SyncMutation(t, run, index, nil, fmt.Sprintf("v12-sync-%05d", index), 1_000+int64(index))
		}
		result, err := application.Synchronize(ctx, syncv2.SynchronizeInput{
			Context:        v12Context(t, user, 0),
			Request:        syncv2.Request{DeviceID: user.deviceID, Cursor: cursor, Mutations: mutations},
			SynchronizedAt: 20_000 + int64(page), RequestBytes: 100_000,
			Limits: entitlement.PaidPersonalVaultLimits(),
		})
		if err != nil || result.Kind != syncv2.ApplicationSynchronized || len(result.Response.Receipts) != v12SyncPageSize {
			t.Fatalf("seed V12 page %d = %s receipts=%d err=%v", page, result.Kind, len(result.Response.Receipts), err)
		}
		next := result.Response.Page.NextCursor
		cursor = &next
	}
}

type v12TraversalResult struct {
	observation        v12SyncObservation
	pageCounts         []int
	uniqueEntries      int
	duplicates         int
	fixedHighWatermark bool
	digest             string
	terminalCursor     syncv2.Cursor
}

func measureV12Traversal(
	t *testing.T,
	ctx context.Context,
	application *syncv2.Application,
	user serverLoadUser,
	operation string,
	run int,
) v12TraversalResult {
	t.Helper()
	counter := &atomic.Int64{}
	measuredContext := context.WithValue(ctx, v12QueryCounterKey{}, counter)
	started := time.Now()
	var cursor *syncv2.Cursor
	var highWatermark syncv2.Sequence
	pageCounts := make([]int, 0, v12SyncPageCount)
	identities := make([]string, 0, v12SyncEntries)
	seen := make(map[string]struct{}, v12SyncEntries)
	duplicates := 0
	responseBytes := 0
	fixed := true
	var terminal syncv2.Cursor
	for page := 0; page < v12SyncPageCount; page++ {
		result, err := application.Synchronize(measuredContext, syncv2.SynchronizeInput{
			Context:        v12Context(t, user, 0),
			Request:        syncv2.Request{DeviceID: user.deviceID, Cursor: cursor, Mutations: []syncv2.Mutation{}},
			SynchronizedAt: 40_000 + int64(run), RequestBytes: 100,
			Limits: entitlement.PaidPersonalVaultLimits(),
		})
		if err != nil || result.Kind != syncv2.ApplicationSynchronized {
			t.Fatalf("%s page %d failed: %s %v", operation, page, result.Kind, err)
		}
		if page == 0 {
			highWatermark = result.Response.HighWatermark
		} else if result.Response.HighWatermark != highWatermark {
			fixed = false
		}
		pageCounts = append(pageCounts, len(result.Response.Changes))
		for _, change := range result.Response.Changes {
			identity := v12ChangeIdentity(t, change)
			if _, duplicate := seen[identity]; duplicate {
				duplicates++
			}
			seen[identity] = struct{}{}
			identities = append(identities, identity)
		}
		encoded, err := json.Marshal(result.Response)
		if err != nil {
			t.Fatal(err)
		}
		responseBytes += len(encoded)
		terminal = result.Response.Page.NextCursor
		cursor = &terminal
	}
	duration := time.Since(started)
	sort.Strings(identities)
	memory := readV12ProcessMemory(t)
	digest := v12Digest(strings.Join(identities, "\n"))
	return v12TraversalResult{
		observation: v12SyncObservation{
			Operation: operation, DurationMilliseconds: v12Milliseconds(duration), Status: 200,
			ResponseBytes: responseBytes, QueryCount: counter.Load(), RSSBytes: memory.rss,
			PSSBytes: memory.pss, ResponseDigest: digest,
		},
		pageCounts: pageCounts, uniqueEntries: len(seen), duplicates: duplicates,
		fixedHighWatermark: fixed, digest: digest, terminalCursor: terminal,
	}
}

type v12DeltaResult struct {
	observation v12SyncObservation
	changeCount int
	digest      string
}

func measureV12Delta(
	t *testing.T,
	ctx context.Context,
	application *syncv2.Application,
	user serverLoadUser,
	run int,
	terminalCursor syncv2.Cursor,
) v12DeltaResult {
	t.Helper()
	revision := syncv2.Revision(1)
	mutation := v12SyncMutation(t, run, 0, &revision, "v12-sync-delta", 80_000+int64(run))
	deltaMutationID, err := syncv2.ParseMutationID(serverLoadUUID(0x780_000+run*0x20_000, 0))
	if err != nil {
		t.Fatal(err)
	}
	mutation.MutationID = deltaMutationID
	mutationResult, err := application.Synchronize(ctx, syncv2.SynchronizeInput{
		Context:        v12Context(t, user, 0),
		Request:        syncv2.Request{DeviceID: user.deviceID, Mutations: []syncv2.Mutation{mutation}},
		SynchronizedAt: 80_000 + int64(run), RequestBytes: 1_000,
		Limits: entitlement.PaidPersonalVaultLimits(),
	})
	if err != nil || mutationResult.Kind != syncv2.ApplicationSynchronized {
		t.Fatalf("delta mutation = %s (%s), %v", mutationResult.Kind, mutationResult.Reason, err)
	}
	counter := &atomic.Int64{}
	measuredContext := context.WithValue(ctx, v12QueryCounterKey{}, counter)
	started := time.Now()
	result, err := application.Synchronize(measuredContext, syncv2.SynchronizeInput{
		Context:        v12Context(t, user, 0),
		Request:        syncv2.Request{DeviceID: user.deviceID, Cursor: &terminalCursor, Mutations: []syncv2.Mutation{}},
		SynchronizedAt: 90_000 + int64(run), RequestBytes: 100,
		Limits: entitlement.PaidPersonalVaultLimits(),
	})
	duration := time.Since(started)
	if err != nil || result.Kind != syncv2.ApplicationSynchronized || len(result.Response.Changes) != 1 {
		t.Fatalf("delta read = %s changes=%d, %v", result.Kind, len(result.Response.Changes), err)
	}
	encoded, err := json.Marshal(result.Response)
	if err != nil {
		t.Fatal(err)
	}
	memory := readV12ProcessMemory(t)
	digest := v12Digest(v12ChangeIdentity(t, result.Response.Changes[0]))
	return v12DeltaResult{
		observation: v12SyncObservation{
			Operation: "delta-1", DurationMilliseconds: v12Milliseconds(duration), Status: 200,
			ResponseBytes: len(encoded), QueryCount: counter.Load(), RSSBytes: memory.rss,
			PSSBytes: memory.pss, ResponseDigest: digest,
		},
		changeCount: 1, digest: digest,
	}
}

func runV12Concurrency(
	t *testing.T,
	ctx context.Context,
	databaseURL string,
	run int,
) v12Concurrency {
	t.Helper()
	pool, tracer, storeIdentity := openV12TracedDatabase(t, ctx, databaseURL)
	defer pool.Close()
	cursors, err := syncv2.NewCursorAuthenticator(bytes.Repeat([]byte{byte(0x80 + run)}, 32))
	if err != nil {
		t.Fatal(err)
	}
	users := seedServerLoadUserCount(t, ctx, pool, cursors, v12SyncConcurrent)
	seedV12ConcurrentRuntimeState(t, ctx, pool, users)
	harness := newServerLoadHarness(t, pool, cursors, users)
	barrier := newV12BarrierApplication(harness.application, users)
	runtime := &httpapi.SyncV2Runtime{
		ExpectedOrigin: serverLoadExpectedOrigin, Clock: func() int64 { return serverLoadSynchronizedAt },
		Sessions: harness.sessions, Admission: allowVaultAdmission{},
		Entitlement: serverLoadEntitlement{}, Application: barrier,
	}
	handler, err := httpapi.NewSyncV2ContractHandler(runtime, harness.logger)
	if err != nil {
		t.Fatal(err)
	}
	metrics := newV12HTTPMetrics(handler)
	server := httptest.NewServer(metrics)
	defer server.Close()
	tracer.maximum.Store(0)
	if tracer.inFlight.Load() != 0 {
		t.Fatal("database queries still in flight before concurrency measurement")
	}
	objectsBefore := harness.objects.Calls()
	encryptionBefore := harness.encryption.snapshot()
	type result struct {
		index    int
		status   int
		bytes    int
		body     []byte
		duration time.Duration
		err      error
	}
	ready := make(chan struct{}, v12SyncConcurrent)
	release := make(chan struct{})
	results := make(chan result, v12SyncConcurrent)
	started := time.Now()
	for index, user := range users {
		go func(index int, user serverLoadUser) {
			ready <- struct{}{}
			<-release
			request, requestErr := http.NewRequestWithContext(
				ctx,
				http.MethodPost,
				server.URL+"/api/v2/sync",
				strings.NewReader(v12ConcurrentMutationRequest(user, run, index)),
			)
			if requestErr != nil {
				results <- result{index: index, err: requestErr}
				return
			}
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Cookie", identity.SessionCookieName+"="+string(user.token))
			request.Header.Set("Origin", serverLoadExpectedOrigin)
			request.Header.Set("Sec-Fetch-Site", "same-origin")
			request.Header.Set("X-Fukamu-V12-Request-Index", strconv.Itoa(index))
			requestStarted := time.Now()
			response, responseErr := server.Client().Do(request)
			if responseErr != nil {
				results <- result{index: index, duration: time.Since(requestStarted), err: responseErr}
				return
			}
			body, readErr := readV12Response(response)
			results <- result{
				index: index, status: response.StatusCode, bytes: len(body), body: body,
				duration: time.Since(requestStarted), err: readErr,
			}
		}(index, user)
	}
	for range v12SyncConcurrent {
		<-ready
	}
	close(release)
	barrier.waitAndRelease(t)
	observations := make([]v12ConcurrentObservation, v12SyncConcurrent)
	errorsFound := 0
	statusCounts := make(map[int]int)
	for range v12SyncConcurrent {
		result := <-results
		statusCounts[result.status]++
		if result.err != nil || result.status != http.StatusOK {
			errorsFound++
		} else {
			assertV12ConcurrentResponse(t, result.index, run, result.body)
		}
		observations[result.index] = v12ConcurrentObservation{
			RequestIndex: result.index, DurationMilliseconds: v12Milliseconds(result.duration),
			Status: result.status, ResponseBytes: result.bytes, QueryCount: metrics.queryCount(result.index),
		}
	}
	if errorsFound != 0 {
		t.Fatalf(
			"V12 concurrent requests failed: errors=%d statuses=%v rejections=%v",
			errorsFound,
			statusCounts,
			barrier.snapshot().rejections,
		)
	}
	duration := time.Since(started)
	memory := readV12ProcessMemory(t)
	stats := barrier.snapshot()
	measuredPoolLimit := pool.Stat().MaxConns()
	measuredPoolAcquired := pool.Stat().AcquiredConns()
	httpInFlight := metrics.inFlight.Load()
	databaseInFlight := tracer.inFlight.Load()
	pool.Close()
	verificationPool, err := postgresadapter.OpenPool(ctx, databaseURL, v12SyncPoolLimit)
	if err != nil {
		t.Fatal(err)
	}
	defer verificationPool.Close()
	durableCommits := v12CountRows(t, ctx, verificationPool, "SELECT COUNT(*) FROM vault_sync_v2_commits")
	durableCards := v12CountRows(t, ctx, verificationPool, "SELECT COUNT(*) FROM vault_sync_v2_cards")
	encryptedMetadata := v12CountRows(t, ctx, verificationPool, "SELECT COUNT(*) FROM vault_encrypted_objects")
	quotaCommitted := v12CountRows(t, ctx, verificationPool, "SELECT COUNT(*) FROM vault_quota_reservations WHERE state = 'committed'")
	expectedObjectKeys := v12AssertOwnedRows(t, ctx, verificationPool, users, run)
	v12AssertObjectKeys(t, ctx, harness, expectedObjectKeys)
	objectsAfter := harness.objects.Calls()
	encryptionAfter := harness.encryption.snapshot()
	objectWrites := objectsAfter.Put - objectsBefore.Put
	encryptions := encryptionAfter.Encrypt - encryptionBefore.Encrypt
	if measuredPoolLimit != v12SyncPoolLimit || stats.maximumAdmitted != v12SyncConcurrent ||
		stats.maximumInner < 2 || stats.maximumInner > v12SyncConcurrent ||
		stats.inFlight != 0 || stats.innerInFlight != 0 || httpInFlight != 0 ||
		databaseInFlight != 0 || measuredPoolAcquired != 0 ||
		stats.tenantViolations != 0 || errorsFound != 0 || metrics.maximum.Load() != v12SyncConcurrent ||
		tracer.maximum.Load() < 1 || tracer.maximum.Load() > int64(v12SyncPoolLimit) ||
		durableCommits != v12SyncConcurrent || durableCards != v12SyncConcurrent ||
		encryptedMetadata != v12SyncConcurrent || quotaCommitted != v12SyncConcurrent ||
		objectWrites != v12SyncConcurrent || encryptions != v12SyncConcurrent {
		t.Fatalf(
			"invalid V12 concurrency: pool=%d app=%d tenant=%d errors=%d http=%d db=%d commits=%d cards=%d metadata=%d quota=%d writes=%d encryptions=%d",
			measuredPoolLimit, stats.maximumInner, stats.tenantViolations, errorsFound,
			metrics.maximum.Load(), tracer.maximum.Load(), durableCommits, durableCards,
			encryptedMetadata, quotaCommitted, objectWrites, encryptions,
		)
	}
	return v12Concurrency{
		Run: run, StoreIdentity: storeIdentity, Requests: v12SyncConcurrent,
		BarrierParticipants: v12SyncConcurrent, IndependentVaults: v12SyncConcurrent,
		IndependentSessions: v12SyncConcurrent, IndependentDevices: v12SyncConcurrent,
		PoolLimit: int(v12SyncPoolLimit), ApplicationSerializationShim: false,
		MaximumHTTPConcurrency:         int(metrics.maximum.Load()),
		AdmittedApplicationConcurrency: stats.maximumAdmitted,
		MaximumApplicationConcurrency:  stats.maximumInner,
		MaximumDatabaseConcurrency:     int(tracer.maximum.Load()),
		TenantScopeViolations:          stats.tenantViolations, ErrorCount: errorsFound,
		DurableCommits: durableCommits, DurableCards: durableCards,
		EncryptedMetadataRows: encryptedMetadata, QuotaCommittedReservations: quotaCommitted,
		ObjectWrites: objectWrites, Encryptions: encryptions,
		DurationMilliseconds: v12Milliseconds(duration), RSSBytes: memory.rss, PSSBytes: memory.pss,
		Observations: observations,
	}
}

func seedV12ConcurrentRuntimeState(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	users []serverLoadUser,
) {
	t.Helper()
	stateRows := make([][]any, len(users))
	quotaRows := make([][]any, len(users))
	for index, user := range users {
		vaultContext := v12Context(t, user, index)
		stateRows[index] = []any{
			string(vaultContext.AccountID), string(vaultContext.VaultID), int64(1), int64(1),
		}
		quotaRows[index] = []any{
			string(vaultContext.AccountID), string(vaultContext.VaultID), int64(1),
			int64(0), int64(0), nil, int64(1_000), int64(1_000),
		}
	}
	transaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	copyServerLoadRows(t, ctx, transaction, "vault_sync_v2_states", []string{
		"account_id", "vault_id", "next_display_id", "next_change_sequence",
	}, stateRows)
	copyServerLoadRows(t, ctx, transaction, "vault_quota_usage", []string{
		"account_id", "vault_id", "revision", "active_cards", "plaintext_bytes",
		"last_transition_reservation_id", "created_at", "updated_at",
	}, quotaRows)
	if err := transaction.Commit(ctx); err != nil {
		t.Fatalf("commit V12 concurrent runtime state: %v", err)
	}
}

type v12HTTPMetrics struct {
	inner    http.Handler
	inFlight atomic.Int64
	maximum  atomic.Int64
	mutex    sync.Mutex
	queries  map[int]int64
}

func newV12HTTPMetrics(inner http.Handler) *v12HTTPMetrics {
	return &v12HTTPMetrics{inner: inner, queries: make(map[int]int64, v12SyncConcurrent)}
}

func (metrics *v12HTTPMetrics) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	index, err := strconv.Atoi(request.Header.Get("X-Fukamu-V12-Request-Index"))
	if err != nil || index < 0 || index >= v12SyncConcurrent {
		http.Error(writer, "invalid V12 request index", http.StatusBadRequest)
		return
	}
	counter := &atomic.Int64{}
	current := metrics.inFlight.Add(1)
	v12Maximum(&metrics.maximum, current)
	defer metrics.inFlight.Add(-1)
	metrics.inner.ServeHTTP(
		writer,
		request.WithContext(context.WithValue(request.Context(), v12QueryCounterKey{}, counter)),
	)
	metrics.mutex.Lock()
	metrics.queries[index] = counter.Load()
	metrics.mutex.Unlock()
}

func (metrics *v12HTTPMetrics) queryCount(index int) int64 {
	metrics.mutex.Lock()
	defer metrics.mutex.Unlock()
	return metrics.queries[index]
}

func readV12Response(response *http.Response) ([]byte, error) {
	defer func() { _ = response.Body.Close() }()
	return io.ReadAll(response.Body)
}

func v12ConcurrentMutationRequest(user serverLoadUser, run int, index int) string {
	mutationID := serverLoadUUID(0x900_000+run*0x1_000, index)
	cardID := serverLoadUUID(0xa00_000+run*0x1_000, index)
	return `{"version":"sync/v2","deviceId":"` + string(user.deviceID) +
		`","cursor":null,"mutations":[{"mutationId":"` + mutationID + `","cardId":"` +
		cardID + `","baseServerRevision":null,"title":"V12 concurrent ` + strconv.Itoa(index) +
		`","body":[{"type":"text","text":"deterministic local V12"}],"createdAt":1400,"updatedAt":1400,"kind":"upsert","conflictIds":[]}]}`
}

func assertV12ConcurrentResponse(t *testing.T, index int, run int, body []byte) {
	t.Helper()
	var response struct {
		Changes []struct {
			Card struct {
				ID string `json:"id"`
			} `json:"card"`
		} `json:"changes"`
		Receipts []struct {
			MutationID string `json:"mutationId"`
		} `json:"receipts"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("concurrent response %d decode: %v", index, err)
	}
	wantMutation := serverLoadUUID(0x900_000+run*0x1_000, index)
	wantCard := serverLoadUUID(0xa00_000+run*0x1_000, index)
	if len(response.Receipts) != 1 || len(response.Changes) != 1 ||
		response.Receipts[0].MutationID != wantMutation || response.Changes[0].Card.ID != wantCard {
		t.Fatalf("concurrent response %d lacks one bound receipt/change", index)
	}
}

func v12CountRows(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	query string,
) int {
	t.Helper()
	var count int
	if err := pool.QueryRow(ctx, query).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func v12AssertOwnedRows(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	users []serverLoadUser,
	run int,
) map[string]struct{} {
	t.Helper()
	objectKeys := make(map[string]struct{}, len(users))
	for index, user := range users {
		vaultContext := v12Context(t, user, index)
		accountID := string(vaultContext.AccountID)
		sessionID := string(vaultContext.SessionID)
		mutationID := serverLoadUUID(0x900_000+run*0x1_000, index)
		cardID := serverLoadUUID(0xa00_000+run*0x1_000, index)
		var objectKey string
		err := pool.QueryRow(ctx, `
				SELECT encrypted.object_key
				  FROM accounts account
				  JOIN personal_vaults vault
				    ON vault.account_id = account.account_id
				  JOIN sessions session
				    ON session.account_id = account.account_id
				   AND session.vault_id = vault.vault_id
				  JOIN vault_sync_v2_commits commit_row
				    ON commit_row.account_id = account.account_id
				   AND commit_row.vault_id = vault.vault_id
				  JOIN vault_sync_v2_cards card
				    ON card.account_id = account.account_id
				   AND card.vault_id = vault.vault_id
				   AND card.card_id = commit_row.card_id
				   AND card.revision = commit_row.applied_revision
				  JOIN vault_sync_v2_changes change_row
				    ON change_row.account_id = account.account_id
				   AND change_row.vault_id = vault.vault_id
				   AND change_row.card_id = card.card_id
				   AND change_row.revision = card.revision
				  JOIN vault_encrypted_objects encrypted
				    ON encrypted.vault_id = vault.vault_id
				   AND encrypted.object_type = 'card'
				   AND encrypted.object_id = card.card_id
				   AND encrypted.object_revision = card.revision
				  JOIN vault_quota_reservations reservation
				    ON reservation.account_id = account.account_id
				   AND reservation.vault_id = vault.vault_id
				   AND reservation.reservation_id = commit_row.mutation_id
				 WHERE account.account_id = $1
				   AND vault.vault_id = $2
				   AND session.session_id = $3
				   AND commit_row.mutation_id = $4
				   AND commit_row.card_id = $5
				   AND reservation.card_id = $5
				   AND reservation.state = 'committed'`,
			accountID,
			string(user.vaultID),
			sessionID,
			mutationID,
			cardID,
		).Scan(&objectKey)
		if err != nil || objectKey == "" {
			t.Fatalf("concurrent ownership row %d missing or cross-tenant: %v", index, err)
		}
		if _, duplicate := objectKeys[objectKey]; duplicate {
			t.Fatalf("concurrent ownership row %d reused object key", index)
		}
		objectKeys[objectKey] = struct{}{}
	}
	return objectKeys
}

func v12AssertObjectKeys(
	t *testing.T,
	ctx context.Context,
	harness *serverLoadHarness,
	expected map[string]struct{},
) {
	t.Helper()
	descriptors, err := harness.objects.List(ctx)
	if err != nil || len(descriptors) != len(expected) {
		t.Fatalf("V12 object list = %d, expected %d: %v", len(descriptors), len(expected), err)
	}
	for _, descriptor := range descriptors {
		if _, found := expected[string(descriptor.ObjectKey)]; !found {
			t.Fatalf("V12 object key %q lacks exact tenant metadata", descriptor.ObjectKey)
		}
	}
}

type v12BarrierApplication struct {
	inner         httpapi.SyncV2Application
	expected      map[syncv2.DeviceID]identity.VaultID
	ready         chan struct{}
	release       chan struct{}
	releaseOnce   sync.Once
	mutex         sync.Mutex
	inFlight      int
	maximum       int
	innerInFlight int
	innerMaximum  int
	tenant        int
	rejections    map[syncv2.ApplicationRejectionReason]int
}

type v12BarrierStats struct {
	maximumAdmitted  int
	maximumInner     int
	inFlight         int
	innerInFlight    int
	tenantViolations int
	rejections       map[syncv2.ApplicationRejectionReason]int
}

func newV12BarrierApplication(inner httpapi.SyncV2Application, users []serverLoadUser) *v12BarrierApplication {
	expected := make(map[syncv2.DeviceID]identity.VaultID, len(users))
	for _, user := range users {
		expected[user.deviceID] = user.vaultID
	}
	return &v12BarrierApplication{
		inner: inner, expected: expected, ready: make(chan struct{}, len(users)), release: make(chan struct{}),
		rejections: make(map[syncv2.ApplicationRejectionReason]int),
	}
}

func (application *v12BarrierApplication) Synchronize(ctx context.Context, input syncv2.SynchronizeInput) (syncv2.ApplicationResult, error) {
	application.mutex.Lock()
	application.inFlight++
	if application.inFlight > application.maximum {
		application.maximum = application.inFlight
	}
	if application.expected[input.Request.DeviceID] != input.Context.VaultID {
		application.tenant++
	}
	application.mutex.Unlock()
	application.ready <- struct{}{}
	<-application.release
	application.mutex.Lock()
	application.innerInFlight++
	if application.innerInFlight > application.innerMaximum {
		application.innerMaximum = application.innerInFlight
	}
	application.mutex.Unlock()
	result, err := application.inner.Synchronize(ctx, input)
	application.mutex.Lock()
	if result.Kind == syncv2.ApplicationRejected {
		application.rejections[result.Reason]++
	}
	application.innerInFlight--
	application.inFlight--
	application.mutex.Unlock()
	return result, err
}

func (application *v12BarrierApplication) waitAndRelease(t *testing.T) {
	t.Helper()
	released := false
	defer func() {
		if !released {
			application.releaseAll()
		}
	}()
	for range v12SyncConcurrent {
		select {
		case <-application.ready:
		case <-time.After(30 * time.Second):
			t.Fatal("application barrier did not receive 100 participants")
		}
	}
	application.releaseAll()
	released = true
}

func (application *v12BarrierApplication) releaseAll() {
	application.releaseOnce.Do(func() { close(application.release) })
}

func (application *v12BarrierApplication) snapshot() v12BarrierStats {
	application.mutex.Lock()
	defer application.mutex.Unlock()
	rejections := make(map[syncv2.ApplicationRejectionReason]int, len(application.rejections))
	for reason, count := range application.rejections {
		rejections[reason] = count
	}
	return v12BarrierStats{
		maximumAdmitted:  application.maximum,
		maximumInner:     application.innerMaximum,
		inFlight:         application.inFlight,
		innerInFlight:    application.innerInFlight,
		tenantViolations: application.tenant,
		rejections:       rejections,
	}
}

func v12SyncMutation(t *testing.T, run int, index int, base *syncv2.Revision, title string, updatedAt int64) syncv2.Mutation {
	t.Helper()
	mutationID, err := syncv2.ParseMutationID(serverLoadUUID(0x700_000+run*0x20_000, index))
	if err != nil {
		t.Fatal(err)
	}
	cardID, err := syncv2.ParseCardID(serverLoadUUID(0x800_000+run*0x20_000, index))
	if err != nil {
		t.Fatal(err)
	}
	return syncv2.Mutation{
		MutationID: mutationID, CardID: cardID, BaseServerRevision: base,
		Title: title, Body: []syncv2.BodySegment{{Kind: syncv2.SegmentText, Text: "deterministic local V12"}},
		CreatedAt: 1_000 + int64(index), UpdatedAt: updatedAt,
		Kind: syncv2.MutationUpsert, ConflictIDs: []syncv2.ConflictID{},
	}
}

func v12Context(t *testing.T, user serverLoadUser, index int) identity.VaultContext {
	t.Helper()
	return identity.VaultContext{
		AccountID:    mustServerLoadAccountID(t, serverLoadUUID(0x100_000, index)),
		VaultID:      user.vaultID,
		SessionID:    mustServerLoadSessionID(t, serverLoadUUID(0x300_000, index)),
		SessionEpoch: 1,
	}
}

func v12ChangeIdentity(t *testing.T, change syncv2.HydratedChange) string {
	t.Helper()
	encoded, err := json.Marshal(change)
	if err != nil {
		t.Fatalf("canonicalize hydrated V12 change: %v", err)
	}
	return string(encoded)
}

type v12Memory struct{ rss, pss int64 }

func readV12ProcessMemory(t *testing.T) v12Memory {
	t.Helper()
	content, err := os.ReadFile("/proc/self/smaps_rollup")
	if err != nil {
		t.Fatal(err)
	}
	read := func(name string) int64 {
		for _, line := range strings.Split(string(content), "\n") {
			fields := strings.Fields(line)
			if len(fields) == 3 && fields[0] == name+":" && fields[2] == "kB" {
				value, err := strconv.ParseInt(fields[1], 10, 64)
				if err == nil && value > 0 {
					return value * 1_024
				}
			}
		}
		t.Fatalf("missing %s in smaps_rollup", name)
		return 0
	}
	return v12Memory{rss: read("Rss"), pss: read("Pss")}
}

func v12Milliseconds(duration time.Duration) float64 {
	value, _ := strconv.ParseFloat(fmt.Sprintf("%.3f", float64(duration)/float64(time.Millisecond)), 64)
	return value
}

func v12Maximum(maximum *atomic.Int64, current int64) {
	for {
		observed := maximum.Load()
		if current <= observed || maximum.CompareAndSwap(observed, current) {
			return
		}
	}
}

func v12Digest(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

//go:build integration

package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/fukamu/notes/backend/internal/adapters/contentcrypto"
	"github.com/fukamu/notes/backend/internal/adapters/objectstorage"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/syncv2"
	"github.com/fukamu/notes/backend/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	serverLoadBranchPoint               = "b95a8155efabe4a29ddafb01b62d7190b926c208"
	serverLoadLegacyRevision            = "e8936ab90768774371d84b4808c100d546649943"
	serverLoadExpectedOrigin            = "https://local-go.invalid"
	serverLoadLogicalRequests           = 1_000
	serverLoadPostgresConnections       = int32(16)
	serverLoadSimulatedPartitions       = 16
	serverLoadApplicationLimit          = 1
	serverLoadSynchronizedAt      int64 = 1_500
)

var errServerLoadResponseLost = errors.New("synthetic response loss after durable commit")

type serverLoadScenario string

const (
	serverLoadColdStart         serverLoadScenario = "cold-start"
	serverLoadNormalPoll        serverLoadScenario = "normal-poll"
	serverLoadHotVaultPartition serverLoadScenario = "hot-vault-partition"
	serverLoadResponseLossRetry serverLoadScenario = "response-loss-retry"
)

var serverLoadScenarios = [...]serverLoadScenario{
	serverLoadColdStart,
	serverLoadNormalPoll,
	serverLoadHotVaultPartition,
	serverLoadResponseLossRetry,
}

type serverLoadObservation struct {
	Scenario                   serverLoadScenario `json:"scenario"`
	LogicalRequests            int                `json:"logicalRequests"`
	HTTPAttempts               int                `json:"httpAttempts"`
	SuccessfulResponses        int                `json:"successfulResponses"`
	UnavailableResponses       int                `json:"unavailableResponses"`
	MaximumInFlight            int                `json:"maximumInFlight"`
	MaximumApplicationInFlight int                `json:"maximumApplicationInFlight"`
	HandlerInstances           int                `json:"handlerInstances"`
	UniqueVaults               int                `json:"uniqueVaults"`
	UniquePartitions           int                `json:"uniquePartitions"`
	TenantViolations           int                `json:"tenantViolations"`
	ApplicationCalls           int                `json:"applicationCalls"`
	UniqueMutationCommits      int                `json:"uniqueMutationCommits"`
	MutationReplays            int                `json:"mutationReplays"`
	ObjectReads                int                `json:"objectReads"`
	ObjectWrites               int                `json:"objectWrites"`
	KMSEncryptions             int                `json:"kmsEncryptions"`
	KMSDecryptions             int                `json:"kmsDecryptions"`
}

type serverLoadEvidence struct {
	SchemaVersion           int                     `json:"schemaVersion"`
	Issue                   int                     `json:"issue"`
	BranchPoint             string                  `json:"branchPoint"`
	LegacyReferenceRevision string                  `json:"legacyReferenceRevision"`
	Safety                  serverLoadSafety        `json:"safety"`
	Methodology             serverLoadMethodology   `json:"methodology"`
	Observations            []serverLoadObservation `json:"observations"`
}

type serverLoadSafety struct {
	ExecutionMode      string `json:"executionMode"`
	DatabaseHostPolicy string `json:"databaseHostPolicy"`
	ExternalAdapters   string `json:"externalAdapters"`
	RemoteTargetUsed   bool   `json:"remoteTargetUsed"`
	CredentialUsed     bool   `json:"credentialUsed"`
}

type serverLoadMethodology struct {
	Command                 string `json:"command"`
	LogicalRequests         int    `json:"logicalRequests"`
	PostgresMaxConnections  int    `json:"postgresMaxConnections"`
	SimulatedPartitions     int    `json:"simulatedPartitions"`
	ApplicationConcurrency  int    `json:"applicationConcurrency"`
	TimingPolicy            string `json:"timingPolicy"`
	MemoryPolicy            string `json:"memoryPolicy"`
	ResponseLossFailureMode string `json:"responseLossFailureMode"`
}

type serverLoadUser struct {
	token        identity.SessionToken
	vaultID      identity.VaultID
	deviceID     syncv2.DeviceID
	commitCursor syncv2.Cursor
}

type serverLoadHarness struct {
	pool        *pgxpool.Pool
	sessions    identity.SessionResolver
	cursors     *syncv2.CursorAuthenticator
	application *syncv2.Application
	objects     *objectstorage.Memory
	encryption  *serverLoadEncryption
	logger      *slog.Logger
	expected    map[syncv2.DeviceID]identity.VaultID
}

func TestSyncV2GoServerLoadEvidence(t *testing.T) {
	authorizeServerLoadEnvironment(t)
	ctx, pool := openServerLoadDatabase(t)
	cursors, err := syncv2.NewCursorAuthenticator(bytes.Repeat([]byte{0x61}, 32))
	if err != nil {
		t.Fatal(err)
	}
	users := seedServerLoadUsers(t, ctx, pool, cursors)
	harness := newServerLoadHarness(t, pool, cursors, users)
	evidence := readServerLoadEvidence(t)

	if len(evidence.Observations) != len(serverLoadScenarios) {
		t.Fatalf("evidence observations = %d, want %d", len(evidence.Observations), len(serverLoadScenarios))
	}
	for index, scenario := range serverLoadScenarios {
		observed := harness.runScenario(t, ctx, scenario, users)
		if observed != evidence.Observations[index] {
			t.Fatalf("%s observation = %#v, want %#v", scenario, observed, evidence.Observations[index])
		}
	}

	assertServerLoadDurableState(t, ctx, pool)
	if pool.Stat().AcquiredConns() != 0 {
		t.Fatalf("database connections still acquired: %d", pool.Stat().AcquiredConns())
	}
}

func authorizeServerLoadEnvironment(t *testing.T) {
	t.Helper()
	if mode := os.Getenv("FUKAMU_SERVER_LOAD_MODE"); mode != "" && mode != "local-go-postgres" {
		t.Fatalf("server load mode %q is not local-go-postgres", mode)
	}
	for _, name := range []string{"FUKAMU_SERVER_LOAD_TARGET_URL", "FUKAMU_SERVER_LOAD_CREDENTIAL"} {
		if os.Getenv(name) != "" {
			t.Fatalf("server load refuses external setting %s", name)
		}
	}
}

func openServerLoadDatabase(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("NOTES_TEST_DATABASE_URL is required for integration tests")
	}
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("unsafe test database target: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	t.Cleanup(cancel)
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, serverLoadPostgresConnections)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	t.Cleanup(pool.Close)
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
	t.Cleanup(func() { _ = database.Close() })
	migrator, err := postgresadapter.NewMigrator(database, migrations.Files)
	if err != nil {
		t.Fatal(err)
	}
	if err := migrator.Up(ctx); err != nil {
		t.Fatalf("migrate server load database: %v", err)
	}
	return ctx, pool
}

func seedServerLoadUsers(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	cursors *syncv2.CursorAuthenticator,
) []serverLoadUser {
	t.Helper()
	users := make([]serverLoadUser, serverLoadLogicalRequests)
	accountRows := make([][]any, serverLoadLogicalRequests)
	vaultRows := make([][]any, serverLoadLogicalRequests)
	sessionRows := make([][]any, serverLoadLogicalRequests)
	keyringRows := make([][]any, serverLoadLogicalRequests)
	for index := range users {
		accountID := mustServerLoadAccountID(t, serverLoadUUID(0x100_000, index))
		vaultID := mustServerLoadVaultID(t, serverLoadUUID(0x200_000, index))
		sessionID := mustServerLoadSessionID(t, serverLoadUUID(0x300_000, index))
		deviceID := mustServerLoadDeviceID(t, serverLoadUUID(0x400_000, index))
		token := mustServerLoadToken(t, index)
		tokenHash, err := identity.HashSessionToken(token)
		if err != nil {
			t.Fatal(err)
		}
		commitCursor, err := cursors.Issue(syncv2.CursorClaims{
			Version: syncv2.CursorVersion, VaultID: vaultID, DeviceID: deviceID,
			AfterSequence: 1, HighWatermark: 1,
		})
		if err != nil {
			t.Fatal(err)
		}
		users[index] = serverLoadUser{
			token: token, vaultID: vaultID, deviceID: deviceID, commitCursor: commitCursor,
		}
		accountRows[index] = []any{string(accountID), int64(1_000)}
		vaultRows[index] = []any{string(vaultID), string(accountID), int64(1_000)}
		sessionRows[index] = []any{
			string(sessionID), string(accountID), string(vaultID), string(tokenHash),
			int64(1), int64(1_000), int64(10_000),
		}
		keyringRows[index] = []any{
			string(vaultID), int64(1), "kms://local/server-load", "AA", true, int64(1_000),
		}
	}

	transaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	copyServerLoadRows(t, ctx, transaction, "accounts", []string{"account_id", "created_at"}, accountRows)
	copyServerLoadRows(t, ctx, transaction, "personal_vaults", []string{"vault_id", "account_id", "created_at"}, vaultRows)
	copyServerLoadRows(t, ctx, transaction, "sessions", []string{
		"session_id", "account_id", "vault_id", "token_hash", "session_epoch", "issued_at", "expires_at",
	}, sessionRows)
	copyServerLoadRows(t, ctx, transaction, "vault_dek_versions", []string{
		"vault_id", "dek_version", "kek_key_reference", "wrapped_dek", "is_write_key", "created_at",
	}, keyringRows)
	if err := transaction.Commit(ctx); err != nil {
		t.Fatalf("commit server load fixtures: %v", err)
	}
	return users
}

func copyServerLoadRows(
	t *testing.T,
	ctx context.Context,
	transaction pgx.Tx,
	table string,
	columns []string,
	rows [][]any,
) {
	t.Helper()
	count, err := transaction.CopyFrom(ctx, pgx.Identifier{table}, columns, pgx.CopyFromRows(rows))
	if err != nil || count != int64(len(rows)) {
		t.Fatalf("seed %s = %d rows, %v", table, count, err)
	}
}

func newServerLoadHarness(
	t *testing.T,
	pool *pgxpool.Pool,
	cursors *syncv2.CursorAuthenticator,
	users []serverLoadUser,
) *serverLoadHarness {
	t.Helper()
	sessionStore, err := postgresadapter.NewSessionStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	sessions, err := postgresadapter.NewSessionResolver(sessionStore)
	if err != nil {
		t.Fatal(err)
	}
	journalDirectory, err := postgresadapter.NewSyncV2JournalDirectory(pool)
	if err != nil {
		t.Fatal(err)
	}
	metadataDirectory, err := postgresadapter.NewSyncV2MetadataDirectory(pool)
	if err != nil {
		t.Fatal(err)
	}
	quotaDirectory, err := postgresadapter.NewQuotaLedgerDirectory(pool)
	if err != nil {
		t.Fatal(err)
	}
	keyrings, err := postgresadapter.NewVaultDEKStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	objects, err := objectstorage.NewMemory(nil)
	if err != nil {
		t.Fatal(err)
	}
	cryptoService, err := cryptocontent.NewService(
		serverLoadKeyManagement{},
		&serverLoadNonceGenerator{},
		&serverLoadNonceReservations{seen: make(map[string]struct{})},
		contentcrypto.AES256GCM{},
	)
	if err != nil {
		t.Fatal(err)
	}
	encryption := &serverLoadEncryption{base: cryptoService}
	contents, err := syncv2.NewEncryptedContentDirectory(
		metadataDirectory, objects, &serverLoadObjectKeys{}, encryption, keyrings,
	)
	if err != nil {
		t.Fatal(err)
	}
	application, err := syncv2.NewApplication(
		journalDirectory, contents, cursors, quotaDirectory, 60_000,
	)
	if err != nil {
		t.Fatal(err)
	}
	expected := make(map[syncv2.DeviceID]identity.VaultID, len(users))
	for _, user := range users {
		expected[user.deviceID] = user.vaultID
	}
	return &serverLoadHarness{
		pool: pool, sessions: sessions, cursors: cursors, application: application,
		objects: objects, encryption: encryption,
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)), expected: expected,
	}
}

func (harness *serverLoadHarness) runScenario(
	t *testing.T,
	ctx context.Context,
	scenario serverLoadScenario,
	users []serverLoadUser,
) serverLoadObservation {
	t.Helper()
	selected := users
	if scenario == serverLoadHotVaultPartition {
		selected = make([]serverLoadUser, serverLoadLogicalRequests)
		for index := range selected {
			selected[index] = users[0]
		}
	}
	application := newServerLoadApplication(
		harness.application,
		harness.expected,
		scenario == serverLoadResponseLossRetry,
	)
	runtime := &httpapi.SyncV2Runtime{
		ExpectedOrigin: serverLoadExpectedOrigin,
		Clock:          func() int64 { return serverLoadSynchronizedAt },
		Sessions:       harness.sessions,
		Entitlement:    serverLoadEntitlement{},
		Application:    application,
	}
	var handlerInstances atomic.Int64
	var shared http.Handler
	if scenario != serverLoadColdStart {
		var err error
		shared, err = httpapi.NewSyncV2ContractHandler(runtime, harness.logger)
		if err != nil {
			t.Fatal(err)
		}
		handlerInstances.Store(1)
	}
	handlerFor := func() (http.Handler, error) {
		if shared != nil {
			return shared, nil
		}
		handlerInstances.Add(1)
		return httpapi.NewSyncV2ContractHandler(runtime, harness.logger)
	}
	bodyFor := func(index int) string {
		if scenario == serverLoadResponseLossRetry {
			return serverLoadMutationRequest(selected[index], index)
		}
		return serverLoadPollRequest(selected[index])
	}
	beforeObjects := harness.objects.Calls()
	beforeEncryption := harness.encryption.snapshot()
	first := runServerLoadWave(t, ctx, selected, handlerFor, bodyFor)
	combined := first
	if scenario == serverLoadResponseLossRetry {
		second := runServerLoadWave(t, ctx, selected, handlerFor, bodyFor)
		combined.Attempts += second.Attempts
		combined.Successes += second.Successes
		combined.Unavailable += second.Unavailable
		if second.MaximumInFlight > combined.MaximumInFlight {
			combined.MaximumInFlight = second.MaximumInFlight
		}
	}
	afterObjects := harness.objects.Calls()
	afterEncryption := harness.encryption.snapshot()
	applicationStats := application.snapshot()
	return serverLoadObservation{
		Scenario: scenario, LogicalRequests: serverLoadLogicalRequests,
		HTTPAttempts: combined.Attempts, SuccessfulResponses: combined.Successes,
		UnavailableResponses: combined.Unavailable, MaximumInFlight: combined.MaximumInFlight,
		MaximumApplicationInFlight: applicationStats.MaximumInFlight,
		HandlerInstances:           int(handlerInstances.Load()), UniqueVaults: applicationStats.UniqueVaults,
		UniquePartitions:      applicationStats.UniquePartitions,
		TenantViolations:      applicationStats.TenantViolations,
		ApplicationCalls:      applicationStats.Calls,
		UniqueMutationCommits: applicationStats.UniqueMutationCommits,
		MutationReplays:       applicationStats.MutationReplays,
		ObjectReads:           afterObjects.Get - beforeObjects.Get,
		ObjectWrites:          afterObjects.Put - beforeObjects.Put,
		KMSEncryptions:        afterEncryption.Encrypt - beforeEncryption.Encrypt,
		KMSDecryptions:        afterEncryption.Decrypt - beforeEncryption.Decrypt,
	}
}

type serverLoadWaveObservation struct {
	Attempts        int
	Successes       int
	Unavailable     int
	MaximumInFlight int
}

type serverLoadHTTPResult struct {
	status int
	body   string
	err    error
}

func runServerLoadWave(
	t *testing.T,
	ctx context.Context,
	users []serverLoadUser,
	handlerFor func() (http.Handler, error),
	bodyFor func(int) string,
) serverLoadWaveObservation {
	t.Helper()
	ready := make(chan struct{}, len(users))
	release := make(chan struct{})
	results := make(chan serverLoadHTTPResult, len(users))
	var inFlight atomic.Int64
	var maximumInFlight atomic.Int64
	for index, user := range users {
		go func(index int, user serverLoadUser) {
			current := inFlight.Add(1)
			for {
				maximum := maximumInFlight.Load()
				if current <= maximum || maximumInFlight.CompareAndSwap(maximum, current) {
					break
				}
			}
			ready <- struct{}{}
			<-release
			handler, err := handlerFor()
			if err != nil {
				inFlight.Add(-1)
				results <- serverLoadHTTPResult{err: err}
				return
			}
			request := httptest.NewRequestWithContext(
				ctx, http.MethodPost, "/api/v2/sync", strings.NewReader(bodyFor(index)),
			)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Cookie", identity.SessionCookieName+"="+string(user.token))
			request.Header.Set("Origin", serverLoadExpectedOrigin)
			request.Header.Set("Sec-Fetch-Site", "same-origin")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			inFlight.Add(-1)
			results <- serverLoadHTTPResult{status: response.Code, body: response.Body.String()}
		}(index, user)
	}
	for range users {
		<-ready
	}
	close(release)
	observation := serverLoadWaveObservation{
		Attempts: len(users), MaximumInFlight: int(maximumInFlight.Load()),
	}
	for range users {
		result := <-results
		if result.err != nil {
			t.Fatalf("server load handler construction: %v", result.err)
		}
		switch result.status {
		case http.StatusOK:
			observation.Successes++
		case http.StatusServiceUnavailable:
			observation.Unavailable++
		default:
			t.Fatalf("unexpected server load response = %d %s", result.status, result.body)
		}
	}
	if inFlight.Load() != 0 {
		t.Fatalf("server load requests still in flight: %d", inFlight.Load())
	}
	return observation
}

type serverLoadApplication struct {
	inner           httpapi.SyncV2Application
	expected        map[syncv2.DeviceID]identity.VaultID
	responseLoss    bool
	slots           chan struct{}
	mutex           sync.Mutex
	calls           int
	inFlight        int
	maximumInFlight int
	tenantErrors    int
	replays         int
	vaults          map[identity.VaultID]struct{}
	partitions      map[int]struct{}
	commits         map[syncv2.MutationID]struct{}
}

type serverLoadApplicationStats struct {
	Calls                 int
	MaximumInFlight       int
	TenantViolations      int
	MutationReplays       int
	UniqueVaults          int
	UniquePartitions      int
	UniqueMutationCommits int
}

func newServerLoadApplication(
	inner httpapi.SyncV2Application,
	expected map[syncv2.DeviceID]identity.VaultID,
	responseLoss bool,
) *serverLoadApplication {
	return &serverLoadApplication{
		inner: inner, expected: expected, responseLoss: responseLoss,
		slots:  make(chan struct{}, serverLoadApplicationLimit),
		vaults: make(map[identity.VaultID]struct{}), partitions: make(map[int]struct{}),
		commits: make(map[syncv2.MutationID]struct{}),
	}
}

func (application *serverLoadApplication) Synchronize(
	ctx context.Context,
	input syncv2.SynchronizeInput,
) (syncv2.ApplicationResult, error) {
	application.slots <- struct{}{}
	defer func() { <-application.slots }()
	application.mutex.Lock()
	application.calls++
	application.inFlight++
	if application.inFlight > application.maximumInFlight {
		application.maximumInFlight = application.inFlight
	}
	application.vaults[input.Context.VaultID] = struct{}{}
	application.partitions[serverLoadPartition(input.Context.VaultID)] = struct{}{}
	if application.expected[input.Request.DeviceID] != input.Context.VaultID {
		application.tenantErrors++
	}
	application.mutex.Unlock()
	defer func() {
		application.mutex.Lock()
		application.inFlight--
		application.mutex.Unlock()
	}()

	result, err := application.inner.Synchronize(ctx, input)
	if err != nil || result.Kind != syncv2.ApplicationSynchronized || !application.responseLoss {
		return result, err
	}
	lost := false
	application.mutex.Lock()
	for _, mutation := range input.Request.Mutations {
		if _, found := application.commits[mutation.MutationID]; found {
			application.replays++
			continue
		}
		application.commits[mutation.MutationID] = struct{}{}
		lost = true
	}
	application.mutex.Unlock()
	if lost {
		return syncv2.ApplicationResult{}, errServerLoadResponseLost
	}
	return result, nil
}

func (application *serverLoadApplication) snapshot() serverLoadApplicationStats {
	application.mutex.Lock()
	defer application.mutex.Unlock()
	return serverLoadApplicationStats{
		Calls: application.calls, TenantViolations: application.tenantErrors,
		MaximumInFlight: application.maximumInFlight,
		MutationReplays: application.replays, UniqueVaults: len(application.vaults),
		UniquePartitions: len(application.partitions), UniqueMutationCommits: len(application.commits),
	}
}

type serverLoadEntitlement struct{}

func (serverLoadEntitlement) AuthorizeCapability(
	_ context.Context,
	_ identity.VaultContext,
	capability entitlement.Capability,
	_ int64,
) entitlement.Decision {
	validUntil := int64(10_000)
	return entitlement.Decision{
		Kind: entitlement.DecisionAllowed, Capability: capability,
		Basis: entitlement.BasisPaid, ValidUntil: &validUntil,
	}
}

func (serverLoadEntitlement) ReadLimits(
	context.Context,
	identity.VaultContext,
	int64,
) entitlement.LimitDecision {
	return entitlement.LimitDecision{
		Kind: entitlement.LimitsAvailable, Limits: entitlement.PaidPersonalVaultLimits(),
		ValidUntil: 10_000,
	}
}

type serverLoadKeyManagement struct{}

func (serverLoadKeyManagement) GenerateDataKey(
	_ context.Context,
	vaultID identity.VaultID,
	version cryptocontent.DEKVersion,
) (cryptocontent.VaultDEKMetadata, *cryptocontent.DataEncryptionKey, error) {
	key, err := cryptocontent.NewDataEncryptionKey(make([]byte, 32))
	return cryptocontent.VaultDEKMetadata{
		VaultID: vaultID, DEKVersion: version, KEKReference: "kms://local/server-load",
		WrappedDEK: "AA", CreatedAtMilli: 1_000,
	}, key, err
}

func (serverLoadKeyManagement) UnwrapDataKey(
	_ context.Context,
	metadata cryptocontent.VaultDEKMetadata,
) (*cryptocontent.DataEncryptionKey, error) {
	if cryptocontent.ValidateVaultDEKMetadata(metadata) != nil {
		return nil, cryptocontent.ErrInvalidEnvelope
	}
	return cryptocontent.NewDataEncryptionKey(make([]byte, 32))
}

type serverLoadNonceGenerator struct{ counter atomic.Uint64 }

func (generator *serverLoadNonceGenerator) CreateNonce(context.Context) ([]byte, error) {
	value := make([]byte, 12)
	binary.BigEndian.PutUint64(value[4:], generator.counter.Add(1))
	return value, nil
}

type serverLoadNonceReservations struct {
	mutex sync.Mutex
	seen  map[string]struct{}
}

func (reservations *serverLoadNonceReservations) ReserveNonce(
	_ context.Context,
	vaultID identity.VaultID,
	version cryptocontent.DEKVersion,
	nonce string,
) (bool, error) {
	key := string(vaultID) + ":" + strconv.FormatInt(int64(version), 10) + ":" + nonce
	reservations.mutex.Lock()
	defer reservations.mutex.Unlock()
	if _, found := reservations.seen[key]; found {
		return false, nil
	}
	reservations.seen[key] = struct{}{}
	return true, nil
}

type serverLoadObjectKeys struct{ counter atomic.Uint64 }

func (keys *serverLoadObjectKeys) CreateObjectKey(context.Context) (string, error) {
	digest := sha256.Sum256([]byte(fmt.Sprintf("go-server-load-object-%d", keys.counter.Add(1))))
	return "obj_v1_" + base64.RawURLEncoding.EncodeToString(digest[:]), nil
}

type serverLoadEncryption struct {
	base    encryptedobject.EncryptionPort
	encrypt atomic.Int64
	decrypt atomic.Int64
}

type serverLoadEncryptionSnapshot struct {
	Encrypt int
	Decrypt int
}

func (encryption *serverLoadEncryption) Encrypt(
	ctx context.Context,
	keyring cryptocontent.VaultDEKKeyring,
	object cryptocontent.ObjectContext,
	plaintext []byte,
) (cryptocontent.EnvelopeCiphertext, error) {
	encryption.encrypt.Add(1)
	return encryption.base.Encrypt(ctx, keyring, object, plaintext)
}

func (encryption *serverLoadEncryption) Decrypt(
	ctx context.Context,
	keyring cryptocontent.VaultDEKKeyring,
	object cryptocontent.ObjectContext,
	ciphertext cryptocontent.EnvelopeCiphertext,
) ([]byte, error) {
	encryption.decrypt.Add(1)
	return encryption.base.Decrypt(ctx, keyring, object, ciphertext)
}

func (encryption *serverLoadEncryption) snapshot() serverLoadEncryptionSnapshot {
	return serverLoadEncryptionSnapshot{
		Encrypt: int(encryption.encrypt.Load()), Decrypt: int(encryption.decrypt.Load()),
	}
}

func serverLoadPollRequest(user serverLoadUser) string {
	return `{"version":"sync/v2","deviceId":"` + string(user.deviceID) + `","cursor":null,"mutations":[]}`
}

func serverLoadMutationRequest(user serverLoadUser, index int) string {
	mutationID := serverLoadUUID(0x500_000, index)
	cardID := serverLoadUUID(0x600_000, index)
	return `{"version":"sync/v2","deviceId":"` + string(user.deviceID) + `","cursor":"` +
		string(user.commitCursor) + `","mutations":[{"mutationId":"` + mutationID + `","cardId":"` +
		cardID + `","baseServerRevision":null,"title":"Load card ` + strconv.Itoa(index) +
		`","body":[{"type":"text","text":"synthetic local-only content"}],"createdAt":1100,` +
		`"updatedAt":1100,"kind":"upsert","conflictIds":[]}]}`
}

func serverLoadUUID(namespace int, index int) string {
	return fmt.Sprintf("01991f20-61d2-7000-8000-%012x", namespace+index)
}

func mustServerLoadAccountID(t *testing.T, value string) identity.AccountID {
	t.Helper()
	parsed, err := identity.ParseAccountID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustServerLoadVaultID(t *testing.T, value string) identity.VaultID {
	t.Helper()
	parsed, err := identity.ParseVaultID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustServerLoadSessionID(t *testing.T, value string) identity.SessionID {
	t.Helper()
	parsed, err := identity.ParseSessionID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustServerLoadDeviceID(t *testing.T, value string) syncv2.DeviceID {
	t.Helper()
	parsed, err := syncv2.ParseDeviceID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustServerLoadToken(t *testing.T, index int) identity.SessionToken {
	t.Helper()
	digest := sha256.Sum256([]byte(fmt.Sprintf("go-server-load-session-%d", index)))
	parsed, err := identity.ParseSessionToken(base64.RawURLEncoding.EncodeToString(digest[:]))
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func serverLoadPartition(vaultID identity.VaultID) int {
	value := string(vaultID)
	parsed, err := strconv.ParseInt(value[len(value)-3:], 16, 32)
	if err != nil {
		return -1
	}
	return int(parsed) % serverLoadSimulatedPartitions
}

func readServerLoadEvidence(t *testing.T) serverLoadEvidence {
	t.Helper()
	content, err := os.ReadFile("../../../docs/benchmarks/server-load-go.json")
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	var evidence serverLoadEvidence
	if err := decoder.Decode(&evidence); err != nil {
		t.Fatalf("decode Go server load evidence: %v", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		t.Fatalf("Go server load evidence has trailing content: %v", err)
	}
	if evidence.SchemaVersion != 2 || evidence.Issue != 501 ||
		evidence.BranchPoint != serverLoadBranchPoint ||
		evidence.LegacyReferenceRevision != serverLoadLegacyRevision {
		t.Fatalf("unexpected Go server load evidence identity: %#v", evidence)
	}
	if evidence.Safety != (serverLoadSafety{
		ExecutionMode: "local-go-postgres", DatabaseHostPolicy: "loopback-test-database-only",
		ExternalAdapters: "in-memory-only", RemoteTargetUsed: false, CredentialUsed: false,
	}) {
		t.Fatalf("unexpected Go server load safety boundary: %#v", evidence.Safety)
	}
	if evidence.Methodology != (serverLoadMethodology{
		Command: "npm run benchmark:server-load", LogicalRequests: serverLoadLogicalRequests,
		PostgresMaxConnections:  int(serverLoadPostgresConnections),
		SimulatedPartitions:     serverLoadSimulatedPartitions,
		ApplicationConcurrency:  serverLoadApplicationLimit,
		TimingPolicy:            "Durations are observations only and are not persisted or used as a pass threshold.",
		MemoryPolicy:            "Memory deltas are observations only and are not persisted or used as a pass threshold.",
		ResponseLossFailureMode: "The first fully committed Sync v2 application result is replaced with a synthetic unavailable response; retry must replay PostgreSQL state without another object write or encryption.",
	}) {
		t.Fatalf("unexpected Go server load methodology: %#v", evidence.Methodology)
	}
	for index, observation := range evidence.Observations {
		if index >= len(serverLoadScenarios) || observation.Scenario != serverLoadScenarios[index] {
			t.Fatalf("unexpected Go server load observation order: %#v", evidence.Observations)
		}
	}
	return evidence
}

func assertServerLoadDurableState(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	var commits int
	var committedVaults int
	if err := pool.QueryRow(ctx,
		"SELECT count(*), count(DISTINCT vault_id) FROM vault_sync_v2_commits",
	).Scan(&commits, &committedVaults); err != nil {
		t.Fatal(err)
	}
	var encryptedObjects int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM vault_encrypted_objects").Scan(&encryptedObjects); err != nil {
		t.Fatal(err)
	}
	var committedReservations int
	var activeCards int
	if err := pool.QueryRow(ctx,
		"SELECT count(*) FROM vault_quota_reservations WHERE state = 'committed'",
	).Scan(&committedReservations); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT COALESCE(sum(active_cards), 0) FROM vault_quota_usage").Scan(&activeCards); err != nil {
		t.Fatal(err)
	}
	if commits != serverLoadLogicalRequests || committedVaults != serverLoadLogicalRequests ||
		encryptedObjects != serverLoadLogicalRequests || committedReservations != serverLoadLogicalRequests ||
		activeCards != serverLoadLogicalRequests {
		t.Fatalf(
			"durable server load state commits=%d vaults=%d objects=%d reservations=%d activeCards=%d",
			commits, committedVaults, encryptedObjects, committedReservations, activeCards,
		)
	}
}

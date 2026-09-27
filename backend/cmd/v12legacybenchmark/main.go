// Command v12legacybenchmark is an opt-in, local-only measurement companion.
// It is not included in the notes release image. It composes the real legacy
// HTTP handler and PostgreSQL adapter while adding a request-scoped pgx tracer.
package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/fukamu/notes/backend/internal/access"
	accessadapter "github.com/fukamu/notes/backend/internal/adapters/access"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	benchmarkOwner   access.Subject = "fukamu-notes-v12-local"
	queryCountHeader                = "X-Fukamu-V12-Query-Count"
	sampleIDHeader                  = "X-Fukamu-V12-Sample-Id"
)

func main() {
	os.Exit(run(context.Background(), os.Args[1:], os.Stdout, os.Stderr))
}

func run(ctx context.Context, arguments []string, stdout io.Writer, stderr io.Writer) int {
	if len(arguments) == 1 && arguments[0] == "postgres-version" {
		version, err := postgresVersion(ctx)
		if err != nil {
			_, _ = fmt.Fprintln(stderr, "V12 local PostgreSQL version query failed")
			return 1
		}
		_, _ = fmt.Fprintln(stdout, version)
		return 0
	}
	if len(arguments) == 1 && arguments[0] == "store-witness" {
		witness, err := postgresStoreWitness(ctx)
		if err != nil {
			_, _ = fmt.Fprintln(stderr, "V12 local PostgreSQL witness query failed")
			return 1
		}
		_, _ = fmt.Fprintln(stdout, witness)
		return 0
	}
	if len(arguments) == 2 && arguments[0] == "prepare" && strings.HasPrefix(arguments[1], "--scale=") {
		scale, err := parseScale(strings.TrimPrefix(arguments[1], "--scale="))
		if err != nil || prepare(ctx, scale) != nil {
			_, _ = fmt.Fprintln(stderr, "V12 local PostgreSQL preparation failed")
			return 1
		}
		_, _ = fmt.Fprintln(stdout, "V12 local PostgreSQL preparation complete")
		return 0
	}
	if len(arguments) == 3 && arguments[0] == "serve" &&
		strings.HasPrefix(arguments[1], "--address=") && strings.HasPrefix(arguments[2], "--static-directory=") {
		address := strings.TrimPrefix(arguments[1], "--address=")
		staticDirectory := strings.TrimPrefix(arguments[2], "--static-directory=")
		if serve(ctx, address, staticDirectory) != nil {
			_, _ = fmt.Fprintln(stderr, "V12 local Go companion failed")
			return 1
		}
		return 0
	}
	_, _ = fmt.Fprintln(stderr, "usage: v12legacybenchmark postgres-version | store-witness | prepare --scale=100|1000|10000 | serve --address=127.0.0.1:<port> --static-directory=<absolute-directory>")
	return 2
}

func postgresStoreWitness(ctx context.Context) (string, error) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		return "", errors.New("unsafe local test database")
	}
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 1)
	if err != nil {
		return "", errors.New("open local test database")
	}
	defer pool.Close()
	var databaseOID uint32
	var schemaOID uint32
	var migrationVersion int64
	if err := pool.QueryRow(ctx, `
		SELECT database.oid, namespace.oid, COALESCE(MAX(migration.version_id), 0)
		  FROM pg_database database
		 CROSS JOIN pg_namespace namespace
		  LEFT JOIN goose_db_version migration ON true
		 WHERE database.datname = current_database()
		   AND namespace.nspname = 'public'
		 GROUP BY database.oid, namespace.oid`).Scan(&databaseOID, &schemaOID, &migrationVersion); err != nil ||
		migrationVersion != int64(migrations.LatestVersion) {
		return "", errors.New("read local store witness")
	}
	return fmt.Sprintf(
		"postgres-database-oid-%d-public-oid-%d-migration-%d",
		databaseOID,
		schemaOID,
		migrationVersion,
	), nil
}

func postgresVersion(ctx context.Context) (string, error) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		return "", errors.New("unsafe local test database")
	}
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 1)
	if err != nil {
		return "", errors.New("open local test database")
	}
	defer pool.Close()
	var version string
	if err := pool.QueryRow(ctx, "SHOW server_version").Scan(&version); err != nil ||
		!validVersion(version) {
		return "", errors.New("read local PostgreSQL version")
	}
	return version, nil
}

func prepare(ctx context.Context, scale int) error {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		return errors.New("unsafe local test database")
	}
	database, err := postgresadapter.OpenSQL(ctx, databaseURL)
	if err != nil {
		return errors.New("open local test database")
	}
	defer func() { _ = database.Close() }()
	if _, err := database.ExecContext(ctx, "DROP SCHEMA public CASCADE"); err != nil {
		return errors.New("reset local test schema")
	}
	if _, err := database.ExecContext(ctx, "CREATE SCHEMA public"); err != nil {
		return errors.New("create local test schema")
	}
	migrator, err := postgresadapter.NewMigrator(database, migrations.Files)
	if err != nil || migrator.Up(ctx) != nil {
		return errors.New("apply local test migrations")
	}
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 4)
	if err != nil {
		return errors.New("open local seed pool")
	}
	defer pool.Close()
	transaction, err := pool.Begin(ctx)
	if err != nil {
		return errors.New("begin local seed")
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	cardRows := make([][]any, scale)
	mutationRows := make([][]any, scale)
	for index := range scale {
		createdAt := int64(1_789_000_000_000 + index)
		cardID := fixtureUUID(0x10_0000, index)
		mutationID := fixtureUUID(0x30_0000, index)
		body := fmt.Sprintf(`[{"type":"text","text":"deterministic-v12-%d"}]`, index)
		cardRows[index] = []any{
			cardID, int64(index + 1), fmt.Sprintf("v12-card-%05d", index), body,
			int64(1), createdAt, createdAt, mutationID,
		}
		mutationRows[index] = []any{mutationID, cardID, createdAt}
	}
	if count, err := transaction.CopyFrom(
		ctx,
		pgx.Identifier{"cards"},
		[]string{"id", "display_id", "title", "body_json", "revision", "created_at", "updated_at", "last_mutation_id"},
		pgx.CopyFromRows(cardRows),
	); err != nil || count != int64(scale) {
		return errors.New("seed local cards")
	}
	if count, err := transaction.CopyFrom(
		ctx,
		pgx.Identifier{"card_mutations"},
		[]string{"id", "card_id", "created_at"},
		pgx.CopyFromRows(mutationRows),
	); err != nil || count != int64(scale) {
		return errors.New("seed local mutation markers")
	}
	if _, err := transaction.Exec(
		ctx,
		"UPDATE sync_state SET next_display_id = $1 WHERE singleton = 1",
		int64(scale+1),
	); err != nil {
		return errors.New("seed local display sequence")
	}
	if _, err := transaction.Exec(
		ctx,
		"INSERT INTO launch_allowed_users(user_id, created_at) VALUES ($1, $2)",
		string(benchmarkOwner), int64(1),
	); err != nil {
		return errors.New("seed local launch gate")
	}
	if err := transaction.Commit(ctx); err != nil {
		return errors.New("commit local seed")
	}
	return nil
}

func serve(parent context.Context, address string, staticDirectory string) error {
	if !validLoopbackAddress(address) || staticDirectory == "" {
		return errors.New("invalid local companion boundary")
	}
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		return errors.New("unsafe local test database")
	}
	ctx, stop := signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
	defer stop()
	tracer := queryTracer{}
	configuration, err := postgresadapter.PoolConfiguration(databaseURL, 4)
	if err != nil {
		return errors.New("parse local database configuration")
	}
	configuration.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(ctx, configuration)
	if err != nil {
		return errors.New("open traced local database")
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		return errors.New("ping traced local database")
	}
	gate, err := postgresadapter.NewLaunchGateReader(pool)
	if err != nil {
		return errors.New("configure launch gate")
	}
	readiness, err := postgresadapter.NewSchemaReadiness(pool, migrations.LatestVersion)
	if err != nil {
		return errors.New("configure readiness")
	}
	legacySync, err := postgresadapter.NewLegacySyncStore(pool)
	if err != nil {
		return errors.New("configure legacy synchronizer")
	}
	publicOrigin, err := url.Parse("http://" + address)
	if err != nil {
		return errors.New("configure public origin")
	}
	publicKey, err := localPublicKey()
	if err != nil {
		return errors.New("configure benchmark verifier")
	}
	issuer := os.Getenv("FUKAMU_V12_LOCAL_AUTH_ISSUER")
	audience := os.Getenv("FUKAMU_V12_LOCAL_AUTH_AUDIENCE")
	verifier, err := accessadapter.NewLocalVerifier(publicKey, issuer, audience)
	if err != nil {
		return errors.New("configure benchmark verifier")
	}
	handler, err := httpapi.NewHandler(httpapi.HandlerOptions{
		StaticDirectory: staticDirectory,
		BodyLimit:       4_000_000,
		Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		PrivateRuntime: &httpapi.PrivateRuntime{
			Verifier: verifier, Gate: gate, Readiness: readiness,
			LegacySync: legacySync, LegacyOwner: benchmarkOwner,
			PublicOrigin: publicOrigin, Clock: time.Now,
		},
	})
	if err != nil {
		return errors.New("compose benchmark handler")
	}
	server := &http.Server{
		Addr:              address,
		Handler:           queryObservationMiddleware(handler),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      2 * time.Minute,
		IdleTimeout:       30 * time.Second,
	}
	result := make(chan error, 1)
	go func() { result <- server.ListenAndServe() }()
	select {
	case err := <-result:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return errors.New("serve local benchmark")
	case <-ctx.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			return errors.New("shutdown local benchmark")
		}
		err := <-result
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return errors.New("stop local benchmark")
		}
		return nil
	}
}

type queryCounterKey struct{}

type queryTracer struct{}

func (queryTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	if counter, ok := ctx.Value(queryCounterKey{}).(*atomic.Int64); ok {
		counter.Add(1)
	}
	return ctx
}

func (queryTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (queryTracer) TraceBatchStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceBatchStartData) context.Context {
	return ctx
}

func (queryTracer) TraceBatchQuery(ctx context.Context, _ *pgx.Conn, _ pgx.TraceBatchQueryData) {
	if counter, ok := ctx.Value(queryCounterKey{}).(*atomic.Int64); ok {
		counter.Add(1)
	}
}

func (queryTracer) TraceBatchEnd(context.Context, *pgx.Conn, pgx.TraceBatchEndData) {}

func queryObservationMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/sync" {
			next.ServeHTTP(response, request)
			return
		}
		sampleID := request.Header.Get(sampleIDHeader)
		if !validSampleID(sampleID) || len(request.Header.Values(sampleIDHeader)) != 1 {
			http.Error(response, "invalid local benchmark sample", http.StatusBadRequest)
			return
		}
		counter := &atomic.Int64{}
		buffered := newBufferedResponse()
		next.ServeHTTP(buffered, request.WithContext(context.WithValue(request.Context(), queryCounterKey{}, counter)))
		for name, values := range buffered.header {
			for _, value := range values {
				response.Header().Add(name, value)
			}
		}
		response.Header().Set(queryCountHeader, strconv.FormatInt(counter.Load(), 10))
		response.Header().Set(sampleIDHeader, sampleID)
		response.WriteHeader(buffered.status)
		_, _ = response.Write(buffered.body.Bytes())
	})
}

type bufferedResponse struct {
	header      http.Header
	body        bytes.Buffer
	status      int
	wroteHeader bool
}

func newBufferedResponse() *bufferedResponse {
	return &bufferedResponse{header: make(http.Header), status: http.StatusOK}
}

func (response *bufferedResponse) Header() http.Header { return response.header }

func (response *bufferedResponse) WriteHeader(status int) {
	if response.wroteHeader {
		return
	}
	response.wroteHeader = true
	response.status = status
}

func (response *bufferedResponse) Write(content []byte) (int, error) {
	if !response.wroteHeader {
		response.WriteHeader(http.StatusOK)
	}
	return response.body.Write(content)
}

func parseScale(source string) (int, error) {
	value, err := strconv.Atoi(source)
	if err != nil || value != 100 && value != 1_000 && value != 10_000 {
		return 0, errors.New("invalid scale")
	}
	return value, nil
}

func localPublicKey() (ed25519.PublicKey, error) {
	source := os.Getenv("FUKAMU_V12_LOCAL_AUTH_PUBLIC_KEY")
	decoded, err := base64.RawURLEncoding.DecodeString(source)
	if err != nil || base64.RawURLEncoding.EncodeToString(decoded) != source || len(decoded) != ed25519.PublicKeySize {
		return nil, errors.New("invalid local public key")
	}
	return ed25519.PublicKey(decoded), nil
}

func validLoopbackAddress(value string) bool {
	host, port, found := strings.Cut(value, ":")
	parsedPort, err := strconv.Atoi(port)
	return found && host == "127.0.0.1" && err == nil && parsedPort >= 10_000 && parsedPort <= 60_000
}

func validSampleID(value string) bool {
	if len(value) < 1 || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' ||
			character == '-' || character == '.' {
			continue
		}
		return false
	}
	return true
}

func validVersion(value string) bool {
	if len(value) < 1 || len(value) > 64 {
		return false
	}
	for _, character := range value {
		if character >= '0' && character <= '9' || character == '.' || character >= 'a' && character <= 'z' ||
			character >= 'A' && character <= 'Z' || character == '-' || character == ' ' || character == '(' ||
			character == ')' {
			continue
		}
		return false
	}
	return true
}

func fixtureUUID(namespace int, index int) string {
	return fmt.Sprintf("01991f20-61d2-7000-8000-%012x", namespace+index)
}

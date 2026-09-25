//go:build integration

package integration_test

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSessionStorePostgres(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("NOTES_TEST_DATABASE_URL is required for integration tests")
	}
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("unsafe test database target: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 12)
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
		t.Fatalf("migrate session database: %v", err)
	}

	accountID := sessionAccountID(t, "01991f20-61d2-7000-8000-000000000101")
	vaultID := sessionVaultID(t, "01991f20-61d2-7000-8000-000000000201")
	if _, err := pool.Exec(
		ctx,
		"INSERT INTO accounts(account_id, created_at) VALUES ($1, 1000)",
		string(accountID),
	); err != nil {
		t.Fatalf("seed account: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		"INSERT INTO personal_vaults(vault_id, account_id, created_at) VALUES ($1, $2, 1000)",
		string(vaultID), string(accountID),
	); err != nil {
		t.Fatalf("seed vault: %v", err)
	}
	store, err := postgresadapter.NewSessionStore(pool)
	if err != nil {
		t.Fatalf("NewSessionStore() error = %v", err)
	}

	active := sessionRecord(t, accountID, vaultID, "01991f20-61d2-7000-8000-000000000301", 1, 1_000, 2_000)
	tokenA := sessionToken(t, 'A', 'A')
	if err := store.CreateSession(ctx, active, tokenA); err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}
	stored, err := store.FindSessionByToken(ctx, tokenA)
	if err != nil || stored == nil || stored.Session != active {
		t.Fatalf("FindSessionByToken() = %#v, %v", stored, err)
	}
	var storedToken string
	if err := pool.QueryRow(
		ctx, "SELECT token_hash FROM sessions WHERE session_id = $1", string(active.SessionID),
	).Scan(&storedToken); err != nil || storedToken == string(tokenA) {
		t.Fatalf("stored token = %q, error = %v", storedToken, err)
	}
	unknown, err := store.FindSessionByToken(ctx, sessionToken(t, 'Z', 'E'))
	if err != nil || unknown != nil {
		t.Fatalf("unknown session = %#v, %v", unknown, err)
	}

	duplicateHash := sessionRecord(t, accountID, vaultID, "01991f20-61d2-7000-8000-000000000303", 1, 1_000, 2_000)
	if err := store.CreateSession(ctx, duplicateHash, tokenA); !errors.Is(err, postgresadapter.ErrSessionConflict) {
		t.Fatalf("duplicate hash error = %v", err)
	}
	if err := store.CreateSession(ctx, active, sessionToken(t, 'B', 'A')); !errors.Is(err, postgresadapter.ErrSessionConflict) {
		t.Fatalf("duplicate ID error = %v", err)
	}
	otherAccount := sessionAccountID(t, "01991f20-61d2-7000-8000-000000000102")
	wrongOwner := sessionRecord(t, otherAccount, vaultID, "01991f20-61d2-7000-8000-000000000304", 1, 1_000, 2_000)
	if err := store.CreateSession(ctx, wrongOwner, sessionToken(t, 'C', 'E')); !errors.Is(err, postgresadapter.ErrSessionOwnerMismatch) {
		t.Fatalf("wrong owner error = %v", err)
	}

	tokenB := sessionToken(t, 'D', 'I')
	rotation := sessionRotation(t, active, tokenA, tokenB, "01991f20-61d2-7000-8000-000000000302")
	if err := store.RotateSession(ctx, sessionToken(t, 'E', 'M'), rotation); !errors.Is(err, postgresadapter.ErrSessionConcurrentChange) {
		t.Fatalf("wrong-token rotation error = %v", err)
	}
	if stillActive, err := store.FindSessionByToken(ctx, tokenA); err != nil || stillActive == nil || stillActive.Session.Kind != identity.SessionActive {
		t.Fatalf("rolled-back predecessor = %#v, %v", stillActive, err)
	}
	if next, err := store.FindSessionByToken(ctx, tokenB); err != nil || next != nil {
		t.Fatalf("rolled-back successor = %#v, %v", next, err)
	}
	if err := store.RotateSession(ctx, tokenA, rotation); err != nil {
		t.Fatalf("RotateSession() error = %v", err)
	}
	if previous, err := store.FindSessionByToken(ctx, tokenA); err != nil || previous == nil || previous.Session.Kind != identity.SessionRevoked ||
		previous.Session.RevocationReason != identity.RevocationRotated {
		t.Fatalf("rotated predecessor = %#v, %v", previous, err)
	}
	current, err := store.FindSessionByToken(ctx, tokenB)
	if err != nil || current == nil || current.Session != rotation.Current {
		t.Fatalf("rotated successor = %#v, %v", current, err)
	}
	revocation := identity.RevokeSession(current.Session, 1_700, identity.RevocationLogout)
	context := identity.VaultContext{
		AccountID: current.Session.AccountID, VaultID: current.Session.VaultID,
		SessionID: current.Session.SessionID, SessionEpoch: current.Session.SessionEpoch,
	}
	if outcome, err := store.RevokeSession(ctx, context, revocation.Session); err != nil || outcome != postgresadapter.SessionMutationApplied {
		t.Fatalf("RevokeSession() = %q, %v", outcome, err)
	}
	if outcome, err := store.RevokeSession(ctx, context, revocation.Session); err != nil || outcome != postgresadapter.SessionMutationUnchanged {
		t.Fatalf("repeat RevokeSession() = %q, %v", outcome, err)
	}
	wrongContext := context
	wrongContext.VaultID = sessionVaultID(t, "01991f20-61d2-7000-8000-000000000202")
	if _, err := store.RevokeSession(ctx, wrongContext, revocation.Session); !errors.Is(err, postgresadapter.ErrInvalidSessionOperation) {
		t.Fatalf("cross-vault revoke error = %v", err)
	}

	assertConcurrentSessionRotation(t, ctx, store, accountID, vaultID)
	assertAccountSessionRevocation(t, ctx, pool, store, accountID, vaultID)
	assertMalformedStoredSessionRejected(t, ctx, pool, store, accountID, vaultID)
	if acquired := pool.Stat().AcquiredConns(); acquired != 0 {
		t.Fatalf("database connections still acquired: %d", acquired)
	}
}

func assertMalformedStoredSessionRejected(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	store *postgresadapter.SessionStore,
	accountID identity.AccountID,
	vaultID identity.VaultID,
) {
	t.Helper()
	token := sessionToken(t, 'K', 'g')
	hash, err := identity.HashSessionToken(token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO sessions(
		   session_id, account_id, vault_id, token_hash, session_epoch,
		   issued_at, expires_at, revoked_at, revocation_reason
		 ) VALUES ('not-a-uuid', $1, $2, $3, 1, 1000, 2000, NULL, NULL)`,
		string(accountID), string(vaultID), string(hash),
	); err != nil {
		t.Fatalf("seed malformed session row: %v", err)
	}
	if _, err := store.FindSessionByToken(ctx, token); !errors.Is(err, postgresadapter.ErrInvalidSessionRecord) {
		t.Fatalf("malformed session lookup error = %v", err)
	}
	if _, err := pool.Exec(ctx, "DELETE FROM sessions WHERE token_hash = $1", string(hash)); err != nil {
		t.Fatalf("remove malformed session row: %v", err)
	}
}

func assertConcurrentSessionRotation(
	t *testing.T,
	ctx context.Context,
	store *postgresadapter.SessionStore,
	accountID identity.AccountID,
	vaultID identity.VaultID,
) {
	t.Helper()
	active := sessionRecord(t, accountID, vaultID, "01991f20-61d2-7000-8000-000000000310", 1, 1_000, 2_000)
	token := sessionToken(t, 'F', 'Q')
	if err := store.CreateSession(ctx, active, token); err != nil {
		t.Fatalf("create race session: %v", err)
	}
	rotations := []identity.RotationDecision{
		sessionRotation(t, active, token, sessionToken(t, 'G', 'U'), "01991f20-61d2-7000-8000-000000000311"),
		sessionRotation(t, active, token, sessionToken(t, 'H', 'Y'), "01991f20-61d2-7000-8000-000000000312"),
	}
	start := make(chan struct{})
	failures := make([]error, len(rotations))
	var wait sync.WaitGroup
	for index, rotation := range rotations {
		index, rotation := index, rotation
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			failures[index] = store.RotateSession(ctx, token, rotation)
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
		case errors.Is(err, postgresadapter.ErrSessionConcurrentChange):
			rejections++
		default:
			t.Fatalf("unexpected rotation race error = %v", err)
		}
	}
	if successes != 1 || rejections != 1 {
		t.Fatalf("rotation race outcomes: success=%d rejected=%d", successes, rejections)
	}
}

func assertAccountSessionRevocation(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	store *postgresadapter.SessionStore,
	accountID identity.AccountID,
	vaultID identity.VaultID,
) {
	t.Helper()
	future := sessionRecord(t, accountID, vaultID, "01991f20-61d2-7000-8000-000000000320", 1, 5_000, 6_000)
	if err := store.CreateSession(ctx, future, sessionToken(t, 'J', 'c')); err != nil {
		t.Fatalf("create future session: %v", err)
	}
	if _, err := store.RevokeAccountSessions(ctx, accountID, vaultID, 4_000); !errors.Is(err, postgresadapter.ErrSessionConcurrentChange) {
		t.Fatalf("partial account revoke error = %v", err)
	}
	var activeCount int64
	if err := pool.QueryRow(
		ctx,
		`SELECT count(*) FROM sessions
		  WHERE account_id = $1 AND vault_id = $2 AND revoked_at IS NULL`,
		string(accountID), string(vaultID),
	).Scan(&activeCount); err != nil || activeCount != 2 {
		t.Fatalf("active sessions after rollback = %d, %v", activeCount, err)
	}
	if count, err := store.RevokeAccountSessions(ctx, accountID, vaultID, 5_500); err != nil || count != 2 {
		t.Fatalf("account revoke = %d, %v", count, err)
	}
	if count, err := store.RevokeAccountSessions(ctx, accountID, vaultID, 5_600); err != nil || count != 0 {
		t.Fatalf("idempotent account revoke = %d, %v", count, err)
	}

	late := sessionRecord(t, accountID, vaultID, "01991f20-61d2-7000-8000-000000000321", 1, 6_000, 7_000)
	if err := store.CreateSession(ctx, late, sessionToken(t, 'L', 'k')); err != nil {
		t.Fatalf("create late session: %v", err)
	}
	operationID, err := accountdeletion.ParseOperationID("01991f20-61d2-7000-8000-000000002801")
	if err != nil {
		t.Fatal(err)
	}
	input := accountdeletion.StepEffectInput{
		Scope:       accountdeletion.Scope{AccountID: accountID, VaultID: vaultID},
		OperationID: operationID, Step: accountdeletion.StepRevokeSessions,
		Attempt: 1, RequestedAt: 1_000, ExecutedAt: 5_900,
	}
	result, err := store.RevokeSessions(ctx, input)
	if err != nil || result.Kind != accountdeletion.EffectRetryableFailure ||
		result.FailureCode != "session-revocation-incomplete" {
		t.Fatalf("concurrent effect = %#v, %v", result, err)
	}
	input.Attempt = 2
	input.ExecutedAt = 6_500
	result, err = store.RevokeSessions(ctx, input)
	if err != nil || result.Kind != accountdeletion.EffectSucceeded {
		t.Fatalf("retried effect = %#v, %v", result, err)
	}
	result, err = store.RevokeSessions(ctx, input)
	if err != nil || result.Kind != accountdeletion.EffectSucceeded {
		t.Fatalf("replayed effect = %#v, %v", result, err)
	}
	input.Scope.AccountID = sessionAccountID(t, "01991f20-61d2-7000-8000-000000000109")
	result, err = store.RevokeSessions(ctx, input)
	if err != nil || result.Kind != accountdeletion.EffectTerminalFailure ||
		result.FailureCode != "session-owner-mismatch" {
		t.Fatalf("wrong-owner effect = %#v, %v", result, err)
	}

	assertDeletionStartBlocksSessionIssuance(t, ctx, pool, store, accountID, vaultID)
}

func assertDeletionStartBlocksSessionIssuance(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	sessions *postgresadapter.SessionStore,
	accountID identity.AccountID,
	vaultID identity.VaultID,
) {
	t.Helper()
	sourceToken := sessionToken(t, 'M', 'o')
	source := sessionRecord(t, accountID, vaultID, "01991f20-61d2-7000-8000-000000000322", 1, 6_500, 9_000)
	if err := sessions.CreateSession(ctx, source, sourceToken); err != nil {
		t.Fatalf("create deletion-race source: %v", err)
	}

	deletions, err := postgresadapter.NewAccountDeletionStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	scope := accountdeletion.Scope{AccountID: accountID, VaultID: vaultID}
	operation := accountDeletionOperation(t, scope, 2_899, 6_600)
	continuation := accountDeletionContinuation(t, operation, 'Q', 'R', 20_000)
	raceSession := sessionRecord(t, accountID, vaultID, "01991f20-61d2-7000-8000-000000000323", 2, 6_600, 9_000)
	raceToken := sessionToken(t, 'N', 's')

	start := make(chan struct{})
	var wait sync.WaitGroup
	var startResult accountdeletion.StartResult
	var startErr error
	var sessionErr error
	wait.Add(2)
	go func() {
		defer wait.Done()
		<-start
		startResult, startErr = deletions.Start(ctx, operation, continuation)
	}()
	go func() {
		defer wait.Done()
		<-start
		sessionErr = sessions.CreateSession(ctx, raceSession, raceToken)
	}()
	close(start)
	wait.Wait()
	if startErr != nil || startResult.Kind != accountdeletion.StartCreated {
		t.Fatalf("raced deletion start = %#v, %v", startResult, startErr)
	}
	if sessionErr != nil && !errors.Is(sessionErr, postgresadapter.ErrSessionDeletionPending) &&
		!errors.Is(sessionErr, postgresadapter.ErrSessionConcurrentChange) {
		t.Fatalf("raced session error = %v", sessionErr)
	}

	blocked := sessionRecord(t, accountID, vaultID, "01991f20-61d2-7000-8000-000000000324", 3, 6_700, 9_000)
	if err := sessions.CreateSession(ctx, blocked, sessionToken(t, 'O', 'w')); !errors.Is(err, postgresadapter.ErrSessionDeletionPending) {
		t.Fatalf("post-deletion session error = %v", err)
	}
	nextID, err := identity.ParseSessionID("01991f20-61d2-7000-8000-000000000325")
	if err != nil {
		t.Fatal(err)
	}
	nextEpoch, err := identity.ParseSessionEpoch(2)
	if err != nil {
		t.Fatal(err)
	}
	rotation := identity.RotateSession(source, identity.RotationInput{
		NextSessionID: nextID, NextSessionEpoch: nextEpoch,
		CurrentToken: sourceToken, NextToken: sessionToken(t, 'P', '0'),
		RotatedAt: 6_800, ExpiresAt: 10_000,
	})
	if !rotation.Rotated {
		t.Fatalf("rotation fixture = %#v", rotation)
	}
	if err := sessions.RotateSession(ctx, sourceToken, rotation); !errors.Is(err, postgresadapter.ErrSessionDeletionPending) {
		t.Fatalf("post-deletion rotation error = %v", err)
	}

	input := accountdeletion.StepEffectInput{
		Scope: scope, OperationID: operation.OperationID, Step: accountdeletion.StepRevokeSessions,
		Attempt: 1, RequestedAt: operation.CreatedAt, ExecutedAt: 7_000,
	}
	result, err := sessions.RevokeSessions(ctx, input)
	if err != nil || result.Kind != accountdeletion.EffectSucceeded {
		t.Fatalf("raced revocation = %#v, %v", result, err)
	}
	var active int64
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM sessions
		  WHERE account_id = $1 AND vault_id = $2 AND revoked_at IS NULL`,
		string(accountID), string(vaultID),
	).Scan(&active); err != nil || active != 0 {
		t.Fatalf("active sessions after deletion revoke = %d, %v", active, err)
	}
}

func sessionRecord(
	t *testing.T,
	accountID identity.AccountID,
	vaultID identity.VaultID,
	sessionID string,
	epoch int64,
	issuedAt int64,
	expiresAt int64,
) identity.Session {
	t.Helper()
	parsedSessionID, err := identity.ParseSessionID(sessionID)
	if err != nil {
		t.Fatal(err)
	}
	parsedEpoch, err := identity.ParseSessionEpoch(epoch)
	if err != nil {
		t.Fatal(err)
	}
	decision := identity.CreateActiveSession(identity.SessionInput{
		SessionID: parsedSessionID, AccountID: accountID, VaultID: vaultID,
		SessionEpoch: parsedEpoch, IssuedAt: issuedAt, ExpiresAt: expiresAt,
	})
	if !decision.Created {
		t.Fatalf("session rejected: %#v", decision)
	}
	return decision.Session
}

func sessionRotation(
	t *testing.T,
	active identity.Session,
	currentToken identity.SessionToken,
	nextToken identity.SessionToken,
	nextSessionID string,
) identity.RotationDecision {
	t.Helper()
	identifier, err := identity.ParseSessionID(nextSessionID)
	if err != nil {
		t.Fatal(err)
	}
	nextEpoch, err := identity.ParseSessionEpoch(int64(active.SessionEpoch) + 1)
	if err != nil {
		t.Fatal(err)
	}
	decision := identity.RotateSession(active, identity.RotationInput{
		NextSessionID: identifier, NextSessionEpoch: nextEpoch,
		CurrentToken: currentToken, NextToken: nextToken, RotatedAt: 1_500, ExpiresAt: 3_000,
	})
	if !decision.Rotated {
		t.Fatalf("rotation rejected: %#v", decision)
	}
	return decision
}

func sessionAccountID(t *testing.T, value string) identity.AccountID {
	t.Helper()
	parsed, err := identity.ParseAccountID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func sessionVaultID(t *testing.T, value string) identity.VaultID {
	t.Helper()
	parsed, err := identity.ParseVaultID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func sessionToken(t *testing.T, repeated byte, last byte) identity.SessionToken {
	t.Helper()
	value := strings.Repeat(string(repeated), 42) + string(last)
	parsed, err := identity.ParseSessionToken(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

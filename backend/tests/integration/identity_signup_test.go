//go:build integration

package integration_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIdentityAndSignupPostgres(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	provisioning, err := postgresadapter.NewSignupProvisioningStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	directory, err := postgresadapter.NewIdentityStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	sessions, err := postgresadapter.NewSessionStore(pool)
	if err != nil {
		t.Fatal(err)
	}

	reservation := integrationSignupReservation(t, 1, "Person@Example.COM")
	reserved, err := provisioning.Reserve(ctx, reservation)
	if err != nil || reserved.Kind != identity.SignupReservationReserved || reserved.Reservation != reservation {
		t.Fatalf("Reserve() = %#v, %v", reserved, err)
	}
	replayCandidate := reservation
	replayCandidate.AccountID = integrationAccountID(t, 109)
	replayCandidate.VaultID = integrationVaultID(t, 209)
	replayCandidate.IdentityID = integrationIdentityID(t, 309)
	replayCandidate.SessionID = integrationSessionID(t, 409)
	replayedReservation, err := provisioning.Reserve(ctx, replayCandidate)
	if err != nil || replayedReservation.Kind != identity.SignupReservationReserved || replayedReservation.Reservation != reservation {
		t.Fatalf("idempotent Reserve() = %#v, %v", replayedReservation, err)
	}

	plan := integrationSignupPlan(t, reservation)
	tokenA := integrationSessionToken(t, 'A', 'A')
	sessionA := integrationSignupSession(t, reservation, 2_000)
	hashA, _ := identity.HashSessionToken(tokenA)
	finalized, err := provisioning.Finalize(ctx, plan, sessionA, hashA)
	if err != nil || finalized.Kind != identity.SignupFinalizationCreated || !finalized.Record.Valid() {
		t.Fatalf("Finalize() = %#v, %v", finalized, err)
	}
	assertSignupRows(t, ctx, pool, reservation, hashA)

	foundIdentity, err := directory.FindByAddress(ctx, reservation.Identity.Address)
	if err != nil || foundIdentity == nil || foundIdentity.AccountID != reservation.AccountID ||
		foundIdentity.VaultID != reservation.VaultID || foundIdentity.IdentityID != reservation.IdentityID {
		t.Fatalf("FindByAddress() = %#v, %v", foundIdentity, err)
	}
	owner, err := directory.FindAccountIDByVerifiedEmail(ctx, reservation.Identity.VerifiedEmail())
	if err != nil || owner == nil || *owner != reservation.AccountID {
		t.Fatalf("FindAccountIDByVerifiedEmail() = %#v, %v", owner, err)
	}
	storedA, err := sessions.FindSessionByToken(ctx, tokenA)
	if err != nil || storedA == nil || storedA.Session != sessionA {
		t.Fatalf("FindSessionByToken(A) = %#v, %v", storedA, err)
	}

	tokenB := integrationSessionToken(t, 'B', 'E')
	sessionB := integrationSignupSession(t, reservation, 2_100)
	hashB, _ := identity.HashSessionToken(tokenB)
	replayed, err := provisioning.Finalize(ctx, plan, sessionB, hashB)
	if err != nil || replayed.Kind != identity.SignupFinalizationReplayed || !replayed.Record.Valid() {
		t.Fatalf("replayed Finalize() = %#v, %v", replayed, err)
	}
	if old, err := sessions.FindSessionByToken(ctx, tokenA); err != nil || old != nil {
		t.Fatalf("old token after replay = %#v, %v", old, err)
	}
	if current, err := sessions.FindSessionByToken(ctx, tokenB); err != nil || current == nil || current.Session != sessionB {
		t.Fatalf("new token after replay = %#v, %v", current, err)
	}
	assertSignupRows(t, ctx, pool, reservation, hashB)

	assertSameAccountMultiProviderOwnership(t, ctx, pool, directory, reservation)
	assertSignupConflictRollsBack(t, ctx, pool, provisioning)
	assertMalformedIdentityRowsFailClosed(t, ctx, pool, directory, reservation)
	if pool.Stat().AcquiredConns() != 0 {
		t.Fatalf("database connections still acquired: %d", pool.Stat().AcquiredConns())
	}
}

func openIdentitySignupDatabase(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("NOTES_TEST_DATABASE_URL is required for integration tests")
	}
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("unsafe test database target: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 12)
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
		t.Fatalf("migrate identity database: %v", err)
	}
	return ctx, pool
}

func integrationSignupReservation(t *testing.T, suffix int, email string) identity.SignupAdmissionReservation {
	t.Helper()
	address, err := identity.ParseEmailOtpAddress(email)
	if err != nil {
		t.Fatal(err)
	}
	return identity.SignupAdmissionReservation{
		SubmissionID: integrationUUID(t, 500+suffix),
		Identity: identity.VerifiedSignupIdentity{
			Kind: identity.SignupIdentityEmailOtp, Address: address,
		},
		AccountID: integrationAccountID(t, 100+suffix), VaultID: integrationVaultID(t, 200+suffix),
		IdentityID: integrationIdentityID(t, 300+suffix), SessionID: integrationSessionID(t, 400+suffix),
		SessionEpoch: integrationEpoch(t), CreatedAt: 1_000,
	}
}

func integrationSignupPlan(t *testing.T, reservation identity.SignupAdmissionReservation) identity.SignupAdmissionPlan {
	t.Helper()
	return identity.PlanSignupAdmission(
		reservation.Identity,
		reservation.SubmissionID,
		reservation,
		identity.SignupTermsEvidence{
			SubmissionID: reservation.SubmissionID, AccountID: reservation.AccountID,
			VaultID: reservation.VaultID, TermsConsentID: integrationUUID(t, 601),
		},
	)
}

func integrationSignupSession(
	t *testing.T,
	reservation identity.SignupAdmissionReservation,
	issuedAt int64,
) identity.Session {
	t.Helper()
	decision := identity.CreateActiveSession(identity.SessionInput{
		SessionID: reservation.SessionID, AccountID: reservation.AccountID,
		VaultID: reservation.VaultID, SessionEpoch: reservation.SessionEpoch,
		IssuedAt: issuedAt, ExpiresAt: issuedAt + identity.SignupSessionLifetimeSeconds,
	})
	if !decision.Created {
		t.Fatalf("session creation = %#v", decision)
	}
	return decision.Session
}

func assertSignupRows(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	reservation identity.SignupAdmissionReservation,
	wantHash identity.SessionTokenHash,
) {
	t.Helper()
	var accounts, vaults, identities, emails, sessions, reservations int
	err := pool.QueryRow(
		ctx,
		`SELECT
		   (SELECT count(*) FROM accounts WHERE account_id = $1),
		   (SELECT count(*) FROM personal_vaults WHERE vault_id = $2),
		   (SELECT count(*) FROM identities WHERE identity_id = $3),
		   (SELECT count(*) FROM verified_email_owners WHERE email = $4),
		   (SELECT count(*) FROM sessions WHERE session_id = $5),
		   (SELECT count(*) FROM signup_admission_reservations WHERE submission_id = $6)`,
		string(reservation.AccountID), string(reservation.VaultID), string(reservation.IdentityID),
		string(reservation.Identity.VerifiedEmail()), string(reservation.SessionID), reservation.SubmissionID,
	).Scan(&accounts, &vaults, &identities, &emails, &sessions, &reservations)
	if err != nil || accounts != 1 || vaults != 1 || identities != 1 || emails != 1 || sessions != 1 || reservations != 1 {
		t.Fatalf("signup row counts = %d %d %d %d %d %d, %v", accounts, vaults, identities, emails, sessions, reservations, err)
	}
	var storedHash string
	if err := pool.QueryRow(ctx, "SELECT token_hash FROM sessions WHERE session_id = $1", string(reservation.SessionID)).Scan(&storedHash); err != nil || storedHash != string(wantHash) {
		t.Fatalf("stored session hash = %q, want %q, %v", storedHash, wantHash, err)
	}
}

func assertSameAccountMultiProviderOwnership(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	directory *postgresadapter.IdentityStore,
	reservation identity.SignupAdmissionReservation,
) {
	t.Helper()
	googleIdentityID := integrationUUID(t, 390)
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO identities(identity_id, account_id, provider, issuer, subject, created_at)
		 VALUES ($1, $2, 'google-oidc', 'https://accounts.google.com', 'google-subject', 2100)`,
		googleIdentityID, string(reservation.AccountID),
	); err != nil {
		t.Fatalf("insert same-account Google identity: %v", err)
	}
	issuer, _ := identity.ParseOidcIssuer("https://accounts.google.com")
	subject, _ := identity.ParseOidcSubject("google-subject")
	record, err := directory.FindByIssuerSubject(ctx, identity.OidcIdentityKey{Issuer: issuer, Subject: subject})
	if err != nil || record == nil || record.AccountID != reservation.AccountID {
		t.Fatalf("FindByIssuerSubject() = %#v, %v", record, err)
	}
	otherAccount := integrationAccountID(t, 109)
	if _, err := pool.Exec(ctx, "INSERT INTO accounts(account_id, created_at) VALUES ($1, 2200)", string(otherAccount)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		"INSERT INTO verified_email_owners(email, account_id, verified_at) VALUES ($1, $2, 2200)",
		string(reservation.Identity.VerifiedEmail()), string(otherAccount),
	); err == nil {
		t.Fatal("verified email was assigned to a second account")
	}
}

func assertSignupConflictRollsBack(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	provisioning *postgresadapter.SignupProvisioningStore,
) {
	t.Helper()
	reservation := integrationSignupReservation(t, 2, "other@example.com")
	reserved, err := provisioning.Reserve(ctx, reservation)
	if err != nil || reserved.Kind != identity.SignupReservationReserved {
		t.Fatalf("reserve conflict fixture = %#v, %v", reserved, err)
	}
	if _, err := pool.Exec(
		ctx, "INSERT INTO accounts(account_id, created_at) VALUES ($1, 1500)", string(reservation.AccountID),
	); err != nil {
		t.Fatalf("seed finalization collision: %v", err)
	}
	plan := integrationSignupPlan(t, reservation)
	token := integrationSessionToken(t, 'C', 'I')
	hash, _ := identity.HashSessionToken(token)
	result, err := provisioning.Finalize(ctx, plan, integrationSignupSession(t, reservation, 2_000), hash)
	if err != nil || result.Kind != identity.SignupFinalizationConflict {
		t.Fatalf("conflicting Finalize() = %#v, %v", result, err)
	}
	var vaults, identities, emails, sessions int
	if err := pool.QueryRow(
		ctx,
		`SELECT
		   (SELECT count(*) FROM personal_vaults WHERE vault_id = $1),
		   (SELECT count(*) FROM identities WHERE identity_id = $2),
		   (SELECT count(*) FROM verified_email_owners WHERE email = $3),
		   (SELECT count(*) FROM sessions WHERE session_id = $4)`,
		string(reservation.VaultID), string(reservation.IdentityID),
		string(reservation.Identity.VerifiedEmail()), string(reservation.SessionID),
	).Scan(&vaults, &identities, &emails, &sessions); err != nil || vaults != 0 || identities != 0 || emails != 0 || sessions != 0 {
		t.Fatalf("partial finalization rows = %d %d %d %d, %v", vaults, identities, emails, sessions, err)
	}
}

func assertMalformedIdentityRowsFailClosed(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	directory *postgresadapter.IdentityStore,
	reservation identity.SignupAdmissionReservation,
) {
	t.Helper()
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO identities(identity_id, account_id, provider, issuer, subject, created_at)
		 VALUES ('not-a-uuid', $1, 'email-otp', 'fukamu.email-otp', 'malformed@example.com', 2300)`,
		string(reservation.AccountID),
	); err != nil {
		t.Fatalf("seed malformed identity: %v", err)
	}
	address, _ := identity.ParseEmailOtpAddress("malformed@example.com")
	if _, err := directory.FindByAddress(ctx, address); !errors.Is(err, postgresadapter.ErrInvalidIdentityRecord) {
		t.Fatalf("malformed identity lookup error = %v", err)
	}
	missing, _ := identity.ParseVerifiedEmailAddress("missing@example.com")
	if owner, err := directory.FindAccountIDByVerifiedEmail(ctx, missing); err != nil || owner != nil {
		t.Fatalf("cross-user/missing owner = %#v, %v", owner, err)
	}
}

func integrationUUID(t *testing.T, suffix int) string {
	t.Helper()
	value := "01991f20-61d2-7000-8000-" + leftPad12(suffix)
	if _, err := identity.ParseIdentityID(value); err != nil {
		t.Fatal(err)
	}
	return value
}

func leftPad12(value int) string {
	return fmt.Sprintf("%012d", value)
}

func integrationAccountID(t *testing.T, suffix int) identity.AccountID {
	t.Helper()
	value, err := identity.ParseAccountID(integrationUUID(t, suffix))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func integrationVaultID(t *testing.T, suffix int) identity.VaultID {
	t.Helper()
	value, err := identity.ParseVaultID(integrationUUID(t, suffix))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func integrationIdentityID(t *testing.T, suffix int) identity.IdentityID {
	t.Helper()
	value, err := identity.ParseIdentityID(integrationUUID(t, suffix))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func integrationSessionID(t *testing.T, suffix int) identity.SessionID {
	t.Helper()
	value, err := identity.ParseSessionID(integrationUUID(t, suffix))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func integrationEpoch(t *testing.T) identity.SessionEpoch {
	t.Helper()
	value, err := identity.ParseSessionEpoch(1)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func integrationSessionToken(t *testing.T, repeated byte, last byte) identity.SessionToken {
	t.Helper()
	value, err := identity.ParseSessionToken(strings.Repeat(string(repeated), 42) + string(last))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

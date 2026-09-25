//go:build integration

package integration_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAccountFinalizationPostgresPolicyIsolationAndReplay(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	store, err := postgresadapter.NewAccountFinalizationStore(pool)
	if err != nil {
		t.Fatal(err)
	}

	scopeA := accountDeletionScopeForSuffix(t, 81)
	scopeB := accountDeletionScopeForSuffix(t, 82)
	seedVaultPurgeOwner(t, ctx, pool, scopeA)
	seedVaultPurgeOwner(t, ctx, pool, scopeB)
	ownerA := seedAccountFinalizationLiveState(t, ctx, pool, scopeA, 81, 'P', true)
	seedAccountFinalizationLiveState(t, ctx, pool, scopeB, 82, 'Q', true)
	operationA := startVaultPurgeDeletion(t, ctx, pool, scopeA, 3_181, 'R', 'S')
	previousReceiptAt := markAccountFinalizationRunning(t, ctx, pool, operationA, 1_700)
	command := accountFinalizationCommand(operationA, previousReceiptAt, 1_800)

	undecided := accountdeletion.LegalEvidenceFinalizationPolicy{
		Kind: accountdeletion.LegalEvidencePolicyUndecided,
	}
	service := newAccountFinalizationService(t, scopeA, undecided, store)
	outboxKey := privateObjectPurgeKey(t, 'T')
	seedPrivateObjectOutbox(t, ctx, pool, scopeA, 1_750, outboxKey)
	assertAccountFinalizationResult(t, ctx, service, command,
		accountdeletion.AccountFinalizationRetryableFailure,
		accountdeletion.AccountFinalizationPrivateObjectsRemaining, "")
	assertRowCount(t, ctx, pool, "vault_dek_versions", "vault_id", string(scopeA.VaultID), 1)
	assertRowCount(t, ctx, pool, "accounts", "account_id", string(scopeA.AccountID), 1)
	if _, err := pool.Exec(ctx, "DELETE FROM vault_object_delete_outbox WHERE object_key = $1", string(outboxKey)); err != nil {
		t.Fatal(err)
	}

	assertAccountFinalizationResult(t, ctx, service, command,
		accountdeletion.AccountFinalizationRetryableFailure,
		accountdeletion.AccountFinalizationLegalPolicyPending, "")
	assertRowCount(t, ctx, pool, "vault_dek_versions", "vault_id", string(scopeA.VaultID), 1)
	assertRowCount(t, ctx, pool, "terms_consent_evidence", "account_id", string(scopeA.AccountID), 1)

	wrongOperation := command
	wrongOperation.OperationID, err = accountdeletion.ParseOperationID(integrationUUID(t, 9_181))
	if err != nil {
		t.Fatal(err)
	}
	assertAccountFinalizationResult(t, ctx, service, wrongOperation,
		accountdeletion.AccountFinalizationTerminalFailure,
		accountdeletion.AccountFinalizationIntegrityFailure, "")
	wrongReceipt := command
	wrongReceipt.PreviousReceiptAt++
	assertAccountFinalizationResult(t, ctx, service, wrongReceipt,
		accountdeletion.AccountFinalizationTerminalFailure,
		accountdeletion.AccountFinalizationIntegrityFailure, "")
	if _, err := pool.Exec(ctx, `DELETE FROM account_deletion_step_receipts
		WHERE operation_id = $1 AND step = 'cancel-subscription'`, string(operationA.OperationID)); err != nil {
		t.Fatal(err)
	}
	assertAccountFinalizationResult(t, ctx, service, command,
		accountdeletion.AccountFinalizationTerminalFailure,
		accountdeletion.AccountFinalizationIntegrityFailure, "")
	if _, err := pool.Exec(ctx, `INSERT INTO account_deletion_step_receipts(operation_id, step, completed_at)
		VALUES ($1, 'cancel-subscription', 1500)`, string(operationA.OperationID)); err != nil {
		t.Fatal(err)
	}
	crossOwner := command
	crossOwner.Scope.VaultID = scopeB.VaultID
	crossResult, err := store.Evaluate(ctx, crossOwner)
	if err != nil || crossResult.Kind != accountdeletion.AccountFinalizationTerminalFailure ||
		crossResult.Reason != accountdeletion.AccountFinalizationOwnerMismatch {
		t.Fatalf("cross-owner Evaluate() = %#v, %v", crossResult, err)
	}
	assertRowCount(t, ctx, pool, "vault_dek_versions", "vault_id", string(scopeA.VaultID), 1)

	deleteLive := accountdeletion.LegalEvidenceFinalizationPolicy{
		Kind: accountdeletion.LegalEvidenceDeleteLive,
	}
	service = newAccountFinalizationService(t, scopeA, deleteLive, store)
	assertAccountFinalizationResult(t, ctx, service, command,
		accountdeletion.AccountFinalizationConfirmed, "", accountdeletion.AccountFinalizationDeleted)
	assertAccountFinalizationRowsDeleted(t, ctx, pool, scopeA)
	assertAccountFinalizationJournal(t, ctx, pool, operationA)
	assertAccountFinalizationOwnerStillLive(t, ctx, pool, scopeB)

	identityStore, err := postgresadapter.NewIdentityStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	identityRecord, err := identityStore.FindByIssuerSubject(ctx, identity.OidcIdentityKey{
		Issuer: ownerA.issuer, Subject: ownerA.subject,
	})
	if err != nil || identityRecord != nil {
		t.Fatalf("deleted identity lookup = %#v, %v", identityRecord, err)
	}
	sessionStore, err := postgresadapter.NewSessionStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	session, err := sessionStore.FindSessionByToken(ctx, ownerA.sessionToken)
	if err != nil || session != nil {
		t.Fatalf("deleted session lookup = %#v, %v", session, err)
	}

	assertAccountFinalizationResult(t, ctx, service, command,
		accountdeletion.AccountFinalizationConfirmed, "", accountdeletion.AccountFinalizationAlreadyFinalized)
	assertAccountFinalizationJournal(t, ctx, pool, operationA)
	if acquired := pool.Stat().AcquiredConns(); acquired != 0 {
		t.Fatalf("database connections still acquired: %d", acquired)
	}
}

func TestAccountFinalizationPostgresPolicyRaceAndRollback(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	store, err := postgresadapter.NewAccountFinalizationStore(pool)
	if err != nil {
		t.Fatal(err)
	}

	raceScope := accountDeletionScopeForSuffix(t, 83)
	seedVaultPurgeOwner(t, ctx, pool, raceScope)
	seedAccountFinalizationLiveState(t, ctx, pool, raceScope, 83, 'U', false)
	raceOperation := startVaultPurgeDeletion(t, ctx, pool, raceScope, 3_183, 'V', 'W')
	raceReceiptAt := markAccountFinalizationRunning(t, ctx, pool, raceOperation, 1_700)
	raceCommand := accountFinalizationCommand(raceOperation, raceReceiptAt, 1_800)
	undecided := accountdeletion.LegalEvidenceFinalizationPolicy{
		Kind: accountdeletion.LegalEvidencePolicyUndecided,
	}
	preflight, err := store.EvaluateLegalEvidence(ctx, raceCommand, undecided)
	if err != nil || preflight.Kind != accountdeletion.AccountFinalizationConfirmed {
		t.Fatalf("legal preflight = %#v, %v", preflight, err)
	}
	legalWriteErr := insertFinalizationTermsEvidence(ctx, pool, raceScope, 83)
	var postgresError *pgconn.PgError
	if !errors.As(legalWriteErr, &postgresError) ||
		postgresError.ConstraintName != "account_deletion_legal_evidence_gate" {
		t.Fatalf("post-deletion legal evidence write = %v", legalWriteErr)
	}
	raceResult, err := store.FinalizeWrappedKeys(ctx, raceCommand, undecided)
	if err != nil || raceResult.Kind != accountdeletion.AccountFinalizationConfirmed {
		t.Fatalf("policy race result = %#v, %v", raceResult, err)
	}
	assertRowCount(t, ctx, pool, "vault_dek_versions", "vault_id", string(raceScope.VaultID), 0)

	rollbackScope := accountDeletionScopeForSuffix(t, 84)
	seedVaultPurgeOwner(t, ctx, pool, rollbackScope)
	seedAccountFinalizationLiveState(t, ctx, pool, rollbackScope, 84, 'X', true)
	rollbackOperation := startVaultPurgeDeletion(t, ctx, pool, rollbackScope, 3_184, 'Y', 'Z')
	rollbackReceiptAt := markAccountFinalizationRunning(t, ctx, pool, rollbackOperation, 1_700)
	rollbackCommand := accountFinalizationCommand(rollbackOperation, rollbackReceiptAt, 1_800)
	deleteLive := accountdeletion.LegalEvidenceFinalizationPolicy{
		Kind: accountdeletion.LegalEvidenceDeleteLive,
	}
	service := newAccountFinalizationService(t, rollbackScope, deleteLive, store)
	if _, err := pool.Exec(ctx, `CREATE FUNCTION fail_test_account_finalization() RETURNS trigger
		LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''injected account finalization failure''; END'`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE TRIGGER fail_test_account_finalization
		BEFORE DELETE ON identities FOR EACH ROW EXECUTE FUNCTION fail_test_account_finalization()`); err != nil {
		t.Fatal(err)
	}
	assertAccountFinalizationResult(t, ctx, service, rollbackCommand,
		accountdeletion.AccountFinalizationRetryableFailure,
		accountdeletion.AccountFinalizationLiveStateUnavailable, "")
	assertRowCount(t, ctx, pool, "vault_dek_versions", "vault_id", string(rollbackScope.VaultID), 0)
	assertRowCount(t, ctx, pool, "terms_consent_evidence", "account_id", string(rollbackScope.AccountID), 1)
	assertRowCount(t, ctx, pool, "contract_evidence", "account_id", string(rollbackScope.AccountID), 1)
	assertRowCount(t, ctx, pool, "sessions", "account_id", string(rollbackScope.AccountID), 1)
	assertRowCount(t, ctx, pool, "identities", "account_id", string(rollbackScope.AccountID), 1)
	assertRowCount(t, ctx, pool, "accounts", "account_id", string(rollbackScope.AccountID), 1)
	if _, err := pool.Exec(ctx, "DROP TRIGGER fail_test_account_finalization ON identities"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "DROP FUNCTION fail_test_account_finalization()"); err != nil {
		t.Fatal(err)
	}
	assertAccountFinalizationResult(t, ctx, service, rollbackCommand,
		accountdeletion.AccountFinalizationConfirmed, "", accountdeletion.AccountFinalizationDeleted)
	assertAccountFinalizationRowsDeleted(t, ctx, pool, rollbackScope)
	assertAccountFinalizationJournal(t, ctx, pool, rollbackOperation)
	if acquired := pool.Stat().AcquiredConns(); acquired != 0 {
		t.Fatalf("database connections still acquired: %d", acquired)
	}
}

type finalizationOwnerFixture struct {
	issuer       identity.OidcIssuer
	subject      identity.OidcSubject
	sessionToken identity.SessionToken
}

func seedAccountFinalizationLiveState(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	scope accountdeletion.Scope,
	suffix int,
	tokenCharacter byte,
	withEvidence bool,
) finalizationOwnerFixture {
	t.Helper()
	issuer, err := identity.ParseOidcIssuer("https://issuer.test")
	if err != nil {
		t.Fatal(err)
	}
	subject, err := identity.ParseOidcSubject("owner-" + integrationUUID(t, suffix))
	if err != nil {
		t.Fatal(err)
	}
	identityID := integrationIdentityID(t, 6_000+suffix)
	if _, err := pool.Exec(ctx, `INSERT INTO identities(
		identity_id, account_id, provider, issuer, subject, created_at
	) VALUES ($1, $2, 'google-oidc', $3, $4, 1000)`, string(identityID),
		string(scope.AccountID), string(issuer), string(subject)); err != nil {
		t.Fatal(err)
	}
	sessionToken := integrationSessionToken(t, tokenCharacter, 'A')
	sessionID := integrationSessionID(t, 6_100+suffix)
	session := identity.CreateActiveSession(identity.SessionInput{
		SessionID: sessionID, AccountID: scope.AccountID, VaultID: scope.VaultID,
		SessionEpoch: integrationEpoch(t), IssuedAt: 1_000, ExpiresAt: 10_000,
	})
	if !session.Created {
		t.Fatalf("session decision = %#v", session)
	}
	sessionStore, err := postgresadapter.NewSessionStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	if err := sessionStore.CreateSession(ctx, session.Session, sessionToken); err != nil {
		t.Fatal(err)
	}
	email := fmt.Sprintf("owner-%d@example.test", suffix)
	if _, err := pool.Exec(ctx, `INSERT INTO verified_email_owners(email, account_id, verified_at)
		VALUES ($1, $2, 1000)`, email, string(scope.AccountID)); err != nil {
		t.Fatal(err)
	}
	var finalizedAt any
	var termsConsentID any
	if withEvidence {
		finalizedAt = int64(1_200)
		termsConsentID = integrationUUID(t, 6_200+suffix)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO signup_admission_reservations(
		submission_id, identity_kind, provider, issuer, subject, verified_email,
		account_id, vault_id, identity_id, session_id, session_epoch, created_at,
		finalized_at, terms_consent_id
	) VALUES ($1, 'google', 'google-oidc', $2, $3, $4, $5, $6, $7, $8, 1, 1000, $9, $10)`,
		integrationUUID(t, 6_300+suffix), string(issuer), string(subject), email,
		string(scope.AccountID), string(scope.VaultID), string(identityID), string(sessionID),
		finalizedAt, termsConsentID); err != nil {
		t.Fatal(err)
	}
	subscriptionID := integrationUUID(t, 6_100+suffix)
	if _, err := pool.Exec(ctx, `INSERT INTO billing_subscriptions(
		subscription_id, account_id, vault_id, provider, version, status,
		payment_method_ready, cancelled_at, created_at, updated_at
	) VALUES ($1, $2, $3, 'stripe', 1, 'cancelled', false, 1400, 1000, 1400)`,
		subscriptionID, string(scope.AccountID), string(scope.VaultID)); err != nil {
		t.Fatal(err)
	}
	seedPreservedEntitlement(t, ctx, pool, scope, suffix)
	if withEvidence {
		if err := insertFinalizationTermsEvidence(ctx, pool, scope, suffix); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO contract_evidence(
			account_id, vault_id, evidence_id, submission_id, offer_hash, offer_version,
			disclosure_version, serialized_offer, consent, confirmed_at
		) VALUES ($1, $2, $3, $4, $5, 'legal-commerce-v1:2026-01-01',
			'2026-01-01', '{}', 'affirmed', 1000)`, string(scope.AccountID), string(scope.VaultID),
			integrationUUID(t, 6_400+suffix), integrationUUID(t, 6_500+suffix),
			"sha256:"+strings.Repeat("b", 64)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO privacy_requests(
		account_id, vault_id, request_id, submission_id, request_kind, revision,
		state, requested_at, updated_at
	) VALUES ($1, $2, $3, $4, 'deletion', 1, 'verification-pending', 1000, 1000)`,
		string(scope.AccountID), string(scope.VaultID), integrationUUID(t, 6_600+suffix),
		integrationUUID(t, 6_700+suffix)); err != nil {
		t.Fatal(err)
	}
	return finalizationOwnerFixture{issuer: issuer, subject: subject, sessionToken: sessionToken}
}

func insertFinalizationTermsEvidence(
	ctx context.Context,
	pool *pgxpool.Pool,
	scope accountdeletion.Scope,
	suffix int,
) error {
	_, err := pool.Exec(ctx, `INSERT INTO terms_consent_evidence(
		account_id, vault_id, consent_id, submission_id, terms_version, terms_hash,
		serialized_terms, consent, accepted_at
	) VALUES ($1, $2, $3, $4, 'terms-v1:2026-01-01', $5, '{}', 'affirmed', 1000)`,
		string(scope.AccountID), string(scope.VaultID), integrationUUIDValue(6_200+suffix),
		integrationUUIDValue(6_800+suffix), "sha256:"+strings.Repeat("a", 64))
	return err
}

func integrationUUIDValue(suffix int) string {
	return fmt.Sprintf("01991f20-61d2-7000-8000-%012d", suffix)
}

func markAccountFinalizationRunning(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	operation accountdeletion.Operation,
	completedAt int64,
) int64 {
	t.Helper()
	markPrivateObjectPurgeRunning(t, ctx, pool, operation, completedAt-100)
	tag, err := pool.Exec(ctx, `UPDATE account_deletion_operations SET
		revision = 4, current_step = 'finalize-account', updated_at = $1, lease_expires_at = $2
		WHERE operation_id = $3 AND account_id = $4 AND vault_id = $5
		  AND state = 'running' AND current_step = 'delete-private-objects'`,
		completedAt, completedAt+2_000, string(operation.OperationID),
		string(operation.Scope.AccountID), string(operation.Scope.VaultID))
	if err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("mark account finalization running: rows=%d err=%v", tag.RowsAffected(), err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO account_deletion_step_receipts(
		operation_id, step, completed_at
	) VALUES ($1, 'delete-private-objects', $2)`, string(operation.OperationID), completedAt); err != nil {
		t.Fatalf("seed private-object receipt: %v", err)
	}
	return completedAt
}

func accountFinalizationCommand(
	operation accountdeletion.Operation,
	previousReceiptAt, attemptedAt int64,
) accountdeletion.AccountFinalizationCommand {
	return accountdeletion.AccountFinalizationCommand{
		Scope: operation.Scope, OperationID: operation.OperationID,
		PreviousReceiptAt: previousReceiptAt, AttemptedAt: attemptedAt,
	}
}

func newAccountFinalizationService(
	t *testing.T,
	scope accountdeletion.Scope,
	policy accountdeletion.LegalEvidenceFinalizationPolicy,
	store *postgresadapter.AccountFinalizationStore,
) *accountdeletion.AccountFinalizationService {
	t.Helper()
	service, err := accountdeletion.NewAccountFinalizationService(
		scope, policy, store, store, store, store,
	)
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func assertAccountFinalizationResult(
	t *testing.T,
	ctx context.Context,
	service *accountdeletion.AccountFinalizationService,
	command accountdeletion.AccountFinalizationCommand,
	kind accountdeletion.AccountFinalizationResultKind,
	reason accountdeletion.AccountFinalizationFailureReason,
	outcome accountdeletion.AccountFinalizationOutcome,
) {
	t.Helper()
	result, err := service.Finalize(ctx, command)
	if err != nil || result.Kind != kind || result.Reason != reason || result.Outcome != outcome {
		t.Fatalf("Finalize() = %#v, %v; want kind=%q reason=%q outcome=%q", result, err, kind, reason, outcome)
	}
}

func assertAccountFinalizationRowsDeleted(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	scope accountdeletion.Scope,
) {
	t.Helper()
	checks := []struct {
		table  string
		column string
		value  string
	}{
		{table: "accounts", column: "account_id", value: string(scope.AccountID)},
		{table: "personal_vaults", column: "account_id", value: string(scope.AccountID)},
		{table: "identities", column: "account_id", value: string(scope.AccountID)},
		{table: "sessions", column: "account_id", value: string(scope.AccountID)},
		{table: "verified_email_owners", column: "account_id", value: string(scope.AccountID)},
		{table: "signup_admission_reservations", column: "account_id", value: string(scope.AccountID)},
		{table: "vault_dek_versions", column: "vault_id", value: string(scope.VaultID)},
		{table: "terms_consent_evidence", column: "account_id", value: string(scope.AccountID)},
		{table: "contract_evidence", column: "account_id", value: string(scope.AccountID)},
		{table: "billing_subscriptions", column: "account_id", value: string(scope.AccountID)},
		{table: "entitlement_projections", column: "vault_id", value: string(scope.VaultID)},
	}
	for _, check := range checks {
		assertRowCount(t, ctx, pool, check.table, check.column, check.value, 0)
	}
	assertRowCount(t, ctx, pool, "privacy_requests", "account_id", string(scope.AccountID), 1)
}

func assertAccountFinalizationJournal(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	operation accountdeletion.Operation,
) {
	t.Helper()
	assertRowCount(t, ctx, pool, "account_deletion_operations", "account_id", string(operation.Scope.AccountID), 1)
	assertRowCount(t, ctx, pool, "account_deletion_step_receipts", "operation_id", string(operation.OperationID), 4)
	assertRowCount(t, ctx, pool, "account_deletion_continuations", "operation_id", string(operation.OperationID), 1)
}

func assertAccountFinalizationOwnerStillLive(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	scope accountdeletion.Scope,
) {
	t.Helper()
	assertRowCount(t, ctx, pool, "accounts", "account_id", string(scope.AccountID), 1)
	assertRowCount(t, ctx, pool, "personal_vaults", "account_id", string(scope.AccountID), 1)
	assertRowCount(t, ctx, pool, "identities", "account_id", string(scope.AccountID), 1)
	assertRowCount(t, ctx, pool, "sessions", "account_id", string(scope.AccountID), 1)
	assertRowCount(t, ctx, pool, "verified_email_owners", "account_id", string(scope.AccountID), 1)
	assertRowCount(t, ctx, pool, "signup_admission_reservations", "account_id", string(scope.AccountID), 1)
	assertRowCount(t, ctx, pool, "vault_dek_versions", "vault_id", string(scope.VaultID), 1)
	assertRowCount(t, ctx, pool, "terms_consent_evidence", "account_id", string(scope.AccountID), 1)
	assertRowCount(t, ctx, pool, "contract_evidence", "account_id", string(scope.AccountID), 1)
}

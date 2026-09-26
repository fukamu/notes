//go:build integration

package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fukamu/notes/backend/internal/access"
	"github.com/fukamu/notes/backend/internal/accountdeletion"
	accountdeletioncredentialadapter "github.com/fukamu/notes/backend/internal/adapters/accountdeletioncredential"
	localfixtureadapter "github.com/fukamu/notes/backend/internal/adapters/localfixture"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	recoverykeyadapter "github.com/fukamu/notes/backend/internal/adapters/recoverykey"
	"github.com/fukamu/notes/backend/internal/config"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/localfixture"
	"github.com/fukamu/notes/backend/internal/privacyrequest"
	"github.com/fukamu/notes/backend/internal/syncv2"
	"github.com/fukamu/notes/backend/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	compositionAccountID = "01999c20-9e33-7000-8000-000000000101"
	compositionVaultID   = "01999c20-9e33-7000-8000-000000000102"
	compositionSessionID = "01999c20-9e33-7000-8000-000000000103"
	compositionCardID    = "01999c20-9e33-7000-8000-000000000104"
	compositionMutation  = "01999c20-9e33-7000-8000-000000000105"
	compositionDeletion  = "01999c20-9e33-7000-8000-000000000106"
	compositionDeviceA   = "01999c20-9e33-7000-8000-000000000107"
	compositionDeviceB   = "01999c20-9e33-7000-8000-000000000108"
	compositionPrivacy   = "01999c20-9e33-7000-8000-000000000109"
	compositionReceipt   = "01999c20-9e33-7000-8000-000000000110"
	compositionOrigin    = "http://localhost:3100"
	compositionSecret    = "restart-persistent encrypted fixture content"
)

func TestLocalFixturePrivacyRequestJournalPersistsWithoutProcessingOrDeletion(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("safe NOTES_TEST_DATABASE_URL is required: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	configuration, token := prepareCompositionFixture(t, ctx, databaseURL)
	configuration.Config.LocalFixture.LegalEvidencePolicy = config.LocalFixtureLegalEvidenceUndecided

	first, closeFirst, err := composeRuntime(ctx, configuration.Config)
	if err != nil {
		t.Fatal(err)
	}
	if first.privacyRequest == nil || first.privacyApplication == nil || first.privacyStore == nil ||
		first.accountDeletion != nil {
		closeFirst()
		t.Fatalf("undecided privacy composition = %#v", first)
	}
	firstHandler := compositionHandler(t, configuration, first)
	submitted := serveCompositionPrivacySubmit(firstHandler, token, compositionPrivacy, privacyrequest.KindDisclosure)
	if submitted.Code != http.StatusAccepted {
		closeFirst()
		t.Fatalf("privacy submit = %d %s", submitted.Code, submitted.Body.String())
	}
	status := decodeCompositionPrivacyStatus(t, submitted)
	if status.Status != privacyrequest.StateVerificationPending || status.RequestKind != privacyrequest.KindDisclosure {
		closeFirst()
		t.Fatalf("privacy submit status = %#v", status)
	}

	replayed := serveCompositionPrivacySubmit(firstHandler, token, compositionPrivacy, privacyrequest.KindDisclosure)
	if replayed.Code != http.StatusAccepted || decodeCompositionPrivacyStatus(t, replayed).RequestID != status.RequestID {
		closeFirst()
		t.Fatalf("privacy replay = %d %s", replayed.Code, replayed.Body.String())
	}
	conflict := serveCompositionPrivacySubmit(firstHandler, token, compositionPrivacy, privacyrequest.KindCorrection)
	if conflict.Code != http.StatusConflict || !strings.Contains(conflict.Body.String(), "request-conflict") {
		closeFirst()
		t.Fatalf("privacy conflict = %d %s", conflict.Code, conflict.Body.String())
	}
	foreign := serveCompositionPrivacyStatus(firstHandler, mustCompositionToken(t, bytes.Repeat([]byte{0x7f}, 32)), status.RequestID)
	if foreign.Code != http.StatusUnauthorized {
		closeFirst()
		t.Fatalf("privacy foreign status = %d %s", foreign.Code, foreign.Body.String())
	}
	verification, err := first.privacyApplication.Verify(
		ctx,
		privacyrequest.Scope{AccountID: configuration.context.AccountID, VaultID: configuration.context.VaultID},
		status.RequestID,
		status.UpdatedAt+1,
	)
	if err != nil || verification.Kind != privacyrequest.ApplicationRejected ||
		verification.Reason != privacyrequest.ApplicationUnavailable {
		closeFirst()
		t.Fatalf("unavailable verification = %#v, %v", verification, err)
	}
	before := captureCompositionAdmissionState(t, ctx, databaseURL, configuration.Config.LocalFixture.PrivateRoot)
	assertCompositionPrivacyCounts(t, ctx, databaseURL, 1, 0, 0, 0, 1)
	closeFirst()

	second, closeSecond, err := composeRuntime(ctx, configuration.Config)
	if err != nil {
		t.Fatalf("restart privacy runtime: %v", err)
	}
	defer closeSecond()
	if second.privacyRequest == nil || second.privacyApplication == nil || second.privacyStore == nil {
		t.Fatalf("restarted privacy composition = %#v", second)
	}
	secondHandler := compositionHandler(t, configuration, second)
	restored := serveCompositionPrivacyStatus(secondHandler, token, status.RequestID)
	if restored.Code != http.StatusAccepted || decodeCompositionPrivacyStatus(t, restored) != status {
		t.Fatalf("privacy restart status = %d %s", restored.Code, restored.Body.String())
	}
	after := captureCompositionAdmissionState(t, ctx, databaseURL, configuration.Config.LocalFixture.PrivateRoot)
	if after != before {
		t.Fatalf("privacy journal changed fixture live state\nbefore=%#v\nafter=%#v", before, after)
	}
	assertCompositionPrivacyCounts(t, ctx, databaseURL, 1, 0, 0, 0, 1)
}

func TestLocalFixturePrivacyDeletionHandoffStartsExactlyOneSagaWithoutEffects(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("safe NOTES_TEST_DATABASE_URL is required: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	configuration, token := prepareCompositionFixture(t, ctx, databaseURL)
	runtime, closeRuntime, err := composeRuntime(ctx, configuration.Config)
	if err != nil {
		t.Fatal(err)
	}
	defer closeRuntime()
	if runtime.privacyApplication == nil || runtime.deletionApplication == nil {
		t.Fatalf("delete-live privacy composition = %#v", runtime)
	}
	handler := compositionHandler(t, configuration, runtime)
	submitted := serveCompositionPrivacySubmit(handler, token, compositionPrivacy, privacyrequest.KindDeletion)
	if submitted.Code != http.StatusAccepted {
		t.Fatalf("privacy deletion submit = %d %s", submitted.Code, submitted.Body.String())
	}
	status := decodeCompositionPrivacyStatus(t, submitted)
	record, err := runtime.privacyStore.FindByID(ctx, privacyrequest.Scope{
		AccountID: configuration.context.AccountID,
		VaultID:   configuration.context.VaultID,
	}, status.RequestID)
	if err != nil || record == nil {
		t.Fatalf("find privacy request = %#v, %v", record, err)
	}
	receiptID, _ := privacyrequest.ParseVerificationReceiptID(compositionReceipt)
	verified := privacyrequest.PlanVerification(*record, privacyrequest.VerificationDecision{
		Kind: privacyrequest.VerificationApproved, ReceiptID: receiptID, DecidedAt: status.UpdatedAt + 1,
	})
	if verified.Kind != privacyrequest.PlanAccepted {
		t.Fatalf("verification plan = %#v", verified)
	}
	committed, err := runtime.privacyStore.Commit(ctx, record.Scope, verified.Transition)
	if err != nil || committed.Kind != privacyrequest.CommitApplied {
		t.Fatalf("verification commit = %#v, %v", committed, err)
	}

	const contenders = 16
	results := make(chan privacyrequest.ApplicationResult, contenders)
	errors := make(chan error, contenders)
	var start sync.WaitGroup
	start.Add(1)
	var workers sync.WaitGroup
	for range contenders {
		workers.Add(1)
		go func() {
			defer workers.Done()
			start.Wait()
			result, processErr := runtime.privacyApplication.Process(
				ctx, record.Scope, status.RequestID, status.UpdatedAt+2, status.UpdatedAt+3,
			)
			results <- result
			errors <- processErr
		}()
	}
	start.Done()
	workers.Wait()
	close(results)
	close(errors)
	for processErr := range errors {
		if processErr != nil {
			t.Fatalf("concurrent Process() error = %v", processErr)
		}
	}
	for result := range results {
		if result.Kind != privacyrequest.ApplicationAccepted || result.Request == nil {
			t.Fatalf("concurrent Process() = %#v", result)
		}
	}
	final, err := runtime.privacyApplication.Status(ctx, record.Scope, status.RequestID)
	if err != nil || final.Request == nil || final.Request.Status != privacyrequest.StateCompleted ||
		final.Request.Outcome != privacyrequest.OutcomeAccountDeletionStarted {
		t.Fatalf("privacy deletion final = %#v, %v", final, err)
	}
	replayed, err := runtime.privacyApplication.Process(
		ctx, record.Scope, status.RequestID, status.UpdatedAt+4, status.UpdatedAt+5,
	)
	if err != nil || replayed.Request == nil || replayed.Request.Status != privacyrequest.StateCompleted {
		t.Fatalf("privacy deletion replay = %#v, %v", replayed, err)
	}
	assertCompositionPrivacyCounts(t, ctx, databaseURL, 1, 1, 1, 0, 1)
	sealed := serveCompositionSync(handler, token, `{"version":"sync/v2","deviceId":"`+
		compositionDeviceB+`","cursor":null,"mutations":[]}`)
	if sealed.Code != http.StatusServiceUnavailable {
		t.Fatalf("sync after privacy deletion handoff = %d %s", sealed.Code, sealed.Body.String())
	}
}

func TestLocalFixtureCompositionSyncV2FilesystemEncryptionRestartAndDelete(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("safe NOTES_TEST_DATABASE_URL is required: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	configuration, token := prepareCompositionFixture(t, ctx, databaseURL)

	first, closeFirst, err := composeRuntime(ctx, configuration.Config)
	if err != nil {
		t.Fatalf("compose first runtime: %v", err)
	}
	firstHandler := compositionHandler(t, configuration, first)
	contextResponse := httptest.NewRecorder()
	contextRequest := httptest.NewRequest(http.MethodGet, "/api/session-context", nil)
	contextRequest.Header.Set("Cookie", identity.SessionCookieName+"="+string(token))
	firstHandler.ServeHTTP(contextResponse, contextRequest)
	if contextResponse.Code != http.StatusOK || strings.Contains(contextResponse.Body.String(), string(token)) ||
		!strings.Contains(contextResponse.Body.String(), compositionVaultID) {
		t.Fatalf("session context = %d %s", contextResponse.Code, contextResponse.Body.String())
	}

	mutationBody := `{"version":"sync/v2","deviceId":"` + compositionDeviceA +
		`","cursor":null,"mutations":[{"mutationId":"` + compositionMutation +
		`","cardId":"` + compositionCardID + `","baseServerRevision":null,"title":"` + compositionSecret +
		`","body":[],"createdAt":1000,"updatedAt":1000,"kind":"upsert","conflictIds":[]}]}`
	created := serveCompositionSync(firstHandler, token, mutationBody)
	if created.Code != http.StatusOK || !strings.Contains(created.Body.String(), compositionSecret) {
		t.Fatalf("create sync = %d %s", created.Code, created.Body.String())
	}
	assertCompositionCiphertext(t, ctx, first, compositionSecret)
	closeFirst()

	second, closeSecond, err := composeRuntime(ctx, configuration.Config)
	if err != nil {
		t.Fatalf("compose restarted runtime: %v", err)
	}
	defer closeSecond()
	secondHandler := compositionHandler(t, configuration, second)
	readBody := `{"version":"sync/v2","deviceId":"` + compositionDeviceB + `","cursor":null,"mutations":[]}`
	read := serveCompositionSync(secondHandler, token, readBody)
	if read.Code != http.StatusOK || !strings.Contains(read.Body.String(), compositionSecret) {
		t.Fatalf("restart read = %d %s", read.Code, read.Body.String())
	}

	cardID, _ := syncv2.ParseCardID(compositionCardID)
	deletionID, _ := syncv2.ParseMutationID(compositionDeletion)
	deletedAt := time.Now().UnixMilli()
	deleted, err := second.syncV2Application.DeleteCard(ctx, syncv2.DeleteCardInput{
		Context: configuration.LocalFixtureContext(), MutationID: deletionID,
		CardID: cardID, ExpectedRevision: 1, DeletedAt: deletedAt,
		SynchronizedAt: deletedAt, Limits: entitlement.PaidPersonalVaultLimits(),
	})
	if err != nil || deleted.Kind != syncv2.DeleteCardDeleted || deleted.Receipt.AppliedRevision != 2 {
		t.Fatalf("delete = %#v, %v", deleted, err)
	}
	replayed, err := second.syncV2Application.DeleteCard(ctx, syncv2.DeleteCardInput{
		Context: configuration.LocalFixtureContext(), MutationID: deletionID,
		CardID: cardID, ExpectedRevision: 1, DeletedAt: deletedAt,
		SynchronizedAt: deletedAt, Limits: entitlement.PaidPersonalVaultLimits(),
	})
	if err != nil || replayed.Kind != syncv2.DeleteCardDeleted || replayed.Receipt != deleted.Receipt {
		t.Fatalf("delete replay = %#v, %v", replayed, err)
	}
	final := serveCompositionSync(secondHandler, token, readBody)
	if final.Code != http.StatusOK || !strings.Contains(final.Body.String(), `"kind":"card-tombstone"`) ||
		!strings.Contains(final.Body.String(), `"revision":2`) {
		t.Fatalf("tombstone sync = %d %s", final.Code, final.Body.String())
	}

	unauthorized := serveCompositionSync(
		secondHandler,
		mustCompositionToken(t, bytes.Repeat([]byte{0x7f}, 32)),
		readBody,
	)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("foreign token = %d %s", unauthorized.Code, unauthorized.Body.String())
	}
}

func TestLocalFixtureCompositionAccountDeletionLifecycleAndPhaseRestarts(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("safe NOTES_TEST_DATABASE_URL is required: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	configuration, token := prepareCompositionFixture(t, ctx, databaseURL)

	initial, closeInitial, err := composeRuntime(ctx, configuration.Config)
	if err != nil {
		t.Fatalf("compose initial runtime: %v", err)
	}
	initialHandler := compositionHandler(t, configuration, initial)
	contextResponse := serveCompositionSessionContext(initialHandler, token)
	if contextResponse.Code != http.StatusOK ||
		!strings.Contains(contextResponse.Body.String(), `"accountDeletionAvailable":true`) {
		closeInitial()
		t.Fatalf("deletion-capable session context = %d %s", contextResponse.Code, contextResponse.Body.String())
	}
	privacySubmitted := serveCompositionPrivacySubmit(
		initialHandler, token, compositionPrivacy, privacyrequest.KindDisclosure,
	)
	if privacySubmitted.Code != http.StatusAccepted {
		closeInitial()
		t.Fatalf("privacy journal before deletion = %d %s", privacySubmitted.Code, privacySubmitted.Body.String())
	}
	privacyStatus := decodeCompositionPrivacyStatus(t, privacySubmitted)
	mutationBody := `{"version":"sync/v2","deviceId":"` + compositionDeviceA +
		`","cursor":null,"mutations":[{"mutationId":"` + compositionMutation +
		`","cardId":"` + compositionCardID + `","baseServerRevision":null,"title":"` + compositionSecret +
		`","body":[],"createdAt":1000,"updatedAt":1000,"kind":"upsert","conflictIds":[]}]}`
	created := serveCompositionSync(initialHandler, token, mutationBody)
	if created.Code != http.StatusOK {
		closeInitial()
		t.Fatalf("create before deletion = %d %s", created.Code, created.Body.String())
	}
	assertCompositionCiphertext(t, ctx, initial, compositionSecret)

	started := serveCompositionDeletionStart(initialHandler, token, strings.Repeat("D", 43))
	startResponse := decodeCompositionDeletionResponse(t, started)
	if started.Code != http.StatusAccepted || startResponse.Status != accountdeletion.PublicInProgress ||
		startResponse.ContinuationToken == "" {
		closeInitial()
		t.Fatalf("deletion start = %d %#v %s", started.Code, startResponse, started.Body.String())
	}
	sealedSync := serveCompositionSync(initialHandler, token, `{"version":"sync/v2","deviceId":"`+
		compositionDeviceB+`","cursor":null,"mutations":[]}`)
	if sealedSync.Code != http.StatusServiceUnavailable {
		closeInitial()
		t.Fatalf("sync after deletion admission = %d %s", sealedSync.Code, sealedSync.Body.String())
	}
	closeInitial()

	preEffect, closePreEffect, err := composeRuntime(ctx, configuration.Config)
	if err != nil {
		t.Fatalf("compose pre-effect deletion restart: %v", err)
	}
	if preEffect.syncV2 != nil || preEffect.syncV2Application != nil || preEffect.accountDeletion == nil ||
		preEffect.privacyRequest == nil || preEffect.privacyApplication == nil {
		closePreEffect()
		t.Fatalf("pre-effect deleting composition exposed sync or omitted deletion: %#v", preEffect)
	}
	preEffectHandler := compositionHandler(t, configuration, preEffect)
	if response := serveCompositionPrivacyStatus(preEffectHandler, token, privacyStatus.RequestID); response.Code != http.StatusAccepted {
		closePreEffect()
		t.Fatalf("privacy journal during deleting phase = %d %s", response.Code, response.Body.String())
	}
	legacyRequest := httptest.NewRequest(http.MethodPost, "/api/sync", strings.NewReader(`{"cards":[]}`))
	legacyResponse := httptest.NewRecorder()
	preEffectHandler.ServeHTTP(legacyResponse, legacyRequest)
	if legacyResponse.Code != http.StatusNotFound {
		closePreEffect()
		t.Fatalf("legacy sync reopened during deletion restart: %d %s", legacyResponse.Code, legacyResponse.Body.String())
	}
	response := serveCompositionDeletionResume(preEffectHandler, startResponse.ContinuationToken)
	current := decodeCompositionDeletionResponse(t, response)
	if response.Code != http.StatusAccepted || current.Status != accountdeletion.PublicInProgress ||
		current.ContinuationToken == "" || response.Header().Get("Set-Cookie") != identity.ClearSessionCookie() {
		closePreEffect()
		t.Fatalf("session revocation = %d %#v headers=%v", response.Code, current, response.Header())
	}
	closePreEffect()

	resumed, closeResumed, err := composeRuntime(ctx, configuration.Config)
	if err != nil {
		t.Fatalf("compose post-revocation restart: %v", err)
	}
	resumedHandler := compositionHandler(t, configuration, resumed)
	for attempts := 0; current.Status != accountdeletion.PublicCompleted && attempts < 8; attempts++ {
		response = serveCompositionDeletionResume(resumedHandler, current.ContinuationToken)
		current = decodeCompositionDeletionResponse(t, response)
		if response.Code != http.StatusAccepted && response.Code != http.StatusOK {
			closeResumed()
			t.Fatalf("deletion resume = %d %#v %s", response.Code, current, response.Body.String())
		}
		if current.Status == accountdeletion.PublicInProgress {
			closeResumed()
			resumed, closeResumed, err = composeRuntime(ctx, configuration.Config)
			if err != nil {
				t.Fatalf("compose after receipt %d: %v", attempts+2, err)
			}
			if resumed.syncV2 != nil || resumed.accountDeletion == nil ||
				resumed.private.Readiness.Check(ctx) != nil {
				closeResumed()
				t.Fatalf("receipt %d restart composition = %#v", attempts+2, resumed)
			}
			resumedHandler = compositionHandler(t, configuration, resumed)
		}
	}
	if response.Code != http.StatusOK || current.Status != accountdeletion.PublicCompleted ||
		current.ContinuationToken != "" {
		closeResumed()
		t.Fatalf("deletion completion = %d %#v", response.Code, current)
	}
	closeResumed()

	completed, closeCompleted, err := composeRuntime(ctx, configuration.Config)
	if err != nil {
		t.Fatalf("compose completed restart: %v", err)
	}
	if completed.syncV2 != nil || completed.localFixture != nil || completed.accountDeletion == nil ||
		completed.privacyRequest == nil || completed.privacyApplication == nil ||
		completed.private.Readiness.Check(ctx) != nil {
		closeCompleted()
		t.Fatalf("completed composition is not closed and ready: %#v", completed)
	}
	completedHandler := compositionHandler(t, configuration, completed)
	if response := serveCompositionPrivacyStatus(completedHandler, token, privacyStatus.RequestID); response.Code != http.StatusUnauthorized {
		closeCompleted()
		t.Fatalf("deleted owner privacy status = %d %s", response.Code, response.Body.String())
	}
	closeCompleted()
	configuration.Config.LocalFixture.LegalEvidencePolicy = config.LocalFixtureLegalEvidenceUndecided
	if unavailable, closeUnavailable, restartErr := composeRuntime(ctx, configuration.Config); restartErr == nil {
		closeUnavailable()
		t.Fatalf("completed fixture restarted without explicit deletion policy: %#v", unavailable)
	}
	assertCompositionDeletionComplete(t, ctx, databaseURL, configuration.Config.LocalFixture.PrivateRoot)
	assertCompositionPrivacyCounts(t, ctx, databaseURL, 1, 1, 1, 5, 0)
}

func TestLocalFixtureCompositionRenewsExpiredPreRevocationContinuationThroughHTTP(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("safe NOTES_TEST_DATABASE_URL is required: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	configuration, token := prepareCompositionFixture(t, ctx, databaseURL)
	runtime, closeRuntime, err := composeRuntime(ctx, configuration.Config)
	if err != nil {
		t.Fatal(err)
	}
	handler := compositionHandler(t, configuration, runtime)
	idempotencyKey := strings.Repeat("E", 43)
	started := serveCompositionDeletionStart(handler, token, idempotencyKey)
	initial := decodeCompositionDeletionResponse(t, started)
	if started.Code != http.StatusAccepted || initial.Status != accountdeletion.PublicInProgress ||
		initial.ContinuationToken == "" {
		closeRuntime()
		t.Fatalf("initial Start = %d %#v", started.Code, initial)
	}

	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 2)
	if err != nil {
		closeRuntime()
		t.Fatal(err)
	}
	var initialExpiry int64
	if err := pool.QueryRow(ctx, `SELECT expires_at FROM account_deletion_continuations`).Scan(&initialExpiry); err != nil {
		pool.Close()
		closeRuntime()
		t.Fatal(err)
	}
	unexpiredReplay := serveCompositionDeletionStart(handler, token, idempotencyKey)
	unexpiredResponse := decodeCompositionDeletionResponse(t, unexpiredReplay)
	var unchangedExpiry int64
	if err := pool.QueryRow(ctx, `SELECT expires_at FROM account_deletion_continuations`).Scan(&unchangedExpiry); err != nil ||
		unexpiredReplay.Code != http.StatusAccepted ||
		unexpiredResponse.ContinuationToken != initial.ContinuationToken || unchangedExpiry != initialExpiry {
		pool.Close()
		closeRuntime()
		t.Fatalf("unexpired replay slid expiry response=%d %#v initial=%d current=%d error=%v",
			unexpiredReplay.Code, unexpiredResponse, initialExpiry, unchangedExpiry, err)
	}
	now := time.Now().UnixMilli()
	createdAt := now - int64((8*24*time.Hour)/time.Millisecond)
	expiredAt := createdAt + int64((7*24*time.Hour)/time.Millisecond)
	tx, err := pool.Begin(ctx)
	if err != nil {
		pool.Close()
		closeRuntime()
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE account_deletion_operations
		SET created_at = $1, updated_at = $1, not_before = $1
		WHERE account_id = $2 AND vault_id = $3 AND revision = 1
		  AND state = 'ready' AND current_step = 'revoke-sessions' AND attempt = 0`,
		createdAt, compositionAccountID, compositionVaultID,
	); err == nil {
		_, err = tx.Exec(ctx, `UPDATE account_deletion_continuations
			SET created_at = $1, updated_at = $1, expires_at = $2`, createdAt, expiredAt)
	}
	if err != nil {
		_ = tx.Rollback(ctx)
		pool.Close()
		closeRuntime()
		t.Fatalf("age pre-revocation operation: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		pool.Close()
		closeRuntime()
		t.Fatal(err)
	}

	conflict := serveCompositionDeletionStart(handler, token, strings.Repeat("F", 43))
	if conflict.Code != http.StatusConflict {
		pool.Close()
		closeRuntime()
		t.Fatalf("conflicting renewal = %d %s", conflict.Code, conflict.Body.String())
	}
	var persistedExpiry, sequence, activeSessions, receipts int64
	var state string
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT expires_at FROM account_deletion_continuations),
		(SELECT sequence FROM account_deletion_continuations),
		(SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL),
		(SELECT COUNT(*) FROM account_deletion_step_receipts),
		(SELECT state FROM account_deletion_operations)`,
	).Scan(&persistedExpiry, &sequence, &activeSessions, &receipts, &state); err != nil ||
		persistedExpiry != expiredAt || sequence != 0 || activeSessions != 1 || receipts != 0 ||
		state != string(accountdeletion.StateReady) {
		pool.Close()
		closeRuntime()
		t.Fatalf("conflict mutated fixture expiry=%d sequence=%d sessions=%d receipts=%d state=%s error=%v",
			persistedExpiry, sequence, activeSessions, receipts, state, err)
	}

	expired := serveCompositionDeletionResume(handler, initial.ContinuationToken)
	if expired.Code != http.StatusUnauthorized || !strings.Contains(expired.Body.String(), "continuation-required") {
		pool.Close()
		closeRuntime()
		t.Fatalf("expired Resume = %d %s", expired.Code, expired.Body.String())
	}
	renewed := serveCompositionDeletionStart(handler, token, idempotencyKey)
	renewedResponse := decodeCompositionDeletionResponse(t, renewed)
	if renewed.Code != http.StatusAccepted || renewedResponse.Status != accountdeletion.PublicInProgress ||
		renewedResponse.ContinuationToken != initial.ContinuationToken {
		pool.Close()
		closeRuntime()
		t.Fatalf("renewal Start = %d %#v", renewed.Code, renewedResponse)
	}
	if err := pool.QueryRow(ctx, `SELECT expires_at, sequence
		FROM account_deletion_continuations`).Scan(&persistedExpiry, &sequence); err != nil ||
		persistedExpiry <= now || sequence != 0 {
		pool.Close()
		closeRuntime()
		t.Fatalf("renewed continuation expiry=%d sequence=%d error=%v", persistedExpiry, sequence, err)
	}
	renewedExpiry := persistedExpiry
	// A lost renewal response is safe to replay and returns the same
	// secret/sequence token while preserving the newly durable expiry.
	replayed := serveCompositionDeletionStart(handler, token, idempotencyKey)
	replayedResponse := decodeCompositionDeletionResponse(t, replayed)
	if replayed.Code != http.StatusAccepted ||
		replayedResponse.ContinuationToken != renewedResponse.ContinuationToken {
		pool.Close()
		closeRuntime()
		t.Fatalf("renewal replay = %d %#v", replayed.Code, replayedResponse)
	}
	if err := pool.QueryRow(ctx, `SELECT expires_at FROM account_deletion_continuations`).Scan(&persistedExpiry); err != nil ||
		persistedExpiry != renewedExpiry {
		pool.Close()
		closeRuntime()
		t.Fatalf("lost-response replay slid expiry initial=%d current=%d error=%v",
			renewedExpiry, persistedExpiry, err)
	}
	pool.Close()
	closeRuntime()

	restarted, closeRestarted, err := composeRuntime(ctx, configuration.Config)
	if err != nil {
		t.Fatalf("restart after pre-revocation renewal: %v", err)
	}
	restartedHandler := compositionHandler(t, configuration, restarted)
	resumed := serveCompositionDeletionResume(restartedHandler, renewedResponse.ContinuationToken)
	resumedResponse := decodeCompositionDeletionResponse(t, resumed)
	if resumed.Code != http.StatusAccepted || resumedResponse.Status != accountdeletion.PublicInProgress ||
		resumed.Header().Get("Set-Cookie") != identity.ClearSessionCookie() {
		closeRestarted()
		t.Fatalf("renewed Resume = %d %#v headers=%v", resumed.Code, resumedResponse, resumed.Header())
	}
	unauthenticatedReplay := serveCompositionDeletionStart(restartedHandler, token, idempotencyKey)
	if unauthenticatedReplay.Code != http.StatusUnauthorized ||
		!strings.Contains(unauthenticatedReplay.Body.String(), "authentication-required") {
		closeRestarted()
		t.Fatalf("post-revocation Start = %d %s", unauthenticatedReplay.Code, unauthenticatedReplay.Body.String())
	}
	verificationPool, err := postgresadapter.OpenPool(ctx, databaseURL, 1)
	if err != nil {
		closeRestarted()
		t.Fatal(err)
	}
	defer verificationPool.Close()
	if err := verificationPool.QueryRow(ctx, `SELECT
		(SELECT expires_at FROM account_deletion_continuations),
		(SELECT sequence FROM account_deletion_continuations),
		(SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL),
		(SELECT COUNT(*) FROM account_deletion_step_receipts)`,
	).Scan(&persistedExpiry, &sequence, &activeSessions, &receipts); err != nil ||
		persistedExpiry != identity.MaximumSafeInteger || sequence != 1 || activeSessions != 0 || receipts != 1 {
		closeRestarted()
		t.Fatalf("post-revocation mutation expiry=%d sequence=%d sessions=%d receipts=%d error=%v",
			persistedExpiry, sequence, activeSessions, receipts, err)
	}
	closeRestarted()
}

func TestLocalFixtureCompositionUndecidedLegalPolicyRejectsAdmissionWithoutSideEffects(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("safe NOTES_TEST_DATABASE_URL is required: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	configuration, token := prepareCompositionFixture(t, ctx, databaseURL)
	configuration.Config.LocalFixture.LegalEvidencePolicy = config.LocalFixtureLegalEvidenceUndecided

	runtime, closeRuntime, err := composeRuntime(ctx, configuration.Config)
	if err != nil {
		t.Fatal(err)
	}
	handler := compositionHandler(t, configuration, runtime)
	mutationBody := `{"version":"sync/v2","deviceId":"` + compositionDeviceA +
		`","cursor":null,"mutations":[{"mutationId":"` + compositionMutation +
		`","cardId":"` + compositionCardID + `","baseServerRevision":null,"title":"policy barrier"` +
		`,"body":[],"createdAt":1000,"updatedAt":1000,"kind":"upsert","conflictIds":[]}]}`
	if response := serveCompositionSync(handler, token, mutationBody); response.Code != http.StatusOK {
		closeRuntime()
		t.Fatalf("seed sync = %d %s", response.Code, response.Body.String())
	}
	before := captureCompositionAdmissionState(t, ctx, databaseURL, configuration.Config.LocalFixture.PrivateRoot)
	if runtime.accountDeletion != nil || runtime.deletionApplication != nil {
		closeRuntime()
		t.Fatalf("undecided policy exposed deletion runtime: %#v", runtime)
	}
	contextResponse := serveCompositionSessionContext(handler, token)
	if contextResponse.Code != http.StatusOK ||
		!strings.Contains(contextResponse.Body.String(), `"accountDeletionAvailable":false`) {
		closeRuntime()
		t.Fatalf("undecided session context = %d %s", contextResponse.Code, contextResponse.Body.String())
	}
	for attempt := 0; attempt < 2; attempt++ {
		started := serveCompositionDeletionStart(handler, token, strings.Repeat("U", 43))
		if started.Code != http.StatusNotFound || !strings.Contains(started.Body.String(), `"error":"not-found"`) {
			closeRuntime()
			t.Fatalf("undecided start %d = %d %s", attempt, started.Code, started.Body.String())
		}
	}
	if response := serveCompositionSync(handler, token,
		`{"version":"sync/v2","deviceId":"`+compositionDeviceB+`","cursor":null,"mutations":[]}`,
	); response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "policy barrier") {
		closeRuntime()
		t.Fatalf("sync after rejected deletion = %d %s", response.Code, response.Body.String())
	}
	afterAttempts := captureCompositionAdmissionState(t, ctx, databaseURL, configuration.Config.LocalFixture.PrivateRoot)
	if afterAttempts != before {
		closeRuntime()
		t.Fatalf("undecided start changed fixture state\nbefore=%#v\nafter=%#v", before, afterAttempts)
	}
	closeRuntime()

	restarted, closeRestarted, err := composeRuntime(ctx, configuration.Config)
	if err != nil {
		t.Fatalf("undecided retry restart: %v", err)
	}
	if restarted.syncV2 == nil || restarted.accountDeletion != nil || restarted.deletionApplication != nil ||
		restarted.private.Readiness.Check(ctx) != nil {
		closeRestarted()
		t.Fatalf("undecided restart composition = %#v", restarted)
	}
	restartedHandler := compositionHandler(t, configuration, restarted)
	if response := serveCompositionDeletionStart(restartedHandler, token, strings.Repeat("U", 43)); response.Code != http.StatusNotFound {
		closeRestarted()
		t.Fatalf("undecided restart start = %d %s", response.Code, response.Body.String())
	}
	afterRestart := captureCompositionAdmissionState(t, ctx, databaseURL, configuration.Config.LocalFixture.PrivateRoot)
	if afterRestart != before {
		closeRestarted()
		t.Fatalf("undecided restart changed fixture state\nbefore=%#v\nafter=%#v", before, afterRestart)
	}
	closeRestarted()
}

func TestLocalFixtureCompositionDeletingPhaseRequiresExplicitPolicyOnRestart(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("safe NOTES_TEST_DATABASE_URL is required: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	configuration, token := prepareCompositionFixture(t, ctx, databaseURL)

	runtime, closeRuntime, err := composeRuntime(ctx, configuration.Config)
	if err != nil {
		t.Fatal(err)
	}
	handler := compositionHandler(t, configuration, runtime)
	started := serveCompositionDeletionStart(handler, token, strings.Repeat("P", 43))
	if response := decodeCompositionDeletionResponse(t, started); started.Code != http.StatusAccepted ||
		response.Status != accountdeletion.PublicInProgress {
		closeRuntime()
		t.Fatalf("deletion admission = %d %#v", started.Code, response)
	}
	closeRuntime()

	configuration.Config.LocalFixture.LegalEvidencePolicy = config.LocalFixtureLegalEvidenceUndecided
	if unavailable, closeUnavailable, restartErr := composeRuntime(ctx, configuration.Config); restartErr == nil {
		closeUnavailable()
		t.Fatalf("deleting fixture restarted without explicit policy: %#v", unavailable)
	}
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var operations, activeSessions int64
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM account_deletion_operations),
		(SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL)`,
	).Scan(&operations, &activeSessions); err != nil {
		t.Fatal(err)
	}
	if operations != 1 || activeSessions != 1 {
		t.Fatalf("failed restart mutated deleting fixture operations=%d active_sessions=%d", operations, activeSessions)
	}
}

func TestLocalFixtureCompositionObjectDirectorySwapCannotRedirectDeletion(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("safe NOTES_TEST_DATABASE_URL is required: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	configuration, token := prepareCompositionFixture(t, ctx, databaseURL)
	runtime, closeRuntime, err := composeRuntime(ctx, configuration.Config)
	if err != nil {
		t.Fatal(err)
	}
	defer closeRuntime()
	handler := compositionHandler(t, configuration, runtime)
	mutationBody := `{"version":"sync/v2","deviceId":"` + compositionDeviceA +
		`","cursor":null,"mutations":[{"mutationId":"` + compositionMutation +
		`","cardId":"` + compositionCardID + `","baseServerRevision":null,"title":"swap barrier"` +
		`,"body":[],"createdAt":1000,"updatedAt":1000,"kind":"upsert","conflictIds":[]}]}`
	if response := serveCompositionSync(handler, token, mutationBody); response.Code != http.StatusOK {
		t.Fatalf("seed sync = %d %s", response.Code, response.Body.String())
	}
	descriptors, err := runtime.localFixture.Objects.List(ctx)
	if err != nil || len(descriptors) != 1 {
		t.Fatalf("object descriptors = %#v, %v", descriptors, err)
	}
	objectKey := descriptors[0].ObjectKey
	started := serveCompositionDeletionStart(handler, token, strings.Repeat("S", 43))
	current := decodeCompositionDeletionResponse(t, started)
	// Revoke sessions, observe no-network cancellation, then delete Vault rows
	// and enqueue the durable private-object delete.
	for step := 0; step < 3; step++ {
		response := serveCompositionDeletionResume(handler, current.ContinuationToken)
		current = decodeCompositionDeletionResponse(t, response)
		if response.Code != http.StatusAccepted || current.Status != accountdeletion.PublicInProgress {
			t.Fatalf("pre-swap step %d = %d %#v", step, response.Code, current)
		}
	}

	layout, err := localfixtureadapter.OpenLayout(configuration.Config.LocalFixture.PrivateRoot)
	if err != nil {
		t.Fatal(err)
	}
	moved := filepath.Join(t.TempDir(), "anchored-objects")
	if err := os.Rename(layout.ObjectDirectory, moved); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	outsidePath := filepath.Join(outside, string(objectKey))
	if err := os.WriteFile(outsidePath, []byte("outside-must-survive"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, layout.ObjectDirectory); err != nil {
		t.Fatal(err)
	}
	response := serveCompositionDeletionResume(handler, current.ContinuationToken)
	current = decodeCompositionDeletionResponse(t, response)
	if response.Code != http.StatusAccepted || current.Status != accountdeletion.PublicRetryWait ||
		current.ContinuationToken == "" {
		t.Fatalf("swapped private-object step = %d %#v %s", response.Code, current, response.Body.String())
	}
	for path, content := range map[string]string{
		filepath.Join(moved, string(objectKey)): "swap barrier",
		outsidePath:                             "outside-must-survive",
	} {
		encoded, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("protected file %s: %v", path, err)
		}
		if content == "swap barrier" {
			if !bytes.Contains(encoded, []byte(`"sealedPayload"`)) {
				t.Fatalf("anchored ciphertext changed: %s", encoded)
			}
		} else if string(encoded) != content {
			t.Fatalf("outside file = %q", encoded)
		}
	}
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var pending int64
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM vault_object_delete_outbox WHERE object_key = $1`, string(objectKey)).Scan(&pending); err != nil || pending != 1 {
		t.Fatalf("unconfirmed outbox rows = %d, %v", pending, err)
	}
}

func TestLocalFixtureCompositionRecoversEffectBeforeReceiptAtEveryBoundary(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("safe NOTES_TEST_DATABASE_URL is required: %v", err)
	}
	cases := []struct {
		name       string
		targetStep accountdeletion.Step
		quarantine bool
	}{
		{name: string(accountdeletion.StepRevokeSessions), targetStep: accountdeletion.StepRevokeSessions},
		{name: string(accountdeletion.StepCancelSubscription), targetStep: accountdeletion.StepCancelSubscription},
		{name: string(accountdeletion.StepDeleteVaultData), targetStep: accountdeletion.StepDeleteVaultData},
		{name: string(accountdeletion.StepDeletePrivateObject), targetStep: accountdeletion.StepDeletePrivateObject},
		{name: "delete-private-object-quarantine", targetStep: accountdeletion.StepDeletePrivateObject, quarantine: true},
		{name: string(accountdeletion.StepFinalizeAccount), targetStep: accountdeletion.StepFinalizeAccount},
	}
	stepIndex := map[accountdeletion.Step]int{
		accountdeletion.StepRevokeSessions: 0, accountdeletion.StepCancelSubscription: 1,
		accountdeletion.StepDeleteVaultData: 2, accountdeletion.StepDeletePrivateObject: 3,
		accountdeletion.StepFinalizeAccount: 4,
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			targetStep := testCase.targetStep
			targetIndex := stepIndex[targetStep]
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			configuration, token := prepareCompositionFixture(t, ctx, databaseURL)
			runtime, closeRuntime, err := composeRuntime(ctx, configuration.Config)
			if err != nil {
				t.Fatal(err)
			}
			handler := compositionHandler(t, configuration, runtime)
			mutationBody := `{"version":"sync/v2","deviceId":"` + compositionDeviceA +
				`","cursor":null,"mutations":[{"mutationId":"` + compositionMutation +
				`","cardId":"` + compositionCardID + `","baseServerRevision":null,"title":"effect crash"` +
				`,"body":[],"createdAt":1000,"updatedAt":1000,"kind":"upsert","conflictIds":[]}]}`
			if response := serveCompositionSync(handler, token, mutationBody); response.Code != http.StatusOK {
				closeRuntime()
				t.Fatalf("seed sync = %d %s", response.Code, response.Body.String())
			}
			descriptors, err := runtime.localFixture.Objects.List(ctx)
			if err != nil || len(descriptors) != 1 {
				closeRuntime()
				t.Fatalf("seed object descriptors = %#v, %v", descriptors, err)
			}
			started := serveCompositionDeletionStart(handler, token, strings.Repeat("R", 43))
			current := decodeCompositionDeletionResponse(t, started)
			if started.Code != http.StatusAccepted || current.Status != accountdeletion.PublicInProgress {
				closeRuntime()
				t.Fatalf("start = %d %#v", started.Code, current)
			}
			for prior := 0; prior < targetIndex; prior++ {
				response := serveCompositionDeletionResume(handler, current.ContinuationToken)
				current = decodeCompositionDeletionResponse(t, response)
				if response.Code != http.StatusAccepted || current.Status != accountdeletion.PublicInProgress {
					closeRuntime()
					t.Fatalf("prior step %d = %d %#v", prior, response.Code, current)
				}
			}

			pool, err := postgresadapter.OpenPool(ctx, databaseURL, 2)
			if err != nil {
				closeRuntime()
				t.Fatal(err)
			}
			store, err := postgresadapter.NewAccountDeletionStore(pool)
			if err != nil {
				pool.Close()
				closeRuntime()
				t.Fatal(err)
			}
			scope := accountdeletion.Scope{
				AccountID: configuration.context.AccountID, VaultID: configuration.context.VaultID,
			}
			snapshot, err := store.FindByOwner(ctx, scope)
			ready, readyOK := func() (accountdeletion.Ready, bool) {
				if snapshot == nil {
					return accountdeletion.Ready{}, false
				}
				value, ok := snapshot.Operation.State.(accountdeletion.Ready)
				return value, ok
			}()
			if err != nil || !readyOK || ready.Step != targetStep || len(snapshot.Receipts) != targetIndex {
				pool.Close()
				closeRuntime()
				t.Fatalf("pre-crash snapshot = %#v, %v", snapshot, err)
			}
			claimAt := time.Now().UnixMilli()
			if claimAt < snapshot.Operation.UpdatedAt {
				claimAt = snapshot.Operation.UpdatedAt
			}
			claim := accountdeletion.PlanStepClaim(snapshot.Operation, claimAt, claimAt+1)
			claimed, err := store.Commit(ctx, scope, claim.Transition)
			if claim.Kind != accountdeletion.PlanAccepted || err != nil ||
				claimed.Kind != accountdeletion.CommitApplied || claimed.Current == nil {
				pool.Close()
				closeRuntime()
				t.Fatalf("claim = %#v, result=%#v, %v", claim, claimed, err)
			}
			running := claimed.Current.Operation.State.(accountdeletion.Running)
			requestedAt := claimed.Current.Operation.CreatedAt
			if len(claimed.Current.Receipts) != 0 {
				requestedAt = claimed.Current.Receipts[len(claimed.Current.Receipts)-1].CompletedAt
			}
			effectInput := accountdeletion.StepEffectInput{
				Scope: scope, OperationID: claimed.Current.Operation.OperationID,
				Step: targetStep, Attempt: running.Attempt,
				RequestedAt: requestedAt, ExecutedAt: claimAt,
			}
			var effectResult accountdeletion.StepEffectResult
			if testCase.quarantine {
				layout, layoutErr := localfixtureadapter.OpenLayout(configuration.Config.LocalFixture.PrivateRoot)
				if layoutErr != nil {
					pool.Close()
					closeRuntime()
					t.Fatal(layoutErr)
				}
				name := string(descriptors[0].ObjectKey)
				if err := os.Rename(
					filepath.Join(layout.ObjectDirectory, name),
					filepath.Join(layout.ObjectDirectory, ".delete-"+name),
				); err != nil {
					pool.Close()
					closeRuntime()
					t.Fatalf("simulate storage-delete quarantine crash: %v", err)
				}
				effectResult = accountdeletion.StepEffectResult{Kind: accountdeletion.EffectSucceeded}
			} else {
				effectResult, err = executeComposedDeletionEffect(ctx, runtime.deletionEffects, effectInput)
			}
			if err != nil || effectResult.Kind != accountdeletion.EffectSucceeded {
				pool.Close()
				closeRuntime()
				t.Fatalf("effect before receipt = %#v, %v", effectResult, err)
			}
			var receiptCount int
			if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM account_deletion_step_receipts`).Scan(&receiptCount); err != nil || receiptCount != targetIndex {
				pool.Close()
				closeRuntime()
				t.Fatalf("pre-crash receipts = %d, %v", receiptCount, err)
			}
			pool.Close()
			closeRuntime()
			for time.Now().UnixMilli() <= running.LeaseExpiresAt {
				time.Sleep(time.Millisecond)
			}

			restarted, closeRestarted, err := composeRuntime(ctx, configuration.Config)
			if err != nil {
				t.Fatalf("restart after %s effect: %v", targetStep, err)
			}
			defer closeRestarted()
			restartedHandler := compositionHandler(t, configuration, restarted)
			recovered := serveCompositionDeletionResume(restartedHandler, current.ContinuationToken)
			current = decodeCompositionDeletionResponse(t, recovered)
			if recovered.Code != http.StatusAccepted || current.Status != accountdeletion.PublicRetryWait ||
				current.RetryAt == nil {
				t.Fatalf("lease recovery = %d %#v", recovered.Code, current)
			}
			for time.Now().UnixMilli() < *current.RetryAt {
				time.Sleep(time.Millisecond)
			}
			readyResponse := serveCompositionDeletionResume(restartedHandler, current.ContinuationToken)
			current = decodeCompositionDeletionResponse(t, readyResponse)
			if readyResponse.Code != http.StatusAccepted || current.Status != accountdeletion.PublicInProgress {
				t.Fatalf("retry readiness = %d %#v", readyResponse.Code, current)
			}
			retried := serveCompositionDeletionResume(restartedHandler, current.ContinuationToken)
			current = decodeCompositionDeletionResponse(t, retried)
			wantCode := http.StatusAccepted
			wantStatus := accountdeletion.PublicInProgress
			if targetStep == accountdeletion.StepFinalizeAccount {
				wantCode = http.StatusOK
				wantStatus = accountdeletion.PublicCompleted
			}
			if retried.Code != wantCode || current.Status != wantStatus {
				t.Fatalf("effect replay = %d %#v %s", retried.Code, current, retried.Body.String())
			}
			if testCase.quarantine {
				layout, layoutErr := localfixtureadapter.OpenLayout(configuration.Config.LocalFixture.PrivateRoot)
				entries, readErr := os.ReadDir(layout.ObjectDirectory)
				if layoutErr != nil || readErr != nil || len(entries) != 0 {
					t.Fatalf("quarantine recovery inventory = %v, %v, %v", entries, layoutErr, readErr)
				}
			}
			verificationPool, err := postgresadapter.OpenPool(ctx, databaseURL, 1)
			if err != nil {
				t.Fatal(err)
			}
			defer verificationPool.Close()
			if err := verificationPool.QueryRow(ctx, `SELECT COUNT(*) FROM account_deletion_step_receipts`).Scan(&receiptCount); err != nil || receiptCount != targetIndex+1 {
				t.Fatalf("recovered receipts = %d, %v", receiptCount, err)
			}
		})
	}
}

func TestLocalFixtureCompositionRevocationClaimPromotesLongLivedRecoveryCredential(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("safe NOTES_TEST_DATABASE_URL is required: %v", err)
	}
	cases := []struct {
		name               string
		executeEffect      bool
		resumeWithPrevious bool
	}{
		{name: "claim-before-effect-current-token"},
		{name: "effect-before-receipt-previous-token", executeEffect: true, resumeWithPrevious: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			configuration, token := prepareCompositionFixture(t, ctx, databaseURL)
			runtime, closeRuntime, err := composeRuntime(ctx, configuration.Config)
			if err != nil {
				t.Fatal(err)
			}
			handler := compositionHandler(t, configuration, runtime)
			mutationBody := `{"version":"sync/v2","deviceId":"` + compositionDeviceA +
				`","cursor":null,"mutations":[{"mutationId":"` + compositionMutation +
				`","cardId":"` + compositionCardID + `","baseServerRevision":null,"title":"long recovery"` +
				`,"body":[],"createdAt":1000,"updatedAt":1000,"kind":"upsert","conflictIds":[]}]}`
			if response := serveCompositionSync(handler, token, mutationBody); response.Code != http.StatusOK {
				closeRuntime()
				t.Fatalf("seed sync = %d %s", response.Code, response.Body.String())
			}
			started := serveCompositionDeletionStart(handler, token, strings.Repeat("X", 43))
			startResponse := decodeCompositionDeletionResponse(t, started)
			if started.Code != http.StatusAccepted || startResponse.Status != accountdeletion.PublicInProgress {
				closeRuntime()
				t.Fatalf("start = %d %#v", started.Code, startResponse)
			}
			preClaimFuture := time.Now().UnixMilli() + int64((8*24*time.Hour)/time.Millisecond)
			expired, expiredErr := runtime.deletionApplication.Resume(
				ctx,
				accountdeletion.ResumeCommand{ContinuationToken: startResponse.ContinuationToken},
				preClaimFuture,
			)
			if expiredErr != nil || expired.Kind != accountdeletion.ApplicationRejected ||
				expired.Reason != accountdeletion.ApplicationInvalidCapability {
				closeRuntime()
				t.Fatalf("pre-revocation expired continuation = %#v, %v", expired, expiredErr)
			}
			secret, sequence, err := accountdeletion.ContinuationTokenParts(startResponse.ContinuationToken)
			if err != nil || sequence != 0 {
				closeRuntime()
				t.Fatalf("initial continuation = %q, %d, %v", secret, sequence, err)
			}
			credentials, err := accountdeletioncredentialadapter.New(
				configuration.Config.LocalFixture.DeletionHMACKey[:],
			)
			if err != nil {
				closeRuntime()
				t.Fatal(err)
			}
			secretHash, err := credentials.DigestSecret(secret)
			if err != nil {
				closeRuntime()
				t.Fatal(err)
			}
			pool, err := postgresadapter.OpenPool(ctx, databaseURL, 2)
			if err != nil {
				closeRuntime()
				t.Fatal(err)
			}
			store, err := postgresadapter.NewAccountDeletionStore(pool)
			if err != nil {
				pool.Close()
				closeRuntime()
				t.Fatal(err)
			}
			var preClaimSequence, preClaimActiveSessions, preClaimReceipts int64
			var preClaimState string
			if err := pool.QueryRow(ctx, `SELECT
				(SELECT sequence FROM account_deletion_continuations),
				(SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL),
				(SELECT COUNT(*) FROM account_deletion_step_receipts),
				(SELECT state FROM account_deletion_operations)`,
			).Scan(&preClaimSequence, &preClaimActiveSessions, &preClaimReceipts, &preClaimState); err != nil {
				pool.Close()
				closeRuntime()
				t.Fatal(err)
			}
			if preClaimSequence != 0 || preClaimActiveSessions != 1 || preClaimReceipts != 0 ||
				preClaimState != string(accountdeletion.StateReady) {
				pool.Close()
				closeRuntime()
				t.Fatalf("expired pre-claim side effects sequence=%d sessions=%d receipts=%d state=%s",
					preClaimSequence, preClaimActiveSessions, preClaimReceipts, preClaimState)
			}
			claimAt := time.Now().UnixMilli()
			consumed, err := store.Consume(ctx, secretHash, sequence, claimAt)
			if err != nil || consumed.Kind != accountdeletion.ConsumeConsumed {
				pool.Close()
				closeRuntime()
				t.Fatalf("consume before claim = %#v, %v", consumed, err)
			}
			claim := accountdeletion.PlanStepClaim(consumed.Snapshot.Operation, claimAt, claimAt+1)
			claimed, err := store.Commit(ctx, consumed.Snapshot.Operation.Scope, claim.Transition)
			if claim.Kind != accountdeletion.PlanAccepted || err != nil ||
				claimed.Kind != accountdeletion.CommitApplied || claimed.Current == nil {
				pool.Close()
				closeRuntime()
				t.Fatalf("claim = %#v, result=%#v, %v", claim, claimed, err)
			}
			var expiresAt, persistedSequence, activeSessions int64
			if err := pool.QueryRow(ctx, `SELECT
				(SELECT expires_at FROM account_deletion_continuations),
				(SELECT sequence FROM account_deletion_continuations),
				(SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL)`,
			).Scan(&expiresAt, &persistedSequence, &activeSessions); err != nil {
				pool.Close()
				closeRuntime()
				t.Fatal(err)
			}
			if expiresAt != identity.MaximumSafeInteger || persistedSequence != 1 || activeSessions != 1 {
				pool.Close()
				closeRuntime()
				t.Fatalf("claim boundary expires=%d sequence=%d active_sessions=%d", expiresAt, persistedSequence, activeSessions)
			}
			if testCase.executeEffect {
				running := claimed.Current.Operation.State.(accountdeletion.Running)
				effect, effectErr := executeComposedDeletionEffect(ctx, runtime.deletionEffects, accountdeletion.StepEffectInput{
					Scope: claimed.Current.Operation.Scope, OperationID: claimed.Current.Operation.OperationID,
					Step: running.Step, Attempt: running.Attempt,
					RequestedAt: claimed.Current.Operation.CreatedAt, ExecutedAt: claimAt,
				})
				if effectErr != nil || effect.Kind != accountdeletion.EffectSucceeded {
					pool.Close()
					closeRuntime()
					t.Fatalf("revocation effect before receipt = %#v, %v", effect, effectErr)
				}
				if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL`).Scan(&activeSessions); err != nil || activeSessions != 0 {
					pool.Close()
					closeRuntime()
					t.Fatalf("revocation crash active_sessions=%d error=%v", activeSessions, err)
				}
			}
			pool.Close()
			closeRuntime()

			restarted, closeRestarted, err := composeRuntime(ctx, configuration.Config)
			if err != nil {
				t.Fatalf("restart after revocation boundary: %v", err)
			}
			futureAt := claimAt + int64((8*24*time.Hour)/time.Millisecond)
			continuation := startResponse.ContinuationToken
			if !testCase.resumeWithPrevious {
				continuation, err = accountdeletion.CreateContinuationToken(secret, consumed.Continuation.Sequence)
				if err != nil {
					closeRestarted()
					t.Fatal(err)
				}
			}
			var terminalPresentation accountdeletion.ContinuationToken
			completed := false
			for attempt := 0; attempt < 24; attempt++ {
				presented := continuation
				result, resumeErr := restarted.deletionApplication.Resume(
					ctx,
					accountdeletion.ResumeCommand{ContinuationToken: presented},
					futureAt,
				)
				if resumeErr != nil || result.Kind != accountdeletion.ApplicationAccepted || result.Response == nil {
					closeRestarted()
					t.Fatalf("future resume %d = %#v, %v", attempt, result, resumeErr)
				}
				if result.Response.Status == accountdeletion.PublicCompleted {
					terminalPresentation = presented
					completed = true
					break
				}
				if result.Response.ContinuationToken == "" {
					closeRestarted()
					t.Fatalf("future resume %d omitted continuation: %#v", attempt, result.Response)
				}
				continuation = result.Response.ContinuationToken
				futureAt++
				if result.Response.RetryAt != nil && *result.Response.RetryAt > futureAt {
					futureAt = *result.Response.RetryAt
				}
			}
			if !completed {
				closeRestarted()
				t.Fatal("long-lived recovery credential did not complete deletion")
			}
			terminal, terminalErr := restarted.deletionApplication.Resume(
				ctx,
				accountdeletion.ResumeCommand{ContinuationToken: terminalPresentation},
				futureAt+1,
			)
			if terminalErr != nil || terminal.Kind != accountdeletion.ApplicationAccepted ||
				terminal.Response == nil || terminal.Response.Status != accountdeletion.PublicCompleted {
				closeRestarted()
				t.Fatalf("terminal status replay = %#v, %v", terminal, terminalErr)
			}
			closeRestarted()
			assertCompositionDeletionComplete(
				t, ctx, databaseURL, configuration.Config.LocalFixture.PrivateRoot,
			)
		})
	}
}

func TestLocalFixtureCompositionFailsClosedAfterPostgresLeaseLoss(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("safe NOTES_TEST_DATABASE_URL is required: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	configuration, token := prepareCompositionFixture(t, ctx, databaseURL)
	runtime, closeRuntime, err := composeRuntime(ctx, configuration.Config)
	if err != nil {
		t.Fatal(err)
	}
	handler := compositionHandler(t, configuration, runtime)
	if err := runtime.private.Readiness.Check(ctx); err != nil {
		closeRuntime()
		t.Fatalf("initial readiness = %v", err)
	}
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 2)
	if err != nil {
		closeRuntime()
		t.Fatal(err)
	}
	if err := terminateCompositionLeaseKeeper(ctx, pool); err != nil {
		pool.Close()
		closeRuntime()
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for runtime.private.Readiness.Check(ctx) == nil && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if err := runtime.private.Readiness.Check(ctx); err == nil {
		pool.Close()
		closeRuntime()
		t.Fatal("readiness stayed healthy after keeper termination")
	}
	response := serveCompositionDeletionStart(handler, token, strings.Repeat("L", 43))
	if response.Code != http.StatusServiceUnavailable {
		pool.Close()
		closeRuntime()
		t.Fatalf("deletion after lease loss = %d %s", response.Code, response.Body.String())
	}
	readBody := `{"version":"sync/v2","deviceId":"` + compositionDeviceB + `","cursor":null,"mutations":[]}`
	if response := serveCompositionSync(handler, token, readBody); response.Code != http.StatusServiceUnavailable {
		pool.Close()
		closeRuntime()
		t.Fatalf("sync after lease loss = %d %s", response.Code, response.Body.String())
	}
	privacyResponse := serveCompositionPrivacySubmit(
		handler, token, compositionPrivacy, privacyrequest.KindDisclosure,
	)
	if privacyResponse.Code != http.StatusServiceUnavailable {
		pool.Close()
		closeRuntime()
		t.Fatalf("privacy submit after lease loss = %d %s", privacyResponse.Code, privacyResponse.Body.String())
	}
	var operations, privacyRequests, activeSessions int64
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM account_deletion_operations),
		(SELECT COUNT(*) FROM privacy_requests),
		(SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL)`,
	).Scan(&operations, &privacyRequests, &activeSessions); err != nil ||
		operations != 0 || privacyRequests != 0 || activeSessions != 1 {
		pool.Close()
		closeRuntime()
		t.Fatalf("lease-loss side effects operations=%d privacy=%d sessions=%d error=%v",
			operations, privacyRequests, activeSessions, err)
	}
	if overlap, overlapClose, err := composeRuntime(ctx, configuration.Config); err == nil {
		overlapClose()
		pool.Close()
		closeRuntime()
		t.Fatalf("replacement runtime overlapped lost keeper: %#v", overlap)
	}
	pool.Close()
	closeRuntime()
	restarted, closeRestarted, err := composeRuntime(ctx, configuration.Config)
	if err != nil {
		t.Fatalf("restart after host lock release: %v", err)
	}
	if restarted.private.Readiness.Check(ctx) != nil {
		closeRestarted()
		t.Fatal("restart after host lock release is not ready")
	}
	closeRestarted()
}

func terminateCompositionLeaseKeeper(ctx context.Context, pool *pgxpool.Pool) error {
	const leaseNamespace = int64(0x46554b41)
	const leaseKey = int64(0x4d554e4f)
	var backendPID int32
	if err := pool.QueryRow(ctx, `SELECT pid FROM pg_locks
		WHERE locktype = 'advisory' AND granted
		  AND classid = $1::oid AND objid = $2::oid AND objsubid = 2`,
		leaseNamespace, leaseKey,
	).Scan(&backendPID); err != nil {
		return err
	}
	var terminated bool
	if err := pool.QueryRow(ctx, `SELECT pg_terminate_backend($1)`, backendPID).Scan(&terminated); err != nil {
		return err
	}
	if !terminated {
		return errors.New("lease keeper was not terminated")
	}
	return nil
}

func executeComposedDeletionEffect(
	ctx context.Context,
	effects *composedDeletionEffects,
	input accountdeletion.StepEffectInput,
) (accountdeletion.StepEffectResult, error) {
	if effects == nil {
		return accountdeletion.StepEffectResult{}, errors.New("composed deletion effects unavailable")
	}
	switch input.Step {
	case accountdeletion.StepRevokeSessions:
		return effects.sessions.RevokeSessions(ctx, input)
	case accountdeletion.StepCancelSubscription:
		return effects.subscriptions.CancelSubscriptionImmediately(ctx, input)
	case accountdeletion.StepDeleteVaultData:
		return effects.vaultData.DeleteVaultData(ctx, input)
	case accountdeletion.StepDeletePrivateObject:
		return effects.privateObjects.DeletePrivateObjects(ctx, input)
	case accountdeletion.StepFinalizeAccount:
		return effects.accounts.FinalizeAccount(ctx, input)
	default:
		return accountdeletion.StepEffectResult{}, errors.New("unknown composed deletion effect")
	}
}

func prepareCompositionFixture(
	t *testing.T,
	ctx context.Context,
	databaseURL string,
) (compositionTestConfig, identity.SessionToken) {
	t.Helper()
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	layout, err := localfixtureadapter.PrepareLayout(root)
	if err != nil {
		t.Fatal(err)
	}
	accountID, _ := identity.ParseAccountID(compositionAccountID)
	vaultID, _ := identity.ParseVaultID(compositionVaultID)
	sessionID, _ := identity.ParseSessionID(compositionSessionID)
	epoch, _ := identity.ParseSessionEpoch(1)
	token := mustCompositionToken(t, bytes.Repeat([]byte{0x41}, 32))
	metadata, err := recoverykeyadapter.PrepareFixtureKey(layout.KeyDirectory, vaultID)
	if err != nil {
		t.Fatal(err)
	}
	owner, _ := access.ParseSubject("composition-fixture-owner")
	seed, err := localfixture.NewSeed(owner, accountID, vaultID, sessionID, epoch, token, metadata)
	if err != nil {
		t.Fatal(err)
	}
	database, err := postgresadapter.OpenSQL(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, "DROP SCHEMA public CASCADE; CREATE SCHEMA public"); err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	migrator, err := postgresadapter.NewMigrator(database, migrations.Files)
	if err != nil {
		t.Fatalf("migrate composition fixture: %v", err)
	}
	if err := migrator.Up(ctx); err != nil {
		_ = database.Close()
		t.Fatalf("migrate composition fixture: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("close migrated composition fixture: %v", err)
	}
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 2)
	if err != nil {
		t.Fatal(err)
	}
	store, err := postgresadapter.NewLocalFixtureStore(pool, seed)
	if err != nil || store.Seed(ctx) != nil {
		pool.Close()
		t.Fatalf("seed composition fixture: %v", err)
	}
	pool.Close()
	publicKey, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	origin, _ := url.Parse(compositionOrigin)
	staticDirectory := compositionStaticSite(t)
	configuration := config.Config{
		Environment: config.EnvironmentTest, HTTPAddress: "127.0.0.1:3100",
		StaticDirectory: staticDirectory, BodyLimit: 4_000_000,
		ShutdownTimeout: time.Second, LogLevel: slog.LevelInfo,
		ApplicationProfile: config.ApplicationProfileLocalFixture,
		PrivateRuntime: &config.PrivateRuntimeConfig{
			DatabaseURL: databaseURL, MaximumConnections: 4, PublicOrigin: origin,
			Issuer: "https://issuer.test", Audience: "notes-composition",
			PublicKey: publicKey, LegacyOwner: owner,
		},
		LocalFixture: &config.LocalFixtureConfig{
			DatabaseURL: databaseURL, PublicOrigin: origin, AllowedSubject: owner,
			AccountID: accountID, VaultID: vaultID, SessionID: sessionID,
			SessionEpoch: epoch, SessionToken: token, PrivateRoot: root,
			ObjectDirectory: layout.ObjectDirectory, NonceDirectory: layout.NonceDirectory,
			KeyDirectory: layout.KeyDirectory, CursorHMACKey: [32]byte{0x42},
			DeletionHMACKey:     [32]byte{0x43},
			LegalEvidencePolicy: config.LocalFixtureDeleteLiveEvidence,
		},
	}
	for index := 1; index < 32; index++ {
		configuration.LocalFixture.CursorHMACKey[index] = 0x42
		configuration.LocalFixture.DeletionHMACKey[index] = 0x43
	}
	return compositionTestConfig{Config: configuration, context: seed.Context}, token
}

type compositionTestConfig struct {
	config.Config
	context identity.VaultContext
}

func (configuration compositionTestConfig) LocalFixtureContext() identity.VaultContext {
	return configuration.context
}

func compositionHandler(
	t *testing.T,
	configuration compositionTestConfig,
	composition runtimeComposition,
) http.Handler {
	t.Helper()
	handler, err := httpapi.NewHandler(httpapi.HandlerOptions{
		StaticDirectory: configuration.StaticDirectory, BodyLimit: configuration.BodyLimit,
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		PrivateRuntime: composition.private, SyncV2Runtime: composition.syncV2,
		AccountDeletionRuntime:     composition.accountDeletion,
		PrivacyRequestRuntime:      composition.privacyRequest,
		DisableLegacySync:          composition.disableLegacySync,
		EnableDisconnectedFixtures: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func serveCompositionDeletionStart(
	handler http.Handler,
	token identity.SessionToken,
	idempotencyKey string,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/account/deletion",
		strings.NewReader(`{"idempotencyKey":"`+idempotencyKey+`"}`),
	)
	request.Header.Set("Cookie", identity.SessionCookieName+"="+string(token))
	setCompositionMutationHeaders(request)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func serveCompositionPrivacySubmit(
	handler http.Handler,
	token identity.SessionToken,
	submissionID string,
	requestKind privacyrequest.RequestKind,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/account/privacy-requests",
		strings.NewReader(`{"submissionId":"`+submissionID+`","requestKind":"`+string(requestKind)+`"}`),
	)
	request.Header.Set("Cookie", identity.SessionCookieName+"="+string(token))
	setCompositionMutationHeaders(request)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func serveCompositionPrivacyStatus(
	handler http.Handler,
	token identity.SessionToken,
	requestID privacyrequest.RequestID,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/account/privacy-requests/status",
		strings.NewReader(`{"requestId":"`+string(requestID)+`"}`),
	)
	request.Header.Set("Cookie", identity.SessionCookieName+"="+string(token))
	setCompositionMutationHeaders(request)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decodeCompositionPrivacyStatus(
	t *testing.T,
	response *httptest.ResponseRecorder,
) privacyrequest.PublicStatus {
	t.Helper()
	status, err := privacyrequest.DecodePublicStatus(response.Body.Bytes())
	if err != nil {
		t.Fatalf("decode privacy response %d %q: %v", response.Code, response.Body.String(), err)
	}
	return status
}

func assertCompositionPrivacyCounts(
	t *testing.T,
	ctx context.Context,
	databaseURL string,
	privacyRequests int64,
	deletionOperations int64,
	continuations int64,
	receipts int64,
	activeSessions int64,
) {
	t.Helper()
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var actualPrivacy, actualOperations, actualContinuations, actualReceipts, actualSessions int64
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM privacy_requests),
		(SELECT COUNT(*) FROM account_deletion_operations),
		(SELECT COUNT(*) FROM account_deletion_continuations),
		(SELECT COUNT(*) FROM account_deletion_step_receipts),
		(SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL)`,
	).Scan(
		&actualPrivacy, &actualOperations, &actualContinuations, &actualReceipts, &actualSessions,
	); err != nil {
		t.Fatal(err)
	}
	if actualPrivacy != privacyRequests || actualOperations != deletionOperations ||
		actualContinuations != continuations || actualReceipts != receipts || actualSessions != activeSessions {
		t.Fatalf(
			"privacy/deletion counts privacy=%d operations=%d continuations=%d receipts=%d active-sessions=%d",
			actualPrivacy, actualOperations, actualContinuations, actualReceipts, actualSessions,
		)
	}
}

func serveCompositionDeletionResume(
	handler http.Handler,
	token accountdeletion.ContinuationToken,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/account/deletion/status",
		strings.NewReader(`{"continuationToken":"`+string(token)+`"}`),
	)
	setCompositionMutationHeaders(request)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func setCompositionMutationHeaders(request *http.Request) {
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", compositionOrigin)
	request.Header.Set("Sec-Fetch-Site", "same-origin")
}

func decodeCompositionDeletionResponse(
	t *testing.T,
	response *httptest.ResponseRecorder,
) accountdeletion.PublicResponse {
	t.Helper()
	decoded, err := accountdeletion.DecodePublicResponse(response.Body.Bytes())
	if err != nil {
		t.Fatalf("decode deletion response %d %q: %v", response.Code, response.Body.String(), err)
	}
	return decoded
}

func assertCompositionDeletionComplete(
	t *testing.T,
	ctx context.Context,
	databaseURL string,
	privateRoot string,
) {
	t.Helper()
	layout, err := localfixtureadapter.OpenLayout(privateRoot)
	if err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{layout.ObjectDirectory, layout.NonceDirectory, layout.KeyDirectory} {
		entries, err := os.ReadDir(directory)
		if err != nil || len(entries) != 0 {
			t.Fatalf("completed directory %s = %v, %v", directory, entries, err)
		}
	}
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var liveRows, completedOperations, receipts, continuations int64
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM accounts) + (SELECT COUNT(*) FROM personal_vaults) +
		(SELECT COUNT(*) FROM sessions) + (SELECT COUNT(*) FROM vault_dek_versions),
		(SELECT COUNT(*) FROM account_deletion_operations WHERE state = 'completed'),
		(SELECT COUNT(*) FROM account_deletion_step_receipts),
		(SELECT COUNT(*) FROM account_deletion_continuations)`,
	).Scan(&liveRows, &completedOperations, &receipts, &continuations); err != nil {
		t.Fatal(err)
	}
	if liveRows != 0 || completedOperations != 1 || receipts != 5 || continuations != 1 {
		t.Fatalf("completed DB live=%d operations=%d receipts=%d continuations=%d",
			liveRows, completedOperations, receipts, continuations)
	}
}

type compositionAdmissionState struct {
	Database [10]int64
	Files    string
}

func captureCompositionAdmissionState(
	t *testing.T,
	ctx context.Context,
	databaseURL string,
	privateRoot string,
) compositionAdmissionState {
	t.Helper()
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var state compositionAdmissionState
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM accounts),
		(SELECT COUNT(*) FROM personal_vaults),
		(SELECT COUNT(*) FROM sessions),
		(SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL),
		(SELECT COUNT(*) FROM vault_dek_versions),
		(SELECT COUNT(*) FROM vault_sync_v2_cards),
		(SELECT COUNT(*) FROM vault_sync_v2_commits),
		(SELECT COUNT(*) FROM account_deletion_operations),
		(SELECT COUNT(*) FROM account_deletion_step_receipts),
		(SELECT COUNT(*) FROM account_deletion_continuations)`,
	).Scan(
		&state.Database[0], &state.Database[1], &state.Database[2], &state.Database[3],
		&state.Database[4], &state.Database[5], &state.Database[6], &state.Database[7],
		&state.Database[8], &state.Database[9],
	); err != nil {
		t.Fatal(err)
	}
	layout, err := localfixtureadapter.OpenLayout(privateRoot)
	if err != nil {
		t.Fatal(err)
	}
	var files strings.Builder
	for _, root := range []struct {
		name string
		path string
	}{
		{name: "objects", path: layout.ObjectDirectory},
		{name: "nonces", path: layout.NonceDirectory},
		{name: "keys", path: layout.KeyDirectory},
	} {
		err := filepath.WalkDir(root.path, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			relative, relativeErr := filepath.Rel(root.path, path)
			if relativeErr != nil {
				return relativeErr
			}
			info, infoErr := entry.Info()
			if infoErr != nil {
				return infoErr
			}
			fmt.Fprintf(&files, "%s/%s:%s", root.name, filepath.ToSlash(relative), info.Mode())
			if info.Mode().IsRegular() {
				content, readErr := os.ReadFile(path)
				if readErr != nil {
					return readErr
				}
				fmt.Fprintf(&files, ":%s", base64.RawStdEncoding.EncodeToString(content))
			}
			files.WriteByte('\n')
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	state.Files = files.String()
	return state
}

func serveCompositionSync(
	handler http.Handler,
	token identity.SessionToken,
	body string,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/api/v2/sync", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Cookie", identity.SessionCookieName+"="+string(token))
	request.Header.Set("Origin", compositionOrigin)
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func serveCompositionSessionContext(
	handler http.Handler,
	token identity.SessionToken,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, "/api/session-context", nil)
	request.Header.Set("Cookie", identity.SessionCookieName+"="+string(token))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func assertCompositionCiphertext(
	t *testing.T,
	ctx context.Context,
	composition runtimeComposition,
	plaintext string,
) {
	t.Helper()
	descriptors, err := composition.localFixture.Objects.List(ctx)
	if err != nil || len(descriptors) != 1 {
		t.Fatalf("object descriptors = %#v, %v", descriptors, err)
	}
	ciphertext, found, err := composition.localFixture.Objects.Get(ctx, descriptors[0].ObjectKey)
	if err != nil || !found || bytes.Contains(ciphertext, []byte(plaintext)) {
		t.Fatalf("ciphertext found=%t err=%v plaintext-leak=%t", found, err, bytes.Contains(ciphertext, []byte(plaintext)))
	}
	var envelope map[string]any
	if json.Unmarshal(ciphertext, &envelope) != nil || envelope["sealedPayload"] == nil {
		t.Fatalf("stored object is not an encrypted envelope: %s", ciphertext)
	}
}

func mustCompositionToken(t *testing.T, raw []byte) identity.SessionToken {
	t.Helper()
	token, err := identity.ParseSessionToken(base64.RawURLEncoding.EncodeToString(raw))
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func compositionStaticSite(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	files := []string{
		"index.html", "favicon.svg", "manifest.webmanifest", "og.png", "sw.js",
		"account/billing/index.html", "account/privacy/index.html", "account/terms/index.html",
		"checkout/index.html", "company/index.html", "legal/commercial-transactions/index.html",
		"legal/external-transmission/index.html", "legal/privacy/index.html", "legal/terms/index.html",
		"pricing/index.html",
	}
	for _, name := range files {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("<!doctype html><title>fixture</title>"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

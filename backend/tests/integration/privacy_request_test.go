//go:build integration

package integration_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/privacyrequest"
	"github.com/jackc/pgx/v5/pgxpool"
)

type integrationPrivacyVerification struct {
	receiptID privacyrequest.VerificationReceiptID
}

func (verification integrationPrivacyVerification) Verify(
	context.Context,
	privacyrequest.Scope,
	privacyrequest.RequestID,
	privacyrequest.RequestKind,
	int64,
) (privacyrequest.VerificationResult, error) {
	return privacyrequest.VerificationResult{
		Kind: privacyrequest.VerificationResultApproved, ReceiptID: verification.receiptID,
	}, nil
}

type integrationPrivacyUnavailableVerification struct{}

func (integrationPrivacyUnavailableVerification) Verify(
	context.Context,
	privacyrequest.Scope,
	privacyrequest.RequestID,
	privacyrequest.RequestKind,
	int64,
) (privacyrequest.VerificationResult, error) {
	return privacyrequest.VerificationResult{Kind: privacyrequest.VerificationResultUnavailable}, nil
}

type integrationPrivacyExecution struct {
	mutex sync.Mutex
	calls int
	fail  bool
}

func (execution *integrationPrivacyExecution) Execute(
	context.Context,
	privacyrequest.Scope,
	privacyrequest.RequestID,
	privacyrequest.RequestKind,
) (privacyrequest.ExecutionResult, error) {
	execution.mutex.Lock()
	defer execution.mutex.Unlock()
	execution.calls++
	if execution.fail {
		return privacyrequest.ExecutionResult{}, errors.New("injected executor outage")
	}
	return privacyrequest.ExecutionResult{Kind: privacyrequest.ExecutionFulfilled}, nil
}

func (execution *integrationPrivacyExecution) callCount() int {
	execution.mutex.Lock()
	defer execution.mutex.Unlock()
	return execution.calls
}

type integrationPrivacyDeletion struct {
	mutex sync.Mutex
	calls int
}

func (deletion *integrationPrivacyDeletion) StartExistingAccountDeletion(
	context.Context,
	privacyrequest.Scope,
	privacyrequest.RequestID,
) (privacyrequest.DeletionHandoffResult, error) {
	deletion.mutex.Lock()
	defer deletion.mutex.Unlock()
	deletion.calls++
	return privacyrequest.DeletionHandoffResult{Kind: privacyrequest.DeletionHandoffStarted}, nil
}

func (deletion *integrationPrivacyDeletion) callCount() int {
	deletion.mutex.Lock()
	defer deletion.mutex.Unlock()
	return deletion.calls
}

func TestPrivacyRequestPostgresApplicationAndHTTP(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	scopeA := seedPrivacyOwner(t, ctx, pool, 61)
	scopeB := seedPrivacyOwner(t, ctx, pool, 62)
	store, err := postgresadapter.NewPrivacyRequestStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	receiptID := mustPrivacyReceiptID(t, integrationUUID(t, 2_701))
	execution := &integrationPrivacyExecution{}
	deletion := &integrationPrivacyDeletion{}
	service, err := privacyrequest.NewService(
		store,
		integrationPrivacyVerification{receiptID: receiptID},
		execution,
		deletion,
	)
	if err != nil {
		t.Fatal(err)
	}

	requestID := mustPrivacyRequestID(t, integrationUUID(t, 2_501))
	submissionID := mustPrivacySubmissionID(t, integrationUUID(t, 2_601))
	handlers, token := newIntegrationPrivacyHandlers(t, ctx, pool, service, scopeA, requestID)
	response := httptest.NewRecorder()
	handlers.Submit.ServeHTTP(response, integrationPrivacyHTTPRequest(
		"/api/account/privacy-requests",
		`{"submissionId":"`+string(submissionID)+`","requestKind":"disclosure"}`,
		token,
	))
	if response.Code != http.StatusAccepted {
		t.Fatalf("submit HTTP = %d %s", response.Code, response.Body.String())
	}
	publicStatus, err := privacyrequest.DecodePublicStatus(response.Body.Bytes())
	if err != nil || publicStatus.RequestID != requestID || publicStatus.Status != privacyrequest.StateVerificationPending {
		t.Fatalf("submit status = %#v, %v", publicStatus, err)
	}
	replayed, err := service.Submit(ctx, scopeA, privacyrequest.SubmitCommand{
		SubmissionID: submissionID, RequestKind: privacyrequest.KindDisclosure,
	}, mustPrivacyRequestID(t, integrationUUID(t, 2_502)), 1_501)
	if err != nil || replayed.Outcome != privacyrequest.ApplicationReplayed || replayed.Request.RequestID != requestID {
		t.Fatalf("replayed submit = %#v, %v", replayed, err)
	}
	conflict, err := service.Submit(ctx, scopeA, privacyrequest.SubmitCommand{
		SubmissionID: submissionID, RequestKind: privacyrequest.KindCorrection,
	}, mustPrivacyRequestID(t, integrationUUID(t, 2_503)), 1_502)
	if err != nil || conflict.Reason != privacyrequest.ApplicationIdentifierConflict {
		t.Fatalf("conflicting submit = %#v, %v", conflict, err)
	}
	foreign, err := service.Status(ctx, scopeB, requestID)
	if err != nil || foreign.Reason != privacyrequest.ApplicationNotFound {
		t.Fatalf("foreign status = %#v, %v", foreign, err)
	}
	ownerBPlan := privacyrequest.PlanStart(scopeB, requestID, submissionID, privacyrequest.KindDisclosure, 1_550)
	ownerBCreated, err := store.Create(ctx, ownerBPlan.Record)
	if err != nil || ownerBCreated.Kind != privacyrequest.CreateCreated {
		t.Fatalf("same identifiers in other Vault = %#v, %v", ownerBCreated, err)
	}
	missingScope := privacyrequest.Scope{
		AccountID: integrationAccountID(t, 199), VaultID: integrationVaultID(t, 299),
	}
	missingPlan := privacyrequest.PlanStart(
		missingScope,
		mustPrivacyRequestID(t, integrationUUID(t, 2_599)),
		mustPrivacySubmissionID(t, integrationUUID(t, 2_699)),
		privacyrequest.KindDisclosure,
		1_560,
	)
	missingCreated, err := store.Create(ctx, missingPlan.Record)
	if err != nil || missingCreated.Kind != privacyrequest.CreateRejected {
		t.Fatalf("missing owner create = %#v, %v", missingCreated, err)
	}

	verified, err := service.Verify(ctx, scopeA, requestID, 1_600)
	if err != nil || verified.Request.Status != privacyrequest.StateReady {
		t.Fatalf("verify = %#v, %v", verified, err)
	}
	results := make(chan privacyrequest.ApplicationResult, 2)
	errorsChannel := make(chan error, 2)
	var wait sync.WaitGroup
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			result, processErr := service.Process(ctx, scopeA, requestID, 1_700, 1_800)
			results <- result
			errorsChannel <- processErr
		}()
	}
	wait.Wait()
	close(results)
	close(errorsChannel)
	for processErr := range errorsChannel {
		if processErr != nil {
			t.Fatalf("concurrent process error = %v", processErr)
		}
	}
	for result := range results {
		if result.Kind != privacyrequest.ApplicationAccepted {
			t.Fatalf("concurrent process = %#v", result)
		}
	}
	if execution.callCount() != 1 {
		t.Fatalf("execution calls = %d, want 1", execution.callCount())
	}
	completed, err := service.Status(ctx, scopeA, requestID)
	if err != nil || completed.Request.Status != privacyrequest.StateCompleted ||
		completed.Request.Outcome != privacyrequest.OutcomeFulfilled {
		t.Fatalf("completed status = %#v, %v", completed, err)
	}

	assertPrivacyDeletionHandoff(t, ctx, service, scopeA, deletion)
	assertPrivacyVerificationUnavailable(t, ctx, store, scopeA, execution, deletion)
	assertPrivacyExecutorFailure(t, ctx, store, receiptID, scopeA)
	assertPrivacyJournalSurvivesVaultRemoval(t, ctx, pool, store)
	assertMalformedPrivacyRequestFailsClosed(t, ctx, pool, store, scopeA, requestID)
	if pool.Stat().AcquiredConns() != 0 {
		t.Fatalf("database connections still acquired: %d", pool.Stat().AcquiredConns())
	}
}

func assertPrivacyVerificationUnavailable(
	t *testing.T,
	ctx context.Context,
	store *postgresadapter.PrivacyRequestStore,
	scope privacyrequest.Scope,
	execution *integrationPrivacyExecution,
	deletion *integrationPrivacyDeletion,
) {
	t.Helper()
	service, err := privacyrequest.NewService(store, integrationPrivacyUnavailableVerification{}, execution, deletion)
	if err != nil {
		t.Fatal(err)
	}
	requestID := mustPrivacyRequestID(t, integrationUUID(t, 2_514))
	submissionID := mustPrivacySubmissionID(t, integrationUUID(t, 2_614))
	_, _ = service.Submit(ctx, scope, privacyrequest.SubmitCommand{
		SubmissionID: submissionID, RequestKind: privacyrequest.KindPurposeNotification,
	}, requestID, 2_500)
	result, err := service.Verify(ctx, scope, requestID, 2_600)
	if err != nil || result.Reason != privacyrequest.ApplicationUnavailable {
		t.Fatalf("unavailable verification = %#v, %v", result, err)
	}
	status, err := service.Status(ctx, scope, requestID)
	if err != nil || status.Request.Status != privacyrequest.StateVerificationPending {
		t.Fatalf("pending after unavailable verification = %#v, %v", status, err)
	}
}

func assertPrivacyDeletionHandoff(
	t *testing.T,
	ctx context.Context,
	service *privacyrequest.Service,
	scope privacyrequest.Scope,
	deletion *integrationPrivacyDeletion,
) {
	t.Helper()
	requestID := mustPrivacyRequestID(t, integrationUUID(t, 2_511))
	submissionID := mustPrivacySubmissionID(t, integrationUUID(t, 2_611))
	if result, err := service.Submit(ctx, scope, privacyrequest.SubmitCommand{
		SubmissionID: submissionID, RequestKind: privacyrequest.KindDeletion,
	}, requestID, 2_000); err != nil || result.Kind != privacyrequest.ApplicationAccepted {
		t.Fatalf("deletion submit = %#v, %v", result, err)
	}
	if _, err := service.Verify(ctx, scope, requestID, 2_100); err != nil {
		t.Fatal(err)
	}
	result, err := service.Process(ctx, scope, requestID, 2_200, 2_300)
	if err != nil || result.Request.Status != privacyrequest.StateCompleted ||
		result.Request.Outcome != privacyrequest.OutcomeAccountDeletionStarted || deletion.callCount() != 1 {
		t.Fatalf("deletion process = %#v, calls=%d, %v", result, deletion.callCount(), err)
	}
}

func assertPrivacyExecutorFailure(
	t *testing.T,
	ctx context.Context,
	store *postgresadapter.PrivacyRequestStore,
	receiptID privacyrequest.VerificationReceiptID,
	scope privacyrequest.Scope,
) {
	t.Helper()
	execution := &integrationPrivacyExecution{fail: true}
	service, err := privacyrequest.NewService(store, integrationPrivacyVerification{receiptID: receiptID}, execution, &integrationPrivacyDeletion{})
	if err != nil {
		t.Fatal(err)
	}
	requestID := mustPrivacyRequestID(t, integrationUUID(t, 2_512))
	submissionID := mustPrivacySubmissionID(t, integrationUUID(t, 2_612))
	_, _ = service.Submit(ctx, scope, privacyrequest.SubmitCommand{SubmissionID: submissionID, RequestKind: privacyrequest.KindCorrection}, requestID, 3_000)
	_, _ = service.Verify(ctx, scope, requestID, 3_100)
	result, err := service.Process(ctx, scope, requestID, 3_200, 3_300)
	if err != nil || result.Request.Status != privacyrequest.StateFailed || result.Request.Retryable == nil ||
		!*result.Request.Retryable || execution.callCount() != 1 {
		t.Fatalf("failed execution = %#v, calls=%d, %v", result, execution.callCount(), err)
	}
}

func assertPrivacyJournalSurvivesVaultRemoval(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	store *postgresadapter.PrivacyRequestStore,
) {
	t.Helper()
	scope := seedPrivacyOwner(t, ctx, pool, 63)
	requestID := mustPrivacyRequestID(t, integrationUUID(t, 2_513))
	submissionID := mustPrivacySubmissionID(t, integrationUUID(t, 2_613))
	plan := privacyrequest.PlanStart(scope, requestID, submissionID, privacyrequest.KindUsageSuspension, 4_000)
	if result, err := store.Create(ctx, plan.Record); err != nil || result.Kind != privacyrequest.CreateCreated {
		t.Fatalf("retained create = %#v, %v", result, err)
	}
	if _, err := pool.Exec(ctx, "DELETE FROM accounts WHERE account_id = $1", string(scope.AccountID)); err != nil {
		t.Fatalf("delete live Account/Vault: %v", err)
	}
	retained, err := store.FindByID(ctx, scope, requestID)
	if err != nil || retained == nil {
		t.Fatalf("retained journal = %#v, %v", retained, err)
	}
}

func assertMalformedPrivacyRequestFailsClosed(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	store *postgresadapter.PrivacyRequestStore,
	scope privacyrequest.Scope,
	requestID privacyrequest.RequestID,
) {
	t.Helper()
	if _, err := pool.Exec(ctx, "ALTER TABLE privacy_requests DROP CONSTRAINT privacy_requests_shape_check"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE privacy_requests SET state = 'completed', outcome = NULL
		WHERE account_id = $1 AND vault_id = $2 AND request_id = $3`, string(scope.AccountID), string(scope.VaultID), string(requestID)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.FindByID(ctx, scope, requestID); !errors.Is(err, postgresadapter.ErrInvalidPrivacyRequestRecord) {
		t.Fatalf("malformed row error = %v", err)
	}
}

func seedPrivacyOwner(t *testing.T, ctx context.Context, pool *pgxpool.Pool, suffix int) privacyrequest.Scope {
	t.Helper()
	scope := privacyrequest.Scope{
		AccountID: integrationAccountID(t, 100+suffix),
		VaultID:   integrationVaultID(t, 200+suffix),
	}
	if _, err := pool.Exec(ctx, "INSERT INTO accounts(account_id, created_at) VALUES ($1, 1000)", string(scope.AccountID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO personal_vaults(vault_id, account_id, created_at) VALUES ($1, $2, 1000)", string(scope.VaultID), string(scope.AccountID)); err != nil {
		t.Fatal(err)
	}
	return scope
}

func newIntegrationPrivacyHandlers(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	service *privacyrequest.Service,
	scope privacyrequest.Scope,
	requestID privacyrequest.RequestID,
) (httpapi.PrivacyRequestContractHandlers, string) {
	t.Helper()
	sessionStore, err := postgresadapter.NewSessionStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	token := integrationSessionToken(t, 'A', 'A')
	sessionID := integrationSessionID(t, 3_501)
	epoch := integrationEpoch(t)
	decision := identity.CreateActiveSession(identity.SessionInput{
		SessionID: sessionID, AccountID: scope.AccountID, VaultID: scope.VaultID,
		SessionEpoch: epoch, IssuedAt: 1_000, ExpiresAt: 5_000,
	})
	if !decision.Created {
		t.Fatalf("session decision = %#v", decision)
	}
	if err := sessionStore.CreateSession(ctx, decision.Session, token); err != nil {
		t.Fatal(err)
	}
	resolver, err := postgresadapter.NewSessionResolver(sessionStore)
	if err != nil {
		t.Fatal(err)
	}
	handlers, err := httpapi.NewPrivacyRequestContractHandlers(&httpapi.PrivacyRequestRuntime{
		ExpectedOrigin: "https://notes.example", Clock: func() int64 { return 1_500 },
		Sessions: resolver, Application: service,
		NewRequestID: func() string { return string(requestID) },
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return handlers, string(token)
}

func integrationPrivacyHTTPRequest(path string, body string, token string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Cookie", identity.SessionCookieName+"="+token)
	request.Header.Set("Origin", "https://notes.example")
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	return request
}

func mustPrivacyRequestID(t *testing.T, value string) privacyrequest.RequestID {
	t.Helper()
	parsed, err := privacyrequest.ParseRequestID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustPrivacySubmissionID(t *testing.T, value string) privacyrequest.SubmissionID {
	t.Helper()
	parsed, err := privacyrequest.ParseSubmissionID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustPrivacyReceiptID(t *testing.T, value string) privacyrequest.VerificationReceiptID {
	t.Helper()
	parsed, err := privacyrequest.ParseVerificationReceiptID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

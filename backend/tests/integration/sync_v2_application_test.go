//go:build integration

package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/adapters/objectstorage"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/syncv2"
)

var errInjectedSyncV2JournalCommit = errors.New("injected Sync v2 journal commit failure")

func TestSyncV2HTTPApplicationPostgresCrashResumeEncryptionAndCursorIsolation(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	owner := seedEntitlementOwner(t, ctx, pool, 151, 251, 351)
	other := seedEntitlementOwner(t, ctx, pool, 152, 252, 352)
	billingService, entitlementService, _, _ := entitlementModules(t, pool)
	startEntitlementTrial(t, ctx, billingService, owner, 751, 752, "evt_sync_v2_owner")

	sessionStore, err := postgresadapter.NewSessionStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	ownerToken := integrationSessionToken(t, 'S', 'A')
	otherToken := integrationSessionToken(t, 'T', 'E')
	createIntegrationSession(t, ctx, sessionStore, owner, ownerToken)
	createIntegrationSession(t, ctx, sessionStore, other, otherToken)
	sessionResolver, err := postgresadapter.NewSessionResolver(sessionStore)
	if err != nil {
		t.Fatal(err)
	}

	keyring, encryption := integrationObjectEncryption(t, owner.VaultID)
	keyStore, err := postgresadapter.NewVaultDEKStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	if err := keyStore.InsertInitial(ctx, keyring.Versions[0]); err != nil {
		t.Fatal(err)
	}
	objects, err := objectstorage.NewMemory(nil)
	if err != nil {
		t.Fatal(err)
	}
	objectKeys := &integrationObjectKeys{values: []encryptedobject.ObjectKey{
		integrationObjectKey(t, 'G'), integrationObjectKey(t, 'H'),
	}}
	metadata, err := postgresadapter.NewSyncV2MetadataDirectory(pool)
	if err != nil {
		t.Fatal(err)
	}
	contents, err := syncv2.NewEncryptedContentDirectory(
		metadata, objects, objectKeys, encryption, keyStore,
	)
	if err != nil {
		t.Fatal(err)
	}
	journalDirectory, err := postgresadapter.NewSyncV2JournalDirectory(pool)
	if err != nil {
		t.Fatal(err)
	}
	quotaDirectory, err := postgresadapter.NewQuotaLedgerDirectory(pool)
	if err != nil {
		t.Fatal(err)
	}
	cursors, err := syncv2.NewCursorAuthenticator(bytes.Repeat([]byte{0x61}, 32))
	if err != nil {
		t.Fatal(err)
	}
	failingJournals := &failOnceSyncV2JournalDirectory{Directory: journalDirectory, fail: true}
	application, err := syncv2.NewApplication(failingJournals, contents, cursors, quotaDirectory, 60_000)
	if err != nil {
		t.Fatal(err)
	}
	now := int64(3_000)
	handler, err := httpapi.NewSyncV2ContractHandler(&httpapi.SyncV2Runtime{
		ExpectedOrigin: "https://notes.example", Clock: func() int64 { return now },
		Sessions: sessionResolver, Entitlement: entitlementService, Application: application,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}

	mutationID := integrationUUID(t, 951)
	cardID := integrationUUID(t, 851)
	body := `{"version":"sync/v2","deviceId":"01991f20-61d2-7000-8000-000000000451","cursor":null,"mutations":[{` +
		`"mutationId":"` + mutationID + `","cardId":"` + cardID + `","baseServerRevision":null,` +
		`"title":"private recovery title","body":[],"createdAt":2500,"updatedAt":2500,"kind":"upsert","conflictIds":[]}]}`

	failed := serveSyncV2(handler, ownerToken, body)
	if failed.Code != http.StatusServiceUnavailable || failed.Body.String() != "{\"error\":\"unavailable\"}\n" {
		t.Fatalf("interrupted response = %d %s", failed.Code, failed.Body.String())
	}
	if objects.Calls().Put != 1 || encryption.encrypt != 1 || objectKeys.calls != 1 {
		t.Fatalf("interrupted external calls = %#v, encrypt=%d keys=%d", objects.Calls(), encryption.encrypt, objectKeys.calls)
	}
	var reservedState string
	if err := pool.QueryRow(ctx,
		"SELECT state FROM vault_quota_reservations WHERE account_id = $1 AND vault_id = $2 AND reservation_id = $3",
		string(owner.AccountID), string(owner.VaultID), mutationID,
	).Scan(&reservedState); err != nil || reservedState != "reserved" {
		t.Fatalf("interrupted quota state = %q, %v", reservedState, err)
	}

	resumed := serveSyncV2(handler, ownerToken, body)
	if resumed.Code != http.StatusOK || resumed.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("resumed response = %d %s", resumed.Code, resumed.Body.String())
	}
	var response struct {
		Version       string `json:"version"`
		HighWatermark int64  `json:"highWatermark"`
		Changes       []struct {
			Kind string `json:"kind"`
			Card struct {
				ID       string `json:"id"`
				Title    string `json:"title"`
				Revision int64  `json:"revision"`
			} `json:"card"`
		} `json:"changes"`
		Receipts []struct {
			MutationID string `json:"mutationId"`
		} `json:"receipts"`
		Page struct {
			Kind       string `json:"kind"`
			NextCursor string `json:"nextCursor"`
		} `json:"page"`
	}
	if err := json.Unmarshal(resumed.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Version != syncv2.ProtocolVersion || response.HighWatermark != 1 ||
		len(response.Changes) != 1 || response.Changes[0].Kind != string(syncv2.ChangeCardUpsert) ||
		response.Changes[0].Card.ID != cardID || response.Changes[0].Card.Title != "private recovery title" ||
		response.Changes[0].Card.Revision != 1 || len(response.Receipts) != 1 ||
		response.Receipts[0].MutationID != mutationID || response.Page.Kind != string(syncv2.PageComplete) ||
		response.Page.NextCursor == "" {
		t.Fatalf("resumed payload = %#v", response)
	}
	if objects.Calls().Put != 1 || encryption.encrypt != 1 || objectKeys.calls != 1 {
		t.Fatalf("resume repeated write side effect = %#v, encrypt=%d keys=%d", objects.Calls(), encryption.encrypt, objectKeys.calls)
	}
	var state string
	var activeCards int64
	if err := pool.QueryRow(ctx,
		`SELECT reservation.state, usage.active_cards
		   FROM vault_quota_reservations reservation
		   JOIN vault_quota_usage usage USING (account_id, vault_id)
		  WHERE reservation.account_id = $1 AND reservation.vault_id = $2 AND reservation.reservation_id = $3`,
		string(owner.AccountID), string(owner.VaultID), mutationID,
	).Scan(&state, &activeCards); err != nil || state != "committed" || activeCards != 1 {
		t.Fatalf("committed quota = %q %d, %v", state, activeCards, err)
	}

	descriptors, err := objects.List(ctx)
	if err != nil || len(descriptors) != 1 {
		t.Fatalf("stored objects = %#v, %v", descriptors, err)
	}
	ciphertext, found, err := objects.Get(ctx, descriptors[0].ObjectKey)
	if err != nil || !found || bytes.Contains(ciphertext, []byte("private recovery title")) {
		t.Fatalf("ciphertext isolation found=%t error=%v plaintext-leak=%t", found, err, bytes.Contains(ciphertext, []byte("private recovery title")))
	}
	var encryptedRows int
	if err := pool.QueryRow(ctx,
		"SELECT count(*) FROM vault_encrypted_objects WHERE vault_id = $1 AND object_id = $2 AND object_revision = 1",
		string(owner.VaultID), cardID,
	).Scan(&encryptedRows); err != nil || encryptedRows != 1 {
		t.Fatalf("encrypted metadata rows = %d, %v", encryptedRows, err)
	}

	emptyWithCursor := `{"version":"sync/v2","deviceId":"01991f20-61d2-7000-8000-000000000451","cursor":"` +
		response.Page.NextCursor + `","mutations":[]}`
	terminal := serveSyncV2(handler, ownerToken, emptyWithCursor)
	if terminal.Code != http.StatusOK || !strings.Contains(terminal.Body.String(), `"changes":[]`) {
		t.Fatalf("terminal cursor response = %d %s", terminal.Code, terminal.Body.String())
	}
	tamperedCursor := response.Page.NextCursor[:len(response.Page.NextCursor)-1] + "A"
	if strings.HasSuffix(response.Page.NextCursor, "A") {
		tamperedCursor = response.Page.NextCursor[:len(response.Page.NextCursor)-1] + "B"
	}
	tampered := strings.Replace(emptyWithCursor, response.Page.NextCursor, tamperedCursor, 1)
	if result := serveSyncV2(handler, ownerToken, tampered); result.Code != http.StatusBadRequest {
		t.Fatalf("tampered cursor response = %d %s", result.Code, result.Body.String())
	}
	otherDevice := strings.Replace(emptyWithCursor, "000000000451", "000000000452", 1)
	if result := serveSyncV2(handler, ownerToken, otherDevice); result.Code != http.StatusBadRequest {
		t.Fatalf("cross-device cursor response = %d %s", result.Code, result.Body.String())
	}
	if result := serveSyncV2(handler, otherToken, emptyWithCursor); result.Code != http.StatusPaymentRequired {
		t.Fatalf("cross-owner cursor response = %d %s", result.Code, result.Body.String())
	}
	deviceID, err := syncv2.ParseDeviceID("01991f20-61d2-7000-8000-000000000451")
	if err != nil {
		t.Fatal(err)
	}
	foreignCursor, err := cursors.Issue(syncv2.CursorClaims{
		Version: syncv2.CursorVersion, VaultID: other.VaultID, DeviceID: deviceID,
	})
	if err != nil {
		t.Fatal(err)
	}
	foreignCursorResult, err := application.Synchronize(ctx, syncv2.SynchronizeInput{
		Context: owner,
		Request: syncv2.Request{
			DeviceID: deviceID, Cursor: &foreignCursor, Mutations: []syncv2.Mutation{},
		},
		SynchronizedAt: 3_000, RequestBytes: 100,
		Limits: entitlementService.ReadLimits(ctx, owner, 3_000).Limits,
	})
	if err != nil || foreignCursorResult.Kind != syncv2.ApplicationRejected ||
		foreignCursorResult.Reason != syncv2.ApplicationInvalidCursor {
		t.Fatalf("foreign Vault cursor = %#v, %v", foreignCursorResult, err)
	}
	reused := strings.Replace(body, "private recovery title", "different title", 1)
	if result := serveSyncV2(handler, ownerToken, reused); result.Code != http.StatusConflict ||
		result.Body.String() != "{\"error\":\"sync-conflict\"}\n" {
		t.Fatalf("idempotency reuse response = %d %s", result.Code, result.Body.String())
	}

	deleteMutationID, err := syncv2.ParseMutationID(integrationUUID(t, 952))
	if err != nil {
		t.Fatal(err)
	}
	parsedCardID, err := syncv2.ParseCardID(cardID)
	if err != nil {
		t.Fatal(err)
	}
	deleted, err := application.DeleteCard(ctx, syncv2.DeleteCardInput{
		Context: owner, MutationID: deleteMutationID, CardID: parsedCardID,
		ExpectedRevision: 1, DeletedAt: 3_500, SynchronizedAt: 4_000,
		Limits: entitlementService.ReadLimits(ctx, owner, 4_000).Limits,
	})
	if err != nil || deleted.Kind != syncv2.DeleteCardDeleted || deleted.Receipt.AppliedRevision != 2 {
		t.Fatalf("delete card = %#v, %v", deleted, err)
	}
	replayedDelete, err := application.DeleteCard(ctx, syncv2.DeleteCardInput{
		Context: owner, MutationID: deleteMutationID, CardID: parsedCardID,
		ExpectedRevision: 1, DeletedAt: 3_500, SynchronizedAt: 4_001,
		Limits: entitlementService.ReadLimits(ctx, owner, 4_001).Limits,
	})
	if err != nil || replayedDelete.Kind != syncv2.DeleteCardDeleted || replayedDelete.Receipt != deleted.Receipt {
		t.Fatalf("replay delete = %#v, %v", replayedDelete, err)
	}
	if objects.Calls().Put != 1 || encryption.encrypt != 1 || objectKeys.calls != 1 {
		t.Fatalf("delete replay wrote content = %#v, encrypt=%d keys=%d", objects.Calls(), encryption.encrypt, objectKeys.calls)
	}
	var deleteState string
	if err := pool.QueryRow(ctx,
		`SELECT reservation.state, usage.active_cards
		   FROM vault_quota_reservations reservation
		   JOIN vault_quota_usage usage USING (account_id, vault_id)
		  WHERE reservation.account_id = $1 AND reservation.vault_id = $2 AND reservation.reservation_id = $3`,
		string(owner.AccountID), string(owner.VaultID), string(deleteMutationID),
	).Scan(&deleteState, &activeCards); err != nil || deleteState != "committed" || activeCards != 0 {
		t.Fatalf("delete quota = %q %d, %v", deleteState, activeCards, err)
	}
	now = 4_001
	changesAfterDelete := serveSyncV2(handler, ownerToken, emptyWithCursor)
	if changesAfterDelete.Code != http.StatusOK ||
		!strings.Contains(changesAfterDelete.Body.String(), `"kind":"card-tombstone"`) ||
		!strings.Contains(changesAfterDelete.Body.String(), `"revision":2`) ||
		!strings.Contains(changesAfterDelete.Body.String(), `"deletedAt":3500`) {
		t.Fatalf("delete change response = %d %s", changesAfterDelete.Code, changesAfterDelete.Body.String())
	}
}

type failOnceSyncV2JournalDirectory struct {
	syncv2.Directory
	fail bool
}

func (directory *failOnceSyncV2JournalDirectory) Open(
	ctx context.Context,
	vaultContext identity.VaultContext,
) (syncv2.OpenResult, error) {
	opened, err := directory.Directory.Open(ctx, vaultContext)
	if err != nil || opened.Repository == nil {
		return opened, err
	}
	opened.Repository = &failOnceSyncV2JournalRepository{
		Repository: opened.Repository, directory: directory,
	}
	return opened, nil
}

type failOnceSyncV2JournalRepository struct {
	syncv2.Repository
	directory *failOnceSyncV2JournalDirectory
}

func (repository *failOnceSyncV2JournalRepository) Commit(
	ctx context.Context,
	command syncv2.CommitCommand,
) (syncv2.CommitResult, error) {
	if repository.directory.fail {
		repository.directory.fail = false
		return syncv2.CommitResult{}, errInjectedSyncV2JournalCommit
	}
	return repository.Repository.Commit(ctx, command)
}

func createIntegrationSession(
	t *testing.T,
	ctx context.Context,
	store *postgresadapter.SessionStore,
	vaultContext identity.VaultContext,
	token identity.SessionToken,
) {
	t.Helper()
	created := identity.CreateActiveSession(identity.SessionInput{
		SessionID: vaultContext.SessionID, AccountID: vaultContext.AccountID,
		VaultID: vaultContext.VaultID, SessionEpoch: vaultContext.SessionEpoch,
		IssuedAt: 1_000, ExpiresAt: 10_000,
	})
	if !created.Created {
		t.Fatalf("create session = %#v", created)
	}
	if err := store.CreateSession(ctx, created.Session, token); err != nil {
		t.Fatal(err)
	}
}

func serveSyncV2(handler http.Handler, token identity.SessionToken, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/api/v2/sync", strings.NewReader(body))
	request.Header.Set("Cookie", identity.SessionCookieName+"="+string(token))
	request.Header.Set("Origin", "https://notes.example")
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

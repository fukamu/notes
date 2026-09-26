//go:build integration

package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/notes/backend/internal/access"
	localfixtureadapter "github.com/fukamu/notes/backend/internal/adapters/localfixture"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	recoverykeyadapter "github.com/fukamu/notes/backend/internal/adapters/recoverykey"
	"github.com/fukamu/notes/backend/internal/config"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/localfixture"
	"github.com/fukamu/notes/backend/internal/syncv2"
	"github.com/fukamu/notes/backend/migrations"
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
	compositionOrigin    = "http://localhost:3100"
	compositionSecret    = "restart-persistent encrypted fixture content"
)

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
	deleted, err := second.syncV2Application.DeleteCard(ctx, syncv2.DeleteCardInput{
		Context: configuration.LocalFixtureContext(), MutationID: deletionID,
		CardID: cardID, ExpectedRevision: 1, DeletedAt: 2_000,
		SynchronizedAt: 2_000, Limits: entitlement.PaidPersonalVaultLimits(),
	})
	if err != nil || deleted.Kind != syncv2.DeleteCardDeleted || deleted.Receipt.AppliedRevision != 2 {
		t.Fatalf("delete = %#v, %v", deleted, err)
	}
	replayed, err := second.syncV2Application.DeleteCard(ctx, syncv2.DeleteCardInput{
		Context: configuration.LocalFixtureContext(), MutationID: deletionID,
		CardID: cardID, ExpectedRevision: 1, DeletedAt: 2_000,
		SynchronizedAt: 2_001, Limits: entitlement.PaidPersonalVaultLimits(),
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
			DeletionHMACKey: [32]byte{0x43},
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
		EnableDisconnectedFixtures: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
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

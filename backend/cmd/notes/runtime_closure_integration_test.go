//go:build integration

package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/fukamu/notes/backend/internal/access"
	accessadapter "github.com/fukamu/notes/backend/internal/adapters/access"
	localfixtureadapter "github.com/fukamu/notes/backend/internal/adapters/localfixture"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/syncv2"
)

const (
	wholeRuntimeIssuer             = "https://issuer.test/runtime-closure"
	wholeRuntimeAudience           = "notes-runtime-closure"
	wholeRuntimeOwner              = "runtime-closure-owner"
	wholeRuntimeTitle              = "whole-runtime-restart-evidence"
	wholeRuntimeQueryCanary        = "runtime-query-canary-must-not-log"
	wholeRuntimeCSP                = "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:"
	wholeRuntimeOfferHash          = "sha256:19edccf0f78bed73624638cb28459a185150fa7f945bd694213fe7d851f71a9d"
	wholeRuntimeTermsHash          = "sha256:791f75856934960252ca37607ba28b46f9ac544990312f4ab909c57460e55597"
	wholeRuntimeCancellationPolicy = "解約はアカウントの契約管理画面からいつでも申し込めます。無料期間中に解約した場合は初回料金が発生せず、利用権停止事由がない限り無料期間の終了時まで利用できます。初回課金後に解約した場合は次回以降の自動更新を停止し、利用権停止事由がない限り支払済みの利用期間の終了時まで利用できます。サブスクリプションの解約とアカウントの退会は別の手続です。"
	wholeRuntimeRefundPolicy       = "提供開始後の料金は日割り計算せず、通常は返金しません。ただし、重複課金、当社の責めに帰すべき事由によりサービスを提供できなかった場合、または法令上返金が必要な場合は、該当する範囲を返金します。"
	wholeRuntimeAdditionalFees     = "本サービスの利用に必要なインターネット接続料金、通信料金および利用端末の費用は利用者の負担です。"
	wholeRuntimeCursorA            = "eyJ2ZXJzaW9uIjoic3luYy1jdXJzb3IvdjIiLCJ2YXVsdElkIjoiMDE5OTljMjAtOWUzMy03MDAwLTgwMDAtMDAwMDAwMDAwMTAyIiwiZGV2aWNlSWQiOiIwMTk5OWMyMC05ZTMzLTcwMDAtODAwMC0wMDAwMDAwMDAxMDciLCJhZnRlclNlcXVlbmNlIjoxLCJoaWdoV2F0ZXJtYXJrIjoxfQ.ayox8s-tSM-TzLcg2U6sEn4R5L6YXVJ7Fq7mtIVyVEY"
	wholeRuntimeCursorB            = "eyJ2ZXJzaW9uIjoic3luYy1jdXJzb3IvdjIiLCJ2YXVsdElkIjoiMDE5OTljMjAtOWUzMy03MDAwLTgwMDAtMDAwMDAwMDAwMTAyIiwiZGV2aWNlSWQiOiIwMTk5OWMyMC05ZTMzLTcwMDAtODAwMC0wMDAwMDAwMDAxMDgiLCJhZnRlclNlcXVlbmNlIjoxLCJoaWdoV2F0ZXJtYXJrIjoxfQ.meuBoCkzBRnBCzKMQkXRY22FSNGtLf0f6w0CnC68_iQ"
)

var (
	wholeRuntimeUUIDV7Pattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
)

type wholeRuntimeProfile string

const (
	wholeRuntimePrivate    wholeRuntimeProfile = "local-private-legacy"
	wholeRuntimeUndecided  wholeRuntimeProfile = "local-fixture-undecided"
	wholeRuntimeDeleteLive wholeRuntimeProfile = "local-fixture-delete-live-evidence"
)

type wholeRuntimeFixture struct {
	profile          wholeRuntimeProfile
	databaseURL      string
	notesBinary      string
	notesctlBinary   string
	staticRoot       string
	privateRoot      string
	address          string
	origin           string
	values           map[string]string
	ownerAssertion   string
	foreignAssertion string
	sessionToken     string
	cursorKey        string
	deletionKey      string
}

type wholeRuntimeServer struct {
	command  *exec.Cmd
	done     <-chan struct{}
	logs     *bytes.Buffer
	stopOnce sync.Once
	waitErr  error
}

type wholeRuntimeState struct {
	privacyRequestID       string
	privacyCanonical       string
	termsConsentID         string
	termsAcceptedAt        int64
	checkoutEvidenceID     string
	checkoutOfferHash      string
	checkoutOfferVersion   string
	cancellationConfirmed  int64
	cancellationAccessEnds int64
}

type wholeRuntimeAuth int

const (
	wholeRuntimeNoAuth wholeRuntimeAuth = iota
	wholeRuntimeAssertionAuth
	wholeRuntimeSessionAuth
)

func TestWholeRuntimeLocalPrivateLegacy(t *testing.T) {
	runWholeRuntimeProfile(t, wholeRuntimePrivate)
}

func TestWholeRuntimeLocalFixtureUndecided(t *testing.T) {
	runWholeRuntimeProfile(t, wholeRuntimeUndecided)
}

func TestWholeRuntimeLocalFixtureDeleteLiveEvidence(t *testing.T) {
	runWholeRuntimeProfile(t, wholeRuntimeDeleteLive)
}

func runWholeRuntimeProfile(t *testing.T, profile wholeRuntimeProfile) {
	t.Helper()
	fixture := prepareWholeRuntimeFixture(t, profile)
	state := &wholeRuntimeState{}
	for cycle := 1; cycle <= 2; cycle++ {
		server := startWholeRuntimeServer(t, fixture, fixture.values)
		assertWholeRuntimeFoundationRoutes(t, fixture)
		switch profile {
		case wholeRuntimePrivate:
			assertPrivateLegacyRouteMatrix(t, fixture, cycle)
			if cycle == 1 {
				assertPrivateLegacyFailureOrdering(t, fixture)
			}
		case wholeRuntimeUndecided, wholeRuntimeDeleteLive:
			assertLocalFixtureRouteMatrix(t, fixture, state, cycle)
			if cycle == 1 {
				assertLocalFixtureFailureOrdering(t, fixture)
			}
			if cycle == 1 && profile == wholeRuntimeUndecided {
				assertLocalFixtureLeaseExclusion(t, fixture, state)
			}
		default:
			t.Fatalf("unknown whole-runtime profile %q", profile)
		}
		logs := stopWholeRuntimeServer(t, server)
		assertWholeRuntimeLogs(t, fixture, logs, cycle)
	}
}

func prepareWholeRuntimeFixture(t *testing.T, profile wholeRuntimeProfile) wholeRuntimeFixture {
	t.Helper()
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("safe NOTES_TEST_DATABASE_URL is required: %v", err)
	}
	backendRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	binRoot := t.TempDir()
	notesBinary := filepath.Join(binRoot, "notes")
	notesctlBinary := filepath.Join(binRoot, "notesctl")
	buildWholeRuntimeBinary(t, backendRoot, notesBinary, "./cmd/notes")
	buildWholeRuntimeBinary(t, backendRoot, notesctlBinary, "./cmd/notesctl")

	address := wholeRuntimeFreeAddress(t)
	origin := "http://" + address
	privateRoot := ""
	staticRoot := compositionStaticSite(t)
	if err := os.WriteFile(
		filepath.Join(staticRoot, "pricing", "index.html"),
		[]byte("<!doctype html><title>pricing fixture</title>"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(staticRoot, "assets"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(staticRoot, "assets", "runtime-closure.js"),
		[]byte("export const runtimeClosure = true;\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	sessionToken := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x41}, 32))
	cursorKey := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x42}, 32))
	deletionKey := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x43}, 32))
	ownerAssertion := wholeRuntimeSignedAssertion(t, privateKey, wholeRuntimeOwner)
	foreignAssertion := wholeRuntimeSignedAssertion(t, privateKey, "runtime-closure-other-owner")
	policy := "undecided"
	if profile == wholeRuntimeDeleteLive {
		policy = "delete-live-evidence"
	}
	values := map[string]string{
		"NOTES_ENVIRONMENT":              "test",
		"NOTES_HTTP_ADDR":                address,
		"NOTES_STATIC_DIR":               staticRoot,
		"NOTES_BODY_LIMIT_BYTES":         "2048",
		"NOTES_SHUTDOWN_TIMEOUT":         "2s",
		"NOTES_LOG_LEVEL":                "info",
		"NOTES_APPLICATION_PROFILE":      "disabled",
		"NOTES_PRIVATE_AUTH_MODE":        "local-signed",
		"NOTES_DATABASE_URL":             databaseURL,
		"NOTES_DATABASE_MAX_CONNECTIONS": "4",
		"NOTES_PUBLIC_ORIGIN":            origin,
		"NOTES_LOCAL_AUTH_ISSUER":        wholeRuntimeIssuer,
		"NOTES_LOCAL_AUTH_AUDIENCE":      wholeRuntimeAudience,
		"NOTES_LOCAL_AUTH_PUBLIC_KEY":    base64.RawURLEncoding.EncodeToString(publicKey),
		"NOTES_LEGACY_OWNER_SUBJECT":     wholeRuntimeOwner,
	}
	if profile == wholeRuntimePrivate {
		prepare := exec.Command(
			notesctlBinary,
			"prepare-e2e",
			"--environment=test",
			"--allowed-subject="+wholeRuntimeOwner,
		)
		prepare.Env = wholeRuntimeEnvironment(values)
		if _, prepareErr := prepare.CombinedOutput(); prepareErr != nil {
			t.Fatalf("prepare private profile with notesctl: %v", prepareErr)
		}
	} else {
		privateRoot = t.TempDir()
		if err := os.Chmod(privateRoot, 0o700); err != nil {
			t.Fatal(err)
		}
		values["NOTES_APPLICATION_PROFILE"] = "local-fixture"
		values["NOTES_LOCAL_FIXTURE_ROOT"] = privateRoot
		values["NOTES_LOCAL_FIXTURE_ACCOUNT_ID"] = compositionAccountID
		values["NOTES_LOCAL_FIXTURE_VAULT_ID"] = compositionVaultID
		values["NOTES_LOCAL_FIXTURE_SESSION_ID"] = compositionSessionID
		values["NOTES_LOCAL_FIXTURE_SESSION_EPOCH"] = "1"
		values["NOTES_LOCAL_FIXTURE_SESSION_TOKEN"] = sessionToken
		values["NOTES_LOCAL_FIXTURE_CURSOR_HMAC_KEY"] = cursorKey
		values["NOTES_LOCAL_FIXTURE_DELETION_HMAC_KEY"] = deletionKey
		values["NOTES_LOCAL_FIXTURE_LEGAL_EVIDENCE_POLICY"] = policy
		prepare := exec.Command(
			notesctlBinary,
			"prepare-e2e",
			"--environment=test",
			"--allowed-subject="+wholeRuntimeOwner,
		)
		prepare.Env = wholeRuntimeEnvironment(values)
		if _, prepareErr := prepare.CombinedOutput(); prepareErr != nil {
			t.Fatalf("prepare exact fixture: %v", prepareErr)
		}
	}
	return wholeRuntimeFixture{
		profile: profile, databaseURL: databaseURL,
		notesBinary: notesBinary, notesctlBinary: notesctlBinary,
		staticRoot: staticRoot, privateRoot: privateRoot,
		address: address, origin: origin, values: values,
		sessionToken:   sessionToken,
		ownerAssertion: ownerAssertion, foreignAssertion: foreignAssertion,
		cursorKey: cursorKey, deletionKey: deletionKey,
	}
}

func buildWholeRuntimeBinary(t *testing.T, backendRoot, output, target string) {
	t.Helper()
	command := exec.Command("go", "build", "-trimpath", "-o", output, target)
	command.Dir = backendRoot
	if _, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build %s: %v", target, err)
	}
}

func wholeRuntimeFreeAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return address
}

func startWholeRuntimeServer(
	t *testing.T,
	fixture wholeRuntimeFixture,
	values map[string]string,
) *wholeRuntimeServer {
	t.Helper()
	logs := &bytes.Buffer{}
	command := exec.Command(fixture.notesBinary)
	command.Env = wholeRuntimeEnvironment(values)
	command.Stdout = logs
	command.Stderr = logs
	if err := command.Start(); err != nil {
		t.Fatalf("start %s: %v", fixture.profile, err)
	}
	done := make(chan struct{})
	server := &wholeRuntimeServer{command: command, done: done, logs: logs}
	go func() {
		server.waitErr = command.Wait()
		close(done)
	}()
	t.Cleanup(func() {
		server.stopOnce.Do(func() {
			select {
			case <-server.done:
			default:
				_ = server.command.Process.Kill()
				<-server.done
			}
		})
	})
	deadline := time.Now().Add(10 * time.Second)
	for {
		select {
		case <-done:
			t.Fatalf("%s exited before health: %v", fixture.profile, server.waitErr)
		default:
		}
		response, err := wholeRuntimeHTTP(t, fixture, http.MethodGet, "/healthz", "", wholeRuntimeNoAuth)
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return server
			}
		}
		if time.Now().After(deadline) {
			_ = command.Process.Kill()
			<-done
			t.Fatalf("%s did not become healthy", fixture.profile)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func stopWholeRuntimeServer(t *testing.T, server *wholeRuntimeServer) string {
	t.Helper()
	timedOut := false
	signalErr := error(nil)
	server.stopOnce.Do(func() {
		signalErr = server.command.Process.Signal(syscall.SIGTERM)
		if signalErr != nil {
			_ = server.command.Process.Kill()
			<-server.done
			return
		}
		select {
		case <-server.done:
		case <-time.After(8 * time.Second):
			timedOut = true
			_ = server.command.Process.Kill()
			<-server.done
		}
	})
	if signalErr != nil {
		t.Fatalf("signal server: %v", signalErr)
	}
	if timedOut {
		t.Fatal("server did not drain after SIGTERM")
	}
	logs := server.logs.String()
	if server.waitErr != nil {
		if strings.Contains(logs, `"error_code":"server_failure"`) {
			t.Fatalf("SIGTERM server exit reported server_failure: %v", server.waitErr)
		}
		t.Fatalf("SIGTERM server exit: %v", server.waitErr)
	}
	return logs
}

func assertWholeRuntimeFoundationRoutes(t *testing.T, fixture wholeRuntimeFixture) {
	t.Helper()
	for _, check := range []struct {
		path string
		body string
	}{
		{path: "/healthz", body: `{"status":"ok"}`},
		{path: "/readyz", body: `{"status":"ready"}`},
	} {
		response, body := mustWholeRuntimeHTTP(
			t, fixture, http.MethodGet, check.path, "", wholeRuntimeNoAuth,
		)
		assertWholeRuntimeJSONHeaders(t, check.path, response, "no-store", "")
		if response.StatusCode != http.StatusOK || strings.TrimSpace(body) != check.body {
			t.Fatalf("%s %s = %d %q, want 200 %q", fixture.profile, check.path, response.StatusCode, body, check.body)
		}
	}
	for _, check := range []struct {
		path     string
		filename string
	}{
		{path: "/", filename: "index.html"},
		{path: "/pricing", filename: "pricing/index.html"},
		{path: "/cards/01999c20-9e33-7000-8000-000000000104/history", filename: "index.html"},
	} {
		response, body := mustWholeRuntimeHTTP(
			t, fixture, http.MethodGet, check.path, "", wholeRuntimeNoAuth,
		)
		assertWholeRuntimeStaticHTMLHeaders(t, check.path, response)
		want, err := os.ReadFile(filepath.Join(fixture.staticRoot, filepath.FromSlash(check.filename)))
		if err != nil {
			t.Fatalf("read expected static %s: %v", check.filename, err)
		}
		if response.StatusCode != http.StatusOK || body != string(want) {
			t.Fatalf("%s %s did not return exact %s", fixture.profile, check.path, check.filename)
		}
	}
	for _, requestPath := range []string{
		"/missing",
		"/api/missing",
		"/api/missing?token=" + wholeRuntimeQueryCanary,
	} {
		response, body := mustWholeRuntimeHTTP(
			t, fixture, http.MethodGet, requestPath, "", wholeRuntimeNoAuth,
		)
		assertWholeRuntimeJSONCode(t, requestPath, response, body, http.StatusNotFound, "not_found")
	}
	response, body := mustWholeRuntimeHTTP(
		t, fixture, http.MethodGet, "/assets/runtime-closure.js", "", wholeRuntimeNoAuth,
	)
	assertWholeRuntimeStaticAssetHeaders(t, "/assets/runtime-closure.js", response)
	if response.StatusCode != http.StatusOK || body != "export const runtimeClosure = true;\n" {
		t.Fatalf("%s immutable asset response was not exact", fixture.profile)
	}
}

func assertPrivateLegacyRouteMatrix(
	t *testing.T,
	fixture wholeRuntimeFixture,
	cycle int,
) {
	t.Helper()
	tested := 0
	response, body := mustWholeRuntimeHTTP(
		t, fixture, http.MethodGet, "/api/launch-status", "", wholeRuntimeAssertionAuth,
	)
	tested++
	assertWholeRuntimeLaunchResponse(t, "private launch", response, body)
	legacyBody := `{"deviceId":"` + compositionDeviceB + `","mutations":[]}`
	if cycle == 1 {
		legacyBody = `{"deviceId":"` + compositionDeviceA +
			`","mutations":[{"mutationId":"` + compositionMutation +
			`","cardId":"` + compositionCardID +
			`","baseServerRevision":null,"title":"` + wholeRuntimeTitle +
			`","body":[],"createdAt":1000,"updatedAt":1000,"kind":"upsert","conflictIds":[]}]}`
	}
	response, body = mustWholeRuntimeHTTP(
		t, fixture, http.MethodPost, "/api/sync", legacyBody, wholeRuntimeAssertionAuth,
	)
	tested++
	assertWholeRuntimeLegacySyncResponse(t, response, body, cycle)
	closed := []struct {
		method         string
		path           string
		privateHeaders bool
	}{
		{http.MethodPost, "/api/v2/sync", true},
		{http.MethodGet, "/api/session-context", true},
		{http.MethodGet, "/api/billing/checkout", true},
		{http.MethodPost, "/api/billing/checkout", true},
		{http.MethodGet, "/api/account/terms-consent", true},
		{http.MethodPost, "/api/account/terms-consent", true},
		{http.MethodPost, "/api/billing/cancel", false},
		{http.MethodPost, "/api/account/deletion", false},
		{http.MethodPost, "/api/account/deletion/status", false},
		{http.MethodPost, "/api/account/privacy-requests", false},
		{http.MethodPost, "/api/account/privacy-requests/status", false},
	}
	for _, route := range closed {
		response, body = mustWholeRuntimeHTTP(
			t, fixture, route.method, route.path, `{}`, wholeRuntimeAssertionAuth,
		)
		tested++
		if route.privateHeaders {
			assertWholeRuntimePrivateJSONError(t, route.path, response, body, http.StatusNotFound, "not-found")
		} else {
			assertWholeRuntimeJSONError(t, route.path, response, body, http.StatusNotFound, "not-found")
		}
	}
	if tested != 13 {
		t.Fatalf("private route evidence count = %d, want 13", tested)
	}
}

func assertLocalFixtureRouteMatrix(
	t *testing.T,
	fixture wholeRuntimeFixture,
	state *wholeRuntimeState,
	cycle int,
) {
	t.Helper()
	tested := 0
	response, body := mustWholeRuntimeHTTP(
		t, fixture, http.MethodGet, "/api/launch-status", "", wholeRuntimeAssertionAuth,
	)
	tested++
	assertWholeRuntimeLaunchResponse(t, "fixture launch", response, body)
	response, body = mustWholeRuntimeHTTP(
		t, fixture, http.MethodPost, "/api/sync", `{}`, wholeRuntimeNoAuth,
	)
	tested++
	assertWholeRuntimeJSONCode(t, "/api/sync", response, body, http.StatusNotFound, "not_found")

	syncBody := `{"version":"sync/v2","deviceId":"` + compositionDeviceB + `","cursor":null,"mutations":[]}`
	if cycle == 1 {
		syncBody = `{"version":"sync/v2","deviceId":"` + compositionDeviceA +
			`","cursor":null,"mutations":[{"mutationId":"` + compositionMutation +
			`","cardId":"` + compositionCardID +
			`","baseServerRevision":null,"title":"` + wholeRuntimeTitle +
			`","body":[],"createdAt":1000,"updatedAt":1000,"kind":"upsert","conflictIds":[]}]}`
	}
	response, body = mustWholeRuntimeHTTP(
		t, fixture, http.MethodPost, "/api/v2/sync", syncBody, wholeRuntimeSessionAuth,
	)
	tested++
	assertWholeRuntimeSyncV2Response(t, fixture, response, body, cycle)
	assertWholeRuntimeEncryptedObject(t, fixture, syncBody)
	response, body = mustWholeRuntimeHTTP(
		t, fixture, http.MethodGet, "/api/session-context", "", wholeRuntimeSessionAuth,
	)
	tested++
	wantDeletionAvailable := fixture.profile == wholeRuntimeDeleteLive
	assertWholeRuntimeSessionContext(t, response, body, wantDeletionAvailable)

	response, body = mustWholeRuntimeHTTP(
		t, fixture, http.MethodGet, "/api/billing/checkout", "", wholeRuntimeSessionAuth,
	)
	tested++
	offer := wholeRuntimeJSONObject(t, body)
	assertWholeRuntimeOffer(t, response, offer)
	offerHash := wholeRuntimeJSONString(t, offer, "offerHash")
	response, body = mustWholeRuntimeHTTP(
		t, fixture, http.MethodGet, "/api/account/terms-consent", "", wholeRuntimeSessionAuth,
	)
	tested++
	if response.StatusCode != http.StatusOK {
		t.Fatalf("fixture terms status = %d %q", response.StatusCode, body)
	}
	termsStatus := wholeRuntimeJSONObject(t, body)
	assertWholeRuntimeJSONHeaders(t, "terms status", response, "no-store", "")
	wholeRuntimeAssertExactKeys(t, "terms status", termsStatus, "outcome", "status")
	if wholeRuntimeJSONString(t, termsStatus, "outcome") != "status" {
		t.Fatalf("fixture terms status outcome = %q", body)
	}
	statusObject := wholeRuntimeJSONNested(t, termsStatus, "status")
	assertWholeRuntimeTermsStatus(t, statusObject, cycle == 2)
	if cycle == 2 {
		assertWholeRuntimeDurableTerms(t, state, wholeRuntimeJSONNested(t, statusObject, "accepted"))
	}
	currentTerms := wholeRuntimeJSONNested(t, statusObject, "current")
	termsBody := wholeRuntimeJSON(t, map[string]any{
		"submissionId":          "01999c20-9e33-7000-8000-000000000822",
		"presentedTermsVersion": wholeRuntimeJSONString(t, currentTerms, "termsVersion"),
		"presentedTermsHash":    wholeRuntimeJSONString(t, currentTerms, "termsHash"),
		"consent":               map[string]string{"kind": "affirmed"},
	})
	response, body = mustWholeRuntimeHTTP(
		t, fixture, http.MethodPost, "/api/account/terms-consent", termsBody, wholeRuntimeSessionAuth,
	)
	tested++
	wantTermsOutcome := "recorded"
	if cycle == 2 {
		wantTermsOutcome = "replayed"
	}
	if response.StatusCode != http.StatusOK ||
		wholeRuntimeJSONString(t, wholeRuntimeJSONObject(t, body), "outcome") != wantTermsOutcome {
		t.Fatalf("fixture terms mutation cycle %d = %d %q", cycle, response.StatusCode, body)
	}
	termsApplication := wholeRuntimeJSONObject(t, body)
	assertWholeRuntimeJSONHeaders(t, "terms mutation", response, "no-store", "")
	wholeRuntimeAssertExactKeys(t, "terms mutation", termsApplication, "outcome", "status")
	acceptedTermsStatus := wholeRuntimeJSONNested(t, termsApplication, "status")
	assertWholeRuntimeTermsStatus(t, acceptedTermsStatus, true)
	acceptedTerms := wholeRuntimeJSONNested(t, acceptedTermsStatus, "accepted")
	if cycle == 1 {
		state.termsConsentID = wholeRuntimeJSONString(t, acceptedTerms, "consentId")
		state.termsAcceptedAt = wholeRuntimeJSONInteger(t, acceptedTerms, "acceptedAt")
	} else {
		assertWholeRuntimeDurableTerms(t, state, acceptedTerms)
	}
	checkoutBody := wholeRuntimeJSON(t, map[string]any{
		"submissionId":       "01999c20-9e33-7000-8000-000000000821",
		"presentedOfferHash": offerHash,
		"consent":            map[string]string{"kind": "affirmed"},
	})
	response, body = mustWholeRuntimeHTTP(
		t, fixture, http.MethodPost, "/api/billing/checkout", checkoutBody, wholeRuntimeSessionAuth,
	)
	tested++
	wantEvidenceOutcome := "recorded"
	if cycle == 2 {
		wantEvidenceOutcome = "replayed"
	}
	checkout := wholeRuntimeJSONObject(t, body)
	assertWholeRuntimeJSONHeaders(t, "checkout mutation", response, "no-store", "")
	wholeRuntimeAssertExactKeys(
		t, "checkout mutation", checkout,
		"kind", "evidenceOutcome", "evidenceId", "offerHash", "offerVersion",
	)
	if response.StatusCode != http.StatusOK ||
		wholeRuntimeJSONString(t, checkout, "kind") != "local-confirmed" ||
		wholeRuntimeJSONString(t, checkout, "evidenceOutcome") != wantEvidenceOutcome ||
		wholeRuntimeJSONString(t, checkout, "offerHash") != offerHash ||
		wholeRuntimeJSONString(t, checkout, "offerVersion") != "legal-commerce-v1:2026-09-15" ||
		!wholeRuntimeUUIDV7Pattern.MatchString(wholeRuntimeJSONString(t, checkout, "evidenceId")) {
		t.Fatalf("fixture checkout mutation cycle %d = %d %q", cycle, response.StatusCode, body)
	}
	if cycle == 1 {
		state.checkoutEvidenceID = wholeRuntimeJSONString(t, checkout, "evidenceId")
		state.checkoutOfferHash = wholeRuntimeJSONString(t, checkout, "offerHash")
		state.checkoutOfferVersion = wholeRuntimeJSONString(t, checkout, "offerVersion")
	} else if wholeRuntimeJSONString(t, checkout, "evidenceId") != state.checkoutEvidenceID ||
		wholeRuntimeJSONString(t, checkout, "offerHash") != state.checkoutOfferHash ||
		wholeRuntimeJSONString(t, checkout, "offerVersion") != state.checkoutOfferVersion {
		t.Fatalf("checkout durable evidence changed across restart: %#v", checkout)
	}
	cancelBody := `{"idempotencyKey":"cancel_whole_runtime_stable"}`
	response, body = mustWholeRuntimeHTTP(
		t, fixture, http.MethodPost, "/api/billing/cancel", cancelBody, wholeRuntimeSessionAuth,
	)
	tested++
	cancelled := wholeRuntimeJSONObject(t, body)
	assertWholeRuntimeJSONHeaders(t, "billing cancellation", response, "no-store", "")
	wholeRuntimeAssertExactKeys(t, "billing cancellation", cancelled, "status", "outcome", "confirmedAt", "accessEndsAt")
	if response.StatusCode != http.StatusOK ||
		wholeRuntimeJSONString(t, cancelled, "status") != "cancellation-scheduled" ||
		wholeRuntimeJSONString(t, cancelled, "outcome") != "scheduled" ||
		wholeRuntimeJSONInteger(t, cancelled, "confirmedAt") != identity.MaximumSafeInteger ||
		wholeRuntimeJSONInteger(t, cancelled, "accessEndsAt") != identity.MaximumSafeInteger {
		t.Fatalf("fixture cancellation cycle %d = %d %q", cycle, response.StatusCode, body)
	}
	confirmedAt := wholeRuntimeJSONInteger(t, cancelled, "confirmedAt")
	accessEndsAt := wholeRuntimeJSONInteger(t, cancelled, "accessEndsAt")
	if cycle == 1 {
		state.cancellationConfirmed = confirmedAt
		state.cancellationAccessEnds = accessEndsAt
	} else if confirmedAt != state.cancellationConfirmed || accessEndsAt != state.cancellationAccessEnds {
		t.Fatalf("cancellation durable receipt changed across restart: %#v", cancelled)
	}

	response, body = mustWholeRuntimeHTTP(
		t, fixture, http.MethodPost, "/api/account/deletion", `{}`, wholeRuntimeSessionAuth,
	)
	tested++
	if fixture.profile == wholeRuntimeDeleteLive {
		assertWholeRuntimeJSONError(t, "/api/account/deletion", response, body, http.StatusBadRequest, "invalid-request")
	} else {
		assertWholeRuntimeJSONError(t, "/api/account/deletion", response, body, http.StatusNotFound, "not-found")
	}
	response, body = mustWholeRuntimeHTTP(
		t, fixture, http.MethodPost, "/api/account/deletion/status", `{}`, wholeRuntimeSessionAuth,
	)
	tested++
	if fixture.profile == wholeRuntimeDeleteLive {
		assertWholeRuntimeJSONError(t, "/api/account/deletion/status", response, body, http.StatusUnauthorized, "continuation-required")
	} else {
		assertWholeRuntimeJSONError(t, "/api/account/deletion/status", response, body, http.StatusNotFound, "not-found")
	}

	privacySubmit := `{"submissionId":"` + compositionPrivacy + `","requestKind":"disclosure"}`
	response, body = mustWholeRuntimeHTTP(
		t, fixture, http.MethodPost, "/api/account/privacy-requests", privacySubmit, wholeRuntimeSessionAuth,
	)
	tested++
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("fixture privacy submit = %d %q", response.StatusCode, body)
	}
	privacyStatus := assertWholeRuntimePrivacyPending(t, "privacy submit", response, body)
	privacyRequestID := wholeRuntimeJSONString(t, privacyStatus, "requestId")
	privacyCanonical := wholeRuntimeJSON(t, privacyStatus)
	if state.privacyRequestID == "" {
		state.privacyRequestID = privacyRequestID
		state.privacyCanonical = privacyCanonical
	} else if privacyRequestID != state.privacyRequestID {
		t.Fatalf("privacy replay changed request id: %q != %q", privacyRequestID, state.privacyRequestID)
	} else if privacyCanonical != state.privacyCanonical {
		t.Fatalf("privacy replay changed durable public status: %s != %s", privacyCanonical, state.privacyCanonical)
	}
	response, body = mustWholeRuntimeHTTP(
		t, fixture, http.MethodPost, "/api/account/privacy-requests/status",
		`{"requestId":"`+state.privacyRequestID+`"}`, wholeRuntimeSessionAuth,
	)
	tested++
	statusResult := assertWholeRuntimePrivacyPending(t, "privacy status", response, body)
	if wholeRuntimeJSONString(t, statusResult, "requestId") != state.privacyRequestID ||
		wholeRuntimeJSON(t, statusResult) != state.privacyCanonical {
		t.Fatalf("fixture privacy status did not return exact durable journal: %q", body)
	}
	if tested != 13 {
		t.Fatalf("fixture route evidence count = %d, want 13", tested)
	}
}

func assertPrivateLegacyFailureOrdering(t *testing.T, fixture wholeRuntimeFixture) {
	t.Helper()
	large := strings.Repeat("x", 4_096)
	response, body := mustWholeRuntimeHTTPWithHeaders(
		t, fixture, http.MethodPost, "/api/sync", large,
		map[string]string{
			"Content-Type": "application/json",
			"Origin":       fixture.origin,
		},
	)
	assertWholeRuntimePrivateJSONError(t, "anonymous legacy sync", response, body, http.StatusForbidden, "launch-access-denied")
	wrongOrigin := wholeRuntimeHeaders(t, fixture, wholeRuntimeAssertionAuth)
	wrongOrigin["Origin"] = "https://attacker.invalid"
	response, body = mustWholeRuntimeHTTPWithHeaders(
		t, fixture, http.MethodPost, "/api/sync", large, wrongOrigin,
	)
	assertWholeRuntimePrivateJSONError(t, "cross-origin legacy sync", response, body, http.StatusForbidden, "launch-access-denied")
	response, body = mustWholeRuntimeHTTP(
		t, fixture, http.MethodPost, "/api/sync", large, wholeRuntimeAssertionAuth,
	)
	assertWholeRuntimePrivateJSONError(
		t, "authenticated legacy body limit", response, body,
		http.StatusRequestEntityTooLarge, "同期データが正しくありません。",
	)
	foreignHeaders := wholeRuntimeAssertionHeaders(t, fixture, "runtime-closure-other-owner")
	foreignMutation := `{"deviceId":"01999c20-9e33-7000-8000-000000000120","mutations":[{"mutationId":"01999c20-9e33-7000-8000-000000000121","cardId":"01999c20-9e33-7000-8000-000000000122","baseServerRevision":null,"title":"foreign-owner-must-not-persist","body":[],"createdAt":1000,"updatedAt":1000,"kind":"upsert","conflictIds":[]}]}`
	response, body = mustWholeRuntimeHTTPWithHeaders(
		t, fixture, http.MethodPost, "/api/sync", foreignMutation, foreignHeaders,
	)
	assertWholeRuntimePrivateJSONError(t, "foreign-owner legacy sync", response, body, http.StatusForbidden, "launch-access-denied")
	response, body = mustWholeRuntimeHTTP(
		t, fixture, http.MethodPost, "/api/sync",
		`{"deviceId":"`+compositionDeviceB+`","mutations":[]}`,
		wholeRuntimeAssertionAuth,
	)
	assertWholeRuntimeLegacySyncResponse(t, response, body, 2)
}

func assertLocalFixtureFailureOrdering(t *testing.T, fixture wholeRuntimeFixture) {
	t.Helper()
	large := strings.Repeat("x", 4_096)
	routes := []struct {
		path      string
		anonymous string
		bodyLimit bool
	}{
		{path: "/api/v2/sync", anonymous: "authentication-required", bodyLimit: true},
		{path: "/api/billing/checkout", anonymous: "authentication-required", bodyLimit: true},
		{path: "/api/account/terms-consent", anonymous: "authentication-required", bodyLimit: true},
		{path: "/api/billing/cancel", anonymous: "authentication-required", bodyLimit: true},
		{path: "/api/account/privacy-requests", anonymous: "authentication-required", bodyLimit: true},
		{path: "/api/account/privacy-requests/status", anonymous: "authentication-required", bodyLimit: true},
	}
	if fixture.profile == wholeRuntimeDeleteLive {
		routes = append(routes,
			struct {
				path      string
				anonymous string
				bodyLimit bool
			}{path: "/api/account/deletion", anonymous: "authentication-required", bodyLimit: true},
		)
	}
	if fixture.profile == wholeRuntimeDeleteLive {
		crossOrigin := map[string]string{
			"Content-Type":   "application/json",
			"Origin":         "https://attacker.invalid",
			"Sec-Fetch-Site": "same-origin",
		}
		response, body := mustWholeRuntimeHTTPWithHeaders(
			t, fixture, http.MethodPost, "/api/account/deletion/status", large, crossOrigin,
		)
		assertWholeRuntimeJSONError(t, "deletion resume cross-origin", response, body, http.StatusForbidden, "forbidden")
		response, body = mustWholeRuntimeHTTPWithHeaders(
			t, fixture, http.MethodPost, "/api/account/deletion/status", large,
			map[string]string{
				"Content-Type":   "application/json",
				"Origin":         fixture.origin,
				"Sec-Fetch-Site": "same-origin",
			},
		)
		assertWholeRuntimeJSONError(t, "deletion resume body limit", response, body, http.StatusRequestEntityTooLarge, "request-too-large")
	}
	for _, route := range routes {
		anonymous := map[string]string{
			"Content-Type":   "application/json",
			"Origin":         fixture.origin,
			"Sec-Fetch-Site": "same-origin",
		}
		response, body := mustWholeRuntimeHTTPWithHeaders(
			t, fixture, http.MethodPost, route.path, large, anonymous,
		)
		assertWholeRuntimeJSONError(t, route.path+" anonymous", response, body, http.StatusUnauthorized, route.anonymous)
		crossOrigin := wholeRuntimeHeaders(t, fixture, wholeRuntimeSessionAuth)
		crossOrigin["Origin"] = "https://attacker.invalid"
		response, body = mustWholeRuntimeHTTPWithHeaders(
			t, fixture, http.MethodPost, route.path, large, crossOrigin,
		)
		assertWholeRuntimeJSONError(t, route.path+" cross-origin", response, body, http.StatusForbidden, "forbidden")
		if route.bodyLimit {
			response, body = mustWholeRuntimeHTTP(
				t, fixture, http.MethodPost, route.path, large, wholeRuntimeSessionAuth,
			)
			assertWholeRuntimeJSONError(t, route.path+" body limit", response, body, http.StatusRequestEntityTooLarge, "request-too-large")
		}
	}
	foreignToken := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x7f}, 32))
	foreignHeaders := wholeRuntimeHeaders(t, fixture, wholeRuntimeSessionAuth)
	foreignHeaders["Cookie"] = identity.SessionCookieName + "=" + foreignToken
	foreignMutation := `{"version":"sync/v2","deviceId":"01999c20-9e33-7000-8000-000000000123","cursor":null,"mutations":[{"mutationId":"01999c20-9e33-7000-8000-000000000124","cardId":"01999c20-9e33-7000-8000-000000000125","baseServerRevision":null,"title":"foreign-owner-must-not-persist","body":[],"createdAt":1000,"updatedAt":1000,"kind":"upsert","conflictIds":[]}]}`
	response, body := mustWholeRuntimeHTTPWithHeaders(
		t, fixture, http.MethodPost, "/api/v2/sync", foreignMutation, foreignHeaders,
	)
	assertWholeRuntimeJSONError(t, "foreign-session sync", response, body, http.StatusUnauthorized, "authentication-required")
	response, body = mustWholeRuntimeHTTP(
		t, fixture, http.MethodPost, "/api/v2/sync",
		`{"version":"sync/v2","deviceId":"`+compositionDeviceB+`","cursor":null,"mutations":[]}`,
		wholeRuntimeSessionAuth,
	)
	assertWholeRuntimeSyncV2Response(t, fixture, response, body, 2)
}

func assertLocalFixtureLeaseExclusion(
	t *testing.T,
	fixture wholeRuntimeFixture,
	state *wholeRuntimeState,
) {
	t.Helper()
	before := wholeRuntimeTreeDigest(t, fixture.privateRoot)
	contenderValues := cloneWholeRuntimeValues(fixture.values)
	contenderAddress := wholeRuntimeFreeAddress(t)
	contenderValues["NOTES_HTTP_ADDR"] = contenderAddress
	contenderValues["NOTES_PUBLIC_ORIGIN"] = "http://" + contenderAddress
	contenderContext, cancelContender := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelContender()
	contender := exec.CommandContext(contenderContext, fixture.notesBinary)
	contender.Env = wholeRuntimeEnvironment(contenderValues)
	contenderOutput, contenderErr := contender.CombinedOutput()
	if contenderErr == nil || contenderContext.Err() != nil {
		t.Fatalf("second fixture runtime was not rejected promptly: %v", contenderErr)
	}
	assertWholeRuntimeExternalLogsRedacted(t, fixture, string(contenderOutput))
	if !strings.Contains(string(contenderOutput), "runtime unavailable") {
		t.Fatal("second fixture runtime failure was not generic")
	}

	prepareContext, cancelPrepare := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelPrepare()
	prepare := exec.CommandContext(
		prepareContext,
		fixture.notesctlBinary,
		"prepare-e2e",
		"--environment=test",
		"--allowed-subject="+wholeRuntimeOwner,
	)
	prepare.Env = wholeRuntimeEnvironment(fixture.values)
	prepareOutput, prepareErr := prepare.CombinedOutput()
	if prepareErr == nil || prepareContext.Err() != nil {
		t.Fatalf("notesctl prepare overlapped the runtime lease: %v", prepareErr)
	}
	assertWholeRuntimeExternalLogsRedacted(t, fixture, string(prepareOutput))
	if after := wholeRuntimeTreeDigest(t, fixture.privateRoot); after != before {
		t.Fatalf("lease contention changed fixture files: %s != %s", after, before)
	}
	response, body := mustWholeRuntimeHTTP(
		t, fixture, http.MethodPost, "/api/account/privacy-requests/status",
		`{"requestId":"`+state.privacyRequestID+`"}`, wholeRuntimeSessionAuth,
	)
	status := assertWholeRuntimePrivacyPending(t, "lease contention privacy status", response, body)
	if wholeRuntimeJSONString(t, status, "requestId") != state.privacyRequestID ||
		wholeRuntimeJSON(t, status) != state.privacyCanonical {
		t.Fatalf("lease contention changed durable journal = %q", body)
	}
}

func assertWholeRuntimeLogs(
	t *testing.T,
	fixture wholeRuntimeFixture,
	logs string,
	cycle int,
) {
	t.Helper()
	assertWholeRuntimeExternalLogsRedacted(t, fixture, logs)
	if !strings.Contains(logs, `"msg":"server starting"`) ||
		!strings.Contains(logs, `"msg":"server stopped"`) ||
		!strings.Contains(logs, `"reason":"shutdown"`) {
		t.Fatalf("%s cycle %d lacks lifecycle evidence", fixture.profile, cycle)
	}
}

func assertWholeRuntimeExternalLogsRedacted(
	t *testing.T,
	fixture wholeRuntimeFixture,
	logs string,
) {
	t.Helper()
	forbiddenValues := []string{
		fixture.databaseURL,
		fixture.sessionToken,
		fixture.cursorKey,
		fixture.deletionKey,
		fixture.ownerAssertion,
		fixture.foreignAssertion,
		fixture.privateRoot,
		fixture.staticRoot,
		wholeRuntimeTitle,
		"foreign-owner-must-not-persist",
		wholeRuntimeQueryCanary,
	}
	databaseURL, err := url.Parse(fixture.databaseURL)
	if err != nil {
		t.Fatalf("parse validated test database URL: %v", err)
	}
	if databaseURL.User != nil {
		forbiddenValues = append(forbiddenValues, databaseURL.User.Username())
		if password, present := databaseURL.User.Password(); present {
			forbiddenValues = append(forbiddenValues, password)
		}
	}
	for _, forbidden := range forbiddenValues {
		if forbidden != "" && strings.Contains(logs, forbidden) {
			t.Fatalf("%s log leaked a fixture secret or path", fixture.profile)
		}
	}
}

func assertWholeRuntimeLaunchResponse(
	t *testing.T,
	label string,
	response *http.Response,
	body string,
) {
	t.Helper()
	assertWholeRuntimeJSONHeaders(
		t, label, response, "private, no-store", "Cookie, X-Fukamu-Local-Identity-Assertion",
	)
	value := wholeRuntimeJSONObject(t, body)
	wholeRuntimeAssertExactKeys(
		t, label, value, "authenticated", "canAccess", "publicAccessEnabled", "userAllowed",
	)
	if response.StatusCode != http.StatusOK ||
		!wholeRuntimeJSONBool(t, value, "authenticated") ||
		!wholeRuntimeJSONBool(t, value, "canAccess") ||
		wholeRuntimeJSONBool(t, value, "publicAccessEnabled") ||
		!wholeRuntimeJSONBool(t, value, "userAllowed") {
		t.Fatalf("%s = %d %q", label, response.StatusCode, body)
	}
}

func assertWholeRuntimeLegacySyncResponse(
	t *testing.T,
	response *http.Response,
	body string,
	cycle int,
) {
	t.Helper()
	assertWholeRuntimeJSONHeaders(
		t, "legacy sync", response, "private, no-store", "Cookie, X-Fukamu-Local-Identity-Assertion",
	)
	value := wholeRuntimeJSONObject(t, body)
	wholeRuntimeAssertExactKeys(t, "legacy sync", value, "cards", "conflicts", "acknowledgedMutationIds")
	cards := wholeRuntimeJSONArray(t, value, "cards")
	conflicts := wholeRuntimeJSONArray(t, value, "conflicts")
	receipts := wholeRuntimeJSONArray(t, value, "acknowledgedMutationIds")
	if response.StatusCode != http.StatusOK || len(cards) != 1 || len(conflicts) != 0 {
		t.Fatalf("legacy sync cycle %d = %d %q", cycle, response.StatusCode, body)
	}
	card := wholeRuntimeJSONArrayObject(t, cards, 0, "legacy card")
	wholeRuntimeAssertExactKeys(
		t, "legacy card", card,
		"id", "officialDisplayId", "title", "body", "createdAt", "updatedAt", "revision",
	)
	if wholeRuntimeJSONString(t, card, "id") != compositionCardID ||
		wholeRuntimeJSONString(t, card, "title") != wholeRuntimeTitle ||
		wholeRuntimeJSONInteger(t, card, "officialDisplayId") != 1 ||
		wholeRuntimeJSONInteger(t, card, "createdAt") != 1_000 ||
		wholeRuntimeJSONInteger(t, card, "updatedAt") != 1_000 ||
		wholeRuntimeJSONInteger(t, card, "revision") != 1 ||
		len(wholeRuntimeJSONArray(t, card, "body")) != 0 {
		t.Fatalf("legacy card cycle %d = %q", cycle, body)
	}
	wantReceipts := 0
	if cycle == 1 {
		wantReceipts = 1
	}
	if len(receipts) != wantReceipts ||
		(wantReceipts == 1 && receipts[0] != compositionMutation) {
		t.Fatalf("legacy receipts cycle %d = %#v", cycle, receipts)
	}
}

func assertWholeRuntimeSyncV2Response(
	t *testing.T,
	fixture wholeRuntimeFixture,
	response *http.Response,
	body string,
	cycle int,
) {
	t.Helper()
	assertWholeRuntimeJSONHeaders(t, "Sync v2", response, "no-store", "")
	value := wholeRuntimeJSONObject(t, body)
	wholeRuntimeAssertExactKeys(t, "Sync v2", value, "version", "highWatermark", "changes", "receipts", "page")
	changes := wholeRuntimeJSONArray(t, value, "changes")
	receipts := wholeRuntimeJSONArray(t, value, "receipts")
	page := wholeRuntimeJSONNested(t, value, "page")
	wholeRuntimeAssertExactKeys(t, "Sync v2 page", page, "kind", "nextCursor")
	cursorSecret, err := base64.RawURLEncoding.DecodeString(fixture.cursorKey)
	if err != nil {
		t.Fatal(err)
	}
	authenticator, err := syncv2.NewCursorAuthenticator(cursorSecret)
	if err != nil {
		t.Fatal(err)
	}
	cursor := wholeRuntimeJSONString(t, page, "nextCursor")
	claims, err := authenticator.Verify(syncv2.Cursor(cursor))
	wantDevice := syncv2.DeviceID(compositionDeviceA)
	wantCursor := wholeRuntimeCursorA
	if cycle == 2 {
		wantDevice = syncv2.DeviceID(compositionDeviceB)
		wantCursor = wholeRuntimeCursorB
	}
	if response.StatusCode != http.StatusOK ||
		wholeRuntimeJSONString(t, value, "version") != "sync/v2" ||
		wholeRuntimeJSONInteger(t, value, "highWatermark") != 1 ||
		len(changes) != 1 ||
		wholeRuntimeJSONString(t, page, "kind") != "complete" ||
		cursor != wantCursor ||
		err != nil || claims.Version != syncv2.CursorVersion ||
		string(claims.VaultID) != compositionVaultID || claims.DeviceID != wantDevice ||
		claims.AfterSequence != 1 || claims.HighWatermark != 1 {
		t.Fatalf("Sync v2 cycle %d = %d %q", cycle, response.StatusCode, body)
	}
	change := wholeRuntimeJSONArrayObject(t, changes, 0, "Sync v2 change")
	wholeRuntimeAssertExactKeys(t, "Sync v2 change", change, "kind", "sequence", "card")
	card := wholeRuntimeJSONNested(t, change, "card")
	wholeRuntimeAssertExactKeys(
		t, "Sync v2 card", card,
		"id", "officialDisplayId", "title", "body", "createdAt", "updatedAt", "revision",
	)
	if wholeRuntimeJSONString(t, change, "kind") != "card-upsert" ||
		wholeRuntimeJSONInteger(t, change, "sequence") != 1 ||
		wholeRuntimeJSONString(t, card, "id") != compositionCardID ||
		wholeRuntimeJSONString(t, card, "title") != wholeRuntimeTitle ||
		wholeRuntimeJSONInteger(t, card, "officialDisplayId") != 1 ||
		wholeRuntimeJSONInteger(t, card, "createdAt") != 1_000 ||
		wholeRuntimeJSONInteger(t, card, "updatedAt") != 1_000 ||
		wholeRuntimeJSONInteger(t, card, "revision") != 1 ||
		len(wholeRuntimeJSONArray(t, card, "body")) != 0 {
		t.Fatalf("Sync v2 card cycle %d = %q", cycle, body)
	}
	wantReceipts := 0
	if cycle == 1 {
		wantReceipts = 1
	}
	if len(receipts) != wantReceipts {
		t.Fatalf("Sync v2 receipts cycle %d = %#v", cycle, receipts)
	}
	if wantReceipts == 1 {
		receipt := wholeRuntimeJSONArrayObject(t, receipts, 0, "Sync v2 receipt")
		wholeRuntimeAssertExactKeys(t, "Sync v2 receipt", receipt, "mutationId", "cardId", "appliedRevision")
		if wholeRuntimeJSONString(t, receipt, "mutationId") != compositionMutation ||
			wholeRuntimeJSONString(t, receipt, "cardId") != compositionCardID ||
			wholeRuntimeJSONInteger(t, receipt, "appliedRevision") != 1 {
			t.Fatalf("Sync v2 receipt = %#v", receipt)
		}
	}
}

func assertWholeRuntimeSessionContext(
	t *testing.T,
	response *http.Response,
	body string,
	wantDeletionAvailable bool,
) {
	t.Helper()
	assertWholeRuntimeJSONHeaders(t, "session context", response, "private, no-store", "Cookie")
	value := wholeRuntimeJSONObject(t, body)
	wholeRuntimeAssertExactKeys(
		t, "session context", value,
		"accountId", "vaultId", "sessionId", "sessionEpoch", "accountDeletionAvailable",
	)
	if response.StatusCode != http.StatusOK ||
		wholeRuntimeJSONString(t, value, "accountId") != compositionAccountID ||
		wholeRuntimeJSONString(t, value, "vaultId") != compositionVaultID ||
		wholeRuntimeJSONString(t, value, "sessionId") != compositionSessionID ||
		wholeRuntimeJSONInteger(t, value, "sessionEpoch") != 1 ||
		wholeRuntimeJSONBool(t, value, "accountDeletionAvailable") != wantDeletionAvailable {
		t.Fatalf("session context = %d %q", response.StatusCode, body)
	}
}

func assertWholeRuntimeOffer(t *testing.T, response *http.Response, root map[string]any) {
	t.Helper()
	assertWholeRuntimeJSONHeaders(t, "checkout offer", response, "no-store", "")
	wholeRuntimeAssertExactKeys(t, "checkout offer", root, "offer", "offerHash")
	offer := wholeRuntimeJSONNested(t, root, "offer")
	wholeRuntimeAssertExactKeys(
		t, "checkout offer snapshot", offer,
		"schemaVersion", "offerVersion", "disclosureVersion", "serviceName", "quantity", "planName",
		"priceYen", "billingPeriod", "taxIncluded", "trialDays", "trialPriceYen", "firstChargeDay",
		"renewalChargeYen", "annualEstimateYen", "automaticRenewal", "paymentMethod", "serviceStart",
		"servicePeriod", "cancellationPolicy", "refundPolicy", "additionalFees", "onlineLockPolicy",
		"cancellationSeparateFromAccountDeletion",
	)
	if response.StatusCode != http.StatusOK ||
		wholeRuntimeJSONString(t, root, "offerHash") != wholeRuntimeOfferHash ||
		wholeRuntimeJSONInteger(t, offer, "schemaVersion") != 1 ||
		wholeRuntimeJSONString(t, offer, "offerVersion") != "legal-commerce-v1:2026-09-15" ||
		wholeRuntimeJSONString(t, offer, "disclosureVersion") != "2026-09-15" ||
		wholeRuntimeJSONString(t, offer, "serviceName") != "FUKAMU Notes" ||
		wholeRuntimeJSONString(t, offer, "quantity") != "one-personal-vault" ||
		wholeRuntimeJSONString(t, offer, "planName") != "FUKAMU Notes 月額プラン" ||
		wholeRuntimeJSONInteger(t, offer, "priceYen") != 980 ||
		wholeRuntimeJSONString(t, offer, "billingPeriod") != "monthly" ||
		!wholeRuntimeJSONBool(t, offer, "taxIncluded") ||
		wholeRuntimeJSONInteger(t, offer, "trialDays") != 14 ||
		wholeRuntimeJSONInteger(t, offer, "trialPriceYen") != 0 ||
		wholeRuntimeJSONInteger(t, offer, "firstChargeDay") != 15 ||
		wholeRuntimeJSONInteger(t, offer, "renewalChargeYen") != 980 ||
		wholeRuntimeJSONInteger(t, offer, "annualEstimateYen") != 11_760 ||
		!wholeRuntimeJSONBool(t, offer, "automaticRenewal") ||
		wholeRuntimeJSONString(t, offer, "paymentMethod") != "credit-card" ||
		wholeRuntimeJSONString(t, offer, "serviceStart") != "after-registration-and-payment-method-confirmation" ||
		wholeRuntimeJSONString(t, offer, "servicePeriod") != "indefinite-until-cancelled" ||
		wholeRuntimeJSONString(t, offer, "cancellationPolicy") != wholeRuntimeCancellationPolicy ||
		wholeRuntimeJSONString(t, offer, "refundPolicy") != wholeRuntimeRefundPolicy ||
		wholeRuntimeJSONString(t, offer, "additionalFees") != wholeRuntimeAdditionalFees ||
		wholeRuntimeJSONString(t, offer, "onlineLockPolicy") != "immediate-on-payment-failure-or-action-required" ||
		!wholeRuntimeJSONBool(t, offer, "cancellationSeparateFromAccountDeletion") {
		t.Fatalf("checkout offer = %#v", root)
	}
}

func assertWholeRuntimeTermsStatus(t *testing.T, status map[string]any, accepted bool) {
	t.Helper()
	keys := []string{"kind", "acceptanceRequired", "current"}
	if accepted {
		keys = append(keys, "accepted")
	}
	wholeRuntimeAssertExactKeys(t, "terms status body", status, keys...)
	current := wholeRuntimeJSONNested(t, status, "current")
	wholeRuntimeAssertExactKeys(t, "current terms", current, "termsVersion", "termsHash", "effectiveDate")
	if wholeRuntimeJSONString(t, current, "termsVersion") != "terms-v1:2026-09-15" ||
		wholeRuntimeJSONString(t, current, "termsHash") != wholeRuntimeTermsHash ||
		wholeRuntimeJSONString(t, current, "effectiveDate") != "2026-09-15" ||
		wholeRuntimeJSONBool(t, status, "acceptanceRequired") == accepted {
		t.Fatalf("terms status = %#v", status)
	}
	if accepted {
		if wholeRuntimeJSONString(t, status, "kind") != "accepted" {
			t.Fatalf("accepted terms kind = %#v", status)
		}
		acceptedValue := wholeRuntimeJSONNested(t, status, "accepted")
		wholeRuntimeAssertExactKeys(t, "accepted terms", acceptedValue, "consentId", "termsVersion", "termsHash", "acceptedAt")
		if !wholeRuntimeUUIDV7Pattern.MatchString(wholeRuntimeJSONString(t, acceptedValue, "consentId")) ||
			wholeRuntimeJSONString(t, acceptedValue, "termsVersion") != wholeRuntimeJSONString(t, current, "termsVersion") ||
			wholeRuntimeJSONString(t, acceptedValue, "termsHash") != wholeRuntimeJSONString(t, current, "termsHash") ||
			wholeRuntimeJSONInteger(t, acceptedValue, "acceptedAt") <= 0 {
			t.Fatalf("accepted terms = %#v", acceptedValue)
		}
	} else if wholeRuntimeJSONString(t, status, "kind") != "current" {
		t.Fatalf("current terms kind = %#v", status)
	}
}

func assertWholeRuntimeDurableTerms(
	t *testing.T,
	state *wholeRuntimeState,
	accepted map[string]any,
) {
	t.Helper()
	if state.termsConsentID == "" || state.termsAcceptedAt <= 0 ||
		wholeRuntimeJSONString(t, accepted, "consentId") != state.termsConsentID ||
		wholeRuntimeJSONInteger(t, accepted, "acceptedAt") != state.termsAcceptedAt {
		t.Fatalf("terms acceptance changed across restart: %#v", accepted)
	}
}

func assertWholeRuntimePrivacyPending(
	t *testing.T,
	label string,
	response *http.Response,
	body string,
) map[string]any {
	t.Helper()
	assertWholeRuntimeJSONHeaders(t, label, response, "no-store", "")
	value := wholeRuntimeJSONObject(t, body)
	wholeRuntimeAssertExactKeys(
		t, label, value, "requestId", "requestKind", "requestedAt", "updatedAt", "status",
	)
	requestedAt := wholeRuntimeJSONInteger(t, value, "requestedAt")
	if response.StatusCode != http.StatusAccepted ||
		!wholeRuntimeUUIDV7Pattern.MatchString(wholeRuntimeJSONString(t, value, "requestId")) ||
		wholeRuntimeJSONString(t, value, "requestKind") != "disclosure" ||
		requestedAt <= 0 || wholeRuntimeJSONInteger(t, value, "updatedAt") != requestedAt ||
		wholeRuntimeJSONString(t, value, "status") != "verification-pending" {
		t.Fatalf("%s = %d %q", label, response.StatusCode, body)
	}
	return value
}

func assertWholeRuntimeJSONHeaders(
	t *testing.T,
	label string,
	response *http.Response,
	wantCacheControl string,
	wantVary string,
) {
	t.Helper()
	if response.Header.Get("Content-Type") != "application/json; charset=utf-8" ||
		response.Header.Get("Cache-Control") != wantCacheControl ||
		response.Header.Get("X-Content-Type-Options") != "nosniff" ||
		response.Header.Get("Vary") != wantVary {
		t.Fatalf("%s response headers = %#v", label, response.Header)
	}
}

func assertWholeRuntimeStaticHTMLHeaders(t *testing.T, label string, response *http.Response) {
	t.Helper()
	if response.Header.Get("Content-Type") != "text/html; charset=utf-8" ||
		response.Header.Get("Cache-Control") != "no-store" ||
		response.Header.Get("Content-Security-Policy") != wholeRuntimeCSP ||
		response.Header.Get("Permissions-Policy") != "camera=(), geolocation=(), microphone=()" ||
		response.Header.Get("Referrer-Policy") != "no-referrer" ||
		response.Header.Get("X-Content-Type-Options") != "nosniff" ||
		response.Header.Get("Cross-Origin-Opener-Policy") != "same-origin" ||
		response.Header.Get("X-Frame-Options") != "DENY" {
		t.Fatalf("%s static response headers = %#v", label, response.Header)
	}
}

func assertWholeRuntimeStaticAssetHeaders(t *testing.T, label string, response *http.Response) {
	t.Helper()
	if response.Header.Get("Content-Type") != "text/javascript; charset=utf-8" ||
		response.Header.Get("Cache-Control") != "public, max-age=31536000, immutable" ||
		response.Header.Get("Content-Security-Policy") != wholeRuntimeCSP ||
		response.Header.Get("Permissions-Policy") != "camera=(), geolocation=(), microphone=()" ||
		response.Header.Get("Referrer-Policy") != "no-referrer" ||
		response.Header.Get("X-Content-Type-Options") != "nosniff" ||
		response.Header.Get("Cross-Origin-Opener-Policy") != "" ||
		response.Header.Get("X-Frame-Options") != "" {
		t.Fatalf("%s static asset response headers = %#v", label, response.Header)
	}
}

func assertWholeRuntimeJSONError(
	t *testing.T,
	label string,
	response *http.Response,
	body string,
	wantStatus int,
	wantCode string,
) {
	t.Helper()
	assertWholeRuntimeJSONHeaders(t, label, response, "no-store", "")
	wantBody := `{"error":"` + wantCode + `"}`
	if response.StatusCode != wantStatus || strings.TrimSpace(body) != wantBody {
		t.Fatalf("%s = %d %q, want %d %q", label, response.StatusCode, body, wantStatus, wantBody)
	}
}

func assertWholeRuntimePrivateJSONError(
	t *testing.T,
	label string,
	response *http.Response,
	body string,
	wantStatus int,
	wantCode string,
) {
	t.Helper()
	assertWholeRuntimeJSONHeaders(
		t, label, response, "private, no-store", "Cookie, X-Fukamu-Local-Identity-Assertion",
	)
	wantBody := `{"error":"` + wantCode + `"}`
	if response.StatusCode != wantStatus || strings.TrimSpace(body) != wantBody {
		t.Fatalf("%s = %d %q, want %d %q", label, response.StatusCode, body, wantStatus, wantBody)
	}
}

func assertWholeRuntimeJSONCode(
	t *testing.T,
	label string,
	response *http.Response,
	body string,
	wantStatus int,
	wantCode string,
) {
	t.Helper()
	assertWholeRuntimeJSONHeaders(t, label, response, "no-store", "")
	wantBody := `{"code":"` + wantCode + `"}`
	if response.StatusCode != wantStatus || strings.TrimSpace(body) != wantBody {
		t.Fatalf("%s = %d %q, want %d %q", label, response.StatusCode, body, wantStatus, wantBody)
	}
}

func assertWholeRuntimeEncryptedObject(
	t *testing.T,
	fixture wholeRuntimeFixture,
	requestPlaintext string,
) {
	t.Helper()
	layout, err := localfixtureadapter.OpenLayout(fixture.privateRoot)
	if err != nil {
		t.Fatalf("open guarded fixture layout: %v", err)
	}
	entries, err := os.ReadDir(layout.ObjectDirectory)
	if err != nil {
		t.Fatalf("read guarded object directory: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("guarded object count = %d, want 1", len(entries))
	}
	entry := entries[0]
	info, err := entry.Info()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		t.Fatalf("guarded object metadata is not an exact private regular file")
	}
	encoded, err := os.ReadFile(filepath.Join(layout.ObjectDirectory, entry.Name()))
	if err != nil {
		t.Fatalf("read guarded object: %v", err)
	}
	if !bytes.Contains(encoded, []byte(`"sealedPayload"`)) ||
		bytes.Contains(encoded, []byte(wholeRuntimeTitle)) ||
		bytes.Contains(encoded, []byte(requestPlaintext)) {
		t.Fatal("guarded object is not a sealed envelope or contains request plaintext")
	}
}

func mustWholeRuntimeHTTP(
	t *testing.T,
	fixture wholeRuntimeFixture,
	method string,
	requestPath string,
	body string,
	auth wholeRuntimeAuth,
) (*http.Response, string) {
	t.Helper()
	return mustWholeRuntimeHTTPWithHeaders(
		t,
		fixture,
		method,
		requestPath,
		body,
		wholeRuntimeHeaders(t, fixture, auth),
	)
}

func mustWholeRuntimeHTTPWithHeaders(
	t *testing.T,
	fixture wholeRuntimeFixture,
	method string,
	requestPath string,
	body string,
	headers map[string]string,
) (*http.Response, string) {
	t.Helper()
	request, err := http.NewRequest(
		method,
		fixture.origin+requestPath,
		strings.NewReader(body),
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Close = true
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		t.Fatalf("%s %s: %v", method, requestPath, err)
	}
	content, readErr := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil {
		t.Fatalf("read %s %s: %v / %v", method, requestPath, readErr, closeErr)
	}
	return response, string(content)
}

func wholeRuntimeHTTP(
	t *testing.T,
	fixture wholeRuntimeFixture,
	method string,
	requestPath string,
	body string,
	auth wholeRuntimeAuth,
) (*http.Response, error) {
	t.Helper()
	request, err := http.NewRequest(method, fixture.origin+requestPath, strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Close = true
	for key, value := range wholeRuntimeHeaders(t, fixture, auth) {
		request.Header.Set(key, value)
	}
	return (&http.Client{Timeout: 250 * time.Millisecond}).Do(request)
}

func wholeRuntimeHeaders(
	t *testing.T,
	fixture wholeRuntimeFixture,
	auth wholeRuntimeAuth,
) map[string]string {
	t.Helper()
	headers := map[string]string{}
	if auth == wholeRuntimeNoAuth {
		return headers
	}
	headers["Origin"] = fixture.origin
	if auth == wholeRuntimeSessionAuth {
		headers["Content-Type"] = "application/json"
		headers["Sec-Fetch-Site"] = "same-origin"
		headers["Cookie"] = identity.SessionCookieName + "=" + fixture.sessionToken
		return headers
	}
	owner, err := access.ParseSubject(wholeRuntimeOwner)
	if err != nil {
		t.Fatal(err)
	}
	for key, value := range wholeRuntimeAssertionHeaders(t, fixture, string(owner)) {
		headers[key] = value
	}
	return headers
}

func wholeRuntimeAssertionHeaders(
	t *testing.T,
	fixture wholeRuntimeFixture,
	subjectValue string,
) map[string]string {
	t.Helper()
	assertion := ""
	switch subjectValue {
	case wholeRuntimeOwner:
		assertion = fixture.ownerAssertion
	case "runtime-closure-other-owner":
		assertion = fixture.foreignAssertion
	default:
		t.Fatalf("unsupported whole-runtime assertion subject %q", subjectValue)
	}
	return map[string]string{
		"Content-Type":                     "application/json",
		"Origin":                           fixture.origin,
		accessadapter.LocalAssertionHeader: assertion,
	}
}

func wholeRuntimeSignedAssertion(
	t *testing.T,
	privateKey ed25519.PrivateKey,
	subjectValue string,
) string {
	t.Helper()
	subject, err := access.ParseSubject(subjectValue)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	assertion, err := accessadapter.SignLocalAssertion(
		privateKey,
		wholeRuntimeIssuer,
		wholeRuntimeAudience,
		subject,
		now.Add(-30*time.Second),
		now.Add(5*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	return assertion
}

func wholeRuntimeJSON(t *testing.T, value any) string {
	t.Helper()
	content, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

func wholeRuntimeJSONObject(t *testing.T, content string) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal([]byte(content), &value); err != nil {
		t.Fatalf("decode whole-runtime response: %v", err)
	}
	return value
}

func wholeRuntimeJSONNested(
	t *testing.T,
	value map[string]any,
	key string,
) map[string]any {
	t.Helper()
	nested, ok := value[key].(map[string]any)
	if !ok {
		t.Fatalf("whole-runtime response %s is not an object", key)
	}
	return nested
}

func wholeRuntimeJSONArray(t *testing.T, value map[string]any, key string) []any {
	t.Helper()
	items, ok := value[key].([]any)
	if !ok {
		t.Fatalf("whole-runtime response %s is not an array", key)
	}
	return items
}

func wholeRuntimeJSONArrayObject(
	t *testing.T,
	items []any,
	index int,
	label string,
) map[string]any {
	t.Helper()
	if index < 0 || index >= len(items) {
		t.Fatalf("%s index %d is out of bounds", label, index)
	}
	value, ok := items[index].(map[string]any)
	if !ok {
		t.Fatalf("%s is not an object", label)
	}
	return value
}

func wholeRuntimeAssertExactKeys(
	t *testing.T,
	label string,
	value map[string]any,
	want ...string,
) {
	t.Helper()
	got := make([]string, 0, len(value))
	for key := range value {
		got = append(got, key)
	}
	sort.Strings(got)
	wantCopy := append([]string(nil), want...)
	sort.Strings(wantCopy)
	if len(got) != len(wantCopy) {
		t.Fatalf("%s keys = %v, want %v", label, got, wantCopy)
	}
	for index := range got {
		if got[index] != wantCopy[index] {
			t.Fatalf("%s keys = %v, want %v", label, got, wantCopy)
		}
	}
}

func wholeRuntimeJSONString(t *testing.T, value map[string]any, key string) string {
	t.Helper()
	text, ok := value[key].(string)
	if !ok || text == "" {
		t.Fatalf("whole-runtime response %s is not a non-empty string", key)
	}
	return text
}

func wholeRuntimeJSONInteger(t *testing.T, value map[string]any, key string) int64 {
	t.Helper()
	number, ok := value[key].(float64)
	if !ok || number < 0 || number > float64(identity.MaximumSafeInteger) || number != float64(int64(number)) {
		t.Fatalf("whole-runtime response %s is not a safe non-negative integer", key)
	}
	return int64(number)
}

func wholeRuntimeJSONBool(t *testing.T, value map[string]any, key string) bool {
	t.Helper()
	boolean, ok := value[key].(bool)
	if !ok {
		t.Fatalf("whole-runtime response %s is not a boolean", key)
	}
	return boolean
}

func wholeRuntimeTreeDigest(t *testing.T, root string) string {
	t.Helper()
	hash := sha256.New()
	var names []string
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("fixture tree contains a symlink")
		}
		names = append(names, path)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	sort.Strings(names)
	for _, name := range names {
		relative, err := filepath.Rel(root, name)
		if err != nil {
			t.Fatal(err)
		}
		info, err := os.Lstat(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = fmt.Fprintf(hash, "%s\x00%o\x00%d\x00", filepath.ToSlash(relative), info.Mode(), info.Size())
		if info.Mode().IsRegular() {
			content, err := os.ReadFile(name)
			if err != nil {
				t.Fatal(err)
			}
			_, _ = hash.Write(content)
		}
		_, _ = hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func cloneWholeRuntimeValues(values map[string]string) map[string]string {
	result := make(map[string]string, len(values))
	for key, value := range values {
		result[key] = value
	}
	return result
}

func wholeRuntimeEnvironment(values map[string]string) []string {
	result := make([]string, 0, len(os.Environ())+len(values))
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "NOTES_") || strings.HasPrefix(key, "FUKAMU_") {
			continue
		}
		result = append(result, entry)
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		result = append(result, key+"="+values[key])
	}
	return result
}

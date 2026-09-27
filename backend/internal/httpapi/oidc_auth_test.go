package httpapi_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/notes/backend/internal/access"
	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/launchgate"
)

type oidcHTTPClock int64

func (clock oidcHTTPClock) NowEpochSeconds() int64 { return int64(clock) }

type oidcHTTPSecrets struct{}

func (oidcHTTPSecrets) CreateState(context.Context) (string, error) {
	return strings.Repeat("S", 42) + "A", nil
}
func (oidcHTTPSecrets) CreateNonce(context.Context) (string, error) {
	return strings.Repeat("N", 42) + "A", nil
}
func (oidcHTTPSecrets) CreateCodeVerifier(context.Context) (string, error) {
	return strings.Repeat("V", 43), nil
}

type oidcHTTPPKCE struct{}

func (oidcHTTPPKCE) DeriveS256(identity.PkceCodeVerifier) (string, error) {
	return strings.Repeat("C", 42) + "A", nil
}

type oidcHTTPTransactions struct {
	pending *identity.PendingOidcTransaction
}

func (store *oidcHTTPTransactions) InsertPending(_ context.Context, value identity.PendingOidcTransaction) error {
	copy := value
	store.pending = &copy
	return nil
}
func (store *oidcHTTPTransactions) ConsumeByState(_ context.Context, state identity.OidcState) (*identity.PendingOidcTransaction, error) {
	if store.pending == nil || store.pending.State != state {
		return nil, nil
	}
	value := *store.pending
	store.pending = nil
	return &value, nil
}

type oidcHTTPProvider struct{ claims identity.RawOidcClaims }

func (provider oidcHTTPProvider) ExchangeCodeForVerifiedClaims(context.Context, identity.OidcCodeExchangeInput) (identity.RawOidcClaims, error) {
	return provider.claims, nil
}

type oidcHTTPIdentities struct{ record *identity.OidcIdentityRecord }

func (directory oidcHTTPIdentities) FindByIssuerSubject(context.Context, identity.OidcIdentityKey) (*identity.OidcIdentityRecord, error) {
	return directory.record, nil
}
func (oidcHTTPIdentities) FindAccountIDByVerifiedEmail(context.Context, identity.VerifiedEmailAddress) (*identity.AccountID, error) {
	return nil, nil
}

type oidcHTTPGate struct{ allowed bool }

func (gate oidcHTTPGate) Read(_ context.Context, subject *access.Subject) (launchgate.Facts, error) {
	return launchgate.Facts{UserAllowed: gate.allowed && subject != nil && *subject == "google-subject"}, nil
}

type oidcHTTPSessions struct{ session *identity.Session }

func (sessions *oidcHTTPSessions) FindSessionByToken(context.Context, identity.SessionToken) (*identity.Session, error) {
	return sessions.session, nil
}

type oidcHTTPSessionStore struct {
	sessions  *oidcHTTPSessions
	created   int
	loggedOut int
}

func (store *oidcHTTPSessionStore) CreateOidcSession(
	_ context.Context,
	session identity.Session,
	_ identity.SessionToken,
	_ identity.IdentityID,
) error {
	store.created++
	copy := session
	store.sessions.session = &copy
	return nil
}
func (store *oidcHTTPSessionStore) LogoutSession(
	_ context.Context,
	_ identity.VaultContext,
	_ identity.SessionToken,
	_ int64,
) error {
	store.loggedOut++
	return nil
}

type oidcHTTPIdentifiers struct{}

func (oidcHTTPIdentifiers) CreateSessionID(context.Context) (string, error) {
	return "01999c20-9e33-7000-8000-000000000303", nil
}
func (oidcHTTPIdentifiers) CreateSessionToken(context.Context) (string, error) {
	return strings.Repeat("T", 42) + "A", nil
}

func TestProductionOidcHTTPFlowRequiresPreprovisionedAllowedIdentity(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		allowed    bool
		wantStatus int
		wantCreate int
	}{
		{name: "allowed", allowed: true, wantStatus: http.StatusSeeOther, wantCreate: 1},
		{name: "not allowlisted", allowed: false, wantStatus: http.StatusForbidden},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			handler, runtime, sessions := newOidcHTTPHandler(t, test.allowed)
			start := httptest.NewRecorder()
			handler.ServeHTTP(start, httptest.NewRequest(http.MethodGet, "/auth/google/start", nil))
			if start.Code != http.StatusFound ||
				!strings.HasPrefix(start.Header().Get("Location"), "https://accounts.google.com/o/oauth2/v2/auth?") ||
				runtime.Transactions.(*oidcHTTPTransactions).pending == nil {
				t.Fatalf("start = %d %q", start.Code, start.Header().Get("Location"))
			}
			callback := httptest.NewRecorder()
			state := strings.Repeat("S", 42) + "A"
			handler.ServeHTTP(callback, httptest.NewRequest(http.MethodGet,
				"/auth/google/callback?state="+state+"&code=authorization-code", nil))
			if callback.Code != test.wantStatus || sessions.created != test.wantCreate {
				t.Fatalf("callback = %d %q created=%d", callback.Code, callback.Body.String(), sessions.created)
			}
			if test.allowed {
				if callback.Header().Get("Location") != "/" ||
					!strings.Contains(callback.Header().Get("Set-Cookie"), identity.SessionCookieName+"=") ||
					!strings.Contains(callback.Header().Get("Set-Cookie"), "Secure; HttpOnly; SameSite=Strict") {
					t.Fatalf("callback headers = %v", callback.Header())
				}
				replay := httptest.NewRecorder()
				handler.ServeHTTP(replay, httptest.NewRequest(http.MethodGet,
					"/auth/google/callback?state="+state+"&code=authorization-code", nil))
				if replay.Code != http.StatusForbidden || sessions.created != 1 {
					t.Fatalf("callback replay = %d created=%d", replay.Code, sessions.created)
				}
			}
		})
	}
}

func TestProductionOidcLogoutRequiresSameOriginAndRevokesServerSession(t *testing.T) {
	t.Parallel()
	handler, _, store := newOidcHTTPHandler(t, true)
	session := identity.CreateActiveSession(identity.SessionInput{
		SessionID: "01999c20-9e33-7000-8000-000000000303",
		AccountID: "01999c20-9e33-7000-8000-000000000101",
		VaultID:   "01999c20-9e33-7000-8000-000000000202", SessionEpoch: 1,
		IssuedAt: 1_500_000, ExpiresAt: 2_000_000,
	})
	store.sessions.session = &session.Session

	denied := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/auth/logout", nil)
	request.Header.Set("Cookie", identity.SessionCookieName+"="+strings.Repeat("T", 42)+"A")
	request.Header.Set("Origin", "https://attacker.example")
	request.Header.Set("Sec-Fetch-Site", "cross-site")
	handler.ServeHTTP(denied, request)
	if denied.Code != http.StatusForbidden || store.loggedOut != 0 {
		t.Fatalf("cross-origin logout = %d calls=%d", denied.Code, store.loggedOut)
	}

	allowed := httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "/auth/logout", nil)
	request.Header.Set("Cookie", identity.SessionCookieName+"="+strings.Repeat("T", 42)+"A")
	request.Header.Set("Origin", "https://notes.example")
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	handler.ServeHTTP(allowed, request)
	if allowed.Code != http.StatusNoContent || store.loggedOut != 1 ||
		allowed.Header().Get("Set-Cookie") != identity.ClearSessionCookie() {
		t.Fatalf("logout = %d calls=%d headers=%v", allowed.Code, store.loggedOut, allowed.Header())
	}
}

func newOidcHTTPHandler(
	t *testing.T,
	allowed bool,
) (http.Handler, *httpapi.OidcAuthRuntime, *oidcHTTPSessionStore) {
	t.Helper()
	issuer, _ := identity.ParseOidcIssuer("https://accounts.google.com")
	subject, _ := identity.ParseOidcSubject("google-subject")
	clientID, _ := identity.ParseOidcClientID("notes.apps.googleusercontent.com")
	endpoint, _ := identity.ParseOidcAuthorizationEndpoint("https://accounts.google.com/o/oauth2/v2/auth")
	redirect, _ := identity.ParseOidcRedirectURI("https://notes.example/auth/google/callback")
	origin, _ := url.Parse("https://notes.example")
	record := &identity.OidcIdentityRecord{
		IdentityID: "01999c20-9e33-7000-8000-000000000404",
		AccountID:  "01999c20-9e33-7000-8000-000000000101",
		VaultID:    "01999c20-9e33-7000-8000-000000000202",
		Issuer:     issuer, Subject: subject,
	}
	transactions := &oidcHTTPTransactions{}
	sessionResolver := &oidcHTTPSessions{}
	sessionStore := &oidcHTTPSessionStore{sessions: sessionResolver}
	runtime := &httpapi.OidcAuthRuntime{
		Configuration: identity.OidcProviderConfiguration{
			AuthorizationEndpoint: endpoint, ClientID: clientID,
			AllowedIssuers: []identity.OidcIssuer{issuer}, RedirectURIs: []identity.OidcRedirectURI{redirect},
		},
		RedirectURI: redirect, PublicOrigin: origin, Clock: oidcHTTPClock(1_500),
		Now:     func() time.Time { return time.UnixMilli(1_500_000) },
		Secrets: oidcHTTPSecrets{}, PKCE: oidcHTTPPKCE{}, Transactions: transactions,
		Provider: oidcHTTPProvider{claims: identity.RawOidcClaims{
			Issuer: string(issuer), Subject: string(subject), Audience: []string{string(clientID)},
			AuthorizedParty: string(clientID), ExpiresAt: 2_000, IssuedAt: 1_400,
			Nonce: strings.Repeat("N", 42) + "A", Email: "person@example.com", EmailVerified: true,
		}},
		Identities: oidcHTTPIdentities{record: record}, Gate: oidcHTTPGate{allowed: allowed},
		Sessions: sessionResolver, SessionStore: sessionStore, Identifiers: oidcHTTPIdentifiers{},
	}
	staticDirectory := t.TempDir()
	writeStaticFixture(t, staticDirectory)
	handler, err := httpapi.NewHandler(httpapi.HandlerOptions{
		StaticDirectory: staticDirectory, BodyLimit: 4_000_000,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), OidcAuthRuntime: runtime,
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler, runtime, sessionStore
}

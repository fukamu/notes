package oidcadapter

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fukamu/notes/backend/internal/identity"
)

const (
	testClientID     = "fukamu-test.apps.googleusercontent.com"
	testClientSecret = "local-test-client-secret"
	testRedirectURI  = "https://notes.example/auth/google/callback"
	testCode         = "local-authorization-code"
	testVerifier     = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	testNonce        = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA"
)

type localProvider struct {
	server       *httptest.Server
	key          *rsa.PrivateKey
	wrongKey     *rsa.PrivateKey
	mu           sync.Mutex
	lastForm     url.Values
	badSignature bool
	missingToken bool
	audience     string
}

type discoveryDocument struct {
	Issuer                            string   `json:"issuer"`
	AuthorizationEndpoint             string   `json:"authorization_endpoint"`
	TokenEndpoint                     string   `json:"token_endpoint"`
	JWKSURI                           string   `json:"jwks_uri"`
	ResponseTypesSupported            []string `json:"response_types_supported"`
	SubjectTypesSupported             []string `json:"subject_types_supported"`
	IDTokenSigningAlgorithmsSupported []string `json:"id_token_signing_alg_values_supported"`
	TokenEndpointAuthMethodsSupported []string `json:"token_endpoint_auth_methods_supported"`
}

type jsonWebKey struct {
	KeyType   string `json:"kty"`
	Use       string `json:"use"`
	Algorithm string `json:"alg"`
	KeyID     string `json:"kid"`
	Modulus   string `json:"n"`
	Exponent  string `json:"e"`
}

type jsonWebKeySet struct {
	Keys []jsonWebKey `json:"keys"`
}

type tokenResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int64  `json:"expires_in"`
	IDToken     string `json:"id_token,omitempty"`
}

type jwtHeader struct {
	Algorithm string `json:"alg"`
	KeyID     string `json:"kid"`
	Type      string `json:"typ"`
}

type jwtClaims struct {
	Issuer        string `json:"iss"`
	Subject       string `json:"sub"`
	Audience      string `json:"aud"`
	ExpiresAt     int64  `json:"exp"`
	IssuedAt      int64  `json:"iat"`
	Nonce         string `json:"nonce"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
}

func newLocalProvider(t *testing.T) *localProvider {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2_048)
	if err != nil {
		t.Fatal(err)
	}
	wrongKey, err := rsa.GenerateKey(rand.Reader, 2_048)
	if err != nil {
		t.Fatal(err)
	}
	provider := &localProvider{key: key, wrongKey: wrongKey, audience: testClientID}
	provider.server = httptest.NewTLSServer(http.HandlerFunc(provider.serveHTTP))
	t.Cleanup(provider.server.Close)
	return provider
}

func (provider *localProvider) serveHTTP(response http.ResponseWriter, request *http.Request) {
	switch request.URL.Path {
	case "/.well-known/openid-configuration":
		writeJSON(response, marshalJSON(discoveryDocument{
			Issuer:                            provider.server.URL,
			AuthorizationEndpoint:             provider.server.URL + "/authorize",
			TokenEndpoint:                     provider.server.URL + "/token",
			JWKSURI:                           provider.server.URL + "/keys",
			ResponseTypesSupported:            []string{"code"},
			SubjectTypesSupported:             []string{"public"},
			IDTokenSigningAlgorithmsSupported: []string{"RS256"},
			TokenEndpointAuthMethodsSupported: []string{"client_secret_basic", "client_secret_post"},
		}))
	case "/keys":
		writeJSON(response, marshalJSON(jsonWebKeySet{Keys: []jsonWebKey{jwkFor(&provider.key.PublicKey)}}))
	case "/token":
		provider.serveToken(response, request)
	default:
		http.NotFound(response, request)
	}
}

func (provider *localProvider) serveToken(response http.ResponseWriter, request *http.Request) {
	if err := request.ParseForm(); err != nil {
		http.Error(response, "bad form", http.StatusBadRequest)
		return
	}
	provider.mu.Lock()
	provider.lastForm = cloneValues(request.Form)
	badSignature := provider.badSignature
	missingToken := provider.missingToken
	audience := provider.audience
	provider.mu.Unlock()
	clientID, clientSecret, hasBasic := request.BasicAuth()
	if !hasBasic {
		clientID = request.Form.Get("client_id")
		clientSecret = request.Form.Get("client_secret")
	}
	if request.Form.Get("grant_type") != "authorization_code" || request.Form.Get("code") != testCode ||
		request.Form.Get("redirect_uri") != testRedirectURI || request.Form.Get("code_verifier") != testVerifier ||
		clientID != testClientID || clientSecret != testClientSecret {
		http.Error(response, "invalid exchange", http.StatusBadRequest)
		return
	}
	responseValue := tokenResponse{
		AccessToken: "local-access-token", TokenType: "Bearer", ExpiresIn: 3_600,
	}
	if !missingToken {
		signingKey := provider.key
		if badSignature {
			signingKey = provider.wrongKey
		}
		responseValue.IDToken = provider.signToken(signingKey, audience)
	}
	writeJSON(response, marshalJSON(responseValue))
}

func (provider *localProvider) signToken(key *rsa.PrivateKey, audience string) string {
	header := marshalJSON(jwtHeader{Algorithm: "RS256", KeyID: "local-test-key", Type: "JWT"})
	claims := marshalJSON(jwtClaims{
		Issuer: provider.server.URL, Subject: "google-subject-123", Audience: audience,
		ExpiresAt: 2_000, IssuedAt: 1_000, Nonce: testNonce,
		Email: "person@example.com", EmailVerified: true,
	})
	encoded := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(claims)
	digest := sha256.Sum256([]byte(encoded))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		panic(err)
	}
	return encoded + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func (provider *localProvider) configuration(t *testing.T) identity.OidcProviderConfiguration {
	t.Helper()
	endpoint, err := identity.ParseOidcAuthorizationEndpoint(provider.server.URL + "/authorize")
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := identity.ParseOidcIssuer(provider.server.URL)
	if err != nil {
		t.Fatal(err)
	}
	clientID, err := identity.ParseOidcClientID(testClientID)
	if err != nil {
		t.Fatal(err)
	}
	redirectURI, err := identity.ParseOidcRedirectURI(testRedirectURI)
	if err != nil {
		t.Fatal(err)
	}
	return identity.OidcProviderConfiguration{
		AuthorizationEndpoint: endpoint, ClientID: clientID,
		AllowedIssuers: []identity.OidcIssuer{issuer},
		RedirectURIs:   []identity.OidcRedirectURI{redirectURI},
	}
}

func TestLocalProviderExchangeAndJWKSVerification(t *testing.T) {
	t.Parallel()
	local := newLocalProvider(t)
	configuration := local.configuration(t)
	provider, err := NewProvider(context.Background(), struct {
		Configuration identity.OidcProviderConfiguration
		Issuer        identity.OidcIssuer
		ClientSecret  string
		HTTPClient    *http.Client
		Now           func() time.Time
	}{
		Configuration: configuration, Issuer: configuration.AllowedIssuers[0],
		ClientSecret: testClientSecret, HTTPClient: local.server.Client(),
		Now: func() time.Time { return time.Unix(1_500, 0) },
	})
	if err != nil {
		t.Fatalf("NewProvider() error = %v", err)
	}
	claims, err := provider.ExchangeCodeForVerifiedClaims(context.Background(), fixtureExchangeInput(t, configuration))
	if err != nil {
		t.Fatalf("ExchangeCodeForVerifiedClaims() error = %v", err)
	}
	if claims.Issuer != local.server.URL || claims.Subject != "google-subject-123" ||
		len(claims.Audience) != 1 || claims.Audience[0] != testClientID ||
		claims.Nonce != testNonce || claims.Email != "person@example.com" || !claims.EmailVerified {
		t.Fatalf("claims = %#v", claims)
	}
	decoded, err := identity.DecodeVerifiedOidcClaims(claims)
	if err != nil {
		t.Fatal(err)
	}
	transaction := identity.PendingOidcTransaction{
		State: mustState(t, strings.Repeat("C", 42)+"A"), Nonce: mustNonce(t, testNonce),
		CodeVerifier: mustVerifier(t, testVerifier), RedirectURI: configuration.RedirectURIs[0],
		Purpose:               identity.OidcPurpose{Kind: identity.OidcPurposeSignIn},
		CreatedAtEpochSeconds: 1_000, ExpiresAtEpochSeconds: 1_600,
	}
	if validation := identity.ValidateOidcClaims(decoded, transaction, configuration, 1_500); !validation.Valid {
		t.Fatalf("claims validation = %#v", validation)
	}
	local.mu.Lock()
	lastForm := cloneValues(local.lastForm)
	local.mu.Unlock()
	if lastForm.Get("code_verifier") != testVerifier || lastForm.Get("redirect_uri") != testRedirectURI {
		t.Fatalf("token form = %#v", lastForm)
	}
}

func TestLocalProviderRejectsSignatureAudienceAndMissingToken(t *testing.T) {
	t.Parallel()
	local := newLocalProvider(t)
	configuration := local.configuration(t)
	provider := mustProvider(t, local, configuration)
	input := fixtureExchangeInput(t, configuration)

	local.mu.Lock()
	local.badSignature = true
	local.mu.Unlock()
	if _, err := provider.ExchangeCodeForVerifiedClaims(context.Background(), input); !errors.Is(err, ErrProviderExchange) {
		t.Fatalf("bad signature error = %v", err)
	}
	local.mu.Lock()
	local.badSignature = false
	local.audience = "other.apps.googleusercontent.com"
	local.mu.Unlock()
	if _, err := provider.ExchangeCodeForVerifiedClaims(context.Background(), input); !errors.Is(err, ErrProviderExchange) {
		t.Fatalf("wrong audience error = %v", err)
	}
	local.mu.Lock()
	local.audience = testClientID
	local.missingToken = true
	local.mu.Unlock()
	if _, err := provider.ExchangeCodeForVerifiedClaims(context.Background(), input); !errors.Is(err, ErrProviderExchange) {
		t.Fatalf("missing token error = %v", err)
	}
}

func TestCryptoSecretsAndPkce(t *testing.T) {
	t.Parallel()
	input := make([]byte, 96)
	for index := range input {
		input[index] = byte(index)
	}
	secrets, err := NewCryptoSecrets(strings.NewReader(string(input)))
	if err != nil {
		t.Fatal(err)
	}
	state, err := secrets.CreateState(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	nonce, err := secrets.CreateNonce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := secrets.CreateCodeVerifier(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if state == nonce || state == verifier || nonce == verifier {
		t.Fatal("entropy outputs were reused")
	}
	parsedVerifier, err := identity.ParsePkceCodeVerifier(testVerifier)
	if err != nil {
		t.Fatal(err)
	}
	challenge, err := (PkceS256{}).DeriveS256(parsedVerifier)
	if err != nil {
		t.Fatal(err)
	}
	if challenge != "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" {
		t.Fatalf("challenge = %q", challenge)
	}
}

func mustProvider(
	t *testing.T,
	local *localProvider,
	configuration identity.OidcProviderConfiguration,
) *Provider {
	t.Helper()
	provider, err := NewProvider(context.Background(), struct {
		Configuration identity.OidcProviderConfiguration
		Issuer        identity.OidcIssuer
		ClientSecret  string
		HTTPClient    *http.Client
		Now           func() time.Time
	}{
		Configuration: configuration, Issuer: configuration.AllowedIssuers[0],
		ClientSecret: testClientSecret, HTTPClient: local.server.Client(),
		Now: func() time.Time { return time.Unix(1_500, 0) },
	})
	if err != nil {
		t.Fatal(err)
	}
	return provider
}

func fixtureExchangeInput(
	t *testing.T,
	configuration identity.OidcProviderConfiguration,
) identity.OidcCodeExchangeInput {
	t.Helper()
	code, err := identity.ParseOidcAuthorizationCode(testCode)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := identity.ParsePkceCodeVerifier(testVerifier)
	if err != nil {
		t.Fatal(err)
	}
	return identity.OidcCodeExchangeInput{
		Code: code, ClientID: configuration.ClientID,
		RedirectURI: configuration.RedirectURIs[0], CodeVerifier: verifier,
	}
}

func jwkFor(key *rsa.PublicKey) jsonWebKey {
	exponent := big.NewInt(int64(key.E)).Bytes()
	return jsonWebKey{
		KeyType: "RSA", Use: "sig", Algorithm: "RS256", KeyID: "local-test-key",
		Modulus:  base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
		Exponent: base64.RawURLEncoding.EncodeToString(exponent),
	}
}

type jsonFixture interface {
	discoveryDocument | jsonWebKeySet | tokenResponse | jwtHeader | jwtClaims
}

func marshalJSON[T jsonFixture](value T) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return encoded
}

func writeJSON(response http.ResponseWriter, value []byte) {
	response.Header().Set("Content-Type", "application/json")
	_, _ = response.Write(value)
}

func cloneValues(input url.Values) url.Values {
	output := make(url.Values, len(input))
	for key, values := range input {
		output[key] = append([]string(nil), values...)
	}
	return output
}

func mustState(t *testing.T, value string) identity.OidcState {
	t.Helper()
	parsed, err := identity.ParseOidcState(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustNonce(t *testing.T, value string) identity.OidcNonce {
	t.Helper()
	parsed, err := identity.ParseOidcNonce(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustVerifier(t *testing.T, value string) identity.PkceCodeVerifier {
	t.Helper()
	parsed, err := identity.ParsePkceCodeVerifier(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

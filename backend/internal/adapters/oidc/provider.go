package oidcadapter

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/fukamu/notes/backend/internal/identity"
	"golang.org/x/oauth2"
)

var (
	ErrInvalidConfiguration = errors.New("invalid OIDC provider configuration")
	ErrProviderExchange     = errors.New("OIDC provider exchange failed")
)

type Provider struct {
	configuration identity.OidcProviderConfiguration
	clientSecret  string
	httpClient    *http.Client
	endpoint      oauth2.Endpoint
	verifier      *oidc.IDTokenVerifier
}

func NewProvider(ctx context.Context, input struct {
	Configuration identity.OidcProviderConfiguration
	Issuer        identity.OidcIssuer
	ClientSecret  string
	HTTPClient    *http.Client
	Now           func() time.Time
}) (*Provider, error) {
	if !input.Configuration.Valid() || input.HTTPClient == nil || input.Now == nil ||
		!containsIssuer(input.Configuration.AllowedIssuers, input.Issuer) || input.ClientSecret == "" ||
		len(input.ClientSecret) > 4_096 {
		return nil, ErrInvalidConfiguration
	}
	providerContext := oidc.ClientContext(ctx, input.HTTPClient)
	discovered, err := oidc.NewProvider(providerContext, string(input.Issuer))
	if err != nil {
		return nil, ErrInvalidConfiguration
	}
	endpoint := discovered.Endpoint()
	if endpoint.AuthURL != string(input.Configuration.AuthorizationEndpoint) || endpoint.TokenURL == "" {
		return nil, ErrInvalidConfiguration
	}
	return &Provider{
		configuration: input.Configuration,
		clientSecret:  input.ClientSecret,
		httpClient:    input.HTTPClient,
		endpoint:      endpoint,
		verifier: discovered.VerifierContext(providerContext, &oidc.Config{
			ClientID: string(input.Configuration.ClientID),
			Now:      input.Now,
		}),
	}, nil
}

func (provider *Provider) ExchangeCodeForVerifiedClaims(
	ctx context.Context,
	input identity.OidcCodeExchangeInput,
) (identity.RawOidcClaims, error) {
	if provider == nil || provider.verifier == nil || provider.httpClient == nil ||
		input.ClientID != provider.configuration.ClientID ||
		!containsRedirect(provider.configuration.RedirectURIs, input.RedirectURI) {
		return identity.RawOidcClaims{}, ErrProviderExchange
	}
	if _, err := identity.ParseOidcAuthorizationCode(string(input.Code)); err != nil {
		return identity.RawOidcClaims{}, ErrProviderExchange
	}
	if _, err := identity.ParsePkceCodeVerifier(string(input.CodeVerifier)); err != nil {
		return identity.RawOidcClaims{}, ErrProviderExchange
	}
	exchangeContext := oidc.ClientContext(ctx, provider.httpClient)
	configuration := oauth2.Config{
		ClientID:     string(provider.configuration.ClientID),
		ClientSecret: provider.clientSecret,
		Endpoint:     provider.endpoint,
		RedirectURL:  string(input.RedirectURI),
		Scopes:       []string{oidc.ScopeOpenID, "email"},
	}
	token, err := configuration.Exchange(
		exchangeContext,
		string(input.Code),
		oauth2.VerifierOption(string(input.CodeVerifier)),
	)
	if err != nil {
		return identity.RawOidcClaims{}, ErrProviderExchange
	}
	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return identity.RawOidcClaims{}, ErrProviderExchange
	}
	idToken, err := provider.verifier.Verify(exchangeContext, rawIDToken)
	if err != nil {
		return identity.RawOidcClaims{}, ErrProviderExchange
	}
	var additionalClaims struct {
		AuthorizedParty string `json:"azp"`
		Email           string `json:"email"`
		EmailVerified   bool   `json:"email_verified"`
	}
	if err := idToken.Claims(&additionalClaims); err != nil {
		return identity.RawOidcClaims{}, ErrProviderExchange
	}
	return identity.RawOidcClaims{
		Issuer: idToken.Issuer, Subject: idToken.Subject,
		Audience:        append([]string(nil), idToken.Audience...),
		AuthorizedParty: additionalClaims.AuthorizedParty,
		ExpiresAt:       idToken.Expiry.Unix(), IssuedAt: idToken.IssuedAt.Unix(),
		Nonce: idToken.Nonce, Email: additionalClaims.Email,
		EmailVerified: additionalClaims.EmailVerified,
	}, nil
}

type CryptoSecrets struct {
	reader io.Reader
}

func NewCryptoSecrets(reader io.Reader) (*CryptoSecrets, error) {
	if reader == nil {
		return nil, errors.New("entropy reader is required")
	}
	return &CryptoSecrets{reader: reader}, nil
}

func NewProductionCryptoSecrets() *CryptoSecrets {
	return &CryptoSecrets{reader: rand.Reader}
}

func (secrets *CryptoSecrets) CreateState(context.Context) (string, error) {
	return secrets.randomBase64URL256()
}

func (secrets *CryptoSecrets) CreateNonce(context.Context) (string, error) {
	return secrets.randomBase64URL256()
}

func (secrets *CryptoSecrets) CreateCodeVerifier(context.Context) (string, error) {
	return secrets.randomBase64URL256()
}

func (secrets *CryptoSecrets) randomBase64URL256() (string, error) {
	if secrets == nil || secrets.reader == nil {
		return "", errors.New("entropy reader is unavailable")
	}
	buffer := make([]byte, 32)
	if _, err := io.ReadFull(secrets.reader, buffer); err != nil {
		return "", errors.New("entropy generation failed")
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

type PkceS256 struct{}

func (PkceS256) DeriveS256(verifier identity.PkceCodeVerifier) (string, error) {
	if _, err := identity.ParsePkceCodeVerifier(string(verifier)); err != nil {
		return "", err
	}
	return oauth2.S256ChallengeFromVerifier(string(verifier)), nil
}

func containsIssuer(values []identity.OidcIssuer, candidate identity.OidcIssuer) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

func containsRedirect(values []identity.OidcRedirectURI, candidate identity.OidcRedirectURI) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

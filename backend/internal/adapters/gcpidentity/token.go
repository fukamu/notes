package gcpidentity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	serviceIdentityTokenURL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
	maximumTokenBodyBytes   = 16_384
)

var ErrAccessTokenUnavailable = errors.New("Google service identity access token is unavailable")

type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

// AccessTokenSource obtains short-lived credentials only from the Google
// metadata server. The production container therefore uses its Cloud Run
// service identity and does not accept a distributed credential file.
type AccessTokenSource struct {
	client    HTTPDoer
	now       func() time.Time
	mutex     sync.Mutex
	token     string
	expiresAt time.Time
}

func NewServiceIdentityAccessTokenSource(client HTTPDoer) (*AccessTokenSource, error) {
	return newServiceIdentityAccessTokenSource(client, time.Now)
}

func newServiceIdentityAccessTokenSource(
	client HTTPDoer,
	now func() time.Time,
) (*AccessTokenSource, error) {
	if client == nil || now == nil {
		return nil, ErrAccessTokenUnavailable
	}
	return &AccessTokenSource{client: client, now: now}, nil
}

func (source *AccessTokenSource) ReadAccessToken(ctx context.Context) (string, error) {
	if source == nil || source.client == nil || source.now == nil || ctx == nil || ctx.Err() != nil {
		return "", ErrAccessTokenUnavailable
	}
	source.mutex.Lock()
	defer source.mutex.Unlock()
	now := source.now()
	if validAccessToken(source.token) && source.expiresAt.After(now.Add(time.Minute)) {
		return source.token, nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, serviceIdentityTokenURL, nil)
	if err != nil {
		return "", ErrAccessTokenUnavailable
	}
	request.Header.Set("Metadata-Flavor", "Google")
	response, err := source.client.Do(request)
	if err != nil || response == nil || response.Body == nil {
		return "", ErrAccessTokenUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Metadata-Flavor") != "Google" {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maximumTokenBodyBytes))
		return "", ErrAccessTokenUnavailable
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maximumTokenBodyBytes+1))
	if err != nil || len(body) == 0 || len(body) > maximumTokenBodyBytes {
		return "", ErrAccessTokenUnavailable
	}
	var wire struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
		TokenType   string `json:"token_type"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	if decoder.Decode(&wire) != nil || decoder.Decode(&struct{}{}) != io.EOF ||
		wire.TokenType != "Bearer" || wire.ExpiresIn < 120 || wire.ExpiresIn > 86_400 ||
		!validAccessToken(wire.AccessToken) {
		return "", ErrAccessTokenUnavailable
	}
	source.token = wire.AccessToken
	source.expiresAt = now.Add(time.Duration(wire.ExpiresIn) * time.Second)
	return source.token, nil
}

func validAccessToken(value string) bool {
	return len(value) >= 20 && len(value) <= 8_192 && !strings.ContainsAny(value, "\r\n\x00")
}

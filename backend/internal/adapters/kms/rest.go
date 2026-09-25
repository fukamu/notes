package kms

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
)

const (
	gcpCloudKMSEndpoint    = "https://cloudkms.googleapis.com/v1"
	maximumAccessTokenSize = 8_192
	maximumResponseSize    = 65_536
)

var visibleTokenPattern = regexp.MustCompile(`^[\x21-\x7e]+$`)

type AccessTokenSource interface {
	ReadAccessToken(context.Context) (string, error)
}

type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

type RESTTransport struct {
	accessToken AccessTokenSource
	client      HTTPDoer
}

func NewRESTTransport(accessToken AccessTokenSource, client HTTPDoer) (*RESTTransport, error) {
	if accessToken == nil || client == nil {
		return nil, ErrGCPConfiguration
	}
	return &RESTTransport{accessToken: accessToken, client: client}, nil
}

func (transport *RESTTransport) Encrypt(
	ctx context.Context,
	command EncryptRequest,
) (json.RawMessage, error) {
	if _, versionName, err := parseCryptoKeyVersionResource(command.KeyVersionName); err != nil ||
		versionName != command.KeyVersionName {
		return nil, ErrGCPOperation
	}
	return transport.post(ctx, gcpCloudKMSEndpoint+"/"+command.KeyVersionName+":encrypt", struct {
		Plaintext                         string `json:"plaintext"`
		AdditionalAuthenticatedData       string `json:"additionalAuthenticatedData"`
		PlaintextCRC32C                   string `json:"plaintextCrc32c"`
		AdditionalAuthenticatedDataCRC32C string `json:"additionalAuthenticatedDataCrc32c"`
	}{
		Plaintext:                         command.Plaintext,
		AdditionalAuthenticatedData:       command.AdditionalAuthenticatedData,
		PlaintextCRC32C:                   command.PlaintextCRC32C,
		AdditionalAuthenticatedDataCRC32C: command.AdditionalAuthenticatedDataCRC32C,
	})
}

func (transport *RESTTransport) Decrypt(
	ctx context.Context,
	command DecryptRequest,
) (json.RawMessage, error) {
	keyName, _, err := parseCryptoKeyVersionResource(command.KeyName + "/cryptoKeyVersions/1")
	if err != nil || keyName != command.KeyName {
		return nil, ErrGCPOperation
	}
	return transport.post(ctx, gcpCloudKMSEndpoint+"/"+command.KeyName+":decrypt", struct {
		Ciphertext                        string `json:"ciphertext"`
		AdditionalAuthenticatedData       string `json:"additionalAuthenticatedData"`
		CiphertextCRC32C                  string `json:"ciphertextCrc32c"`
		AdditionalAuthenticatedDataCRC32C string `json:"additionalAuthenticatedDataCrc32c"`
	}{
		Ciphertext:                        command.Ciphertext,
		AdditionalAuthenticatedData:       command.AdditionalAuthenticatedData,
		CiphertextCRC32C:                  command.CiphertextCRC32C,
		AdditionalAuthenticatedDataCRC32C: command.AdditionalAuthenticatedDataCRC32C,
	})
}

func (transport *RESTTransport) post(ctx context.Context, url string, payload any) (json.RawMessage, error) {
	if transport == nil || ctx == nil {
		return nil, ErrGCPOperation
	}
	token, err := transport.accessToken.ReadAccessToken(ctx)
	if err != nil || len(token) < 20 || len(token) > maximumAccessTokenSize ||
		!visibleTokenPattern.MatchString(token) {
		return nil, ErrGCPOperation
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, ErrGCPOperation
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, ErrGCPOperation
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response, err := transport.client.Do(request)
	if err != nil || response == nil || response.Body == nil {
		return nil, ErrGCPOperation
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maximumResponseSize))
		return nil, ErrGCPOperation
	}
	limited := io.LimitReader(response.Body, maximumResponseSize+1)
	responseBody, err := io.ReadAll(limited)
	if err != nil || len(responseBody) > maximumResponseSize || len(responseBody) == 0 {
		return nil, ErrGCPOperation
	}
	if !json.Valid(responseBody) {
		return nil, ErrGCPOperation
	}
	return json.RawMessage(responseBody), nil
}

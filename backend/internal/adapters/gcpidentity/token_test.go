package gcpidentity

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type metadataDoerStub struct {
	responses []*http.Response
	err       error
	calls     int
}

func (stub *metadataDoerStub) Do(request *http.Request) (*http.Response, error) {
	stub.calls++
	if request.URL.String() != serviceIdentityTokenURL || request.Header.Get("Metadata-Flavor") != "Google" {
		return nil, errors.New("unexpected metadata request")
	}
	if stub.err != nil {
		return nil, stub.err
	}
	response := stub.responses[0]
	stub.responses = stub.responses[1:]
	return response, nil
}

func TestServiceIdentityAccessTokenSourceValidatesAndCachesMetadataToken(t *testing.T) {
	t.Parallel()
	now := time.Unix(1_000, 0)
	client := &metadataDoerStub{responses: []*http.Response{metadataResponse(
		http.StatusOK, "Google", `{"access_token":"production-short-lived-token","expires_in":3600,"token_type":"Bearer"}`,
	)}}
	source, err := newServiceIdentityAccessTokenSource(client, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	first, err := source.ReadAccessToken(context.Background())
	if err != nil || first != "production-short-lived-token" {
		t.Fatalf("ReadAccessToken() = %q, %v", first, err)
	}
	second, err := source.ReadAccessToken(context.Background())
	if err != nil || second != first || client.calls != 1 {
		t.Fatalf("cached ReadAccessToken() = %q, %v calls=%d", second, err, client.calls)
	}
}

func TestServiceIdentityAccessTokenSourceFailsClosed(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		response *http.Response
	}{
		{name: "provider status", response: metadataResponse(http.StatusServiceUnavailable, "Google", "failure")},
		{name: "missing metadata proof", response: metadataResponse(http.StatusOK, "", `{"access_token":"production-short-lived-token","expires_in":3600,"token_type":"Bearer"}`)},
		{name: "short token", response: metadataResponse(http.StatusOK, "Google", `{"access_token":"short","expires_in":3600,"token_type":"Bearer"}`)},
		{name: "short lifetime", response: metadataResponse(http.StatusOK, "Google", `{"access_token":"production-short-lived-token","expires_in":30,"token_type":"Bearer"}`)},
		{name: "trailing json", response: metadataResponse(http.StatusOK, "Google", `{"access_token":"production-short-lived-token","expires_in":3600,"token_type":"Bearer"}{}`)},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			client := &metadataDoerStub{responses: []*http.Response{test.response}}
			source, err := newServiceIdentityAccessTokenSource(client, time.Now)
			if err != nil {
				t.Fatal(err)
			}
			value, err := source.ReadAccessToken(context.Background())
			if !errors.Is(err, ErrAccessTokenUnavailable) || value != "" {
				t.Fatalf("ReadAccessToken() = %q, %v", value, err)
			}
		})
	}
}

func metadataResponse(status int, flavor string, body string) *http.Response {
	response := &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
	if flavor != "" {
		response.Header.Set("Metadata-Flavor", flavor)
	}
	return response
}

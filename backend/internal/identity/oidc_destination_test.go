package identity

import (
	"net/url"
	"testing"
)

func TestSerializeGoogleOidcAuthorizationRequestPreservesControlledFields(t *testing.T) {
	t.Parallel()
	request := fixtureGoogleOidcAuthorizationRequest(t)

	serialized, err := SerializeGoogleOidcAuthorizationRequest(request)
	if err != nil {
		t.Fatalf("SerializeGoogleOidcAuthorizationRequest() error = %v", err)
	}
	parsed, err := url.Parse(serialized)
	if err != nil {
		t.Fatalf("parse serialized request: %v", err)
	}
	if parsed.Scheme+"://"+parsed.Host+parsed.EscapedPath() != fixtureOidcEndpoint ||
		parsed.User != nil || parsed.Fragment != "" {
		t.Fatalf("authorization destination = %q", parsed.String())
	}
	want := map[string]string{
		"response_type":         "code",
		"client_id":             fixtureOidcClientID,
		"redirect_uri":          fixtureOidcRedirect,
		"scope":                 "openid email",
		"state":                 fixtureOidcState,
		"nonce":                 fixtureOidcNonce,
		"code_challenge":        fixtureOidcChallenge,
		"code_challenge_method": "S256",
	}
	values := parsed.Query()
	if len(values) != len(want) {
		t.Fatalf("authorization query keys = %#v", values)
	}
	for name, value := range want {
		if values.Get(name) != value || len(values[name]) != 1 {
			t.Fatalf("authorization query %q = %#v, want exactly %q", name, values[name], value)
		}
	}
}

func TestSerializeGoogleOidcAuthorizationRequestRejectsNonExactDestination(t *testing.T) {
	t.Parallel()
	request := fixtureGoogleOidcAuthorizationRequest(t)

	otherProvider, err := ParseOidcAuthorizationEndpoint(
		"https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
	)
	if err != nil {
		t.Fatalf("generic HTTPS provider endpoint rejected by parser: %v", err)
	}

	for _, endpoint := range []OidcAuthorizationEndpoint{
		"https://accounts.google.com/o/oauth2/v2/userinfo",
		"https://accounts.google.com/o/oauth2/v2/auth#fragment",
		"https://accounts.google.com/o/oauth2/v2/auth?prompt=consent",
		"https://accounts.google.com/o/oauth2/v2/auth?client_id=attacker",
		"https://accounts.google.com/o/oauth2/v2/auth?",
		"https://accounts.google.com/o/oauth2/auth",
		"https://accounts.google.com/o/oauth2/v2/auth/",
		"https://accounts.google.com.evil.test/o/oauth2/v2/auth",
		"https://user@accounts.google.com/o/oauth2/v2/auth",
		"http://accounts.google.com/o/oauth2/v2/auth",
		otherProvider,
	} {
		endpoint := endpoint
		t.Run(string(endpoint), func(t *testing.T) {
			t.Parallel()
			candidate := request
			candidate.AuthorizationEndpoint = endpoint
			if serialized, serializeErr := SerializeGoogleOidcAuthorizationRequest(candidate); serializeErr == nil {
				t.Fatalf("non-exact authorization destination serialized as %q", serialized)
			}
		})
	}
}

func TestSerializeGoogleOidcAuthorizationRequestRejectsUncontrolledFields(t *testing.T) {
	t.Parallel()
	request := fixtureGoogleOidcAuthorizationRequest(t)
	cases := []struct {
		name   string
		change func(*OidcAuthorizationRequest)
	}{
		{"response type", func(candidate *OidcAuthorizationRequest) { candidate.ResponseType = "token" }},
		{"scope", func(candidate *OidcAuthorizationRequest) { candidate.Scope = "openid email profile" }},
		{"challenge method", func(candidate *OidcAuthorizationRequest) { candidate.CodeChallengeMethod = "plain" }},
		{"client id", func(candidate *OidcAuthorizationRequest) { candidate.ClientID = "" }},
		{"redirect URI", func(candidate *OidcAuthorizationRequest) { candidate.RedirectURI = "http://notes.example/callback" }},
		{"state", func(candidate *OidcAuthorizationRequest) { candidate.State = "short" }},
		{"nonce", func(candidate *OidcAuthorizationRequest) { candidate.Nonce = "short" }},
		{"challenge", func(candidate *OidcAuthorizationRequest) { candidate.CodeChallenge = "short" }},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			candidate := request
			testCase.change(&candidate)
			if serialized, err := SerializeGoogleOidcAuthorizationRequest(candidate); err == nil {
				t.Fatalf("uncontrolled authorization request serialized as %q", serialized)
			}
		})
	}
}

func fixtureGoogleOidcAuthorizationRequest(t *testing.T) OidcAuthorizationRequest {
	t.Helper()
	configuration := fixtureOidcConfiguration(t)
	transaction := fixturePendingOidcTransaction(t)
	return CreateOidcAuthorizationRequest(
		configuration,
		transaction,
		mustOidcChallenge(t, fixtureOidcChallenge),
	)
}

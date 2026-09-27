package identity

import (
	"context"
	"strings"
	"testing"
)

type fakeSessionResolver struct {
	session *Session
	err     error
	calls   int
}

func (resolver *fakeSessionResolver) FindSessionByToken(
	context.Context,
	SessionToken,
) (*Session, error) {
	resolver.calls++
	return resolver.session, resolver.err
}

func TestCSRFPolicy(t *testing.T) {
	t.Parallel()
	if decision := EvaluateCSRF(CSRFInput{Method: "GET"}); decision.Kind != CSRFAllowed || decision.Reason != CSRFSafeMethod {
		t.Fatalf("safe method = %#v", decision)
	}
	base := CSRFInput{
		Method: "POST", ExpectedOrigin: "https://notes.example",
		OriginHeader: "https://notes.example", SecFetchSiteHeader: "same-origin",
	}
	if decision := EvaluateCSRF(base); decision.Kind != CSRFAllowed || decision.Reason != CSRFSameOrigin {
		t.Fatalf("same origin = %#v", decision)
	}
	cases := []struct {
		name   string
		input  CSRFInput
		reason CSRFReason
	}{
		{"lowercase method", withCSRF(base, func(input *CSRFInput) { input.Method = "post" }), CSRFInvalidMethod},
		{"origin slash", withCSRF(base, func(input *CSRFInput) { input.ExpectedOrigin += "/" }), CSRFInvalidExpectedOrigin},
		{"origin default port", withCSRF(base, func(input *CSRFInput) { input.ExpectedOrigin += ":443" }), CSRFInvalidExpectedOrigin},
		{"missing origin", withCSRF(base, func(input *CSRFInput) { input.OriginHeader = "" }), CSRFMissingOrigin},
		{"mismatch", withCSRF(base, func(input *CSRFInput) { input.OriginHeader = "https://evil.example" }), CSRFOriginMismatch},
		{"missing metadata", withCSRF(base, func(input *CSRFInput) { input.SecFetchSiteHeader = "" }), CSRFMissingFetchMetadata},
		{"same site", withCSRF(base, func(input *CSRFInput) { input.SecFetchSiteHeader = "same-site" }), CSRFCrossSite},
		{"cross site", withCSRF(base, func(input *CSRFInput) { input.SecFetchSiteHeader = "cross-site" }), CSRFCrossSite},
		{"none", withCSRF(base, func(input *CSRFInput) { input.SecFetchSiteHeader = "none" }), CSRFCrossSite},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			decision := EvaluateCSRF(testCase.input)
			if decision.Kind != CSRFDenied || decision.Reason != testCase.reason {
				t.Fatalf("decision = %#v", decision)
			}
		})
	}
}

func TestSessionCookiePolicy(t *testing.T) {
	t.Parallel()
	token := mustToken(t, strings.Repeat("A", 43))
	serialized, ok := SetSessionCookie(token, 3_600)
	if !ok || serialized != SessionCookieName+"="+string(token)+
		"; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict" {
		t.Fatalf("set cookie = %q, %t", serialized, ok)
	}
	if ClearSessionCookie() != SessionCookieName+"=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict" {
		t.Fatalf("clear cookie = %q", ClearSessionCookie())
	}
	if _, ok := SetSessionCookie(token, 0); ok {
		t.Fatal("zero max age accepted")
	}
	if result := ParseSessionCookieHeader(SessionCookieName + "=" + string(token)); result.Kind != CookieFound || result.Token != token {
		t.Fatalf("parsed cookie = %#v", result)
	}
	if result := ParseSessionCookieHeader("other=value; " + SessionCookieName + "=" + string(token)); result.Kind != CookieFound {
		t.Fatalf("cookie after other value = %#v", result)
	}
	if result := ParseSessionCookieHeader(""); result.Kind != CookieMissing {
		t.Fatalf("empty cookie = %#v", result)
	}
	if result := ParseSessionCookieHeader(SessionCookieName + "=short"); result.Kind != CookieInvalid {
		t.Fatalf("short cookie = %#v", result)
	}
	duplicate := SessionCookieName + "=" + string(token) + "; " + SessionCookieName + "=" + string(token)
	if result := ParseSessionCookieHeader(duplicate); result.Kind != CookieInvalid {
		t.Fatalf("duplicate cookie = %#v", result)
	}
	if result := ParseSessionCookieHeader(strings.Repeat("a", 8_193)); result.Kind != CookieInvalid {
		t.Fatalf("oversize cookie = %#v", result)
	}
}

func TestVaultContextBoundary(t *testing.T) {
	t.Parallel()
	active := fixtureSession(t)
	token := mustToken(t, strings.Repeat("A", 43))
	resolver := &fakeSessionResolver{session: &active}
	metadata := SessionRequestMetadata{
		Method: "POST", CookieHeaders: []string{SessionCookieName + "=" + string(token)},
		OriginHeader: "https://notes.example", SecFetchSiteHeader: "same-origin",
		ExpectedOrigin: "https://notes.example", Now: 1_500,
	}
	resolution, err := DeriveVaultContext(context.Background(), metadata, resolver)
	if err != nil || resolution.Kind != ResolutionAuthenticated ||
		resolution.Context.AccountID != active.AccountID || resolver.calls != 1 {
		t.Fatalf("authenticated resolution = %#v, %v, calls=%d", resolution, err, resolver.calls)
	}

	blockedResolver := &fakeSessionResolver{session: &active}
	blocked := metadata
	blocked.OriginHeader = "https://evil.example"
	blocked.SecFetchSiteHeader = "cross-site"
	resolution, err = DeriveVaultContext(context.Background(), blocked, blockedResolver)
	if err != nil || resolution.Kind != ResolutionForbidden ||
		resolution.CSRF.Reason != CSRFOriginMismatch || blockedResolver.calls != 0 {
		t.Fatalf("cross-site resolution = %#v, %v, calls=%d", resolution, err, blockedResolver.calls)
	}

	duplicateResolver := &fakeSessionResolver{session: &active}
	duplicate := metadata
	duplicate.CookieHeaders = append([]string(nil), metadata.CookieHeaders[0], metadata.CookieHeaders[0])
	resolution, err = DeriveVaultContext(context.Background(), duplicate, duplicateResolver)
	if err != nil || resolution.Kind != ResolutionAnonymous ||
		resolution.Reason != ResolutionInvalidCookie || duplicateResolver.calls != 0 {
		t.Fatalf("duplicate-cookie resolution = %#v, %v, calls=%d", resolution, err, duplicateResolver.calls)
	}

	unknownResolver := &fakeSessionResolver{}
	resolution, err = DeriveVaultContext(context.Background(), metadata, unknownResolver)
	if err != nil || resolution.Kind != ResolutionAnonymous ||
		resolution.Reason != ResolutionUnknownSession || unknownResolver.calls != 1 {
		t.Fatalf("unknown resolution = %#v, %v, calls=%d", resolution, err, unknownResolver.calls)
	}
}

func withCSRF(input CSRFInput, change func(*CSRFInput)) CSRFInput {
	change(&input)
	return input
}

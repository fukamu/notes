package httpapi

import (
	"context"
	"net/http"
	"net/url"
	"time"

	"github.com/fukamu/notes/backend/internal/access"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/launchgate"
)

const productionSessionLifetime = 30 * 24 * time.Hour

type OidcSessionStore interface {
	CreateOidcSession(context.Context, identity.Session, identity.SessionToken, identity.IdentityID) error
	LogoutSession(context.Context, identity.VaultContext, identity.SessionToken, int64) error
}

type OidcSessionIdentifiers interface {
	CreateSessionID(context.Context) (string, error)
	CreateSessionToken(context.Context) (string, error)
}

type OidcAuthRuntime struct {
	Configuration identity.OidcProviderConfiguration
	RedirectURI   identity.OidcRedirectURI
	PublicOrigin  *url.URL
	Clock         identity.OidcClock
	Now           func() time.Time
	Secrets       identity.OidcSecretPort
	PKCE          identity.PkceChallengePort
	Transactions  identity.OidcTransactionStore
	Provider      identity.OidcVerifiedClaimsPort
	Identities    identity.OidcIdentityDirectory
	Gate          launchgate.Reader
	Sessions      identity.SessionResolver
	SessionStore  OidcSessionStore
	Identifiers   OidcSessionIdentifiers
}

func oidcAuthRuntimeComplete(runtime *OidcAuthRuntime) bool {
	return runtime != nil && runtime.Configuration.Valid() && runtime.RedirectURI != "" &&
		runtime.PublicOrigin != nil && runtime.Clock != nil && runtime.Now != nil &&
		runtime.Secrets != nil && runtime.PKCE != nil && runtime.Transactions != nil &&
		runtime.Provider != nil && runtime.Identities != nil && runtime.Gate != nil &&
		runtime.Sessions != nil && runtime.SessionStore != nil && runtime.Identifiers != nil
}

func oidcStart(runtime *OidcAuthRuntime) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		setLaunchPrivateHeaders(response)
		if !allowMethods(response, request, http.MethodGet) {
			return
		}
		if request.URL.RawQuery != "" || request.ContentLength != 0 ||
			len(request.TransferEncoding) != 0 || !oidcAuthRuntimeComplete(runtime) {
			writeError(response, request, http.StatusBadRequest, "invalid_request")
			return
		}
		result := identity.StartGoogleOidc(request.Context(), struct {
			Configuration      identity.OidcProviderConfiguration
			RedirectURI        string
			Intent             identity.OidcStartIntent
			SignupTermsConsent *identity.SignupTermsConsent
			VaultContext       *identity.VaultContext
			Clock              identity.OidcClock
			Secrets            identity.OidcSecretPort
			Pkce               identity.PkceChallengePort
			Transactions       identity.OidcTransactionStore
		}{
			Configuration: runtime.Configuration, RedirectURI: string(runtime.RedirectURI),
			Intent: identity.OidcStartSignIn, Clock: runtime.Clock,
			Secrets: runtime.Secrets, Pkce: runtime.PKCE, Transactions: runtime.Transactions,
		})
		if !result.Redirect {
			writeLaunchUnavailable(response, request)
			return
		}
		destination, err := identity.SerializeGoogleOidcAuthorizationRequest(result.Request)
		if err != nil {
			writeLaunchUnavailable(response, request)
			return
		}
		response.Header().Set("Location", destination)
		response.WriteHeader(http.StatusFound)
	}
}

func oidcCallback(runtime *OidcAuthRuntime) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		setLaunchPrivateHeaders(response)
		if !allowMethods(response, request, http.MethodGet) {
			return
		}
		if request.ContentLength != 0 || len(request.TransferEncoding) != 0 || !oidcAuthRuntimeComplete(runtime) {
			writeError(response, request, http.StatusBadRequest, "invalid_request")
			return
		}
		callback, err := identity.OidcCallbackInputFromURL(request.URL.RequestURI())
		if err != nil {
			writeError(response, request, http.StatusBadRequest, "authentication_failed")
			return
		}
		completed := identity.CompleteGoogleOidc(request.Context(), struct {
			Callback      identity.OidcCallbackInput
			Configuration identity.OidcProviderConfiguration
			Clock         identity.OidcClock
			Transactions  identity.OidcTransactionStore
			Provider      identity.OidcVerifiedClaimsPort
			Identities    identity.OidcIdentityDirectory
			Signup        identity.SignupAdmissionPort
		}{
			Callback: callback, Configuration: runtime.Configuration, Clock: runtime.Clock,
			Transactions: runtime.Transactions, Provider: runtime.Provider, Identities: runtime.Identities,
		})
		if completed.Kind != identity.OidcCompletionResolved ||
			completed.Resolution.Kind != identity.OidcAuthenticateExisting ||
			completed.Resolution.Identity == nil {
			writeError(response, request, http.StatusForbidden, "authentication_failed")
			return
		}
		principal := *completed.Resolution.Identity
		subject, err := access.ParseSubject(string(principal.Subject))
		if err != nil {
			writeError(response, request, http.StatusForbidden, "authentication_failed")
			return
		}
		admission, err := launchgate.Resolve(request.Context(), runtime.Gate, &subject)
		if err != nil {
			writeLaunchUnavailable(response, request)
			return
		}
		if !admission.CanAccess {
			writeLaunchDenied(response, request)
			return
		}
		session, token, ok := issueOidcSession(request.Context(), runtime, principal)
		if !ok {
			writeLaunchUnavailable(response, request)
			return
		}
		cookie, ok := identity.SetSessionCookie(token, int64(productionSessionLifetime/time.Second))
		if !ok || session.ExpiresAt <= session.IssuedAt {
			writeLaunchUnavailable(response, request)
			return
		}
		response.Header().Add("Set-Cookie", cookie)
		response.Header().Set("Location", "/")
		response.WriteHeader(http.StatusSeeOther)
	}
}

func issueOidcSession(
	ctx context.Context,
	runtime *OidcAuthRuntime,
	principal identity.OidcIdentityRecord,
) (identity.Session, identity.SessionToken, bool) {
	rawID, err := runtime.Identifiers.CreateSessionID(ctx)
	if err != nil {
		return identity.Session{}, "", false
	}
	sessionID, err := identity.ParseSessionID(rawID)
	if err != nil {
		return identity.Session{}, "", false
	}
	rawToken, err := runtime.Identifiers.CreateSessionToken(ctx)
	if err != nil {
		return identity.Session{}, "", false
	}
	token, err := identity.ParseSessionToken(rawToken)
	if err != nil {
		return identity.Session{}, "", false
	}
	now := runtime.Now().UnixMilli()
	established := identity.EstablishOidcSession(struct {
		Principal        identity.OidcIdentityRecord
		CurrentSession   *identity.Session
		CurrentToken     *identity.SessionToken
		NextSessionID    identity.SessionID
		NextSessionEpoch identity.SessionEpoch
		NextToken        identity.SessionToken
		Now              int64
		ExpiresAt        int64
	}{
		Principal: principal, NextSessionID: sessionID, NextSessionEpoch: 1,
		NextToken: token, Now: now, ExpiresAt: now + productionSessionLifetime.Milliseconds(),
	})
	if established.Kind != identity.OidcSessionCreated ||
		runtime.SessionStore.CreateOidcSession(ctx, established.Session, token, principal.IdentityID) != nil {
		return identity.Session{}, "", false
	}
	return established.Session, token, true
}

func oidcLogout(runtime *OidcAuthRuntime) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		setLaunchPrivateHeaders(response)
		if !allowMethods(response, request, http.MethodPost) {
			return
		}
		if !oidcAuthRuntimeComplete(runtime) {
			writeLaunchUnavailable(response, request)
			return
		}
		origin, valid := singleHeader(request, "Origin")
		if !valid {
			writeLaunchDenied(response, request)
			return
		}
		secFetchSite, valid := singleHeader(request, "Sec-Fetch-Site")
		if !valid || identity.EvaluateCSRF(identity.CSRFInput{
			Method: request.Method, ExpectedOrigin: runtime.PublicOrigin.String(),
			OriginHeader: origin, SecFetchSiteHeader: secFetchSite,
		}).Kind != identity.CSRFAllowed {
			writeLaunchDenied(response, request)
			return
		}
		cookieHeaders := request.Header.Values("Cookie")
		cookie := identity.CookieParseResult{Kind: identity.CookieMissing}
		if len(cookieHeaders) == 1 {
			cookie = identity.ParseSessionCookieHeader(cookieHeaders[0])
		} else if len(cookieHeaders) > 1 {
			cookie = identity.CookieParseResult{Kind: identity.CookieInvalid}
		}
		if cookie.Kind != identity.CookieFound {
			response.Header().Add("Set-Cookie", identity.ClearSessionCookie())
			response.WriteHeader(http.StatusNoContent)
			return
		}
		now := runtime.Now().UnixMilli()
		resolved, err := identity.DeriveVaultContext(request.Context(), identity.SessionRequestMetadata{
			Method: request.Method, CookieHeaders: request.Header.Values("Cookie"),
			OriginHeader: origin, SecFetchSiteHeader: secFetchSite,
			ExpectedOrigin: runtime.PublicOrigin.String(), Now: now,
		}, runtime.Sessions)
		if err != nil || resolved.Kind != identity.ResolutionAuthenticated ||
			runtime.SessionStore.LogoutSession(request.Context(), resolved.Context, cookie.Token, now) != nil {
			writeLaunchUnavailable(response, request)
			return
		}
		response.Header().Add("Set-Cookie", identity.ClearSessionCookie())
		response.WriteHeader(http.StatusNoContent)
	}
}

package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/fukamu/notes/backend/internal/access"
	"github.com/fukamu/notes/backend/internal/accountdeletion"
	accessadapter "github.com/fukamu/notes/backend/internal/adapters/access"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/launchgate"
	"github.com/fukamu/notes/backend/internal/privacyrequest"
	"github.com/fukamu/notes/backend/internal/synclegacy"
)

type HandlerOptions struct {
	StaticDirectory            string
	BodyLimit                  int64
	Logger                     *slog.Logger
	PrivateRuntime             *PrivateRuntime
	SessionAccessRuntime       *SessionAccessRuntime
	Readiness                  ReadinessChecker
	OidcAuthRuntime            *OidcAuthRuntime
	ProductionFeatureRuntime   *ProductionFeatureRuntime
	SyncV2Runtime              *SyncV2Runtime
	LegalRuntime               *LegalRuntime
	BillingCancellationRuntime *BillingCancellationRuntime
	AccountDeletionRuntime     *AccountDeletionRuntime
	PrivacyRequestRuntime      *PrivacyRequestRuntime
	DisableLegacySync          bool
	EnableDisconnectedFixtures bool
}

type AssertionVerifier interface {
	Verify(string, time.Time) (access.Subject, error)
}

type ReadinessChecker interface {
	Check(context.Context) error
}

type LegacySynchronizer interface {
	Sync(context.Context, synclegacy.Request) (synclegacy.Response, error)
}

type PrivateRuntime struct {
	Verifier     AssertionVerifier
	Gate         launchgate.Reader
	Readiness    ReadinessChecker
	LegacySync   LegacySynchronizer
	LegacyOwner  access.Subject
	PublicOrigin *url.URL
	Clock        func() time.Time
}

type SessionAccessRuntime struct {
	Clock     func() int64
	Sessions  identity.SessionResolver
	Admission VaultAdmission
}

type statusResponseWriter struct {
	http.ResponseWriter
	status int
}

func (writer *statusResponseWriter) WriteHeader(status int) {
	writer.status = status
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *statusResponseWriter) Unwrap() http.ResponseWriter {
	return writer.ResponseWriter
}

func NewHandler(options HandlerOptions) (http.Handler, error) {
	if options.Logger == nil {
		return nil, errors.New("logger is required")
	}
	if options.BodyLimit < 1 {
		return nil, errors.New("body limit must be positive")
	}
	if options.SyncV2Runtime != nil && !syncV2RuntimeComplete(options.SyncV2Runtime) {
		return nil, errors.New("Sync v2 runtime is incomplete")
	}
	if options.OidcAuthRuntime != nil && !oidcAuthRuntimeComplete(options.OidcAuthRuntime) {
		return nil, errors.New("OIDC auth runtime is incomplete")
	}
	if options.ProductionFeatureRuntime != nil &&
		!productionFeatureRuntimeComplete(options.ProductionFeatureRuntime) {
		return nil, errors.New("production feature runtime is incomplete")
	}
	if options.AccountDeletionRuntime != nil && !accountDeletionRuntimeComplete(options.AccountDeletionRuntime) {
		return nil, errors.New("account deletion runtime is incomplete")
	}
	if options.PrivacyRequestRuntime != nil && !privacyRequestRuntimeComplete(options.PrivacyRequestRuntime) {
		return nil, errors.New("privacy request runtime is incomplete")
	}
	staticSite, err := loadStaticSite(options.StaticDirectory)
	if err != nil {
		return nil, err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", exact("/healthz", processHealth))
	readinessChecker := options.Readiness
	if readinessChecker == nil && options.PrivateRuntime != nil {
		readinessChecker = options.PrivateRuntime.Readiness
	}
	mux.HandleFunc("/readyz", exact("/readyz", readiness(readinessChecker)))
	launchStatusHandler := launchStatus(options.PrivateRuntime)
	if options.SessionAccessRuntime != nil {
		launchStatusHandler = sessionLaunchStatus(options.SessionAccessRuntime)
	}
	mux.HandleFunc(
		"/api/launch-status",
		exact("/api/launch-status", launchStatusHandler),
	)
	oidcStartHandler := http.HandlerFunc(closedAPI)
	oidcCallbackHandler := http.HandlerFunc(closedAPI)
	oidcLogoutHandler := http.HandlerFunc(closedAPI)
	if options.OidcAuthRuntime != nil {
		oidcStartHandler = oidcStart(options.OidcAuthRuntime)
		oidcCallbackHandler = oidcCallback(options.OidcAuthRuntime)
		oidcLogoutHandler = oidcLogout(options.OidcAuthRuntime)
	}
	mux.HandleFunc("/auth/google/start", exact("/auth/google/start", oidcStartHandler))
	mux.HandleFunc("/auth/google/callback", exact("/auth/google/callback", oidcCallbackHandler))
	mux.HandleFunc("/auth/logout", exact("/auth/logout", oidcLogoutHandler))
	legacyHandler := legacySync(options.PrivateRuntime, options.BodyLimit)
	if options.DisableLegacySync {
		legacyHandler = closedAPI
	}
	syncV2Handler := disconnectedProtectedAPI(
		options.PrivateRuntime, options.EnableDisconnectedFixtures, http.MethodPost,
	)
	sessionContextHandler := disconnectedProtectedAPI(
		options.PrivateRuntime, options.EnableDisconnectedFixtures, http.MethodGet,
	)
	if options.SyncV2Runtime != nil {
		legacyHandler = closedAPI
		syncV2Handler = syncV2ContractHandler(
			options.SyncV2Runtime,
			options.Logger,
			effectiveSyncV2BodyLimit(options.BodyLimit),
		)
		sessionContextHandler = sessionContext(
			options.SyncV2Runtime,
			options.AccountDeletionRuntime != nil,
		)
	}
	mux.HandleFunc("/api/sync", exact("/api/sync", legacyHandler))
	mux.HandleFunc("/api/v2/sync", exact("/api/v2/sync", syncV2Handler))
	mux.HandleFunc(
		"/api/session-context",
		exact("/api/session-context", sessionContextHandler),
	)
	mux.HandleFunc(
		"/api/billing/checkout",
		exact("/api/billing/checkout", checkoutRoute(options)),
	)
	mux.HandleFunc(
		"/api/account/terms-consent",
		exact("/api/account/terms-consent", termsConsentRoute(options)),
	)
	mux.HandleFunc(
		"/api/billing/cancel",
		exact("/api/billing/cancel", billingCancellationRoute(options)),
	)
	deletionStart := http.HandlerFunc(disconnectedPublicAPI(options.EnableDisconnectedFixtures, http.MethodGet, http.MethodPost))
	deletionResume := http.HandlerFunc(disconnectedPublicAPI(options.EnableDisconnectedFixtures, http.MethodGet, http.MethodPost))
	if options.AccountDeletionRuntime != nil {
		deletionHandlers, deletionErr := newAccountDeletionContractHandlers(
			options.AccountDeletionRuntime, options.Logger, effectiveAccountDeletionBodyLimit(options.BodyLimit),
		)
		if deletionErr != nil {
			return nil, deletionErr
		}
		deletionStart = deletionHandlers.Start.ServeHTTP
		deletionResume = deletionHandlers.Resume.ServeHTTP
	}
	mux.HandleFunc("/api/account/deletion", exact("/api/account/deletion", deletionStart))
	mux.HandleFunc("/api/account/deletion/status", exact("/api/account/deletion/status", deletionResume))
	privacySubmit := http.HandlerFunc(disconnectedPublicAPI(options.EnableDisconnectedFixtures, http.MethodGet, http.MethodPost))
	privacyStatus := http.HandlerFunc(disconnectedPublicAPI(options.EnableDisconnectedFixtures, http.MethodGet, http.MethodPost))
	if options.PrivacyRequestRuntime != nil {
		privacyHandlers, privacyErr := newPrivacyRequestContractHandlers(
			options.PrivacyRequestRuntime,
			options.Logger,
			effectivePrivacyRequestBodyLimit(options.BodyLimit),
		)
		if privacyErr != nil {
			return nil, privacyErr
		}
		privacySubmit = privacyHandlers.Submit.ServeHTTP
		privacyStatus = privacyHandlers.Status.ServeHTTP
	}
	mux.HandleFunc("/api/account/privacy-requests", exact("/api/account/privacy-requests", privacySubmit))
	mux.HandleFunc("/api/account/privacy-requests/status", exact("/api/account/privacy-requests/status", privacyStatus))
	mux.HandleFunc("/api", closedAPI)
	mux.HandleFunc("/api/", closedAPI)
	mux.HandleFunc("/", staticSite.handler())

	handler := limitBody(options.BodyLimit, mux)
	handler = recoverPanics(options.Logger, handler)
	handler = logRequests(options.Logger, handler)
	return handler, nil
}

func exact(path string, handler http.HandlerFunc) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != path {
			writeError(response, request, http.StatusNotFound, "not_found")
			return
		}
		handler(response, request)
	}
}

func processHealth(response http.ResponseWriter, request *http.Request) {
	if !allowRead(response, request) {
		return
	}
	writeJSON(response, request, http.StatusOK, map[string]string{"status": "ok"})
}

func readiness(checker ReadinessChecker) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !allowRead(response, request) {
			return
		}
		if checker == nil {
			writeJSON(
				response,
				request,
				http.StatusServiceUnavailable,
				map[string]string{"status": "not_ready"},
			)
			return
		}
		ctx, cancel := context.WithTimeout(request.Context(), time.Second)
		defer cancel()
		if err := checker.Check(ctx); err != nil {
			writeJSON(
				response,
				request,
				http.StatusServiceUnavailable,
				map[string]string{"status": "not_ready"},
			)
			return
		}
		writeJSON(response, request, http.StatusOK, map[string]string{"status": "ready"})
	}
}

func sessionLaunchStatus(runtime *SessionAccessRuntime) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		setLaunchPrivateHeaders(response)
		if !allowRead(response, request) {
			return
		}
		if runtime == nil || runtime.Clock == nil || runtime.Sessions == nil || runtime.Admission == nil {
			writeLaunchUnavailable(response, request)
			return
		}
		now := runtime.Clock()
		if now < 0 || now > identity.MaximumSafeInteger {
			writeLaunchUnavailable(response, request)
			return
		}
		resolved, err := identity.DeriveVaultContext(request.Context(), identity.SessionRequestMetadata{
			Method: request.Method, CookieHeaders: request.Header.Values("Cookie"), Now: now,
		}, runtime.Sessions)
		if err != nil {
			writeLaunchUnavailable(response, request)
			return
		}
		if resolved.Kind != identity.ResolutionAuthenticated {
			writeJSON(response, request, http.StatusOK, map[string]bool{
				"publicAccessEnabled": false,
				"userAllowed":         false,
				"canAccess":           false,
				"authenticated":       false,
			})
			return
		}
		decision, err := runtime.Admission.AuthorizeVault(request.Context(), resolved.Context)
		if err != nil {
			writeLaunchUnavailable(response, request)
			return
		}
		writeJSON(response, request, http.StatusOK, map[string]bool{
			"publicAccessEnabled": decision.PublicAccessEnabled,
			"userAllowed":         decision.UserAllowed,
			"canAccess":           decision.CanAccess,
			"authenticated":       true,
		})
	}
}

func launchStatus(runtime *PrivateRuntime) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		setLaunchPrivateHeaders(response)
		if !allowRead(response, request) {
			return
		}
		if runtime == nil || runtime.Verifier == nil || runtime.Gate == nil || runtime.Clock == nil {
			writeLaunchUnavailable(response, request)
			return
		}
		subject, valid := resolvePrivateIdentity(request, runtime)
		if !valid {
			writeLaunchUnavailable(response, request)
			return
		}
		decision, err := launchgate.Resolve(request.Context(), runtime.Gate, subject)
		if err != nil {
			writeLaunchUnavailable(response, request)
			return
		}
		writeJSON(response, request, http.StatusOK, map[string]bool{
			"publicAccessEnabled": decision.PublicAccessEnabled,
			"userAllowed":         decision.UserAllowed,
			"canAccess":           decision.CanAccess,
			"authenticated":       subject != nil,
		})
	}
}

func legacySync(runtime *PrivateRuntime, bodyLimit int64) http.HandlerFunc {
	if bodyLimit > int64(synclegacy.MaximumPayloadBytes) {
		bodyLimit = int64(synclegacy.MaximumPayloadBytes)
	}
	return func(response http.ResponseWriter, request *http.Request) {
		if !privateRuntimeComplete(runtime) {
			writeError(response, request, http.StatusNotFound, "not_found")
			return
		}
		setLaunchPrivateHeaders(response)
		if request.Method != http.MethodPost {
			response.Header().Set("Allow", "POST")
			writeError(response, request, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		subject, valid := resolvePrivateIdentity(request, runtime)
		if !valid || subject == nil {
			writeLaunchDenied(response, request)
			return
		}
		decision, err := launchgate.Resolve(request.Context(), runtime.Gate, subject)
		if err != nil {
			writeLaunchUnavailable(response, request)
			return
		}
		if !decision.CanAccess || !access.IsLegacyOwner(*subject, runtime.LegacyOwner) ||
			access.RequireSameOrigin(request.Header.Get("Origin"), runtime.PublicOrigin) != nil {
			writeLaunchDenied(response, request)
			return
		}
		mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
		if err != nil || mediaType != "application/json" {
			writeInvalidSync(response, request, http.StatusBadRequest)
			return
		}
		if request.ContentLength > bodyLimit {
			writeInvalidSync(response, request, http.StatusRequestEntityTooLarge)
			return
		}
		limited := http.MaxBytesReader(response, request.Body, bodyLimit)
		content, err := io.ReadAll(limited)
		if err != nil {
			var maximumBytesError *http.MaxBytesError
			if errors.As(err, &maximumBytesError) {
				writeInvalidSync(response, request, http.StatusRequestEntityTooLarge)
				return
			}
			writeInvalidSync(response, request, http.StatusBadRequest)
			return
		}
		input, err := synclegacy.DecodeRequest(content)
		if err != nil {
			writeInvalidSync(response, request, http.StatusBadRequest)
			return
		}
		result, err := runtime.LegacySync.Sync(request.Context(), input)
		if err != nil || synclegacy.ValidateResponse(result, input.Mutations) != nil {
			writeJSON(
				response,
				request,
				http.StatusInternalServerError,
				map[string]string{"error": "同期に失敗しました。入力内容は端末に残っています。"},
			)
			return
		}
		writeJSON(response, request, http.StatusOK, result)
	}
}

func privateRuntimeComplete(runtime *PrivateRuntime) bool {
	return runtime != nil && runtime.Readiness != nil && runtime.Verifier != nil &&
		runtime.Gate != nil && runtime.LegacySync != nil && runtime.LegacyOwner != "" &&
		runtime.PublicOrigin != nil && runtime.Clock != nil
}

func resolvePrivateIdentity(
	request *http.Request,
	runtime *PrivateRuntime,
) (*access.Subject, bool) {
	if runtime == nil || runtime.Verifier == nil || runtime.Clock == nil ||
		len(request.Header.Values(accessadapter.LegacySitesHeader)) != 0 {
		return nil, false
	}
	assertions := request.Header.Values(accessadapter.LocalAssertionHeader)
	if len(assertions) > 1 || (len(assertions) == 1 && strings.Contains(assertions[0], ",")) {
		return nil, false
	}
	if len(assertions) == 0 {
		return nil, true
	}
	verified, err := runtime.Verifier.Verify(assertions[0], runtime.Clock())
	if err != nil {
		return nil, false
	}
	return &verified, true
}

func setLaunchPrivateHeaders(response http.ResponseWriter) {
	response.Header().Set("Cache-Control", "private, no-store")
	response.Header().Set("Vary", "Cookie, "+accessadapter.LocalAssertionHeader)
}

func writeLaunchUnavailable(response http.ResponseWriter, request *http.Request) {
	writeJSON(
		response,
		request,
		http.StatusServiceUnavailable,
		map[string]string{"error": "launch-gate-unavailable"},
	)
}

func writeLaunchDenied(response http.ResponseWriter, request *http.Request) {
	writeJSON(
		response,
		request,
		http.StatusForbidden,
		map[string]string{"error": "launch-access-denied"},
	)
}

func writeInvalidSync(response http.ResponseWriter, request *http.Request, status int) {
	writeJSON(
		response,
		request,
		status,
		map[string]string{"error": "同期データが正しくありません。"},
	)
}

func closedAPI(response http.ResponseWriter, request *http.Request) {
	writeError(response, request, http.StatusNotFound, "not_found")
}

func disconnectedProtectedAPI(
	runtime *PrivateRuntime,
	fixtures bool,
	methods ...string,
) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		setLaunchPrivateHeaders(response)
		if !allowMethods(response, request, methods...) {
			return
		}
		if runtime == nil || runtime.Verifier == nil || runtime.Gate == nil || runtime.Clock == nil {
			writeLaunchUnavailable(response, request)
			return
		}
		subject, valid := resolvePrivateIdentity(request, runtime)
		if !valid {
			writeLaunchUnavailable(response, request)
			return
		}
		decision, err := launchgate.Resolve(request.Context(), runtime.Gate, subject)
		if err != nil {
			writeLaunchUnavailable(response, request)
			return
		}
		if !decision.CanAccess {
			writeLaunchDenied(response, request)
			return
		}
		writeDisconnected(response, request, fixtures)
	}
}

func disconnectedPublicAPI(fixtures bool, methods ...string) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !allowMethods(response, request, methods...) {
			return
		}
		writeDisconnected(response, request, fixtures)
	}
}

func allowMethods(response http.ResponseWriter, request *http.Request, methods ...string) bool {
	for _, method := range methods {
		if request.Method == method {
			return true
		}
	}
	response.Header().Set("Allow", strings.Join(methods, ", "))
	writeError(response, request, http.StatusMethodNotAllowed, "method_not_allowed")
	return false
}

func writeDisconnected(response http.ResponseWriter, request *http.Request, fixtures bool) {
	status := http.StatusServiceUnavailable
	errorCode := "unavailable"
	if fixtures {
		status = http.StatusNotFound
		errorCode = "not-found"
	}
	writeJSON(response, request, status, map[string]string{"error": errorCode})
}

func allowRead(response http.ResponseWriter, request *http.Request) bool {
	if request.Method == http.MethodGet || request.Method == http.MethodHead {
		return true
	}
	response.Header().Set("Allow", "GET, HEAD")
	writeError(response, request, http.StatusMethodNotAllowed, "method_not_allowed")
	return false
}

func limitBody(limit int64, next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if authorizesBeforeBody(request.URL.Path) {
			next.ServeHTTP(response, request)
			return
		}
		if request.ContentLength > limit {
			writeBodyTooLarge(response, request)
			return
		}
		limited := http.MaxBytesReader(response, request.Body, limit)
		body, err := io.ReadAll(limited)
		if err != nil {
			var maximumBytesError *http.MaxBytesError
			if errors.As(err, &maximumBytesError) {
				writeBodyTooLarge(response, request)
				return
			}
			writeError(response, request, http.StatusBadRequest, "invalid_body")
			return
		}
		request.Body = io.NopCloser(bytes.NewReader(body))
		next.ServeHTTP(response, request)
	})
}

func authorizesBeforeBody(path string) bool {
	switch path {
	case "/auth/logout", "/api/sync", "/api/v2/sync", "/api/session-context", "/api/billing/checkout", "/api/account/terms-consent", "/api/billing/cancel", "/api/account/deletion", "/api/account/deletion/status", "/api/account/privacy-requests", "/api/account/privacy-requests/status":
		return true
	default:
		return false
	}
}

func effectiveAccountDeletionBodyLimit(configured int64) int64 {
	if configured < accountdeletion.MaximumRequestBytes {
		return configured
	}
	return accountdeletion.MaximumRequestBytes
}

func effectivePrivacyRequestBodyLimit(configured int64) int64 {
	if configured < privacyrequest.MaximumRequestBytes {
		return configured
	}
	return privacyrequest.MaximumRequestBytes
}

func writeBodyTooLarge(response http.ResponseWriter, request *http.Request) {
	writeError(response, request, http.StatusRequestEntityTooLarge, "body_too_large")
}

func recoverPanics(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		defer func() {
			if recover() != nil {
				logger.Error("request failed", "error_code", "internal_panic")
				writeError(
					response,
					request,
					http.StatusInternalServerError,
					"internal_error",
				)
			}
		}()
		next.ServeHTTP(response, request)
	})
}

func logRequests(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		started := time.Now()
		tracked := &statusResponseWriter{ResponseWriter: response, status: http.StatusOK}
		next.ServeHTTP(tracked, request)
		logger.Info(
			"http request",
			"method", request.Method,
			"path", request.URL.Path,
			"status", tracked.status,
			"duration_ms", time.Since(started).Milliseconds(),
		)
	})
}

func writeError(
	response http.ResponseWriter,
	request *http.Request,
	status int,
	code string,
) {
	writeJSON(response, request, status, map[string]string{"code": code})
}

func writeJSON(
	response http.ResponseWriter,
	request *http.Request,
	status int,
	payload any,
) {
	if response.Header().Get("Cache-Control") == "" {
		response.Header().Set("Cache-Control", "no-store")
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	if request != nil && request.Method == http.MethodHead {
		return
	}
	_ = json.NewEncoder(response).Encode(payload)
}

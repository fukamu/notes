package httpapi

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	"github.com/fukamu/notes/backend/internal/identity"
)

type AccountDeletionApplication interface {
	Start(context.Context, accountdeletion.Scope, accountdeletion.StartCommand, accountdeletion.OperationID, int64) (accountdeletion.ApplicationResult, error)
	Resume(context.Context, accountdeletion.ResumeCommand, int64) (accountdeletion.ApplicationResult, error)
}

var _ AccountDeletionApplication = (*accountdeletion.Service)(nil)

// AccountDeletionRuntime is deliberately separate from HandlerOptions. These
// contract handlers stay disconnected until deletion effects, evidence policy,
// provider choice, and production recovery have a separate enablement review.
type AccountDeletionRuntime struct {
	ExpectedOrigin string
	Clock          func() int64
	Sessions       identity.SessionResolver
	Application    AccountDeletionApplication
	NewOperationID func() string
}

type AccountDeletionContractHandlers struct {
	Start  http.Handler
	Resume http.Handler
}

func NewAccountDeletionContractHandlers(
	runtime *AccountDeletionRuntime,
	logger *slog.Logger,
) (AccountDeletionContractHandlers, error) {
	if !accountDeletionRuntimeComplete(runtime) || logger == nil {
		return AccountDeletionContractHandlers{}, errors.New("complete account deletion runtime and logger are required")
	}
	return AccountDeletionContractHandlers{
		Start:  http.HandlerFunc(accountDeletionStartHandler(runtime, logger)),
		Resume: http.HandlerFunc(accountDeletionResumeHandler(runtime, logger)),
	}, nil
}

func accountDeletionStartHandler(runtime *AccountDeletionRuntime, logger *slog.Logger) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !allowMethods(response, request, http.MethodPost) {
			return
		}
		now, vaultContext, handled := authenticateAccountDeletion(response, request, runtime)
		if handled {
			return
		}
		body, status := readAccountDeletionBody(response, request)
		if status != 0 {
			writeAccountDeletionBodyError(response, request, status)
			return
		}
		command, err := accountdeletion.DecodeStartCommand(body)
		if err != nil {
			writeAccountDeletionError(response, request, http.StatusBadRequest, "invalid-request")
			return
		}
		operationID, err := accountdeletion.ParseOperationID(runtime.NewOperationID())
		if err != nil {
			writeAccountDeletionError(response, request, http.StatusServiceUnavailable, "unavailable")
			return
		}
		result, err := runtime.Application.Start(request.Context(), accountdeletion.Scope{
			AccountID: vaultContext.AccountID, VaultID: vaultContext.VaultID,
		}, command, operationID, now)
		writeAccountDeletionApplicationResult(response, request, result, err, false, logger)
	}
}

func accountDeletionResumeHandler(runtime *AccountDeletionRuntime, logger *slog.Logger) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !allowMethods(response, request, http.MethodPost) {
			return
		}
		now, handled := authorizeAccountDeletionContinuation(response, request, runtime)
		if handled {
			return
		}
		body, status := readAccountDeletionBody(response, request)
		if status != 0 {
			writeAccountDeletionBodyError(response, request, status)
			return
		}
		command, err := accountdeletion.DecodeResumeCommand(body)
		if err != nil {
			writeAccountDeletionError(response, request, http.StatusUnauthorized, "continuation-required")
			return
		}
		result, err := runtime.Application.Resume(request.Context(), command, now)
		writeAccountDeletionApplicationResult(response, request, result, err, true, logger)
	}
}

func accountDeletionRuntimeComplete(runtime *AccountDeletionRuntime) bool {
	if runtime == nil || runtime.Clock == nil || runtime.Sessions == nil ||
		runtime.Application == nil || runtime.NewOperationID == nil {
		return false
	}
	return identity.EvaluateCSRF(identity.CSRFInput{
		Method: http.MethodPost, ExpectedOrigin: runtime.ExpectedOrigin,
		OriginHeader: runtime.ExpectedOrigin, SecFetchSiteHeader: "same-origin",
	}).Kind == identity.CSRFAllowed
}

func authenticateAccountDeletion(
	response http.ResponseWriter,
	request *http.Request,
	runtime *AccountDeletionRuntime,
) (int64, identity.VaultContext, bool) {
	now, valid := accountDeletionTime(runtime.Clock())
	if !valid {
		writeAccountDeletionError(response, request, http.StatusServiceUnavailable, "unavailable")
		return 0, identity.VaultContext{}, true
	}
	origin, originValid := singleHeader(request, "Origin")
	secFetchSite, siteValid := singleHeader(request, "Sec-Fetch-Site")
	if !originValid || !siteValid {
		writeAccountDeletionError(response, request, http.StatusForbidden, "forbidden")
		return 0, identity.VaultContext{}, true
	}
	resolved, err := identity.DeriveVaultContext(request.Context(), identity.SessionRequestMetadata{
		Method: request.Method, CookieHeaders: request.Header.Values("Cookie"),
		OriginHeader: origin, SecFetchSiteHeader: secFetchSite,
		ExpectedOrigin: runtime.ExpectedOrigin, Now: now,
	}, runtime.Sessions)
	if err != nil {
		writeAccountDeletionError(response, request, http.StatusServiceUnavailable, "unavailable")
		return 0, identity.VaultContext{}, true
	}
	switch resolved.Kind {
	case identity.ResolutionAuthenticated:
		return now, resolved.Context, false
	case identity.ResolutionForbidden:
		writeAccountDeletionError(response, request, http.StatusForbidden, "forbidden")
	default:
		writeAccountDeletionError(response, request, http.StatusUnauthorized, "authentication-required")
	}
	return 0, identity.VaultContext{}, true
}

func authorizeAccountDeletionContinuation(
	response http.ResponseWriter,
	request *http.Request,
	runtime *AccountDeletionRuntime,
) (int64, bool) {
	now, valid := accountDeletionTime(runtime.Clock())
	if !valid {
		writeAccountDeletionError(response, request, http.StatusServiceUnavailable, "unavailable")
		return 0, true
	}
	origin, originValid := singleHeader(request, "Origin")
	secFetchSite, siteValid := singleHeader(request, "Sec-Fetch-Site")
	if !originValid || !siteValid || identity.EvaluateCSRF(identity.CSRFInput{
		Method: request.Method, ExpectedOrigin: runtime.ExpectedOrigin,
		OriginHeader: origin, SecFetchSiteHeader: secFetchSite,
	}).Kind != identity.CSRFAllowed {
		writeAccountDeletionError(response, request, http.StatusForbidden, "forbidden")
		return 0, true
	}
	return now, false
}

func readAccountDeletionBody(response http.ResponseWriter, request *http.Request) ([]byte, int) {
	declared := request.Header.Values("Content-Length")
	if len(declared) > 1 {
		return nil, http.StatusBadRequest
	}
	if len(declared) == 1 {
		length, err := strconv.ParseInt(declared[0], 10, 64)
		if err != nil || length < 0 {
			return nil, http.StatusBadRequest
		}
		if length > accountdeletion.MaximumRequestBytes {
			return nil, http.StatusRequestEntityTooLarge
		}
	}
	limited := http.MaxBytesReader(response, request.Body, accountdeletion.MaximumRequestBytes)
	body, err := io.ReadAll(limited)
	if err != nil {
		var maximum *http.MaxBytesError
		if errors.As(err, &maximum) {
			return nil, http.StatusRequestEntityTooLarge
		}
		return nil, http.StatusBadRequest
	}
	return body, 0
}

func writeAccountDeletionBodyError(response http.ResponseWriter, request *http.Request, status int) {
	code := "invalid-request"
	if status == http.StatusRequestEntityTooLarge {
		code = "request-too-large"
	}
	writeAccountDeletionError(response, request, status, code)
}

func writeAccountDeletionApplicationResult(
	response http.ResponseWriter,
	request *http.Request,
	result accountdeletion.ApplicationResult,
	applicationErr error,
	clearSession bool,
	logger *slog.Logger,
) {
	if applicationErr != nil {
		logger.Error("account deletion failed", "error_code", "application_failure")
		writeAccountDeletionError(response, request, http.StatusServiceUnavailable, "unavailable")
		return
	}
	if result.Kind == accountdeletion.ApplicationRejected {
		switch result.Reason {
		case accountdeletion.ApplicationCredentialConflict:
			writeAccountDeletionError(response, request, http.StatusConflict, "request-conflict")
		case accountdeletion.ApplicationInvalidCapability:
			writeAccountDeletionError(response, request, http.StatusUnauthorized, "continuation-required")
		case accountdeletion.ApplicationInvalidInput:
			writeAccountDeletionError(response, request, http.StatusBadRequest, "invalid-request")
		default:
			writeAccountDeletionError(response, request, http.StatusServiceUnavailable, "unavailable")
		}
		return
	}
	if result.Kind != accountdeletion.ApplicationAccepted || result.Response == nil {
		writeAccountDeletionError(response, request, http.StatusServiceUnavailable, "unavailable")
		return
	}
	encoded, err := accountdeletion.EncodePublicResponse(*result.Response)
	if err != nil {
		logger.Error("account deletion failed", "error_code", "invalid_application_response")
		writeAccountDeletionError(response, request, http.StatusServiceUnavailable, "unavailable")
		return
	}
	if clearSession {
		response.Header().Add("Set-Cookie", identity.ClearSessionCookie())
	}
	status := http.StatusAccepted
	if result.Response.Status == accountdeletion.PublicFailed || result.Response.Status == accountdeletion.PublicCompleted {
		status = http.StatusOK
	}
	writeAccountDeletionBytes(response, request, status, encoded)
}

func writeAccountDeletionError(response http.ResponseWriter, request *http.Request, status int, code string) {
	writeJSON(response, request, status, map[string]string{"error": code})
}

func writeAccountDeletionBytes(response http.ResponseWriter, request *http.Request, status int, content []byte) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	if request.Method != http.MethodHead {
		_, _ = response.Write(content)
	}
}

func accountDeletionTime(value int64) (int64, bool) {
	return value, value >= 0 && value <= identity.MaximumSafeInteger
}

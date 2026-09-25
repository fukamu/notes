package httpapi

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/privacyrequest"
)

type PrivacyRequestApplication interface {
	Submit(context.Context, privacyrequest.Scope, privacyrequest.SubmitCommand, privacyrequest.RequestID, int64) (privacyrequest.ApplicationResult, error)
	Status(context.Context, privacyrequest.Scope, privacyrequest.RequestID) (privacyrequest.ApplicationResult, error)
}

var _ PrivacyRequestApplication = (*privacyrequest.Service)(nil)

// PrivacyRequestRuntime is deliberately not part of HandlerOptions. Constructing
// these reviewed handlers must not publish either privacy request route.
type PrivacyRequestRuntime struct {
	ExpectedOrigin string
	Clock          func() int64
	Sessions       identity.SessionResolver
	Application    PrivacyRequestApplication
	NewRequestID   func() string
}

type PrivacyRequestContractHandlers struct {
	Submit http.Handler
	Status http.Handler
}

// NewPrivacyRequestContractHandlers returns disconnected handlers for contract
// and integration verification. NewHandler continues to install the closed
// public routes until a separate route-enablement review.
func NewPrivacyRequestContractHandlers(runtime *PrivacyRequestRuntime, logger *slog.Logger) (PrivacyRequestContractHandlers, error) {
	if !privacyRequestRuntimeComplete(runtime) || logger == nil {
		return PrivacyRequestContractHandlers{}, errors.New("complete privacy request runtime and logger are required")
	}
	return PrivacyRequestContractHandlers{
		Submit: http.HandlerFunc(privacyRequestSubmitHandler(runtime, logger)),
		Status: http.HandlerFunc(privacyRequestStatusHandler(runtime, logger)),
	}, nil
}

func privacyRequestSubmitHandler(runtime *PrivacyRequestRuntime, logger *slog.Logger) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !allowMethods(response, request, http.MethodPost) {
			return
		}
		now, vaultContext, handled := authenticatePrivacyRequest(response, request, runtime)
		if handled {
			return
		}
		body, status := readPrivacyRequestBody(response, request)
		if status != 0 {
			writePrivacyRequestBodyError(response, request, status)
			return
		}
		command, err := privacyrequest.DecodeSubmitCommand(body)
		if err != nil {
			writePrivacyRequestError(response, request, http.StatusBadRequest, "invalid-request")
			return
		}
		requestID, err := privacyrequest.ParseRequestID(runtime.NewRequestID())
		if err != nil {
			writePrivacyRequestError(response, request, http.StatusServiceUnavailable, "unavailable")
			return
		}
		result, err := runtime.Application.Submit(request.Context(), privacyrequest.Scope{
			AccountID: vaultContext.AccountID, VaultID: vaultContext.VaultID,
		}, command, requestID, now)
		if err != nil {
			logger.Error("privacy request failed", "error_code", "application_failure")
			writePrivacyRequestError(response, request, http.StatusServiceUnavailable, "unavailable")
			return
		}
		writePrivacyRequestResult(response, request, result, logger)
	}
}

func privacyRequestStatusHandler(runtime *PrivacyRequestRuntime, logger *slog.Logger) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !allowMethods(response, request, http.MethodPost) {
			return
		}
		_, vaultContext, handled := authenticatePrivacyRequest(response, request, runtime)
		if handled {
			return
		}
		body, status := readPrivacyRequestBody(response, request)
		if status != 0 {
			writePrivacyRequestBodyError(response, request, status)
			return
		}
		command, err := privacyrequest.DecodeStatusCommand(body)
		if err != nil {
			writePrivacyRequestError(response, request, http.StatusBadRequest, "invalid-request")
			return
		}
		result, err := runtime.Application.Status(request.Context(), privacyrequest.Scope{
			AccountID: vaultContext.AccountID, VaultID: vaultContext.VaultID,
		}, command.RequestID)
		if err != nil {
			logger.Error("privacy request failed", "error_code", "application_failure")
			writePrivacyRequestError(response, request, http.StatusServiceUnavailable, "unavailable")
			return
		}
		writePrivacyRequestResult(response, request, result, logger)
	}
}

func privacyRequestRuntimeComplete(runtime *PrivacyRequestRuntime) bool {
	if runtime == nil || runtime.Clock == nil || runtime.Sessions == nil ||
		runtime.Application == nil || runtime.NewRequestID == nil {
		return false
	}
	return identity.EvaluateCSRF(identity.CSRFInput{
		Method: http.MethodPost, ExpectedOrigin: runtime.ExpectedOrigin,
		OriginHeader: runtime.ExpectedOrigin, SecFetchSiteHeader: "same-origin",
	}).Kind == identity.CSRFAllowed
}

func authenticatePrivacyRequest(
	response http.ResponseWriter,
	request *http.Request,
	runtime *PrivacyRequestRuntime,
) (int64, identity.VaultContext, bool) {
	now := runtime.Clock()
	if now < 0 || now > identity.MaximumSafeInteger {
		writePrivacyRequestError(response, request, http.StatusServiceUnavailable, "unavailable")
		return 0, identity.VaultContext{}, true
	}
	origin, valid := singleHeader(request, "Origin")
	if !valid {
		writePrivacyRequestError(response, request, http.StatusForbidden, "forbidden")
		return 0, identity.VaultContext{}, true
	}
	secFetchSite, valid := singleHeader(request, "Sec-Fetch-Site")
	if !valid {
		writePrivacyRequestError(response, request, http.StatusForbidden, "forbidden")
		return 0, identity.VaultContext{}, true
	}
	resolved, err := identity.DeriveVaultContext(request.Context(), identity.SessionRequestMetadata{
		Method: request.Method, CookieHeaders: request.Header.Values("Cookie"),
		OriginHeader: origin, SecFetchSiteHeader: secFetchSite,
		ExpectedOrigin: runtime.ExpectedOrigin, Now: now,
	}, runtime.Sessions)
	if err != nil {
		writePrivacyRequestError(response, request, http.StatusServiceUnavailable, "unavailable")
		return 0, identity.VaultContext{}, true
	}
	switch resolved.Kind {
	case identity.ResolutionAuthenticated:
		return now, resolved.Context, false
	case identity.ResolutionForbidden:
		writePrivacyRequestError(response, request, http.StatusForbidden, "forbidden")
	default:
		writePrivacyRequestError(response, request, http.StatusUnauthorized, "authentication-required")
	}
	return 0, identity.VaultContext{}, true
}

func readPrivacyRequestBody(response http.ResponseWriter, request *http.Request) ([]byte, int) {
	declared := request.Header.Values("Content-Length")
	if len(declared) > 1 {
		return nil, http.StatusBadRequest
	}
	if len(declared) == 1 {
		length, err := strconv.ParseInt(declared[0], 10, 64)
		if err != nil || length < 0 {
			return nil, http.StatusBadRequest
		}
		if length > privacyrequest.MaximumRequestBytes {
			return nil, http.StatusRequestEntityTooLarge
		}
	}
	limited := http.MaxBytesReader(response, request.Body, privacyrequest.MaximumRequestBytes)
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

func writePrivacyRequestBodyError(response http.ResponseWriter, request *http.Request, status int) {
	code := "invalid-request"
	if status == http.StatusRequestEntityTooLarge {
		code = "request-too-large"
	}
	writePrivacyRequestError(response, request, status, code)
}

func writePrivacyRequestResult(
	response http.ResponseWriter,
	request *http.Request,
	result privacyrequest.ApplicationResult,
	logger *slog.Logger,
) {
	if result.Kind == privacyrequest.ApplicationRejected {
		switch result.Reason {
		case privacyrequest.ApplicationIdentifierConflict, privacyrequest.ApplicationInvalidState:
			writePrivacyRequestError(response, request, http.StatusConflict, "request-conflict")
		case privacyrequest.ApplicationInvalidInput:
			writePrivacyRequestError(response, request, http.StatusBadRequest, "invalid-request")
		case privacyrequest.ApplicationNotFound:
			writePrivacyRequestError(response, request, http.StatusNotFound, "not-found")
		default:
			writePrivacyRequestError(response, request, http.StatusServiceUnavailable, "unavailable")
		}
		return
	}
	if result.Kind != privacyrequest.ApplicationAccepted || result.Request == nil {
		writePrivacyRequestError(response, request, http.StatusServiceUnavailable, "unavailable")
		return
	}
	encoded, err := privacyrequest.EncodePublicStatus(*result.Request)
	if err != nil {
		logger.Error("privacy request failed", "error_code", "invalid_application_response")
		writePrivacyRequestError(response, request, http.StatusServiceUnavailable, "unavailable")
		return
	}
	status := http.StatusAccepted
	switch result.Request.Status {
	case privacyrequest.StateCompleted, privacyrequest.StateRejected, privacyrequest.StateFailed:
		status = http.StatusOK
	}
	writePrivacyRequestBytes(response, request, status, encoded)
}

func writePrivacyRequestError(response http.ResponseWriter, request *http.Request, status int, code string) {
	writeJSON(response, request, status, map[string]string{"error": code})
}

func writePrivacyRequestBytes(response http.ResponseWriter, request *http.Request, status int, content []byte) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	if request.Method != http.MethodHead {
		_, _ = response.Write(content)
	}
}

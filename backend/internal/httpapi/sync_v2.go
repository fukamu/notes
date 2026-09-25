package httpapi

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/syncv2"
)

type SyncV2Entitlement interface {
	AuthorizeCapability(context.Context, identity.VaultContext, entitlement.Capability, int64) entitlement.Decision
	ReadLimits(context.Context, identity.VaultContext, int64) entitlement.LimitDecision
}

type SyncV2Application interface {
	Synchronize(context.Context, syncv2.SynchronizeInput) (syncv2.ApplicationResult, error)
}

var (
	_ SyncV2Entitlement = (*entitlement.Service)(nil)
	_ SyncV2Application = (*syncv2.Application)(nil)
)

// SyncV2Runtime is deliberately not part of HandlerOptions. Building this
// reviewed composition must not publish /api/v2/sync; NewHandler continues to
// install the closed 404/503 route until a separate public-enablement change.
type SyncV2Runtime struct {
	ExpectedOrigin string
	Clock          func() int64
	Sessions       identity.SessionResolver
	Entitlement    SyncV2Entitlement
	Application    SyncV2Application
}

// NewSyncV2ContractHandler returns the disconnected handler used by contract
// and integration tests. Callers must not mount it in the public mux without a
// separately reviewed route-enablement change.
func NewSyncV2ContractHandler(runtime *SyncV2Runtime, logger *slog.Logger) (http.Handler, error) {
	if !syncV2RuntimeComplete(runtime) || logger == nil {
		return nil, errors.New("complete Sync v2 runtime and logger are required")
	}
	return http.HandlerFunc(syncV2ContractHandler(runtime, logger)), nil
}

func syncV2ContractHandler(runtime *SyncV2Runtime, logger *slog.Logger) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !allowMethods(response, request, http.MethodPost) {
			return
		}
		now := runtime.Clock()
		if now < 0 || now > identity.MaximumSafeInteger {
			writeSyncV2Error(response, request, http.StatusServiceUnavailable, "unavailable")
			return
		}
		vaultContext, handled := authenticateSyncV2Request(response, request, runtime, now)
		if handled {
			return
		}
		body, status := readSyncV2Body(response, request)
		if status != 0 {
			code := "invalid-request"
			if status == http.StatusRequestEntityTooLarge {
				code = "request-too-large"
			}
			writeSyncV2Error(response, request, status, code)
			return
		}
		syncRequest, err := syncv2.DecodeRequest(body)
		if err != nil {
			writeSyncV2Error(response, request, http.StatusBadRequest, "invalid-request")
			return
		}
		access := runtime.Entitlement.AuthorizeCapability(
			request.Context(), vaultContext, entitlement.CapabilityNotesSync, now,
		)
		if status, code, rejected := syncV2EntitlementRejection(access.Reason, access.Kind); rejected {
			writeSyncV2Error(response, request, status, code)
			return
		}
		if access.Capability != entitlement.CapabilityNotesSync {
			writeSyncV2Error(response, request, http.StatusForbidden, "forbidden")
			return
		}
		limits := runtime.Entitlement.ReadLimits(request.Context(), vaultContext, now)
		if limits.Kind != entitlement.LimitsAvailable {
			status, code, _ := syncV2EntitlementRejection(limits.Reason, entitlement.DecisionDenied)
			writeSyncV2Error(response, request, status, code)
			return
		}
		result, err := runtime.Application.Synchronize(request.Context(), syncv2.SynchronizeInput{
			Context: vaultContext, Request: syncRequest, SynchronizedAt: now,
			RequestBytes: int64(len(body)), Limits: limits.Limits,
		})
		if err != nil {
			logger.Error("sync v2 failed", "error_code", "application_failure")
			writeSyncV2Error(response, request, http.StatusServiceUnavailable, "unavailable")
			return
		}
		if result.Kind != syncv2.ApplicationSynchronized {
			status, code := syncV2ApplicationRejection(result.Reason)
			writeSyncV2Error(response, request, status, code)
			return
		}
		encoded, err := syncv2.EncodeResponse(result.Response)
		if err != nil {
			logger.Error("sync v2 failed", "error_code", "invalid_application_response")
			writeSyncV2Error(response, request, http.StatusServiceUnavailable, "unavailable")
			return
		}
		writeSyncV2Bytes(response, request, http.StatusOK, encoded)
	}
}

func syncV2RuntimeComplete(runtime *SyncV2Runtime) bool {
	if runtime == nil || runtime.Clock == nil || runtime.Sessions == nil ||
		runtime.Entitlement == nil || runtime.Application == nil {
		return false
	}
	return identity.EvaluateCSRF(identity.CSRFInput{
		Method: http.MethodPost, ExpectedOrigin: runtime.ExpectedOrigin,
		OriginHeader: runtime.ExpectedOrigin, SecFetchSiteHeader: "same-origin",
	}).Kind == identity.CSRFAllowed
}

func authenticateSyncV2Request(
	response http.ResponseWriter,
	request *http.Request,
	runtime *SyncV2Runtime,
	now int64,
) (identity.VaultContext, bool) {
	origin, valid := singleHeader(request, "Origin")
	if !valid {
		writeSyncV2Error(response, request, http.StatusForbidden, "forbidden")
		return identity.VaultContext{}, true
	}
	secFetchSite, valid := singleHeader(request, "Sec-Fetch-Site")
	if !valid {
		writeSyncV2Error(response, request, http.StatusForbidden, "forbidden")
		return identity.VaultContext{}, true
	}
	resolved, err := identity.DeriveVaultContext(request.Context(), identity.SessionRequestMetadata{
		Method: request.Method, CookieHeaders: request.Header.Values("Cookie"),
		OriginHeader: origin, SecFetchSiteHeader: secFetchSite,
		ExpectedOrigin: runtime.ExpectedOrigin, Now: now,
	}, runtime.Sessions)
	if err != nil {
		writeSyncV2Error(response, request, http.StatusServiceUnavailable, "unavailable")
		return identity.VaultContext{}, true
	}
	switch resolved.Kind {
	case identity.ResolutionAuthenticated:
		return resolved.Context, false
	case identity.ResolutionForbidden:
		writeSyncV2Error(response, request, http.StatusForbidden, "forbidden")
	default:
		writeSyncV2Error(response, request, http.StatusUnauthorized, "authentication-required")
	}
	return identity.VaultContext{}, true
}

func readSyncV2Body(response http.ResponseWriter, request *http.Request) ([]byte, int) {
	declared := request.Header.Values("Content-Length")
	if len(declared) > 1 {
		return nil, http.StatusBadRequest
	}
	if len(declared) == 1 {
		length, err := strconv.ParseInt(declared[0], 10, 64)
		if err != nil || length < 0 {
			return nil, http.StatusBadRequest
		}
		if length > syncv2.MaximumRequestBytes {
			return nil, http.StatusRequestEntityTooLarge
		}
	}
	limited := http.MaxBytesReader(response, request.Body, syncv2.MaximumRequestBytes)
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

func syncV2EntitlementRejection(
	reason entitlement.DenialReason,
	kind entitlement.DecisionKind,
) (int, string, bool) {
	if kind == entitlement.DecisionAllowed {
		return 0, "", false
	}
	switch reason {
	case entitlement.DenialOwnerMismatch:
		return http.StatusForbidden, "forbidden", true
	case entitlement.DenialBillingUnavailable,
		entitlement.DenialEntitlementUnavailable,
		entitlement.DenialInvalidInput,
		entitlement.DenialProjectionConflict:
		return http.StatusServiceUnavailable, "unavailable", true
	case entitlement.DenialSubscriptionRequired,
		entitlement.DenialLeasePolicyUndecided,
		entitlement.DenialLeaseNotFound,
		entitlement.DenialLeaseExpired,
		entitlement.DenialLeaseRevoked,
		entitlement.DenialLeaseScopeMismatch,
		entitlement.DenialOnlineRequired,
		entitlement.DenialIdentifierConflict,
		entitlement.DenialReason(entitlement.LockCheckoutIncomplete),
		entitlement.DenialReason(entitlement.LockPaymentMethodRequired),
		entitlement.DenialReason(entitlement.LockTrialExpired),
		entitlement.DenialReason(entitlement.LockPaidPeriodExpired),
		entitlement.DenialReason(entitlement.LockPaymentFailed),
		entitlement.DenialReason(entitlement.LockPaymentActionRequired),
		entitlement.DenialReason(entitlement.LockCancelled):
		return http.StatusPaymentRequired, "online-access-locked", true
	default:
		return http.StatusServiceUnavailable, "unavailable", true
	}
}

func syncV2ApplicationRejection(reason syncv2.ApplicationRejectionReason) (int, string) {
	switch reason {
	case syncv2.ApplicationInvalidCursor:
		return http.StatusBadRequest, "invalid-request"
	case syncv2.ApplicationIdempotencyKeyReuse, syncv2.ApplicationMutationConflict:
		return http.StatusConflict, "sync-conflict"
	case syncv2.ApplicationScopeUnavailable, syncv2.ApplicationQuotaUnavailable:
		return http.StatusServiceUnavailable, "unavailable"
	case syncv2.ApplicationRequestLimit:
		return http.StatusRequestEntityTooLarge, "request-too-large"
	case syncv2.ApplicationDisplayCharacterLimit, syncv2.ApplicationSerializedPlaintextLimit:
		return http.StatusRequestEntityTooLarge, "card-too-large"
	case syncv2.ApplicationCiphertextLimit:
		return http.StatusRequestEntityTooLarge, "encrypted-content-too-large"
	case syncv2.ApplicationActiveCardLimit, syncv2.ApplicationVaultPlaintextLimit:
		return http.StatusConflict, "quota-exceeded"
	default:
		return http.StatusServiceUnavailable, "unavailable"
	}
}

func writeSyncV2Error(response http.ResponseWriter, request *http.Request, status int, code string) {
	writeJSON(response, request, status, map[string]string{"error": code})
}

func writeSyncV2Bytes(response http.ResponseWriter, request *http.Request, status int, content []byte) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	if request.Method != http.MethodHead {
		_, _ = response.Write(content)
	}
}

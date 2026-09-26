package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/identity"
)

type PeriodEndCancellationApplication interface {
	ScheduleSubscriptionCancellation(context.Context, billing.SubscriptionCancellationCommand) (billing.SubscriptionCancellationResult, error)
}

var _ PeriodEndCancellationApplication = (*billing.CancellationService)(nil)

// BillingCancellationRuntime is supplied only by the explicit local-fixture
// composition. A nil runtime keeps the route closed.
type BillingCancellationRuntime struct {
	ExpectedOrigin string
	Clock          func() int64
	Sessions       identity.SessionResolver
	Cancellation   PeriodEndCancellationApplication
}

// NewBillingCancellationContractHandler retains a focused constructor for
// contract tests and future reviewed compositions.
func NewBillingCancellationContractHandler(
	runtime *BillingCancellationRuntime,
	logger *slog.Logger,
) (http.Handler, error) {
	if !billingCancellationRuntimeComplete(runtime) || logger == nil {
		return nil, errors.New("complete billing cancellation runtime and logger are required")
	}
	return http.HandlerFunc(billingCancellationHandler(runtime, logger)), nil
}

func billingCancellationRoute(options HandlerOptions) http.HandlerFunc {
	if options.BillingCancellationRuntime == nil {
		return disconnectedPublicAPI(options.EnableDisconnectedFixtures, http.MethodPost)
	}
	if !billingCancellationRuntimeComplete(options.BillingCancellationRuntime) {
		return func(response http.ResponseWriter, request *http.Request) {
			if allowMethods(response, request, http.MethodPost) {
				writeBillingCancellationError(response, request, http.StatusServiceUnavailable, "unavailable")
			}
		}
	}
	return billingCancellationHandler(options.BillingCancellationRuntime, options.Logger)
}

type billingCancellationBody struct {
	IdempotencyKey string `json:"idempotencyKey"`
}

func billingCancellationHandler(runtime *BillingCancellationRuntime, logger *slog.Logger) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !allowMethods(response, request, http.MethodPost) {
			return
		}
		now, vaultContext, handled := authenticateBillingCancellation(response, request, runtime)
		if handled {
			return
		}
		var body billingCancellationBody
		switch readLegalJSON(response, request, &body) {
		case legalBodyTooLarge:
			writeBillingCancellationError(response, request, http.StatusRequestEntityTooLarge, "request-too-large")
			return
		case legalBodyInvalid:
			writeBillingCancellationError(response, request, http.StatusBadRequest, "invalid-request")
			return
		case legalBodyRead:
		default:
			writeBillingCancellationError(response, request, http.StatusBadRequest, "invalid-request")
			return
		}
		idempotencyKey, err := billing.ParseCancellationIdempotencyKey(body.IdempotencyKey)
		if err != nil {
			writeBillingCancellationError(response, request, http.StatusBadRequest, "invalid-request")
			return
		}
		result, err := runtime.Cancellation.ScheduleSubscriptionCancellation(
			request.Context(),
			billing.SubscriptionCancellationCommand{
				Scope: billing.OwnerScope{
					AccountID: vaultContext.AccountID,
					VaultID:   vaultContext.VaultID,
				},
				IdempotencyKey: idempotencyKey,
				RequestedAt:    now,
			},
		)
		if err != nil {
			logger.Error("billing cancellation failed", "error_code", "application_failure")
			writeBillingCancellationError(response, request, http.StatusServiceUnavailable, "unavailable")
			return
		}
		writeBillingCancellationResult(response, request, result, logger)
	}
}

func billingCancellationRuntimeComplete(runtime *BillingCancellationRuntime) bool {
	if runtime == nil || runtime.Clock == nil || runtime.Sessions == nil || runtime.Cancellation == nil {
		return false
	}
	return identity.EvaluateCSRF(identity.CSRFInput{
		Method: http.MethodPost, ExpectedOrigin: runtime.ExpectedOrigin,
		OriginHeader: runtime.ExpectedOrigin, SecFetchSiteHeader: "same-origin",
	}).Kind == identity.CSRFAllowed
}

func authenticateBillingCancellation(
	response http.ResponseWriter,
	request *http.Request,
	runtime *BillingCancellationRuntime,
) (int64, identity.VaultContext, bool) {
	now := runtime.Clock()
	if now < 0 || now > identity.MaximumSafeInteger {
		writeBillingCancellationError(response, request, http.StatusServiceUnavailable, "unavailable")
		return 0, identity.VaultContext{}, true
	}
	origin, originValid := singleHeader(request, "Origin")
	secFetchSite, siteValid := singleHeader(request, "Sec-Fetch-Site")
	if !originValid || !siteValid {
		writeBillingCancellationError(response, request, http.StatusForbidden, "forbidden")
		return 0, identity.VaultContext{}, true
	}
	resolved, err := identity.DeriveVaultContext(request.Context(), identity.SessionRequestMetadata{
		Method: request.Method, CookieHeaders: request.Header.Values("Cookie"),
		OriginHeader: origin, SecFetchSiteHeader: secFetchSite,
		ExpectedOrigin: runtime.ExpectedOrigin, Now: now,
	}, runtime.Sessions)
	if err != nil {
		writeBillingCancellationError(response, request, http.StatusServiceUnavailable, "unavailable")
		return 0, identity.VaultContext{}, true
	}
	switch resolved.Kind {
	case identity.ResolutionAuthenticated:
		return now, resolved.Context, false
	case identity.ResolutionForbidden:
		writeBillingCancellationError(response, request, http.StatusForbidden, "forbidden")
	default:
		writeBillingCancellationError(response, request, http.StatusUnauthorized, "authentication-required")
	}
	return 0, identity.VaultContext{}, true
}

func writeBillingCancellationResult(
	response http.ResponseWriter,
	request *http.Request,
	result billing.SubscriptionCancellationResult,
	logger *slog.Logger,
) {
	switch result.Kind {
	case billing.SubscriptionCancellationConfirmed:
		if (result.Outcome != billing.SubscriptionCancellationScheduled &&
			result.Outcome != billing.SubscriptionAlreadyCancelled) ||
			result.ConfirmedAt < 0 || result.ConfirmedAt > identity.MaximumSafeInteger ||
			result.AccessEndsAt < 0 || result.AccessEndsAt > identity.MaximumSafeInteger {
			logger.Error("billing cancellation failed", "error_code", "invalid_application_response")
			writeBillingCancellationError(response, request, http.StatusServiceUnavailable, "unavailable")
			return
		}
		status := "cancellation-scheduled"
		if result.Outcome == billing.SubscriptionAlreadyCancelled {
			status = "cancelled"
		}
		writeJSON(response, request, http.StatusOK, map[string]any{
			"status": status, "outcome": result.Outcome,
			"confirmedAt": result.ConfirmedAt, "accessEndsAt": result.AccessEndsAt,
		})
	case billing.SubscriptionCancellationRetryableFailure:
		writeBillingCancellationError(response, request, http.StatusServiceUnavailable, "unavailable")
	case billing.SubscriptionCancellationTerminalFailure:
		switch result.Reason {
		case billing.CancellationInvalidCommand:
			writeBillingCancellationError(response, request, http.StatusBadRequest, "invalid-request")
		case billing.CancellationOwnerMismatch:
			writeBillingCancellationError(response, request, http.StatusForbidden, "forbidden")
		case billing.CancellationSubscriptionNotFound, billing.CancellationInvalidSubscriptionState,
			billing.CancellationProviderNotLinked, billing.CancellationProviderTerminal:
			writeBillingCancellationError(response, request, http.StatusConflict, "cancellation-unavailable")
		default:
			writeBillingCancellationError(response, request, http.StatusServiceUnavailable, "unavailable")
		}
	default:
		logger.Error("billing cancellation failed", "error_code", "invalid_application_response")
		writeBillingCancellationError(response, request, http.StatusServiceUnavailable, "unavailable")
	}
}

func writeBillingCancellationError(response http.ResponseWriter, request *http.Request, status int, code string) {
	writeJSON(response, request, status, map[string]string{"error": code})
}

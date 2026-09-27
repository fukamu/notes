package httpapi

import (
	"context"
	"net/http"

	"github.com/fukamu/notes/backend/internal/featureflag"
	"github.com/fukamu/notes/backend/internal/identity"
)

type FeatureFlagEvaluator interface {
	Evaluate(context.Context, featureflag.Name, identity.AccountID) (featureflag.Decision, error)
}

type ProductionFeatureRuntime struct {
	ExpectedOrigin string
	Access         *SessionAccessRuntime
	Flags          FeatureFlagEvaluator
}

func productionFeatureRuntimeComplete(runtime *ProductionFeatureRuntime) bool {
	if runtime == nil || runtime.Access == nil || runtime.Access.Clock == nil ||
		runtime.Access.Sessions == nil || runtime.Access.Admission == nil || runtime.Flags == nil {
		return false
	}
	return identity.EvaluateCSRF(identity.CSRFInput{
		Method: http.MethodPost, ExpectedOrigin: runtime.ExpectedOrigin,
		OriginHeader: runtime.ExpectedOrigin, SecFetchSiteHeader: "same-origin",
	}).Kind == identity.CSRFAllowed
}

// productionCheckoutByFeature keeps checkout side effects absent unless both
// the server-side flag and a future checkout composition are explicitly
// connected. Enabling the flag alone therefore cannot charge a user.
func productionCheckoutByFeature(runtime *ProductionFeatureRuntime) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		setLaunchPrivateHeaders(response)
		if !allowMethods(response, request, http.MethodGet, http.MethodPost) {
			return
		}
		if !productionFeatureRuntimeComplete(runtime) {
			writeLaunchUnavailable(response, request)
			return
		}
		now := runtime.Access.Clock()
		if now < 0 || now > identity.MaximumSafeInteger {
			writeLaunchUnavailable(response, request)
			return
		}
		metadata := identity.SessionRequestMetadata{
			Method: request.Method, CookieHeaders: request.Header.Values("Cookie"),
			ExpectedOrigin: runtime.ExpectedOrigin, Now: now,
		}
		if request.Method == http.MethodPost {
			origin, valid := singleHeader(request, "Origin")
			if !valid {
				writeLaunchDenied(response, request)
				return
			}
			secFetchSite, valid := singleHeader(request, "Sec-Fetch-Site")
			if !valid {
				writeLaunchDenied(response, request)
				return
			}
			metadata.OriginHeader = origin
			metadata.SecFetchSiteHeader = secFetchSite
		}
		resolved, err := identity.DeriveVaultContext(request.Context(), metadata, runtime.Access.Sessions)
		if err != nil {
			writeLaunchUnavailable(response, request)
			return
		}
		if resolved.Kind != identity.ResolutionAuthenticated {
			writeSyncV2Error(response, request, http.StatusUnauthorized, "authentication-required")
			return
		}
		admission, err := runtime.Access.Admission.AuthorizeVault(request.Context(), resolved.Context)
		if err != nil {
			writeLaunchUnavailable(response, request)
			return
		}
		if !admission.CanAccess {
			writeLaunchDenied(response, request)
			return
		}
		decision, err := runtime.Flags.Evaluate(
			request.Context(), featureflag.BillingCheckout, resolved.Context.AccountID,
		)
		if err != nil {
			writeLaunchUnavailable(response, request)
			return
		}
		if decision.Kind != featureflag.DecisionEnabled {
			writeError(response, request, http.StatusNotFound, "not_found")
			return
		}
		writeJSON(response, request, http.StatusServiceUnavailable, map[string]string{
			"error": "checkout-not-connected",
		})
	}
}

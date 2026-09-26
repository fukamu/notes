package httpapi

import (
	"net/http"

	"github.com/fukamu/notes/backend/internal/identity"
)

type sessionContextResponse struct {
	AccountID    string `json:"accountId"`
	VaultID      string `json:"vaultId"`
	SessionID    string `json:"sessionId"`
	SessionEpoch int64  `json:"sessionEpoch"`
}

func sessionContext(runtime *SyncV2Runtime) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Cache-Control", "private, no-store")
		response.Header().Set("Vary", "Cookie")
		if !allowMethods(response, request, http.MethodGet) {
			return
		}
		if request.URL.RawQuery != "" || !syncV2RuntimeComplete(runtime) {
			writeSyncV2Error(response, request, http.StatusBadRequest, "invalid-request")
			return
		}
		now := runtime.Clock()
		if now < 0 || now > identity.MaximumSafeInteger {
			writeSyncV2Error(response, request, http.StatusServiceUnavailable, "unavailable")
			return
		}
		resolved, err := identity.DeriveVaultContext(
			request.Context(),
			identity.SessionRequestMetadata{
				Method: request.Method, CookieHeaders: request.Header.Values("Cookie"),
				ExpectedOrigin: runtime.ExpectedOrigin, Now: now,
			},
			runtime.Sessions,
		)
		if err != nil {
			writeSyncV2Error(response, request, http.StatusServiceUnavailable, "unavailable")
			return
		}
		if resolved.Kind != identity.ResolutionAuthenticated {
			writeSyncV2Error(response, request, http.StatusUnauthorized, "authentication-required")
			return
		}
		if request.ContentLength != 0 || len(request.TransferEncoding) != 0 {
			writeSyncV2Error(response, request, http.StatusBadRequest, "invalid-request")
			return
		}
		writeJSON(response, request, http.StatusOK, sessionContextResponse{
			AccountID: string(resolved.Context.AccountID), VaultID: string(resolved.Context.VaultID),
			SessionID: string(resolved.Context.SessionID), SessionEpoch: int64(resolved.Context.SessionEpoch),
		})
	}
}

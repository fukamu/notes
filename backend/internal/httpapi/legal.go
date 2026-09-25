package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"unicode/utf8"

	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/legal"
)

const legalRequestBodyLimitBytes int64 = 2_048

type TermsConsentApplication interface {
	Status(context.Context, legal.TermsScope) legal.ApplicationResult
	Accept(
		context.Context,
		legal.TermsScope,
		legal.TermsConsentCommand,
		legal.TermsConsentID,
		int64,
	) legal.ApplicationResult
}

type ContractCheckoutApplication interface {
	PrepareOffer(context.Context) legal.PrepareContractOfferResult
	Confirm(
		context.Context,
		identity.VaultContext,
		legal.ContractConfirmationCommand,
		legal.ContractEvidenceID,
		int64,
	) legal.ContractCheckoutResult
}

var (
	_ TermsConsentApplication     = (*legal.TermsConsentService)(nil)
	_ ContractCheckoutApplication = (*legal.ContractCheckoutApplication)(nil)
)

// LegalRuntime is deliberately separate from PrivateRuntime. Supplying the
// launch-gate runtime must not accidentally publish signup, terms, or billing.
// The command composition leaves this nil until identity, legal text, pricing,
// and provider configuration have been reviewed together.
type LegalRuntime struct {
	ExpectedOrigin        string
	Clock                 func() int64
	Sessions              identity.SessionResolver
	Terms                 TermsConsentApplication
	Checkout              ContractCheckoutApplication
	NewTermsConsentID     func() string
	NewContractEvidenceID func() string
}

func termsConsentRoute(options HandlerOptions) http.HandlerFunc {
	if options.LegalRuntime == nil {
		return disconnectedProtectedAPI(
			options.PrivateRuntime,
			options.EnableLocalFixtures,
			http.MethodGet,
			http.MethodPost,
		)
	}
	return termsConsentHandler(options.LegalRuntime, options.Logger)
}

func checkoutRoute(options HandlerOptions) http.HandlerFunc {
	if options.LegalRuntime == nil {
		return disconnectedProtectedAPI(
			options.PrivateRuntime,
			options.EnableLocalFixtures,
			http.MethodGet,
			http.MethodPost,
		)
	}
	return contractCheckoutHandler(options.LegalRuntime, options.Logger)
}

func termsConsentHandler(runtime *LegalRuntime, logger *slog.Logger) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !allowMethods(response, request, http.MethodGet, http.MethodPost) {
			return
		}
		now, ok := readLegalClock(runtime)
		if !ok || !legalRuntimeComplete(runtime) {
			writeLegalError(response, request, http.StatusServiceUnavailable, "unavailable")
			return
		}
		vaultContext, handled := authenticateLegalRequest(response, request, runtime, now)
		if handled {
			return
		}
		if request.Method == http.MethodGet {
			result, ok := callTermsStatus(request.Context(), runtime.Terms, legal.TermsScope{
				AccountID: vaultContext.AccountID,
				VaultID:   vaultContext.VaultID,
			})
			if !ok {
				logLegalFailure(logger, "terms_status_panic")
				writeLegalError(response, request, http.StatusServiceUnavailable, "unavailable")
				return
			}
			writeTermsApplicationResult(response, request, result)
			return
		}

		var body termsConsentCommandBody
		switch readLegalJSON(response, request, &body) {
		case legalBodyTooLarge:
			writeLegalError(response, request, http.StatusRequestEntityTooLarge, "request-too-large")
			return
		case legalBodyInvalid:
			writeLegalError(response, request, http.StatusBadRequest, "invalid-request")
			return
		case legalBodyRead:
		default:
			writeLegalError(response, request, http.StatusBadRequest, "invalid-request")
			return
		}
		command, ok := body.decode()
		if !ok {
			writeLegalError(response, request, http.StatusBadRequest, "invalid-request")
			return
		}
		consentID, ok := createTermsConsentID(runtime)
		if !ok {
			writeLegalError(response, request, http.StatusServiceUnavailable, "unavailable")
			return
		}
		result, ok := callTermsAccept(
			request.Context(),
			runtime.Terms,
			legal.TermsScope{AccountID: vaultContext.AccountID, VaultID: vaultContext.VaultID},
			command,
			consentID,
			now,
		)
		if !ok {
			logLegalFailure(logger, "terms_accept_panic")
			writeLegalError(response, request, http.StatusServiceUnavailable, "unavailable")
			return
		}
		writeTermsApplicationResult(response, request, result)
	}
}

func contractCheckoutHandler(runtime *LegalRuntime, logger *slog.Logger) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !allowMethods(response, request, http.MethodGet, http.MethodPost) {
			return
		}
		now, ok := readLegalClock(runtime)
		if !ok || !legalRuntimeComplete(runtime) {
			writeLegalError(response, request, http.StatusServiceUnavailable, "unavailable")
			return
		}
		vaultContext, handled := authenticateLegalRequest(response, request, runtime, now)
		if handled {
			return
		}
		if request.Method == http.MethodGet {
			result, ok := callPrepareOffer(request.Context(), runtime.Checkout)
			if !ok {
				logLegalFailure(logger, "checkout_offer_panic")
				writeLegalError(response, request, http.StatusServiceUnavailable, "unavailable")
				return
			}
			if result.Kind != legal.PrepareContractAvailable {
				writeLegalError(response, request, http.StatusServiceUnavailable, "unavailable")
				return
			}
			writeJSON(response, request, http.StatusOK, contractOfferResponse{
				Offer: result.Prepared.Offer, OfferHash: result.Prepared.OfferHash,
			})
			return
		}

		var body contractConfirmationCommandBody
		switch readLegalJSON(response, request, &body) {
		case legalBodyTooLarge:
			writeLegalError(response, request, http.StatusRequestEntityTooLarge, "request-too-large")
			return
		case legalBodyInvalid:
			writeLegalError(response, request, http.StatusBadRequest, "invalid-request")
			return
		case legalBodyRead:
		default:
			writeLegalError(response, request, http.StatusBadRequest, "invalid-request")
			return
		}
		command, ok := body.decode()
		if !ok {
			writeLegalError(response, request, http.StatusBadRequest, "invalid-request")
			return
		}
		evidenceID, ok := createContractEvidenceID(runtime)
		if !ok {
			writeLegalError(response, request, http.StatusServiceUnavailable, "unavailable")
			return
		}
		result, ok := callConfirmCheckout(
			request.Context(), runtime.Checkout, vaultContext, command, evidenceID, now,
		)
		if !ok {
			logLegalFailure(logger, "checkout_confirm_panic")
			writeLegalError(response, request, http.StatusServiceUnavailable, "unavailable")
			return
		}
		writeContractCheckoutResult(response, request, result)
	}
}

func legalRuntimeComplete(runtime *LegalRuntime) bool {
	if runtime == nil || runtime.Clock == nil || runtime.Sessions == nil || runtime.Terms == nil ||
		runtime.Checkout == nil || runtime.NewTermsConsentID == nil || runtime.NewContractEvidenceID == nil {
		return false
	}
	return identity.EvaluateCSRF(identity.CSRFInput{
		Method: "POST", ExpectedOrigin: runtime.ExpectedOrigin,
		OriginHeader: runtime.ExpectedOrigin, SecFetchSiteHeader: "same-origin",
	}).Kind == identity.CSRFAllowed
}

func authenticateLegalRequest(
	response http.ResponseWriter,
	request *http.Request,
	runtime *LegalRuntime,
	now int64,
) (identity.VaultContext, bool) {
	origin, valid := singleHeader(request, "Origin")
	if !valid {
		writeLegalError(response, request, http.StatusForbidden, "forbidden")
		return identity.VaultContext{}, true
	}
	secFetchSite, valid := singleHeader(request, "Sec-Fetch-Site")
	if !valid {
		writeLegalError(response, request, http.StatusForbidden, "forbidden")
		return identity.VaultContext{}, true
	}
	result, err := identity.DeriveVaultContext(request.Context(), identity.SessionRequestMetadata{
		Method: request.Method, CookieHeaders: request.Header.Values("Cookie"),
		OriginHeader: origin, SecFetchSiteHeader: secFetchSite,
		ExpectedOrigin: runtime.ExpectedOrigin, Now: now,
	}, runtime.Sessions)
	if err != nil {
		writeLegalError(response, request, http.StatusServiceUnavailable, "unavailable")
		return identity.VaultContext{}, true
	}
	switch result.Kind {
	case identity.ResolutionAuthenticated:
		return result.Context, false
	case identity.ResolutionForbidden:
		writeLegalError(response, request, http.StatusForbidden, "forbidden")
	default:
		writeLegalError(response, request, http.StatusUnauthorized, "authentication-required")
	}
	return identity.VaultContext{}, true
}

func singleHeader(request *http.Request, name string) (string, bool) {
	values := request.Header.Values(name)
	if len(values) == 0 {
		return "", true
	}
	if len(values) != 1 {
		return "", false
	}
	return values[0], true
}

type legalBodyResult string

const (
	legalBodyRead     legalBodyResult = "read"
	legalBodyInvalid  legalBodyResult = "invalid"
	legalBodyTooLarge legalBodyResult = "too-large"
)

func readLegalJSON(response http.ResponseWriter, request *http.Request, destination any) legalBodyResult {
	if request.ContentLength < -1 {
		return legalBodyInvalid
	}
	if request.ContentLength > legalRequestBodyLimitBytes {
		return legalBodyTooLarge
	}
	limited := http.MaxBytesReader(response, request.Body, legalRequestBodyLimitBytes)
	content, err := io.ReadAll(limited)
	if err != nil {
		var maximumBytesError *http.MaxBytesError
		if errors.As(err, &maximumBytesError) {
			return legalBodyTooLarge
		}
		return legalBodyInvalid
	}
	if !utf8.Valid(content) {
		return legalBodyInvalid
	}
	if bytes.HasPrefix(content, []byte{0xef, 0xbb, 0xbf}) {
		content = content[3:]
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return legalBodyInvalid
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return legalBodyInvalid
	}
	return legalBodyRead
}

type consentBody struct {
	Kind string `json:"kind"`
}

type termsConsentCommandBody struct {
	SubmissionID          string      `json:"submissionId"`
	PresentedTermsVersion string      `json:"presentedTermsVersion"`
	PresentedTermsHash    string      `json:"presentedTermsHash"`
	Consent               consentBody `json:"consent"`
}

func (body termsConsentCommandBody) decode() (legal.TermsConsentCommand, bool) {
	submissionID, submissionErr := legal.ParseTermsConsentSubmissionID(body.SubmissionID)
	version, versionErr := legal.ParseTermsVersion(body.PresentedTermsVersion)
	hash, hashErr := legal.ParseTermsDocumentHash(body.PresentedTermsHash)
	consent, consentOK := decodeTermsConsent(body.Consent.Kind)
	if submissionErr != nil || versionErr != nil || hashErr != nil || !consentOK {
		return legal.TermsConsentCommand{}, false
	}
	return legal.TermsConsentCommand{
		SubmissionID: submissionID, PresentedTermsVersion: version,
		PresentedTermsHash: hash, Consent: consent,
	}, true
}

func decodeTermsConsent(value string) (legal.ConsentChoice, bool) {
	switch value {
	case string(legal.ConsentAffirmed):
		return legal.ConsentAffirmed, true
	case string(legal.ConsentNotAffirmed):
		return legal.ConsentNotAffirmed, true
	default:
		return "", false
	}
}

type contractConfirmationCommandBody struct {
	SubmissionID       string      `json:"submissionId"`
	PresentedOfferHash string      `json:"presentedOfferHash"`
	Consent            consentBody `json:"consent"`
}

func (body contractConfirmationCommandBody) decode() (legal.ContractConfirmationCommand, bool) {
	submissionID, submissionErr := legal.ParseContractSubmissionID(body.SubmissionID)
	hash, hashErr := legal.ParseContractOfferHash(body.PresentedOfferHash)
	consent, consentOK := decodeContractConsent(body.Consent.Kind)
	if submissionErr != nil || hashErr != nil || !consentOK {
		return legal.ContractConfirmationCommand{}, false
	}
	return legal.ContractConfirmationCommand{
		SubmissionID: submissionID, PresentedOfferHash: hash, Consent: consent,
	}, true
}

func decodeContractConsent(value string) (legal.ContractConsent, bool) {
	switch value {
	case string(legal.ContractConsentAffirmed):
		return legal.ContractConsentAffirmed, true
	case string(legal.ContractConsentNotAffirmed):
		return legal.ContractConsentNotAffirmed, true
	default:
		return "", false
	}
}

type currentTermsResponse struct {
	TermsVersion  legal.TermsVersion      `json:"termsVersion"`
	TermsHash     legal.TermsDocumentHash `json:"termsHash"`
	EffectiveDate string                  `json:"effectiveDate"`
}

type acceptedTermsResponse struct {
	ConsentID    legal.TermsConsentID    `json:"consentId"`
	TermsVersion legal.TermsVersion      `json:"termsVersion"`
	TermsHash    legal.TermsDocumentHash `json:"termsHash"`
	AcceptedAt   int64                   `json:"acceptedAt"`
}

type termsStatusResponse struct {
	Kind               legal.TermsStatusKind  `json:"kind"`
	AcceptanceRequired bool                   `json:"acceptanceRequired"`
	Current            currentTermsResponse   `json:"current"`
	Accepted           *acceptedTermsResponse `json:"accepted,omitempty"`
}

type termsApplicationResponse struct {
	Outcome legal.ApplicationOutcome `json:"outcome"`
	Status  termsStatusResponse      `json:"status"`
}

func writeTermsApplicationResult(response http.ResponseWriter, request *http.Request, result legal.ApplicationResult) {
	if result.Kind == legal.ApplicationAccepted {
		writeJSON(response, request, http.StatusOK, termsApplicationResponse{
			Outcome: result.Outcome, Status: mapTermsStatus(result.Status),
		})
		return
	}
	switch result.Reason {
	case legal.ApplicationInvalidCommand:
		writeLegalError(response, request, http.StatusBadRequest, "invalid-request")
	case legal.ApplicationConsentRequired:
		writeLegalError(response, request, http.StatusUnprocessableEntity, "consent-required")
	case legal.ApplicationStaleTerms:
		writeLegalError(response, request, http.StatusConflict, "terms-changed")
	case legal.ApplicationIdentifierConflict:
		writeLegalError(response, request, http.StatusConflict, "request-conflict")
	case legal.ApplicationOwnerMismatch:
		writeLegalError(response, request, http.StatusForbidden, "forbidden")
	default:
		writeLegalError(response, request, http.StatusServiceUnavailable, "unavailable")
	}
}

func mapTermsStatus(status legal.TermsConsentStatus) termsStatusResponse {
	mapped := termsStatusResponse{
		Kind: status.Kind, AcceptanceRequired: status.AcceptanceRequired,
		Current: currentTermsResponse{
			TermsVersion:  status.Current.TermsVersion,
			TermsHash:     status.Current.TermsHash,
			EffectiveDate: status.Current.EffectiveDate,
		},
	}
	if status.Accepted != nil {
		mapped.Accepted = &acceptedTermsResponse{
			ConsentID: status.Accepted.ConsentID, TermsVersion: status.Accepted.TermsVersion,
			TermsHash: status.Accepted.TermsHash, AcceptedAt: status.Accepted.AcceptedAt,
		}
	}
	return mapped
}

type contractOfferResponse struct {
	Offer     legal.ContractOfferSnapshot `json:"offer"`
	OfferHash legal.ContractOfferHash     `json:"offerHash"`
}

type contractCheckoutResponse struct {
	Kind            legal.ContractCheckoutResultKind `json:"kind"`
	EvidenceOutcome legal.ContractEvidenceOutcome    `json:"evidenceOutcome"`
	EvidenceID      legal.ContractEvidenceID         `json:"evidenceId"`
	OfferHash       legal.ContractOfferHash          `json:"offerHash"`
	OfferVersion    string                           `json:"offerVersion"`
	CheckoutURL     string                           `json:"checkoutUrl"`
}

func writeContractCheckoutResult(response http.ResponseWriter, request *http.Request, result legal.ContractCheckoutResult) {
	if result.Kind == legal.ContractCheckoutRedirect {
		writeJSON(response, request, http.StatusOK, contractCheckoutResponse{
			Kind: result.Kind, EvidenceOutcome: result.Outcome,
			EvidenceID: result.Evidence.EvidenceID, OfferHash: result.Evidence.OfferHash,
			OfferVersion: result.Evidence.Offer.OfferVersion, CheckoutURL: result.CheckoutURL,
		})
		return
	}
	switch result.Reason {
	case legal.ContractInvalidCommand:
		writeLegalError(response, request, http.StatusBadRequest, "invalid-request")
	case legal.ContractConsentRequired:
		writeLegalError(response, request, http.StatusUnprocessableEntity, "consent-required")
	case legal.ContractStaleOffer:
		writeLegalError(response, request, http.StatusConflict, "offer-changed")
	case legal.ContractTermsChanged:
		writeLegalError(response, request, http.StatusConflict, "terms-changed")
	case legal.ContractTermsRequired:
		writeLegalError(response, request, http.StatusUnprocessableEntity, "terms-consent-required")
	case legal.ContractIdentifierConflict, legal.ContractBillingRejected:
		writeLegalError(response, request, http.StatusConflict, "request-conflict")
	case legal.ContractOwnerMismatch:
		writeLegalError(response, request, http.StatusForbidden, "forbidden")
	default:
		writeLegalError(response, request, http.StatusServiceUnavailable, "unavailable")
	}
}

func writeLegalError(response http.ResponseWriter, request *http.Request, status int, code string) {
	writeJSON(response, request, status, map[string]string{"error": code})
}

func readLegalClock(runtime *LegalRuntime) (now int64, ok bool) {
	if runtime == nil || runtime.Clock == nil {
		return 0, false
	}
	defer func() {
		if recover() != nil {
			now, ok = 0, false
		}
	}()
	now = runtime.Clock()
	return now, now >= 0 && now <= legal.MaximumSafeInteger
}

func createTermsConsentID(runtime *LegalRuntime) (identifier legal.TermsConsentID, ok bool) {
	if runtime == nil || runtime.NewTermsConsentID == nil {
		return "", false
	}
	defer func() {
		if recover() != nil {
			identifier, ok = "", false
		}
	}()
	parsed, err := legal.ParseTermsConsentID(runtime.NewTermsConsentID())
	return parsed, err == nil
}

func createContractEvidenceID(runtime *LegalRuntime) (identifier legal.ContractEvidenceID, ok bool) {
	if runtime == nil || runtime.NewContractEvidenceID == nil {
		return "", false
	}
	defer func() {
		if recover() != nil {
			identifier, ok = "", false
		}
	}()
	parsed, err := legal.ParseContractEvidenceID(runtime.NewContractEvidenceID())
	return parsed, err == nil
}

func callTermsStatus(ctx context.Context, application TermsConsentApplication, scope legal.TermsScope) (result legal.ApplicationResult, ok bool) {
	defer func() {
		if recover() != nil {
			result, ok = legal.ApplicationResult{}, false
		}
	}()
	return application.Status(ctx, scope), true
}

func callTermsAccept(
	ctx context.Context,
	application TermsConsentApplication,
	scope legal.TermsScope,
	command legal.TermsConsentCommand,
	consentID legal.TermsConsentID,
	acceptedAt int64,
) (result legal.ApplicationResult, ok bool) {
	defer func() {
		if recover() != nil {
			result, ok = legal.ApplicationResult{}, false
		}
	}()
	return application.Accept(ctx, scope, command, consentID, acceptedAt), true
}

func callPrepareOffer(ctx context.Context, application ContractCheckoutApplication) (result legal.PrepareContractOfferResult, ok bool) {
	defer func() {
		if recover() != nil {
			result, ok = legal.PrepareContractOfferResult{}, false
		}
	}()
	return application.PrepareOffer(ctx), true
}

func callConfirmCheckout(
	ctx context.Context,
	application ContractCheckoutApplication,
	vaultContext identity.VaultContext,
	command legal.ContractConfirmationCommand,
	evidenceID legal.ContractEvidenceID,
	confirmedAt int64,
) (result legal.ContractCheckoutResult, ok bool) {
	defer func() {
		if recover() != nil {
			result, ok = legal.ContractCheckoutResult{}, false
		}
	}()
	return application.Confirm(ctx, vaultContext, command, evidenceID, confirmedAt), true
}

func logLegalFailure(logger *slog.Logger, code string) {
	if logger != nil {
		logger.Error("legal request failed", "error_code", code)
	}
}

package identity

import (
	"context"
	"errors"
)

var ErrSessionResolverRequired = errors.New("session resolver is required")

type SessionResolver interface {
	FindSessionByToken(context.Context, SessionToken) (*Session, error)
}

type SessionRequestMetadata struct {
	Method             string
	CookieHeaders      []string
	OriginHeader       string
	SecFetchSiteHeader string
	ExpectedOrigin     string
	Now                int64
}

type ResolutionKind string
type ResolutionReason string

const (
	ResolutionAuthenticated ResolutionKind = "authenticated"
	ResolutionAnonymous     ResolutionKind = "anonymous"
	ResolutionForbidden     ResolutionKind = "forbidden"

	ResolutionMissingSession ResolutionReason = "missing-session"
	ResolutionInvalidCookie  ResolutionReason = "invalid-cookie"
	ResolutionUnknownSession ResolutionReason = "unknown-session"
	ResolutionInvalidSession ResolutionReason = "invalid-session-record"
	ResolutionRevoked        ResolutionReason = "revoked"
	ResolutionExpired        ResolutionReason = "expired"
	ResolutionInvalidClock   ResolutionReason = "invalid-clock"
)

type VaultContextResolution struct {
	Kind    ResolutionKind
	Reason  ResolutionReason
	Context VaultContext
	CSRF    CSRFDecision
}

func DeriveVaultContext(
	ctx context.Context,
	request SessionRequestMetadata,
	resolver SessionResolver,
) (VaultContextResolution, error) {
	csrf := EvaluateCSRF(CSRFInput{
		Method:             request.Method,
		ExpectedOrigin:     request.ExpectedOrigin,
		OriginHeader:       request.OriginHeader,
		SecFetchSiteHeader: request.SecFetchSiteHeader,
	})
	if csrf.Kind == CSRFDenied {
		return VaultContextResolution{Kind: ResolutionForbidden, CSRF: csrf}, nil
	}
	if len(request.CookieHeaders) == 0 {
		return VaultContextResolution{
			Kind: ResolutionAnonymous, Reason: ResolutionMissingSession,
		}, nil
	}
	if len(request.CookieHeaders) != 1 {
		return VaultContextResolution{
			Kind: ResolutionAnonymous, Reason: ResolutionInvalidCookie,
		}, nil
	}
	cookie := ParseSessionCookieHeader(request.CookieHeaders[0])
	switch cookie.Kind {
	case CookieMissing:
		return VaultContextResolution{
			Kind: ResolutionAnonymous, Reason: ResolutionMissingSession,
		}, nil
	case CookieInvalid:
		return VaultContextResolution{
			Kind: ResolutionAnonymous, Reason: ResolutionInvalidCookie,
		}, nil
	case CookieFound:
	default:
		return VaultContextResolution{
			Kind: ResolutionAnonymous, Reason: ResolutionInvalidCookie,
		}, nil
	}
	if resolver == nil {
		return VaultContextResolution{}, ErrSessionResolverRequired
	}
	session, err := resolver.FindSessionByToken(ctx, cookie.Token)
	if err != nil {
		return VaultContextResolution{}, err
	}
	if session == nil {
		return VaultContextResolution{
			Kind: ResolutionAnonymous, Reason: ResolutionUnknownSession,
		}, nil
	}
	access := AuthorizeSession(session, request.Now)
	switch access.Kind {
	case AccessAuthenticated:
		return VaultContextResolution{
			Kind: ResolutionAuthenticated, Context: access.Context,
		}, nil
	case AccessAnonymous:
		return VaultContextResolution{
			Kind: ResolutionAnonymous, Reason: ResolutionMissingSession,
		}, nil
	case AccessDenied:
		return VaultContextResolution{
			Kind: ResolutionAnonymous, Reason: resolutionReason(access.Reason),
		}, nil
	default:
		return VaultContextResolution{
			Kind: ResolutionAnonymous, Reason: ResolutionInvalidSession,
		}, nil
	}
}

func resolutionReason(reason AccessReason) ResolutionReason {
	switch reason {
	case AccessRevoked:
		return ResolutionRevoked
	case AccessExpired:
		return ResolutionExpired
	case AccessInvalidClock:
		return ResolutionInvalidClock
	default:
		return ResolutionInvalidSession
	}
}

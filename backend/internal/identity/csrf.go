package identity

import (
	"net/url"
	"regexp"
	"strings"
)

var uppercaseMethodPattern = regexp.MustCompile(`^[A-Z]+$`)

type CSRFKind string
type CSRFReason string

const (
	CSRFAllowed CSRFKind = "allowed"
	CSRFDenied  CSRFKind = "denied"

	CSRFSafeMethod            CSRFReason = "safe-method"
	CSRFSameOrigin            CSRFReason = "same-origin"
	CSRFInvalidMethod         CSRFReason = "invalid-method"
	CSRFInvalidExpectedOrigin CSRFReason = "invalid-expected-origin"
	CSRFMissingOrigin         CSRFReason = "missing-origin"
	CSRFOriginMismatch        CSRFReason = "origin-mismatch"
	CSRFMissingFetchMetadata  CSRFReason = "missing-fetch-metadata"
	CSRFCrossSite             CSRFReason = "cross-site"
)

type CSRFInput struct {
	Method             string
	ExpectedOrigin     string
	OriginHeader       string
	SecFetchSiteHeader string
}

type CSRFDecision struct {
	Kind   CSRFKind
	Reason CSRFReason
}

func EvaluateCSRF(input CSRFInput) CSRFDecision {
	if !uppercaseMethodPattern.MatchString(input.Method) {
		return CSRFDecision{Kind: CSRFDenied, Reason: CSRFInvalidMethod}
	}
	if input.Method == "GET" || input.Method == "HEAD" || input.Method == "OPTIONS" {
		return CSRFDecision{Kind: CSRFAllowed, Reason: CSRFSafeMethod}
	}
	expected, valid := strictOrigin(input.ExpectedOrigin)
	if !valid {
		return CSRFDecision{Kind: CSRFDenied, Reason: CSRFInvalidExpectedOrigin}
	}
	requestOrigin, valid := strictOrigin(input.OriginHeader)
	if !valid {
		return CSRFDecision{Kind: CSRFDenied, Reason: CSRFMissingOrigin}
	}
	if requestOrigin != expected {
		return CSRFDecision{Kind: CSRFDenied, Reason: CSRFOriginMismatch}
	}
	if input.SecFetchSiteHeader == "" {
		return CSRFDecision{Kind: CSRFDenied, Reason: CSRFMissingFetchMetadata}
	}
	if input.SecFetchSiteHeader != "same-origin" {
		return CSRFDecision{Kind: CSRFDenied, Reason: CSRFCrossSite}
	}
	return CSRFDecision{Kind: CSRFAllowed, Reason: CSRFSameOrigin}
}

func strictOrigin(value string) (string, bool) {
	if value == "" || len(value) > 2_048 || strings.TrimSpace(value) != value {
		return "", false
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") ||
		parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawPath != "" ||
		parsed.RawQuery != "" || parsed.Fragment != "" || parsed.ForceQuery || parsed.Opaque != "" {
		return "", false
	}
	canonical := parsed.Scheme + "://" + strings.ToLower(parsed.Host)
	if parsed.Scheme == "https" && strings.HasSuffix(canonical, ":443") {
		canonical = strings.TrimSuffix(canonical, ":443")
	}
	if parsed.Scheme == "http" && strings.HasSuffix(canonical, ":80") {
		canonical = strings.TrimSuffix(canonical, ":80")
	}
	if canonical != value {
		return "", false
	}
	return canonical, true
}

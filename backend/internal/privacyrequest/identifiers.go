package privacyrequest

import (
	"errors"
	"regexp"
)

var (
	ErrInvalidIdentifier  = errors.New("invalid privacy request identifier")
	ErrInvalidFailureCode = errors.New("invalid privacy request failure code")

	uuidV7Pattern      = regexp.MustCompile(`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-7[0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$`)
	failureCodePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)
)

type RequestID string
type SubmissionID string
type VerificationReceiptID string
type FailureCode string

func ParseRequestID(value string) (RequestID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidIdentifier
	}
	return RequestID(value), nil
}

func ParseSubmissionID(value string) (SubmissionID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidIdentifier
	}
	return SubmissionID(value), nil
}

func ParseVerificationReceiptID(value string) (VerificationReceiptID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidIdentifier
	}
	return VerificationReceiptID(value), nil
}

func ParseFailureCode(value string) (FailureCode, error) {
	if !failureCodePattern.MatchString(value) {
		return "", ErrInvalidFailureCode
	}
	return FailureCode(value), nil
}

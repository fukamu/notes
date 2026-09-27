package accountdeletion

import (
	"errors"
	"regexp"
)

type OperationID string
type FailureCode string
type IdempotencyKey string
type CredentialHash string
type ContinuationSecret string

var (
	failureCodePattern  = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)
	base64URL256Pattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	uuidV7Pattern       = regexp.MustCompile(
		`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-7[0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$`,
	)
)

func ParseOperationID(value string) (OperationID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", errors.New("account deletion operation ID must be UUIDv7")
	}
	return OperationID(value), nil
}

func ParseFailureCode(value string) (FailureCode, error) {
	if !failureCodePattern.MatchString(value) {
		return "", errors.New("account deletion failure code is invalid")
	}
	return FailureCode(value), nil
}

func ParseIdempotencyKey(value string) (IdempotencyKey, error) {
	if !base64URL256Pattern.MatchString(value) {
		return "", errors.New("account deletion idempotency key is invalid")
	}
	return IdempotencyKey(value), nil
}

func ParseCredentialHash(value string) (CredentialHash, error) {
	if !base64URL256Pattern.MatchString(value) {
		return "", errors.New("account deletion credential hash is invalid")
	}
	return CredentialHash(value), nil
}

func ParseContinuationSecret(value string) (ContinuationSecret, error) {
	if !base64URL256Pattern.MatchString(value) {
		return "", errors.New("account deletion continuation secret is invalid")
	}
	return ContinuationSecret(value), nil
}

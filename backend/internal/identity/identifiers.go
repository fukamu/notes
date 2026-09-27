package identity

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"regexp"
)

const (
	MaximumSafeInteger  = int64(9_007_199_254_740_991)
	MaximumSessionEpoch = int64(2_147_483_647)
)

var (
	ErrInvalidIdentifier = errors.New("invalid identity identifier")
	ErrInvalidEpoch      = errors.New("invalid session epoch")
	ErrInvalidToken      = errors.New("invalid session token")
	ErrInvalidTokenHash  = errors.New("invalid session token hash")

	uuidV7Pattern = regexp.MustCompile(
		`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-7[0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$`,
	)
	tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$`)
)

type AccountID string
type VaultID string
type SessionID string
type IdentityID string
type SessionEpoch int64
type SessionToken string
type SessionTokenHash string

func ParseAccountID(value string) (AccountID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidIdentifier
	}
	return AccountID(value), nil
}

func ParseVaultID(value string) (VaultID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidIdentifier
	}
	return VaultID(value), nil
}

func ParseSessionID(value string) (SessionID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidIdentifier
	}
	return SessionID(value), nil
}

func ParseIdentityID(value string) (IdentityID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidIdentifier
	}
	return IdentityID(value), nil
}

func ParseSessionEpoch(value int64) (SessionEpoch, error) {
	if value < 1 || value > MaximumSessionEpoch {
		return 0, ErrInvalidEpoch
	}
	return SessionEpoch(value), nil
}

func ParseSessionToken(value string) (SessionToken, error) {
	if !tokenPattern.MatchString(value) {
		return "", ErrInvalidToken
	}
	return SessionToken(value), nil
}

func ParseSessionTokenHash(value string) (SessionTokenHash, error) {
	if !tokenPattern.MatchString(value) {
		return "", ErrInvalidTokenHash
	}
	return SessionTokenHash(value), nil
}

func HashSessionToken(token SessionToken) (SessionTokenHash, error) {
	if _, err := ParseSessionToken(string(token)); err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(token))
	return SessionTokenHash(base64.RawURLEncoding.EncodeToString(digest[:])), nil
}

func validTimestamp(value int64) bool {
	return value >= 0 && value <= MaximumSafeInteger
}

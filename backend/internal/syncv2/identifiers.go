package syncv2

import (
	"errors"
	"regexp"
)

var (
	ErrInvalidIdentifier = errors.New("invalid Sync v2 identifier")
	uuidV7Pattern        = regexp.MustCompile(`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-7[0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$`)
	fingerprintPattern   = regexp.MustCompile(`^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$`)
)

type CardID string
type ConflictID string
type MutationID string
type Fingerprint string
type Revision int64
type Sequence int64

func ParseCardID(value string) (CardID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidIdentifier
	}
	return CardID(value), nil
}

func ParseConflictID(value string) (ConflictID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidIdentifier
	}
	return ConflictID(value), nil
}

func ParseMutationID(value string) (MutationID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidIdentifier
	}
	return MutationID(value), nil
}

func ParseDeviceID(value string) (DeviceID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidIdentifier
	}
	return DeviceID(value), nil
}

func ParseFingerprint(value string) (Fingerprint, error) {
	if !fingerprintPattern.MatchString(value) {
		return "", ErrInvalidIdentifier
	}
	return Fingerprint(value), nil
}

func ParseRevision(value int64) (Revision, error) {
	if value < 1 || value > MaximumRevision {
		return 0, ErrInvalidIdentifier
	}
	return Revision(value), nil
}

func ParseSequence(value int64) (Sequence, error) {
	if value < 0 || value > MaximumSafeInteger {
		return 0, ErrInvalidIdentifier
	}
	return Sequence(value), nil
}

package quota

import (
	"errors"
	"regexp"
)

var (
	ErrInvalidIdentifier = errors.New("invalid quota identifier")
	uuidV7Pattern        = regexp.MustCompile(`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-7[0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$`)
	fingerprintPattern   = regexp.MustCompile(`^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$`)
)

type ReservationID string
type CardID string
type Fingerprint string
type Revision int64

func ParseReservationID(value string) (ReservationID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidIdentifier
	}
	return ReservationID(value), nil
}

func ParseCardID(value string) (CardID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidIdentifier
	}
	return CardID(value), nil
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

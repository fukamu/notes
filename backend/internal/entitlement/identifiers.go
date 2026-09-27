package entitlement

import (
	"errors"
	"regexp"
)

var (
	ErrInvalidIdentifier = errors.New("invalid entitlement identifier")
	uuidV7Pattern        = regexp.MustCompile(`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-7[0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$`)
)

type OfflineLeaseID string
type ProjectionVersion int64

func ParseOfflineLeaseID(value string) (OfflineLeaseID, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", ErrInvalidIdentifier
	}
	return OfflineLeaseID(value), nil
}

func ParseProjectionVersion(value int64) (ProjectionVersion, error) {
	if value < 1 || value > 2_147_483_647 {
		return 0, ErrInvalidIdentifier
	}
	return ProjectionVersion(value), nil
}

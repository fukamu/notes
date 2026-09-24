package launchgate

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/access"
)

var ErrUnavailable = errors.New("launch gate unavailable")

type Facts struct {
	PublicAccessEnabled bool
	UserAllowed         bool
}

type Decision struct {
	PublicAccessEnabled bool
	UserAllowed         bool
	CanAccess           bool
}

type Reader interface {
	Read(context.Context, *access.Subject) (Facts, error)
}

func Decide(facts Facts) Decision {
	return Decision{
		PublicAccessEnabled: facts.PublicAccessEnabled,
		UserAllowed:         facts.UserAllowed,
		CanAccess:           facts.PublicAccessEnabled || facts.UserAllowed,
	}
}

func Resolve(ctx context.Context, reader Reader, subject *access.Subject) (Decision, error) {
	if reader == nil {
		return Decision{}, ErrUnavailable
	}
	facts, err := reader.Read(ctx, subject)
	if err != nil {
		return Decision{}, ErrUnavailable
	}
	return Decide(facts), nil
}

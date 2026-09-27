package launchgate_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/access"
	"github.com/fukamu/notes/backend/internal/launchgate"
)

type readerFunction func(context.Context, *access.Subject) (launchgate.Facts, error)

func (reader readerFunction) Read(ctx context.Context, subject *access.Subject) (launchgate.Facts, error) {
	return reader(ctx, subject)
}

func TestDecideLaunchAccess(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		facts launchgate.Facts
		want  bool
	}{
		{facts: launchgate.Facts{}, want: false},
		{facts: launchgate.Facts{PublicAccessEnabled: true}, want: true},
		{facts: launchgate.Facts{UserAllowed: true}, want: true},
		{facts: launchgate.Facts{PublicAccessEnabled: true, UserAllowed: true}, want: true},
	} {
		decision := launchgate.Decide(test.facts)
		if decision.CanAccess != test.want ||
			decision.PublicAccessEnabled != test.facts.PublicAccessEnabled ||
			decision.UserAllowed != test.facts.UserAllowed {
			t.Fatalf("Decide(%#v) = %#v", test.facts, decision)
		}
	}
}

func TestResolveHidesRepositoryFailure(t *testing.T) {
	t.Parallel()
	rawFailure := errors.New("raw database detail")
	_, err := launchgate.Resolve(context.Background(), readerFunction(
		func(context.Context, *access.Subject) (launchgate.Facts, error) {
			return launchgate.Facts{}, rawFailure
		},
	), nil)
	if !errors.Is(err, launchgate.ErrUnavailable) || errors.Is(err, rawFailure) ||
		strings.Contains(err.Error(), rawFailure.Error()) {
		t.Fatalf("Resolve() error = %v", err)
	}
}

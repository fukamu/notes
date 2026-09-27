package featureflag

import (
	"context"
	"errors"
	"regexp"

	"github.com/fukamu/notes/backend/internal/identity"
)

var (
	ErrInvalidName = errors.New("invalid feature flag name")
	namePattern    = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)
)

type Name string

const BillingCheckout Name = "billing-checkout"

func ParseName(value string) (Name, error) {
	if !namePattern.MatchString(value) {
		return "", ErrInvalidName
	}
	return Name(value), nil
}

type Facts struct {
	Configured      bool
	GloballyEnabled bool
	AccountEnabled  bool
}

type DecisionKind string

const (
	DecisionDisabled DecisionKind = "disabled"
	DecisionEnabled  DecisionKind = "enabled"
)

type Decision struct {
	Kind DecisionKind
	Name Name
}

func Evaluate(name Name, facts Facts) Decision {
	if _, err := ParseName(string(name)); err != nil || !facts.Configured {
		return Decision{Kind: DecisionDisabled, Name: name}
	}
	if facts.GloballyEnabled || facts.AccountEnabled {
		return Decision{Kind: DecisionEnabled, Name: name}
	}
	return Decision{Kind: DecisionDisabled, Name: name}
}

type Reader interface {
	Read(context.Context, Name, identity.AccountID) (Facts, error)
}

type Service struct {
	reader Reader
}

func NewService(reader Reader) (*Service, error) {
	if reader == nil {
		return nil, errors.New("feature flag reader is required")
	}
	return &Service{reader: reader}, nil
}

func (service *Service) Evaluate(
	ctx context.Context,
	name Name,
	accountID identity.AccountID,
) (Decision, error) {
	if service == nil || service.reader == nil {
		return Decision{Kind: DecisionDisabled, Name: name}, errors.New("feature flag service is unavailable")
	}
	if _, err := ParseName(string(name)); err != nil {
		return Decision{Kind: DecisionDisabled, Name: name}, nil
	}
	if _, err := identity.ParseAccountID(string(accountID)); err != nil {
		return Decision{Kind: DecisionDisabled, Name: name}, err
	}
	facts, err := service.reader.Read(ctx, name, accountID)
	if err != nil {
		return Decision{Kind: DecisionDisabled, Name: name}, err
	}
	return Evaluate(name, facts), nil
}

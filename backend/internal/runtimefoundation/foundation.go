package runtimefoundation

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/syncv2"
)

var (
	ErrInvalidFoundation = errors.New("invalid local fixture runtime foundation")
	ErrNotReady          = errors.New("local fixture runtime foundation is not ready")
)

type Readiness interface {
	Check(context.Context) error
}

type AggregateReadiness struct {
	checks []Readiness
}

func NewAggregateReadiness(checks ...Readiness) (*AggregateReadiness, error) {
	if len(checks) == 0 {
		return nil, ErrInvalidFoundation
	}
	copyOfChecks := make([]Readiness, len(checks))
	for index, check := range checks {
		if check == nil {
			return nil, ErrInvalidFoundation
		}
		copyOfChecks[index] = check
	}
	return &AggregateReadiness{checks: copyOfChecks}, nil
}

func (readiness *AggregateReadiness) Check(ctx context.Context) error {
	if readiness == nil || ctx == nil || len(readiness.checks) == 0 {
		return ErrNotReady
	}
	for _, check := range readiness.checks {
		if check == nil || check.Check(ctx) != nil {
			return ErrNotReady
		}
	}
	return nil
}

type LocalFixtureOptions struct {
	Context             identity.VaultContext
	Sessions            identity.SessionResolver
	Objects             encryptedobject.ObjectStoragePort
	NonceReservations   cryptocontent.NonceReservationPort
	Keys                cryptocontent.KeyManagementPort
	Cursors             *syncv2.CursorAuthenticator
	DeletionCredentials accountdeletion.CredentialPort
}

type LocalFixture struct {
	Context             identity.VaultContext
	Sessions            identity.SessionResolver
	Objects             encryptedobject.ObjectStoragePort
	NonceReservations   cryptocontent.NonceReservationPort
	Keys                cryptocontent.KeyManagementPort
	Cursors             *syncv2.CursorAuthenticator
	DeletionCredentials accountdeletion.CredentialPort
}

func NewLocalFixture(options LocalFixtureOptions) (*LocalFixture, error) {
	_, accountErr := identity.ParseAccountID(string(options.Context.AccountID))
	_, vaultErr := identity.ParseVaultID(string(options.Context.VaultID))
	_, sessionErr := identity.ParseSessionID(string(options.Context.SessionID))
	_, epochErr := identity.ParseSessionEpoch(int64(options.Context.SessionEpoch))
	if accountErr != nil || vaultErr != nil || sessionErr != nil || epochErr != nil ||
		options.Sessions == nil || options.Objects == nil ||
		options.NonceReservations == nil || options.Keys == nil || options.Cursors == nil ||
		options.DeletionCredentials == nil {
		return nil, ErrInvalidFoundation
	}
	return &LocalFixture{
		Context: options.Context, Sessions: options.Sessions, Objects: options.Objects,
		NonceReservations: options.NonceReservations, Keys: options.Keys, Cursors: options.Cursors,
		DeletionCredentials: options.DeletionCredentials,
	}, nil
}

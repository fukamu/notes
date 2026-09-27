package runtimefoundation

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/entitlement"
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

type EntitlementPort interface {
	AuthorizeCapability(context.Context, identity.VaultContext, entitlement.Capability, int64) entitlement.Decision
	ReadLimits(context.Context, identity.VaultContext, int64) entitlement.LimitDecision
}

// ScopedSessionResolver prevents an otherwise valid token from escaping the
// one disposable Account/Vault/session generation selected by local-fixture.
type ScopedSessionResolver struct {
	expected identity.VaultContext
	delegate identity.SessionResolver
}

func NewScopedSessionResolver(
	expected identity.VaultContext,
	delegate identity.SessionResolver,
) (*ScopedSessionResolver, error) {
	if !validVaultContext(expected) || delegate == nil {
		return nil, ErrInvalidFoundation
	}
	return &ScopedSessionResolver{expected: expected, delegate: delegate}, nil
}

func (resolver *ScopedSessionResolver) FindSessionByToken(
	ctx context.Context,
	token identity.SessionToken,
) (*identity.Session, error) {
	if resolver == nil || resolver.delegate == nil || !validVaultContext(resolver.expected) {
		return nil, ErrInvalidFoundation
	}
	session, err := resolver.delegate.FindSessionByToken(ctx, token)
	if err != nil || session == nil {
		return nil, err
	}
	if !identity.SessionMatchesContext(resolver.expected, *session) {
		return nil, nil
	}
	copy := *session
	return &copy, nil
}

// ScopedEntitlement delegates to the real Billing/Entitlement graph while
// pinning evaluation to the deterministic seed. HTTP/session expiry and Sync
// mutation timestamps continue to use the real request clock.
type ScopedEntitlement struct {
	expected    identity.VaultContext
	evaluatedAt int64
	delegate    EntitlementPort
}

func NewScopedEntitlement(
	expected identity.VaultContext,
	evaluatedAt int64,
	delegate EntitlementPort,
) (*ScopedEntitlement, error) {
	if !validVaultContext(expected) || evaluatedAt < 0 ||
		evaluatedAt > identity.MaximumSafeInteger || delegate == nil {
		return nil, ErrInvalidFoundation
	}
	return &ScopedEntitlement{
		expected: expected, evaluatedAt: evaluatedAt, delegate: delegate,
	}, nil
}

func (access *ScopedEntitlement) AuthorizeCapability(
	ctx context.Context,
	vaultContext identity.VaultContext,
	capability entitlement.Capability,
	_ int64,
) entitlement.Decision {
	if access == nil || access.delegate == nil || vaultContext != access.expected {
		return entitlement.Decision{
			Kind: entitlement.DecisionDenied, Capability: capability,
			Reason: entitlement.DenialOwnerMismatch,
		}
	}
	return access.delegate.AuthorizeCapability(ctx, vaultContext, capability, access.evaluatedAt)
}

func (access *ScopedEntitlement) ReadLimits(
	ctx context.Context,
	vaultContext identity.VaultContext,
	_ int64,
) entitlement.LimitDecision {
	if access == nil || access.delegate == nil || vaultContext != access.expected {
		return entitlement.LimitDecision{
			Kind: entitlement.LimitsDenied, Reason: entitlement.DenialOwnerMismatch,
		}
	}
	return access.delegate.ReadLimits(ctx, vaultContext, access.evaluatedAt)
}

func NewLocalFixture(options LocalFixtureOptions) (*LocalFixture, error) {
	if !validVaultContext(options.Context) ||
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

func validVaultContext(value identity.VaultContext) bool {
	_, accountErr := identity.ParseAccountID(string(value.AccountID))
	_, vaultErr := identity.ParseVaultID(string(value.VaultID))
	_, sessionErr := identity.ParseSessionID(string(value.SessionID))
	_, epochErr := identity.ParseSessionEpoch(int64(value.SessionEpoch))
	return accountErr == nil && vaultErr == nil && sessionErr == nil && epochErr == nil
}

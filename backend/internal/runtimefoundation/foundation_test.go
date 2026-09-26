package runtimefoundation_test

import (
	"context"
	"errors"
	"testing"

	accountdeletioncredentialadapter "github.com/fukamu/notes/backend/internal/adapters/accountdeletioncredential"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/runtimefoundation"
	"github.com/fukamu/notes/backend/internal/syncv2"
)

type readinessCheck func(context.Context) error

func (check readinessCheck) Check(ctx context.Context) error { return check(ctx) }

func TestAggregateReadinessChecksEveryDependencyInOrderAndRedactsFailure(t *testing.T) {
	t.Parallel()
	order := make([]int, 0, 3)
	readiness, err := runtimefoundation.NewAggregateReadiness(
		readinessCheck(func(context.Context) error { order = append(order, 1); return nil }),
		readinessCheck(func(context.Context) error {
			order = append(order, 2)
			return errors.New("sensitive dependency failure")
		}),
		readinessCheck(func(context.Context) error { order = append(order, 3); return nil }),
	)
	if err != nil {
		t.Fatal(err)
	}
	err = readiness.Check(context.Background())
	if !errors.Is(err, runtimefoundation.ErrNotReady) || err.Error() == "sensitive dependency failure" {
		t.Fatalf("Check() error = %v", err)
	}
	if len(order) != 2 || order[0] != 1 || order[1] != 2 {
		t.Fatalf("readiness order = %v", order)
	}
	if _, err := runtimefoundation.NewAggregateReadiness(); !errors.Is(err, runtimefoundation.ErrInvalidFoundation) {
		t.Fatalf("empty aggregate error = %v", err)
	}
	if _, err := runtimefoundation.NewAggregateReadiness(nil); !errors.Is(err, runtimefoundation.ErrInvalidFoundation) {
		t.Fatalf("nil aggregate error = %v", err)
	}
}

func TestNewLocalFixtureRequiresACompleteTypedFoundation(t *testing.T) {
	t.Parallel()
	contextValue := fixtureContext(t)
	cursors, err := syncv2.NewCursorAuthenticator(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	credentials, err := accountdeletioncredentialadapter.New(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	options := runtimefoundation.LocalFixtureOptions{
		Context: contextValue, Sessions: fakeSessions{}, Objects: fakeObjects{},
		NonceReservations: fakeNonces{}, Keys: fakeKeys{}, Cursors: cursors,
		DeletionCredentials: credentials,
	}
	foundation, err := runtimefoundation.NewLocalFixture(options)
	if err != nil || foundation.Context != contextValue || foundation.Sessions == nil || foundation.Objects == nil {
		t.Fatalf("NewLocalFixture() = %#v, %v", foundation, err)
	}
	options.Keys = nil
	if _, err := runtimefoundation.NewLocalFixture(options); !errors.Is(err, runtimefoundation.ErrInvalidFoundation) {
		t.Fatalf("missing key port error = %v", err)
	}
	options.Keys = fakeKeys{}
	options.Context.VaultID = "other"
	if _, err := runtimefoundation.NewLocalFixture(options); !errors.Is(err, runtimefoundation.ErrInvalidFoundation) {
		t.Fatalf("invalid context error = %v", err)
	}
}

func TestScopedSessionResolverAllowsOnlyTheFixtureGeneration(t *testing.T) {
	t.Parallel()
	expected := fixtureContext(t)
	matching := fixtureSession(expected)
	resolver, err := runtimefoundation.NewScopedSessionResolver(
		expected,
		&sessionResolverStub{session: &matching},
	)
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := resolver.FindSessionByToken(context.Background(), fixtureToken(t))
	if err != nil || resolved == nil || !identity.SessionMatchesContext(expected, *resolved) {
		t.Fatalf("matching session = %#v, %v", resolved, err)
	}
	resolved.SessionEpoch++
	again, err := resolver.FindSessionByToken(context.Background(), fixtureToken(t))
	if err != nil || again == nil || again.SessionEpoch != expected.SessionEpoch {
		t.Fatalf("resolver leaked caller mutation = %#v, %v", again, err)
	}

	foreign := matching
	foreign.SessionEpoch++
	foreignResolver, err := runtimefoundation.NewScopedSessionResolver(
		expected,
		&sessionResolverStub{session: &foreign},
	)
	if err != nil {
		t.Fatal(err)
	}
	resolved, err = foreignResolver.FindSessionByToken(context.Background(), fixtureToken(t))
	if err != nil || resolved != nil {
		t.Fatalf("foreign generation = %#v, %v", resolved, err)
	}
}

func TestScopedEntitlementPinsEvaluationAndRejectsForeignScope(t *testing.T) {
	t.Parallel()
	expected := fixtureContext(t)
	delegate := &entitlementStub{}
	access, err := runtimefoundation.NewScopedEntitlement(expected, 1, delegate)
	if err != nil {
		t.Fatal(err)
	}
	decision := access.AuthorizeCapability(
		context.Background(), expected, entitlement.CapabilityNotesSync, 5_000,
	)
	limits := access.ReadLimits(context.Background(), expected, 6_000)
	if decision.Kind != entitlement.DecisionAllowed || limits.Kind != entitlement.LimitsAvailable ||
		delegate.authorizationTimestamp != 1 || delegate.limitsTimestamp != 1 {
		t.Fatalf("decisions = %#v %#v, delegate = %#v", decision, limits, delegate)
	}
	foreign := expected
	foreign.SessionEpoch++
	decision = access.AuthorizeCapability(
		context.Background(), foreign, entitlement.CapabilityNotesSync, 7_000,
	)
	limits = access.ReadLimits(context.Background(), foreign, 8_000)
	if decision.Kind != entitlement.DecisionDenied || decision.Reason != entitlement.DenialOwnerMismatch ||
		limits.Kind != entitlement.LimitsDenied || limits.Reason != entitlement.DenialOwnerMismatch ||
		delegate.authorizationCalls != 1 || delegate.limitsCalls != 1 {
		t.Fatalf("foreign decisions = %#v %#v, delegate = %#v", decision, limits, delegate)
	}
}

type fakeSessions struct{}

func (fakeSessions) FindSessionByToken(context.Context, identity.SessionToken) (*identity.Session, error) {
	return nil, nil
}

type sessionResolverStub struct{ session *identity.Session }

func (stub *sessionResolverStub) FindSessionByToken(context.Context, identity.SessionToken) (*identity.Session, error) {
	return stub.session, nil
}

type entitlementStub struct {
	authorizationCalls     int
	authorizationTimestamp int64
	limitsCalls            int
	limitsTimestamp        int64
}

func (stub *entitlementStub) AuthorizeCapability(
	_ context.Context,
	_ identity.VaultContext,
	capability entitlement.Capability,
	checkedAt int64,
) entitlement.Decision {
	stub.authorizationCalls++
	stub.authorizationTimestamp = checkedAt
	return entitlement.Decision{Kind: entitlement.DecisionAllowed, Capability: capability}
}

func (stub *entitlementStub) ReadLimits(
	_ context.Context,
	_ identity.VaultContext,
	checkedAt int64,
) entitlement.LimitDecision {
	stub.limitsCalls++
	stub.limitsTimestamp = checkedAt
	return entitlement.LimitDecision{
		Kind: entitlement.LimitsAvailable, Limits: entitlement.PaidPersonalVaultLimits(),
	}
}

type fakeObjects struct{}

func (fakeObjects) Get(context.Context, encryptedobject.ObjectKey) ([]byte, bool, error) {
	return nil, false, nil
}
func (fakeObjects) PutIfAbsent(context.Context, encryptedobject.ObjectKey, []byte, int64) (encryptedobject.PutResult, error) {
	return encryptedobject.PutStored, nil
}
func (fakeObjects) Delete(context.Context, encryptedobject.ObjectKey) (encryptedobject.DeleteResult, error) {
	return encryptedobject.DeleteNotFound, nil
}
func (fakeObjects) List(context.Context) ([]encryptedobject.PrivateObjectDescriptor, error) {
	return nil, nil
}

type fakeNonces struct{}

func (fakeNonces) ReserveNonce(context.Context, identity.VaultID, cryptocontent.DEKVersion, string) (bool, error) {
	return true, nil
}

type fakeKeys struct{}

func (fakeKeys) GenerateDataKey(context.Context, identity.VaultID, cryptocontent.DEKVersion) (cryptocontent.VaultDEKMetadata, *cryptocontent.DataEncryptionKey, error) {
	return cryptocontent.VaultDEKMetadata{}, nil, nil
}
func (fakeKeys) UnwrapDataKey(context.Context, cryptocontent.VaultDEKMetadata) (*cryptocontent.DataEncryptionKey, error) {
	return nil, nil
}

func fixtureContext(t *testing.T) identity.VaultContext {
	t.Helper()
	accountID, _ := identity.ParseAccountID("01999c20-9e33-7000-8000-000000000001")
	vaultID, _ := identity.ParseVaultID("01999c20-9e33-7000-8000-000000000002")
	sessionID, _ := identity.ParseSessionID("01999c20-9e33-7000-8000-000000000003")
	epoch, _ := identity.ParseSessionEpoch(1)
	return identity.VaultContext{
		AccountID: accountID, VaultID: vaultID, SessionID: sessionID, SessionEpoch: epoch,
	}
}

func fixtureSession(vaultContext identity.VaultContext) identity.Session {
	return identity.Session{
		Kind: identity.SessionActive, AccountID: vaultContext.AccountID,
		VaultID: vaultContext.VaultID, SessionID: vaultContext.SessionID,
		SessionEpoch: vaultContext.SessionEpoch, IssuedAt: 1,
		ExpiresAt: identity.MaximumSafeInteger,
	}
}

func fixtureToken(t *testing.T) identity.SessionToken {
	t.Helper()
	token, err := identity.ParseSessionToken("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	if err != nil {
		t.Fatal(err)
	}
	return token
}

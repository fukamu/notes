package entitlement

import (
	"context"

	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/identity"
)

type BillingPort interface {
	ReadSubscription(context.Context, identity.VaultContext) (*billing.SubscriptionFacts, error)
}

type OwnershipPort interface {
	Owns(context.Context, identity.VaultContext) (bool, error)
}

type ProjectionCommitKind string

const (
	ProjectionApplied  ProjectionCommitKind = "applied"
	ProjectionConflict ProjectionCommitKind = "conflict"
)

type LeaseCreateKind string

const (
	LeaseCreateIssued             LeaseCreateKind = "issued"
	LeaseCreateReplayed           LeaseCreateKind = "replayed"
	LeaseCreateIdentifierConflict LeaseCreateKind = "identifier-conflict"
	LeaseCreateProjectionConflict LeaseCreateKind = "projection-conflict"
)

type LeaseCreateResult struct {
	Kind  LeaseCreateKind
	Lease *OfflineLeaseRecord
}

type Repository interface {
	FindProjection(context.Context, identity.VaultContext) (*ProjectionRecord, error)
	CommitProjection(
		context.Context,
		*ProjectionVersion,
		ProjectionRecord,
		*int64,
	) (ProjectionCommitKind, error)
	FindOfflineLease(context.Context, identity.VaultContext, OfflineLeaseID) (*OfflineLeaseRecord, error)
	CreateOfflineLease(context.Context, ProjectionVersion, OfflineLeaseRecord) (LeaseCreateResult, error)
}

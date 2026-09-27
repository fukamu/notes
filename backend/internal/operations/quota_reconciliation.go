package operations

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/quota"
)

var ErrQuotaReconciliationAudit = errors.New("quota reconciliation audit failed")

type QuotaCandidateQuery struct {
	AccountID  identity.AccountID
	VaultID    identity.VaultID
	AsOfMillis int64
	Limit      int
}

type QuotaCandidate struct {
	ReservationID  quota.ReservationID
	ReconcileAfter int64
}

type QuotaCandidateLoad struct {
	Owned      bool
	Candidates []QuotaCandidate
}

type QuotaCandidateRepository interface {
	ListQuotaCandidates(context.Context, QuotaCandidateQuery) (QuotaCandidateLoad, error)
}

type QuotaAuditResultKind string

const (
	QuotaAuditListed  QuotaAuditResultKind = "listed"
	QuotaAuditRefused QuotaAuditResultKind = "refused"
)

type QuotaAuditRefusal string

const QuotaAuditOwnerMismatch QuotaAuditRefusal = "owner-mismatch"

type QuotaAuditResult struct {
	Kind       QuotaAuditResultKind
	Reason     QuotaAuditRefusal
	AsOfMillis int64
	Candidates []QuotaCandidate
}

type QuotaAuditService struct {
	repository QuotaCandidateRepository
}

func NewQuotaAuditService(repository QuotaCandidateRepository) (*QuotaAuditService, error) {
	if repository == nil {
		return nil, ErrQuotaReconciliationAudit
	}
	return &QuotaAuditService{repository: repository}, nil
}

func (service *QuotaAuditService) ListCandidates(
	ctx context.Context,
	query QuotaCandidateQuery,
) (QuotaAuditResult, error) {
	if service == nil || service.repository == nil || ctx == nil || ValidateQuotaCandidateQuery(query) != nil {
		return QuotaAuditResult{}, ErrQuotaReconciliationAudit
	}
	loaded, err := service.repository.ListQuotaCandidates(ctx, query)
	if err != nil {
		return QuotaAuditResult{}, err
	}
	if !loaded.Owned {
		if len(loaded.Candidates) != 0 {
			return QuotaAuditResult{}, ErrQuotaReconciliationAudit
		}
		return QuotaAuditResult{
			Kind: QuotaAuditRefused, Reason: QuotaAuditOwnerMismatch, AsOfMillis: query.AsOfMillis,
		}, nil
	}
	if len(loaded.Candidates) > query.Limit || !validCandidates(loaded.Candidates, query.AsOfMillis) {
		return QuotaAuditResult{}, ErrQuotaReconciliationAudit
	}
	candidates := append([]QuotaCandidate(nil), loaded.Candidates...)
	return QuotaAuditResult{
		Kind: QuotaAuditListed, AsOfMillis: query.AsOfMillis, Candidates: candidates,
	}, nil
}

func ValidateQuotaCandidateQuery(query QuotaCandidateQuery) error {
	if _, err := identity.ParseAccountID(string(query.AccountID)); err != nil {
		return ErrQuotaReconciliationAudit
	}
	if _, err := identity.ParseVaultID(string(query.VaultID)); err != nil {
		return ErrQuotaReconciliationAudit
	}
	if !validTimestamp(query.AsOfMillis) || query.Limit < 1 || query.Limit > quota.MaximumReconciliationPageSize {
		return ErrQuotaReconciliationAudit
	}
	return nil
}

func validCandidates(candidates []QuotaCandidate, asOfMillis int64) bool {
	for index, candidate := range candidates {
		if _, err := quota.ParseReservationID(string(candidate.ReservationID)); err != nil ||
			!validTimestamp(candidate.ReconcileAfter) || candidate.ReconcileAfter > asOfMillis {
			return false
		}
		if index > 0 && !candidateAfter(candidates[index-1], candidate) {
			return false
		}
	}
	return true
}

func candidateAfter(previous, candidate QuotaCandidate) bool {
	return candidate.ReconcileAfter > previous.ReconcileAfter ||
		(candidate.ReconcileAfter == previous.ReconcileAfter && candidate.ReservationID > previous.ReservationID)
}

func validTimestamp(value int64) bool {
	return value >= 0 && value <= identity.MaximumSafeInteger
}

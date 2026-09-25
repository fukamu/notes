package operations

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/quota"
)

func TestQuotaAuditListsOnlyValidatedOrderedCandidates(t *testing.T) {
	t.Parallel()
	query := quotaAuditQuery(t)
	repository := &quotaAuditRepository{load: QuotaCandidateLoad{
		Owned: true,
		Candidates: []QuotaCandidate{
			quotaAuditCandidate(t, "01991f20-61d2-7000-8000-000000000401", 4_000),
			quotaAuditCandidate(t, "01991f20-61d2-7000-8000-000000000402", 4_000),
		},
	}}
	service, err := NewQuotaAuditService(repository)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.ListCandidates(context.Background(), query)
	if err != nil || result.Kind != QuotaAuditListed || result.AsOfMillis != query.AsOfMillis ||
		len(result.Candidates) != 2 || repository.query != query {
		t.Fatalf("result = %#v, query = %#v, error = %v", result, repository.query, err)
	}
	repository.load.Candidates[0].ReconcileAfter = 1
	if result.Candidates[0].ReconcileAfter != 4_000 {
		t.Fatal("result shares repository-owned candidate storage")
	}
}

func TestQuotaAuditRefusesUnknownOwnerWithoutCandidates(t *testing.T) {
	t.Parallel()
	service, _ := NewQuotaAuditService(&quotaAuditRepository{load: QuotaCandidateLoad{Owned: false}})
	result, err := service.ListCandidates(context.Background(), quotaAuditQuery(t))
	if err != nil || result.Kind != QuotaAuditRefused || result.Reason != QuotaAuditOwnerMismatch ||
		len(result.Candidates) != 0 {
		t.Fatalf("result = %#v, error = %v", result, err)
	}
}

func TestQuotaAuditRejectsInvalidQueriesAndMalformedRepositoryResults(t *testing.T) {
	t.Parallel()
	valid := quotaAuditQuery(t)
	tests := []struct {
		name  string
		query QuotaCandidateQuery
		load  QuotaCandidateLoad
	}{
		{name: "account", query: withQuotaAuditQuery(valid, func(value *QuotaCandidateQuery) { value.AccountID = "invalid" })},
		{name: "vault", query: withQuotaAuditQuery(valid, func(value *QuotaCandidateQuery) { value.VaultID = "invalid" })},
		{name: "timestamp", query: withQuotaAuditQuery(valid, func(value *QuotaCandidateQuery) { value.AsOfMillis = -1 })},
		{name: "limit zero", query: withQuotaAuditQuery(valid, func(value *QuotaCandidateQuery) { value.Limit = 0 })},
		{name: "limit high", query: withQuotaAuditQuery(valid, func(value *QuotaCandidateQuery) { value.Limit = 101 })},
		{name: "candidate for absent owner", query: valid, load: QuotaCandidateLoad{Candidates: []QuotaCandidate{quotaAuditCandidate(t, "01991f20-61d2-7000-8000-000000000401", 4_000)}}},
		{name: "invalid candidate", query: valid, load: QuotaCandidateLoad{Owned: true, Candidates: []QuotaCandidate{{ReservationID: "invalid", ReconcileAfter: 4_000}}}},
		{name: "future candidate", query: valid, load: QuotaCandidateLoad{Owned: true, Candidates: []QuotaCandidate{quotaAuditCandidate(t, "01991f20-61d2-7000-8000-000000000401", 6_000)}}},
		{name: "unordered candidates", query: valid, load: QuotaCandidateLoad{Owned: true, Candidates: []QuotaCandidate{
			quotaAuditCandidate(t, "01991f20-61d2-7000-8000-000000000402", 4_000),
			quotaAuditCandidate(t, "01991f20-61d2-7000-8000-000000000401", 4_000),
		}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			repository := &quotaAuditRepository{load: test.load}
			service, _ := NewQuotaAuditService(repository)
			if _, err := service.ListCandidates(context.Background(), test.query); !errors.Is(err, ErrQuotaReconciliationAudit) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestQuotaAuditPropagatesCancellationAndDependencyFailure(t *testing.T) {
	t.Parallel()
	sensitive := errors.New("PRIVATE-DB-FAILURE")
	service, _ := NewQuotaAuditService(&quotaAuditRepository{err: sensitive})
	if _, err := service.ListCandidates(context.Background(), quotaAuditQuery(t)); !errors.Is(err, sensitive) {
		t.Fatalf("dependency error = %v", err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	service, _ = NewQuotaAuditService(&quotaAuditRepository{checkContext: true})
	if _, err := service.ListCandidates(cancelled, quotaAuditQuery(t)); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation error = %v", err)
	}
}

func TestNewQuotaAuditServiceRejectsMissingRepository(t *testing.T) {
	t.Parallel()
	if _, err := NewQuotaAuditService(nil); !errors.Is(err, ErrQuotaReconciliationAudit) {
		t.Fatalf("error = %v", err)
	}
}

type quotaAuditRepository struct {
	load         QuotaCandidateLoad
	err          error
	query        QuotaCandidateQuery
	checkContext bool
}

func (repository *quotaAuditRepository) ListQuotaCandidates(
	ctx context.Context,
	query QuotaCandidateQuery,
) (QuotaCandidateLoad, error) {
	repository.query = query
	if repository.checkContext {
		return QuotaCandidateLoad{}, ctx.Err()
	}
	return repository.load, repository.err
}

func quotaAuditQuery(t *testing.T) QuotaCandidateQuery {
	t.Helper()
	accountID, err := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000101")
	if err != nil {
		t.Fatal(err)
	}
	vaultID, err := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000201")
	if err != nil {
		t.Fatal(err)
	}
	return QuotaCandidateQuery{AccountID: accountID, VaultID: vaultID, AsOfMillis: 5_000, Limit: 2}
}

func quotaAuditCandidate(t *testing.T, rawID string, reconcileAfter int64) QuotaCandidate {
	t.Helper()
	reservationID, err := quota.ParseReservationID(rawID)
	if err != nil {
		t.Fatal(err)
	}
	return QuotaCandidate{ReservationID: reservationID, ReconcileAfter: reconcileAfter}
}

func withQuotaAuditQuery(
	query QuotaCandidateQuery,
	update func(*QuotaCandidateQuery),
) QuotaCandidateQuery {
	update(&query)
	return query
}

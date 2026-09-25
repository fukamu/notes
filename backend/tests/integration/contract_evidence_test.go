//go:build integration

package integration_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/fukamu/notes/backend/internal/adapters/legalhash"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/legal"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type integrationContractFixture struct {
	Scope struct {
		AccountID string `json:"accountId"`
		VaultID   string `json:"vaultId"`
	} `json:"scope"`
	EvidenceID   string                        `json:"evidenceId"`
	SubmissionID string                        `json:"submissionId"`
	ConfirmedAt  int64                         `json:"confirmedAt"`
	Disclosure   legal.LegalCommerceDisclosure `json:"disclosure"`
	Expected     struct {
		CanonicalSHA256 string `json:"canonicalSha256"`
	} `json:"expected"`
}

func TestContractEvidencePostgres(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	store, err := postgresadapter.NewContractEvidenceStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	service, err := legal.NewContractEvidenceService(store, legalhash.OfferSHA256Hasher{})
	if err != nil {
		t.Fatal(err)
	}
	fixture := readIntegrationContractFixture(t)
	scope := fixture.contractScope(t)
	insertContractOwner(t, ctx, pool, scope, 1_000)
	command := legal.ContractConfirmationCommand{
		SubmissionID:       mustIntegrationContractSubmissionID(t, fixture.SubmissionID),
		PresentedOfferHash: mustIntegrationContractHash(t, fixture.Expected.CanonicalSHA256),
		Consent:            legal.ContractConsentAffirmed,
	}
	evidenceID := mustIntegrationContractEvidenceID(t, fixture.EvidenceID)
	created := service.Confirm(ctx, scope, fixture.Disclosure, command, evidenceID, fixture.ConfirmedAt)
	if created.Kind != legal.ContractConfirmationAccepted || created.Outcome != legal.ContractEvidenceRecorded {
		t.Fatalf("created evidence = %#v", created)
	}
	replayed := service.Confirm(
		ctx, scope, fixture.Disclosure, command,
		mustIntegrationContractEvidenceID(t, integrationUUID(t, 731)), fixture.ConfirmedAt+1,
	)
	if replayed.Kind != legal.ContractConfirmationAccepted || replayed.Outcome != legal.ContractEvidenceReplayed ||
		replayed.Evidence.EvidenceID != created.Evidence.EvidenceID || replayed.Evidence.ConfirmedAt != created.Evidence.ConfirmedAt {
		t.Fatalf("replayed evidence = %#v", replayed)
	}
	foreign := legal.TermsScope{AccountID: integrationAccountID(t, 191), VaultID: integrationVaultID(t, 291)}
	if found, err := store.FindBySubmission(ctx, foreign, command.SubmissionID); err != nil || found != nil {
		t.Fatalf("cross-owner lookup = %#v, %v", found, err)
	}

	assertContractEvidenceImmutable(t, ctx, pool, scope, evidenceID)
	assertContractEvidenceOwnerIsolation(t, ctx, store, service, fixture)
	assertConcurrentContractEvidenceReplay(t, ctx, pool, service, fixture)
	assertContractEvidenceBlocksImplicitOwnerDeletion(t, ctx, pool, scope)
	assertMalformedContractEvidenceFailsClosed(t, ctx, pool, store, scope)
	if pool.Stat().AcquiredConns() != 0 {
		t.Fatalf("database connections still acquired: %d", pool.Stat().AcquiredConns())
	}
}

func assertContractEvidenceImmutable(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	scope legal.TermsScope,
	evidenceID legal.ContractEvidenceID,
) {
	t.Helper()
	_, err := pool.Exec(
		ctx,
		"UPDATE contract_evidence SET confirmed_at = confirmed_at + 1 WHERE account_id = $1 AND vault_id = $2 AND evidence_id = $3",
		string(scope.AccountID), string(scope.VaultID), string(evidenceID),
	)
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) || postgresError.ConstraintName != "contract_evidence_immutable" {
		t.Fatalf("immutable update error = %v", err)
	}
}

func assertContractEvidenceOwnerIsolation(
	t *testing.T,
	ctx context.Context,
	store *postgresadapter.ContractEvidenceStore,
	service *legal.ContractEvidenceService,
	fixture integrationContractFixture,
) {
	t.Helper()
	scope := legal.TermsScope{AccountID: integrationAccountID(t, 190), VaultID: integrationVaultID(t, 290)}
	prepared := service.PrepareOffer(ctx, fixture.Disclosure)
	if prepared.Kind != legal.PrepareContractAvailable {
		t.Fatalf("prepared offer = %#v", prepared)
	}
	record := legal.ContractEvidenceRecord{
		Scope: scope, EvidenceID: mustIntegrationContractEvidenceID(t, integrationUUID(t, 790)),
		SubmissionID: mustIntegrationContractSubmissionID(t, integrationUUID(t, 890)),
		OfferHash:    prepared.Prepared.OfferHash, Offer: prepared.Prepared.Offer,
		SerializedOffer: prepared.Prepared.SerializedOffer, Consent: legal.ContractConsentAffirmed, ConfirmedAt: 4_000,
	}
	result, err := store.Append(ctx, record)
	if err != nil || result.Kind != legal.ContractEvidenceAppendOwnerMismatch {
		t.Fatalf("ownerless append = %#v, %v", result, err)
	}
	if found, err := store.FindBySubmission(ctx, scope, record.SubmissionID); err != nil || found != nil {
		t.Fatalf("ownerless evidence = %#v, %v", found, err)
	}
}

func assertConcurrentContractEvidenceReplay(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	service *legal.ContractEvidenceService,
	fixture integrationContractFixture,
) {
	t.Helper()
	scope := legal.TermsScope{AccountID: integrationAccountID(t, 192), VaultID: integrationVaultID(t, 292)}
	// The owner row is inserted with a separate connection before the race.
	// Each goroutine then runs the repository's serializable append transaction.
	insertContractOwner(t, ctx, pool, scope, 1_100)
	submissionID := mustIntegrationContractSubmissionID(t, integrationUUID(t, 892))
	command := legal.ContractConfirmationCommand{
		SubmissionID: submissionID, PresentedOfferHash: mustIntegrationContractHash(t, fixture.Expected.CanonicalSHA256),
		Consent: legal.ContractConsentAffirmed,
	}
	type outcome struct {
		result legal.ContractConfirmationResult
	}
	start := make(chan struct{})
	outcomes := make(chan outcome, 2)
	var wait sync.WaitGroup
	for _, rawID := range []string{integrationUUID(t, 792), integrationUUID(t, 793)} {
		wait.Add(1)
		go func(value string) {
			defer wait.Done()
			<-start
			outcomes <- outcome{result: service.Confirm(
				ctx, scope, fixture.Disclosure, command,
				mustIntegrationContractEvidenceID(t, value), 5_000,
			)}
		}(rawID)
	}
	close(start)
	wait.Wait()
	close(outcomes)
	var evidence *legal.ContractEvidenceRecord
	for outcome := range outcomes {
		if outcome.result.Kind != legal.ContractConfirmationAccepted {
			t.Fatalf("concurrent confirmation = %#v", outcome.result)
		}
		if evidence == nil {
			copy := outcome.result.Evidence
			evidence = &copy
		} else if evidence.EvidenceID != outcome.result.Evidence.EvidenceID || evidence.ConfirmedAt != outcome.result.Evidence.ConfirmedAt {
			t.Fatalf("concurrent evidence differs: %#v and %#v", *evidence, outcome.result.Evidence)
		}
	}
}

func assertContractEvidenceBlocksImplicitOwnerDeletion(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	scope legal.TermsScope,
) {
	t.Helper()
	_, err := pool.Exec(ctx, "DELETE FROM personal_vaults WHERE account_id = $1 AND vault_id = $2", string(scope.AccountID), string(scope.VaultID))
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) || postgresError.ConstraintName != "contract_evidence_owner_fk" {
		t.Fatalf("implicit owner deletion error = %v", err)
	}
}

func assertMalformedContractEvidenceFailsClosed(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	store *postgresadapter.ContractEvidenceStore,
	scope legal.TermsScope,
) {
	t.Helper()
	if _, err := pool.Exec(ctx, "ALTER TABLE contract_evidence DROP CONSTRAINT contract_evidence_shape_check"); err != nil {
		t.Fatal(err)
	}
	evidenceID := mustIntegrationContractEvidenceID(t, integrationUUID(t, 794))
	submissionID := mustIntegrationContractSubmissionID(t, integrationUUID(t, 894))
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO contract_evidence(
		 account_id, vault_id, evidence_id, submission_id, offer_hash,
		 offer_version, disclosure_version, serialized_offer, consent, confirmed_at
		) VALUES ($1, $2, $3, $4, $5, 'legal-commerce-v1:2026-09-14', '2026-09-14', '{}', 'affirmed', 6000)`,
		string(scope.AccountID), string(scope.VaultID), string(evidenceID), string(submissionID),
		"sha256:"+strings.Repeat("a", 64),
	); err != nil {
		t.Fatal(err)
	}
	if record, err := store.FindBySubmission(ctx, scope, submissionID); !errors.Is(err, postgresadapter.ErrInvalidContractEvidenceRecord) || record != nil {
		t.Fatalf("malformed record = %#v, %v", record, err)
	}
}

func insertContractOwner(t *testing.T, ctx context.Context, pool *pgxpool.Pool, scope legal.TermsScope, createdAt int64) {
	t.Helper()
	if _, err := pool.Exec(ctx, "INSERT INTO accounts(account_id, created_at) VALUES ($1, $2)", string(scope.AccountID), createdAt); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx, "INSERT INTO personal_vaults(vault_id, account_id, created_at) VALUES ($1, $2, $3)",
		string(scope.VaultID), string(scope.AccountID), createdAt,
	); err != nil {
		t.Fatal(err)
	}
}

func readIntegrationContractFixture(t *testing.T) integrationContractFixture {
	t.Helper()
	content, err := os.ReadFile("../../../contracts/fixtures/legal/contract-evidence.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture integrationContractFixture
	if err := json.Unmarshal(content, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func (fixture integrationContractFixture) contractScope(t *testing.T) legal.TermsScope {
	t.Helper()
	accountID, err := identity.ParseAccountID(fixture.Scope.AccountID)
	if err != nil {
		t.Fatal(err)
	}
	vaultID, err := identity.ParseVaultID(fixture.Scope.VaultID)
	if err != nil {
		t.Fatal(err)
	}
	return legal.TermsScope{AccountID: accountID, VaultID: vaultID}
}

func mustIntegrationContractEvidenceID(t *testing.T, value string) legal.ContractEvidenceID {
	t.Helper()
	parsed, err := legal.ParseContractEvidenceID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustIntegrationContractSubmissionID(t *testing.T, value string) legal.ContractSubmissionID {
	t.Helper()
	parsed, err := legal.ParseContractSubmissionID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func mustIntegrationContractHash(t *testing.T, value string) legal.ContractOfferHash {
	t.Helper()
	parsed, err := legal.ParseContractOfferHash(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

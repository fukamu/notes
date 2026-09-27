package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/privacyrequest"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalidPrivacyRequestOperation = errors.New("invalid privacy request operation")
	ErrInvalidPrivacyRequestRecord    = errors.New("invalid stored privacy request record")
)

type PrivacyRequestStore struct {
	pool *pgxpool.Pool
}

var _ privacyrequest.Repository = (*PrivacyRequestStore)(nil)

const privacyRequestSelect = `SELECT account_id, vault_id, request_id, submission_id,
       request_kind, revision, state, verification_receipt_id, verified_at,
       started_at, completed_at, outcome, rejected_at, rejection_reason,
       failed_at, failure_code, retryable, requested_at, updated_at
  FROM privacy_requests`

func NewPrivacyRequestStore(pool *pgxpool.Pool) (*PrivacyRequestStore, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &PrivacyRequestStore{pool: pool}, nil
}

func (store *PrivacyRequestStore) FindByID(
	ctx context.Context,
	scope privacyrequest.Scope,
	requestID privacyrequest.RequestID,
) (*privacyrequest.Record, error) {
	if !validPrivacyRequestStore(store) || !privacyrequest.ValidScope(scope) {
		return nil, ErrInvalidPrivacyRequestOperation
	}
	if _, err := privacyrequest.ParseRequestID(string(requestID)); err != nil {
		return nil, ErrInvalidPrivacyRequestOperation
	}
	return scanOptionalPrivacyRequest(store.pool.QueryRow(ctx,
		privacyRequestSelect+" WHERE account_id = $1 AND vault_id = $2 AND request_id = $3",
		string(scope.AccountID), string(scope.VaultID), string(requestID),
	))
}

func (store *PrivacyRequestStore) FindBySubmission(
	ctx context.Context,
	scope privacyrequest.Scope,
	submissionID privacyrequest.SubmissionID,
) (*privacyrequest.Record, error) {
	if !validPrivacyRequestStore(store) || !privacyrequest.ValidScope(scope) {
		return nil, ErrInvalidPrivacyRequestOperation
	}
	if _, err := privacyrequest.ParseSubmissionID(string(submissionID)); err != nil {
		return nil, ErrInvalidPrivacyRequestOperation
	}
	return scanOptionalPrivacyRequest(store.pool.QueryRow(ctx,
		privacyRequestSelect+" WHERE account_id = $1 AND vault_id = $2 AND submission_id = $3",
		string(scope.AccountID), string(scope.VaultID), string(submissionID),
	))
}

func (store *PrivacyRequestStore) Create(
	ctx context.Context,
	record privacyrequest.Record,
) (privacyrequest.CreateResult, error) {
	if !validPrivacyRequestStore(store) || !privacyrequest.InitialRecord(record) {
		return privacyrequest.CreateResult{Kind: privacyrequest.CreateRejected}, nil
	}
	bindings := privacyRequestBindings(record)
	tag, err := store.pool.Exec(ctx, `INSERT INTO privacy_requests(
		account_id, vault_id, request_id, submission_id, request_kind, revision,
		state, verification_receipt_id, verified_at, started_at, completed_at,
		outcome, rejected_at, rejection_reason, failed_at, failure_code, retryable,
		requested_at, updated_at
	) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
		$14, $15, $16, $17, $18, $19) ON CONFLICT DO NOTHING`, bindings...)
	if isPrivacyRequestOwnerViolation(err) {
		return privacyrequest.CreateResult{Kind: privacyrequest.CreateRejected}, nil
	}
	if err != nil {
		return privacyrequest.CreateResult{}, classifyPrivacyRequestError(err)
	}
	if tag.RowsAffected() == 1 {
		created := record
		return privacyrequest.CreateResult{Kind: privacyrequest.CreateCreated, Record: &created}, nil
	}
	existing, err := store.FindBySubmission(ctx, record.Scope, record.SubmissionID)
	if err != nil {
		return privacyrequest.CreateResult{}, err
	}
	if existing != nil {
		if existing.RequestKind == record.RequestKind {
			return privacyrequest.CreateResult{Kind: privacyrequest.CreateExisting, Record: existing}, nil
		}
		return privacyrequest.CreateResult{Kind: privacyrequest.CreateConflict}, nil
	}
	byID, err := store.FindByID(ctx, record.Scope, record.RequestID)
	if err != nil {
		return privacyrequest.CreateResult{}, err
	}
	if byID != nil && byID.SubmissionID == record.SubmissionID && byID.RequestKind == record.RequestKind {
		return privacyrequest.CreateResult{Kind: privacyrequest.CreateExisting, Record: byID}, nil
	}
	return privacyrequest.CreateResult{Kind: privacyrequest.CreateConflict}, nil
}

func (store *PrivacyRequestStore) Commit(
	ctx context.Context,
	scope privacyrequest.Scope,
	transition privacyrequest.Transition,
) (privacyrequest.CommitResult, error) {
	if !validPrivacyRequestStore(store) || !privacyrequest.ValidTransition(scope, transition) {
		return privacyrequest.CommitResult{Kind: privacyrequest.CommitRejected}, nil
	}
	state := privacyRequestStateBindings(transition.Next.State)
	tag, err := store.pool.Exec(ctx, `UPDATE privacy_requests SET
		revision = $1, state = $2, verification_receipt_id = $3, verified_at = $4,
		started_at = $5, completed_at = $6, outcome = $7, rejected_at = $8,
		rejection_reason = $9, failed_at = $10, failure_code = $11,
		retryable = $12, updated_at = $13
		WHERE account_id = $14 AND vault_id = $15 AND request_id = $16 AND revision = $17`,
		transition.Next.Revision, state.kind, state.verificationReceiptID, state.verifiedAt,
		state.startedAt, state.completedAt, state.outcome, state.rejectedAt,
		state.rejectionReason, state.failedAt, state.failureCode, state.retryable,
		transition.Next.UpdatedAt, string(scope.AccountID), string(scope.VaultID),
		string(transition.Current.RequestID), transition.Current.Revision,
	)
	if err != nil {
		return privacyrequest.CommitResult{}, classifyPrivacyRequestError(err)
	}
	persisted, err := store.FindByID(ctx, scope, transition.Current.RequestID)
	if err != nil {
		return privacyrequest.CommitResult{}, err
	}
	if tag.RowsAffected() == 1 {
		if persisted == nil || !privacyrequest.SameRecord(*persisted, transition.Next) {
			return privacyrequest.CommitResult{}, ErrInvalidPrivacyRequestRecord
		}
		return privacyrequest.CommitResult{Kind: privacyrequest.CommitApplied, Record: persisted}, nil
	}
	if persisted != nil && privacyrequest.SameRecord(*persisted, transition.Next) {
		return privacyrequest.CommitResult{Kind: privacyrequest.CommitReplayed, Record: persisted}, nil
	}
	return privacyrequest.CommitResult{Kind: privacyrequest.CommitConflict, Current: persisted}, nil
}

type privacyRequestStateColumns struct {
	kind                  string
	verificationReceiptID *string
	verifiedAt            *int64
	startedAt             *int64
	completedAt           *int64
	outcome               *string
	rejectedAt            *int64
	rejectionReason       *string
	failedAt              *int64
	failureCode           *string
	retryable             *bool
}

func privacyRequestBindings(record privacyrequest.Record) []any {
	state := privacyRequestStateBindings(record.State)
	return []any{
		string(record.Scope.AccountID), string(record.Scope.VaultID), string(record.RequestID),
		string(record.SubmissionID), string(record.RequestKind), record.Revision, state.kind,
		state.verificationReceiptID, state.verifiedAt, state.startedAt, state.completedAt,
		state.outcome, state.rejectedAt, state.rejectionReason, state.failedAt,
		state.failureCode, state.retryable, record.RequestedAt, record.UpdatedAt,
	}
}

func privacyRequestStateBindings(state privacyrequest.State) privacyRequestStateColumns {
	columns := privacyRequestStateColumns{kind: string(state.Kind())}
	switch value := state.(type) {
	case privacyrequest.Ready:
		columns.verificationReceiptID = stringPointer(string(value.VerificationReceiptID))
		columns.verifiedAt = int64Pointer(value.VerifiedAt)
	case privacyrequest.Processing:
		columns.verificationReceiptID = stringPointer(string(value.VerificationReceiptID))
		columns.verifiedAt = int64Pointer(value.VerifiedAt)
		columns.startedAt = int64Pointer(value.StartedAt)
	case privacyrequest.Completed:
		columns.verificationReceiptID = stringPointer(string(value.VerificationReceiptID))
		columns.verifiedAt = int64Pointer(value.VerifiedAt)
		columns.startedAt = int64Pointer(value.StartedAt)
		columns.completedAt = int64Pointer(value.CompletedAt)
		columns.outcome = stringPointer(string(value.Outcome))
	case privacyrequest.Rejected:
		columns.rejectedAt = int64Pointer(value.RejectedAt)
		columns.rejectionReason = stringPointer(string(value.Reason))
	case privacyrequest.Failed:
		columns.verificationReceiptID = stringPointer(string(value.VerificationReceiptID))
		columns.verifiedAt = int64Pointer(value.VerifiedAt)
		columns.startedAt = int64Pointer(value.StartedAt)
		columns.failedAt = int64Pointer(value.FailedAt)
		columns.failureCode = stringPointer(string(value.FailureCode))
		columns.retryable = boolPointer(value.Retryable)
	}
	return columns
}

func scanOptionalPrivacyRequest(row rowScanner) (*privacyrequest.Record, error) {
	record, err := scanPrivacyRequest(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func scanPrivacyRequest(row rowScanner) (privacyrequest.Record, error) {
	var accountID, vaultID, requestID, submissionID, requestKind, stateKind string
	var revision, requestedAt, updatedAt int64
	var verificationReceiptID, outcome, rejectionReason, failureCode *string
	var verifiedAt, startedAt, completedAt, rejectedAt, failedAt *int64
	var retryable *bool
	if err := row.Scan(
		&accountID, &vaultID, &requestID, &submissionID, &requestKind, &revision,
		&stateKind, &verificationReceiptID, &verifiedAt, &startedAt, &completedAt,
		&outcome, &rejectedAt, &rejectionReason, &failedAt, &failureCode, &retryable,
		&requestedAt, &updatedAt,
	); err != nil {
		return privacyrequest.Record{}, err
	}
	parsedAccountID, accountErr := identity.ParseAccountID(accountID)
	parsedVaultID, vaultErr := identity.ParseVaultID(vaultID)
	parsedRequestID, requestErr := privacyrequest.ParseRequestID(requestID)
	parsedSubmissionID, submissionErr := privacyrequest.ParseSubmissionID(submissionID)
	state, stateErr := decodePrivacyRequestState(privacyRequestStateColumns{
		kind: stateKind, verificationReceiptID: verificationReceiptID, verifiedAt: verifiedAt,
		startedAt: startedAt, completedAt: completedAt, outcome: outcome, rejectedAt: rejectedAt,
		rejectionReason: rejectionReason, failedAt: failedAt, failureCode: failureCode, retryable: retryable,
	})
	record := privacyrequest.Record{
		Scope:     privacyrequest.Scope{AccountID: parsedAccountID, VaultID: parsedVaultID},
		RequestID: parsedRequestID, SubmissionID: parsedSubmissionID,
		RequestKind: privacyrequest.RequestKind(requestKind), Revision: revision,
		State: state, RequestedAt: requestedAt, UpdatedAt: updatedAt,
	}
	if accountErr != nil || vaultErr != nil || requestErr != nil || submissionErr != nil ||
		stateErr != nil || !privacyrequest.ValidRecord(record) {
		return privacyrequest.Record{}, ErrInvalidPrivacyRequestRecord
	}
	return record, nil
}

func decodePrivacyRequestState(columns privacyRequestStateColumns) (privacyrequest.State, error) {
	noVerification := columns.verificationReceiptID == nil && columns.verifiedAt == nil
	noProcessing := columns.startedAt == nil && columns.completedAt == nil && columns.outcome == nil
	noRejection := columns.rejectedAt == nil && columns.rejectionReason == nil
	noFailure := columns.failedAt == nil && columns.failureCode == nil && columns.retryable == nil
	switch privacyrequest.StateKind(columns.kind) {
	case privacyrequest.StateVerificationPending:
		if noVerification && noProcessing && noRejection && noFailure {
			return privacyrequest.VerificationPending{}, nil
		}
	case privacyrequest.StateReady:
		if columns.verificationReceiptID != nil && columns.verifiedAt != nil && noProcessing && noRejection && noFailure {
			receiptID, err := privacyrequest.ParseVerificationReceiptID(*columns.verificationReceiptID)
			return privacyrequest.Ready{VerificationReceiptID: receiptID, VerifiedAt: *columns.verifiedAt}, err
		}
	case privacyrequest.StateProcessing:
		if columns.verificationReceiptID != nil && columns.verifiedAt != nil && columns.startedAt != nil &&
			columns.completedAt == nil && columns.outcome == nil && noRejection && noFailure {
			receiptID, err := privacyrequest.ParseVerificationReceiptID(*columns.verificationReceiptID)
			return privacyrequest.Processing{VerificationReceiptID: receiptID, VerifiedAt: *columns.verifiedAt, StartedAt: *columns.startedAt}, err
		}
	case privacyrequest.StateCompleted:
		if columns.verificationReceiptID != nil && columns.verifiedAt != nil && columns.startedAt != nil &&
			columns.completedAt != nil && columns.outcome != nil && noRejection && noFailure {
			receiptID, err := privacyrequest.ParseVerificationReceiptID(*columns.verificationReceiptID)
			return privacyrequest.Completed{
				VerificationReceiptID: receiptID, VerifiedAt: *columns.verifiedAt,
				StartedAt: *columns.startedAt, CompletedAt: *columns.completedAt,
				Outcome: privacyrequest.Outcome(*columns.outcome),
			}, err
		}
	case privacyrequest.StateRejected:
		if noVerification && noProcessing && columns.rejectedAt != nil && columns.rejectionReason != nil && noFailure {
			return privacyrequest.Rejected{RejectedAt: *columns.rejectedAt, Reason: privacyrequest.RejectionReason(*columns.rejectionReason)}, nil
		}
	case privacyrequest.StateFailed:
		if columns.verificationReceiptID != nil && columns.verifiedAt != nil && columns.startedAt != nil &&
			columns.completedAt == nil && columns.outcome == nil && noRejection &&
			columns.failedAt != nil && columns.failureCode != nil && columns.retryable != nil {
			receiptID, receiptErr := privacyrequest.ParseVerificationReceiptID(*columns.verificationReceiptID)
			code, codeErr := privacyrequest.ParseFailureCode(*columns.failureCode)
			if receiptErr != nil || codeErr != nil {
				return nil, ErrInvalidPrivacyRequestRecord
			}
			return privacyrequest.Failed{
				VerificationReceiptID: receiptID, VerifiedAt: *columns.verifiedAt,
				StartedAt: *columns.startedAt, FailedAt: *columns.failedAt,
				FailureCode: code, Retryable: *columns.retryable,
			}, nil
		}
	}
	return nil, ErrInvalidPrivacyRequestRecord
}

func validPrivacyRequestStore(store *PrivacyRequestStore) bool {
	return store != nil && store.pool != nil
}

func isPrivacyRequestOwnerViolation(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "23503" &&
		postgresError.ConstraintName == "privacy_request_owner"
}

func classifyPrivacyRequestError(err error) error {
	if err == nil {
		return nil
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		switch postgresError.Code {
		case "23503":
			return ErrInvalidPrivacyRequestOperation
		case "23514", "22003":
			return ErrInvalidPrivacyRequestRecord
		}
	}
	return err
}

func stringPointer(value string) *string { return &value }
func int64Pointer(value int64) *int64    { return &value }
func boolPointer(value bool) *bool       { return &value }

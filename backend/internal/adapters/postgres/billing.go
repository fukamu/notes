package postgres

import (
	"context"
	"database/sql"
	"errors"

	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalidBillingOperation = errors.New("invalid billing operation")
	ErrInvalidBillingRecord    = errors.New("invalid stored billing record")
	errCheckoutWriteConflict   = errors.New("billing checkout write conflict")
)

type BillingStore struct {
	pool *pgxpool.Pool
}

var _ billing.BillingRepository = (*BillingStore)(nil)

func NewBillingStore(pool *pgxpool.Pool) (*BillingStore, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &BillingStore{pool: pool}, nil
}

const subscriptionSelect = `SELECT subscription_id, account_id, vault_id, provider,
       provider_customer_ref, provider_subscription_ref, version, status,
       payment_method_ready, payment_method_updated_at,
       trial_started_at, trial_ends_at, trial_observed_at,
       paid_period_started_at, paid_period_ends_at,
       last_paid_at, last_paid_invoice_ref, last_delinquency_at,
       delinquency_reason, delinquency_since, delinquency_invoice_ref,
       cancel_at, cancellation_updated_at, cancelled_at, last_reconciled_at,
       created_at, updated_at
  FROM billing_subscriptions`

const checkoutSelect = `SELECT checkout_intent_id, subscription_id, provider,
       provider_checkout_ref, status, created_at, opened_at
  FROM billing_checkout_intents`

func (store *BillingStore) FindByOwner(
	ctx context.Context,
	scope billing.OwnerScope,
) (*billing.SubscriptionRecord, error) {
	if store == nil || store.pool == nil || !scope.Valid() {
		return nil, ErrInvalidBillingOperation
	}
	return scanOptionalSubscription(store.pool.QueryRow(
		ctx, subscriptionSelect+" WHERE account_id = $1 AND vault_id = $2", string(scope.AccountID), string(scope.VaultID),
	))
}

func (store *BillingStore) FindByID(
	ctx context.Context,
	subscriptionID billing.SubscriptionID,
) (*billing.SubscriptionRecord, error) {
	if store == nil || store.pool == nil {
		return nil, ErrInvalidBillingOperation
	}
	if _, err := billing.ParseSubscriptionID(string(subscriptionID)); err != nil {
		return nil, ErrInvalidBillingOperation
	}
	return scanOptionalSubscription(store.pool.QueryRow(
		ctx, subscriptionSelect+" WHERE subscription_id = $1", string(subscriptionID),
	))
}

func (store *BillingStore) FindByProviderMapping(
	ctx context.Context,
	provider billing.Provider,
	customer billing.ProviderCustomerReference,
	subscription billing.ProviderSubscriptionReference,
) (*billing.SubscriptionRecord, error) {
	if store == nil || store.pool == nil || !validProviderMapping(provider, customer, subscription) {
		return nil, ErrInvalidBillingOperation
	}
	return scanOptionalSubscription(store.pool.QueryRow(
		ctx,
		subscriptionSelect+" WHERE provider = $1 AND provider_customer_ref = $2 AND provider_subscription_ref = $3",
		string(provider), string(customer), string(subscription),
	))
}

func (store *BillingStore) FindCheckoutIntent(
	ctx context.Context,
	checkoutID billing.CheckoutIntentID,
) (*billing.CheckoutIntentRecord, error) {
	if store == nil || store.pool == nil {
		return nil, ErrInvalidBillingOperation
	}
	if _, err := billing.ParseCheckoutIntentID(string(checkoutID)); err != nil {
		return nil, ErrInvalidBillingOperation
	}
	return scanOptionalCheckout(store.pool.QueryRow(
		ctx, checkoutSelect+" WHERE checkout_intent_id = $1", string(checkoutID),
	))
}

func (store *BillingStore) FindCheckoutByProviderReference(
	ctx context.Context,
	provider billing.Provider,
	reference billing.ProviderCheckoutReference,
) (*billing.CheckoutIntentRecord, error) {
	if store == nil || store.pool == nil {
		return nil, ErrInvalidBillingOperation
	}
	if _, err := billing.ParseProvider(string(provider)); err != nil {
		return nil, ErrInvalidBillingOperation
	}
	if _, err := billing.ParseProviderCheckoutReference(string(reference)); err != nil {
		return nil, ErrInvalidBillingOperation
	}
	return scanOptionalCheckout(store.pool.QueryRow(
		ctx, checkoutSelect+" WHERE provider = $1 AND provider_checkout_ref = $2", string(provider), string(reference),
	))
}

func (store *BillingStore) CreateCheckout(
	ctx context.Context,
	record billing.SubscriptionRecord,
	intent billing.CheckoutIntentRecord,
) (billing.CheckoutCreateResult, error) {
	if store == nil || store.pool == nil || !billing.ValidRecord(record) || !validCreatedCheckout(record, intent) {
		return billing.CheckoutCreateResult{}, ErrInvalidBillingOperation
	}
	result := billing.CheckoutCreateResult{}
	err := WithSerializableTx(ctx, store.pool, func(transaction pgx.Tx) error {
		tag, err := insertSubscription(ctx, transaction, record)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			result.Kind = billing.CheckoutExisting
			return nil
		}
		tag, err = transaction.Exec(
			ctx,
			`INSERT INTO billing_checkout_intents(
			 checkout_intent_id, subscription_id, provider, provider_checkout_ref, status, created_at, opened_at
			 ) VALUES ($1, $2, $3, NULL, 'created', $4, NULL)
			 ON CONFLICT DO NOTHING`,
			string(intent.CheckoutIntentID), string(intent.SubscriptionID), string(intent.Provider), intent.CreatedAt,
		)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errCheckoutWriteConflict
		}
		result.Kind = billing.CheckoutCreated
		return nil
	})
	if err != nil && !errors.Is(err, errCheckoutWriteConflict) {
		return billing.CheckoutCreateResult{}, err
	}
	if result.Kind == billing.CheckoutCreated {
		return result, nil
	}
	existingRecord, findErr := store.FindByID(ctx, record.SubscriptionID)
	if findErr != nil {
		return billing.CheckoutCreateResult{}, findErr
	}
	if existingRecord == nil {
		existingRecord, findErr = store.FindByOwner(ctx, billing.OwnerScope{AccountID: record.AccountID, VaultID: record.VaultID})
		if findErr != nil {
			return billing.CheckoutCreateResult{}, findErr
		}
	}
	existingIntent, findErr := store.FindCheckoutIntent(ctx, intent.CheckoutIntentID)
	if findErr != nil {
		return billing.CheckoutCreateResult{}, findErr
	}
	return billing.CheckoutCreateResult{Kind: billing.CheckoutExisting, Record: existingRecord, Intent: existingIntent}, nil
}

func (store *BillingStore) OpenCheckout(
	ctx context.Context,
	scope billing.OwnerScope,
	intent billing.CheckoutIntentRecord,
) (billing.CommitKind, error) {
	if store == nil || store.pool == nil || !scope.Valid() || !validOpenedCheckout(intent) {
		return "", ErrInvalidBillingOperation
	}
	result := billing.CommitConflict
	err := WithSerializableTx(ctx, store.pool, func(transaction pgx.Tx) error {
		var rawAccountID, rawVaultID string
		stored, scanErr := scanCheckout(transaction.QueryRow(
			ctx,
			`SELECT checkout.checkout_intent_id, checkout.subscription_id, checkout.provider,
			        checkout.provider_checkout_ref, checkout.status, checkout.created_at, checkout.opened_at,
			        subscription.account_id, subscription.vault_id
			   FROM billing_checkout_intents checkout
			 JOIN billing_subscriptions subscription ON subscription.subscription_id = checkout.subscription_id
			 WHERE checkout.checkout_intent_id = $1 FOR UPDATE`,
			string(intent.CheckoutIntentID),
		), &rawAccountID, &rawVaultID)
		if errors.Is(scanErr, pgx.ErrNoRows) {
			result = billing.CommitConflict
			return nil
		}
		if scanErr != nil {
			return scanErr
		}
		if rawAccountID != string(scope.AccountID) || rawVaultID != string(scope.VaultID) ||
			stored.SubscriptionID != intent.SubscriptionID || stored.Provider != intent.Provider ||
			stored.CreatedAt != intent.CreatedAt {
			result = billing.CommitConflict
			return nil
		}
		if stored.Status == billing.CheckoutIntentOpened {
			if stored.ProviderCheckoutReference == intent.ProviderCheckoutReference &&
				stored.OpenedAt != nil && intent.OpenedAt != nil && *stored.OpenedAt == *intent.OpenedAt {
				result = billing.CommitReplayed
			} else {
				result = billing.CommitConflict
			}
			return nil
		}
		tag, updateErr := transaction.Exec(
			ctx,
			`UPDATE billing_checkout_intents
			 SET provider_checkout_ref = $1, status = 'opened', opened_at = $2
			 WHERE checkout_intent_id = $3 AND status = 'created'`,
			string(intent.ProviderCheckoutReference), *intent.OpenedAt, string(intent.CheckoutIntentID),
		)
		if updateErr != nil {
			return updateErr
		}
		if tag.RowsAffected() == 1 {
			result = billing.CommitApplied
		}
		return nil
	})
	if isUniqueViolation(err) {
		return billing.CommitConflict, nil
	}
	return normalizeBillingCommit(result, err)
}

func (store *BillingStore) FindProviderEventReceipt(
	ctx context.Context,
	provider billing.Provider,
	eventID billing.ProviderEventID,
) (*billing.ProviderEventReceipt, error) {
	if store == nil || store.pool == nil || !validProviderEventKey(provider, eventID) {
		return nil, ErrInvalidBillingOperation
	}
	receipt, err := scanProviderReceipt(store.pool.QueryRow(
		ctx,
		`SELECT provider, provider_event_id, subscription_id, fact_kind, outcome,
		        occurred_at, applied_version, recorded_at
		   FROM billing_provider_event_receipts
		  WHERE provider = $1 AND provider_event_id = $2`,
		string(provider), string(eventID),
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &receipt, nil
}

func (store *BillingStore) CommitProviderFact(
	ctx context.Context,
	expected billing.SubscriptionRecord,
	next billing.SubscriptionRecord,
	receipt billing.ProviderEventReceipt,
) (billing.CommitKind, error) {
	if store == nil || store.pool == nil || !validFactCommit(expected, next, receipt) {
		return "", ErrInvalidBillingOperation
	}
	result := billing.CommitConflict
	err := WithSerializableTx(ctx, store.pool, func(transaction pgx.Tx) error {
		stored, scanErr := scanSubscription(transaction.QueryRow(
			ctx, subscriptionSelect+" WHERE subscription_id = $1 FOR UPDATE", string(expected.SubscriptionID),
		))
		if errors.Is(scanErr, pgx.ErrNoRows) {
			result = billing.CommitConflict
			return nil
		}
		if scanErr != nil {
			return scanErr
		}
		found, findErr := providerReceiptExists(ctx, transaction, receipt, &result)
		if findErr != nil {
			return findErr
		}
		if found {
			return nil
		}
		if stored.Version != expected.Version {
			result = billing.CommitConflict
			return nil
		}
		inserted, insertErr := insertProviderReceipt(ctx, transaction, receipt)
		if insertErr != nil {
			return insertErr
		}
		if !inserted {
			return classifyProviderReceiptConflict(ctx, transaction, receipt, &result)
		}
		updated, updateErr := updateSubscription(ctx, transaction, next, expected.Version)
		if updateErr != nil {
			return updateErr
		}
		if !updated {
			return errors.New("billing CAS changed while row lock held")
		}
		result = billing.CommitApplied
		return nil
	})
	return normalizeBillingCommit(result, err)
}

func (store *BillingStore) RecordIgnoredProviderFact(
	ctx context.Context,
	receipt billing.ProviderEventReceipt,
) (billing.CommitKind, error) {
	if store == nil || store.pool == nil || !validProviderReceipt(receipt) || receipt.Outcome != billing.ReceiptIgnored {
		return "", ErrInvalidBillingOperation
	}
	result := billing.CommitApplied
	err := WithSerializableTx(ctx, store.pool, func(transaction pgx.Tx) error {
		inserted, insertErr := insertProviderReceipt(ctx, transaction, receipt)
		if insertErr != nil {
			return insertErr
		}
		if !inserted {
			return classifyProviderReceiptConflict(ctx, transaction, receipt, &result)
		}
		return nil
	})
	return normalizeBillingCommit(result, err)
}

func (store *BillingStore) FindReconciliationCheckpoint(
	ctx context.Context,
	provider billing.Provider,
	snapshotID billing.ReconciliationSnapshotID,
) (*billing.ReconciliationCheckpoint, error) {
	if store == nil || store.pool == nil || !validSnapshotKey(provider, snapshotID) {
		return nil, ErrInvalidBillingOperation
	}
	checkpoint, err := scanReconciliationCheckpoint(store.pool.QueryRow(
		ctx,
		`SELECT provider, snapshot_id, subscription_id, observed_at, applied_version, recorded_at
		   FROM billing_reconciliation_checkpoints
		  WHERE provider = $1 AND snapshot_id = $2`,
		string(provider), string(snapshotID),
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &checkpoint, nil
}

func (store *BillingStore) CommitReconciliation(
	ctx context.Context,
	expected billing.SubscriptionRecord,
	next billing.SubscriptionRecord,
	checkpoint billing.ReconciliationCheckpoint,
) (billing.CommitKind, error) {
	if store == nil || store.pool == nil || !validReconciliationCommit(expected, next, checkpoint) {
		return "", ErrInvalidBillingOperation
	}
	result := billing.CommitConflict
	err := WithSerializableTx(ctx, store.pool, func(transaction pgx.Tx) error {
		stored, scanErr := scanSubscription(transaction.QueryRow(
			ctx, subscriptionSelect+" WHERE subscription_id = $1 FOR UPDATE", string(expected.SubscriptionID),
		))
		if errors.Is(scanErr, pgx.ErrNoRows) {
			result = billing.CommitConflict
			return nil
		}
		if scanErr != nil {
			return scanErr
		}
		found, findErr := checkpointExists(ctx, transaction, checkpoint, &result)
		if findErr != nil {
			return findErr
		}
		if found {
			return nil
		}
		if stored.Version != expected.Version {
			result = billing.CommitConflict
			return nil
		}
		inserted, insertErr := insertReconciliationCheckpoint(ctx, transaction, checkpoint)
		if insertErr != nil {
			return insertErr
		}
		if !inserted {
			return classifyCheckpointConflict(ctx, transaction, checkpoint, &result)
		}
		updated, updateErr := updateSubscription(ctx, transaction, next, expected.Version)
		if updateErr != nil {
			return updateErr
		}
		if !updated {
			return errors.New("billing reconciliation CAS changed while row lock held")
		}
		result = billing.CommitApplied
		return nil
	})
	return normalizeBillingCommit(result, err)
}

func (store *BillingStore) RecordIgnoredReconciliation(
	ctx context.Context,
	checkpoint billing.ReconciliationCheckpoint,
) (billing.CommitKind, error) {
	if store == nil || store.pool == nil || !validCheckpoint(checkpoint) {
		return "", ErrInvalidBillingOperation
	}
	result := billing.CommitApplied
	err := WithSerializableTx(ctx, store.pool, func(transaction pgx.Tx) error {
		inserted, insertErr := insertReconciliationCheckpoint(ctx, transaction, checkpoint)
		if insertErr != nil {
			return insertErr
		}
		if !inserted {
			return classifyCheckpointConflict(ctx, transaction, checkpoint, &result)
		}
		return nil
	})
	return normalizeBillingCommit(result, err)
}

func normalizeBillingCommit(result billing.CommitKind, err error) (billing.CommitKind, error) {
	if isRetryableTransactionError(err) {
		return billing.CommitConflict, nil
	}
	return result, err
}

func insertSubscription(ctx context.Context, transaction pgx.Tx, record billing.SubscriptionRecord) (pgconn.CommandTag, error) {
	shape := encodeLifecycle(record.Lifecycle)
	return transaction.Exec(
		ctx,
		`INSERT INTO billing_subscriptions(
		 subscription_id, account_id, vault_id, provider, provider_customer_ref, provider_subscription_ref,
		 version, status, payment_method_ready, payment_method_updated_at,
		 trial_started_at, trial_ends_at, trial_observed_at,
		 paid_period_started_at, paid_period_ends_at, last_paid_at, last_paid_invoice_ref, last_delinquency_at,
		 delinquency_reason, delinquency_since, delinquency_invoice_ref,
		 cancel_at, cancellation_updated_at, cancelled_at, last_reconciled_at, created_at, updated_at
		 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
		 ON CONFLICT DO NOTHING`,
		string(record.SubscriptionID), string(record.AccountID), string(record.VaultID), string(record.Provider),
		nullableString(string(record.ProviderCustomerReference)), nullableString(string(record.ProviderSubscriptionReference)),
		int64(record.Version), string(record.Lifecycle.Kind), record.PaymentMethodReady, nullableTimestamp(record.PaymentMethodUpdatedAt),
		shape.trialStartedAt, shape.trialEndsAt, nullableTimestamp(record.TrialObservedAt),
		shape.paidPeriodStartedAt, shape.paidPeriodEndsAt, nullableTimestamp(record.LastPaidAt),
		nullableString(string(record.LastPaidInvoiceReference)), nullableTimestamp(record.LastDelinquencyAt),
		shape.delinquencyReason, shape.delinquencySince,
		shape.delinquencyInvoiceReference, nullableTimestamp(record.CancelAt), nullableTimestamp(record.CancellationUpdatedAt),
		shape.cancelledAt, nullableTimestamp(record.LastReconciledAt), record.CreatedAt, record.UpdatedAt,
	)
}

func updateSubscription(
	ctx context.Context,
	transaction pgx.Tx,
	record billing.SubscriptionRecord,
	expectedVersion billing.Version,
) (bool, error) {
	shape := encodeLifecycle(record.Lifecycle)
	tag, err := transaction.Exec(
		ctx,
		`UPDATE billing_subscriptions SET
		 provider_customer_ref=$1, provider_subscription_ref=$2, version=$3, status=$4,
		 payment_method_ready=$5, payment_method_updated_at=$6,
		 trial_started_at=$7, trial_ends_at=$8, trial_observed_at=$9,
		 paid_period_started_at=$10, paid_period_ends_at=$11, last_paid_at=$12, last_paid_invoice_ref=$13,
		 last_delinquency_at=$14, delinquency_reason=$15, delinquency_since=$16, delinquency_invoice_ref=$17,
		 cancel_at=$18, cancellation_updated_at=$19, cancelled_at=$20, last_reconciled_at=$21, updated_at=$22
		 WHERE subscription_id=$23 AND version=$24`,
		nullableString(string(record.ProviderCustomerReference)), nullableString(string(record.ProviderSubscriptionReference)),
		int64(record.Version), string(record.Lifecycle.Kind), record.PaymentMethodReady, nullableTimestamp(record.PaymentMethodUpdatedAt),
		shape.trialStartedAt, shape.trialEndsAt, nullableTimestamp(record.TrialObservedAt),
		shape.paidPeriodStartedAt, shape.paidPeriodEndsAt, nullableTimestamp(record.LastPaidAt),
		nullableString(string(record.LastPaidInvoiceReference)), nullableTimestamp(record.LastDelinquencyAt),
		shape.delinquencyReason, shape.delinquencySince,
		shape.delinquencyInvoiceReference, nullableTimestamp(record.CancelAt), nullableTimestamp(record.CancellationUpdatedAt),
		shape.cancelledAt, nullableTimestamp(record.LastReconciledAt), record.UpdatedAt,
		string(record.SubscriptionID), int64(expectedVersion),
	)
	return tag.RowsAffected() == 1, err
}

func insertProviderReceipt(ctx context.Context, transaction pgx.Tx, receipt billing.ProviderEventReceipt) (bool, error) {
	tag, err := transaction.Exec(
		ctx,
		`INSERT INTO billing_provider_event_receipts(
		 provider, provider_event_id, subscription_id, fact_kind, outcome, occurred_at, applied_version, recorded_at
		 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
		string(receipt.Provider), string(receipt.EventID), string(receipt.SubscriptionID), string(receipt.FactKind),
		string(receipt.Outcome), receipt.OccurredAt, int64(receipt.AppliedVersion), receipt.RecordedAt,
	)
	return tag.RowsAffected() == 1, err
}

func insertReconciliationCheckpoint(
	ctx context.Context,
	transaction pgx.Tx,
	checkpoint billing.ReconciliationCheckpoint,
) (bool, error) {
	tag, err := transaction.Exec(
		ctx,
		`INSERT INTO billing_reconciliation_checkpoints(
		 provider, snapshot_id, subscription_id, observed_at, applied_version, recorded_at
		 ) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
		string(checkpoint.Provider), string(checkpoint.SnapshotID), string(checkpoint.SubscriptionID),
		checkpoint.ObservedAt, int64(checkpoint.AppliedVersion), checkpoint.RecordedAt,
	)
	return tag.RowsAffected() == 1, err
}

func providerReceiptExists(
	ctx context.Context,
	transaction pgx.Tx,
	receipt billing.ProviderEventReceipt,
	result *billing.CommitKind,
) (bool, error) {
	var subscriptionID string
	err := transaction.QueryRow(
		ctx,
		`SELECT subscription_id FROM billing_provider_event_receipts
		  WHERE provider = $1 AND provider_event_id = $2`,
		string(receipt.Provider), string(receipt.EventID),
	).Scan(&subscriptionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if subscriptionID == string(receipt.SubscriptionID) {
		*result = billing.CommitDuplicate
	} else {
		*result = billing.CommitConflict
	}
	return true, nil
}

func checkpointExists(
	ctx context.Context,
	transaction pgx.Tx,
	checkpoint billing.ReconciliationCheckpoint,
	result *billing.CommitKind,
) (bool, error) {
	var subscriptionID string
	err := transaction.QueryRow(
		ctx,
		`SELECT subscription_id FROM billing_reconciliation_checkpoints
		  WHERE provider = $1 AND snapshot_id = $2`,
		string(checkpoint.Provider), string(checkpoint.SnapshotID),
	).Scan(&subscriptionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if subscriptionID == string(checkpoint.SubscriptionID) {
		*result = billing.CommitDuplicate
	} else {
		*result = billing.CommitConflict
	}
	return true, nil
}

func classifyProviderReceiptConflict(
	ctx context.Context,
	transaction pgx.Tx,
	receipt billing.ProviderEventReceipt,
	result *billing.CommitKind,
) error {
	var subscriptionID string
	err := transaction.QueryRow(
		ctx,
		`SELECT subscription_id FROM billing_provider_event_receipts
		  WHERE provider = $1 AND provider_event_id = $2`,
		string(receipt.Provider), string(receipt.EventID),
	).Scan(&subscriptionID)
	if err != nil {
		return err
	}
	if subscriptionID == string(receipt.SubscriptionID) {
		*result = billing.CommitDuplicate
	} else {
		*result = billing.CommitConflict
	}
	return nil
}

func classifyCheckpointConflict(
	ctx context.Context,
	transaction pgx.Tx,
	checkpoint billing.ReconciliationCheckpoint,
	result *billing.CommitKind,
) error {
	var subscriptionID string
	err := transaction.QueryRow(
		ctx,
		`SELECT subscription_id FROM billing_reconciliation_checkpoints
		  WHERE provider = $1 AND snapshot_id = $2`,
		string(checkpoint.Provider), string(checkpoint.SnapshotID),
	).Scan(&subscriptionID)
	if err != nil {
		return err
	}
	if subscriptionID == string(checkpoint.SubscriptionID) {
		*result = billing.CommitDuplicate
	} else {
		*result = billing.CommitConflict
	}
	return nil
}

func scanOptionalSubscription(row rowScanner) (*billing.SubscriptionRecord, error) {
	record, err := scanSubscription(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func scanSubscription(row rowScanner) (billing.SubscriptionRecord, error) {
	var raw subscriptionRow
	err := row.Scan(
		&raw.subscriptionID, &raw.accountID, &raw.vaultID, &raw.provider,
		&raw.customerReference, &raw.subscriptionReference, &raw.version, &raw.status,
		&raw.paymentMethodReady, &raw.paymentMethodUpdatedAt,
		&raw.trialStartedAt, &raw.trialEndsAt, &raw.trialObservedAt,
		&raw.paidPeriodStartedAt, &raw.paidPeriodEndsAt, &raw.lastPaidAt, &raw.lastPaidInvoiceReference,
		&raw.lastDelinquencyAt,
		&raw.delinquencyReason, &raw.delinquencySince, &raw.delinquencyInvoiceReference,
		&raw.cancelAt, &raw.cancellationUpdatedAt, &raw.cancelledAt, &raw.lastReconciledAt,
		&raw.createdAt, &raw.updatedAt,
	)
	if err != nil {
		return billing.SubscriptionRecord{}, err
	}
	record, err := decodeSubscription(raw)
	if err != nil {
		return billing.SubscriptionRecord{}, err
	}
	return record, nil
}

type subscriptionRow struct {
	subscriptionID, accountID, vaultID, provider      string
	customerReference, subscriptionReference          sql.NullString
	version                                           int64
	status                                            string
	paymentMethodReady                                bool
	paymentMethodUpdatedAt                            sql.NullInt64
	trialStartedAt, trialEndsAt, trialObservedAt      sql.NullInt64
	paidPeriodStartedAt, paidPeriodEndsAt, lastPaidAt sql.NullInt64
	lastPaidInvoiceReference                          sql.NullString
	lastDelinquencyAt                                 sql.NullInt64
	delinquencyReason, delinquencyInvoiceReference    sql.NullString
	delinquencySince, cancelAt, cancellationUpdatedAt sql.NullInt64
	cancelledAt, lastReconciledAt                     sql.NullInt64
	createdAt, updatedAt                              int64
}

func decodeSubscription(raw subscriptionRow) (billing.SubscriptionRecord, error) {
	subscriptionID, subscriptionErr := billing.ParseSubscriptionID(raw.subscriptionID)
	accountID, accountErr := identity.ParseAccountID(raw.accountID)
	vaultID, vaultErr := identity.ParseVaultID(raw.vaultID)
	provider, providerErr := billing.ParseProvider(raw.provider)
	version, versionErr := billing.ParseVersion(raw.version)
	if subscriptionErr != nil || accountErr != nil || vaultErr != nil || providerErr != nil || versionErr != nil {
		return billing.SubscriptionRecord{}, ErrInvalidBillingRecord
	}
	record := billing.SubscriptionRecord{
		SubscriptionID: subscriptionID, AccountID: accountID, VaultID: vaultID, Provider: provider, Version: version,
		ProviderCustomerReference:     billing.ProviderCustomerReference(nullString(raw.customerReference)),
		ProviderSubscriptionReference: billing.ProviderSubscriptionReference(nullString(raw.subscriptionReference)),
		PaymentMethodReady:            recordBool(raw.paymentMethodReady), PaymentMethodUpdatedAt: nullInt64(raw.paymentMethodUpdatedAt),
		TrialObservedAt: nullInt64(raw.trialObservedAt), LastPaidAt: nullInt64(raw.lastPaidAt),
		LastPaidInvoiceReference: billing.ProviderInvoiceReference(nullString(raw.lastPaidInvoiceReference)),
		LastDelinquencyAt:        nullInt64(raw.lastDelinquencyAt), CancelAt: nullInt64(raw.cancelAt),
		CancellationUpdatedAt: nullInt64(raw.cancellationUpdatedAt), LastReconciledAt: nullInt64(raw.lastReconciledAt),
		CreatedAt: raw.createdAt, UpdatedAt: raw.updatedAt,
	}
	switch billing.LifecycleKind(raw.status) {
	case billing.LifecycleCheckoutPending:
		record.Lifecycle = billing.Lifecycle{Kind: billing.LifecycleCheckoutPending}
	case billing.LifecycleTrialing:
		if !raw.trialStartedAt.Valid || !raw.trialEndsAt.Valid {
			return billing.SubscriptionRecord{}, ErrInvalidBillingRecord
		}
		record.Lifecycle = billing.Lifecycle{Kind: billing.LifecycleTrialing, TrialStartedAt: raw.trialStartedAt.Int64, TrialEndsAt: raw.trialEndsAt.Int64}
	case billing.LifecycleActive:
		if !raw.paidPeriodStartedAt.Valid || !raw.paidPeriodEndsAt.Valid {
			return billing.SubscriptionRecord{}, ErrInvalidBillingRecord
		}
		record.Lifecycle = billing.Lifecycle{Kind: billing.LifecycleActive, PaidPeriodStartedAt: raw.paidPeriodStartedAt.Int64, PaidThrough: raw.paidPeriodEndsAt.Int64}
	case billing.LifecycleDelinquent:
		if !raw.delinquencyReason.Valid || !raw.delinquencySince.Valid || !raw.delinquencyInvoiceReference.Valid {
			return billing.SubscriptionRecord{}, ErrInvalidBillingRecord
		}
		record.Lifecycle = billing.Lifecycle{
			Kind: billing.LifecycleDelinquent, DelinquencyReason: billing.DelinquencyReason(raw.delinquencyReason.String),
			DelinquencySince: raw.delinquencySince.Int64, InvoiceReference: billing.ProviderInvoiceReference(raw.delinquencyInvoiceReference.String),
		}
	case billing.LifecycleCancelled:
		if !raw.cancelledAt.Valid {
			return billing.SubscriptionRecord{}, ErrInvalidBillingRecord
		}
		record.Lifecycle = billing.Lifecycle{Kind: billing.LifecycleCancelled, CancelledAt: raw.cancelledAt.Int64}
	default:
		return billing.SubscriptionRecord{}, ErrInvalidBillingRecord
	}
	if !billing.ValidRecord(record) {
		return billing.SubscriptionRecord{}, ErrInvalidBillingRecord
	}
	return record, nil
}

type lifecycleColumns struct {
	trialStartedAt, trialEndsAt              any
	paidPeriodStartedAt, paidPeriodEndsAt    any
	delinquencyReason, delinquencySince      any
	delinquencyInvoiceReference, cancelledAt any
}

func encodeLifecycle(lifecycle billing.Lifecycle) lifecycleColumns {
	shape := lifecycleColumns{}
	switch lifecycle.Kind {
	case billing.LifecycleTrialing:
		shape.trialStartedAt, shape.trialEndsAt = lifecycle.TrialStartedAt, lifecycle.TrialEndsAt
	case billing.LifecycleActive:
		shape.paidPeriodStartedAt, shape.paidPeriodEndsAt = lifecycle.PaidPeriodStartedAt, lifecycle.PaidThrough
	case billing.LifecycleDelinquent:
		shape.delinquencyReason = string(lifecycle.DelinquencyReason)
		shape.delinquencySince = lifecycle.DelinquencySince
		shape.delinquencyInvoiceReference = string(lifecycle.InvoiceReference)
	case billing.LifecycleCancelled:
		shape.cancelledAt = lifecycle.CancelledAt
	}
	return shape
}

func scanOptionalCheckout(row rowScanner) (*billing.CheckoutIntentRecord, error) {
	intent, err := scanCheckout(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &intent, nil
}

func scanCheckout(row rowScanner, extraDestinations ...any) (billing.CheckoutIntentRecord, error) {
	var rawID, rawSubscriptionID, rawProvider, rawStatus string
	var rawReference sql.NullString
	var createdAt int64
	var openedAt sql.NullInt64
	destinations := []any{&rawID, &rawSubscriptionID, &rawProvider, &rawReference, &rawStatus, &createdAt, &openedAt}
	destinations = append(destinations, extraDestinations...)
	if err := row.Scan(destinations...); err != nil {
		return billing.CheckoutIntentRecord{}, err
	}
	checkoutID, checkoutErr := billing.ParseCheckoutIntentID(rawID)
	subscriptionID, subscriptionErr := billing.ParseSubscriptionID(rawSubscriptionID)
	provider, providerErr := billing.ParseProvider(rawProvider)
	intent := billing.CheckoutIntentRecord{
		CheckoutIntentID: checkoutID, SubscriptionID: subscriptionID, Provider: provider,
		ProviderCheckoutReference: billing.ProviderCheckoutReference(nullString(rawReference)),
		Status:                    billing.CheckoutIntentStatus(rawStatus), CreatedAt: createdAt, OpenedAt: nullInt64(openedAt),
	}
	if checkoutErr != nil || subscriptionErr != nil || providerErr != nil || !validCheckout(intent) {
		return billing.CheckoutIntentRecord{}, ErrInvalidBillingRecord
	}
	return intent, nil
}

func scanProviderReceipt(row rowScanner) (billing.ProviderEventReceipt, error) {
	var rawProvider, rawEventID, rawSubscriptionID, rawFactKind, rawOutcome string
	var occurredAt, version, recordedAt int64
	if err := row.Scan(&rawProvider, &rawEventID, &rawSubscriptionID, &rawFactKind, &rawOutcome, &occurredAt, &version, &recordedAt); err != nil {
		return billing.ProviderEventReceipt{}, err
	}
	provider, providerErr := billing.ParseProvider(rawProvider)
	eventID, eventErr := billing.ParseProviderEventID(rawEventID)
	subscriptionID, subscriptionErr := billing.ParseSubscriptionID(rawSubscriptionID)
	appliedVersion, versionErr := billing.ParseVersion(version)
	receipt := billing.ProviderEventReceipt{
		Provider: provider, EventID: eventID, SubscriptionID: subscriptionID, FactKind: billing.FactKind(rawFactKind),
		Outcome: billing.ReceiptOutcome(rawOutcome), OccurredAt: occurredAt, AppliedVersion: appliedVersion, RecordedAt: recordedAt,
	}
	if providerErr != nil || eventErr != nil || subscriptionErr != nil || versionErr != nil || !validProviderReceipt(receipt) {
		return billing.ProviderEventReceipt{}, ErrInvalidBillingRecord
	}
	return receipt, nil
}

func scanReconciliationCheckpoint(row rowScanner) (billing.ReconciliationCheckpoint, error) {
	var rawProvider, rawSnapshotID, rawSubscriptionID string
	var observedAt, version, recordedAt int64
	if err := row.Scan(&rawProvider, &rawSnapshotID, &rawSubscriptionID, &observedAt, &version, &recordedAt); err != nil {
		return billing.ReconciliationCheckpoint{}, err
	}
	provider, providerErr := billing.ParseProvider(rawProvider)
	snapshotID, snapshotErr := billing.ParseReconciliationSnapshotID(rawSnapshotID)
	subscriptionID, subscriptionErr := billing.ParseSubscriptionID(rawSubscriptionID)
	appliedVersion, versionErr := billing.ParseVersion(version)
	checkpoint := billing.ReconciliationCheckpoint{
		Provider: provider, SnapshotID: snapshotID, SubscriptionID: subscriptionID,
		ObservedAt: observedAt, AppliedVersion: appliedVersion, RecordedAt: recordedAt,
	}
	if providerErr != nil || snapshotErr != nil || subscriptionErr != nil || versionErr != nil || !validCheckpoint(checkpoint) {
		return billing.ReconciliationCheckpoint{}, ErrInvalidBillingRecord
	}
	return checkpoint, nil
}

func validCreatedCheckout(record billing.SubscriptionRecord, intent billing.CheckoutIntentRecord) bool {
	return validCheckout(intent) && intent.Status == billing.CheckoutIntentCreated &&
		intent.SubscriptionID == record.SubscriptionID && intent.Provider == record.Provider && intent.CreatedAt == record.CreatedAt
}

func validOpenedCheckout(intent billing.CheckoutIntentRecord) bool {
	return validCheckout(intent) && intent.Status == billing.CheckoutIntentOpened
}

func validCheckout(intent billing.CheckoutIntentRecord) bool {
	if _, err := billing.ParseCheckoutIntentID(string(intent.CheckoutIntentID)); err != nil {
		return false
	}
	if _, err := billing.ParseSubscriptionID(string(intent.SubscriptionID)); err != nil {
		return false
	}
	if _, err := billing.ParseProvider(string(intent.Provider)); err != nil || intent.CreatedAt < 0 || intent.CreatedAt > 9_007_199_254_740_991 {
		return false
	}
	if intent.Status == billing.CheckoutIntentCreated {
		return intent.ProviderCheckoutReference == "" && intent.OpenedAt == nil
	}
	if intent.Status != billing.CheckoutIntentOpened || intent.OpenedAt == nil || *intent.OpenedAt < intent.CreatedAt {
		return false
	}
	_, err := billing.ParseProviderCheckoutReference(string(intent.ProviderCheckoutReference))
	return err == nil
}

func validFactCommit(expected billing.SubscriptionRecord, next billing.SubscriptionRecord, receipt billing.ProviderEventReceipt) bool {
	return billing.ValidRecord(expected) && billing.ValidRecord(next) && validProviderReceipt(receipt) &&
		next.SubscriptionID == expected.SubscriptionID && next.AccountID == expected.AccountID && next.VaultID == expected.VaultID &&
		next.Provider == expected.Provider && next.CreatedAt == expected.CreatedAt && next.Version == expected.Version+1 &&
		receipt.SubscriptionID == next.SubscriptionID && receipt.Provider == next.Provider &&
		receipt.AppliedVersion == next.Version && receipt.Outcome == billing.ReceiptApplied
}

func validReconciliationCommit(expected billing.SubscriptionRecord, next billing.SubscriptionRecord, checkpoint billing.ReconciliationCheckpoint) bool {
	return billing.ValidRecord(expected) && billing.ValidRecord(next) && validCheckpoint(checkpoint) &&
		next.SubscriptionID == expected.SubscriptionID && next.AccountID == expected.AccountID && next.VaultID == expected.VaultID &&
		next.Provider == expected.Provider && next.CreatedAt == expected.CreatedAt && next.Version == expected.Version+1 &&
		checkpoint.SubscriptionID == next.SubscriptionID && checkpoint.Provider == next.Provider &&
		checkpoint.AppliedVersion == next.Version
}

func validProviderReceipt(receipt billing.ProviderEventReceipt) bool {
	if !validProviderEventKey(receipt.Provider, receipt.EventID) {
		return false
	}
	if _, err := billing.ParseSubscriptionID(string(receipt.SubscriptionID)); err != nil {
		return false
	}
	if _, err := billing.ParseVersion(int64(receipt.AppliedVersion)); err != nil {
		return false
	}
	if receipt.Outcome != billing.ReceiptApplied && receipt.Outcome != billing.ReceiptIgnored {
		return false
	}
	switch receipt.FactKind {
	case billing.FactTrialStarted, billing.FactPaymentMethodUpdated, billing.FactInvoicePaid,
		billing.FactInvoicePaymentFailed, billing.FactInvoicePaymentActionRequired,
		billing.FactCancellationScheduled, billing.FactSubscriptionCancelled:
	default:
		return false
	}
	return receipt.OccurredAt >= 0 && receipt.RecordedAt >= receipt.OccurredAt && receipt.RecordedAt <= 9_007_199_254_740_991
}

func validCheckpoint(checkpoint billing.ReconciliationCheckpoint) bool {
	if !validSnapshotKey(checkpoint.Provider, checkpoint.SnapshotID) {
		return false
	}
	if _, err := billing.ParseSubscriptionID(string(checkpoint.SubscriptionID)); err != nil {
		return false
	}
	if _, err := billing.ParseVersion(int64(checkpoint.AppliedVersion)); err != nil {
		return false
	}
	return checkpoint.ObservedAt >= 0 && checkpoint.RecordedAt >= checkpoint.ObservedAt && checkpoint.RecordedAt <= 9_007_199_254_740_991
}

func validProviderMapping(provider billing.Provider, customer billing.ProviderCustomerReference, subscription billing.ProviderSubscriptionReference) bool {
	if _, err := billing.ParseProvider(string(provider)); err != nil {
		return false
	}
	if _, err := billing.ParseProviderCustomerReference(string(customer)); err != nil {
		return false
	}
	_, err := billing.ParseProviderSubscriptionReference(string(subscription))
	return err == nil
}

func validProviderEventKey(provider billing.Provider, eventID billing.ProviderEventID) bool {
	if _, err := billing.ParseProvider(string(provider)); err != nil {
		return false
	}
	_, err := billing.ParseProviderEventID(string(eventID))
	return err == nil
}

func validSnapshotKey(provider billing.Provider, snapshotID billing.ReconciliationSnapshotID) bool {
	if _, err := billing.ParseProvider(string(provider)); err != nil {
		return false
	}
	_, err := billing.ParseReconciliationSnapshotID(string(snapshotID))
	return err == nil
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullableTimestamp(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullString(value sql.NullString) string {
	if !value.Valid {
		return ""
	}
	return value.String
}

func nullInt64(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	copy := value.Int64
	return &copy
}

func recordBool(value bool) bool {
	return value
}

func isUniqueViolation(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "23505"
}

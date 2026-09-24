package postgres

import (
	"context"
	"errors"
	"slices"
	"sort"
	"time"

	"github.com/fukamu/notes/backend/internal/synclegacy"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const maximumSerializableAttempts = 3

var errInvalidResolve = errors.New("invalid conflict resolution")

type LegacySyncStore struct {
	pool    *pgxpool.Pool
	attempt func(context.Context, synclegacy.Request) (synclegacy.Response, error)
}

type legacyCardRow struct {
	ID             synclegacy.CardID
	DisplayID      int64
	Title          string
	BodyJSON       string
	Revision       int64
	CreatedAt      int64
	UpdatedAt      int64
	LastMutationID synclegacy.MutationID
}

func NewLegacySyncStore(pool *pgxpool.Pool) (*LegacySyncStore, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	store := &LegacySyncStore{pool: pool}
	store.attempt = store.syncAttempt
	return store, nil
}

func (store *LegacySyncStore) Sync(
	ctx context.Context,
	request synclegacy.Request,
) (synclegacy.Response, error) {
	if store == nil || store.attempt == nil {
		return synclegacy.Response{}, synclegacy.ErrSyncFailed
	}
	for attempt := 0; attempt < maximumSerializableAttempts; attempt++ {
		response, err := store.attempt(ctx, request)
		if err == nil {
			return response, nil
		}
		if !isRetryableTransactionError(err) || ctx.Err() != nil {
			return synclegacy.Response{}, synclegacy.ErrSyncFailed
		}
	}
	return synclegacy.Response{}, synclegacy.ErrSyncFailed
}

func (store *LegacySyncStore) syncAttempt(
	ctx context.Context,
	request synclegacy.Request,
) (synclegacy.Response, error) {
	transaction, err := store.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return synclegacy.Response{}, err
	}
	committed := false
	defer func() {
		if committed {
			return
		}
		rollbackContext, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = transaction.Rollback(rollbackContext)
	}()

	response, err := synchronizeTransaction(ctx, transaction, request)
	if err != nil {
		return synclegacy.Response{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return synclegacy.Response{}, err
	}
	committed = true
	return response, nil
}

func synchronizeTransaction(
	ctx context.Context,
	transaction pgx.Tx,
	request synclegacy.Request,
) (synclegacy.Response, error) {
	var nextDisplayID int64
	if err := transaction.QueryRow(
		ctx,
		"SELECT next_display_id FROM sync_state WHERE singleton = 1 FOR UPDATE",
	).Scan(&nextDisplayID); err != nil {
		return synclegacy.Response{}, err
	}
	if nextDisplayID < 1 || nextDisplayID > synclegacy.MaximumSafeInteger {
		return synclegacy.Response{}, synclegacy.ErrInvalidState
	}
	preflight, err := readLegacyState(ctx, transaction, nil)
	if err != nil {
		return synclegacy.Response{}, err
	}
	if err := synclegacy.ValidateResponse(preflight, nil); err != nil {
		return synclegacy.Response{}, err
	}

	ordered := append([]synclegacy.Mutation(nil), request.Mutations...)
	sort.Slice(ordered, func(left int, right int) bool {
		if ordered[left].CardID == ordered[right].CardID {
			return ordered[left].MutationID < ordered[right].MutationID
		}
		return ordered[left].CardID < ordered[right].CardID
	})
	acknowledged := make([]synclegacy.MutationID, 0, len(ordered))
	initialNextDisplayID := nextDisplayID
	for _, mutation := range ordered {
		applied, err := mutationWasAppliedPostgres(ctx, transaction, mutation.MutationID)
		if err != nil {
			return synclegacy.Response{}, err
		}
		if !applied {
			nextDisplayID, err = applyLegacyMutation(ctx, transaction, mutation, nextDisplayID)
			if err != nil {
				return synclegacy.Response{}, err
			}
		}
		acknowledged = append(acknowledged, mutation.MutationID)
	}
	if nextDisplayID != initialNextDisplayID {
		tag, err := transaction.Exec(
			ctx,
			"UPDATE sync_state SET next_display_id = $1 WHERE singleton = 1 AND next_display_id = $2",
			nextDisplayID,
			initialNextDisplayID,
		)
		if err != nil {
			return synclegacy.Response{}, err
		}
		if err := RequireOneRow(tag); err != nil {
			return synclegacy.Response{}, err
		}
	}
	response, err := readLegacyState(ctx, transaction, acknowledged)
	if err != nil {
		return synclegacy.Response{}, err
	}
	if err := synclegacy.ValidateResponse(response, request.Mutations); err != nil {
		return synclegacy.Response{}, err
	}
	return response, nil
}

func mutationWasAppliedPostgres(
	ctx context.Context,
	transaction pgx.Tx,
	identifier synclegacy.MutationID,
) (bool, error) {
	var applied bool
	if err := transaction.QueryRow(
		ctx,
		"SELECT EXISTS (SELECT 1 FROM card_mutations WHERE id = $1)",
		string(identifier),
	).Scan(&applied); err != nil {
		return false, err
	}
	return applied, nil
}

func applyLegacyMutation(
	ctx context.Context,
	transaction pgx.Tx,
	mutation synclegacy.Mutation,
	nextDisplayID int64,
) (int64, error) {
	current, err := readLegacyCardForUpdate(ctx, transaction, mutation.CardID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nextDisplayID, err
	}
	if errors.Is(err, pgx.ErrNoRows) {
		if nextDisplayID >= synclegacy.MaximumSafeInteger {
			return nextDisplayID, synclegacy.ErrInvalidState
		}
		if err := createLegacyCard(ctx, transaction, mutation, nextDisplayID); err != nil {
			return nextDisplayID, err
		}
		return nextDisplayID + 1, nil
	}
	if mutation.Kind == synclegacy.MutationResolve {
		return nextDisplayID, resolveLegacyCard(ctx, transaction, current, mutation)
	}
	return nextDisplayID, updateLegacyCard(ctx, transaction, current, mutation)
}

func readLegacyCardForUpdate(
	ctx context.Context,
	transaction pgx.Tx,
	identifier synclegacy.CardID,
) (legacyCardRow, error) {
	var row legacyCardRow
	err := transaction.QueryRow(
		ctx,
		`SELECT id, display_id, title, body_json, revision, created_at, updated_at,
                last_mutation_id
           FROM cards WHERE id = $1 FOR UPDATE`,
		string(identifier),
	).Scan(
		&row.ID,
		&row.DisplayID,
		&row.Title,
		&row.BodyJSON,
		&row.Revision,
		&row.CreatedAt,
		&row.UpdatedAt,
		&row.LastMutationID,
	)
	return row, err
}

func createLegacyCard(
	ctx context.Context,
	transaction pgx.Tx,
	mutation synclegacy.Mutation,
	displayID int64,
) error {
	bodyJSON, err := synclegacy.EncodeBody(mutation.Body)
	if err != nil {
		return err
	}
	if mutation.Kind == synclegacy.MutationResolve {
		return errInvalidResolve
	}
	if _, err := transaction.Exec(
		ctx,
		`INSERT INTO cards(
           id, display_id, title, body_json, revision, created_at, updated_at, last_mutation_id
         ) VALUES ($1, $2, $3, $4, 1, $5, $6, $7)`,
		string(mutation.CardID),
		displayID,
		mutation.Title,
		bodyJSON,
		mutation.CreatedAt,
		mutation.UpdatedAt,
		string(mutation.MutationID),
	); err != nil {
		return err
	}
	return insertMutationMarker(ctx, transaction, mutation)
}

func updateLegacyCard(
	ctx context.Context,
	transaction pgx.Tx,
	current legacyCardRow,
	mutation synclegacy.Mutation,
) error {
	bodyJSON, err := synclegacy.EncodeBody(mutation.Body)
	if err != nil {
		return err
	}
	currentBody, err := synclegacy.DecodeStoredBody(current.BodyJSON)
	if err != nil {
		return err
	}
	revisionMatches := mutation.BaseServerRevision != nil &&
		current.Revision == *mutation.BaseServerRevision
	contentMatches := current.Title == mutation.Title && slices.Equal(currentBody, mutation.Body)
	if revisionMatches || contentMatches {
		tag, err := transaction.Exec(
			ctx,
			`UPDATE cards SET title = $1, body_json = $2, revision = revision + 1,
                   updated_at = $3, last_mutation_id = $4
               WHERE id = $5 AND revision = $6`,
			mutation.Title,
			bodyJSON,
			mutation.UpdatedAt,
			string(mutation.MutationID),
			string(mutation.CardID),
			current.Revision,
		)
		if err != nil {
			return err
		}
		if err := RequireOneRow(tag); err != nil {
			return err
		}
	} else {
		if _, err := transaction.Exec(
			ctx,
			`INSERT INTO conflicts(
             id, card_id, server_revision, local_title, local_body_json,
             server_title, server_body_json, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			string(mutation.MutationID),
			string(mutation.CardID),
			current.Revision,
			mutation.Title,
			bodyJSON,
			current.Title,
			current.BodyJSON,
			mutation.UpdatedAt,
		); err != nil {
			return err
		}
	}
	return insertMutationMarker(ctx, transaction, mutation)
}

func resolveLegacyCard(
	ctx context.Context,
	transaction pgx.Tx,
	current legacyCardRow,
	mutation synclegacy.Mutation,
) error {
	if mutation.BaseServerRevision == nil || current.Revision != *mutation.BaseServerRevision ||
		len(mutation.ConflictIDs) == 0 {
		return errInvalidResolve
	}
	identifiers := make([]string, len(mutation.ConflictIDs))
	for index, identifier := range mutation.ConflictIDs {
		identifiers[index] = string(identifier)
	}
	var count int
	if err := transaction.QueryRow(
		ctx,
		"SELECT count(*) FROM conflicts WHERE card_id = $1 AND id = ANY($2::text[])",
		string(mutation.CardID),
		identifiers,
	).Scan(&count); err != nil || count != len(identifiers) {
		return errInvalidResolve
	}
	bodyJSON, err := synclegacy.EncodeBody(mutation.Body)
	if err != nil {
		return err
	}
	tag, err := transaction.Exec(
		ctx,
		`UPDATE cards SET title = $1, body_json = $2, revision = revision + 1,
               updated_at = $3, last_mutation_id = $4
           WHERE id = $5 AND revision = $6`,
		mutation.Title,
		bodyJSON,
		mutation.UpdatedAt,
		string(mutation.MutationID),
		string(mutation.CardID),
		current.Revision,
	)
	if err != nil {
		return err
	}
	if err := RequireOneRow(tag); err != nil {
		return err
	}
	deleted, err := transaction.Exec(
		ctx,
		"DELETE FROM conflicts WHERE card_id = $1 AND id = ANY($2::text[])",
		string(mutation.CardID),
		identifiers,
	)
	if err != nil || deleted.RowsAffected() != int64(len(identifiers)) {
		return errInvalidResolve
	}
	return insertMutationMarker(ctx, transaction, mutation)
}

func insertMutationMarker(
	ctx context.Context,
	transaction pgx.Tx,
	mutation synclegacy.Mutation,
) error {
	_, err := transaction.Exec(
		ctx,
		"INSERT INTO card_mutations(id, card_id, created_at) VALUES ($1, $2, $3)",
		string(mutation.MutationID),
		string(mutation.CardID),
		mutation.UpdatedAt,
	)
	return err
}

func readLegacyState(
	ctx context.Context,
	transaction pgx.Tx,
	acknowledged []synclegacy.MutationID,
) (synclegacy.Response, error) {
	cards, err := readLegacyCards(ctx, transaction)
	if err != nil {
		return synclegacy.Response{}, err
	}
	conflicts, err := readLegacyConflicts(ctx, transaction)
	if err != nil {
		return synclegacy.Response{}, err
	}
	acknowledgedCopy := make([]synclegacy.MutationID, len(acknowledged))
	copy(acknowledgedCopy, acknowledged)
	return synclegacy.Response{
		Cards:                   cards,
		Conflicts:               conflicts,
		AcknowledgedMutationIDs: acknowledgedCopy,
	}, nil
}

func readLegacyCards(ctx context.Context, transaction pgx.Tx) ([]synclegacy.Card, error) {
	rows, err := transaction.Query(
		ctx,
		`SELECT id, display_id, title, body_json, revision, created_at, updated_at,
		        last_mutation_id
           FROM cards ORDER BY display_id ASC LIMIT $1`,
		synclegacy.MaximumCards+1,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cards := make([]synclegacy.Card, 0)
	for rows.Next() {
		var card synclegacy.Card
		var bodyJSON string
		var lastMutationID string
		if err := rows.Scan(
			&card.ID,
			&card.OfficialDisplayID,
			&card.Title,
			&bodyJSON,
			&card.Revision,
			&card.CreatedAt,
			&card.UpdatedAt,
			&lastMutationID,
		); err != nil {
			return nil, err
		}
		body, err := synclegacy.DecodeStoredBody(bodyJSON)
		if err != nil {
			return nil, err
		}
		card.Body = body
		if _, err := synclegacy.DecodeStoredMutationID(lastMutationID); err != nil {
			return nil, err
		}
		cards = append(cards, card)
		if len(cards) > synclegacy.MaximumCards {
			return nil, synclegacy.ErrInvalidState
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return cards, nil
}

func readLegacyConflicts(ctx context.Context, transaction pgx.Tx) ([]synclegacy.Conflict, error) {
	rows, err := transaction.Query(
		ctx,
		`SELECT id, card_id, server_revision, local_title, local_body_json,
                server_title, server_body_json, created_at
           FROM conflicts ORDER BY created_at ASC LIMIT $1`,
		synclegacy.MaximumConflicts+1,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	conflicts := make([]synclegacy.Conflict, 0)
	for rows.Next() {
		var conflict synclegacy.Conflict
		var localBodyJSON string
		var serverBodyJSON string
		if err := rows.Scan(
			&conflict.ID,
			&conflict.CardID,
			&conflict.ServerRevision,
			&conflict.LocalTitle,
			&localBodyJSON,
			&conflict.ServerTitle,
			&serverBodyJSON,
			&conflict.CreatedAt,
		); err != nil {
			return nil, err
		}
		localBody, err := synclegacy.DecodeStoredBody(localBodyJSON)
		if err != nil {
			return nil, err
		}
		serverBody, err := synclegacy.DecodeStoredBody(serverBodyJSON)
		if err != nil {
			return nil, err
		}
		conflict.LocalBody = localBody
		conflict.ServerBody = serverBody
		conflicts = append(conflicts, conflict)
		if len(conflicts) > synclegacy.MaximumConflicts {
			return nil, synclegacy.ErrInvalidState
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return conflicts, nil
}

func isRetryableTransactionError(err error) bool {
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) {
		return false
	}
	return postgresError.Code == "40001" || postgresError.Code == "40P01"
}

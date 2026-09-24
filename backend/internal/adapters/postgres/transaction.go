package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrConcurrentChange = errors.New("expected row was not changed")

func RequireOneRow(tag pgconn.CommandTag) error {
	if tag.RowsAffected() != 1 {
		return ErrConcurrentChange
	}
	return nil
}

func WithSerializableTx(
	ctx context.Context,
	pool *pgxpool.Pool,
	operation func(pgx.Tx) error,
) error {
	transaction, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer func() { _ = transaction.Rollback(context.Background()) }()
	if err := operation(transaction); err != nil {
		return err
	}
	return transaction.Commit(ctx)
}

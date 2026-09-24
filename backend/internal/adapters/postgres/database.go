package postgres

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
)

var ErrDatabaseUnavailable = errors.New("database unavailable")

func OpenSQL(ctx context.Context, databaseURL string) (*sql.DB, error) {
	configuration, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return nil, ErrDatabaseUnavailable
	}
	database := stdlib.OpenDB(*configuration)
	database.SetMaxOpenConns(2)
	database.SetMaxIdleConns(1)
	database.SetConnMaxLifetime(30 * time.Minute)
	if err := database.PingContext(ctx); err != nil {
		_ = database.Close()
		return nil, ErrDatabaseUnavailable
	}
	return database, nil
}

func OpenPool(
	ctx context.Context,
	databaseURL string,
	maximumConnections int32,
) (*pgxpool.Pool, error) {
	if maximumConnections < 1 {
		return nil, errors.New("maximum connections must be positive")
	}
	configuration, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, ErrDatabaseUnavailable
	}
	configuration.MaxConns = maximumConnections
	configuration.MinConns = 0
	configuration.MaxConnLifetime = 30 * time.Minute
	configuration.MaxConnIdleTime = 5 * time.Minute
	pool, err := pgxpool.NewWithConfig(ctx, configuration)
	if err != nil {
		return nil, ErrDatabaseUnavailable
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, ErrDatabaseUnavailable
	}
	return pool, nil
}
